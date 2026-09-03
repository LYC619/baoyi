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
 *
 * ## 两本账
 *
 * `TmdbLedger` 和 `DoubanLedger`：模型填的 id 只有在**这次识别里真的被查询
 * 返回过**才收。编 id 是最常见的失手，而后果是下次刷新刮到另一部作品 ——
 * 海报、简介、季集表全换成别人的。豆瓣那本还多担一件事：**评分从账本取，
 * 不进参数表**，模型没有任何理由知道豆瓣给某部片打了几分。
 *
 * ## 三个搜索上限
 *
 * TMDB 4 次（用户自己的免费 key），豆瓣 2 次、web_search 3 次
 *（按次计费的钱）。三个数在 prompt 里也写了一遍 —— 那边负责说，这边负责执行。
 */

import type { AgentTool } from '../../services/agent/loop.ts'
import type { SqlDb } from '../../services/schema.ts'
import type { SearchConfig, TmdbConfig, VideoPart } from '../../../src/types'
import { formatHits, search, searchCached } from '../../services/searchService.ts'
import { insertVideo, type EpisodePayload, type VideoPayload } from './db.ts'
import { doubanLookup, doubanQuery, doubanUrl, type DoubanCandidate } from './douban.ts'
import type { EpisodeFacts, VideoFacts } from './facts.ts'
import {
  tmdbDetail,
  tmdbFindByExternalId,
  tmdbSearch,
  tmdbSeasonEpisodes,
  type TmdbDetail
} from './tmdb.ts'
import {
  MAX_HANIME_FETCHES,
  hanimeDetail,
  hanimeSearch,
  newBudget,
  type HanimeBudget
} from './hentai/hanime.ts'
import { watchUrl, type HanimeDetail, type HanimeHit } from './hentai/selectors.ts'

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

/**
 * 一个条目最多用几次**用户的搜索服务商**。豆瓣和 web_search 各自一个数，
 * 但它们烧的是**同一份额度** —— 走的是同一个 `searchService`。
 *
 * TMDB 那个上限（4 次）是防着模型绕圈子，代价只是用户自己的免费 key；
 * 这两个上限管的是**按次计费的钱**。Tavily / Exa 这类服务商按检索次数收，
 * 一次扫描过 200 个条目，每个条目多搜一次就是 200 次。所以这里给得比 TMDB 紧。
 *
 * 豆瓣给 2 次：第一次带年份，认不出来再来一次不带年份的。第三次不会有新信息 ——
 * 同一个服务商同一批索引，换个词序不会变出一个新条目页。
 *
 * `web_search` 之前**没有上限**，是这次补的。它在 prompt 里被写成「最后手段」，
 * 但那只是说了一句；模型认不出一部冷门片时会反复换词搜，而每一次都在计费。
 */
const MAX_DOUBAN_SEARCHES = 2
const MAX_WEB_SEARCHES = 3

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
  /**
   * 每次真的走了一趟用户的搜索服务商就叫一下（豆瓣和 web_search 都算）。
   *
   * 报给用户用来对账 —— 按次计费的服务商，这个数就是这次扫描的账单。
   * 只在**请求真的发出去**时叫：撞上限被挡回的那次不算，不然报出来的数
   * 比实际扣的钱多，对账就成了制造疑惑。
   */
  onSearch?: () => void
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

/* ============================== 豆瓣账本 ============================== */

/**
 * 这次识别里，豆瓣查询真实返回过的条目，按 subject id 索引。
 *
 * 和 `TmdbLedger` 同一个设计，但**多担一件事**：`register_video` 不光拿它核对
 * id 真假，还从它身上取评分。评分**不进参数表** —— 模型没有任何理由知道
 * 豆瓣给某部片打了几分，让它填就是请它编一个。那个数会被当成真评分显示，
 * 而用户没法从界面上看出它是编的。
 *
 * 所以这条路上模型只做一件事：**从候选里挑一个 id**。剩下的都从账本里取。
 */
