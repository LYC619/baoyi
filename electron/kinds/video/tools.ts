/**
 * 交给视频识别 agent 的工具集。
 *
 * 和游戏那份比，边界问题轻得多：视频识别**不需要走出条目目录**
 * （游戏要找存档，存档几乎总在游戏目录之外，所以那边有两道白名单）。
 * 这里落到文件系统上的只有一个 `path` —— 而它必须是扫描器已经见过的那个，
 * 不是模型给的。见 `register` 里那道核对。
 *
 * 不 import `services/database.ts`：那条链路依赖 electron 和 better-sqlite3，
 * 一旦引进来整套识别就只能在应用跑起来之后才验证得了。落库走 `ctx.db`
 * 这个最小 SQL 句柄 —— 和 game/tools.ts 同一个理由。
 *
 * ## 这里没有 list_directory 和 read_text_file
 *
 * 刻意的。视频目录里没有说明文档可读（游戏那边有 readme 和汉化说明，
 * 那是真信息），而目录结构 `scanner.ts` 已经完整看过一遍、
 * `facts.ts` 已经把能读的都读了。给一个用不上的工具只会引诱模型
 * 浪费一轮往返，而每一轮都要把整个上下文重发一次。
 */

import type { AgentTool } from '../../services/agent/loop.ts'
import type { SqlDb } from '../../services/schema.ts'
import type { SearchConfig, TmdbConfig, VideoPart } from '../../../src/types'
import { formatHits, search } from '../../services/searchService.ts'
import { insertVideo, type EpisodePayload, type VideoPayload } from './db.ts'
import type { VideoFacts } from './facts.ts'
import {
  tmdbDetail,
  tmdbFindByExternalId,
  tmdbSearch,
  tmdbSeasonEpisodes,
  type TmdbDetail
} from './tmdb.ts'

/** 一次识别最多搜几次 TMDB。上限在 prompt 里也写了一遍，这里是执行它的那一半 */
const MAX_TMDB_SEARCHES = 4
/**
 * 一次刮削最多取几季的集表。
 *
 * 一部 10 季的美剧全取是 10 次 API 往返，而用户手上通常只有一两季。
 * 所以只取「用户手上有的那些季」，见 `fetchEpisodes`。这个上限是兜底，
 * 防着一个畸形的季号列表把请求打爆。
 */
const MAX_SEASON_FETCHES = 6

export interface VideoToolContext {
  /** 本次负责的条目，事实已经凑齐 */
  facts: VideoFacts
  /** 落库句柄 */
  db: SqlDb
  /** 现有标签池，用来收敛模型新造标签的冲动 */
  tagPool: string[]
  searchConfig: SearchConfig
  tmdbConfig: TmdbConfig
  onRegister?: (info: { name: string; path: string; created: boolean; episodesAdded: number }) => void
  onSkip?: (path: string, reason: string) => void
}

function str(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : ''
}

function int(raw: unknown): number {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.round(n) : 0
}

/**
 * 取一个 id，数字和字符串都收。
 *
 * 参数表里 `tmdb_id` 声明的是 number，所以守规矩的模型交上来的是 JSON 数字
 * `438631`；但也有模型交 `"438631"`，甚至 `"tmdb:438631"`。
 * 用 `str()` 读会把前者变成空串 —— **越守规矩的模型越拿不到 id**，
 * 而表现是「刮削静默失效」：不报错、不落 id、日志里什么都看不出来。
 */
function idOf(raw: unknown): string {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? String(Math.round(raw)) : ''
  return str(raw, 20).replace(/\D/g, '')
}

/* ============================== 标签收敛 ============================== */

