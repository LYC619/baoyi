import Database from 'better-sqlite3'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readExternalActiveAt } from './activity'
import { rebase } from '../kinds/software/organize/plan'
import { KINDS } from '../kinds'
import { initSchema, insertCategories, insertTag, schemaVersion, seedDefaults, SCHEMA_VERSION } from './schema'
import { FALLBACK_CATEGORY } from './taxonomy'
import { VIDEO_JOBS_SQL } from '../kinds/video/download/jobs.ts'
import { migratePosterStorage, resolvePosterDirectory } from './poster-storage.ts'
import { isPortable } from './portable'
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
  ,TaskRecord
} from '../../src/types'

type Row = Record<string, any>

let db: Database.Database | null = null
let posterDirectory = ''


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
  // 默认关，因为它要用户自己去 TMDB 注册一个 key。域名留空表示用官方地址，
  // 具体的默认域名写在 kinds/video/tmdb.ts 里 —— 那是它自己的事
  tmdb: {
    api_key: '',
    api_domain: '',
    image_domain: '',
    enabled: false
  },
  software_scan_dirs: [],
  game_scan_dirs: [],
  video_scan_dirs: [],
  video_download_root: '',
  video_download_quality: '',
  video_download_strict_quality: false,
  video_download_register: true,
  organize_root: '',
  save_backup_root: '',
  save_backup_keep: 10,
  // 空串 = 直连。只有走 Chromium 网络栈的请求受它管，见 AppSettings.proxy 的注释
  proxy: '',
  // Hanime 内置 Hosts 默认开：国内系统 DNS 对这几个域名常被污染，不开就基本连不上
  hanime_builtin_hosts: true,
  hanime_hosts_active_ip: '',
  // 默认不藏。默认藏的话，装完看不见自己刮进来的东西，会当成刮削坏了
  hide_hentai: false,
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

/**
 * 游戏封面目录。和 icons 分开而不是共用一个目录：
 *
 * 图标是抱一自己从 exe 里抽出来的**缓存**，清掉不丢东西，下次识别会重新抽 ——
 * `clearIcons()` 就是照这个前提写的，重置时整个目录一扫而空。封面是用户亲手指的
 * 一张图，性质是**资产**。混在一起的话，「清空图标缓存」会顺手把他挑的封面全删了。
 */