type DoubanLedger = Map<string, DoubanCandidate>

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
  const have = new Map<string, EpisodeFacts>()
  for (const ep of ctx.facts.episodes) have.set(`${ep.season}/${ep.episode}`, ep)

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
        air_date: e.air_date_ts,
        ...watchOf(local)
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
      // 这一支是「TMDB 没收录」，air_date 用本地 nfo 的而不是硬写 0
      air_date: local.air_date,
      ...watchOf(local)
    })
  }

  list.sort((a, b) => a.season - b.season || a.episode - b.episode)
  const missing = list.filter((e) => !e.path).length
  const note = fetchedSeasons > 0
    ? `从 TMDB 补齐了 ${fetchedSeasons} 季的集表，共 ${list.length} 集${missing > 0 ? `，其中 ${missing} 集磁盘上没有文件` : ''}`
    : ''
  return { list, note }
}

/**
 * 别家 nfo 记的观看状态，摊平成 payload 上那三个可选字段。
 *
 * 没有痕迹时给空对象而不是 `watch_status: 'unwatched'` —— 展开进 payload 里
 * 就是「这三个键不存在」，`upsertEpisodes` 那边落到列默认值上。
 * 显式写 unwatched 也是同一个结果，但那等于宣称「nfo 说他没看过」，
 * 而事实是 nfo 什么都没说。见 `EpisodeFacts.watch` 的注释。
 */
function watchOf(e: EpisodeFacts | undefined): Partial<EpisodePayload> {
  if (!e?.watch) return {}
  return {
    watch_status: e.watch.watch_status,
    position_sec: e.watch.position_sec,
    watched_at: e.watch.watched_at
  }
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
    air_date: e.air_date,
    ...watchOf(e)
  }))
}