/**
 * 标签收敛。和 prompt 里「最多新增 2 个」是同一条规则的两半：
 * prompt 负责说，这里负责在模型不听话时执行。
 *
 * 逻辑与 `game/tools.ts` 的 `limitGameTags` 一致但**刻意各留一份** ——
 * 跨品类 import 会让两边的规则从此绑死，而它们的新增上限本来就不同
 * （游戏 1 个，视频 2 个：影视的题材词比游戏类型词丰富得多，
 * 「悬疑」「公路」「伪纪录」这类词在池子里攒起来是有用的）。
 *
 * 另外挡掉技术词：模型总想把 4K / HEVC / 蓝光写成标签，而它们已经是
 * `video_meta` 上的真列了。放进去是重复，还会把筛选器塞满。
 */
const TECH_WORDS =
  /^(?:4k|8k|1080p?|2160p?|720p?|480p?|hdr\d*|dolby\s?vision|dv|hevc|h\.?26[45]|av1|x26[45]|蓝光|bluray|blu-ray|remux|webdl|web-dl|webrip|hdtv|dvd(?:rip)?|原盘|高清|超清|标清|杜比|dts(?:-hd)?|truehd|atmos|flac|aac|ac3)$/i

export function limitVideoTags(raw: unknown, pool: Set<string>): string[] {
  const all = (Array.isArray(raw) ? raw : [])
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim().slice(0, 12))
    .filter((t) => !TECH_WORDS.test(t))
  const known = all.filter((t) => pool.has(t))
  const fresh = all.filter((t) => !pool.has(t)).slice(0, 2)
  return [...new Set([...known, ...fresh])].slice(0, 3)
}

/* ============================== TMDB 账本 ============================== */

/**
 * 这次识别里，TMDB 真实返回过的条目。
 *
 * `register_video` 拿它核对模型填的 tmdb_id 是不是编的。和游戏那边的
 * `ProbeLedger` 同一个设计：prompt 已经写了「不要编 id」，但编 id 是
 * 最常见的失手，而编出来的后果是**下次刷新刮到另一部片** ——
 * 海报、简介、季集表全换成别人的，用户得手工全删一遍。
 */
type TmdbLedger = Map<string, { kind: 'movie' | 'tv'; title: string }>

function ledgerKey(kind: 'movie' | 'tv', id: number | string): string {
  return `${kind}:${id}`
}

/* ============================== 工具实现 ============================== */

async function doSearch(
  ctx: VideoToolContext,
  ledger: TmdbLedger,
  counter: { n: number },
  args: any
): Promise<string> {
  if (counter.n >= MAX_TMDB_SEARCHES) {
    return (
      `已经搜了 ${MAX_TMDB_SEARCHES} 次，不要再搜。` +
      '从已经看到的候选里挑一个，或者不填 tmdb_id 直接 register_video —— 留空是可以接受的答案。'
    )
  }
  counter.n++

  const query = str(args?.query, 120)
  if (!query) throw new Error('query 不能为空')

  const rawType = str(args?.type, 10)
  const type = rawType === 'movie' || rawType === 'series' ? rawType : undefined
  const year = int(args?.year)

  const hits = await tmdbSearch(ctx.tmdbConfig, query, {
    type,
    year: year > 1800 ? year : 0
  })

  if (hits.length === 0) {
    return (
      `TMDB 上没搜到「${query}」${year > 0 ? `（${year}）` : ''}。\n` +
      '换个写法再试：去掉副标题、换英文原名、或者去掉年份放宽一点。' +
      '剧集要用剧名搜，不要带季号。\n' +
      '**都搜不到就不填 tmdb_id 直接注册** —— 条目照样能用，用户之后可以自己刮削。'
    )
  }

  for (const h of hits) ledger.set(ledgerKey(h.media_type, h.id), { kind: h.media_type, title: h.title })

  const lines = hits.map((h, i) => {
    const bits = [
      `[${i + 1}] ${h.media_type === 'tv' ? '剧集' : '电影'} id=${h.id}`,
      `${h.title}${h.original_title && h.original_title !== h.title ? `（原名 ${h.original_title}）` : ''}`,
      h.year > 0 ? `${h.year} 年` : '年份未知',
      `评分 ${h.rating || '—'}（${h.votes} 票）`,
      `匹配分 ${h.score}`
    ]
    return `${bits.join('　')}\n    ${h.overview ? h.overview.slice(0, 150) : '(无简介)'}`
  })

  return [
    `「${query}」搜到 ${hits.length} 个候选（按匹配分排序，**分数只是参考不是答案**）：`,
    ...lines,
    '',
    '挑一个之后用 tmdb_detail 取详情。年份吻合比标题相似更值得信；' +
      '都不像就不要硬挑，不填 tmdb_id 直接注册。'
  ].join('\n')
}

