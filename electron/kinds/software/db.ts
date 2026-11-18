import { parseJsonArray } from '../../services/json.ts'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readExternalActiveAt } from '../../services/activity.ts'
import { insertCategories, insertTag } from '../../services/schema.ts'
import { FALLBACK_CATEGORY } from '../../services/taxonomy.ts'
import type { Category, ConfirmResult, Launcher, MoveRisk, PendingItem, RegisterPayload, ScannedFile, SidebarCounts, SoftwareItem, SoftwareQuery } from '../../../src/types/index.ts'
import { listCategories, tagPool, pruneOrphanAiTags } from '../../services/taxonomy-store.ts'
import type { SqlDb } from '../../services/schema.ts'
import { transaction } from '../../workspace/validation.ts'

type Row = Record<string, any>

/* ------------------------------ 行 <-> 对象 ------------------------------ */

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
    tags: parseJsonArray(row.tags).filter((value): value is string => typeof value === 'string'),
    official_url: row.official_url ?? '',
    ai_status: row.ai_status ?? 'pending',
    launchers: safeLaunchers(row.launchers, row.exe_path),
    why_choose: row.why_choose ?? '',
    use_cases: row.use_cases ?? '',
    notes: row.notes ?? '',
    alternatives: parseJsonArray(row.alternatives).filter((value): value is string => typeof value === 'string'),
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