async function register(
  ctx: VideoToolContext,
  ledger: TmdbLedger,
  doubanLedger: DoubanLedger,
  hanimeLedger: HanimeLedger,
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

  let wrongKindId = ''

  if (claimed) {
    // **只认同一形态的 id。** 电影和剧集是两套独立的 id 空间，同一个数字
    // 在两边指的是两部不同的作品。之前这里会退回另一个形态去找 ——
    // 那等于「只要这个数字在哪儿见过就算」：本地是一部剧、模型给的是一个
    // 电影 id，fetchEpisodes 会正确地跳过（media_type 不是 tv），
    // 但年份、评分、简介、imdb_id 全从那部电影抄了过来，而那个电影 id
    // 还被写进 tmdb_id。下次刷新就照着它刮，整条记录换成另一部作品 ——
    // 账本本来就是为了挡这件事的
    const known = ledger.get(ledgerKey(wantKind, claimed))
    if (known) {
      // 取一次详情落库用。ledger 只记了「见过这个 id」，字段还得取
      try {
        detail = await tmdbDetail(ctx.tmdbConfig, known.kind, Number(claimed))
      } catch {
        detail = null
      }
    } else if (ledger.has(ledgerKey(wantKind === 'tv' ? 'movie' : 'tv', claimed))) {
      // id 是真的，但查的是另一个形态。这和「编 id」是两种错，
      // 回灌的话也得说两句不一样的 —— 不然模型不知道该改什么
      wrongKindId = claimed
    } else {
      rejectedId = claimed
    }
  }

  /* -------- douban_id 核对：只收豆瓣查询真实返回过的 -------- */
  // 评分从账本取，**不从参数取**。理由见 DoubanLedger 的注释
  const claimedDouban = idOf(args?.douban_id)
  let douban: DoubanCandidate | null = null
  let rejectedDouban = ''
  if (claimedDouban) {
    douban = doubanLedger.get(claimedDouban) ?? null
    if (!douban) rejectedDouban = claimedDouban
  }

  /* -------- hanime_id 核对：只收这次真的查过的 -------- */
  // 编一个出来的后果是详情页上一个指向别的作品的链接，而用户没法判断它是错的：
  // 点进去看到另一部片，只会以为是站方改了内容
  const claimedHanime = idOf(args?.hanime_id)
  let hanimeId = ''
  let rejectedHanime = ''
  /**
   * 封面地址**从账本取，不从参数取** —— 和豆瓣评分一个道理（见 DoubanLedger）。
   *
   * 让模型填一个 URL 的话，它会「记得」一个看起来像的地址然后编出来，而编错的
   * 后果是一张别的作品的封面挂在这条上，用户没法判断它是错的。账本里的那个
   * 是我们自己从页面上解出来的，没有第二个来源。
   *
   * 顺带省掉一个工具参数：`register_video` 的参数表不用为它长一栏。
   */
  let hanimeCover = ''
  if (claimedHanime) {
    const hit = hanimeLedger.get(claimedHanime)
    if (hit) {
      hanimeId = claimedHanime
      hanimeCover = hit.coverUrl ?? ''
    } else {
      rejectedHanime = claimedHanime
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
    // 官网都没有时退到豆瓣条目页：对中文用户来说，那个页面比一个 404 的
    // 官方站有用得多 —— 演职员、短评、同类推荐都在那儿
    // 里番排在豆瓣后面：豆瓣上没有这类作品，所以有 hanime_id 的时候
    // 前两个来源基本都是空的，顺序不产生冲突
    official_url: url || detail?.homepage || doubanUrl(douban?.id ?? '') || watchUrl(hanimeId),
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
    douban_id: douban?.id ?? '',
    douban_rating: douban?.rating ?? 0,
    hanime_id: hanimeId,
    // 相对路径，不是本地文件。下载是 Step 6 的活，但这两个值在这次刮削的
    // 详情响应里白拿 —— 不存的话 Step 6 得为每个条目把详情重取一遍
    //
    // 里番走 hanime 的封面（一个完整的 https 地址，见 posters.ts 的
    // isRemotePoster）。TMDB 那份排在前面：两个都有的时候前者是竖版海报，
    // 而 hanime 给的是横版缩略图。实际上两者几乎不会同时出现 ——
    // 走了 hanime 通道就不查 TMDB
    poster_path: detail?.poster_path || hanimeCover,
    fanart_path: detail?.backdrop_path ?? '',
    episodes,
    // 电影从 nfo 带过来的观看状态。只在新建时生效，剧集恒为 null，
    // 两条都在 db.ts 里把着，见 VideoPayload 上那一组字段
    ...(f.watch
      ? {
          watch_status: f.watch.watch_status,
          position_sec: f.watch.position_sec,
          last_watched_at: f.watch.watched_at
        }
      : {})
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
  if (douban) {
    lines.push(
      `豆瓣：${douban.id}${douban.rating > 0 ? `　评分 ${douban.rating}` : '　评分未取到'}`
    )
  }
  if (episodeNote) lines.push(episodeNote)
  if (outcome.episodesAdded > 0) lines.push(`新增 ${outcome.episodesAdded} 集`)
  if (wrongKindId) {
    lines.push(
      `你填的 tmdb_id ${wrongKindId} 是一个${wantKind === 'tv' ? '电影' : '剧集'} id，` +
        `而这个条目是${wantKind === 'tv' ? '剧集' : '电影'}，已被忽略 —— ` +
        '电影和剧集在 TMDB 上是两套独立的 id。' +
        `要补的话用 tmdb_search 带上 type=${wantKind === 'tv' ? 'series' : 'movie'} 重搜。`
    )
  }
  if (rejectedDouban) {
    lines.push(
      `你填的 douban_id ${rejectedDouban} 没有出现在任何一次豆瓣查询结果里，已被忽略。` +
        '只能填 douban_search 真实返回过的 id。'
    )
  }
  if (rejectedHanime) {
    lines.push(
      `你填的 hanime_id ${rejectedHanime} 没有出现在任何一次 hanime 查询结果里，已被忽略。` +
        '只能填 hanime_search / hanime_detail 真实返回过的 id。'
    )
  }
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

async function webSearch(
  ctx: VideoToolContext,
  counter: { n: number },
  args: any
): Promise<string> {
  const query = str(args?.query, 120)
  if (!query) throw new Error('query 不能为空')

  if (counter.n >= MAX_WEB_SEARCHES) {
    return (
      `这个条目已经联网搜了 ${MAX_WEB_SEARCHES} 次，不要再搜 —— 搜索按次计费。\n` +
      '就按现在手上的信息 register_video，认不出来就 skip_entry。'
    )
  }

  try {
    // 缓存命中不算一次账：真实请求没发出去，服务商那边也没扣
    const billed = !searchCached(query, ctx.searchConfig)
    const hits = await search(query, ctx.searchConfig)
    if (billed) {
      counter.n++
      ctx.onSearch?.()
    }
    return formatHits(query, hits)
  } catch (err) {
    // 搜索挂了不该拖垮识别，让 agent 退回本地信息继续判断。
    // 也不计数：请求失败了，但服务商那边可能已经扣了 —— 这里宁愿少算，
    // 因为多算会让用户拿着一个比账单大的数去质疑服务商
    return `搜索「${query}」失败：${err instanceof Error ? err.message : String(err)}。请依据已知事实判断。`
  }
}

/* ============================== 豆瓣 ============================== */

/** 候选的可读渲染。评分那一栏刻意写「豆瓣 x.x」，让模型知道这个分不是 TMDB 的 */
function describeDoubanCandidates(list: DoubanCandidate[]): string[] {
  return list.map((c, i) => {
    const bits = [
      `[${i + 1}] id=${c.id}`,
      c.title,
      c.year > 0 ? `${c.year} 年` : '年份未知',
      c.rating > 0 ? `豆瓣 ${c.rating}` : '评分未取到'
    ]
    return `${bits.join('　')}\n    ${c.url}`
  })
}

async function doDouban(
  ctx: VideoToolContext,
  ledger: DoubanLedger,
  counter: { n: number },
  args: any
): Promise<string> {
  if (counter.n >= MAX_DOUBAN_SEARCHES) {
    return (
      `豆瓣已经查了 ${MAX_DOUBAN_SEARCHES} 次，不要再查。` +
      '没匹配上就不填 douban_id 直接 register_video —— 留空是可以接受的答案。'
    )
  }

  const title = str(args?.title, 120)
  if (!title) throw new Error('title 不能为空')
  const rawYear = int(args?.year)
  const year = rawYear > 1800 ? rawYear : 0

  const q = doubanQuery(title, year)
  const billed = !searchCached(q, ctx.searchConfig)

  let list: DoubanCandidate[]
  try {
    list = await doubanLookup(ctx.searchConfig, title, year)
  } catch (err) {
    // 同 webSearch：查不到不该拖垮识别，也不计数
    return (
      `查豆瓣「${title}」失败：${err instanceof Error ? err.message : String(err)}。\n` +
      '跳过豆瓣，直接按已知事实 register_video，不填 douban_id。'
    )
  }

  if (billed) {
    counter.n++
    ctx.onSearch?.()
  }

  if (list.length === 0) {
    return (
      `豆瓣上没找到「${title}」${year > 0 ? `（${year}）` : ''}的条目页。\n` +
      (counter.n < MAX_DOUBAN_SEARCHES
        ? '可以再试一次：去掉年份、去掉副标题、或者换中文译名。'
        : '不要再查了。') +
      '\n**豆瓣是可选的补充** —— 没有它条目照样完整，不填 douban_id 直接注册。'
    )
  }

  for (const c of list) ledger.set(c.id, c)

  return [
    `豆瓣候选 ${list.length} 条（按匹配分排序，**分数只是参考不是答案**）：`,
    ...describeDoubanCandidates(list),
    '',
    '确认是哪一条就把它的 id 填进 register_video 的 douban_id。' +
      '**评分不用你填**，系统按 id 从上面这份结果里取。' +
      '一条都不像就不填 —— 错的豆瓣链接比没有链接更糟。'
  ].join('\n')
}

/* ============================== hanime ============================== */

/**
 * 这次识别里 hanime 查过的候选，按 videoCode 记。
 *
 * 和 `TmdbLedger` / `DoubanLedger` 同一个用途：`register_video` 只收
 * **真的查过**的 id。模型编一个 videoCode 出来的后果是详情页上一个
 * 指向别的作品的链接，而用户没法判断它是错的 —— 他点进去看到另一部片，
 * 只会以为是站方改了内容。
 */
type HanimeLedger = Map<string, HanimeHit | HanimeDetail>

function describeHanimeHits(list: HanimeHit[]): string[] {
  return list.map((h, i) => {
    const mins = h.durationSec > 0 ? `${Math.round(h.durationSec / 60)} 分钟` : '时长未知'
    return `${i + 1}. ${h.title}　[id ${h.videoCode}]　${mins}\n    ${watchUrl(h.videoCode)}`
  })
}

/**
 * 这两个函数不收 `ctx`：hanime 没有 key 要配、不走用户的搜索服务商，
 * 所以既不需要读配置也不需要报账（`ctx.onSearch` 是给按次计费的服务商用的）。
 * 加一个用不上的参数只会让人以为这条通道也在花用户的钱。
 */
async function doHanimeSearch(
  ledger: HanimeLedger,
  budget: HanimeBudget,
  args: any
): Promise<string> {
  const query = str(args?.query, 120)
  if (!query) throw new Error('query 不能为空')

  let list: HanimeHit[]
  try {
    list = await hanimeSearch(query, budget, { limit: 10 })
  } catch (err) {
    // 取页失败不该拖垮识别。这里把原文带出去 —— hanime.ts 已经把
    // 「挑战页」「403/503」「预算用完」分成了三句不同的话，
    // 而这三种的下一步动作完全不同（换网络 / 等一会儿 / 别再搜了）
    return (
      `搜 hanime「${query}」失败：${err instanceof Error ? err.message : String(err)}\n` +
      '不要重复同一次搜索。按已知事实 register_video，不填 hanime_id。'
    )
  }

  if (list.length === 0) {
    return (
      `hanime 上没搜到「${query}」。\n` +
      '可以换一次：去掉集号和方括号里的标记，只用作品名；或者试日文原名。\n' +
      '**这条通道是可选的** —— 搜不到就按已知事实 register_video，不填 hanime_id。'
    )
  }

  for (const h of list) ledger.set(h.videoCode, h)

  return [
    `hanime 候选 ${list.length} 条（站方顺序，**不是匹配度排序**）：`,
    ...describeHanimeHits(list),
    '',
    '确认是哪一条就用它的 id 调 hanime_detail 取标签和简介，' +
      '然后把 id 填进 register_video 的 hanime_id。' +
      '一条都不像就不填 —— 错的链接比没有链接更糟。'
  ].join('\n')
}

async function doHanimeDetail(
  ledger: HanimeLedger,
  budget: HanimeBudget,
  args: any
): Promise<string> {
  const id = idOf(args?.hanime_id)
  if (!id) throw new Error('hanime_id 得是站上那串纯数字')

  let detail: HanimeDetail | null
  try {
    detail = await hanimeDetail(id, budget)
  } catch (err) {
    return (
      `取 hanime 详情（id ${id}）失败：${err instanceof Error ? err.message : String(err)}\n` +
      '按已知事实 register_video，不填 hanime_id。'
    )
  }

  if (!detail || (!detail.title && detail.tags.length === 0)) {
    return (
      `id ${id} 那个页面解析不出内容。可能是 id 不对，也可能是站方改版了。\n` +
      '不填 hanime_id 直接 register_video。'
    )
  }

  ledger.set(detail.videoCode || id, detail)

  const bits = [
    `hanime 详情（id ${detail.videoCode || id}）：`,
    `标题：${detail.title || '（没解出来）'}`,
    detail.chineseTitle ? `中文名：${detail.chineseTitle}` : '',
    detail.artist ? `厂牌 / 作者：${detail.artist}` : '',
    detail.tags.length > 0 ? `站方标签：${detail.tags.join('、')}` : '站方标签：（没解出来）',
    detail.introduction ? `简介：${detail.introduction.slice(0, 600)}` : '',
    detail.seriesName ? `系列：${detail.seriesName}` : '',
    detail.episodes.length > 0
      ? `同系列 ${detail.episodes.length} 集：${detail.episodes.map((e) => e.title || e.videoCode).join('、')}`
      : ''
  ].filter(Boolean)

  return [
    ...bits,
    '',
    '**站方标签可以直接用**，它们是这个站自己的分类词，比你造的词准。' +
      '但仍旧受标签规则约束：优先用标签池里已有的，新增最多 2 个。',
    detail.episodes.length > 1
      ? '**同系列的集不要合并成一条**。你只负责手上这一个文件对应的那一集 —— ' +
        '别的集是别的文件，它们会各自走一次识别。'
      : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/* ============================== 工具定义 ============================== */

export function buildVideoTools(
  ctx: VideoToolContext,
  categoryNames: string[],
  withSearch: boolean,
  withTmdb: boolean,
  withHanime = false
): AgentTool[] {
  // 每个条目一份新账本和新计数：模型不能靠上一部片查过的 id 蒙混过关
  const ledger: TmdbLedger = new Map()
  const doubanLedger: DoubanLedger = new Map()
  const hanimeLedger: HanimeLedger = new Map()
  // hanime 的预算不按「次数」记在 counter 上而是一个 budget 对象：
  // 搜索和详情共用同一份上限，因为限制它们的是同一件事（别被盾盯上），
  // 不是两份不同的额度
  const hanimeBudget = newBudget()
  const searchCounter = { n: 0 }
  // 豆瓣和 web_search 各自计数，但两个都是用户的搜索额度。分开数是因为
  // 两个上限不同用途也不同，报给用户的那个数在 ctx.onSearch 上汇总
  const doubanCounter = { n: 0 }
  const webCounter = { n: 0 }

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
          official_url: { type: 'string', description: '官网或条目页地址，不确定就传空字符串' },
          ...(withSearch
            ? {
                douban_id: {
                  type: 'number',
                  description:
                    '豆瓣条目 id。**必须是 douban_search 真实返回过的**，编的会被丢弃。' +
                    '没查豆瓣或者没匹配上就不填。豆瓣评分不用你填，系统按这个 id 自己取。'
                }
              }
            : {}),
          // 关掉这条通道时这个字段也跟着消失：没有 hanime_search 就没有合法来源，
          // 留着只会被编出来。和 douban_id 同一个处理
          ...(withHanime
            ? {
                hanime_id: {
                  type: 'number',
                  description:
                    'hanime 的 id。**必须是 hanime_search / hanime_detail 真实返回过的**，' +
                    '编的会被丢弃。没搜到或者不像就不填。'
                }
              }
            : {})
        },
        required: ['name_zh', 'summary', 'category']
      },
      execute: (args) => register(ctx, ledger, doubanLedger, hanimeLedger, args)
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

  // 里番通道。挂载条件不是「用户配了什么」而是「这一条看起来是不是里番」——
  // hanime 是免费公开页面，没有 key 要配，所以没有可用性可判
  if (withHanime) {
    tools.push(
      {
        name: 'hanime_search',
        description:
          `按作品名搜 hanime1.me，返回候选（带 id、标题、时长）。**里番专用通道** —— ` +
          `搜索和取详情合起来最多 ${MAX_HANIME_FETCHES} 次。` + +
          'TMDB 和豆瓣上没有这类作品，所以对里番这是唯一能拿到数据的地方。' +
          '用**作品名**搜，不要带集号（＃2 / ROUND1）和方括号里的标记（[中文字幕]）—— ' +
          '那些不是名字的一部分，带上会搜不到。日文原名比中文译名准，站上的标题多数是日文。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '作品名。去掉集号和标记，日文原名优先'
            }
          },
          required: ['query']
        },
        execute: (args) => doHanimeSearch(hanimeLedger, hanimeBudget, args)
      },
      {
        name: 'hanime_detail',
        description:
          '按 hanime id 取详情：站方标签、简介、中文名、厂牌、同系列的集。' +
          '先用 hanime_search 确定是哪一条，再用它的 id 调这个。' +
          '站方标签是这个站自己的分类词，比你自己造的准。',
        parameters: {
          type: 'object',
          properties: {
            hanime_id: {
              type: 'number',
              description: 'hanime_search 返回的那串纯数字 id'
            }
          },
          required: ['hanime_id']
        },
        execute: (args) => doHanimeDetail(hanimeLedger, hanimeBudget, args)
      }
    )
  }

  if (withSearch) {
    tools.push(
      {
        name: 'douban_search',
        description:
          '查豆瓣条目页，拿豆瓣评分、中文译名和条目链接。' +
          '**这是补充，不是识别手段** —— 先用已知事实和 TMDB 确定这是哪一部，再用中文名来查它。' +
          '中文语境下豆瓣评分比 TMDB 评分更贴用户的判断，所以值得查；' +
          '但查不到完全没关系，条目照样完整。' +
          '剧集可以按「剧名 第二季」查 —— 豆瓣的分季是独立条目，各有各的评分，匹配到分季更准。',
        parameters: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: '片名，**优先中文译名** —— 豆瓣是中文站，用英文原名往往搜不到条目页'
            },
            year: {
              type: 'number',
              description: '年份。同名片子靠它分开，知道就填'
            }
          },
          required: ['title']
        },
        execute: (args) => doDouban(ctx, doubanLedger, doubanCounter, args)
      },
      {
        name: 'web_search',
        description:
          '搜索互联网了解这是什么作品。最后手段：先看已知事实，再搜 TMDB，都认不出来时才用它。' +
          '常见的片子（流浪地球、进击的巨人）不要浪费额度。' +
          '想拿豆瓣评分用 douban_search，不要用这个自己拼 site: 查询。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词，建议「片名 + 电影」或「片名 + 电视剧」，优先中文' }
          },
          required: ['query']
        },
        execute: (args) => webSearch(ctx, webCounter, args)
      }
    )
  }

  return tools
}