async function doFind(ctx: VideoToolContext, ledger: TmdbLedger, args: any): Promise<string> {
  const raw = str(args?.external_id, 40)
  if (!raw) throw new Error('external_id 不能为空')
  const source = raw.toLowerCase().startsWith('tt') ? 'imdb_id' : 'tvdb_id'

  const hits = await tmdbFindByExternalId(ctx.tmdbConfig, source, raw)
  if (hits.length === 0) {
    return (
      `按 ${source === 'imdb_id' ? 'IMDB' : 'TVDB'} id「${raw}」在 TMDB 上反查不到。\n` +
      '这个 id 可能是错的，或者 TMDB 上还没关联。改用 tmdb_search 按名字搜。'
    )
  }

  for (const h of hits) ledger.set(ledgerKey(h.media_type, h.id), { kind: h.media_type, title: h.title })
  const lines = hits.map(
    (h) =>
      `${h.media_type === 'tv' ? '剧集' : '电影'} id=${h.id}　${h.title}　${h.year > 0 ? `${h.year} 年` : ''}`
  )
  return [
    `按 ${raw} 精确反查到 ${hits.length} 条：`,
    ...lines,
    '',
    '这是按 id 精确查到的，**没有猜的成分**。直接用 tmdb_detail 取详情。'
  ].join('\n')
}

/** 详情的可读渲染。这一段会占掉不少上下文，所以只报模型真需要判断的部分 */
function describeDetail(d: TmdbDetail): string {
  const lines = [
    `${d.media_type === 'tv' ? '剧集' : '电影'} id=${d.id}　${d.title}`,
    d.original_title && d.original_title !== d.title ? `原名：${d.original_title}` : '',
    `年份：${d.year || '未知'}${d.end_year > 0 && d.end_year !== d.year ? ` - ${d.end_year}` : ''}`,
    `评分：${d.rating || '—'}（${d.votes} 票）`,
    d.original_language ? `原始语言：${d.original_language}` : '',
    d.countries.length ? `地区：${d.countries.join('、')}` : '',
    d.genres.length ? `类型：${d.genres.join('、')}` : '',
    d.directors.length ? `${d.media_type === 'tv' ? '主创' : '导演'}：${d.directors.join('、')}` : '',
    d.cast.length ? `主演：${d.cast.slice(0, 6).map((c) => c.name).join('、')}` : '',
    d.status ? `状态：${d.status}` : ''
  ].filter(Boolean)

  if (d.seasons.length > 0) {
    const total = d.seasons.reduce((a, s) => a + s.episode_count, 0)
    lines.push(
      `季：${d.seasons.length} 季共 ${total} 集（${d.seasons
        .map((s) => `第${s.season_number}季 ${s.episode_count}集`)
        .join('、')}）`
    )
  }
  if (d.overview) lines.push('', `简介：${d.overview.slice(0, 500)}`)
  lines.push(
    '',
    '确认是这一部就用 register_video 注册，tmdb_id 填 ' + d.id + '。' +
      'description 可以直接用上面这段中文简介（截到 120 字左右）。'
  )
  return lines.join('\n')
}

