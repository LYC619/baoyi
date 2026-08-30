/**
 * 视频条目的落库出口。
 *
 * 和 game/db.ts 同一个约定：收 `SqlDb` 而不是自己去调 `getDb()`。
 * `services/database.ts` 依赖 electron 和 better-sqlite3（后者按 Electron ABI
 * 编译，纯 node 载不进来），一旦在这里 import 它，整条链路就只能在应用跑起来
 * 之后才能验证。收一个 db 句柄，自检就能拿 node:sqlite 驱动同一份 SQL
 * 走完整个流程 —— 和 services/schema.ts 是同一个理由。
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  Episode,
  LinkedFile,
  MediaTrack,
  VideoCounts,
  VideoItem,
  VideoPart,
  VideoQuery,
  VideoType,
  WatchStatus
} from '../../../src/types'
import type { SqlDb } from '../../services/schema.ts'

/** 一集的入库形状。id 由这一层生成，调用方不用管 */
export interface EpisodePayload {
  season: number
  episode: number
  title?: string
  /** 空串 = 库里知道有这一集但磁盘上没文件，见 schema.ts */
  path?: string
  file_size?: number
  duration_sec?: number
  air_date?: number
}

export interface VideoPayload {
  /** 电影：默认文件路径。剧集：整部剧的目录。同时是 resource.path 这个全局唯一键 */
  path: string
  video_type: VideoType
  name_zh: string
  name_en: string
  summary: string
  description: string
  category: string
  tags: string[]
  official_url: string
  source_dir: string
  file_size: number

  year: number
  end_year: number
  rating: number
  duration_sec: number
  resolution: string
  video_codec: string
  source: string
  release_group: string
  audio_tracks: MediaTrack[]
  subtitle_tracks: MediaTrack[]
  parts: VideoPart[]
  linked_files: LinkedFile[]
  tmdb_id: string
  imdb_id: string
  douban_id: string
  /** 豆瓣评分。0 = 没拿到，和 rating 分开存，见 schema.ts */
  douban_rating: number
  /**
   * TMDB 上的海报相对路径（`/abc.jpg`），**不是本地文件路径**。
   *
   * 刮削时顺手存下来。下载图片是 Step 6 的活（要缓存目录、要主机白名单，
   * 见 game/covers.ts 那一套），但**相对路径是刮削时白拿的** ——
   * 不存的话 Step 6 得为每个条目重新取一次 TMDB 详情，才能拿回这一步
   * 手里已经有的东西。落在 poster_path 上，Step 6 下载完覆盖成本地路径。
   */
  poster_path: string
  /**
   * 同上，横版背景图的 TMDB 相对路径。
   *
   * 和海报一起存而不是只存海报：两个都在同一份详情响应里，只存一个的话
   * Step 6 为了另一个还得把详情重取一遍 —— 那就等于没省。
   */
  fanart_path: string

  /** 剧集的集列表。电影传空数组 */
  episodes: EpisodePayload[]
}

export interface VideoWriteOutcome {
  id: string
  created: boolean
  /** 这次新建了几集。更新已存在的集不计入 */
  episodesAdded: number
}

export const WATCH_STATUSES: WatchStatus[] = ['unwatched', 'watching', 'watched', 'dropped']
export const VIDEO_TYPES: VideoType[] = ['movie', 'series']