export function coversDir(): string {
  const dir = path.join(app.getPath('userData'), 'covers')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 影视海报目录。第三个图片目录，不是随手多开的一个 —— 它在上面那条
 * 「缓存 vs 资产」的线上落在**中间**，所以两边都不该收它。
 *
 * 海报绝大多数是刮削下来的，丢了重刮一次就有，这一点像 icons；但用户也能自己
 * 挑一张，那一张跟游戏封面一样是资产。塞进 covers/ 的话，将来做「清理刮削缓存」
 * 就没有一个能安全下手的目录；塞进 icons/ 的话，`clearIcons()` 会把用户手动
 * 挑的海报一起删掉。单独一个目录，两种清理都有明确边界。
 */
export function postersDir(): string {
  const dir = path.join(app.getPath('userData'), 'posters')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 0.8 开发期有一版把海报缓存放到了项目/程序目录下的 `data/posters`，仓库一挪缓存就断。
 * 现在缓存回到 userData；这里算出那个旧位置，启动时把里面的图搬回来。
 * 绿色版和显式 --user-data-dir 从来没用过那个位置，算出来就是 userData 本身，迁移会直接跳过。
 */
function legacyProjectPostersDir(): string {
  posterDirectory ||= resolvePosterDirectory({
    appPath: app.getAppPath(), exePath: process.execPath, userDataPath: app.getPath('userData'),
    explicitUserData: app.commandLine.hasSwitch('user-data-dir'), portable: isPortable()
  })
  return posterDirectory
}

/**
 * 存档备份根目录，并保证它存在。
 *
 * 设置为空时退回用户数据目录下的 save-backups —— 和 icons 同一个套路：
 * 「不设置也能用」比「先去设置里指一个」少一道门槛，而想换位置的人随时能换。
 * 目录建不出来（盘拔了、没权限）时原样返回路径，让备份那一层去报真实的错误 ——
 * 在这里抛会让设置页整个打不开。
 */
export function saveBackupRoot(): string {
  const configured = getSettings().save_backup_root.trim()
  const dir = configured || path.join(app.getPath('userData'), 'save-backups')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 交给上层报错 */
  }
  return dir
}

/**
 * 迁移前留一份原样的副本。
 *
 * 迁移是全项目唯一会改写用户几个月真实数据的一段。自检和 verify-migration 都跑过了，
 * 但它们跑的是合成数据和副本 —— 真库上出的那一次意外，代价是数据没了。
 *
 * 命名沿用 0.1 / 0.3 / 0.4 那几份手工备份的形状：baoyi.db.v{旧版本}.bak。
 * 同一个旧版本只备一次：升级失败、用户重开应用再试一次时，第二次备份的会是
 * 一个已经被改坏的库，正好把唯一那份好的盖掉。
 *
 * 备份失败不拦启动，但要在主进程日志里喊一声 —— 一次静默失败的备份
 * 和没有备份是一回事，而用户会以为自己有。
 */
function backupBeforeMigrate(file: string): void {
  let from = 0
  try {
    const probe = new Database(file, { readonly: true, fileMustExist: true })
    try {
      from = schemaVersion(probe)
    } finally {
      probe.close()
    }
  } catch {
    // 库还不存在（首次启动），或者连版本号都读不出来。前者没什么可备份的，
    // 后者交给 initSchema 去报错，这里不越权
    return
  }
  if (from <= 0 || from >= SCHEMA_VERSION) return

  const target = `${file}.v0.${from}.0.bak`
  if (fs.existsSync(target)) return
  try {
    // WAL 里可能还压着没落盘的事务，直接 copyFile 会拿到一个缺尾巴的库。
    // better-sqlite3 的 backup 走的是 SQLite 自己的备份 API，拿到的是完整快照
    const src = new Database(file, { readonly: true, fileMustExist: true })
    try {
      src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    } finally {
      src.close()
    }
    console.log(`[抱一] 迁移前备份：${target}`)
  } catch (err) {
    console.error(`[抱一] 迁移前备份失败（${from} -> ${SCHEMA_VERSION}）：`, err)
  }
}

export function getDb(): Database.Database {
  if (db) return db
  const file = path.join(app.getPath('userData'), 'baoyi.db')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  backupBeforeMigrate(file)
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // 品类模块从注册表来：公共层不认识 software_meta，也不认识「开发工具」
  // 这些分类名，它只负责把每个品类交上来的那几段 SQL 按顺序执行一遍
  initSchema(db, KINDS)
  db.exec(VIDEO_JOBS_SQL)
  try {
    const migration = migratePosterStorage(db, legacyProjectPostersDir(), postersDir())
    if (migration.removed || migration.updated) console.log(`[抱一] 影视图片已搬回 ${postersDir()}（${migration.removed} 张，${migration.updated} 处引用）`)
    for (const warning of migration.warnings) console.warn('[抱一] ' + warning)
  } catch (cause) { console.error('[抱一] 影视图片迁移未完成；尚未迁移的原文件与恢复记录已保留：', cause) }
  return db
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

/**
 * 只有 SoftwareItem 里存在的列才允许写入，避免把任意字段透传进 SQL。
 * 拆表之后还多一层作用：这个映射同时决定每一列该落到哪张表。
 * exe_path 在总表里叫 path —— 对视频、游戏同样要成立的列名不该带 exe。
 */
const RESOURCE_COLUMNS = new Map<string, string>([
  ['exe_path', 'path'],
  ['icon_path', 'icon_path'],
  ['file_name', 'file_name'],
  ['file_size', 'file_size'],
  ['source_dir', 'source_dir'],
  ['name_zh', 'name_zh'],
  ['name_en', 'name_en'],
  ['summary', 'summary'],
  ['description', 'description'],
  ['category', 'category'],
  ['tags', 'tags'],
  ['official_url', 'official_url'],
  ['ai_status', 'ai_status'],
  ['why_choose', 'why_choose'],
  ['use_cases', 'use_cases'],
  ['notes', 'notes'],
  ['alternatives', 'alternatives'],
  ['mastery_level', 'mastery_level'],
  ['last_used_at', 'last_used_at'],
  ['use_count', 'use_count'],
  ['is_archived', 'is_archived'],
  ['external_active_at', 'external_active_at']
])

const META_COLUMNS = new Map<string, string>([
  ['file_description', 'file_description'],
  ['company', 'company'],
  ['version', 'version'],
  ['launchers', 'launchers'],
  ['is_portable', 'is_portable'],
  ['move_risk', 'move_risk'],
  ['link_target', 'link_target']
])

const WRITABLE_COLUMNS = new Set([...RESOURCE_COLUMNS.keys(), ...META_COLUMNS.keys()])

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

  const tx = d.transaction(() => {
    for (const [table, cols, key] of [
      ['resource', RESOURCE_COLUMNS, 'id'],
      ['software_meta', META_COLUMNS, 'resource_id']
    ] as Array<[string, Map<string, string>, string]>) {
      const mine = entries.filter(([k]) => cols.has(k))
      if (mine.length === 0) continue
      const sets = mine.map(([k]) => `${cols.get(k)} = @${k}`).join(', ')
      const params: Row = { id }
      for (const [k, v] of mine) params[k] = toColumnValue(k, v)
      d.prepare(`UPDATE ${table} SET ${sets} WHERE ${key} = @id`).run(params)
    }
    // updated_at 只在总表上，改哪张表都要动它
    d.prepare('UPDATE resource SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  })
  tx()
  return getSoftware(id)
}

export function deleteSoftware(id: string): void {
  // software_meta 靠 ON DELETE CASCADE 跟着走（foreign_keys 在 getDb 里已打开）
  getDb().prepare('DELETE FROM resource WHERE id = ?').run(id)
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
    const tx = d.transaction(() => {
      d.prepare(
        `UPDATE resource SET
           name_zh = @name_zh, name_en = @name_en, summary = @summary, description = @description,
           category = @category, tags = @tags, official_url = @official_url,
           source_dir = @source_dir, file_name = @file_name, file_size = @file_size,
           external_active_at = @external_active_at,
           ai_status = 'done', updated_at = @updated_at
         WHERE id = @id`
      ).run({ ...aiFields, ...facts, id: existing.id, updated_at: now })
      d.prepare(
        `UPDATE software_meta SET
           launchers = @launchers, is_portable = @is_portable, move_risk = @move_risk,
           file_description = @file_description, company = @company, version = @version
         WHERE resource_id = @id`
      ).run({ ...aiFields, ...facts, id: existing.id })
    })
    tx()
    return { id: existing.id, created: false, exe_path: primary.path }
  }

  const id = randomUUID()
  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO resource
         (id, kind, created_at, updated_at, path, icon_path, file_name, file_size, source_dir,
          name_zh, name_en, summary, description, category, tags, official_url, ai_status,
          external_active_at)
       VALUES
         (@id, 'software', @created_at, @updated_at, @exe_path, '', @file_name, @file_size, @source_dir,
          @name_zh, @name_en, @summary, @description, @category, @tags, @official_url, 'done',
          @external_active_at)`
    ).run({ ...aiFields, ...facts, id, created_at: now, updated_at: now, exe_path: primary.path })
    d.prepare(
      `INSERT INTO software_meta
         (resource_id, file_description, company, version, launchers, is_portable, move_risk)
       VALUES
         (@id, @file_description, @company, @version, @launchers, @is_portable, @move_risk)`
    ).run({ ...aiFields, ...facts, id })
  })
  tx()

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
  // 条件里有 software_meta 才有的列吗？没有 —— 全在总表上。但 DELETE 仍然要打在
  // resource 上（software 是视图），meta 行靠 CASCADE 跟着走。
  const info = getDb()
    .prepare(
      `DELETE FROM resource
       WHERE kind = 'software' AND source_dir = ? AND updated_at < ?
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
    for (const t of newTags) insertTag(d, t, 'ai', 'software')
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
      const next = (d.prepare('SELECT MAX(sort_order) AS n FROM categories WHERE kind = ?').get('software') as { n: number | null }).n ?? 0
      insertCategories(
        d,
        [{ id: randomUUID(), name: item.category, description: 'AI 识别时提议，已确认', icon: 'box', sort_order: next + 1 }],
        'software'
      )
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
      const tag = d.prepare('SELECT id, source FROM tags WHERE kind = ? AND name = ?').get('software', name) as Row | undefined
      if (!tag) {
        insertTag(d, name, 'user', 'software')
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
         (id, dir, label, kind, resource_kind, status, summary, registered, rounds,
          duration_ms, tokens, stop_reason, events, created_at)
       VALUES
         (@id, @dir, @label, @kind, @resource_kind, @status, @summary, @registered, @rounds,
          @duration_ms, @tokens, @stop_reason, @events, @created_at)`
    ).run({
      id,
      dir: log.dir,
      label: log.label,
      kind: log.kind,
      resource_kind: log.resource_kind,
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
    resource_kind: row.resource_kind ?? 'software',
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
  if (query.resource_kind) {
    where.push('resource_kind = ?')
    params.push(query.resource_kind)
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

export function clearIdentifyLogs(resourceKind?: string): number {
  const d = getDb()
  // 报告只是这些日志的汇总视图，日志清了它就没有依据了 —— 一起清掉
  if (resourceKind) {
    const n = d.prepare('DELETE FROM identify_logs WHERE resource_kind = ?').run(resourceKind).changes
    d.prepare('DELETE FROM identification_reports WHERE resource_kind = ?').run(resourceKind)
    return n
  } else {
    const n = d.prepare('DELETE FROM identify_logs').run().changes
    d.prepare('DELETE FROM identification_reports').run()
    return n
  }
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
         (id, created_at, resource_kind, processed, registered, skipped, failed,
          duration_ms, tokens, searches, entries)
       VALUES
         (@id, @created_at, @resource_kind, @processed, @registered, @skipped, @failed,
          @duration_ms, @tokens, @searches, @entries)`
    ).run({
      id,
      created_at: Date.now(),
      resource_kind: report.resource_kind,
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

export function listIdentifyReports(resourceKind?: string): IdentifyReport[] {
  const d = getDb()
  const rows = resourceKind
    ? (d.prepare('SELECT * FROM identification_reports WHERE resource_kind = ? ORDER BY created_at DESC').all(resourceKind) as Row[])
    : (d.prepare('SELECT * FROM identification_reports ORDER BY created_at DESC').all() as Row[])
  return rows.map((row) => {
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
      resource_kind: row.resource_kind ?? 'software',
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
      `UPDATE resource SET path = @exe_path, source_dir = @source_dir, updated_at = @updated_at
       WHERE id = @id`
    ).run({
      id,
      exe_path: nextExe,
      source_dir: rebase(item.source_dir, fromDir, toDir),
      updated_at: Date.now()
    })
    // launchers 和 link_target 是软件私有的，在 meta 表上
    d.prepare(
      `UPDATE software_meta SET launchers = @launchers, link_target = @link_target
       WHERE resource_id = @id`
    ).run({ id, launchers: JSON.stringify(launchers), link_target: linkTarget })

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

/** 插入扫描结果，已存在的路径直接跳过。返回新插入的条目。 */
export function insertScanned(files: ScannedFile[]): SoftwareItem[] {
  const d = getDb()
  const now = Date.now()
  // OR IGNORE 靠的是 resource.path 上的 UNIQUE：同一个 exe 反复扫只会占一行
  const insResource = d.prepare(`
    INSERT OR IGNORE INTO resource
      (id, kind, created_at, updated_at, path, icon_path, file_name, file_size,
       name_zh, ai_status, source_dir, external_active_at)
    VALUES
      (@id, 'software', @created_at, @updated_at, @exe_path, '', @file_name, @file_size,
       @name_zh, 'pending', @source_dir, @external_active_at)
  `)
  const insMeta = d.prepare(`
    INSERT OR IGNORE INTO software_meta
      (resource_id, file_description, company, version, launchers)
    VALUES
      (@id, @file_description, @company, @version, @launchers)
  `)

  const inserted: string[] = []
  const tx = d.transaction((rows: ScannedFile[]) => {
    for (const f of rows) {
      const id = randomUUID()
      const params = {
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
      }
      const info = insResource.run(params)
      // 总表那行被 IGNORE 掉了就别再插 meta，否则会给别人的 resource_id 挂一行
      if (info.changes === 0) continue
      insMeta.run(params)
      inserted.push(id)
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
    .prepare('UPDATE resource SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
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

/**
 * 分类 / 标签一律按 kind 收口。
 *
 * 0.6 之前 categories 和 tags 是全局单表，加游戏模块时才发现这条缝：
 * listCategories() 和 tagPool() 直接喂给软件的识别 prompt（见 aiService.ts），
 * 游戏的「RPG」「魂系」一旦进表，agent 就会拿它们去归类一个调试器。
 *
 * 默认值定成 'software' 是有意的：软件模块那几十处调用和整条 IPC / 渲染进程
 * 链路因此一个字都不用改，加 kind 的改动全压在游戏这一侧。
 */
const DEFAULT_KIND = 'software'

export function listCategories(kind: string = DEFAULT_KIND): Category[] {
  return getDb()
    .prepare(
      `SELECT id, name, description, icon, sort_order FROM categories
       WHERE kind = ? ORDER BY sort_order, name`
    )
    .all(kind) as Category[]
}

/** 一条分类属于哪个品类。改名 / 删除时要按它把影响范围圈住 */
function categoryKind(d: Database.Database, id: string): string {
  const row = d.prepare('SELECT kind FROM categories WHERE id = ?').get(id) as Row | undefined
  return (row?.kind as string) ?? DEFAULT_KIND
}

export function upsertCategory(c: Category, kind: string = DEFAULT_KIND): Category[] {
  const d = getDb()
  const id = c.id || randomUUID()
  const previous = d.prepare('SELECT name, kind FROM categories WHERE id = ?').get(id) as
    | Row
    | undefined
  const target = (previous?.kind as string) ?? kind

  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO categories (id, kind, name, description, icon, sort_order)
       VALUES (@id, @kind, @name, @description, @icon, @sort_order)
       ON CONFLICT(id) DO UPDATE SET
         name = @name, description = @description, icon = @icon, sort_order = @sort_order`
    ).run({ ...c, id, kind: target, description: c.description ?? '', icon: c.icon ?? '' })

    // 分类是靠名字挂在条目上的，改名必须把引用一起改，否则一改名条目全掉进「其他」。
    // 限定 kind：软件和游戏可以各有一个叫「其他」的格子，改一边不该动到另一边
    if (previous && previous.name !== c.name) {
      d.prepare('UPDATE resource SET category = ? WHERE kind = ? AND category = ?').run(
        c.name,
        target,
        previous.name
      )
      if (target === DEFAULT_KIND) {
        d.prepare('UPDATE pending_software SET category = ? WHERE category = ?').run(c.name, previous.name)
      }
    }
  })
  tx()
  return listCategories(target)
}

export function removeCategory(id: string): Category[] {
  const d = getDb()
  const row = d.prepare('SELECT name, kind FROM categories WHERE id = ?').get(id) as Row | undefined
  const kind = (row?.kind as string) ?? DEFAULT_KIND
  if (row) {
    // 分类是虚拟的，删除时把归属条目退回「其他」，不动实际文件。
    // 同样限定 kind —— 两个品类各有一个「其他」，别把对方的条目也扫进来
    const tx = d.transaction(() => {
      d.prepare('UPDATE resource SET category = ? WHERE kind = ? AND category = ?').run(
        FALLBACK_CATEGORY,
        kind,
        row.name
      )
      if (kind === DEFAULT_KIND) {
        d.prepare('UPDATE pending_software SET category = ? WHERE category = ?').run(FALLBACK_CATEGORY, row.name)
      }
      d.prepare('DELETE FROM categories WHERE id = ?').run(id)
    })
    tx()
  }
  return listCategories(kind)
}

/**
 * 上下挪一格。和相邻那条交换 sort_order 即可 —— 拖拽排序留给以后，
 * 这个按钮能到达完全一样的顺序，还能用键盘操作。
 */
export function moveCategory(id: string, delta: number): Category[] {
  const kind = categoryKind(getDb(), id)
  const list = listCategories(kind)
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
  return listCategories(kind)
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
function tagUsage(d: Database.Database, kind: string): Map<string, number> {
  const map = new Map<string, number>()
  const rows = d
    .prepare('SELECT tags FROM resource WHERE kind = ? AND is_archived = 0')
    .all(kind) as Row[]
  for (const r of rows) {
    for (const t of safeJsonArray(r.tags)) map.set(t, (map.get(t) ?? 0) + 1)
  }
  return map
}

export function listTags(kind: string = DEFAULT_KIND): Tag[] {
  const d = getDb()
  const usage = tagUsage(d, kind)
  const rows = d.prepare('SELECT * FROM tags WHERE kind = ? ORDER BY name').all(kind) as Row[]
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
export function tagPool(kind: string = DEFAULT_KIND): string[] {
  return (
    getDb()
      .prepare(
        `SELECT name FROM tags WHERE kind = ? AND source IN ('user','confirmed') ORDER BY name`
      )
      .all(kind) as Row[]
  ).map((r) => r.name as string)
}

/** 一条标签属于哪个品类。改名 / 合并 / 删除都要按它把影响范围圈住 */
function tagKind(d: Database.Database, id: number): string {
  const row = d.prepare('SELECT kind FROM tags WHERE id = ?').get(id) as Row | undefined
  return (row?.kind as string) ?? DEFAULT_KIND
}

export function createTag(name: string, kind: string = DEFAULT_KIND): Tag[] {
  const clean = name.trim().slice(0, 12)
  if (clean) insertTag(getDb(), clean, 'user', kind)
  return listTags(kind)
}

export function renameTag(id: number, name: string): Tag[] {
  const d = getDb()
  const kind = tagKind(d, id)
  const clean = name.trim().slice(0, 12)
  const row = d.prepare('SELECT name FROM tags WHERE id = ?').get(id) as Row | undefined
  if (!clean || !row || row.name === clean) return listTags(kind)

  // 改成一个已存在的名字，等同于合并。只在同品类里找同名 ——
  // 游戏的「开源」和软件的「开源」是两个词，跨品类合并会把两边的条目搅在一起
  const collide = d.prepare('SELECT id FROM tags WHERE kind = ? AND name = ?').get(kind, clean) as
    | Row
    | undefined
  if (collide) return mergeTags([id], collide.id as number)

  const tx = d.transaction(() => {
    d.prepare('UPDATE tags SET name = ? WHERE id = ?').run(clean, id)
    replaceTagInEntries(d, [row.name as string], clean, kind)
  })
  tx()
  return listTags(kind)
}

/** 把 fromIds 这些标签并进 intoId，条目上的引用一并替换并去重 */
export function mergeTags(fromIds: number[], intoId: number): Tag[] {
  const d = getDb()
  const kind = tagKind(d, intoId)
  const target = d.prepare('SELECT name FROM tags WHERE id = ?').get(intoId) as Row | undefined
  if (!target) return listTags(kind)

  const sources = fromIds
    .filter((id) => id !== intoId)
    .map((id) => d.prepare('SELECT id, name, kind FROM tags WHERE id = ?').get(id) as Row | undefined)
    .filter((r): r is Row => !!r)
    // 跨品类合并没有意义，静默跳过比把游戏标签并进软件池好
    .filter((r) => (r.kind as string) === kind)
  if (sources.length === 0) return listTags(kind)

  const tx = d.transaction(() => {
    replaceTagInEntries(d, sources.map((s) => s.name as string), target.name as string, kind)
    const del = d.prepare('DELETE FROM tags WHERE id = ?')
    for (const s of sources) del.run(s.id)
    // 并过之后目标标签就是用户的意思了，顺手转正
    d.prepare(`UPDATE tags SET source = 'confirmed' WHERE id = ? AND source = 'ai'`).run(intoId)
  })
  tx()
  return listTags(kind)
}

export function removeTag(id: number): Tag[] {
  const d = getDb()
  const kind = tagKind(d, id)
  const row = d.prepare('SELECT name FROM tags WHERE id = ?').get(id) as Row | undefined
  if (!row) return listTags(kind)
  const tx = d.transaction(() => {
    replaceTagInEntries(d, [row.name as string], '', kind)
    d.prepare('DELETE FROM tags WHERE id = ?').run(id)
  })
  tx()
  return listTags(kind)
}

/**
 * 把条目（含暂存）标签数组里的 from 换成 to，to 为空串表示删除。
 * 标签存的是 JSON 数组，只能读出来改完写回去 —— SQL 里没法原地改。
 *
 * 限定 kind：两个品类可以各有一个同名标签，删掉游戏的「单机」
 * 不该把软件条目上的「单机」一起抹掉。
 */
function replaceTagInEntries(
  d: Database.Database,
  from: string[],
  to: string,
  kind: string
): void {
  const drop = new Set(from)
  const rows = d.prepare('SELECT id, tags FROM resource WHERE kind = ?').all(kind) as Row[]
  const stmt = d.prepare('UPDATE resource SET tags = ? WHERE id = ?')
  const rewrite = (list: Row[], update: Database.Statement): void => {
    for (const r of list) {
      const tags = safeJsonArray(r.tags)
      if (!tags.some((t) => drop.has(t))) continue
      const next = tags.map((t) => (drop.has(t) ? to : t)).filter(Boolean)
      update.run(JSON.stringify([...new Set(next)]), r.id)
    }
  }
  rewrite(rows, stmt)

  // 暂存区是软件模块自己的表，只有软件标签能落在里面
  if (kind === DEFAULT_KIND) {
    rewrite(
      d.prepare('SELECT id, tags FROM pending_software').all() as Row[],
      d.prepare('UPDATE pending_software SET tags = ? WHERE id = ?')
    )
  }
}

/**
 * 清掉没有任何条目（含暂存区）在用的 AI 待确认标签，别让否决过的词一直留在管理页。
 * 只清软件那一侧 —— 这是确认面板走完之后调的，游戏的 AI 标签不在它的视野里，
 * 不限定 kind 的话会把游戏刚识别出来、还没确认的标签一起删掉。
 */
function pruneOrphanAiTags(d: Database.Database): void {
  const used = new Set<string>()
  for (const table of ['software', 'pending_software']) {
    for (const r of d.prepare(`SELECT tags FROM ${table}`).all() as Row[]) {
      for (const t of safeJsonArray(r.tags)) used.add(t)
    }
  }
  const stale = (
    d.prepare(`SELECT id, name FROM tags WHERE source = 'ai' AND kind = ?`).all(DEFAULT_KIND) as Row[]
  ).filter((t) => !used.has(t.name as string))
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
    search: { ...DEFAULT_SETTINGS.search, ...(stored.search ?? {}) },
    // 逐个嵌套对象都要单独铺一层默认值：老库里存的 tmdb 只有三个键时，
    // 展开 stored 会让新加的那个键变成 undefined 而不是取默认
    tmdb: { ...DEFAULT_SETTINGS.tmdb, ...(stored.tmdb ?? {}) }
  }
}

export function patchSettings(patch: Partial<AppSettings>): AppSettings {
  const d = getDb()
  const current = getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    ai: { ...current.ai, ...(patch.ai ?? {}) },
    search: { ...current.search, ...(patch.search ?? {}) },
    tmdb: { ...current.tmdb, ...(patch.tmdb ?? {}) }
  }
  const stmt = d.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  const tx = d.transaction(() => {
    for (const [k, v] of Object.entries(next)) {
      // 跳过已废弃的键：迁移已经把 scan_dirs 改名成 software_scan_dirs，
      // 不能每次保存设置都把旧键再写回去
      if (k === 'scan_dirs') continue
      stmt.run(k, JSON.stringify(v))
    }
  })
  tx()

  // 目录被移出扫描列表后，它名下的待识别单元也就没意义了（仅软件模块有 scan_units）
  if (patch.software_scan_dirs) {
    const kept = new Set(next.software_scan_dirs)
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

export function listTaskRecords(): TaskRecord[] {
  const rows = getDb().prepare('SELECT * FROM task_records ORDER BY started_at DESC LIMIT 30').all() as Row[]
  return rows.map(row => ({
    id: String(row.id), kind: row.kind, title: String(row.title), status: row.status,
    startedAt: Number(row.started_at), finishedAt: Number(row.finished_at) || undefined,
    processed: Number(row.processed) || 0, total: Number(row.total) || 0, percent: Number(row.percent) || 0,
    current: String(row.current || ''), message: String(row.message || ''), error: String(row.error || '') || undefined,
    events: (() => { try { const value = JSON.parse(String(row.events || '[]')); return Array.isArray(value) ? value : [] } catch { return [] } })()
  })) as TaskRecord[]
}

export function saveTaskRecord(task: TaskRecord): void {
  getDb().prepare(`INSERT INTO task_records (id, kind, title, status, started_at, finished_at, processed, total, percent, current, message, error, events)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at, processed = excluded.processed,
      total = excluded.total, percent = excluded.percent, current = excluded.current, message = excluded.message,
      error = excluded.error, events = excluded.events`).run(task.id, task.kind, task.title, task.status, task.startedAt, task.finishedAt || 0, task.processed, task.total, task.percent, task.current, task.message, task.error || '', JSON.stringify(task.events))
}

export function interruptRunningTasks(): void {
  getDb().prepare(`UPDATE task_records SET status = 'interrupted', finished_at = ?, message = '应用关闭前未完成，可重新执行' WHERE status = 'running'`).run(Date.now())
}

export function clearTaskRecords(ids?: string[]): number {
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !id || id.length > 256))) throw new Error('任务范围无效')
  if (ids?.length === 0) return 0
  const selected = ids ? [...new Set(ids)] : undefined
  return getDb().prepare(`DELETE FROM task_records WHERE status != 'running'${selected ? ' AND id IN (' + selected.map(() => '?').join(',') + ')' : ''}`).run(...(selected || [])).changes
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
 *
 * 封面单独一栏，和图标并列。它们在**存留策略**上是两回事（图标是缓存，随时可重建；
 * 封面是用户亲手指的资产），但在「占了多少磁盘」这个问题上是同一回事 ——
 * 0.6 只统计图标，于是封面攒了多少空间在界面上完全看不到。
 */
function dirUsage(dir: string): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      count++
      bytes += fileSize(path.join(dir, name))
    }
  } catch {
    /* 目录还没建起来，当作空 —— 第一次运行时图标和封面目录都还不存在 */
  }
  return { count, bytes }
}

export function dataStats(): DataStats {
  const d = getDb()
  const one = (sql: string) => (d.prepare(sql).get() as { n: number }).n
  const dbFile = path.join(app.getPath('userData'), 'baoyi.db')

  const icons = dirUsage(iconsDir())
  const covers = dirUsage(coversDir())
  const posters = dirUsage(postersDir())

  return {
    software: one('SELECT COUNT(*) AS n FROM software'),
    games: one('SELECT COUNT(*) AS n FROM game'),
    videos: one('SELECT COUNT(*) AS n FROM video'),
    episodes: one('SELECT COUNT(*) AS n FROM episode'),
    units: one('SELECT COUNT(*) AS n FROM scan_units'),
    logs: one('SELECT COUNT(*) AS n FROM identify_logs'),
    dbBytes: fileSize(dbFile) + fileSize(`${dbFile}-wal`),
    icons: icons.count,
    iconBytes: icons.bytes,
    covers: covers.count,
    coverBytes: covers.bytes,
    posters: posters.count,
    posterBytes: posters.bytes
  }
}

/* ------------------------------- 重置 ------------------------------- */

export interface ResetSummary {
  software: number
  games: number
  videos: number
  /** 跟着影视条目一起清掉的集数。见 resetData 里数它的那一行 */
  episodes: number
  units: number
  icons: number
  covers: number
  posters: number
  /** 保留下来的存档备份记录数。磁盘上那些备份文件一个都没动，见下面的注释 */
  saveBackupsKept: number
  settingsCleared: boolean
}

/** 清空一个目录里的文件，返回删掉的个数。删不掉的跳过，不让一个占用中的文件挡住整次重置 */
function wipeDir(dir: string, whenBusy: string): number {
  let n = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.unlinkSync(path.join(dir, name))
        n++
      } catch {
        void whenBusy /* 正被渲染进程占用，删不掉就留着 */
      }
    }
  } catch {
    /* 目录不存在，当作里面没东西 */
  }
  return n
}

/** 清空图标缓存目录，返回删掉的文件数 */
function clearIcons(): number {
  return wipeDir(iconsDir(), '下次识别会覆盖')
}

/**
 * 清空封面目录，返回删掉的文件数。
 *
 * **这不等于把封面当缓存看。** `clearIcons()` 可以随时调用，因为图标能重新提取；
 * 封面不能，它是用户亲手指的一张图。这个函数只在 `resetData()` 里调用，
 * 而且只因为同一次操作正在把每一条游戏记录一起删掉 ——
 * 封面文件名是 `<游戏 id>.<后缀>`，而 id 是重置时生成的 uuid，重扫一遍不会再生成同一个。
 * 也就是说这些文件在记录消失的那一刻就已经没有任何代码路径能读到它们了，
 * 留着不是「保住了用户的资产」，是在磁盘上攒一堆永远打不开的图。
 *
 * 反过来说，`clearIcons()` 至今没有、以后也不该碰 `coversDir()` ——
 * 「清空图标缓存」是个能单独发生的动作，那时候游戏记录还在，封面还读得到。
 */
function clearCovers(): number {
  return wipeDir(coversDir(), '下次换封面会覆盖')
}

/**
 * 清空海报目录，返回删掉的文件数。理由和 `clearCovers()` 一字不差：
 * 文件名是 `<条目 id>.<后缀>`，条目记录一删，这些图就再没有任何代码路径读得到。
 */
function clearPosters(): number {
  return wipeDir(postersDir(), '下次刮削会覆盖')
}

/**
 * 重置识别数据。
 *
 * mode = 'library'：清掉全部品类的条目、待识别目录、整理记录、图标缓存和封面，
 *   保留 API Key、搜索配置、扫描目录和自定义分类 —— 反复调 prompt 重测时用这个。
 * mode = 'all'：连设置和分类一起清掉，等于恢复出厂，会重新走引导流程。
 *
 * 两种模式都只动抱一自己的数据库，绝不碰你磁盘上的任何实际软件文件 ——
 * 已经整理过的文件夹留在整理后的位置，只是抱一不再记得它们原来在哪。
 *
 * **0.6 到 0.7 之间改掉的一件事**：原先这里限定 `kind = 'software'`，注释写的理由是
 * 「以后有了游戏、视频，『清空软件库』不该顺手把它们也清了」。那个理由针对的是一个
 * 并不存在的按钮 —— 这两个入口在全局设置页里，写的是「清空识别数据」和「恢复出厂」，
 * 没有一个是「清空软件库」。结果是用户点了「恢复出厂」、对话框说了会清空、
 * 走完引导之后游戏库里那些条目一条不少地站在原地。
 * 一个和界面说法不符的行为比少一个功能糟得多，所以改成清全部品类。
 * 真要做「只清当前模块」，那是给 resetData 加一个 kind 参数、并且按钮上得写清楚，
 * 不是靠这里悄悄限定一个品类。
 */
export function resetData(mode: 'library' | 'all'): ResetSummary {
  const d = getDb()

  const count = (sql: string) => (d.prepare(sql).get() as { n: number }).n
  const software = count('SELECT COUNT(*) AS n FROM software')
  const games = count('SELECT COUNT(*) AS n FROM game')
  // 影视条目和它下面的集数分开数：一部剧清掉的是一行，但用户感觉上没的是几十集。
  // 只报「1 个影视条目」会让人以为季集表还在
  const videos = count('SELECT COUNT(*) AS n FROM video')
  const episodes = count('SELECT COUNT(*) AS n FROM episode')
  const units = count('SELECT COUNT(*) AS n FROM scan_units')
  // 先数下来，因为下面刻意不删它 —— 报给用户的是「留了多少」，不是「清了多少」
  const saveBackupsKept = count('SELECT COUNT(*) AS n FROM save_backups')

  const tx = d.transaction(() => {
    // 打在 resource 上，各品类的私有表（software_meta / game_meta）靠 CASCADE 跟着走。
    // 不带 WHERE：所有品类一起清，理由见上面那段注释。
    //
    // save_backups 刻意**不在**这里 —— 它没有外键，所以这句 DELETE 碰不到它，
    // 而这正是当初不给它建外键的目的：那张表不是日志而是索引，每行的 backup_dir
    // 指向磁盘上一份真实存在的存档拷贝。删掉记录不会删掉那些文件，
    // 只会让用户再也找不到它们。「用户重置了抱一」不等于「用户愿意扔掉存档备份」。
    // 代价是留下一批孤儿行，等「孤儿备份清理」那一屏再回收；
    // 在那之前至少要让用户知道它们还在，所以 saveBackupsKept 进了 ResetSummary。
    d.prepare('DELETE FROM resource').run()
    d.prepare('DELETE FROM scan_units').run()
    d.prepare('DELETE FROM pending_software').run()
    d.prepare('DELETE FROM skip_list').run()
    // 没被认可过的 AI 标签跟着识别数据一起清；用户建的和确认过的是资产，留着。
    // 不再限定 kind：条目全清了，哪个品类的 AI 标签都一样没了主人
    d.prepare(`DELETE FROM tags WHERE source = 'ai'`).run()
    // 整理记录跟着软件条目一起清。0.3 时这里刻意留着它（「文件夹还在磁盘上，
    // 清掉记录等于让用户永远失去搬回去的办法」），但留下来的记录里 software_id
    // 全都指向已经不存在的条目 —— 撤销时找不到关联软件，整理页也只能显示一串空条目。
    // 一份读不懂的记录不比没有记录更有用，所以改成一起清。
    // 代价是清空后无法再自动撤销整理，这一点已经写进了重置对话框的提示里。
    d.prepare('DELETE FROM organize_plans').run()
    d.prepare('DELETE FROM video_organize_journal').run()
    d.prepare('DELETE FROM video_download_jobs').run()
    d.prepare('DELETE FROM task_records').run()
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
  // 会以为还没迁移过，白跑一遍重建。分类同样来自品类注册表，不是写死的
  if (mode === 'all') seedDefaults(d, KINDS)

  const icons = clearIcons()
  const covers = clearCovers()
  const posters = clearPosters()

  // 删完把 WAL 落盘并把文件收缩回去，不然 db 文件不会变小
  try {
    d.pragma('wal_checkpoint(TRUNCATE)')
    d.exec('VACUUM')
  } catch {
    /* 收缩失败不影响数据已被清空这个事实 */
  }

  return {
    software,
    games,
    videos,
    episodes,
    units,
    icons,
    covers,
    posters,
    saveBackupsKept,
    settingsCleared: mode === 'all'
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}
