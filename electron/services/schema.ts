/**
 * 库结构与迁移。公共层的东西，不认识「软件」以外的任何业务。
 *
 * 单独成文件有一个硬理由：database.ts 依赖 electron 和 better-sqlite3
 * （后者按 Electron ABI 编译，纯 node 载不进来），而迁移是整个项目里最危险的
 * 一段代码 —— 它改写用户攒了几个月的真实数据，出错的代价是数据没了。
 * 这里只依赖一个最小的 SQL 接口，于是自检可以用 node 自带的 node:sqlite
 * 驱动同一份代码跑真库级别的用例（见 scripts/agent-selfcheck.ts）。
 *
 * 参数一律用位置参数 `?`：better-sqlite3 和 node:sqlite 对具名参数的前缀处理
 * 不一样，位置参数是两边都稳的那个写法。
 */

import { readExternalActiveAt } from './activity.ts'
import { mapCategory } from './taxonomy.ts'
import type { Category, TagSource } from '../../src/types'

/**
 * 库结构 / 内置数据的版本。
 *
 * 0.2 拿「categories 有没有 description 列」当版本标记，那招只能用一次 ——
 * 0.4 要再换一次分类体系，没有列可以拿来当标记了。于是显式记一个数字，
 * 存在 settings 表里（下划线开头的键不会出现在 AppSettings 里，见 getSettings）。
 */
export const SCHEMA_VERSION = 9
export const SCHEMA_KEY = '_schema'

/* --------------------------- 最小 SQL 接口 --------------------------- */

export interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqlDb {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
}

type Row = Record<string, any>

