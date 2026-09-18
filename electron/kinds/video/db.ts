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
import type { VideoContentInput } from '../../../src/types/video-library.ts'
import { HENTAI_CATEGORY } from './taxonomy.ts'
import { resolveVideoOrganizeOwner, resolveVideoOrganizePathOwner } from './organize-owner.ts'
import { episodePublicationSql, publicationBounds, videoWithPublicationSql } from './publication.ts'

/** 一集的入库形状。id 由这一层生成，调用方不用管 */
export interface EpisodePayload {
  local_metadata?: Partial<VideoContentInput>
  season: number
  episode: number
  title?: string
  display_label?: string
  /** 空串 = 库里知道有这一集但磁盘上没文件，见 schema.ts */
  path?: string
  file_size?: number
  duration_sec?: number
  air_date?: number

  /**
   * 别家 nfo 里记着的观看状态，**只在新建这一集时写，重扫时整组忽略**。
   *
   * 这一组和上面那些不是一类东西：上面是文件的事实，这一组是「Kodi 那边的
   * 账」。第一次入库时采信它，是因为用户在别处已经看过了，抱一没有任何
   * 理由把它显示成未看。而第二遍扫描时它就不能再作数了 —— 用户可能已经在
   * 抱一里标过，nfo 那边的数字是旧的，覆盖过去就是 Step 6b 刚修掉的那个错
   * 又从另一个入口长回来。
   *
   * 折算规则不在这一层，见 `nfo.ts` 文件里那三个字段的注释和
   * `facts.ts` 的 `nfoWatchState`。
   */
  watch_status?: WatchStatus
  position_sec?: number
  watched_at?: number
}

export interface VideoPayload {
  /** 电影：默认文件路径。剧集：整部剧的目录。同时是 resource.path 这个全局唯一键 */
  path: string
  video_type: VideoType
  collection_name?: string
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
   * hanime 的 videoCode。空串 = 没刮到或不是里番。地位同 tmdb_id。
   *
   * 可选：0.8 才加的，而这个 payload 有十来处构造点（扫描器、nfo、自检、
   * 回滚验证脚本）。要求它等于让每一处都写一遍 `hanime_id: ''`，
   * 而那些地方没有一处知道 hanime 是什么。
   */
  hanime_id?: string
  /** Hanime 页面原文；不经过模型，空串表示没有 Hanime 详情。 */
  original_description?: string
  /** Hanime 站方全部标签；与普通的、受数量限制的 tags 分开。 */
  hanime_tags?: string[]
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

  /**
   * 电影从别家 nfo 带过来的观看状态，**只在这条 resource 还不存在时写**。
   *
   * 和 `EpisodePayload` 上那一组同一个道理，只是落点不同：电影的进度记在
   * `video_meta` 上（`schema.ts` 里写了「position_sec 在这里只对电影有意义」）。
   * 剧集传这一组没有意义 —— 剧一级的状态由 `deriveSeriesStatus` 从集列表推，
   * 硬写会被下一次 `syncSeriesStatus` 推翻。
   */
  watch_status?: WatchStatus
  position_sec?: number
  last_watched_at?: number
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
 * 用户改过就不再被重扫覆盖的字段，按落在哪张表分开。
 *
 * ## 为什么是这一份名单，而不是「所有能改的字段」
 *
 * 名单的边界是**「这个值是猜的，还是从文件上读出来的」**：
 *
 * - 猜的（在名单里）：片名、简介、分类、标签、年份、类型、几个刮削 id。
 *   用户改它们**正是因为刮错了** —— agent 把《三体》的分类给成「欧美」、
 *   把发布组的烂译名当片名。重扫再猜一次，多半还是同一个错。
 * - 读出来的（不在名单里）：分辨率、编码、片源、发布组、时长、音轨、字幕轨、
 *   分卷。这些来自 mediainfo 和文件名，**换了个 1080p 的版本就该跟着变**。
 *   把它们锁住的后果是：用户换了片源，详情页还写着 720p，而那一栏正是
 *   他用来分辨手上是哪个版本的。
 *
 * 所以「用户改过」在这两类上的含义不一样：一类是「我知道得比刮削准」，
 * 另一类是「我手上的文件变了」。只有前者需要保护。
 *
 * `rating` / `douban_rating` 在名单里：它们确实是外部事实，但重扫时刮回来的
 * 是**同一个来源的同一个数**，覆盖不产生新信息；而用户改过评分说明他不认
 * 那个数。`tmdb_id` / `imdb_id` / `douban_id` 更要保护 —— 用户改这个是在说
 * 「你匹配错片了」，不保护的话下次重扫按错的 id 又把整条刮一遍。
 *
 * `notes` / `is_archived` / `watch_status` / `position_sec` 不在名单里，
 * 因为 `insertVideo` 本来就不写它们（见那个函数的注释），不需要这一层。
 */
export const PROTECTED_RESOURCE_FIELDS = [
  'name_zh', 'name_en', 'summary', 'description', 'category', 'tags', 'official_url'
] as const
export const PROTECTED_META_FIELDS = [
  'video_type', 'collection_name', 'year', 'end_year', 'rating',
  'tmdb_id', 'imdb_id', 'douban_id', 'douban_rating', 'hanime_id'
] as const

/** 两张名单合起来。界面上「这个字段被保护着」的判断用它 */
export const PROTECTED_FIELDS: readonly string[] = [
  ...PROTECTED_RESOURCE_FIELDS,
  ...PROTECTED_META_FIELDS
]

/** 解析 user_edited 那一列。脏数据一律当「没改过」，不让它拦住重扫 */
/**
 * user_edited 列里允许出现的字段：受保护的刮削字段，加上 poster_path。
 * poster_path 不走 markUserEdited（见那边的注释），是 setVideoPoster 手选时直接写进去的；
 * 之前解析时按 PROTECTED_FIELDS 过滤把它滤掉了，于是所有 `user_edited.includes('poster_path')`
 * 的判断都恒为 false，用户亲手挑的封面照样被补封面换掉。
 */
export const USER_EDITED_FIELDS: readonly string[] = [...PROTECTED_FIELDS, 'poster_path']

export function parseUserEdited(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((f): f is string => typeof f === 'string' && USER_EDITED_FIELDS.includes(f))
  } catch {
    return []
  }
}

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
 *
 * **用户在界面上改过的字段也跳过**（`user_edited` 那一列，见
 * `PROTECTED_RESOURCE_FIELDS` / `PROTECTED_META_FIELDS`）。跳的是字段不是整行：
 * 用户只改过分类的话，新刮到的简介照样写进去。没有这一层的话，用户把分类从
 * 「欧美」改成「科幻」、把烂译名改成通行叫法，下一次重扫全退回 agent 说的
 * 那个值 —— 而重扫可能只是因为他往那个目录里加了一集。
 */
