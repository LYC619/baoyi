/**
 * 游戏条目的落库出口。
 *
 * 刻意收 `SqlDb` 而不是自己去调 `getDb()`：`services/database.ts` 依赖
 * electron 和 better-sqlite3（后者按 Electron ABI 编译，纯 node 载不进来），
 * 一旦在这里 import 它，整条识别链路就只能在应用跑起来之后才能验证。
 * 收一个 db 句柄，自检和 scripts/try-game-identify.ts 就能拿 node:sqlite
 * 驱动同一份 SQL 走完整个流程 —— 和 services/schema.ts 是同一个理由。
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  GameCounts,
  GameItem,
  GameQuery,
  LinkedFile,
  PlayStatus,
  SavePath
} from '../../../src/types'
import type { SqlDb } from '../../services/schema.ts'

export interface GamePayload {
  /** 主程序绝对路径，同时是 resource.path 这个全局唯一键 */
  exe_path: string
  name_zh: string
  name_en: string
  summary: string
  description: string
  category: string
  tags: string[]
  official_url: string
  /** 这个游戏所在的目录 */
  source_dir: string
  file_size: number
  save_paths: SavePath[]
  linked_files: LinkedFile[]
}

export interface GameWriteOutcome {
  id: string
  created: boolean
}

/**
 * 以主程序路径作唯一键：同一个游戏反复识别是更新，不是再开一条。
 *
 * 更新时只覆盖 AI 认出来的那些字段。游玩时长、上次游玩、游玩状态、封面
 * 一律不动 —— 它们是用户玩出来的账，重新识别一次不该把它清零。
 * save_paths 同理：用户手工改过的路径比模型这一次的猜测可信，只在
 * 原先为空时才写入。
 */
export function insertGame(d: SqlDb, p: GamePayload): GameWriteOutcome {
  const now = Date.now()
  const common = [
    p.name_zh,
    p.name_en,
    p.summary,
    p.description,
    p.category,
    JSON.stringify(p.tags),
    p.official_url,
    p.source_dir,
    path.basename(p.exe_path),
    p.file_size
  ]

  const existing = d.prepare('SELECT id FROM resource WHERE path = ?').get(p.exe_path) as
    | { id: string }
    | undefined

  if (existing) {
    d.prepare(
      `UPDATE resource SET
         name_zh = ?, name_en = ?, summary = ?, description = ?, category = ?, tags = ?,
         official_url = ?, source_dir = ?, file_name = ?, file_size = ?,
         ai_status = 'done', updated_at = ?
       WHERE id = ?`
    ).run(...common, now, existing.id)

    // meta 行可能不存在（手工改库、或早于 game_meta 建表的条目），补一行再写
    d.prepare(`INSERT OR IGNORE INTO game_meta (resource_id) VALUES (?)`).run(existing.id)
    d.prepare(
      `UPDATE game_meta SET
         save_paths = CASE WHEN save_paths IN ('[]', '') THEN ? ELSE save_paths END,
         linked_files = CASE WHEN linked_files IN ('[]', '') THEN ? ELSE linked_files END
       WHERE resource_id = ?`
    ).run(JSON.stringify(p.save_paths), JSON.stringify(p.linked_files), existing.id)

    return { id: existing.id, created: false }
  }

  const id = randomUUID()
  d.prepare(
    `INSERT INTO resource
       (id, kind, created_at, updated_at, path, icon_path,
        name_zh, name_en, summary, description, category, tags,
        official_url, source_dir, file_name, file_size, ai_status)
     VALUES (?, 'game', ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done')`
  ).run(id, now, now, p.exe_path, ...common)
  d.prepare(
    `INSERT INTO game_meta (resource_id, save_paths, linked_files) VALUES (?, ?, ?)`
  ).run(id, JSON.stringify(p.save_paths), JSON.stringify(p.linked_files))

  return { id, created: true }
}

/** 某个目录下已注册的游戏，用来告诉 agent 别重复注册 */
export function gamesUnder(d: SqlDb, dir: string): Array<{ name: string; path: string }> {
  const rows = d
    .prepare(
      `SELECT name_zh, name_en, file_name, path FROM resource
       WHERE kind = 'game' AND source_dir = ? ORDER BY created_at`
    )
    .all(dir) as Array<Record<string, string>>
  return rows.map((r) => ({ name: r.name_zh || r.name_en || r.file_name, path: r.path }))
}

