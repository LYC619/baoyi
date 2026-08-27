import Database from 'better-sqlite3'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readExternalActiveAt } from './activity'
import { rebase } from './organize/plan'
import {
  BUILTIN_TAGS,
  DEFAULT_CATEGORIES,
  FALLBACK_CATEGORY,
  mapCategory
} from './taxonomy'
import type {
  AgentEvent,
  AppSettings,
  Category,
  ConfirmResult,
  DataStats,
  IdentifyLog,
  IdentifyLogQuery,
  IdentifyLogStatus,
  IdentifyReport,
  IdentifyReportEntry,
  Launcher,
  MoveRisk,
  OrganizePlan,
  OrganizeStep,
  PendingItem,
  RegisterPayload,
  ScannedFile,
  ScanUnit,
  ScanUnitStatus,
  SidebarCounts,
  SoftwareItem,
  SoftwareQuery,
  Tag,
  TagSource
} from '../../src/types'

type Row = Record<string, any>

let db: Database.Database | null = null

/**
 * 库结构 / 内置数据的版本。
 *
 * 0.2 拿「categories 有没有 description 列」当版本标记，那招只能用一次 ——
 * 0.4 要再换一次分类体系，没有列可以拿来当标记了。于是显式记一个数字，
 * 存在 settings 表里（下划线开头的键不会出现在 AppSettings 里，见 getSettings）。
 */
const SCHEMA_VERSION = 4
const SCHEMA_KEY = '_schema'

export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    api_url: 'https://api.deepseek.com/v1',
    api_key: '',
    model: 'deepseek-chat',
    enabled: true
  },
  ai_profiles: [],
  ai_profile_id: '',
  search: {
    provider: 'model_builtin',
    api_key: '',
    endpoint: '',
    enabled: false
  },
  scan_dirs: [],
  organize_root: '',
  theme: 'dark',
  view_mode: 'grid',
  group_by_category: false,
  unused_days: 60,
  title_lang: 'zh',
  onboarded: false
}

export function iconsDir(): string {
  const dir = path.join(app.getPath('userData'), 'icons')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getDb(): Database.Database {
  if (db) return db
  const file = path.join(app.getPath('userData'), 'baoyi.db')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

function initSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS software (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      exe_path TEXT NOT NULL UNIQUE,
      icon_path TEXT,
      file_name TEXT NOT NULL,
      file_description TEXT DEFAULT '',
      company TEXT DEFAULT '',
      version TEXT DEFAULT '',
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
      launchers TEXT DEFAULT '[]',

      why_choose TEXT DEFAULT '',
      use_cases TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      alternatives TEXT DEFAULT '[]',
      mastery_level TEXT DEFAULT 'new',

      last_used_at INTEGER DEFAULT 0,
      use_count INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,

      -- 软件目录里配置文件的最新 mtime，见 services/activity.ts
      external_active_at INTEGER DEFAULT 0,

      -- 绿色软件？NULL = 还没判断过，和「判断为否」不是一回事
      is_portable INTEGER DEFAULT NULL,
      -- 挪位置的风险：safe / risky / unknown
      move_risk TEXT DEFAULT 'unknown',
      -- 整理成 junction 后链接的真实指向。空串 = 实体目录
      link_target TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS scan_units (
      dir TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      exe_count INTEGER DEFAULT 0,
      loose_only INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      note TEXT DEFAULT '',
      registered INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      icon TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );

    -- 标签池。只有 source 为 user / confirmed 的会注入 prompt，
    -- agent 新造的先记成 ai，等用户在确认面板里点头才转正。
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      source TEXT DEFAULT 'ai',
      created_at INTEGER NOT NULL
    );

    -- 识别结果的暂存区：agent 认完先落在这里，用户确认后才进 software。
    -- exe_path 唯一，同一个程序反复识别只会占一行。
    CREATE TABLE IF NOT EXISTS pending_software (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      scan_unit_id TEXT DEFAULT '',

      exe_path TEXT NOT NULL UNIQUE,
      icon_path TEXT DEFAULT '',
      file_name TEXT NOT NULL,
      file_description TEXT DEFAULT '',
      company TEXT DEFAULT '',
      version TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      external_active_at INTEGER DEFAULT 0,

      name_zh TEXT DEFAULT '',
      name_en TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      description TEXT DEFAULT '',
      category TEXT DEFAULT '其他',
      tags TEXT DEFAULT '[]',
      official_url TEXT DEFAULT '',
      launchers TEXT DEFAULT '[]',
      source_dir TEXT DEFAULT '',

      new_category INTEGER DEFAULT 0,
      new_tags TEXT DEFAULT '[]',

      is_portable INTEGER DEFAULT NULL,
      move_risk TEXT DEFAULT 'unknown'
    );

    -- 用户明确说过「不注册」的程序。下次识别到同一个路径直接不再暂存，
    -- 否则每次重扫都要把同一批东西再否决一遍。
    CREATE TABLE IF NOT EXISTS skip_list (
      exe_path TEXT PRIMARY KEY,
      label TEXT DEFAULT '',
      source_dir TEXT DEFAULT '',
      created_at INTEGER NOT NULL
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

  `)

  migrate(d)

  // 建索引必须在 migrate 之后。
  //
  // CREATE TABLE IF NOT EXISTS 对老库是空操作 —— 表还是 0.1 那张表，没有 0.3 的列。
  // 于是 `ON software(is_portable)` 在老库上直接报 no such column，而 exec 是一条条
  // 顺着执行的：它一炸，后面的语句连同 migrate() 全都不会跑。结果就是 0.3 的三列
  // 永远补不上，写 pending 时报「has no column named is_portable」，而 db 句柄在
  // getDb 里早已赋值，第二次调用照常返回这个半迁移的库 —— 应用看着还能用。
  // 索引只依赖 migrate 之后的表结构，所以它必须排在后面。
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_software_category ON software(category);
    CREATE INDEX IF NOT EXISTS idx_software_mastery ON software(mastery_level);
    CREATE INDEX IF NOT EXISTS idx_software_archived ON software(is_archived);
    CREATE INDEX IF NOT EXISTS idx_software_last_used ON software(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_software_ai_status ON software(ai_status);
    CREATE INDEX IF NOT EXISTS idx_software_portable ON software(is_portable);
    CREATE INDEX IF NOT EXISTS idx_scan_units_status ON scan_units(status);
    CREATE INDEX IF NOT EXISTS idx_identify_logs_status ON identify_logs(status);
    CREATE INDEX IF NOT EXISTS idx_identify_logs_created ON identify_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_organize_plans_created ON organize_plans(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_created ON identification_reports(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pending_dir ON pending_software(source_dir);
  `)

  seedCategories(d)
}

/**
 * 内置分类 + 内置标签 + 版本号，一次装齐。
 *
 * 只在恢复出厂之后调 —— 正常启动走 migrate() 里那个按版本号闸的分支。
 * 差别要紧：这里的 seedBuiltinTags 是无条件跑的，放到每次启动就会让用户
 * 删掉的内置标签第二天又长回来。
 */
function seedDefaults(d: Database.Database): void {
  seedCategories(d)
  seedBuiltinTags(d)
  setSchemaVersion(d, SCHEMA_VERSION)
}

/** 分类表空了才装 —— 用户把 5 个全删了的话，总得有东西兜着 */
function seedCategories(d: Database.Database): void {
  const seeded = d.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }
  if (seeded.n > 0) return
  insertCategories(d, DEFAULT_CATEGORIES)
}

/**
 * 内置标签入池。已存在的一律不动 —— 用户可能已经把「便携」改成了别的意思，
 * 或者把它并进了另一个标签，覆盖回去等于替他撤销一次决定。
 */
function seedBuiltinTags(d: Database.Database): void {
  const tx = d.transaction(() => {
    for (const name of BUILTIN_TAGS) insertTag(d, name, 'user')
  })
  tx()
}

function schemaVersion(d: Database.Database): number {
  const row = d.prepare('SELECT value FROM settings WHERE key = ?').get(SCHEMA_KEY) as Row | undefined
  return Number(row?.value) || 0
}

function setSchemaVersion(d: Database.Database, version: number): void {
  d.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(SCHEMA_KEY, String(version))
}

function insertCategories(d: Database.Database, rows: Category[]): void {
  const stmt = d.prepare(
    `INSERT OR REPLACE INTO categories (id, name, description, icon, sort_order)
     VALUES (@id, @name, @description, @icon, @sort_order)`
  )
  const tx = d.transaction(() => rows.forEach((r) => stmt.run(r)))
  tx()
}

/**
 * 0.1.0 的库里没有 launchers / source_dir，补列而不是重建表，
 * 保证老用户的备注、熟练度、使用统计不丢。
 */