/** 目录拆分或代表集变化时，用已入库的实际文件定位原条目。多个归属时不猜。 */
export function videoOwnerForFiles(d: SqlDb, files: string[]): { id: string; path: string } | null {
  const keys = new Set(files.filter(Boolean).map(file => file.toLowerCase()))
  if (!keys.size) return null
  const owners = new Map<string, { id: string; path: string }>()
  const addOwner = (rawId: string) => {
    const id = resolveVideoOrganizeOwner(d, rawId)
    const row = d.prepare("SELECT id, path FROM resource WHERE id = ? AND kind = 'video' AND is_archived = 0").get(id) as { id: string; path: string } | undefined
    if (row) owners.set(id, row)
  }
  for (const row of d.prepare('SELECT id, path, parts FROM video').all() as Row[]) {
    if (keys.has(String(row.path).toLowerCase()) || jsonArray<VideoPart>(row.parts).some(part => keys.has(String(part.path).toLowerCase()))) {
      addOwner(row.id)
    }
  }
  for (const row of d.prepare(`SELECT e.resource_id AS id, r.path AS resource_path, e.path
    FROM episode e JOIN resource r ON r.id = e.resource_id WHERE e.path != '' AND r.kind = 'video'`).all() as Row[]) {
    if (keys.has(String(row.path).toLowerCase())) addOwner(row.id)
  }
  for (const row of d.prepare('SELECT resource_id, path FROM video_assets').all() as Row[]) if (keys.has(String(row.path).toLowerCase())) addOwner(row.resource_id)
  for (const file of files) { const historical = resolveVideoOrganizePathOwner(d, file); if (historical) addOwner(historical) }
  return owners.size === 1 ? [...owners.values()][0] : null
}

export function insertVideo(d: SqlDb, p: VideoPayload, splitFromId = ''): VideoWriteOutcome {
  if (!splitFromId) return writeVideo(d, p, '')
  d.exec('SAVEPOINT split_video')
  try {
    const outcome = writeVideo(d, p, splitFromId)
    d.exec('RELEASE SAVEPOINT split_video')
    return outcome
  } catch (error) {
    d.exec('ROLLBACK TO SAVEPOINT split_video')
    d.exec('RELEASE SAVEPOINT split_video')
    throw error
  }
}

