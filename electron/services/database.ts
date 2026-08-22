import Database from 'better-sqlite3'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readExternalActiveAt } from './activity'
import type {
  AgentEvent,
  AppSettings,
  Category,
  DataStats,
  IdentifyLog,
  IdentifyLogQuery,
  IdentifyLogStatus,
  Launcher,
  RegisterPayload,
  ScannedFile,
  ScanUnit,
  ScanUnitStatus,
  SidebarCounts,
  SoftwareItem,
  SoftwareQuery
} from '../../src/types'

type Row = Record<string, any>

let db: Database.Database | null = null

export const DEFAULT_CATEGORIES: Array<Omit<Category, 'id'> & { id: string }> = [
  { id: 'dev', name: '开发工具', icon: 'code-2', sort_order: 1 },
  { id: 'image', name: '图片处理', icon: 'image', sort_order: 2 },
  { id: 'network', name: '网络工具', icon: 'globe', sort_order: 3 },
  { id: 'system', name: '系统工具', icon: 'settings-2', sort_order: 4 },
  { id: 'file', name: '文件管理', icon: 'folder', sort_order: 5 },
  { id: 'media', name: '音视频', icon: 'clapperboard', sort_order: 6 },
  { id: 'efficiency', name: '效率工具', icon: 'zap', sort_order: 7 },
  { id: 'security', name: '安全工具', icon: 'shield', sort_order: 8 },
  { id: 'other', name: '其他', icon: 'box', sort_order: 9 }
]

export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    api_url: 'https://api.deepseek.com/v1',
    api_key: '',
    model: 'deepseek-chat',
    enabled: true
  },
  search: {
    provider: 'model_builtin',
    api_key: '',
    endpoint: '',
    enabled: false
  },
  scan_dirs: [],
  theme: 'dark',
  view_mode: 'grid',
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
      category TEXT DEFAULT '未分类',
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
      external_active_at INTEGER DEFAULT 0
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
      icon TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
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

    CREATE INDEX IF NOT EXISTS idx_software_category ON software(category);
    CREATE INDEX IF NOT EXISTS idx_software_mastery ON software(mastery_level);
    CREATE INDEX IF NOT EXISTS idx_software_archived ON software(is_archived);
    CREATE INDEX IF NOT EXISTS idx_software_last_used ON software(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_software_ai_status ON software(ai_status);
    CREATE INDEX IF NOT EXISTS idx_scan_units_status ON scan_units(status);
    CREATE INDEX IF NOT EXISTS idx_identify_logs_status ON identify_logs(status);
    CREATE INDEX IF NOT EXISTS idx_identify_logs_created ON identify_logs(created_at DESC);
  `)

  migrate(d)
  seedCategories(d)
}

function seedCategories(d: Database.Database): void {
  const seeded = d.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }
  if (seeded.n > 0) return
  const stmt = d.prepare(
    'INSERT INTO categories (id, name, icon, sort_order) VALUES (@id, @name, @icon, @sort_order)'
  )
  const tx = d.transaction((rows: Category[]) => rows.forEach((r) => stmt.run(r)))
  tx(DEFAULT_CATEGORIES)
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
    ['external_active_at', 'INTEGER DEFAULT 0']
  ]
  for (const [name, decl] of added) {
    if (!existing.has(name)) d.exec(`ALTER TABLE software ADD COLUMN ${name} ${decl}`)
  }

  // 刚补出来的 external_active_at 全是 0，等于让存量条目继续显示「从未使用」——
  // 而那正是这个字段要治的毛病。补列的同一次启动就把它填上，只跑这一次。
  if (!existing.has('external_active_at')) backfillExternalActive(d)
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
    category: row.category ?? '未分类',
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
    external_active_at: row.external_active_at ?? 0
  }
}

/** 只有 SoftwareItem 里存在的列才允许写入，避免把任意字段透传进 SQL */
const WRITABLE_COLUMNS = new Set([
  'exe_path', 'icon_path', 'file_name', 'file_description', 'company', 'version', 'file_size',
  'source_dir', 'name_zh', 'name_en', 'summary', 'description', 'category', 'tags',
  'official_url', 'ai_status', 'launchers',
  'why_choose', 'use_cases', 'notes', 'alternatives', 'mastery_level',
  'last_used_at', 'use_count', 'is_archived', 'external_active_at'
])

const JSON_COLUMNS = new Set(['tags', 'alternatives', 'launchers'])

function toColumnValue(key: string, value: unknown): string | number {
  if (JSON_COLUMNS.has(key)) {
    return JSON.stringify(Array.isArray(value) ? value : [])
  }
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
    source_dir: payload.source_dir
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
        category, tags, official_url, ai_status, launchers, external_active_at)
     VALUES
       (@id, @created_at, @updated_at, @exe_path, '', @file_name, @file_description,
        @company, @version, @file_size, @source_dir, @name_zh, @name_en, @summary, @description,
        @category, @tags, @official_url, 'done', @launchers, @external_active_at)`
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
  return getDb().prepare('DELETE FROM identify_logs').run().changes
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
  getDb()
    .prepare(
      `INSERT INTO categories (id, name, icon, sort_order) VALUES (@id, @name, @icon, @sort_order)
       ON CONFLICT(id) DO UPDATE SET name = @name, icon = @icon, sort_order = @sort_order`
    )
    .run({ ...c, id: c.id || randomUUID() })
  return listCategories()
}

export function removeCategory(id: string): Category[] {
  const d = getDb()
  const row = d.prepare('SELECT name FROM categories WHERE id = ?').get(id) as Row | undefined
  if (row) {
    // 分类是虚拟的，删除时把归属条目退回「未分类」，不动实际文件
    d.prepare(`UPDATE software SET category = '未分类' WHERE category = ?`).run(row.name)
    d.prepare('DELETE FROM categories WHERE id = ?').run(id)
  }
  return listCategories()
}

/* ------------------------------- 设置 ------------------------------- */

export function getSettings(): AppSettings {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as Array<{
    key: string
    value: string
  }>
  const stored: Row = {}
  for (const r of rows) {
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
    version: 2,
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
 * mode = 'library'：只清软件条目、待识别目录和图标缓存，
 *   保留 API Key、搜索配置、扫描目录和自定义分类 —— 反复调 prompt 重测时用这个。
 * mode = 'all'：连设置和分类一起清掉，等于恢复出厂，会重新走引导流程。
 *
 * 两种模式都只动抱一自己的数据库，绝不碰你磁盘上的任何实际软件文件。
 */
export function resetData(mode: 'library' | 'all'): ResetSummary {
  const d = getDb()

  const software = (d.prepare('SELECT COUNT(*) AS n FROM software').get() as { n: number }).n
  const units = (d.prepare('SELECT COUNT(*) AS n FROM scan_units').get() as { n: number }).n

  const tx = d.transaction(() => {
    d.prepare('DELETE FROM software').run()
    d.prepare('DELETE FROM scan_units').run()
    if (mode === 'all') {
      // 识别日志只在恢复出厂时清。反复调 prompt 时要的正是「改之前那次是怎么判断的」，
      // 清空识别数据后还能拿旧日志对照，这是它最主要的用途
      d.prepare('DELETE FROM identify_logs').run()
      d.prepare('DELETE FROM settings').run()
      d.prepare('DELETE FROM categories').run()
    }
  })
  tx()

  if (mode === 'all') seedCategories(d)

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