/** 更新游玩状态。Step 6 的时长统计会走同一张表，这里先只开状态这一个口子 */
export function setPlayStatus(d: SqlDb, id: string, status: PlayStatus): void {
  d.prepare('UPDATE game_meta SET play_status = ? WHERE resource_id = ?').run(status, id)
}

/* ================================ 读 ================================ */

type Row = Record<string, any>

export const PLAY_STATUSES: PlayStatus[] = ['unplayed', 'playing', 'completed', 'shelved']

/**
 * 库里的 JSON 列坏掉时退回空数组，而不是让整个列表页炸掉。
 *
 * 这不是防御性编程的洁癖：save_paths / linked_files / tags 都是模型写进去的，
 * 而 0.5 之前手工改过库的用户也真实存在。一行坏数据不该让整个游戏库打不开。
 */
function jsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

function rowToGame(row: Row): GameItem {
  return {
    id: String(row.id),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
    path: String(row.path ?? ''),
    file_name: String(row.file_name ?? ''),
    file_size: Number(row.file_size) || 0,
    source_dir: String(row.source_dir ?? ''),
    name_zh: String(row.name_zh ?? ''),
    name_en: String(row.name_en ?? ''),
    summary: String(row.summary ?? ''),
    description: String(row.description ?? ''),
    category: String(row.category ?? ''),
    tags: jsonArray<string>(row.tags),
    official_url: String(row.official_url ?? ''),
    notes: String(row.notes ?? ''),
    is_archived: Number(row.is_archived) === 1,
    cover_path: String(row.cover_path ?? ''),
    background_path: String(row.background_path ?? ''),
    // 库里有 CHECK 兜着，读到别的值只能是手工改库改坏了，退回默认而不是把它透出去
    play_status: PLAY_STATUSES.includes(row.play_status) ? row.play_status : 'unplayed',
    total_playtime_sec: Number(row.total_playtime_sec) || 0,
    last_played_at: Number(row.last_played_at) || 0,
    save_paths: jsonArray<SavePath>(row.save_paths),
    linked_files: jsonArray<LinkedFile>(row.linked_files)
  }
}

/**
 * 默认排序按「上次游玩」而不是「加入时间」：游戏库是拿来玩的，最近碰过的
 * 应该在手边。从没玩过的（last_played_at = 0）自然沉到底，再按加入时间排，
 * 于是刚扫进来的一批仍然挨在一起，不会散成一片。
 */
const GAME_ORDER: Record<NonNullable<GameQuery['sort']>, string> = {
  played: 'last_played_at DESC, created_at DESC',
  name: `COALESCE(NULLIF(name_zh, ''), NULLIF(name_en, ''), file_name) ASC`,
  playtime: 'total_playtime_sec DESC, last_played_at DESC',
  added: 'created_at DESC'
}

export function listGames(d: SqlDb, query: GameQuery = {}): GameItem[] {
  const where: string[] = [query.group === 'archived' ? 'is_archived = 1' : 'is_archived = 0']
  const params: unknown[] = []

  if (query.category) {
    where.push('category = ?')
    params.push(query.category)
  }
  if (query.status) {
    where.push('play_status = ?')
    params.push(query.status)
  }
  if (query.tag) {
    // tags 是 JSON 数组字符串，带引号匹配，免得「独立」命中「独立游戏」
    where.push('tags LIKE ?')
    params.push(`%"${query.tag}"%`)
  }
  const keyword = query.keyword?.trim()
  if (keyword) {
    where.push('(name_zh LIKE ? OR name_en LIKE ? OR summary LIKE ? OR tags LIKE ? OR file_name LIKE ?)')
    for (let i = 0; i < 5; i++) params.push(`%${keyword}%`)
  }

  const order = GAME_ORDER[query.sort ?? 'played'] ?? GAME_ORDER.played
  const rows = d
    .prepare(`SELECT * FROM game WHERE ${where.join(' AND ')} ORDER BY ${order}`)
    .all(...params) as Row[]
  return rows.map(rowToGame)
}

export function getGame(d: SqlDb, id: string): GameItem | null {
  const row = d.prepare('SELECT * FROM game WHERE id = ?').get(id) as Row | undefined
  return row ? rowToGame(row) : null
}

