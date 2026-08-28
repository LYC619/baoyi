/**
 * 软件品类的库结构：私有表、视图、索引，以及 0.4 -> 0.5 那次拆表。
 *
 * 这些以前长在 services/schema.ts 里 —— 公共层因此知道了「软件有绿色版」
 * 「软件能搬目录」这些概念，而那正是要拆掉的耦合。现在它们归软件模块自己管，
 * 公共层只负责在建库时按注册表把每个品类的这几段 SQL 执行一遍。
 */

import type { SqlDb } from '../../services/schema.ts'
import { backfillExternalActive, columnsOf, objectType } from '../../services/schema.ts'
import type { KindSchema } from '../types.ts'

/**
 * 软件的扫描与暂存：待识别目录、确认前的暂存区、不注册名单。
 *
 * 这三张表带着 exe_path / is_portable / launchers 这些列 —— 它们是软件的表，
 * 不是通用的。确认「这个交互模式」是公共的，但**这张表**不是：
 * 游戏模块会有自己形状不同的暂存表。
 */
export const SOFTWARE_SCAN_SQL = `
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


  -- 识别结果的暂存区：agent 认完先落在这里，用户确认后才进 resource。
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

`

/**
 * 软件私有字段。刻意用真列而不是一个 JSON attrs：is_portable 是三态的
 * （是 / 否 / 还没判断过），而 json_extract 分不出「键不存在」「值真是 null」
 * 「键名拼错」—— 三种都返回 NULL。这个字段决定整理时敢不敢搬一个目录，
 * 分不出来的代价是搬错。列不存在会当场报错，列是 NULL 就真是「没判断过」。
 */
export const SOFTWARE_META_SQL = `
  CREATE TABLE IF NOT EXISTS software_meta (
    resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
    file_description TEXT DEFAULT '',
    company TEXT DEFAULT '',
    version TEXT DEFAULT '',
    launchers TEXT DEFAULT '[]',

    -- 绿色软件？NULL = 还没判断过，和「判断为否」不是一回事
    is_portable INTEGER DEFAULT NULL,
    -- 挪位置的风险：safe / risky / unknown
    move_risk TEXT DEFAULT 'unknown',
    -- 整理成 junction 后链接的真实指向。空串 = 实体目录
    link_target TEXT DEFAULT ''
  );
`

/**
 * resource + software_meta 拼回 SoftwareItem 原来的那张宽表形状。
 *
 * 叫 software 是有意的：读路径（listSoftware / counts / tagUsage 等十来处）
 * 一个字都不用改，拆表的改动全压在写入侧。写视图会报「cannot modify a view」——
 * 是个响亮的错，不会静默写丢。
 *
 * 列名 path -> exe_path 的映射也在这里：总表那一列对视频、游戏同样要成立，
 * 所以库里叫 path；而 SoftwareItem 对外仍然是 exe_path，渲染进程、整理模块、
 * 启动器（合计 38 处引用）因此一行都不用动。
 *
 * LEFT JOIN 而不是 JOIN：万一哪条 resource 缺了配套的 software_meta（写入侧有
 * 事务保证，但手工改库改得出来），条目应该带着默认值露面，而不是从库里凭空消失。
 */
export const SOFTWARE_VIEW_SQL = `
  CREATE VIEW IF NOT EXISTS software AS
  SELECT
    r.id, r.created_at, r.updated_at,
    r.path AS exe_path, r.icon_path, r.file_name, r.file_size, r.source_dir,
    r.name_zh, r.name_en, r.summary, r.description, r.category, r.tags,
    r.official_url, r.ai_status,
    r.why_choose, r.use_cases, r.notes, r.alternatives, r.mastery_level,
    r.last_used_at, r.use_count, r.is_archived, r.external_active_at,
    COALESCE(m.file_description, '') AS file_description,
    COALESCE(m.company, '') AS company,
    COALESCE(m.version, '') AS version,
    COALESCE(m.launchers, '[]') AS launchers,
    m.is_portable AS is_portable,
    COALESCE(m.move_risk, 'unknown') AS move_risk,
    COALESCE(m.link_target, '') AS link_target
  FROM resource r
  LEFT JOIN software_meta m ON m.resource_id = r.id
  WHERE r.kind = 'software'
`