export function listSoftware(d: SqlDb, query: SoftwareQuery = {}): SoftwareItem[] {

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

export function getSoftware(d: SqlDb, id: string): SoftwareItem | null {
  const row = d.prepare('SELECT * FROM software WHERE id = ?').get(id) as Row | undefined
  return row ? rowToItem(row) : null
}

export function getSoftwareByPath(d: SqlDb, exePath: string): SoftwareItem | null {
  const row = d.prepare('SELECT * FROM software WHERE exe_path = ?').get(exePath) as
    | Row
    | undefined
  return row ? rowToItem(row) : null
}

export function updateSoftware(d: SqlDb, id: string, patch: Partial<SoftwareItem>): SoftwareItem | null {

  const entries = Object.entries(patch).filter(([k]) => WRITABLE_COLUMNS.has(k))
  if (entries.length === 0) return getSoftware(d, id)

  transaction(d, () => {
    if (patch.category !== undefined) {
      d.prepare('UPDATE software_meta SET category_locked = 1 WHERE resource_id = ?').run(id)
    }
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

  return getSoftware(d, id)
}

export function deleteSoftware(d: SqlDb, id: string): void {
  // software_meta 靠 ON DELETE CASCADE 跟着走（foreign_keys 在 getDb 里已打开）
  d.prepare('DELETE FROM resource WHERE id = ?').run(id)
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
 * 更新其他 AI 字段时保留已有分类，用户备注 / 熟练度 / 使用统计同样保留。
 */
export function registerSoftware(
  d: SqlDb, payload: RegisterPayload,
  facts: RegisterFileFacts
): RegisterOutcome | null {
  const launchers = normalizeLaunchers(payload.launchers)
  if (launchers.length === 0) return null
  const primary = launchers.find((l) => l.is_default) ?? launchers[0]


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
    transaction(d, () => {
      d.prepare(
        `UPDATE resource SET
           name_zh = @name_zh, name_en = @name_en, summary = @summary, description = @description,
           category = CASE WHEN
             COALESCE((SELECT category_locked FROM software_meta WHERE resource_id = resource.id), 0) = 1
             OR (TRIM(COALESCE(category, '')) != '' AND (category != '其他' OR ai_status = 'done'))
             THEN category ELSE @category END,
           tags = @tags, official_url = @official_url,
           source_dir = @source_dir, file_name = @file_name, file_size = @file_size,
           external_active_at = @external_active_at,
           ai_status = 'done', updated_at = @updated_at
         WHERE id = @id`
      ).run({ ...aiFields, ...facts, id: existing.id, updated_at: now })
      d.prepare(
        `UPDATE software_meta SET
           launchers = @launchers, is_portable = @is_portable, move_risk = @move_risk,
           file_description = @file_description, company = @company, version = @version,
           category_locked = 1
         WHERE resource_id = @id`
      ).run({ ...aiFields, ...facts, id: existing.id })
    })

    return { id: existing.id, created: false, exe_path: primary.path }
  }

  const id = randomUUID()
  transaction(d, () => {
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
         (resource_id, file_description, company, version, launchers, is_portable, move_risk, category_locked)
       VALUES
         (@id, @file_description, @company, @version, @launchers, @is_portable, @move_risk, 1)`
    ).run({ ...aiFields, ...facts, id })
  })


  return { id, created: true, exe_path: primary.path }
}

/**
 * 重跑一个目录后，清掉「上一轮注册过、这一轮没再注册、用户也没碰过」的残留条目。
 * 只删零使用 + 无备注 + 未归档的，用户写过一个字就留着。
 * 必须在 agent 跑完之后调用，olderThan 传本轮开始的时间戳。
 *
 * 确定过分类的条目同样保留：目录识别选了不同启动端，也不能删除原分类记录。
 */
export function pruneStaleBySourceDir(d: SqlDb, dir: string, olderThan: number): number {
  // DELETE 打在 resource 上（software 是只读视图）；子查询读取分类保护标记，
  // 未分类占位的 meta 行靠 CASCADE 跟着清理。
  const info = d
    .prepare(
      `DELETE FROM resource
       WHERE kind = 'software' AND source_dir = ? AND updated_at < ?
         AND use_count = 0 AND last_used_at = 0 AND is_archived = 0
         AND why_choose = '' AND use_cases = '' AND notes = '' AND alternatives IN ('[]', '')
         AND mastery_level = 'new'
         AND (TRIM(COALESCE(category, '')) = '' OR category = '其他')
         AND COALESCE(ai_status, 'pending') != 'done'
         AND NOT EXISTS (SELECT 1 FROM software_meta m
           WHERE m.resource_id = resource.id AND m.category_locked = 1)`
    )
    .run(dir, olderThan)
  return Number(info.changes)
}

/** 某个目录下已注册的条目，用来告诉 agent 别重复注册 */
export function listBySourceDir(d: SqlDb, dir: string): SoftwareItem[] {
  const rows = d
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
    tags: parseJsonArray(row.tags).filter((value): value is string => typeof value === 'string'),
    official_url: row.official_url ?? '',
    launchers: safeLaunchers(row.launchers, row.exe_path),
    source_dir: row.source_dir ?? '',
    is_portable: safeTriBool(row.is_portable),
    move_risk: safeRisk(row.move_risk),
    new_category: row.new_category === 1,
    new_tags: parseJsonArray(row.new_tags).filter((value): value is string => typeof value === 'string')
  }
}

export function listPending(d: SqlDb): PendingItem[] {
  const rows = d
    .prepare('SELECT * FROM pending_software ORDER BY source_dir, created_at')
    .all() as Row[]
  return rows.map(rowToPending)
}

export function countPending(d: SqlDb): number {
  return (d.prepare('SELECT COUNT(*) AS n FROM pending_software').get() as { n: number }).n
}

export function isSkipped(d: SqlDb, exePath: string): boolean {
  return !!d.prepare('SELECT 1 FROM skip_list WHERE exe_path = ?').get(exePath)
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
  d: SqlDb, payload: RegisterPayload,
  facts: RegisterFileFacts,
  scanUnitId: string,
  iconPath: string
): StageOutcome | null {
  const launchers = normalizeLaunchers(payload.launchers)
  if (launchers.length === 0) return null
  const primary = launchers.find((l) => l.is_default) ?? launchers[0]
  if (isSkipped(d, primary.path)) return null


  const now = Date.now()
  const knownCategories = new Set(listCategories(d).map((c) => c.name))
  const pool = new Set(tagPool(d))
  const newTags = payload.tags.filter((t) => !pool.has(t))
  const protectedItem=d.prepare(`SELECT r.category FROM resource r LEFT JOIN software_meta m ON m.resource_id = r.id
    WHERE r.kind = 'software' AND r.path = ? AND
      (COALESCE(m.category_locked, 0) = 1 OR
       (TRIM(COALESCE(r.category, '')) != '' AND (r.category != '其他' OR r.ai_status = 'done')))`
  ).get(primary.path) as {category:string}|undefined
  const category=protectedItem?.category ?? (payload.category || FALLBACK_CATEGORY)

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
    category,
    tags: JSON.stringify(payload.tags),
    official_url: payload.official_url,
    launchers: JSON.stringify(launchers),
    source_dir: payload.source_dir,
    is_portable: payload.is_portable === null ? null : payload.is_portable ? 1 : 0,
    move_risk: payload.move_risk,
    new_category: knownCategories.has(category) ? 0 : 1,
    new_tags: JSON.stringify(newTags)
  }

  transaction(d, () => {
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


  return { id, created: !existing, exe_path: primary.path }
}

const PENDING_EDITABLE = new Set([
  'name_zh', 'name_en', 'summary', 'description', 'category', 'tags', 'official_url',
  'is_portable', 'move_risk'
])

/** 确认面板里改一个字段就存一次，不攒到最后 —— 中途关掉窗口不该丢改动 */
export function updatePending(d: SqlDb, id: string, patch: Partial<PendingItem>): PendingItem | null {

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
export function confirmPending(d: SqlDb, ids: string[]): ConfirmResult {

  if (ids.length === 0) return { registered: 0, categories: [], tags: [] }

  const placeholders = ids.map(() => '?').join(',')
  const rows = d
    .prepare(`SELECT * FROM pending_software WHERE id IN (${placeholders})`)
    .all(...ids) as Row[]
  if (rows.length === 0) return { registered: 0, categories: [], tags: [] }

  const startedAt = Date.now()
  const knownCategories = new Set(listCategories(d).map((c) => c.name))
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
      d, {
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

    if (item.icon_path) updateSoftware(d, outcome.id, { icon_path: item.icon_path })

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
function pruneStaleAfterConfirm(d: SqlDb, dirs: string[], olderThan: number): void {
  for (const dir of dirs) {
    if (!dir) continue
    const left = d.prepare('SELECT COUNT(*) AS n FROM pending_software WHERE source_dir = ?').get(dir) as { n: number }
    if (left.n > 0) continue
    pruneStaleBySourceDir(d, dir, olderThan)
  }
}

/** 忽略名单里现在有多少条。设置页要能看见它，否则误点的「不注册」就成了死结 */
export function countSkipped(d: SqlDb): number {
  return (d.prepare('SELECT COUNT(*) AS n FROM skip_list').get() as { n: number }).n
}

/** 清空忽略名单：这些程序下次识别会重新出现在确认面板里 */
export function clearSkipped(d: SqlDb): number {
  return Number(d.prepare('DELETE FROM skip_list').run().changes)
}

/** 用户说「不注册」：从暂存区移走并记进忽略名单，下次识别不再冒出来 */
export function skipPending(d: SqlDb, ids: string[]): number {

  if (ids.length === 0) return 0
  const now = Date.now()
  let n = 0

  transaction(d, () => {
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

  return n
}

/* -------------------------------- 插入 -------------------------------- */

/** 插入扫描结果，已存在的路径直接跳过。返回新插入的条目。 */
export function insertScanned(d: SqlDb, files: ScannedFile[]): SoftwareItem[] {

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
  transaction(d, () => {
    for (const f of files) {
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
      if (Number(info.changes) === 0) continue
      insMeta.run(params)
      inserted.push(id)
    }
  })


  if (inserted.length === 0) return []
  const placeholders = inserted.map(() => '?').join(',')
  const rows = d
    .prepare(`SELECT * FROM software WHERE id IN (${placeholders})`)
    .all(...inserted) as Row[]
  return rows.map(rowToItem)
}

export function listForAi(d: SqlDb, ids?: string[]): SoftwareItem[] {

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

export function recordLaunch(d: SqlDb, id: string): void {
  d
    .prepare('UPDATE resource SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
    .run(Date.now(), id)
}

export function counts(d: SqlDb, unusedDays: number): SidebarCounts {

  const one = (sql: string, ...args: any[]) =>
    (d.prepare(sql).get(...args) as { n: number }).n

  const cutoff = Date.now() - unusedDays * 86400_000
  const categories = d
    .prepare(
      `SELECT category AS name, COUNT(*) AS count FROM software
       WHERE is_archived = 0 GROUP BY category
       ORDER BY COALESCE((SELECT c.sort_order FROM categories c WHERE c.kind = 'software' AND c.name = software.category), 2147483647), name`
    )
    .all() as Array<{ name: string; count: number }>

  // 标签存在 JSON 数组里，直接在 JS 里聚合（数据量在千级以内，够用）
  const tagRows = d.prepare('SELECT tags FROM software WHERE is_archived = 0').all() as Row[]
  const tagMap = new Map<string, number>()
  for (const r of tagRows) {
    for (const t of parseJsonArray(r.tags).filter((value): value is string => typeof value === 'string')) tagMap.set(t, (tagMap.get(t) ?? 0) + 1)
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

export function exportSoftwareList(d: SqlDb): { version: number; exported_at: number; software: SoftwareItem[]; categories: Category[] } {
  return {
    // 3：条目上多了 is_portable / move_risk / link_target
    version: 3,
    exported_at: Date.now(),
    software: listSoftware(d, { group: 'all' }).concat(listSoftware(d, { group: 'archived' })),
    categories: listCategories(d)
  }
}