function migrate(d: Database.Database): void {
  const existing = new Set(
    (d.prepare('PRAGMA table_info(software)').all() as Row[]).map((c) => c.name as string)
  )
  const added: Array<[string, string]> = [
    ['source_dir', `TEXT DEFAULT ''`],
    ['launchers', `TEXT DEFAULT '[]'`],
    ['external_active_at', 'INTEGER DEFAULT 0'],
    // 0.3 的三列。is_portable 刻意让存量条目留在 NULL：那才是事实
    // ——「还没判断过」，而不是「判断为不是绿色软件」。整理时前者不会被当成可搬的
    ['is_portable', 'INTEGER DEFAULT NULL'],
    ['move_risk', `TEXT DEFAULT 'unknown'`],
    ['link_target', `TEXT DEFAULT ''`]
  ]
  for (const [name, decl] of added) {
    if (!existing.has(name)) d.exec(`ALTER TABLE software ADD COLUMN ${name} ${decl}`)
  }

  // 刚补出来的 external_active_at 全是 0，等于让存量条目继续显示「从未使用」——
  // 而那正是这个字段要治的毛病。补列的同一次启动就把它填上，只跑这一次。
  if (!existing.has('external_active_at')) backfillExternalActive(d)

  const pendingCols = new Set(
    (d.prepare('PRAGMA table_info(pending_software)').all() as Row[]).map((c) => c.name as string)
  )
  for (const [name, decl] of [
    ['is_portable', 'INTEGER DEFAULT NULL'],
    ['move_risk', `TEXT DEFAULT 'unknown'`]
  ] as Array<[string, string]>) {
    if (!pendingCols.has(name)) d.exec(`ALTER TABLE pending_software ADD COLUMN ${name} ${decl}`)
  }

  // 0.3.1 起扫描根那一层的散落 exe 只上报、不识别（见 scanPlan.ts 的 ScanPlan.loose），
  // 所以 loose_only 的单元再也不会被生成。存量的那几行既不会被重扫刷新、也永远停在
  // pending，只会让 agent 白跑一趟去认一个安装器。已经认出来的软件条目不受影响 ——
  // scan_units 只是「还要识别哪些目录」的待办表。
  d.prepare('DELETE FROM scan_units WHERE loose_only = 1').run()

  // description 是 0.2 给 categories 加的一列，下面的重建要往里写，所以先保证它在
  const catCols = new Set(
    (d.prepare('PRAGMA table_info(categories)').all() as Row[]).map((c) => c.name as string)
  )
  if (!catCols.has('description')) {
    d.exec(`ALTER TABLE categories ADD COLUMN description TEXT DEFAULT ''`)
  }

  if (schemaVersion(d) < SCHEMA_VERSION) {
    rebuildCategories(d)
    seedBuiltinTags(d)
    setSchemaVersion(d, SCHEMA_VERSION)
  }
}

/**
 * 0.4 换一套分类：清空分类表，装上 DEFAULT_CATEGORIES 那 5 条。
 *
 * 「清空」是有意的，包括用户自建的分类 —— 分类是靠**名字**挂在条目上的，
 * 留着一个不在新体系里的分类，只会让侧边栏同时显示新旧两套格子。名下的条目按
 * CATEGORY_MOVES 迁移，映射不到的退回「其他」：条目本身一条不少，只是要重归一次。
 *
 * 只跑一次，跑完写版本号。之后用户在设置里加的分类不会再被碰。
 */
function rebuildCategories(d: Database.Database): void {
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM categories').run()
    insertCategories(d, DEFAULT_CATEGORIES)

    // 暂存区也要迁 —— 升级前刚识别完还没确认的那批，分类同样是旧体系的
    for (const table of ['software', 'pending_software']) {
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
  tx()
}

/** 逐条读磁盘补 external_active_at。软件条目是千级，一次几百毫秒，只在升级时发生 */
function backfillExternalActive(d: Database.Database): void {
  const rows = d.prepare('SELECT id, exe_path FROM software').all() as Row[]
  if (rows.length === 0) return
  const stmt = d.prepare('UPDATE software SET external_active_at = ? WHERE id = ?')
  const tx = d.transaction(() => {
    for (const r of rows) stmt.run(readExternalActiveAt(r.exe_path), r.id)
  })
  tx()
}

/* ------------------------------ 行 <-> 对象 ------------------------------ */

function safeJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function safeLaunchers(raw: unknown, fallbackPath: string): Launcher[] {
  let parsed: unknown = []
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = []
    }
  }
  const list = Array.isArray(parsed)
    ? parsed
        .filter((l): l is Row => !!l && typeof l === 'object' && typeof l.path === 'string')
        .map((l) => ({
          path: String(l.path),
          label: typeof l.label === 'string' ? l.label : '',
          kind: l.kind === 'extra' ? ('extra' as const) : ('main' as const),
          is_default: l.is_default === true
        }))
    : []

  if (list.length === 0) {
    return [{ path: fallbackPath, label: '默认', kind: 'main', is_default: true }]
  }
  // 落库时已保证有且只有一个默认端，这里再兜一次，避免手工改库改坏
  if (!list.some((l) => l.is_default)) list[0].is_default = true
  return list
}

/**
 * SQLite 没有布尔类型，而这一列的三个状态（是 / 否 / 还没判断）都有意义，
 * 所以 NULL 必须原样传上去，不能顺手 `?? false` 掉。
 */
function safeTriBool(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null
  return raw === 1 || raw === true
}

function safeRisk(raw: unknown): MoveRisk {
  return raw === 'safe' || raw === 'risky' ? raw : 'unknown'
}

function rowToItem(row: Row): SoftwareItem {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    exe_path: row.exe_path,
    icon_path: row.icon_path ?? '',
    file_name: row.file_name,
    file_description: row.file_description ?? '',
    company: row.company ?? '',
    version: row.version ?? '',
    file_size: row.file_size ?? 0,
    source_dir: row.source_dir ?? '',
    name_zh: row.name_zh ?? '',
    name_en: row.name_en ?? '',
    summary: row.summary ?? '',
    description: row.description ?? '',
    category: row.category ?? FALLBACK_CATEGORY,
    tags: safeJsonArray(row.tags),
    official_url: row.official_url ?? '',
    ai_status: row.ai_status ?? 'pending',
    launchers: safeLaunchers(row.launchers, row.exe_path),
    why_choose: row.why_choose ?? '',
    use_cases: row.use_cases ?? '',
    notes: row.notes ?? '',
    alternatives: safeJsonArray(row.alternatives),
    mastery_level: row.mastery_level ?? 'new',
    last_used_at: row.last_used_at ?? 0,
    use_count: row.use_count ?? 0,
    is_archived: row.is_archived === 1,
    external_active_at: row.external_active_at ?? 0,
    is_portable: safeTriBool(row.is_portable),
    move_risk: safeRisk(row.move_risk),
    link_target: row.link_target ?? ''
  }
}

/** 只有 SoftwareItem 里存在的列才允许写入，避免把任意字段透传进 SQL */
const WRITABLE_COLUMNS = new Set([
  'exe_path', 'icon_path', 'file_name', 'file_description', 'company', 'version', 'file_size',
  'source_dir', 'name_zh', 'name_en', 'summary', 'description', 'category', 'tags',
  'official_url', 'ai_status', 'launchers',
  'why_choose', 'use_cases', 'notes', 'alternatives', 'mastery_level',
  'last_used_at', 'use_count', 'is_archived', 'external_active_at',
  'is_portable', 'move_risk', 'link_target'
])

const JSON_COLUMNS = new Set(['tags', 'alternatives', 'launchers'])

function toColumnValue(key: string, value: unknown): string | number | null {
  if (JSON_COLUMNS.has(key)) {
    return JSON.stringify(Array.isArray(value) ? value : [])
  }
  // 三态列：null 要真的写成 NULL，不能被下面的 `value == null → ''` 压成空串
  if (key === 'is_portable') return value === null || value === undefined ? null : value ? 1 : 0
  if (key === 'is_archived') return value ? 1 : 0
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  return value == null ? '' : String(value)
}

/* -------------------------------- 查询 -------------------------------- */

/**
 * 「上次活跃」在 SQL 里的表达式：抱一记到的启动时间和外部活跃时间取晚的那个。
 * 长期未用的判定和默认排序都走它 —— 只看 last_used_at 会把刚导入的整库
 * 一律算成「从未使用」，那是抱一还没开始记账，不是用户真的没用过。
 */
const ACTIVE_AT = 'MAX(last_used_at, external_active_at)'