/**
 * 以 path 作唯一键：同一部片反复识别是更新，不是再开一条。
 *
 * 更新时只覆盖识别/刮削认出来的字段。**观看状态和播放位置一律不动** ——
 * 它们是用户看出来的账，重新刮削一次不该把它清零。这条规则在 0.6 的
 * insertGame 上已经立过，视频这边更要紧：一部 60 集的剧重扫一遍把
 * watch_status 打回 unwatched，用户就得重新标 60 次。
 *
 * 海报和背景图**只在空的时候写**（`CASE WHEN poster_path = ''`）：刮削这一步
 * 落进去的是 TMDB 的相对路径，Step 6 下载完会把同一列改成本地路径，
 * 而用户也可能自己挑过一张。重扫时无条件覆盖就会把这两种都打回相对路径 ——
 * 界面拿它当本地文件去读，结果是一面空白的海报墙。`linked_files` 同理。
 *
 * 集列表走 UPSERT（唯一键是 resource_id + season + episode）：
 * 补进新发现的集、更新已有集的文件路径和时长，但不动那一集的
 * watch_status / position_sec / watched_at。用户新下了后半季，
 * 前半季看到哪儿了得保住。
 */
export function insertVideo(d: SqlDb, p: VideoPayload): VideoWriteOutcome {
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
    path.basename(p.path),
    p.file_size
  ]

  const metaCols = [
    p.video_type,
    p.year,
    p.end_year,
    p.rating,
    p.duration_sec,
    p.resolution,
    p.video_codec,
    p.source,
    p.release_group,
    JSON.stringify(p.audio_tracks),
    JSON.stringify(p.subtitle_tracks),
    JSON.stringify(p.parts),
    p.tmdb_id,
    p.imdb_id,
    p.douban_id,
    p.douban_rating
  ]

  const existing = d.prepare('SELECT id FROM resource WHERE path = ?').get(p.path) as
    | { id: string }
    | undefined

  let id: string
  let created: boolean

  if (existing) {
    id = existing.id
    created = false
    d.prepare(
      `UPDATE resource SET
         name_zh = ?, name_en = ?, summary = ?, description = ?, category = ?, tags = ?,
         official_url = ?, source_dir = ?, file_name = ?, file_size = ?,
         ai_status = 'done', updated_at = ?
       WHERE id = ?`
    ).run(...common, now, id)

    // meta 行可能不存在（手工改库、或早于 video_meta 建表的条目），补一行再写
    d.prepare('INSERT OR IGNORE INTO video_meta (resource_id) VALUES (?)').run(id)
    d.prepare(
      `UPDATE video_meta SET
         video_type = ?, year = ?, end_year = ?, rating = ?, duration_sec = ?,
         resolution = ?, video_codec = ?, source = ?, release_group = ?,
         audio_tracks = ?, subtitle_tracks = ?, parts = ?, tmdb_id = ?, imdb_id = ?,
         douban_id = ?, douban_rating = ?,
         linked_files = CASE WHEN linked_files IN ('[]', '') THEN ? ELSE linked_files END,
         poster_path = CASE WHEN poster_path = '' THEN ? ELSE poster_path END,
         fanart_path = CASE WHEN fanart_path = '' THEN ? ELSE fanart_path END
       WHERE resource_id = ?`
    ).run(...metaCols, JSON.stringify(p.linked_files), p.poster_path, p.fanart_path, id)
  } else {
    id = randomUUID()
    created = true
    d.prepare(
      `INSERT INTO resource
         (id, kind, created_at, updated_at, path, icon_path,
          name_zh, name_en, summary, description, category, tags,
          official_url, source_dir, file_name, file_size, ai_status)
       VALUES (?, 'video', ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done')`
    ).run(id, now, now, p.path, ...common)
    d.prepare(
      `INSERT INTO video_meta
         (resource_id, video_type, year, end_year, rating, duration_sec,
          resolution, video_codec, source, release_group,
          audio_tracks, subtitle_tracks, parts, tmdb_id, imdb_id,
          douban_id, douban_rating, linked_files, poster_path, fanart_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, ...metaCols, JSON.stringify(p.linked_files), p.poster_path, p.fanart_path)
  }

  const episodesAdded = upsertEpisodes(d, id, p.episodes)

  // 集数变了就把剧一级的状态重算一遍。
  //
  // 上面刻意不动 watch_status，这里又改它，看着矛盾，其实是两回事：那边
  // 拒绝的是「把用户的账清零」，这里做的是「让它和集列表对上」。
  //
  // 不重算的话有一个必然出现的错：一部在播的剧，用户看完手上那 8 集
  //（状态 watched），下了后半季再扫一遍 —— upsertEpisodes 补进 8 集未看，
  // 而剧一级还写着「看完」。侧栏说看完了，详情页的 8/16 说没看完，
  // 两个数字来自同一个库却对不上。视图里那几个 episode_* 现算就是为了
  // 避免这类不一致，watch_status 是真列，得自己补这一刀。
  //
  // **只在真的补进新集时重算**（`episodesAdded > 0`）：集列表没变的重扫
  // 不该动它，那种情况下没有任何新事实，重算只会把用户在剧一级上做过的
  // 标记按集列表推翻一次。
  if (episodesAdded > 0) syncSeriesStatus(d, id)

  return { id, created, episodesAdded }
}

/**
 * 补集列表。返回这次**新建**了几集。
 *
 * 已存在的集只更新 title / path / file_size / duration_sec / air_date ——
 * 观看进度那三列碰不得，理由见 insertVideo。
 *
 * 不用 `INSERT ... ON CONFLICT DO UPDATE`：那样写更短，但 SQLite 的
 * `changes` 在 upsert 时对「插入」和「更新」都返回 1，就没法回报新增了几集。
 * 而扫描完那句「新发现 12 集」是用户判断这次扫描有没有用的唯一依据。
 */
export function upsertEpisodes(d: SqlDb, resourceId: string, list: EpisodePayload[]): number {
  if (list.length === 0) return 0

  const find = d.prepare(
    'SELECT id FROM episode WHERE resource_id = ? AND season = ? AND episode = ?'
  )
  const ins = d.prepare(
    `INSERT INTO episode
       (id, resource_id, season, episode, title, path, file_size, duration_sec, air_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const upd = d.prepare(
    `UPDATE episode SET title = ?, path = ?, file_size = ?, duration_sec = ?, air_date = ?
     WHERE id = ?`
  )

  let added = 0
  for (const e of list) {
    const season = Number(e.season) || 0
    const episode = Number(e.episode) || 0
    const row = find.get(resourceId, season, episode) as { id: string } | undefined
    if (row) {
      upd.run(
        String(e.title ?? ''),
        String(e.path ?? ''),
        Number(e.file_size) || 0,
        Number(e.duration_sec) || 0,
        Number(e.air_date) || 0,
        row.id
      )
    } else {
      ins.run(
        randomUUID(),
        resourceId,
        season,
        episode,
        String(e.title ?? ''),
        String(e.path ?? ''),
        Number(e.file_size) || 0,
        Number(e.duration_sec) || 0,
        Number(e.air_date) || 0
      )
      added++
    }
  }
  return added
}

/** 某个目录下已注册的视频，用来告诉 agent 别重复注册 */
export function videosUnder(d: SqlDb, dir: string): Array<{ name: string; path: string }> {
  const rows = d
    .prepare(
      `SELECT name_zh, name_en, file_name, path FROM resource
       WHERE kind = 'video' AND source_dir = ? ORDER BY created_at`
    )
    .all(dir) as Array<Record<string, string>>
  return rows.map((r) => ({ name: r.name_zh || r.name_en || r.file_name, path: r.path }))
}

/* ================================ 读 ================================ */

type Row = Record<string, any>

/**
 * 库里的 JSON 列坏掉时退回空数组，而不是让整个列表页炸掉。
 * 和 game/db.ts 里那个同名函数同一个理由 —— 一行坏数据不该让整个视频库打不开。
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

function rowToVideo(row: Row): VideoItem {
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
    // 库里有 CHECK 兜着，读到别的值只能是手工改库改坏了，退回默认而不是把它透出去
    video_type: VIDEO_TYPES.includes(row.video_type) ? row.video_type : 'movie',
    poster_path: String(row.poster_path ?? ''),
    fanart_path: String(row.fanart_path ?? ''),
    year: Number(row.year) || 0,
    end_year: Number(row.end_year) || 0,
    rating: Number(row.rating) || 0,
    watch_status: WATCH_STATUSES.includes(row.watch_status) ? row.watch_status : 'unwatched',
    position_sec: Number(row.position_sec) || 0,
    duration_sec: Number(row.duration_sec) || 0,
    last_watched_at: Number(row.last_watched_at) || 0,
    resolution: String(row.resolution ?? ''),
    video_codec: String(row.video_codec ?? ''),
    source: String(row.source ?? ''),
    release_group: String(row.release_group ?? ''),
    audio_tracks: jsonArray<MediaTrack>(row.audio_tracks),
    subtitle_tracks: jsonArray<MediaTrack>(row.subtitle_tracks),
    parts: jsonArray<VideoPart>(row.parts),
    linked_files: jsonArray<LinkedFile>(row.linked_files),
    tmdb_id: String(row.tmdb_id ?? ''),
    imdb_id: String(row.imdb_id ?? ''),
    douban_id: String(row.douban_id ?? ''),
    douban_rating: Number(row.douban_rating) || 0,
    episode_total: Number(row.episode_total) || 0,
    episode_watched: Number(row.episode_watched) || 0,
    episode_present: Number(row.episode_present) || 0
  }
}

function rowToEpisode(row: Row): Episode {
  return {
    id: String(row.id),
    resource_id: String(row.resource_id ?? ''),
    season: Number(row.season) || 0,
    episode: Number(row.episode) || 0,
    title: String(row.title ?? ''),
    path: String(row.path ?? ''),
    file_size: Number(row.file_size) || 0,
    duration_sec: Number(row.duration_sec) || 0,
    watch_status: WATCH_STATUSES.includes(row.watch_status) ? row.watch_status : 'unwatched',
    position_sec: Number(row.position_sec) || 0,
    watched_at: Number(row.watched_at) || 0,
    air_date: Number(row.air_date) || 0
  }
}

/**
 * 默认排序按加入时间而不是「上次观看」。
 *
 * 和游戏那边刻意不同：游戏库是拿来反复玩的，最近碰过的该在手边；
 * 影视是**看完就完了**，最近看过的那部恰恰是最不需要再点开的。
 * 刚扫进来还没看的才是用户要找的东西。效果图里排序默认也是「按添加时间」。
 */
const VIDEO_ORDER: Record<NonNullable<VideoQuery['sort']>, string> = {
  name: `COALESCE(NULLIF(name_zh, ''), NULLIF(name_en, ''), file_name) ASC`,
  // year 为 0（不知道年份）的沉到底，不要浮在 2026 前面
  year: 'CASE WHEN year = 0 THEN 1 ELSE 0 END, year DESC, created_at DESC',
  added: 'created_at DESC',
  /**
   * 按分排序时 TMDB 分优先、豆瓣分兜底。
   *
   * 两列都是十分制（tmdb.ts 的 toRating 和豆瓣摘要都按十分制归一），
   * 混在一个排序键里不会出现 8.5 和 85 挨着的事。不兜底的话，一部只
   * 刮到豆瓣分的片会被当成「没评分」沉到底 —— 用户明明在卡片上看得见
   * 那个 8.1，排序却把它当 0，这种自相矛盾比排得不够准更难解释。
   *
   * TMDB 优先而不是取两者最大值：最大值会让排序变成「哪个网站给分高」的
   * 排名，同一部片换个数据源就上下窜。固定主源，另一个只在主源缺失时顶上。
   */
  rating:
    'CASE WHEN COALESCE(NULLIF(rating, 0), douban_rating) = 0 THEN 1 ELSE 0 END, ' +
    'COALESCE(NULLIF(rating, 0), douban_rating) DESC, created_at DESC'
}

export function listVideos(d: SqlDb, query: VideoQuery = {}): VideoItem[] {
  const where: string[] = [query.group === 'archived' ? 'is_archived = 1' : 'is_archived = 0']
  const params: unknown[] = []

  if (query.type && VIDEO_TYPES.includes(query.type)) {
    where.push('video_type = ?')
    params.push(query.type)
  }
  if (query.category) {
    where.push('category = ?')
    params.push(query.category)
  }
  if (query.status && WATCH_STATUSES.includes(query.status)) {
    where.push('watch_status = ?')
    params.push(query.status)
  }
  if (query.tag) {
    // tags 是 JSON 数组字符串，带引号匹配，免得「剧情」命中「剧情向」
    where.push('tags LIKE ?')
    params.push(`%"${query.tag}"%`)
  }
  const keyword = query.keyword?.trim()
  if (keyword) {
    // 中英文标题都要搜得到（规格明确要求），顺带 summary / tags / 文件名
    where.push(
      '(name_zh LIKE ? OR name_en LIKE ? OR summary LIKE ? OR tags LIKE ? OR file_name LIKE ?)'
    )
    for (let i = 0; i < 5; i++) params.push(`%${keyword}%`)
  }

  const order = VIDEO_ORDER[query.sort ?? 'added'] ?? VIDEO_ORDER.added
  const rows = d
    .prepare(`SELECT * FROM video WHERE ${where.join(' AND ')} ORDER BY ${order}`)
    .all(...params) as Row[]
  return rows.map(rowToVideo)
}

export function getVideo(d: SqlDb, id: string): VideoItem | null {
  const row = d.prepare('SELECT * FROM video WHERE id = ?').get(id) as Row | undefined
  return row ? rowToVideo(row) : null
}

/** 一部剧的全部集，按季集号排。电影返回空数组 */
export function listEpisodes(d: SqlDb, resourceId: string): Episode[] {
  const rows = d
    .prepare('SELECT * FROM episode WHERE resource_id = ? ORDER BY season, episode')
    .all(resourceId) as Row[]
  return rows.map(rowToEpisode)
}

export function getEpisode(d: SqlDb, episodeId: string): Episode | null {
  const row = d.prepare('SELECT * FROM episode WHERE id = ?').get(episodeId) as Row | undefined
  return row ? rowToEpisode(row) : null
}

/**
 * 自动连播要放的下一集是哪一集。
 *
 * 只在**同一部剧**里找，且只找有文件的（`path != ''`）—— 缺文件的集要跳过，
 * 否则连播会停在一集播不出来的黑屏上，而用户以为是播放器坏了。
 * 跨季连播是有意的：S01E16 播完接 S02E01，用户不用回详情页点一下。
 */
export function nextEpisode(d: SqlDb, resourceId: string, season: number, episode: number): Episode | null {
  const row = d
    .prepare(
      `SELECT * FROM episode
       WHERE resource_id = ? AND path != ''
         AND (season > ? OR (season = ? AND episode > ?))
       ORDER BY season, episode LIMIT 1`
    )
    .get(resourceId, season, season, episode) as Row | undefined
  return row ? rowToEpisode(row) : null
}

export function videoCounts(d: SqlDb): VideoCounts {
  const one = (sql: string, ...args: unknown[]) =>
    Number((d.prepare(sql).get(...args) as { n: number }).n) || 0

  const status = Object.fromEntries(WATCH_STATUSES.map((s) => [s, 0])) as Record<WatchStatus, number>
  const statusRows = d
    .prepare(
      `SELECT watch_status AS s, COUNT(*) AS n FROM video WHERE is_archived = 0 GROUP BY watch_status`
    )
    .all() as Array<{ s: string; n: number }>
  for (const r of statusRows) {
    if (WATCH_STATUSES.includes(r.s as WatchStatus)) status[r.s as WatchStatus] = Number(r.n) || 0
  }

  const type = Object.fromEntries(VIDEO_TYPES.map((t) => [t, 0])) as Record<VideoType, number>
  const typeRows = d
    .prepare(
      `SELECT video_type AS t, COUNT(*) AS n FROM video WHERE is_archived = 0 GROUP BY video_type`
    )
    .all() as Array<{ t: string; n: number }>
  for (const r of typeRows) {
    if (VIDEO_TYPES.includes(r.t as VideoType)) type[r.t as VideoType] = Number(r.n) || 0
  }

  const categories = (
    d
      .prepare(
        `SELECT category AS name, COUNT(*) AS count FROM video
         WHERE is_archived = 0 GROUP BY category ORDER BY count DESC`
      )
      .all() as Array<{ name: string; count: number }>
  ).map((r) => ({ name: String(r.name ?? ''), count: Number(r.count) || 0 }))

  // 标签在 JSON 数组里，直接在 JS 里聚合。视频库是百级规模，够用
  const tagMap = new Map<string, number>()
  for (const r of d.prepare('SELECT tags FROM video WHERE is_archived = 0').all() as Row[]) {
    for (const t of jsonArray<string>(r.tags)) tagMap.set(t, (tagMap.get(t) ?? 0) + 1)
  }

  return {
    all: one('SELECT COUNT(*) AS n FROM video WHERE is_archived = 0'),
    archived: one('SELECT COUNT(*) AS n FROM video WHERE is_archived = 1'),
    type,
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
 * 键名直接进 SQL 就是一条注入口子。也顺手挡住了「把 id 改掉」这种事。
 *
 * 三个 episode_* 刻意不在名单里 —— 它们是视图现算的，写不进去。
 */
const VIDEO_RESOURCE_COLUMNS = new Set([
  'name_zh', 'name_en', 'summary', 'description', 'category', 'tags',
  'official_url', 'notes', 'is_archived'
])
const VIDEO_META_COLUMNS = new Set([
  'video_type', 'poster_path', 'fanart_path', 'year', 'end_year', 'rating',
  'watch_status', 'position_sec', 'duration_sec', 'last_watched_at',
  'resolution', 'video_codec', 'source', 'release_group',
  'audio_tracks', 'subtitle_tracks', 'parts', 'linked_files', 'tmdb_id', 'imdb_id',
  'douban_id', 'douban_rating'
])

function toColumn(key: string, value: unknown): string | number {
  if (key === 'is_archived') return value ? 1 : 0
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'number') return value
  return String(value ?? '')
}

export function updateVideo(d: SqlDb, id: string, patch: Partial<VideoItem>): VideoItem | null {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined)

  for (const [table, cols, key] of [
    ['resource', VIDEO_RESOURCE_COLUMNS, 'id'],
    ['video_meta', VIDEO_META_COLUMNS, 'resource_id']
  ] as Array<[string, Set<string>, string]>) {
    const mine = entries.filter(([k]) => cols.has(k))
    if (mine.length === 0) continue
    // meta 行可能不存在（手工改库的条目），补一行再写，免得 UPDATE 落空
    if (table === 'video_meta') {
      d.prepare('INSERT OR IGNORE INTO video_meta (resource_id) VALUES (?)').run(id)
    }
    const sets = mine.map(([k]) => `${k} = ?`).join(', ')
    d.prepare(`UPDATE ${table} SET ${sets} WHERE ${key} = ?`).run(
      ...mine.map(([k, v]) => toColumn(k, v)),
      id
    )
  }

  // updated_at 只在总表上，改哪张表都要动它
  d.prepare('UPDATE resource SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  return getVideo(d, id)
}

/** 允许从界面改的集字段。观看进度是唯一会被界面改的东西 */
const EPISODE_COLUMNS = new Set(['watch_status', 'position_sec', 'watched_at', 'title'])

export function updateEpisode(d: SqlDb, episodeId: string, patch: Partial<Episode>): Episode | null {
  const mine = Object.entries(patch).filter(
    ([k, v]) => v !== undefined && EPISODE_COLUMNS.has(k)
  )
  if (mine.length === 0) return getEpisode(d, episodeId)

  const sets = mine.map(([k]) => `${k} = ?`).join(', ')
  d.prepare(`UPDATE episode SET ${sets} WHERE id = ?`).run(
    ...mine.map(([, v]) => (typeof v === 'number' ? v : String(v ?? ''))),
    episodeId
  )

  // 改一集的进度要把整部剧的 updated_at 推前 —— 海报墙的 ?v=updated_at
  // 靠它破封面缓存，也让「最近看过」这类排序反映到剧一级
  d.prepare(
    `UPDATE resource SET updated_at = ?
     WHERE id = (SELECT resource_id FROM episode WHERE id = ?)`
  ).run(Date.now(), episodeId)
  return getEpisode(d, episodeId)
}

/**
 * 从库里移除一个视频。video_meta 和 episode 都靠 ON DELETE CASCADE 跟着走。
 *
 * 不动磁盘上的视频文件 —— 和 removeGame 同一个约定：从抱一里移除一条记录，
 * 不等于用户愿意删掉那个几十 GB 的文件。
 */
export function deleteVideo(d: SqlDb, id: string): void {
  d.prepare('DELETE FROM resource WHERE id = ?').run(id)
}

/**
 * 整部剧的观看状态该是什么，从集列表推出来。
 *
 * 不让用户手动维护剧一级的状态：他标完最后一集「看完」之后，还要再去顶部
 * 点一次「整部剧看完」，这是重复劳动，而漏点一次侧栏计数就错了。
 *
 * 规则：一集都没看 = 未看；全看完 = 看完；否则 = 在看。
 * **dropped 不参与推导** —— 「弃」是用户主动做的判断，看了 8 集不看了和
 * 「在看」在数据上无法区分，只能由用户说。所以这个函数只在
 * 当前状态不是 dropped 时才动它。
 *
 * **没文件的集不进分母**（`path === ''`，即「TMDB 说有这集，磁盘上没有」）。
 * 手上 11 集全看完、还差 5 集没下，这里给的是 watched 而不是 watching。
 * 这一条是有意的，别顺手「修」成按 episode_total 算：
 *   - 按总集数算的话，「看完」在把整部剧凑齐之前永远到不了，而是否凑齐
 *     取决于用户想不想下，不取决于他看到哪了；
 *   - 在看那一组是侧栏里唯一有行动含义的一格（接着看什么，见 Sidebar.vue）。
 *     一部现在没有任何一集能点开播的剧待在那儿，就是往唯一的待办清单里塞噪音。
 * 「还差 5 集」这个信息没丢，详情页照样显示 11/16 并把缺的集列出来 ——
 * 它属于详情页，不属于侧栏计数。
 */
export function deriveSeriesStatus(episodes: Episode[]): WatchStatus | null {
  const withFile = episodes.filter((e) => e.path !== '')
  if (withFile.length === 0) return null
  const watched = withFile.filter((e) => e.watch_status === 'watched').length
  if (watched === 0) {
    const touched = withFile.some((e) => e.position_sec > 0 || e.watch_status === 'watching')
    return touched ? 'watching' : 'unwatched'
  }
  return watched === withFile.length ? 'watched' : 'watching'
}

/** 按集列表把剧一级的状态刷一遍。dropped 不动，见 deriveSeriesStatus */
export function syncSeriesStatus(d: SqlDb, resourceId: string): void {
  const current = d
    .prepare('SELECT watch_status FROM video_meta WHERE resource_id = ?')
    .get(resourceId) as { watch_status: string } | undefined
  if (current?.watch_status === 'dropped') return

  const next = deriveSeriesStatus(listEpisodes(d, resourceId))
  if (!next) return
  d.prepare('UPDATE video_meta SET watch_status = ? WHERE resource_id = ?').run(next, resourceId)
}