async function doDetail(ctx: VideoToolContext, ledger: TmdbLedger, args: any): Promise<string> {
  const id = int(args?.tmdb_id)
  if (id <= 0) throw new Error('tmdb_id 必须是正整数')
  const rawKind = str(args?.type, 10)
  const kind: 'movie' | 'tv' = rawKind === 'movie' ? 'movie' : rawKind === 'tv' || rawKind === 'series' ? 'tv' : ctx.facts.video_type === 'series' ? 'tv' : 'movie'

  const detail = await tmdbDetail(ctx.tmdbConfig, kind, id)
  if (!detail) {
    return `TMDB 上取不到 ${kind} id=${id} 的详情。id 可能不对，或者类型选错了（电影 / 剧集用的是两套 id）。`
  }
  ledger.set(ledgerKey(kind, id), { kind, title: detail.title })
  return describeDetail(detail)
}

/* ============================== 注册 ============================== */

/**
 * 从 TMDB 补齐季集表。
 *
 * **只取用户手上有的那些季。** 一部 10 季的美剧全取是 10 次 API 往返，
 * 而用户通常只有一两季 —— 给他补出 9 季全是「缺文件」的空行，
 * 详情页会变成一面灰墙，而他要找的那 16 集埋在里面。
 *
 * 用户手上没有任何集号时（整季包、认不出集号）取第一季，
 * 至少让详情页有个结构。
 */
async function fetchEpisodes(
  ctx: VideoToolContext,
  detail: TmdbDetail
): Promise<{ list: EpisodePayload[]; note: string }> {
  const have = new Map<string, { path: string; file_size: number; duration_sec: number; title: string }>()
  for (const ep of ctx.facts.episodes) {
    have.set(`${ep.season}/${ep.episode}`, {
      path: ep.path,
      file_size: ep.file_size,
      duration_sec: ep.duration_sec,
      title: ep.title
    })
  }

  const wanted = ctx.facts.seasons.length > 0 ? ctx.facts.seasons : [1]
  const available = new Set(detail.seasons.map((s) => s.season_number))
  const targets = wanted.filter((s) => available.has(s)).slice(0, MAX_SEASON_FETCHES)

  const list: EpisodePayload[] = []
  const filled = new Set<string>()
  let fetchedSeasons = 0

  for (const season of targets) {
    let episodes
    try {
      episodes = await tmdbSeasonEpisodes(ctx.tmdbConfig, detail.id, season)
    } catch {
      // 某一季取不到不该让整次注册失败 —— 本地那几集照样要入库
      continue
    }
    if (episodes.length === 0) continue
    fetchedSeasons++
    for (const e of episodes) {
      const key = `${e.season_number}/${e.episode_number}`
      const local = have.get(key)
      filled.add(key)
      list.push({
        season: e.season_number,
        episode: e.episode_number,
        // TMDB 的集标题比文件名里切出来的准，但本地 nfo 写了的话优先本地
        title: local?.title || e.name,
        // 本地没有这一集就留空 path —— 那正是详情页「缺」那一列的来源
        path: local?.path ?? '',
        file_size: local?.file_size ?? 0,
        duration_sec: local?.duration_sec || e.runtime_min * 60,
        air_date: e.air_date_ts
      })
    }
  }

  // 本地有、TMDB 那一季里没有的集要补上：番剧的绝对集号、
  // 用户手里的特别篇、或者 TMDB 还没收录的新集。丢掉它们等于
  // 用户手上明明有文件却在详情页上看不到
  for (const [key, local] of have) {
    if (filled.has(key)) continue
    const [s, e] = key.split('/').map(Number)
    list.push({
      season: s ?? 1,
      episode: e ?? 0,
      title: local.title,
      path: local.path,
      file_size: local.file_size,
      duration_sec: local.duration_sec,
      air_date: 0
    })
  }

  list.sort((a, b) => a.season - b.season || a.episode - b.episode)
  const missing = list.filter((e) => !e.path).length
  const note = fetchedSeasons > 0
    ? `从 TMDB 补齐了 ${fetchedSeasons} 季的集表，共 ${list.length} 集${missing > 0 ? `，其中 ${missing} 集磁盘上没有文件` : ''}`
    : ''
  return { list, note }
}