export function listSoftware(query: SoftwareQuery = {}): SoftwareItem[] {
  const d = getDb()
  const where: string[] = []
  const params: Row = {}

  const group = query.group ?? 'all'
  if (group === 'archived') {
    where.push('is_archived = 1')
  } else {
    where.push('is_archived = 0')
    if (group === 'unused') {
      const days = query.unused_days ?? 60
      params.cutoff = Date.now() - days * 86400_000
      // 两边都读不到时间的（= 0）同样算长期未用
      where.push(`${ACTIVE_AT} < @cutoff`)
    } else if (group === 'pending') {
      where.push(`ai_status IN ('pending', 'failed')`)
    } else if (group === 'portable') {
      where.push('is_portable = 1')
    }
  }

  if (query.category) {
    where.push('category = @category')
    params.category = query.category
  }
  if (query.mastery) {
    where.push('mastery_level = @mastery')
    params.mastery = query.mastery
  }
  if (query.tag) {
    // tags 存的是 JSON 数组字符串，用 "标签" 带引号匹配避免命中子串
    where.push('tags LIKE @tagLike')
    params.tagLike = `%"${query.tag}"%`
  }
  const keyword = query.keyword?.trim()
  if (keyword) {
    where.push(`(
      name_zh LIKE @kw OR name_en LIKE @kw OR summary LIKE @kw OR description LIKE @kw
      OR tags LIKE @kw OR file_name LIKE @kw OR company LIKE @kw OR file_description LIKE @kw
    )`)
    params.kw = `%${keyword}%`
  }

  const order =
    query.sort === 'name'
      ? `COALESCE(NULLIF(name_zh, ''), file_name) ASC`
      : query.sort === 'count'
        ? 'use_count DESC, last_used_at DESC'
        : query.sort === 'added'
          ? 'created_at DESC'
          : `${ACTIVE_AT} DESC, created_at DESC`

  const rows = d
    .prepare(`SELECT * FROM software WHERE ${where.join(' AND ')} ORDER BY ${order}`)
    .all(params) as Row[]
  return rows.map(rowToItem)
}

export function getSoftware(id: string): SoftwareItem | null {
  const row = getDb().prepare('SELECT * FROM software WHERE id = ?').get(id) as Row | undefined
  return row ? rowToItem(row) : null
}

export function getSoftwareByPath(exePath: string): SoftwareItem | null {
  const row = getDb().prepare('SELECT * FROM software WHERE exe_path = ?').get(exePath) as
    | Row
    | undefined
  return row ? rowToItem(row) : null
}

export function updateSoftware(id: string, patch: Partial<SoftwareItem>): SoftwareItem | null {
  const d = getDb()
  const entries = Object.entries(patch).filter(([k]) => WRITABLE_COLUMNS.has(k))
  if (entries.length === 0) return getSoftware(id)

  const sets = entries.map(([k]) => `${k} = @${k}`).join(', ')
  const params: Row = { id, updated_at: Date.now() }
  for (const [k, v] of entries) params[k] = toColumnValue(k, v)

  d.prepare(`UPDATE software SET ${sets}, updated_at = @updated_at WHERE id = @id`).run(params)
  return getSoftware(id)
}

export function deleteSoftware(id: string): void {
  getDb().prepare('DELETE FROM software WHERE id = ?').run(id)
}

/* ------------------------------ agent 注册 ------------------------------ */

/** 从启动端列表里挑出默认端，并保证有且只有一个 is_default */
function normalizeLaunchers(raw: Launcher[]): Launcher[] {
  const list = raw
    .filter((l) => l && typeof l.path === 'string' && l.path.trim().length > 0)
    .map((l) => ({
      path: l.path.trim(),
      label: (l.label ?? '').trim().slice(0, 20),
      kind: l.kind === 'extra' ? ('extra' as const) : ('main' as const),
      is_default: l.is_default === true
    }))

  // 同一路径只保留一次，避免 agent 重复列出
  const seen = new Set<string>()
  const unique = list.filter((l) => {
    const key = l.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (unique.length === 0) return []

  let defaultIndex = unique.findIndex((l) => l.is_default && l.kind === 'main')
  if (defaultIndex < 0) defaultIndex = unique.findIndex((l) => l.kind === 'main')
  if (defaultIndex < 0) defaultIndex = 0
  return unique.map((l, i) => ({ ...l, is_default: i === defaultIndex }))
}

export interface RegisterFileFacts {
  file_name: string
  file_description: string
  company: string
  version: string
  file_size: number
  /** 软件目录里配置文件的最新 mtime，见 services/activity.ts */
  external_active_at: number
}

export interface RegisterOutcome {
  id: string
  created: boolean
  exe_path: string
}

/**
 * agent 调用 register_software 的落库出口。
 * 以默认启动端的路径作唯一键：同一路径重复注册视为更新，
 * 更新时只覆盖 AI 字段，用户自己填的备注 / 熟练度 / 使用统计一律保留。
 */
export function registerSoftware(
  payload: RegisterPayload,
  facts: RegisterFileFacts
): RegisterOutcome | null {
  const launchers = normalizeLaunchers(payload.launchers)
  if (launchers.length === 0) return null
  const primary = launchers.find((l) => l.is_default) ?? launchers[0]

  const d = getDb()
  const now = Date.now()
  const aiFields = {
    name_zh: payload.name_zh,
    name_en: payload.name_en,
    summary: payload.summary,
    description: payload.description,
    category: payload.category,
    tags: JSON.stringify(payload.tags),
    official_url: payload.official_url,
    launchers: JSON.stringify(launchers),
    source_dir: payload.source_dir,
    is_portable: payload.is_portable === null ? null : payload.is_portable ? 1 : 0,
    move_risk: payload.move_risk
  }

  const existing = d.prepare('SELECT id FROM software WHERE exe_path = ?').get(primary.path) as
    | Row
    | undefined

  if (existing) {
    d.prepare(
      `UPDATE software SET
         name_zh = @name_zh, name_en = @name_en, summary = @summary, description = @description,
         category = @category, tags = @tags, official_url = @official_url,
         launchers = @launchers, source_dir = @source_dir,
         is_portable = @is_portable, move_risk = @move_risk,
         file_name = @file_name, file_description = @file_description,
         company = @company, version = @version, file_size = @file_size,
         external_active_at = @external_active_at,
         ai_status = 'done', updated_at = @updated_at
       WHERE id = @id`
    ).run({ ...aiFields, ...facts, id: existing.id, updated_at: now })
    return { id: existing.id, created: false, exe_path: primary.path }
  }

  const id = randomUUID()
  d.prepare(
    `INSERT INTO software
       (id, created_at, updated_at, exe_path, icon_path, file_name, file_description,
        company, version, file_size, source_dir, name_zh, name_en, summary, description,
        category, tags, official_url, ai_status, launchers, external_active_at,
        is_portable, move_risk)
     VALUES
       (@id, @created_at, @updated_at, @exe_path, '', @file_name, @file_description,
        @company, @version, @file_size, @source_dir, @name_zh, @name_en, @summary, @description,
        @category, @tags, @official_url, 'done', @launchers, @external_active_at,
        @is_portable, @move_risk)`
  ).run({ ...aiFields, ...facts, id, created_at: now, updated_at: now, exe_path: primary.path })

  return { id, created: true, exe_path: primary.path }
}

/**
 * 重跑一个目录后，清掉「上一轮注册过、这一轮没再注册、用户也没碰过」的残留条目。
 * 只删零使用 + 无备注 + 未归档的，用户写过一个字就留着。
 * 必须在 agent 跑完之后调用，olderThan 传本轮开始的时间戳。
 *
 * ponytail: 「碰过」是启发式判断 —— 用户如果只改过分类不会被算作碰过。
 * 要更严谨得给表加一个 user_touched 标记位，在 updateSoftware 里置位。
 */
export function pruneStaleBySourceDir(dir: string, olderThan: number): number {
  const info = getDb()
    .prepare(
      `DELETE FROM software
       WHERE source_dir = ? AND updated_at < ?
         AND use_count = 0 AND last_used_at = 0 AND is_archived = 0
         AND why_choose = '' AND use_cases = '' AND notes = '' AND alternatives IN ('[]', '')
         AND mastery_level = 'new'`
    )
    .run(dir, olderThan)
  return info.changes
}

/** 某个目录下已注册的条目，用来告诉 agent 别重复注册 */
export function listBySourceDir(dir: string): SoftwareItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM software WHERE source_dir = ? ORDER BY created_at')
    .all(dir) as Row[]
  return rows.map(rowToItem)
}

/* ------------------------------ 暂存与确认 ------------------------------ */

function rowToPending(row: Row): PendingItem {
  return {
    id: row.id,
    created_at: row.created_at,
    scan_unit_id: row.scan_unit_id ?? '',
    exe_path: row.exe_path,
    icon_path: row.icon_path ?? '',
    file_name: row.file_name,
    file_description: row.file_description ?? '',
    company: row.company ?? '',
    version: row.version ?? '',
    file_size: row.file_size ?? 0,
    external_active_at: row.external_active_at ?? 0,
    name_zh: row.name_zh ?? '',
    name_en: row.name_en ?? '',
    summary: row.summary ?? '',
    description: row.description ?? '',
    category: row.category ?? FALLBACK_CATEGORY,
    tags: safeJsonArray(row.tags),
    official_url: row.official_url ?? '',
    launchers: safeLaunchers(row.launchers, row.exe_path),
    source_dir: row.source_dir ?? '',
    is_portable: safeTriBool(row.is_portable),
    move_risk: safeRisk(row.move_risk),
    new_category: row.new_category === 1,
    new_tags: safeJsonArray(row.new_tags)
  }
}

export function listPending(): PendingItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM pending_software ORDER BY source_dir, created_at')
    .all() as Row[]
  return rows.map(rowToPending)
}