export const SOFTWARE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_scan_units_status ON scan_units(status);
  CREATE INDEX IF NOT EXISTS idx_pending_dir ON pending_software(source_dir);
  CREATE INDEX IF NOT EXISTS idx_meta_portable ON software_meta(is_portable);
`

/**
 * 0.4 -> 0.5：把 software 那张宽表拆成 resource（通用）+ software_meta（软件私有）。
 *
 * 老表改名留下，不删。真库另有备份文件，但把快照留在库里，回滚脚本就不必依赖
 * 用户当初有没有备份 —— 代价是一张不再更新的冗余表。
 * ponytail: 等 0.6 确认迁移无恙之后再删掉 software_legacy_v4。
 */
export function splitIntoResource(d: SqlDb): void {
  if (objectType(d, 'software') !== 'table') return

  d.exec('BEGIN')
  try {
    d.exec(`
      INSERT INTO resource
        (id, kind, created_at, updated_at, path, icon_path, file_name, file_size, source_dir,
         name_zh, name_en, summary, description, category, tags, official_url, ai_status,
         why_choose, use_cases, notes, alternatives, mastery_level,
         last_used_at, use_count, is_archived, external_active_at)
      SELECT
        id, 'software', created_at, updated_at, exe_path, icon_path, file_name, file_size, source_dir,
        name_zh, name_en, summary, description, category, tags, official_url, ai_status,
        why_choose, use_cases, notes, alternatives, mastery_level,
        last_used_at, use_count, is_archived, external_active_at
      FROM software;

      INSERT INTO software_meta
        (resource_id, file_description, company, version, launchers,
         is_portable, move_risk, link_target)
      SELECT
        id, file_description, company, version, launchers,
        is_portable, move_risk, link_target
      FROM software;
    `)

    // 搬完立刻核对条数。少一条都不许把老表改名 —— 事务整个回滚，
    // 用户下次启动看到的还是 0.4 的库，而不是一个缺了东西的 0.5 库。
    const before = (d.prepare('SELECT COUNT(*) AS n FROM software').get() as { n: number }).n
    const after = (d.prepare('SELECT COUNT(*) AS n FROM resource').get() as { n: number }).n
    const meta = (d.prepare('SELECT COUNT(*) AS n FROM software_meta').get() as { n: number }).n
    if (before !== after || before !== meta) {
      throw new Error(`0.5 迁移条数对不上：software=${before} resource=${after} meta=${meta}`)
    }

    d.exec('ALTER TABLE software RENAME TO software_legacy_v4')
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}

/**
 * 软件模块自己的迁移。公共层保证调用它时 resource 表已经就绪。
 *
 * 顺序要紧：老库里 software 还是一张宽表，0.1 -> 0.3 的补列必须先在它身上做完，
 * 否则 splitIntoResource 会去 SELECT 一个不存在的列。
 */
export function migrateSoftware(d: SqlDb, _from: number): void {
  if (objectType(d, 'software') === 'table') {
    const existing = columnsOf(d, 'software')
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
    // 趁 software 还是表的时候做，拆完之后它就只剩一份只读快照了。
    if (!existing.has('external_active_at')) backfillExternalActive(d, 'software')
  }

  const pendingCols = columnsOf(d, 'pending_software')
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

  splitIntoResource(d)
}

export const softwareSchema: KindSchema = {
  tables: SOFTWARE_META_SQL + SOFTWARE_SCAN_SQL,
  view: SOFTWARE_VIEW_SQL,
  indexes: SOFTWARE_INDEXES_SQL,
  migrate: migrateSoftware
}