export function gameCounts(d: SqlDb): GameCounts {
  const one = (sql: string, ...args: unknown[]) =>
    Number((d.prepare(sql).get(...args) as { n: number }).n) || 0

  const status = Object.fromEntries(PLAY_STATUSES.map((s) => [s, 0])) as Record<PlayStatus, number>
  const statusRows = d
    .prepare(
      `SELECT play_status AS s, COUNT(*) AS n FROM game WHERE is_archived = 0 GROUP BY play_status`
    )
    .all() as Array<{ s: string; n: number }>
  for (const r of statusRows) {
    if (PLAY_STATUSES.includes(r.s as PlayStatus)) status[r.s as PlayStatus] = Number(r.n) || 0
  }

  const categories = (
    d
      .prepare(
        `SELECT category AS name, COUNT(*) AS count FROM game
         WHERE is_archived = 0 GROUP BY category ORDER BY count DESC`
      )
      .all() as Array<{ name: string; count: number }>
  ).map((r) => ({ name: String(r.name ?? ''), count: Number(r.count) || 0 }))

  // 标签在 JSON 数组里，直接在 JS 里聚合。游戏数量比软件还少，够用
  const tagMap = new Map<string, number>()
  for (const r of d.prepare('SELECT tags FROM game WHERE is_archived = 0').all() as Row[]) {
    for (const t of jsonArray<string>(r.tags)) tagMap.set(t, (tagMap.get(t) ?? 0) + 1)
  }

  return {
    all: one('SELECT COUNT(*) AS n FROM game WHERE is_archived = 0'),
    archived: one('SELECT COUNT(*) AS n FROM game WHERE is_archived = 1'),
    status,
    categories,
    tags: [...tagMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }
}

/* ================================ 写 ================================ */

/**
 * 允许从界面改的列，按它们真正落在哪张表分开。
 *
 * 白名单而不是「把 patch 里的键拼进 SQL」：patch 是从渲染进程过来的，
 * 键名直接进 SQL 语句就是一条注入口子。也顺手挡住了「把 id 改掉」这种事。
 */
const GAME_RESOURCE_COLUMNS = new Set([
  'name_zh', 'name_en', 'summary', 'description', 'category', 'tags',
  'official_url', 'notes', 'is_archived'
])
const GAME_META_COLUMNS = new Set([
  'cover_path', 'background_path', 'play_status', 'total_playtime_sec',
  'last_played_at', 'save_paths', 'linked_files'
])

function toColumn(key: string, value: unknown): string | number {
  if (key === 'is_archived') return value ? 1 : 0
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'number') return value
  return String(value ?? '')
}

export function updateGame(d: SqlDb, id: string, patch: Partial<GameItem>): GameItem | null {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined)

  for (const [table, cols, key] of [
    ['resource', GAME_RESOURCE_COLUMNS, 'id'],
    ['game_meta', GAME_META_COLUMNS, 'resource_id']
  ] as Array<[string, Set<string>, string]>) {
    const mine = entries.filter(([k]) => cols.has(k))
    if (mine.length === 0) continue
    // meta 行可能不存在（早于 game_meta 建表的条目），补一行再写，免得 UPDATE 落空
    if (table === 'game_meta') {
      d.prepare('INSERT OR IGNORE INTO game_meta (resource_id) VALUES (?)').run(id)
    }
    const sets = mine.map(([k]) => `${k} = ?`).join(', ')
    d.prepare(`UPDATE ${table} SET ${sets} WHERE ${key} = ?`).run(
      ...mine.map(([k, v]) => toColumn(k, v)),
      id
    )
  }

  // updated_at 只在总表上，改哪张表都要动它
  d.prepare('UPDATE resource SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  return getGame(d, id)
}

/**
 * 从库里移除一个游戏。game_meta 靠 ON DELETE CASCADE 跟着走。
 *
 * save_backups 刻意不删 —— 那张表指向磁盘上真实存在的存档拷贝（见 schema.ts）。
 * 从抱一里移除一个游戏，不等于用户愿意扔掉它的存档备份。
 */
export function deleteGame(d: SqlDb, id: string): void {
  d.prepare('DELETE FROM resource WHERE id = ?').run(id)
}