/** 本地事实里的集列表，TMDB 不可用或没挑条目时用它 */
function localEpisodes(f: VideoFacts): EpisodePayload[] {
  return f.episodes.map((e) => ({
    season: e.season,
    episode: e.episode,
    title: e.title,
    path: e.path,
    file_size: e.file_size,
    duration_sec: e.duration_sec,
    air_date: e.air_date
  }))
}

async function register(
  ctx: VideoToolContext,
  ledger: TmdbLedger,
  args: any
): Promise<string> {
  const f = ctx.facts

  const nameZh = str(args?.name_zh, 120)
  if (!nameZh) throw new Error('name_zh 不能为空')

  let url = str(args?.official_url, 300)
  if (url && !/^https?:\/\//i.test(url)) url = ''

  /* -------- tmdb_id 核对：只收 TMDB 真实返回过的 -------- */
  const claimed = idOf(args?.tmdb_id)
  const wantKind: 'movie' | 'tv' = f.video_type === 'series' ? 'tv' : 'movie'
  let detail: TmdbDetail | null = null
  let rejectedId = ''

  if (claimed) {
    const known = ledger.get(ledgerKey(wantKind, claimed)) ?? ledger.get(ledgerKey(wantKind === 'tv' ? 'movie' : 'tv', claimed))
    if (known) {
      // 取一次详情落库用。ledger 只记了「见过这个 id」，字段还得取
      try {
        detail = await tmdbDetail(ctx.tmdbConfig, known.kind, Number(claimed))
      } catch {
        detail = null
      }
    } else {
      rejectedId = claimed
    }
  }

  /* -------- 集列表 -------- */
  let episodes: EpisodePayload[] = f.video_type === 'series' ? localEpisodes(f) : []
  let episodeNote = ''
  if (detail && f.video_type === 'series' && detail.media_type === 'tv') {
    const fetched = await fetchEpisodes(ctx, detail)
    if (fetched.list.length > 0) {
      episodes = fetched.list
      episodeNote = fetched.note
    }
  }

  /* -------- 拼 payload：本地事实是底，刮削结果补空 -------- */
  // 技术字段一律用本地读到的，**不接受模型填**（参数表里也没有它们）：
  // 那些是确定值，让模型经手只会引入错误
  const payload: VideoPayload = {
    path: f.path,
    video_type: f.video_type,
    name_zh: nameZh,
    name_en: str(args?.name_en, 160) || detail?.original_title || f.title_en,
    summary: str(args?.summary, 80) || '未填写说明',
    description: str(args?.description, 600) || detail?.overview || f.plot,
    category: str(args?.category, 20) || '其他',
    tags: limitVideoTags(args?.tags, new Set(ctx.tagPool)),
    official_url: url || detail?.homepage || '',
    source_dir: f.dir,
    file_size: f.parts.reduce((a, p) => a + p.file_size, 0) ||
      f.episodes.reduce((a, e) => a + e.file_size, 0),

    // 年份：刮削结果压过本地 —— TMDB 的上映年是权威的，
    // 而文件名里的年份可能是发布年
    year: detail?.year || f.year,
    end_year: detail?.end_year ?? 0,
    rating: detail?.rating || f.nfo_rating,
    duration_sec: f.duration_sec || (detail?.runtime_min ?? 0) * 60,
    resolution: f.resolution,
    video_codec: f.video_codec,
    source: f.source,
    release_group: f.release_group,
    audio_tracks: f.audio_tracks,
    subtitle_tracks: f.subtitle_tracks,
    parts: f.parts as VideoPart[],
    // 外挂字幕和 nfo 记成关联文件：用户想知道「这部片旁边都有什么」
    linked_files: [
      ...f.external_subtitles.map((p) => ({ path: p, label: '字幕', type: 'other' as const })),
      ...f.nfo_files.map((p) => ({ path: p, label: 'NFO', type: 'other' as const }))
    ].slice(0, 20),
    tmdb_id: detail ? String(detail.id) : f.tmdb_id,
    imdb_id: detail?.imdb_id || f.imdb_id,
    episodes
  }

  const outcome = insertVideo(ctx.db, payload)
  ctx.onRegister?.({
    name: nameZh,
    path: f.path,
    created: outcome.created,
    episodesAdded: outcome.episodesAdded
  })

  const lines = [
    `${outcome.created ? '已注册' : '已更新'}${f.video_type === 'series' ? '剧集' : '电影'}「${nameZh}」`,
    `分类：${payload.category}　标签：${payload.tags.join('、') || '（无）'}`,
    payload.tmdb_id ? `TMDB id：${payload.tmdb_id}` : 'TMDB id：未填（用户之后可以自己刮削）'
  ]
  if (episodeNote) lines.push(episodeNote)
  if (outcome.episodesAdded > 0) lines.push(`新增 ${outcome.episodesAdded} 集`)
  if (rejectedId) {
    // 回灌而不是静默丢弃：模型下一次调用能看见自己编了什么。
    // 静默丢会让它以为成功了，而下一条继续编
    lines.push(
      `你填的 tmdb_id ${rejectedId} 没有出现在任何一次 TMDB 查询结果里，已被忽略。` +
        '只能填 tmdb_search / tmdb_detail / tmdb_find 真实返回过的 id。'
    )
  }
  lines.push('这个条目处理完了，直接回复一句总结，不要再调用工具。')
  return lines.join('\n')
}

async function skip(ctx: VideoToolContext, args: any): Promise<string> {
  const reason = str(args?.reason, 200) || '未说明原因'
  ctx.onSkip?.(ctx.facts.path, reason)
  return `已记录跳过：${ctx.facts.path}（${reason}）。直接回复一句总结即可，不要再调用工具。`
}

async function webSearch(ctx: VideoToolContext, args: any): Promise<string> {
  const query = str(args?.query, 120)
  if (!query) throw new Error('query 不能为空')
  try {
    return formatHits(query, await search(query, ctx.searchConfig))
  } catch (err) {
    // 搜索挂了不该拖垮识别，让 agent 退回本地信息继续判断
    return `搜索「${query}」失败：${err instanceof Error ? err.message : String(err)}。请依据已知事实判断。`
  }
}

/* ============================== 工具定义 ============================== */

export function buildVideoTools(
  ctx: VideoToolContext,
  categoryNames: string[],
  withSearch: boolean,
  withTmdb: boolean
): AgentTool[] {
  // 每个条目一份新账本和新计数：模型不能靠上一部片查过的 id 蒙混过关
  const ledger: TmdbLedger = new Map()
  const searchCounter = { n: 0 }

  const tools: AgentTool[] = []

  if (withTmdb) {
    tools.push(
      {
        name: 'tmdb_search',
        description:
          '按名字搜 TMDB，返回候选条目（带 id、年份、评分、简介和匹配分）。' +
          '中文片优先用中文名搜 —— TMDB 有完整的中文数据。' +
          '剧集用剧名搜，不要带季号。已知事实里已经有 TMDB / IMDB id 时不要用这个，直接取详情。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '片名。中文片用中文名，日本作品可以试原名' },
            type: {
              type: 'string',
              enum: ['movie', 'series'],
              description: '限定电影还是剧集。已知事实里的形态就填那个，能显著提高准确率'
            },
            year: {
              type: 'number',
              description: '年份。同名片子太多，带上年份是分开它们最有效的一刀。不知道就不填'
            }
          },
          required: ['query']
        },
        execute: (args) => doSearch(ctx, ledger, searchCounter, args)
      },
      {
        name: 'tmdb_detail',
        description:
          '按 TMDB id 取详情：完整简介、评分、导演演员、地区类型，剧集还有季集结构。' +
          '挑定候选之后调它确认，然后再 register_video。',
        parameters: {
          type: 'object',
          properties: {
            tmdb_id: { type: 'number', description: 'TMDB 条目 id，必须是查询结果里真实出现过的' },
            type: {
              type: 'string',
              enum: ['movie', 'tv'],
              description: '这个 id 是电影还是剧集的。两者是两套独立的 id 空间，填错会取不到'
            }
          },
          required: ['tmdb_id', 'type']
        },
        execute: (args) => doDetail(ctx, ledger, args)
      },
      {
        name: 'tmdb_find',
        description:
          '按 IMDB id（tt 开头）或 TVDB id 在 TMDB 上精确反查。' +
          '已知事实里带了这类 id 时**先用这个** —— 它是精确查询，没有猜的成分，比搜索准。',
        parameters: {
          type: 'object',
          properties: {
            external_id: { type: 'string', description: 'IMDB id（如 tt0111161）或 TVDB id' }
          },
          required: ['external_id']
        },
        execute: (args) => doFind(ctx, ledger, args)
      }
    )
  }

  tools.push(
    {
      name: 'register_video',
      description:
        '把识别结果注册成一个条目。一个条目调用一次。' +
        '技术信息（分辨率、编码、时长、音轨）系统已经从本地读好了，不用也不能在这里填。',
      parameters: {
        type: 'object',
        properties: {
          name_zh: {
            type: 'string',
            description: '通行中文译名，不带书名号。没有通行译名就填原名，不要自己造译名'
          },
          name_en: { type: 'string', description: '官方原名/英文名，保持官方大小写和空格' },
          summary: { type: 'string', description: '一句话说明，15-25 字' },
          description: {
            type: 'string',
            description: '中文简介，50-120 字。TMDB 的中文简介可以直接用，太长就截断'
          },
          category: {
            type: 'string',
            description: `按地区和形态分类，只能从以下选择：${categoryNames.join('、')}`,
            enum: categoryNames
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: ctx.tagPool.length
              ? `1-3 个标签，写题材和气质，不要写分辨率/编码/片源/人名。优先从现有标签池里选：${ctx.tagPool.join('、')}。确实都不合适时最多新增 2 个。`
              : '1-3 个标签，写题材和气质（悬疑、武侠、公路、合家欢…），不要写分辨率、编码、片源或人名。'
          },
          tmdb_id: {
            type: 'number',
            description:
              'TMDB 条目 id。**必须是 tmdb_search / tmdb_detail / tmdb_find 真实返回过的**，' +
              '编的会被丢弃。一个都没挑中就不填 —— 留空是可以接受的答案。'
          },
          official_url: { type: 'string', description: '官网或条目页地址，不确定就传空字符串' }
        },
        required: ['name_zh', 'summary', 'category']
      },
      execute: (args) => register(ctx, ledger, args)
    },
    {
      name: 'skip_entry',
      description:
        '判断这不是影视作品（教学录屏、会议录像、监控、家庭视频、游戏实况、漏进来的预告片等），跳过并记录原因。',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: '跳过原因，一句话' } },
        required: ['reason']
      },
      execute: (args) => skip(ctx, args)
    }
  )

  if (withSearch) {
    tools.push({
      name: 'web_search',
      description:
        '搜索互联网了解这是什么作品。最后手段：先看已知事实，再搜 TMDB，都认不出来时才用它。' +
        '常见的片子（流浪地球、进击的巨人）不要浪费额度。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，建议「片名 + 电影」或「片名 + 电视剧」，优先中文' }
        },
        required: ['query']
      },
      execute: (args) => webSearch(ctx, args)
    })
  }

  return tools
}