export function countPending(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM pending_software').get() as { n: number }).n
}

export function isSkipped(exePath: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM skip_list WHERE exe_path = ?').get(exePath)
}

export interface StageOutcome {
  id: string
  created: boolean
  exe_path: string
}

/**
 * agent 识别完的落脚点。
 *
 * 和 0.1.x 直接写 software 的区别就一件事：这里写完不算数，等用户在确认面板点头。
 * 顺带把「AI 提了个新分类」「AI 造了个新标签」标出来，面板要靠它高亮。
 * 用户明确否决过的路径直接不收，否则每次重扫都要再否决一遍。
 */
export function stagePending(
  payload: RegisterPayload,
  facts: RegisterFileFacts,
  scanUnitId: string,
  iconPath: string
): StageOutcome | null {
  const launchers = normalizeLaunchers(payload.launchers)
  if (launchers.length === 0) return null
  const primary = launchers.find((l) => l.is_default) ?? launchers[0]
  if (isSkipped(primary.path)) return null

  const d = getDb()
  const now = Date.now()
  const knownCategories = new Set(listCategories().map((c) => c.name))
  const pool = new Set(tagPool())
  const newTags = payload.tags.filter((t) => !pool.has(t))

  const existing = d.prepare('SELECT id FROM pending_software WHERE exe_path = ?').get(primary.path) as
    | Row
    | undefined
  const id = existing?.id ?? randomUUID()

  const values = {
    id,
    created_at: existing ? undefined : now,
    scan_unit_id: scanUnitId,
    exe_path: primary.path,
    icon_path: iconPath,
    file_name: facts.file_name,
    file_description: facts.file_description,
    company: facts.company,
    version: facts.version,
    file_size: facts.file_size,
    external_active_at: facts.external_active_at,
    name_zh: payload.name_zh,
    name_en: payload.name_en,
    summary: payload.summary,
    description: payload.description,
    category: payload.category || FALLBACK_CATEGORY,
    tags: JSON.stringify(payload.tags),
    official_url: payload.official_url,
    launchers: JSON.stringify(launchers),
    source_dir: payload.source_dir,
    is_portable: payload.is_portable === null ? null : payload.is_portable ? 1 : 0,
    move_risk: payload.move_risk,
    new_category: knownCategories.has(payload.category) ? 0 : 1,
    new_tags: JSON.stringify(newTags)
  }

  const tx = d.transaction(() => {
    if (existing) {
      d.prepare(
        `UPDATE pending_software SET
           scan_unit_id = @scan_unit_id, file_name = @file_name,
           file_description = @file_description, company = @company, version = @version,
           file_size = @file_size, external_active_at = @external_active_at,
           icon_path = @icon_path,
           name_zh = @name_zh, name_en = @name_en, summary = @summary, description = @description,
           category = @category, tags = @tags, official_url = @official_url,
           launchers = @launchers, source_dir = @source_dir,
           is_portable = @is_portable, move_risk = @move_risk,
           new_category = @new_category, new_tags = @new_tags
         WHERE id = @id`
      ).run({ ...values, created_at: undefined })
    } else {
      d.prepare(
        `INSERT INTO pending_software
           (id, created_at, scan_unit_id, exe_path, icon_path, file_name, file_description,
            company, version, file_size, external_active_at, name_zh, name_en, summary,
            description, category, tags, official_url, launchers, source_dir,
            is_portable, move_risk, new_category, new_tags)
         VALUES
           (@id, @created_at, @scan_unit_id, @exe_path, @icon_path, @file_name, @file_description,
            @company, @version, @file_size, @external_active_at, @name_zh, @name_en, @summary,
            @description, @category, @tags, @official_url, @launchers, @source_dir,
            @is_portable, @move_risk, @new_category, @new_tags)`
      ).run({ ...values, created_at: now })
    }

    // AI 造的新词先记成 ai，不进池 —— 用户确认那一步才转正
    for (const t of newTags) insertTag(d, t, 'ai')
  })
  tx()

  return { id, created: !existing, exe_path: primary.path }
}

const PENDING_EDITABLE = new Set([
  'name_zh', 'name_en', 'summary', 'description', 'category', 'tags', 'official_url',
  'is_portable', 'move_risk'
])