function writeVideo(d: SqlDb, p: VideoPayload, splitFromId: string): VideoWriteOutcome {
  const now = Date.now()

  // 字段名和值配对着走，因为重扫时要按 user_edited 把其中几对摘掉。
  // 摘不了「第 3 个问号对应 category」这种写法 —— 那是上一版的形状，
  // 摘掉一个值就得同时数着改 SQL 里的问号，改错一个是静默写错列
  const resourceFields: Array<[string, string | number]> = [
    ['name_zh', p.name_zh],
    ['name_en', p.name_en],
    ['summary', p.summary],
    ['description', p.description],
    ['category', p.category],
    ['tags', JSON.stringify(p.tags)],
    ['official_url', p.official_url]
  ]
  // 这三个不属于「刮出来的」，是文件本身的事实，永远跟着重扫走
  const resourceAlways: Array<[string, string | number]> = [
    ['source_dir', p.source_dir],
    ['file_name', path.basename(p.path)],
    ['file_size', p.file_size]
  ]

  const metaFields: Array<[string, string | number]> = [
    ['video_type', p.video_type],
    ['year', p.year],
    ['end_year', p.end_year],
    ['rating', p.rating],
    ['tmdb_id', p.tmdb_id],
    ['imdb_id', p.imdb_id],
    ['douban_id', p.douban_id],
    ['douban_rating', p.douban_rating],
    // 0.8 加的，所以是可选字段 —— 这里补默认值而不是让 VideoPayload 要求它。
    //
    // 不补的话 undefined 会一路走到 stmt.run()，报的是
    // 「Provided value cannot be bound to SQLite parameter 13」——
    // 一句不提哪个字段的错，而它会在**每一次入库**上炸，不只是里番那条路
    ['hanime_id', p.hanime_id ?? ''],
    ['original_description', p.original_description ?? ''],
    ['hanime_tags', JSON.stringify(p.hanime_tags ?? [])]
  ]
  // 只在新建时写的一组：别家 nfo 记的观看状态。
  //
  // 它既不在 metaFields 里也不在 metaAlways 里，因为两组都会在重扫时写。
  // 这一组的整个约定是「只认第一次」—— 第二遍扫描时用户可能已经在抱一里
  // 标过了，而 nfo 那边的数字是旧的。
  //
  // 只对电影成立。剧集的 watch_status 由集列表推，见字段上的注释
  const metaCreateOnly: Array<[string, string | number]> =
    p.video_type === 'movie' && WATCH_STATUSES.includes(p.watch_status as WatchStatus)
      ? [
          ['watch_status', p.watch_status as WatchStatus],
          ['position_sec', Math.max(0, Math.round(Number(p.position_sec) || 0))],
          ['last_watched_at', Math.max(0, Math.round(Number(p.last_watched_at) || 0))]
        ]
      : []

  // 本地事实那一组，不受保护，见 PROTECTED_META_FIELDS 的注释
  const metaAlways: Array<[string, string | number]> = [
    ['duration_sec', p.duration_sec],
    ['resolution', p.resolution],
    ['video_codec', p.video_codec],
    ['source', p.source],
    ['release_group', p.release_group],
    ['audio_tracks', JSON.stringify(p.audio_tracks)],
    ['subtitle_tracks', JSON.stringify(p.subtitle_tracks)],
    ['parts', JSON.stringify(p.parts)]
  ]

  const existing = (d.prepare("SELECT id, path FROM resource WHERE kind = 'video' AND path = ?").get(p.path) as
    { id: string; path: string } | undefined) ?? (splitFromId ? null : videoOwnerForFiles(d, [...p.parts.map(part => part.path), ...p.episodes.map(ep => ep.path || '')]))

  let id: string
  let created: boolean

  if (existing) {
    id = existing.id
    created = false
    if (existing.path !== p.path) d.prepare('UPDATE resource SET path = ? WHERE id = ?').run(p.path, id)

    // meta 行可能不存在（手工改库、或早于 video_meta 建表的条目），补一行再写。
    // 提到读 user_edited 之前 —— 没这一行的话下面那句 SELECT 拿不到东西，
    // 保护名单会变成空的，等于这一层没生效
    d.prepare('INSERT OR IGNORE INTO video_meta (resource_id) VALUES (?)').run(id)
    const edited = new Set(
      parseUserEdited(
        (
          d.prepare('SELECT user_edited FROM video_meta WHERE resource_id = ?').get(id) as
            | { user_edited?: unknown }
            | undefined
        )?.user_edited
      )
    )

    const resourceSets = [
      ...resourceFields.filter(([f]) => !edited.has(f)),
      ...resourceAlways
    ]
    d.prepare(
      `UPDATE resource SET ${resourceSets.map(([f]) => `${f} = ?`).join(', ')},
         ai_status = 'done', updated_at = ?
       WHERE id = ?`
    ).run(...resourceSets.map(([, v]) => v), now, id)

    const metaSets = [...metaFields.filter(([f]) => !edited.has(f)), ...metaAlways]
    d.prepare(
      `UPDATE video_meta SET ${metaSets.map(([f]) => `${f} = ?`).join(', ')},
         linked_files = CASE WHEN linked_files IN ('[]', '') THEN ? ELSE linked_files END,
         poster_path = CASE WHEN poster_path = '' THEN ? ELSE poster_path END,
         poster_source = CASE WHEN ? != '' THEN ? ELSE poster_source END,
         fanart_path = CASE WHEN fanart_path = '' THEN ? ELSE fanart_path END
       WHERE resource_id = ?`
    ).run(
      ...metaSets.map(([, v]) => v),
      JSON.stringify(p.linked_files),
      p.poster_path,
      p.poster_path,
      p.poster_path,
      p.fanart_path,
      id
    )
  } else {
    id = randomUUID()
    created = true
    // 新条目：还没人改过任何字段，两组全写进去
    const rCols = [...resourceFields, ...resourceAlways]
    d.prepare(
      `INSERT INTO resource
         (id, kind, created_at, updated_at, path, icon_path, ai_status,
          ${rCols.map(([f]) => f).join(', ')})
       VALUES (?, 'video', ?, ?, ?, '', 'done', ${rCols.map(() => '?').join(', ')})`
    ).run(id, now, now, p.path, ...rCols.map(([, v]) => v))

    const mCols = [...metaFields, ...metaAlways, ...metaCreateOnly]
    d.prepare(
      `INSERT INTO video_meta
         (resource_id, linked_files, poster_path, poster_source, fanart_path,
          ${mCols.map(([f]) => f).join(', ')})
       VALUES (?, ?, ?, ?, ?, ${mCols.map(() => '?').join(', ')})`
    ).run(
      id,
      JSON.stringify(p.linked_files),
      p.poster_path,
      p.poster_path,
      p.fanart_path,
      ...mCols.map(([, v]) => v)
    )
  }

  // Move the existing rows before upsert so episode IDs and watch progress follow their files.
  let episodesMoved = 0
  if (splitFromId && splitFromId !== id) {
    const move = d.prepare('UPDATE episode SET resource_id = ? WHERE resource_id = ? AND path = ? COLLATE NOCASE')
    for (const file of new Set(p.episodes.map(ep => ep.path).filter(Boolean))) {
      episodesMoved += Number(move.run(id, splitFromId, file).changes)
    }
    if (episodesMoved > 0) syncSeriesStatus(d, splitFromId)
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
  if (episodesAdded > 0 || episodesMoved > 0) syncSeriesStatus(d, id)

  return { id, created, episodesAdded }
}

/**
 * 补集列表。返回这次**新建**了几集。
 *
 * 已存在的集只更新 title / path / file_size / duration_sec / air_date ——
 * 观看进度那三列碰不得，理由见 insertVideo。**新建的集是唯一的例外**：
 * 那三列会接受 payload 里带来的值（来自别家 nfo），因为一条还不存在的记录
 * 上没有任何用户账可言。见 `EpisodePayload` 上那一组字段的注释。
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
       (id, resource_id, season, episode, title, display_label, path, file_size, duration_sec, air_date,
        watch_status, position_sec, watched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  // UPDATE 的列比 INSERT 少三个，是这个函数的全部要点：观看进度只在新建时接受
  // 外来值，之后就归用户和 updateEpisode 管。别顺手把它们补齐成一样的列表
  const upd = d.prepare(
    `UPDATE episode SET title = ?, display_label = ?, path = ?, file_size = ?, duration_sec = ?, air_date = ?
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
        String(e.display_label ?? ''),
        String(e.path ?? ''),
        Number(e.file_size) || 0,
        Number(e.duration_sec) || 0,
        Number(e.air_date) || 0,
        row.id
      )
    } else {
      // 状态过一遍白名单：这个值一路来自磁盘上别人写的 xml，
      // 而那一列有 CHECK 约束，写进去一个没见过的词是整条 INSERT 抛异常
      const status = WATCH_STATUSES.includes(e.watch_status as WatchStatus)
        ? (e.watch_status as WatchStatus)
        : 'unwatched'
      ins.run(
        randomUUID(),
        resourceId,
        season,
        episode,
        String(e.title ?? ''),
        String(e.display_label ?? ''),
        String(e.path ?? ''),
        Number(e.file_size) || 0,
        Number(e.duration_sec) || 0,
        Number(e.air_date) || 0,
        status,
        Math.max(0, Math.round(Number(e.position_sec) || 0)),
        Math.max(0, Math.round(Number(e.watched_at) || 0))
      )
      added++
    }
  }
  return added
}

/** 某个目录下已注册的视频，用来告诉 agent 别重复注册 */
export function videosUnder(d: SqlDb, dir: string): Array<{ name: string; path: string; collection_name: string }> {
  const rows = d
    .prepare(
      `SELECT name_zh, name_en, file_name, path, collection_name FROM video
       WHERE source_dir = ? ORDER BY created_at`
    )
    .all(dir) as Array<Record<string, string>>
  return rows.map((r) => ({ name: r.name_zh || r.name_en || r.file_name, path: r.path, collection_name: r.collection_name }))
}

/**
 * 这条路径上已有条目的分类。空串 = 库里还没有它。
 *
 * 给刮削通道判据用（见 `hentai/channel.ts`）：用户手改过的分类是**永久保护**的
 * （`category` 在 PROTECTED_RESOURCE_FIELDS 里），所以「这一条已经是里番」
 * 这个事实读一次就够，不用每次重新猜。
 *
 * 只查 `resource`，不走 `video` 视图 —— 视图里 JOIN 了 video_meta 和三个
 * 子查询统计集数，而这里只要一列。识别每个条目都会调它一次。
 */
export function videoCategoryOf(d: SqlDb, path: string): string {
  const row = d
    .prepare(`SELECT category FROM resource WHERE kind = 'video' AND path = ?`)
    .get(String(path ?? '')) as { category?: string } | undefined
  return String(row?.category ?? '')
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
    needs_review: row.ai_status !== 'done',
    published_start: Number(row.published_start) || 0,
    published_end: Number(row.published_end) || 0,
    // 库里有 CHECK 兜着，读到别的值只能是手工改库改坏了，退回默认而不是把它透出去
    video_type: VIDEO_TYPES.includes(row.video_type) ? row.video_type : 'movie',
    thumbnail_path: String(row.thumbnail_path ?? ""),
    thumbnail_source: String(row.thumbnail_source ?? ""),
    poster_path: String(row.poster_path ?? ''),
    poster_source: String(row.poster_source ?? ''),
    collection_name: String(row.collection_name ?? ''),
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
    hanime_id: String(row.hanime_id ?? ''),
    original_description: String(row.original_description ?? ''),
    hanime_tags: jsonArray<string>(row.hanime_tags),
    user_edited: parseUserEdited(row.user_edited),
    episode_total: Number(row.episode_total) || 0,
    episode_watched: Number(row.episode_watched) || 0,
    episode_present: Number(row.episode_present) || 0
  }
}