/** better-sqlite3 的 .transaction() 在 node:sqlite 上没有，显式开事务两边都认 */
function tx(d: SqlDb, fn: () => void): void {
  d.exec('BEGIN')
  try {
    fn()
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}

/* ------------------------------- 建表 ------------------------------- */

export const TABLES_SQL = `
  -- 总表：抱一「拥有什么」的账本，按 kind 区分资源类型。
  --
  -- 它归公共层管，只放跟「是软件」无关的字段。软件私有的那些（是不是绿色版、
  -- 能不能搬、启动端有哪些）在 software_meta 里，那张表归软件模块自己管。
  -- 路径全局唯一而不是按 kind 唯一：磁盘只有一块，同一个目录不该被两个模块
  -- 各自认领一次，否则整理模块搬动它时另一个模块的记录会当场失效。
  CREATE TABLE IF NOT EXISTS resource (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'software',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    path TEXT NOT NULL UNIQUE,
    icon_path TEXT,
    file_name TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    source_dir TEXT DEFAULT '',

    name_zh TEXT DEFAULT '',
    name_en TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    description TEXT DEFAULT '',
    category TEXT DEFAULT '其他',
    tags TEXT DEFAULT '[]',
    official_url TEXT DEFAULT '',
    ai_status TEXT DEFAULT 'pending',

    why_choose TEXT DEFAULT '',
    use_cases TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    alternatives TEXT DEFAULT '[]',
    mastery_level TEXT DEFAULT 'new',

    last_used_at INTEGER DEFAULT 0,
    use_count INTEGER DEFAULT 0,
    is_archived INTEGER DEFAULT 0,

    -- 资源目录里配置文件的最新 mtime，见 services/activity.ts
    external_active_at INTEGER DEFAULT 0
  );

  -- 分类。kind 把每个品类的分类体系隔开 —— 「开发工具」是软件的格子，
  -- 「RPG」是游戏的格子，两边都靠 resource.category 按名字挂载，但不该
  -- 出现在对方的侧边栏里，更不该出现在对方识别 prompt 的分类菜单里。
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'software',
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    icon TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0
  );

  -- 标签池。只有 source 为 user / confirmed 的会注入 prompt，
  -- agent 新造的先记成 ai，等用户在确认面板里点头才转正。
  --
  -- 唯一键是 (kind, name) 而不是 name：「单机」「开源」这类词两个品类都用得上，
  -- 全局唯一会让先到的那个品类把词占死，另一个品类再也建不出同名标签。
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'software',
    name TEXT NOT NULL,
    source TEXT DEFAULT 'ai',
    created_at INTEGER NOT NULL,
    UNIQUE(kind, name)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 每跑一次识别留一条，存完整的 agent 过程，用来回答「它当时为什么这么判断」。
  -- ponytail: 刻意不给 dir 建外键。scan_units 的主键就是 dir，而移除扫描目录会
  -- 直接 DELETE 那些行；带外键要么阻塞删除，要么级联把日志一起带走 —— 而日志的
  -- 价值恰恰在于目录已经不在了还能回头看。它是一份只增不改的流水，按条数自行淘汰。
  CREATE TABLE IF NOT EXISTS identify_logs (
    id TEXT PRIMARY KEY,
    dir TEXT NOT NULL,
    label TEXT DEFAULT '',
    kind TEXT DEFAULT 'unit',
    status TEXT NOT NULL,
    summary TEXT DEFAULT '',
    registered INTEGER DEFAULT 0,
    rounds INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    tokens INTEGER DEFAULT 0,
    stop_reason TEXT DEFAULT '',
    events TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL
  );

  -- 每次整理留一条，steps 是完整的动作流水。撤销就是把它逆着做一遍，
  -- 所以这张表不是日志而是**依据** —— 它丢了，用户就再也找不回原来的目录结构了。
  -- 因此它不像 identify_logs 那样按条数淘汰，也不参与「清空识别数据」。
  CREATE TABLE IF NOT EXISTS organize_plans (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    root TEXT NOT NULL,
    undone_at INTEGER DEFAULT 0,
    steps TEXT DEFAULT '[]'
  );

  -- 每跑完一轮批量识别留一条。逐条日志说的是「这个目录为什么这样判断」，
  -- 这张表说的是「这一轮整体怎么样」：哪些没成、共花了多少、搜索额度用掉几次。
  -- 内容全部由 identify_logs 那些数据汇总而来，不额外消耗 token。
  CREATE TABLE IF NOT EXISTS identification_reports (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    processed INTEGER DEFAULT 0,
    registered INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    tokens INTEGER DEFAULT 0,
    searches INTEGER DEFAULT 0,
    entries TEXT DEFAULT '[]'
  );
`

export const INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_resource_kind ON resource(kind);
  CREATE INDEX IF NOT EXISTS idx_resource_category ON resource(category);
  CREATE INDEX IF NOT EXISTS idx_resource_mastery ON resource(mastery_level);
  CREATE INDEX IF NOT EXISTS idx_resource_archived ON resource(is_archived);
  CREATE INDEX IF NOT EXISTS idx_resource_last_used ON resource(last_used_at);
  CREATE INDEX IF NOT EXISTS idx_resource_ai_status ON resource(ai_status);
  CREATE INDEX IF NOT EXISTS idx_resource_source_dir ON resource(source_dir);
  CREATE INDEX IF NOT EXISTS idx_identify_logs_status ON identify_logs(status);
  CREATE INDEX IF NOT EXISTS idx_identify_logs_created ON identify_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_organize_plans_created ON organize_plans(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_created ON identification_reports(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_categories_kind ON categories(kind, sort_order);
`

/* ------------------------------ 版本记账 ------------------------------ */

export function schemaVersion(d: SqlDb): number {
  const row = d.prepare('SELECT value FROM settings WHERE key = ?').get(SCHEMA_KEY) as Row | undefined
  return Number(row?.value) || 0
}

export function setSchemaVersion(d: SqlDb, version: number): void {
  d.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(SCHEMA_KEY, String(version))
}

/** sqlite_master 里这个名字是什么：表、视图，还是不存在 */
export function objectType(d: SqlDb, name: string): 'table' | 'view' | null {
  const row = d.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(name) as Row | undefined
  const t = row?.type
  return t === 'table' || t === 'view' ? t : null
}

export function columnsOf(d: SqlDb, table: string): Set<string> {
  return new Set((d.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name as string))
}

/* ------------------------------ 内置数据 ------------------------------ */

export function insertCategories(d: SqlDb, rows: Category[], kind: string): void {
  const stmt = d.prepare(
    `INSERT OR REPLACE INTO categories (id, kind, name, description, icon, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  tx(d, () => {
    for (const r of rows) stmt.run(r.id, kind, r.name, r.description ?? '', r.icon ?? '', r.sort_order)
  })
}

export function insertTag(d: SqlDb, name: string, source: TagSource, kind: string): void {
  d.prepare(
    `INSERT INTO tags (kind, name, source, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, name) DO NOTHING`
  ).run(kind, name, source, Date.now())
}

/**
 * 某个品类的分类表空了才装 —— 用户把它们全删了的话，总得有东西兜着。
 *
 * 按 kind 分别判断，不看整张表：0.5 的库升上来时表里已经有软件那 5 条，
 * 看整张表就永远轮不到游戏的分类被装进去。
 */
export function seedCategories(d: SqlDb, categories: Category[], kind: string): void {
  if (categories.length === 0) return
  const seeded = d
    .prepare('SELECT COUNT(*) AS n FROM categories WHERE kind = ?')
    .get(kind) as { n: number }
  if (seeded.n > 0) return
  insertCategories(d, categories, kind)
}

/**
 * 内置标签入池。已存在的一律不动 —— 用户可能已经把「便携」改成了别的意思，
 * 或者把它并进了另一个标签，覆盖回去等于替他撤销一次决定。
 */
export function seedTags(d: SqlDb, names: string[], kind: string): void {
  tx(d, () => {
    for (const name of names) insertTag(d, name, 'user', kind)
  })
}

/**
 * 内置分类 + 内置标签 + 版本号，一次装齐。
 *
 * 只在恢复出厂之后调 —— 正常启动走 migrate() 里那些按版本号闸的分支。
 * 差别要紧：这里的 seedTags 是无条件跑的，放到每次启动就会让用户
 * 删掉的内置标签第二天又长回来。
 */
export function seedDefaults(d: SqlDb, kinds: KindLike[]): void {
  for (const k of kinds) {
    seedCategories(d, k.defaultCategories, k.kind)
    seedTags(d, k.defaultTags, k.kind)
  }
  setSchemaVersion(d, SCHEMA_VERSION)
}

/* ------------------------------- 迁移 ------------------------------- */

/**
 * 建表 -> 品类私有表 -> 迁移 -> 视图 -> 索引 -> 兜底内置分类。
 *
 * kinds 由调用方传进来（见 electron/kinds/index.ts 的注册表）。公共层不认识
 * 任何具体品类：它只知道「每个品类有几段 SQL 要执行，有自己的默认分类」。
 *
 * 视图和索引都必须排在 migrate 之后，理由同源：
 *  · 0.4 的库里 software 还是一张**表**，这时候 CREATE VIEW software 会撞名报错，
 *    要等品类的 migrate 把它改名成 software_legacy_v4 才轮得到视图占这个名字。
 *  · CREATE TABLE IF NOT EXISTS 对老库是空操作 —— 表还是 0.1 那张表，没有后来的列。
 *    索引建在不存在的列上会当场报错，而 exec 是一条条顺着执行的：它一炸，后面的
 *    语句连同 migrate() 全都不会跑，库就停在半迁移状态，而应用看着还能用。
 */
export function initSchema(d: SqlDb, kinds: KindLike[] = []): void {
  d.exec(TABLES_SQL)
  for (const k of kinds) d.exec(k.schema.tables)

  // 版本号必须在建表**之后**读：全新安装时 settings 表还不存在，
  // 先读会直接抛 no such table，首次启动当场崩在建库这一步。
  // 而它又必须在 migrate 之前读 —— migrate 跑完就把它改写成当前版本了。
  const from = schemaVersion(d)

  migrate(d, from)
  for (const k of kinds) k.schema.migrate?.(d, from)

  for (const k of kinds) if (k.schema.view) d.exec(k.schema.view)

  d.exec(INDEXES_SQL)
  for (const k of kinds) if (k.schema.indexes) d.exec(k.schema.indexes)

  // 换分类体系这件事绑定到「从 4 以前升上来」，而不是「版本号小于当前」。
  //
  // 这里原本写的是 `schemaVersion(d) < SCHEMA_VERSION`，注释也写着「只跑一次」——
  // 但那个闸门挡不住下一次提版本：4 -> 5 会再跑一遍 rebuildCategories，而它第一行
  // 是 DELETE FROM categories，用户从 0.4 到现在自建的分类会被清光。
  // 一次性动作就该绑死在触发它的那个版本上。
  if (from < 4) rebuildCategories(d, kinds)

  // 内置标签只在升级那一次装，正常启动不装 —— 否则用户删掉的内置标签会长回来
  if (from < SCHEMA_VERSION) {
    for (const k of kinds) seedTags(d, k.defaultTags, k.kind)
    setSchemaVersion(d, SCHEMA_VERSION)
  }

  for (const k of kinds) seedCategories(d, k.defaultCategories, k.kind)
}

/** 公共层对品类模块的最小认知：几段 SQL，一份默认分类，一份默认标签 */
export interface KindLike {
  kind: string
  defaultCategories: Category[]
  /** 这个品类的内置标签池。「魂系」「开放世界」不该出现在软件的识别 prompt 里 */
  defaultTags: string[]
  schema: {
    tables: string
    view?: string
    indexes?: string
    migrate?: (d: SqlDb, from: number) => void
  }
}

/**
 * 公共层自己的迁移。只碰公共层的表 —— 品类私有表的补列、清理、拆分，
 * 由各品类模块在自己的 schema.migrate 里做，initSchema 会在这之后调用它们。
 */
export function migrate(d: SqlDb, from = schemaVersion(d)): void {
  void from

  // description 是 0.2 给 categories 加的一列，rebuildCategories 要往里写，所以先保证它在
  if (!columnsOf(d, 'categories').has('description')) {
    d.exec(`ALTER TABLE categories ADD COLUMN description TEXT DEFAULT ''`)
  }

  // 0.6 给分类和标签加 kind：在此之前库里的每一条都是软件的
  if (!columnsOf(d, 'categories').has('kind')) {
    d.exec(`ALTER TABLE categories ADD COLUMN kind TEXT NOT NULL DEFAULT 'software'`)
  }
  splitTagsByKind(d)
}

/**
 * 0.5 -> 0.6：tags 的唯一键从 name 换成 (kind, name)。
 *
 * 改唯一约束 SQLite 只能重建表。id 原样搬过去 —— 重命名 / 合并 / 删除标签
 * 这几个 IPC 拿的都是 id，换一套 id 等于把用户正开着的那个设置页弄失效。
 */
export function splitTagsByKind(d: SqlDb): void {
  if (objectType(d, 'tags') !== 'table') return
  if (columnsOf(d, 'tags').has('kind')) return

  tx(d, () => {
    d.exec(`
      CREATE TABLE tags_v6 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL DEFAULT 'software',
        name TEXT NOT NULL,
        source TEXT DEFAULT 'ai',
        created_at INTEGER NOT NULL,
        UNIQUE(kind, name)
      );
      INSERT INTO tags_v6 (id, kind, name, source, created_at)
        SELECT id, 'software', name, source, created_at FROM tags;
    `)

    const before = (d.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n
    const after = (d.prepare('SELECT COUNT(*) AS n FROM tags_v6').get() as { n: number }).n
    if (before !== after) {
      throw new Error(`0.6 标签迁移条数对不上：tags=${before} tags_v6=${after}`)
    }

    d.exec('DROP TABLE tags')
    d.exec('ALTER TABLE tags_v6 RENAME TO tags')
  })
}

/**
 * 0.4 换一套分类：清空分类表，装上各品类交上来的那几条。
 *
 * 「清空」是有意的，包括用户自建的分类 —— 分类是靠**名字**挂在条目上的，
 * 留着一个不在新体系里的分类，只会让侧边栏同时显示新旧两套格子。名下的条目按
 * CATEGORY_MOVES 迁移，映射不到的退回「其他」：条目本身一条不少，只是要重归一次。
 *
 * 只在「从 4 以前升上来」时跑一次，见 initSchema 里那句 `if (from < 4)`。
 * 那个年代库里只有软件，所以按名字重映射这一步对全表成立。
 */
export function rebuildCategories(d: SqlDb, kinds: KindLike[]): void {
  tx(d, () => {
    d.prepare('DELETE FROM categories').run()
    // insertCategories 自己会开事务，这里直接走语句，别嵌套 BEGIN
    const stmt = d.prepare(
      `INSERT OR REPLACE INTO categories (id, kind, name, description, icon, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const k of kinds) {
      for (const r of k.defaultCategories) {
        stmt.run(r.id, k.kind, r.name, r.description ?? '', r.icon ?? '', r.sort_order)
      }
    }

    // 暂存区也要迁 —— 升级前刚识别完还没确认的那批，分类同样是旧体系的。
    // 条目侧写的是 resource：这个函数在 splitIntoResource 之后才跑，
    // 那时候 software 已经是个不可写的视图了。
    for (const table of ['resource', 'pending_software']) {
      const names = (
        d.prepare(`SELECT DISTINCT category AS name FROM ${table}`).all() as Row[]
      ).map((r) => (r.name ?? '') as string)
      const move = d.prepare(`UPDATE ${table} SET category = ? WHERE category = ?`)
      for (const from of names) {
        const to = mapCategory(from)
        if (to !== from) move.run(to, from)
      }
    }
  })
}

/**
 * 逐条读磁盘补 external_active_at。软件条目是千级，一次几百毫秒，只在升级时发生。
 * table 显式传进来：它既可能在拆表前跑（老表 software），也可能在拆表后跑（resource），
 * 两边的路径列名还不一样。
 */
export function backfillExternalActive(d: SqlDb, table: 'software' | 'resource'): void {
  const pathCol = table === 'software' ? 'exe_path' : 'path'
  const rows = d.prepare(`SELECT id, ${pathCol} AS p FROM ${table}`).all() as Row[]
  if (rows.length === 0) return
  const stmt = d.prepare(`UPDATE ${table} SET external_active_at = ? WHERE id = ?`)
  tx(d, () => {
    for (const r of rows) stmt.run(readExternalActiveAt(r.p), r.id)
  })
}