/** 确认面板里改一个字段就存一次，不攒到最后 —— 中途关掉窗口不该丢改动 */
export function updatePending(id: string, patch: Partial<PendingItem>): PendingItem | null {
  const d = getDb()
  const entries = Object.entries(patch).filter(([k]) => PENDING_EDITABLE.has(k))
  if (entries.length > 0) {
    const params: Row = { id }
    for (const [k, v] of entries) {
      params[k] =
        k === 'tags'
          ? JSON.stringify(v ?? [])
          : k === 'is_portable'
            ? v === null || v === undefined
              ? null
              : v
                ? 1
                : 0
            : String(v ?? '')
    }

    // 用户动过手的分类 / 标签就不再是「AI 提议」了，标记跟着撤掉
    const sets = entries.map(([k]) => `${k} = @${k}`)
    if (patch.category !== undefined) sets.push('new_category = 0')
    if (patch.tags !== undefined) sets.push(`new_tags = '[]'`)
    d.prepare(`UPDATE pending_software SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  const row = d.prepare('SELECT * FROM pending_software WHERE id = ?').get(id) as Row | undefined
  return row ? rowToPending(row) : null
}

/**
 * 确认写入：暂存条目搬进 software。
 *
 * 同一趟里把 AI 提的新分类建出来、把它造的新标签转正 —— 用户点了确认，
 * 就是认可了这两件事，不该再让他去管理页补一遍。
 */
export function confirmPending(ids: string[]): ConfirmResult {
  const d = getDb()
  if (ids.length === 0) return { registered: 0, categories: [], tags: [] }

  const placeholders = ids.map(() => '?').join(',')
  const rows = d
    .prepare(`SELECT * FROM pending_software WHERE id IN (${placeholders})`)
    .all(...ids) as Row[]
  if (rows.length === 0) return { registered: 0, categories: [], tags: [] }

  const startedAt = Date.now()
  const knownCategories = new Set(listCategories().map((c) => c.name))
  const createdCategories: string[] = []
  const promotedTags: string[] = []
  let registered = 0

  for (const row of rows) {
    const item = rowToPending(row)

    if (item.category && !knownCategories.has(item.category)) {
      const next = (d.prepare('SELECT MAX(sort_order) AS n FROM categories').get() as { n: number | null }).n ?? 0
      insertCategories(d, [
        { id: randomUUID(), name: item.category, description: 'AI 识别时提议，已确认', icon: 'box', sort_order: next + 1 }
      ])
      knownCategories.add(item.category)
      createdCategories.push(item.category)
    }

    const outcome = registerSoftware(
      {
        name_zh: item.name_zh,
        name_en: item.name_en,
        summary: item.summary,
        description: item.description,
        category: item.category || FALLBACK_CATEGORY,
        tags: item.tags,
        official_url: item.official_url,
        launchers: item.launchers,
        source_dir: item.source_dir,
        is_portable: item.is_portable,
        move_risk: item.move_risk
      },
      {
        file_name: item.file_name,
        file_description: item.file_description,
        company: item.company,
        version: item.version,
        file_size: item.file_size,
        external_active_at: item.external_active_at
      }
    )
    if (!outcome) continue
    registered++

    if (item.icon_path) updateSoftware(outcome.id, { icon_path: item.icon_path })

    // 确认时条目上挂着的 AI 标签就此转正入池；用户自己敲进去的新词直接算 user
    for (const name of item.tags) {
      const tag = d.prepare('SELECT id, source FROM tags WHERE name = ?').get(name) as Row | undefined
      if (!tag) {
        insertTag(d, name, 'user')
        promotedTags.push(name)
      } else if (tag.source === 'ai') {
        d.prepare(`UPDATE tags SET source = 'confirmed' WHERE id = ?`).run(tag.id)
        promotedTags.push(name)
      }
    }

    d.prepare('DELETE FROM pending_software WHERE id = ?').run(item.id)
  }

  pruneStaleAfterConfirm(d, [...new Set(rows.map((r) => r.source_dir as string))], startedAt)
  pruneOrphanAiTags(d)

  return { registered, categories: createdCategories, tags: [...new Set(promotedTags)] }
}

/**
 * 一个目录暂存的条目全部处理完之后，清掉上一轮注册过、这一轮没再出现、用户也没碰过的残留。
 * 「全部处理完」这个前提不能省：只确认了一半就清理，会连带删掉另一半对应的旧条目。
 */
function pruneStaleAfterConfirm(d: Database.Database, dirs: string[], olderThan: number): void {
  for (const dir of dirs) {
    if (!dir) continue
    const left = d.prepare('SELECT COUNT(*) AS n FROM pending_software WHERE source_dir = ?').get(dir) as { n: number }
    if (left.n > 0) continue
    pruneStaleBySourceDir(dir, olderThan)
  }
}

/** 忽略名单里现在有多少条。设置页要能看见它，否则误点的「不注册」就成了死结 */
export function countSkipped(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM skip_list').get() as { n: number }).n
}

/** 清空忽略名单：这些程序下次识别会重新出现在确认面板里 */
export function clearSkipped(): number {
  return getDb().prepare('DELETE FROM skip_list').run().changes
}

/** 用户说「不注册」：从暂存区移走并记进忽略名单，下次识别不再冒出来 */
export function skipPending(ids: string[]): number {
  const d = getDb()
  if (ids.length === 0) return 0
  const now = Date.now()
  let n = 0

  const tx = d.transaction(() => {
    const get = d.prepare('SELECT * FROM pending_software WHERE id = ?')
    const add = d.prepare(
      `INSERT INTO skip_list (exe_path, label, source_dir, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(exe_path) DO NOTHING`
    )
    const del = d.prepare('DELETE FROM pending_software WHERE id = ?')
    for (const id of ids) {
      const row = get.get(id) as Row | undefined
      if (!row) continue
      add.run(row.exe_path, row.name_zh || row.file_name, row.source_dir ?? '', now)
      del.run(id)
      n++
    }
    pruneOrphanAiTags(d)
  })
  tx()
  return n
}

/* ------------------------------ 扫描单元 ------------------------------ */

function rowToUnit(row: Row): ScanUnit {
  return {
    dir: row.dir,
    root: row.root,
    exe_count: row.exe_count ?? 0,
    loose_only: row.loose_only === 1,
    status: (row.status ?? 'pending') as ScanUnitStatus,
    note: row.note ?? '',
    registered: row.registered ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

/**
 * 写入本次扫描发现的目录。已存在的目录保留原状态（不重复付费识别），只刷新 exe 数量。
 *
 * 返回的三个数字是按**状态**分的，不是按「行是否已存在」分的 ——
 * 一个之前就在表里、但还没识别过的目录，对用户来说仍然是「待识别」而不是「已处理」。
 */
export function upsertScanUnits(
  units: Array<Pick<ScanUnit, 'dir' | 'root' | 'exe_count' | 'loose_only'>>
): { added: number; pending: number; settled: number } {
  const d = getDb()
  const now = Date.now()
  const insert = d.prepare(
    `INSERT INTO scan_units (dir, root, exe_count, loose_only, status, note, registered, created_at, updated_at)
     VALUES (@dir, @root, @exe_count, @loose_only, 'pending', '', 0, @now, @now)
     ON CONFLICT(dir) DO UPDATE SET exe_count = @exe_count, root = @root, updated_at = @now`
  )
  const current = d.prepare('SELECT status FROM scan_units WHERE dir = ?')

  let added = 0
  let pending = 0
  let settled = 0
  const tx = d.transaction(() => {
    for (const u of units) {
      const row = current.get(u.dir) as Row | undefined
      if (!row) {
        added++
        pending++
      } else if (row.status === 'pending' || row.status === 'failed') {
        // 之前就发现了但还没识别成功，这次照样得跑
        pending++
      } else {
        settled++
      }
      insert.run({
        dir: u.dir,
        root: u.root,
        exe_count: u.exe_count,
        loose_only: u.loose_only ? 1 : 0,
        now
      })
    }
  })
  tx()
  return { added, pending, settled }
}

export function listScanUnits(status?: ScanUnitStatus): ScanUnit[] {
  const d = getDb()
  const rows = (
    status
      ? d.prepare('SELECT * FROM scan_units WHERE status = ? ORDER BY dir').all(status)
      : d.prepare('SELECT * FROM scan_units ORDER BY status, dir').all()
  ) as Row[]
  return rows.map(rowToUnit)
}

/**
 * 还需要跑 agent 的目录：没跑过的，加上跑失败的。
 * 失败的必须算进来 —— 否则一个目录失败一次就永远卡住，只能靠「全部重新识别」才捞得回来。
 */
export function listUnfinishedUnits(): ScanUnit[] {
  const rows = getDb()
    .prepare(`SELECT * FROM scan_units WHERE status IN ('pending','failed') ORDER BY status, dir`)
    .all() as Row[]
  return rows.map(rowToUnit)
}

export function markScanUnit(
  dir: string,
  status: ScanUnitStatus,
  note = '',
  registered = 0
): void {
  getDb()
    .prepare(
      `UPDATE scan_units SET status = ?, note = ?, registered = ?, updated_at = ? WHERE dir = ?`
    )
    .run(status, note.slice(0, 300), registered, Date.now(), dir)
}

/** 把所有非 pending 的单元退回 pending，用于「全部重新识别」 */
export function resetScanUnits(): number {
  const info = getDb()
    .prepare(`UPDATE scan_units SET status = 'pending', note = '', updated_at = ? WHERE status != 'pending'`)
    .run(Date.now())
  return info.changes
}

/** 单个目录退回待识别。跳过/失败的目录旁边那个「重试」按钮走这里 */
export function resetScanUnit(dir: string): boolean {
  const info = getDb()
    .prepare(`UPDATE scan_units SET status = 'pending', note = '', updated_at = ? WHERE dir = ?`)
    .run(Date.now(), dir)
  return info.changes > 0
}

/** 扫描目录被移除时，连带清掉它名下的单元 */
export function removeScanUnitsUnder(root: string): number {
  const info = getDb().prepare('DELETE FROM scan_units WHERE root = ?').run(root)
  return info.changes
}

/* ------------------------------ 识别日志 ------------------------------ */

/** 保留的日志条数。够翻完最近几轮识别，又不会让 db 无限长大 */
const LOG_KEEP = 300
/** 单条工具返回回放时截断的长度。原文回灌给模型时本就只有 6000 字符 */
const LOG_TEXT_MAX = 4000
/** 单条日志最多存几个事件，兜住模型疯狂打转的极端情况 */
const LOG_EVENT_MAX = 400

/** 事件里真正占空间的只有文本，落库前先削一刀 */
function trimEvents(events: AgentEvent[]): AgentEvent[] {
  return events.slice(0, LOG_EVENT_MAX).map((e) => {
    if (e.type === 'tool_result' && e.text.length > LOG_TEXT_MAX) {
      return { ...e, text: `${e.text.slice(0, LOG_TEXT_MAX)}\n…（已截断，共 ${e.text.length} 字符）` }
    }
    if (e.type === 'text' && e.text.length > LOG_TEXT_MAX) {
      return { ...e, text: `${e.text.slice(0, LOG_TEXT_MAX)}\n…（已截断）` }
    }
    return e
  })
}

export function saveIdentifyLog(log: Omit<IdentifyLog, 'id' | 'created_at'>): string {
  const d = getDb()
  const id = randomUUID()
  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO identify_logs
         (id, dir, label, kind, status, summary, registered, rounds,
          duration_ms, tokens, stop_reason, events, created_at)
       VALUES
         (@id, @dir, @label, @kind, @status, @summary, @registered, @rounds,
          @duration_ms, @tokens, @stop_reason, @events, @created_at)`
    ).run({
      id,
      dir: log.dir,
      label: log.label,
      kind: log.kind,
      status: log.status,
      summary: log.summary.slice(0, 500),
      registered: log.registered,
      rounds: log.rounds,
      duration_ms: log.duration_ms,
      tokens: log.tokens,
      stop_reason: log.stop_reason,
      events: JSON.stringify(trimEvents(log.events)),
      created_at: Date.now()
    })
    d.prepare(
      `DELETE FROM identify_logs WHERE id NOT IN (
         SELECT id FROM identify_logs ORDER BY created_at DESC LIMIT ?
       )`
    ).run(LOG_KEEP)
  })
  tx()
  return id
}

function rowToLog(row: Row): IdentifyLog {
  let events: AgentEvent[] = []
  try {
    const parsed = JSON.parse(row.events ?? '[]')
    if (Array.isArray(parsed)) events = parsed
  } catch {
    /* 存进去的是我们自己序列化的，解析失败就当没有过程记录，不影响结论那几行 */
  }
  return {
    id: row.id,
    dir: row.dir,
    label: row.label ?? '',
    kind: row.kind === 'item' ? 'item' : 'unit',
    status: (row.status ?? 'failed') as IdentifyLogStatus,
    summary: row.summary ?? '',
    registered: row.registered ?? 0,
    rounds: row.rounds ?? 0,
    duration_ms: row.duration_ms ?? 0,
    tokens: row.tokens ?? 0,
    stop_reason: row.stop_reason ?? '',
    events,
    created_at: row.created_at
  }
}