function rowToEpisode(row: Row): Episode {
  return {
    published_at: Number(row.published_at) || 0,
    studio: String(row.studio ?? ''),
    id: String(row.id),
    resource_id: String(row.resource_id ?? ''),
    season: Number(row.season) || 0,
    episode: Number(row.episode) || 0,
    title: String(row.title ?? ''),
    display_label: String(row.display_label ?? ''),
    tags: jsonArray<string>(row.tags),
    poster_source: String(row.poster_source ?? ""),
    original_title: String(row.original_title ?? ''),
    description: String(row.description ?? ''),
    original_description: String(row.original_description ?? ''),
    thumbnail_path: String(row.thumbnail_path ?? ""),
    thumbnail_source: String(row.thumbnail_source ?? ""),
    poster_path: String(row.poster_path ?? ''),
    source_url: String(row.source_url ?? ''),
    notes: String(row.notes ?? ''),
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
  updated: 'updated_at DESC',
  published: 'CASE WHEN published_end = 0 THEN 1 ELSE 0 END, published_end DESC, created_at DESC',
  'published-asc': 'CASE WHEN published_start = 0 THEN 1 ELSE 0 END, published_start ASC, created_at DESC',
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

/**
 * 「隐藏里番」那个开关的 SQL 片段。
 *
 * 收在一个常量里而不是各处手写 `category != '里番'`：这个条件要出现在**七处**
 * （列表 + counts 的六个聚合），漏掉任何一处的表现都是「关了还能从别的地方看见」
 * —— 而那种漏比不做更糟，用户以为藏住了。
 *
 * 用 `!=` 而不是 `NOT IN`：目前只有一个分类要藏。将来 F 那条（要不要把
 * 泡面番 / 3D / MMD 也做成分类）如果定了要加，这里改成一个列表，
 * 七处引用一起跟着变，不用再找一遍。
 */
const NOT_HENTAI = `category != '${HENTAI_CATEGORY}'`

/**
 * @param hideHentai 隐藏里番。**显式传进来**，不在这一层读设置 ——
 *   db.ts 是纯数据层，自检直接拿内存库驱动它；一读设置就得先有 app 和库，
 *   那几十条断言全得改。判据留在 service 层（`listVideoItems`）。
 */
export function listVideos(
  d: SqlDb,
  query: VideoQuery = {},
  hideHentai = false
): VideoItem[] {
  const where: string[] = [query.group === 'archived' ? 'is_archived = 1' : 'is_archived = 0']
  const params: unknown[] = []

  const dates = publicationBounds(query.publishedFrom, query.publishedTo)
  if (dates.from !== undefined || dates.until !== undefined) {
    const bounds = [`e.resource_id=video.id`, `${episodePublicationSql} IS NOT NULL`]
    if (dates.from !== undefined) { bounds.push(`${episodePublicationSql} >= ?`); params.push(dates.from) }
    if (dates.until !== undefined) { bounds.push(`${episodePublicationSql} < ?`); params.push(dates.until) }
    where.push(`EXISTS (SELECT 1 FROM episode e WHERE ${bounds.join(' AND ')})`)
  }

  /*
   * 藏的时候连**明确点了里番分类**的查询也一起空掉。
   *
   * 看着多余 —— 藏了之后侧栏那一格就没了，正常操作点不到它。但 `query` 是从
   * 渲染进程过来的，挡在这一层才是真的挡住：开关刚打开的那一刻 store 里的
   * selection 可能还停在里番（用户正看着那一格时去设置页打开了开关），
   * 而任何一处忘了刷新都会让墙上原样铺着。
   *
   * 判据放数据层而不是靠界面自觉，理由是这个开关的意义就是「别显示出来」——
   * 靠调用方每一处都记得传对参数，等于把它做成了君子协定。
   */
  const inHentai = query.type === 'hentai'
  if (hideHentai || !inHentai) where.push(NOT_HENTAI)
  if (inHentai) { where.push('category = ?'); params.push(HENTAI_CATEGORY) }
  if (query.collection !== undefined) { where.push('collection_name = ?'); params.push(query.collection) }

  if (query.type && query.type !== 'hentai' && VIDEO_TYPES.includes(query.type)) {
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
    // 站方标签只在明确进入里番分类后参与查询。这样普通标签区即使存在同名词，
    // 也不会把里番条目带进普通影视结果。
    where.push("(EXISTS (SELECT 1 FROM json_each(video.tags) t WHERE t.value = ?) OR EXISTS (SELECT 1 FROM json_each(video.hanime_tags) t WHERE t.value = ?) OR EXISTS (SELECT 1 FROM episode e,json_each(e.tags) t WHERE e.resource_id=video.id AND t.value=?))")
    params.push(query.tag, query.tag, query.tag)
  }
  const keyword = query.keyword?.trim()
  if (keyword) {
    // 中英文标题都要搜得到（规格明确要求），顺带 summary / tags / 文件名
    where.push(
      `(name_zh LIKE ? OR name_en LIKE ? OR summary LIKE ? OR tags LIKE ? OR file_name LIKE ?
        OR EXISTS (SELECT 1 FROM episode e WHERE e.resource_id = video.id AND (e.title LIKE ? OR e.path LIKE ? OR e.original_title LIKE ? OR e.tags LIKE ?))
        OR EXISTS (SELECT 1 FROM video_assets a WHERE a.resource_id = video.id AND a.path LIKE ?))`
    )
    for (let i = 0; i < 10; i++) params.push(`%${keyword}%`)
  }

  const order = VIDEO_ORDER[query.sort ?? 'added'] ?? VIDEO_ORDER.added
  const rows = d
    .prepare(`${videoWithPublicationSql} WHERE ${where.join(' AND ')} ORDER BY ${order}`)
    .all(...params) as Row[]
  return rows.map(row => {
    const item = rowToVideo(row)
    if (keyword) {
      const match = d.prepare('SELECT title, path FROM episode WHERE resource_id = ? AND (title LIKE ? OR path LIKE ?) LIMIT 1').get(item.id, `%${keyword}%`, `%${keyword}%`) as Row | undefined
      if (match) item.matched_content = String(match.title || path.basename(match.path || ''))
    }
    return item
  })
}

export function getVideo(d: SqlDb, id: string): VideoItem | null {
  const row = d.prepare(`${videoWithPublicationSql} WHERE id = ?`).get(id) as Row | undefined
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

/**
 * 在一部剧上点「播放」该开哪一集。没有一集有文件时给 `null`。
 *
 * 三档，顺序是想清楚的：
 *
 * 1. **有断点、还没看完的那一集**（`position_sec > 0` 且不是 watched）。
 *    上次播到一半退出去了，接着看它。多集都有断点时取最靠前的 ——
 *    倒着追剧的人是少数，而「最靠前」这个规则用户能自己预测出来。
 * 2. **第一集没看完的**（不是 watched，也不是 dropped）。正常追剧就走这一档。
 * 3. **全看完了 = 第一集**。重看一部剧的人从头开始，这比「没得播」有用。
 *    这一档也兜住了「全标成 dropped」那种情况。
 *
 * `dropped` 在第二档里被排除掉：用户明确说过这一集不看了（跳过的花絮特别篇
 * 常被这么标），点播放跳到它上面是把用户刚做的判断当没看见。但第三档不排除
 * 它 —— 那时候已经没有别的候选了，开一集总比什么都不做好。
 *
 * 只找有文件的（`path != ''`）。缺文件的集在详情页上要露面（用户得知道
 * 自己缺什么），但播放器打不开一个不存在的文件。
 */
export function resumeEpisode(d: SqlDb, resourceId: string): Episode | null {
  const pick = (extra: string): Row | undefined =>
    d
      .prepare(
        `SELECT * FROM episode WHERE resource_id = ? AND path != '' ${extra}
         ORDER BY season, episode LIMIT 1`
      )
      .get(resourceId) as Row | undefined

  const row =
    pick(`AND position_sec > 0 AND watch_status != 'watched'`) ??
    pick(`AND watch_status NOT IN ('watched', 'dropped')`) ??
    pick('')
  return row ? rowToEpisode(row) : null
}

/**
 * @param hideHentai 隐藏里番。**六个聚合都要挡**，不是只挡 categories ——
 *   侧栏的观看状态、类型、标签三处计数都从这里来，只挡分类那一格的话，
 *   格子消失了而别处的数字仍旧含着里番，等于告诉用户「藏了几条」。
 *   `archived` 也挡：归档区的计数漏出去是同一回事。
 */
export function videoCounts(d: SqlDb, hideHentai = false): VideoCounts {
  const one = (sql: string, ...args: unknown[]) =>
    Number((d.prepare(sql).get(...args) as { n: number }).n) || 0

  /** 拼在 `is_archived = ?` 后面的那一截。不藏时是空串，SQL 原样不变 */
  const hide = ` AND ${NOT_HENTAI}`

  const status = Object.fromEntries(WATCH_STATUSES.map((s) => [s, 0])) as Record<WatchStatus, number>
  const statusRows = d
    .prepare(
      `SELECT watch_status AS s, COUNT(*) AS n FROM video
       WHERE is_archived = 0${hide} GROUP BY watch_status`
    )
    .all() as Array<{ s: string; n: number }>
  for (const r of statusRows) {
    if (WATCH_STATUSES.includes(r.s as WatchStatus)) status[r.s as WatchStatus] = Number(r.n) || 0
  }

  const type = Object.fromEntries(VIDEO_TYPES.map((t) => [t, 0])) as Record<VideoType, number>
  const typeRows = d
    .prepare(
      `SELECT video_type AS t, COUNT(*) AS n FROM video
       WHERE is_archived = 0${hide} GROUP BY video_type`
    )
    .all() as Array<{ t: string; n: number }>
  for (const r of typeRows) {
    if (VIDEO_TYPES.includes(r.t as VideoType)) type[r.t as VideoType] = Number(r.n) || 0
  }

  const categories = (
    d
      .prepare(
        `SELECT category AS name, COUNT(*) AS count FROM video
         WHERE is_archived = 0${hide} GROUP BY category ORDER BY count DESC`
      )
      .all() as Array<{ name: string; count: number }>
  ).map((r) => ({ name: String(r.name ?? ''), count: Number(r.count) || 0 }))

  const tagMap = new Map<string, number>(), hanimeTagMap = new Map<string, number>()
  const tagRows = d.prepare(`SELECT tag, category, COUNT(DISTINCT resource_id) AS count FROM (
    SELECT v.id AS resource_id,v.category,t.value AS tag FROM video v,json_each(v.tags) t WHERE v.is_archived=0
    UNION SELECT v.id,v.category,t.value FROM video v,json_each(v.hanime_tags) t WHERE v.is_archived=0
    UNION SELECT v.id,v.category,t.value FROM video v JOIN episode e ON e.resource_id=v.id,json_each(e.tags) t WHERE v.is_archived=0
  ) GROUP BY tag,category`).all() as Row[]
  for (const row of tagRows) {
    const map = row.category === HENTAI_CATEGORY ? hideHentai ? null : hanimeTagMap : tagMap
    if (map) map.set(String(row.tag),(map.get(String(row.tag)) || 0) + Number(row.count))
  }
  return {
    all: one(`SELECT COUNT(*) AS n FROM video WHERE is_archived = 0${hide}`),
    hentai: hideHentai ? 0 : one(`SELECT COUNT(*) AS n FROM video WHERE is_archived = 0 AND category = ?`, HENTAI_CATEGORY),
    hentai_visible: !hideHentai,
    hentai_archived: hideHentai ? 0 : one(`SELECT COUNT(*) AS n FROM video WHERE is_archived = 1 AND category = ?`, HENTAI_CATEGORY),
    collections: d.prepare(`SELECT collection_name AS name, COUNT(*) AS count FROM video
      WHERE is_archived = 0${hide} AND collection_name != '' GROUP BY collection_name ORDER BY collection_name`).all().map(row => ({ name: String((row as Row).name), count: Number((row as Row).count) })),
    hentai_collections: hideHentai ? [] : d.prepare(`SELECT collection_name AS name, COUNT(*) AS count FROM video
      WHERE is_archived = 0 AND category = ? AND collection_name != '' GROUP BY collection_name ORDER BY collection_name`).all(HENTAI_CATEGORY).map(row => ({ name: String((row as Row).name), count: Number((row as Row).count) })),
    archived: one(`SELECT COUNT(*) AS n FROM video WHERE is_archived = 1${hide}`),
    type,
    status,
    categories,
    tags: [...tagMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh')),
    hanime_tags: [...hanimeTagMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
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
export const VIDEO_RESOURCE_COLUMNS = new Set([
  'name_zh', 'name_en', 'summary', 'description', 'category', 'tags',
  'official_url', 'notes', 'is_archived'
])
export const VIDEO_META_COLUMNS = new Set([
  'thumbnail_path', 'thumbnail_source', 'video_type', 'collection_name', 'poster_path', 'poster_source', 'fanart_path', 'year', 'end_year', 'rating',
  'watch_status', 'position_sec', 'duration_sec', 'last_watched_at',
  'resolution', 'video_codec', 'source', 'release_group',
  'audio_tracks', 'subtitle_tracks', 'parts', 'linked_files', 'tmdb_id', 'imdb_id',
  'douban_id', 'douban_rating', 'hanime_id', 'original_description', 'hanime_tags'
])

function toColumn(key: string, value: unknown): string | number {
  if (key === 'collection_name') return String(value ?? '').trim().slice(0, 80)
  if (key === 'is_archived') return value ? 1 : 0
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'number') return value
  return String(value ?? '')
}

/**
 * 把这次改动里受保护的字段记进 `user_edited`。
 *
 * 只加不减 —— 撤保护走 `restoreScrapedFields`，是用户显式点的另一个动作。
 *
 * `poster_path` 不在保护名单里，所以经由 `setPoster` / `clearPoster` 走到这里的
 * 改动不会留下标记。那两条路本来就有自己的保护（`CASE WHEN poster_path = ''`），
 * 不需要在这儿重复一遍。
 */
function markUserEdited(d: SqlDb, id: string, changedFields: string[]): void {
  const mine = changedFields.filter((f) => PROTECTED_FIELDS.includes(f))
  if (mine.length === 0) return

  d.prepare('INSERT OR IGNORE INTO video_meta (resource_id) VALUES (?)').run(id)
  const before = parseUserEdited(
    (
      d.prepare('SELECT user_edited FROM video_meta WHERE resource_id = ?').get(id) as
        | { user_edited?: unknown }
        | undefined
    )?.user_edited
  )
  const merged = [...new Set([...before, ...mine])]
  if (merged.length === before.length) return
  d.prepare('UPDATE video_meta SET user_edited = ? WHERE resource_id = ?').run(
    JSON.stringify(merged),
    id
  )
}

/**
 * 撤掉几个字段的保护，让它们下次重扫时重新跟着刮削走。
 *
 * **它不把值改回去。** 刮削原来那个值没有存第二份 —— 用户改的时候就把它
 * 覆盖了。所以这个动作的真实含义是「以后这一栏听刮削的」，界面上的文案
 * 必须这么写：叫「恢复成刮削值」会让用户以为点一下就变回去了，
 * 而实际要等下一次重扫才变，中间那段时间他会以为功能坏了。
 *
 * 传空数组 = 全撤。
 */
export function restoreScrapedFields(d: SqlDb, id: string, fields: string[]): VideoItem | null {
  const before = parseUserEdited(
    (
      d.prepare('SELECT user_edited FROM video_meta WHERE resource_id = ?').get(id) as
        | { user_edited?: unknown }
        | undefined
    )?.user_edited
  )
  const drop = fields.length === 0 ? before : fields
  const next = before.filter((f) => !drop.includes(f))
  if (next.length !== before.length) {
    d.prepare('UPDATE video_meta SET user_edited = ? WHERE resource_id = ?').run(
      JSON.stringify(next),
      id
    )
    d.prepare('UPDATE resource SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }
  return getVideo(d, id)
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

  markUserEdited(d, id, entries.map(([k]) => k))

  // updated_at 只在总表上，改哪张表都要动它
  d.prepare('UPDATE resource SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  return getVideo(d, id)
}

/** Editable episode metadata and progress; identity and file ownership use dedicated operations. */
const EPISODE_COLUMNS = new Set(['published_at', 'air_date', 'duration_sec', 'studio', 'watch_status', 'position_sec', 'watched_at', 'title', 'display_label', 'original_title', 'description', 'original_description', 'notes', 'tags', 'poster_path', 'poster_source', 'thumbnail_path', 'thumbnail_source', 'source_url'])

export function updateEpisode(d: SqlDb, episodeId: string, patch: Partial<Episode>): Episode | null {
  const mine = Object.entries(patch).filter(
    ([k, v]) => v !== undefined && EPISODE_COLUMNS.has(k)
  )
  if (mine.length === 0) return getEpisode(d, episodeId)

  const sets = mine.map(([k]) => `${k} = ?`).join(', ')
  d.prepare(`UPDATE episode SET ${sets} WHERE id = ?`).run(
    ...mine.map(([, v]) => (Array.isArray(v) ? JSON.stringify(v) : typeof v === 'number' ? v : String(v ?? ''))),
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