export function listIdentifyLogs(query: IdentifyLogQuery = {}): IdentifyLog[] {
  const where: string[] = []
  const params: unknown[] = []
  if (query.status) {
    where.push('status = ?')
    params.push(query.status)
  }
  const keyword = query.keyword?.trim()
  if (keyword) {
    where.push('(dir LIKE ? OR label LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  params.push(Math.min(Math.max(query.limit ?? 100, 1), LOG_KEEP))

  const rows = getDb()
    .prepare(
      `SELECT * FROM identify_logs
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params) as Row[]
  return rows.map(rowToLog)
}

export function clearIdentifyLogs(): number {
  const d = getDb()
  // 报告只是这些日志的汇总视图，日志清了它就没有依据了 —— 一起清掉
  const n = d.prepare('DELETE FROM identify_logs').run().changes
  d.prepare('DELETE FROM identification_reports').run()
  return n
}

/* ------------------------------ 汇总报告 ------------------------------ */

/** 保留的报告条数。一轮识别一条，够翻回前几周 */
const REPORT_KEEP = 50

export function saveIdentifyReport(
  report: Omit<IdentifyReport, 'id' | 'created_at'>
): string {
  const d = getDb()
  const id = randomUUID()
  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO identification_reports
         (id, created_at, processed, registered, skipped, failed,
          duration_ms, tokens, searches, entries)
       VALUES
         (@id, @created_at, @processed, @registered, @skipped, @failed,
          @duration_ms, @tokens, @searches, @entries)`
    ).run({
      id,
      created_at: Date.now(),
      processed: report.processed,
      registered: report.registered,
      skipped: report.skipped,
      failed: report.failed,
      duration_ms: report.duration_ms,
      tokens: report.tokens,
      searches: report.searches,
      entries: JSON.stringify(report.entries)
    })
    d.prepare(
      `DELETE FROM identification_reports WHERE id NOT IN (
         SELECT id FROM identification_reports ORDER BY created_at DESC LIMIT ?
       )`
    ).run(REPORT_KEEP)
  })
  tx()
  return id
}

export function listIdentifyReports(): IdentifyReport[] {
  return (
    getDb()
      .prepare('SELECT * FROM identification_reports ORDER BY created_at DESC')
      .all() as Row[]
  ).map((row) => {
    let entries: IdentifyReportEntry[] = []
    try {
      const parsed = JSON.parse(row.entries ?? '[]')
      if (Array.isArray(parsed)) entries = parsed
    } catch {
      /* 解析不出来就只剩总览那几个数字，它们本身就是独立存的列 */
    }
    return {
      id: row.id,
      created_at: row.created_at,
      processed: row.processed ?? 0,
      registered: row.registered ?? 0,
      skipped: row.skipped ?? 0,
      failed: row.failed ?? 0,
      duration_ms: row.duration_ms ?? 0,
      tokens: row.tokens ?? 0,
      searches: row.searches ?? 0,
      entries
    }
  })
}

/* ------------------------------ 整理记录 ------------------------------ */

function rowToPlan(row: Row): OrganizePlan {
  let steps: OrganizeStep[] = []
  try {
    const parsed = JSON.parse(row.steps ?? '[]')
    if (Array.isArray(parsed)) steps = parsed
  } catch {
    /* 解析不出来就当空，至少记录本身还在，用户能看到「那天整理过」 */
  }
  return {
    id: row.id,
    created_at: row.created_at,
    root: row.root ?? '',
    undone_at: row.undone_at ?? 0,
    steps
  }
}

export function saveOrganizePlan(root: string, steps: OrganizeStep[]): string {
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO organize_plans (id, created_at, root, undone_at, steps)
       VALUES (?, ?, ?, 0, ?)`
    )
    .run(id, Date.now(), root, JSON.stringify(steps))
  return id
}

export function listOrganizePlans(): OrganizePlan[] {
  return (
    getDb().prepare('SELECT * FROM organize_plans ORDER BY created_at DESC').all() as Row[]
  ).map(rowToPlan)
}

export function getOrganizePlan(id: string): OrganizePlan | null {
  const row = getDb().prepare('SELECT * FROM organize_plans WHERE id = ?').get(id) as Row | undefined
  return row ? rowToPlan(row) : null
}

/** 撤销完成后打标。已撤销的记录留着 —— 它回答的是「那天到底动了什么」 */
export function markPlanUndone(id: string): void {
  // 反引号不是随手写的：selfcheck 靠模板字符串的边界从构建产物里抠 SQL 原文出来
  // 做 prepare 校验（见 scripts/agent-selfcheck.ts），单引号的语句它取不到
  getDb().prepare(`UPDATE organize_plans SET undone_at = ? WHERE id = ?`).run(Date.now(), id)
}

/**
 * 目录搬走之后，把库里所有指向旧位置的路径改到新位置。
 *
 * 要改的不止 exe_path —— launchers 里每个启动端、source_dir、以及 scan_units
 * 的主键都带着旧前缀。漏掉任何一个都会表现成「整理完点启动就失败」，
 * 而那时候用户已经不知道是整理干的了。
 *
 * fromDir / toDir 传目录，不带结尾分隔符。
 */
export function remapPaths(
  id: string,
  fromDir: string,
  toDir: string,
  linkTarget: string
): SoftwareItem | null {
  const d = getDb()
  const item = getSoftware(id)
  if (!item) return null

  const launchers = item.launchers.map((l) => ({ ...l, path: rebase(l.path, fromDir, toDir) }))
  const nextExe = rebase(item.exe_path, fromDir, toDir)

  const tx = d.transaction(() => {
    d.prepare(
      `UPDATE software SET exe_path = @exe_path, launchers = @launchers, source_dir = @source_dir,
         link_target = @link_target, updated_at = @updated_at
       WHERE id = @id`
    ).run({
      id,
      exe_path: nextExe,
      launchers: JSON.stringify(launchers),
      source_dir: rebase(item.source_dir, fromDir, toDir),
      link_target: linkTarget,
      updated_at: Date.now()
    })

    // scan_units.dir 是主键，改不了就删旧插新。整理过的目录已经不在扫描根下了，
    // 留着那一行只会让下次「全部重新识别」去一个不存在的路径
    const unit = d.prepare('SELECT * FROM scan_units WHERE dir = ?').get(fromDir) as Row | undefined
    if (unit) {
      d.prepare('DELETE FROM scan_units WHERE dir = ?').run(fromDir)
      d.prepare(
        `INSERT INTO scan_units (dir, root, exe_count, loose_only, status, note, registered, created_at, updated_at)
         VALUES (@dir, @root, @exe_count, @loose_only, @status, @note, @registered, @created_at, @updated_at)
         ON CONFLICT(dir) DO NOTHING`
      ).run({ ...unit, dir: toDir, updated_at: Date.now() })
    }
  })
  tx()
  return getSoftware(id)
}

/* -------------------------------- 插入 -------------------------------- */

/** 插入扫描结果，已存在的 exe_path 直接跳过。返回新插入的条目。 */
export function insertScanned(files: ScannedFile[]): SoftwareItem[] {
  const d = getDb()
  const now = Date.now()
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO software
      (id, created_at, updated_at, exe_path, icon_path, file_name,
       file_description, company, version, file_size, name_zh, ai_status, source_dir, launchers,
       external_active_at)
    VALUES
      (@id, @created_at, @updated_at, @exe_path, '', @file_name,
       @file_description, @company, @version, @file_size, @name_zh, 'pending', @source_dir, @launchers,
       @external_active_at)
  `)

  const inserted: string[] = []
  const tx = d.transaction((rows: ScannedFile[]) => {
    for (const f of rows) {
      const id = randomUUID()
      const info = stmt.run({
        id,
        created_at: now,
        updated_at: now,
        exe_path: f.exe_path,
        file_name: f.file_name,
        file_description: f.file_description,
        company: f.company,
        version: f.version,
        file_size: f.file_size,
        source_dir: path.dirname(f.exe_path),
        external_active_at: readExternalActiveAt(f.exe_path),
        launchers: JSON.stringify([
          { path: f.exe_path, label: '默认', kind: 'main', is_default: true }
        ]),
        // 先用文件描述或文件名占位，AI 补全后覆盖
        name_zh: f.file_description || path.basename(f.file_name, path.extname(f.file_name))
      })
      if (info.changes > 0) inserted.push(id)
    }
  })
  tx(files)

  if (inserted.length === 0) return []
  const placeholders = inserted.map(() => '?').join(',')
  const rows = d
    .prepare(`SELECT * FROM software WHERE id IN (${placeholders})`)
    .all(...inserted) as Row[]
  return rows.map(rowToItem)
}

export function listForAi(ids?: string[]): SoftwareItem[] {
  const d = getDb()
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',')
    const rows = d
      .prepare(`SELECT * FROM software WHERE id IN (${placeholders})`)
      .all(...ids) as Row[]
    return rows.map(rowToItem)
  }
  const rows = d
    .prepare(`SELECT * FROM software WHERE ai_status IN ('pending','failed') ORDER BY created_at`)
    .all() as Row[]
  return rows.map(rowToItem)
}

export function recordLaunch(id: string): void {
  getDb()
    .prepare('UPDATE software SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
    .run(Date.now(), id)
}

export function counts(unusedDays: number): SidebarCounts {
  const d = getDb()
  const one = (sql: string, ...args: any[]) =>
    (d.prepare(sql).get(...args) as { n: number }).n

  const cutoff = Date.now() - unusedDays * 86400_000
  const categories = d
    .prepare(
      `SELECT category AS name, COUNT(*) AS count FROM software
       WHERE is_archived = 0 GROUP BY category ORDER BY count DESC`
    )
    .all() as Array<{ name: string; count: number }>

  // 标签存在 JSON 数组里，直接在 JS 里聚合（数据量在千级以内，够用）
  const tagRows = d.prepare('SELECT tags FROM software WHERE is_archived = 0').all() as Row[]
  const tagMap = new Map<string, number>()
  for (const r of tagRows) {
    for (const t of safeJsonArray(r.tags)) tagMap.set(t, (tagMap.get(t) ?? 0) + 1)
  }

  // 待识别目录还不是条目，和「待补全的条目」分开计，
  // 否则侧边栏点进去会出现「计数 30、列表 0」。失败的目录同样算待办，能被下一次识别捡起来。
  const pendingUnits = one(
    `SELECT COUNT(*) AS n FROM scan_units WHERE status IN ('pending','failed')`
  )
  const pendingItems = one(
    `SELECT COUNT(*) AS n FROM software WHERE is_archived = 0 AND ai_status IN ('pending','failed')`
  )

  return {
    all: one('SELECT COUNT(*) AS n FROM software WHERE is_archived = 0'),
    archived: one('SELECT COUNT(*) AS n FROM software WHERE is_archived = 1'),
    unused: one(
      `SELECT COUNT(*) AS n FROM software WHERE is_archived = 0 AND ${ACTIVE_AT} < ?`,
      cutoff
    ),
    pending: pendingItems,
    pending_units: pendingUnits,
    pending_confirm: one('SELECT COUNT(*) AS n FROM pending_software'),
    portable: one('SELECT COUNT(*) AS n FROM software WHERE is_archived = 0 AND is_portable = 1'),
    categories,
    tags: [...tagMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }
}

/* ------------------------------- 分类 ------------------------------- */

export function listCategories(): Category[] {
  return getDb()
    .prepare('SELECT * FROM categories ORDER BY sort_order, name')
    .all() as Category[]
}

export function upsertCategory(c: Category): Category[] {
  const d = getDb()
  const id = c.id || randomUUID()
  const previous = d.prepare('SELECT name FROM categories WHERE id = ?').get(id) as Row | undefined

  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO categories (id, name, description, icon, sort_order)
       VALUES (@id, @name, @description, @icon, @sort_order)
       ON CONFLICT(id) DO UPDATE SET
         name = @name, description = @description, icon = @icon, sort_order = @sort_order`
    ).run({ ...c, id, description: c.description ?? '', icon: c.icon ?? '' })

    // 分类是靠名字挂在条目上的，改名必须把引用一起改，否则一改名条目全掉进「其他」
    if (previous && previous.name !== c.name) {
      d.prepare('UPDATE software SET category = ? WHERE category = ?').run(c.name, previous.name)
      d.prepare('UPDATE pending_software SET category = ? WHERE category = ?').run(c.name, previous.name)
    }
  })
  tx()
  return listCategories()
}

export function removeCategory(id: string): Category[] {
  const d = getDb()
  const row = d.prepare('SELECT name FROM categories WHERE id = ?').get(id) as Row | undefined
  if (row) {
    // 分类是虚拟的，删除时把归属条目退回「其他」，不动实际文件
    const tx = d.transaction(() => {
      d.prepare('UPDATE software SET category = ? WHERE category = ?').run(FALLBACK_CATEGORY, row.name)
      d.prepare('UPDATE pending_software SET category = ? WHERE category = ?').run(FALLBACK_CATEGORY, row.name)
      d.prepare('DELETE FROM categories WHERE id = ?').run(id)
    })
    tx()
  }
  return listCategories()
}

/**
 * 上下挪一格。和相邻那条交换 sort_order 即可 —— 拖拽排序留给以后，
 * 这个按钮能到达完全一样的顺序，还能用键盘操作。
 */
export function moveCategory(id: string, delta: number): Category[] {
  const list = listCategories()
  const from = list.findIndex((c) => c.id === id)
  const to = from + (delta < 0 ? -1 : 1)
  if (from < 0 || to < 0 || to >= list.length) return list

  const reordered = [...list]
  ;[reordered[from], reordered[to]] = [reordered[to], reordered[from]]

  const d = getDb()
  const stmt = d.prepare('UPDATE categories SET sort_order = ? WHERE id = ?')
  // 整体重排一遍，顺便把历史上重复 / 空缺的 sort_order 抹平
  const tx = d.transaction(() => reordered.forEach((c, i) => stmt.run(i + 1, c.id)))
  tx()
  return listCategories()
}

/* ------------------------------- 标签 ------------------------------- */

/**
 * 每个标签实际被多少条目用着。
 *
 * ponytail: 规划里 tags 表带一个 usage_count 列，这里改成读的时候现算。
 * 标签存在 software.tags 的 JSON 数组里，详情页随手一改就会让计数列失真，
 * 而这个数字的唯一用途恰恰是「找出只挂着一个条目的碎片标签」—— 失真就没意义了。
 * 数据量在千级，一次全表扫描的代价可以忽略。
 */
function tagUsage(d: Database.Database): Map<string, number> {
  const map = new Map<string, number>()
  const rows = d.prepare('SELECT tags FROM software WHERE is_archived = 0').all() as Row[]
  for (const r of rows) {
    for (const t of safeJsonArray(r.tags)) map.set(t, (map.get(t) ?? 0) + 1)
  }
  return map
}

export function listTags(): Tag[] {
  const d = getDb()
  const usage = tagUsage(d)
  const rows = d.prepare('SELECT * FROM tags ORDER BY name').all() as Row[]
  return rows
    .map((r) => ({
      id: r.id as number,
      name: r.name as string,
      source: (r.source ?? 'ai') as TagSource,
      usage_count: usage.get(r.name) ?? 0,
      created_at: r.created_at as number
    }))
    .sort((a, b) => b.usage_count - a.usage_count || a.name.localeCompare(b.name, 'zh'))
}

/**
 * 注入 prompt 的标签池：只给用户认可过的。
 * agent 自己造的（source='ai'）不进池 —— 否则它造一个新词，下一轮就当成既成事实
 * 继续沿用，标签只会越长越碎，而这正是标签池要防的事。
 */
export function tagPool(): string[] {
  return (
    getDb()
      .prepare(`SELECT name FROM tags WHERE source IN ('user','confirmed') ORDER BY name`)
      .all() as Row[]
  ).map((r) => r.name as string)
}

function insertTag(d: Database.Database, name: string, source: TagSource): void {
  d.prepare(
    `INSERT INTO tags (name, source, created_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO NOTHING`
  ).run(name, source, Date.now())
}

export function createTag(name: string): Tag[] {
  const clean = name.trim().slice(0, 12)
  if (clean) insertTag(getDb(), clean, 'user')
  return listTags()
}

export function renameTag(id: number, name: string): Tag[] {
  const d = getDb()
  const clean = name.trim().slice(0, 12)
  const row = d.prepare('SELECT name FROM tags WHERE id = ?').get(id) as Row | undefined
  if (!clean || !row || row.name === clean) return listTags()

  // 改成一个已存在的名字，等同于合并
  const collide = d.prepare('SELECT id FROM tags WHERE name = ?').get(clean) as Row | undefined
  if (collide) return mergeTags([id], collide.id as number)

  const tx = d.transaction(() => {
    d.prepare('UPDATE tags SET name = ? WHERE id = ?').run(clean, id)
    replaceTagInEntries(d, [row.name as string], clean)
  })
  tx()
  return listTags()
}

/** 把 fromIds 这些标签并进 intoId，条目上的引用一并替换并去重 */
export function mergeTags(fromIds: number[], intoId: number): Tag[] {
  const d = getDb()
  const target = d.prepare('SELECT name FROM tags WHERE id = ?').get(intoId) as Row | undefined
  if (!target) return listTags()

  const sources = fromIds
    .filter((id) => id !== intoId)
    .map((id) => d.prepare('SELECT id, name FROM tags WHERE id = ?').get(id) as Row | undefined)
    .filter((r): r is Row => !!r)
  if (sources.length === 0) return listTags()

  const tx = d.transaction(() => {
    replaceTagInEntries(d, sources.map((s) => s.name as string), target.name as string)
    const del = d.prepare('DELETE FROM tags WHERE id = ?')
    for (const s of sources) del.run(s.id)
    // 并过之后目标标签就是用户的意思了，顺手转正
    d.prepare(`UPDATE tags SET source = 'confirmed' WHERE id = ? AND source = 'ai'`).run(intoId)
  })
  tx()
  return listTags()
}

export function removeTag(id: number): Tag[] {
  const d = getDb()
  const row = d.prepare('SELECT name FROM tags WHERE id = ?').get(id) as Row | undefined
  if (!row) return listTags()
  const tx = d.transaction(() => {
    replaceTagInEntries(d, [row.name as string], '')
    d.prepare('DELETE FROM tags WHERE id = ?').run(id)
  })
  tx()
  return listTags()
}

/**
 * 把条目（含暂存）标签数组里的 from 换成 to，to 为空串表示删除。
 * 标签存的是 JSON 数组，只能读出来改完写回去 —— SQL 里没法原地改。
 */
function replaceTagInEntries(d: Database.Database, from: string[], to: string): void {
  const drop = new Set(from)
  for (const table of ['software', 'pending_software']) {
    const rows = d.prepare(`SELECT id, tags FROM ${table}`).all() as Row[]
    const stmt = d.prepare(`UPDATE ${table} SET tags = ? WHERE id = ?`)
    for (const r of rows) {
      const tags = safeJsonArray(r.tags)
      if (!tags.some((t) => drop.has(t))) continue
      const next = tags.map((t) => (drop.has(t) ? to : t)).filter(Boolean)
      stmt.run(JSON.stringify([...new Set(next)]), r.id)
    }
  }
}

/** 清掉没有任何条目（含暂存区）在用的 AI 待确认标签，别让否决过的词一直留在管理页 */
function pruneOrphanAiTags(d: Database.Database): void {
  const used = new Set<string>()
  for (const table of ['software', 'pending_software']) {
    for (const r of d.prepare(`SELECT tags FROM ${table}`).all() as Row[]) {
      for (const t of safeJsonArray(r.tags)) used.add(t)
    }
  }
  const stale = (d.prepare(`SELECT id, name FROM tags WHERE source = 'ai'`).all() as Row[]).filter(
    (t) => !used.has(t.name as string)
  )
  const del = d.prepare('DELETE FROM tags WHERE id = ?')
  for (const t of stale) del.run(t.id)
}

/* ------------------------------- 设置 ------------------------------- */

export function getSettings(): AppSettings {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as Array<{
    key: string
    value: string
  }>
  const stored: Row = {}
  for (const r of rows) {
    // 下划线开头的是内部记账（_schema），不属于用户设置，不该透给渲染进程
    if (r.key.startsWith('_')) continue
    try {
      stored[r.key] = JSON.parse(r.value)
    } catch {
      stored[r.key] = r.value
    }
  }
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    ai: { ...DEFAULT_SETTINGS.ai, ...(stored.ai ?? {}) },
    search: { ...DEFAULT_SETTINGS.search, ...(stored.search ?? {}) }
  }
}

export function patchSettings(patch: Partial<AppSettings>): AppSettings {
  const d = getDb()
  const current = getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    ai: { ...current.ai, ...(patch.ai ?? {}) },
    search: { ...current.search, ...(patch.search ?? {}) }
  }
  const stmt = d.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  const tx = d.transaction(() => {
    for (const [k, v] of Object.entries(next)) stmt.run(k, JSON.stringify(v))
  })
  tx()

  // 目录被移出扫描列表后，它名下的待识别单元也就没意义了
  if (patch.scan_dirs) {
    const kept = new Set(next.scan_dirs)
    const stale = new Set(listScanUnits().map((u) => u.root).filter((r) => !kept.has(r)))
    for (const root of stale) removeScanUnitsUnder(root)
  }
  return next
}

export function exportAll(): { version: number; exported_at: number; software: SoftwareItem[]; categories: Category[] } {
  return {
    // 3：条目上多了 is_portable / move_risk / link_target
    version: 3,
    exported_at: Date.now(),
    software: listSoftware({ group: 'all' }).concat(listSoftware({ group: 'archived' })),
    categories: listCategories()
  }
}

/* ------------------------------ 用量统计 ------------------------------ */

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * 设置页「数据管理」上那几个数字。
 *
 * 库大小要把 -wal 算进去：journal_mode 是 WAL，刚写进去还没 checkpoint 的数据
 * 全在 wal 文件里，只报 baoyi.db 会明显偏小，看起来像是数据没存上。
 */
export function dataStats(): DataStats {
  const d = getDb()
  const one = (sql: string) => (d.prepare(sql).get() as { n: number }).n
  const dbFile = path.join(app.getPath('userData'), 'baoyi.db')

  let icons = 0
  let iconBytes = 0
  const dir = iconsDir()
  try {
    for (const name of fs.readdirSync(dir)) {
      icons++
      iconBytes += fileSize(path.join(dir, name))
    }
  } catch {
    /* 图标目录还没建起来，当作 0 */
  }

  return {
    software: one('SELECT COUNT(*) AS n FROM software'),
    units: one('SELECT COUNT(*) AS n FROM scan_units'),
    logs: one('SELECT COUNT(*) AS n FROM identify_logs'),
    dbBytes: fileSize(dbFile) + fileSize(`${dbFile}-wal`),
    icons,
    iconBytes
  }
}

/* ------------------------------- 重置 ------------------------------- */

export interface ResetSummary {
  software: number
  units: number
  icons: number
  settingsCleared: boolean
}

/** 清空图标缓存目录，返回删掉的文件数 */
function clearIcons(): number {
  const dir = iconsDir()
  let n = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.unlinkSync(path.join(dir, name))
        n++
      } catch {
        /* 图标可能正被渲染进程占用，删不掉就留着，下次识别会覆盖 */
      }
    }
  } catch {
    /* 目录不存在，当作没有图标 */
  }
  return n
}

/**
 * 重置识别数据。
 *
 * mode = 'library'：只清软件条目、待识别目录、整理记录和图标缓存，
 *   保留 API Key、搜索配置、扫描目录和自定义分类 —— 反复调 prompt 重测时用这个。
 * mode = 'all'：连设置和分类一起清掉，等于恢复出厂，会重新走引导流程。
 *
 * 两种模式都只动抱一自己的数据库，绝不碰你磁盘上的任何实际软件文件 ——
 * 已经整理过的文件夹留在整理后的位置，只是抱一不再记得它们原来在哪。
 */
export function resetData(mode: 'library' | 'all'): ResetSummary {
  const d = getDb()

  const software = (d.prepare('SELECT COUNT(*) AS n FROM software').get() as { n: number }).n
  const units = (d.prepare('SELECT COUNT(*) AS n FROM scan_units').get() as { n: number }).n

  const tx = d.transaction(() => {
    d.prepare('DELETE FROM software').run()
    d.prepare('DELETE FROM scan_units').run()
    d.prepare('DELETE FROM pending_software').run()
    d.prepare('DELETE FROM skip_list').run()
    // 没被认可过的 AI 标签跟着识别数据一起清；用户建的和确认过的是资产，留着
    d.prepare(`DELETE FROM tags WHERE source = 'ai'`).run()
    // 整理记录跟着软件条目一起清。0.3 时这里刻意留着它（「文件夹还在磁盘上，
    // 清掉记录等于让用户永远失去搬回去的办法」），但留下来的记录里 software_id
    // 全都指向已经不存在的条目 —— 撤销时找不到关联软件，整理页也只能显示一串空条目。
    // 一份读不懂的记录不比没有记录更有用，所以改成一起清。
    // 代价是清空后无法再自动撤销整理，这一点已经写进了重置对话框的提示里。
    d.prepare('DELETE FROM organize_plans').run()
    if (mode === 'all') {
      // 识别日志只在恢复出厂时清。反复调 prompt 时要的正是「改之前那次是怎么判断的」，
      // 清空识别数据后还能拿旧日志对照，这是它最主要的用途
      d.prepare('DELETE FROM identify_logs').run()
      d.prepare('DELETE FROM identification_reports').run()
      d.prepare('DELETE FROM settings').run()
      d.prepare('DELETE FROM categories').run()
      d.prepare('DELETE FROM tags').run()
    }
  })
  tx()

  // 恢复出厂把内置分类、内置标签和版本号一并装回去。少了最后一项，下次启动
  // 会以为还没迁移过，白跑一遍重建
  if (mode === 'all') seedDefaults(d)

  const icons = clearIcons()

  // 删完把 WAL 落盘并把文件收缩回去，不然 db 文件不会变小
  try {
    d.pragma('wal_checkpoint(TRUNCATE)')
    d.exec('VACUUM')
  } catch {
    /* 收缩失败不影响数据已被清空这个事实 */
  }

  return { software, units, icons, settingsCleared: mode === 'all' }
}

export function closeDb(): void {
  db?.close()
  db = null
}
