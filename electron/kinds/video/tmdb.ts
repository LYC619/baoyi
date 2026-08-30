/**
 * TMDB 刮削客户端。
 *
 * 这一步在链路上的位置：文件名解析 + nfo + 容器元数据把**本地事实**凑齐之后，
 * 还缺的是「这部片在世界上是哪一部」—— 官方译名、简介、评分、演员、
 * 以及剧集那张完整的季集表（用户手上只有 8 个文件，TMDB 说这季 16 集，
 * 缺的那 8 集要露面）。这些东西本地读不到，只能联网。
 *
 * ## 为什么是 TMDB 而不是让 agent 联网搜
 *
 * 因为 TMDB 回的是**结构化条目**：一个 id、一个季集表、一个日期。搜索引擎回的是
 * 网页摘要，模型得从里面读出年份和集数 —— 那是把一件确定性的事交给概率。
 * 而且有了 tmdb_id，重新刮削是一次精确查询而不是重新搜一遍。
 *
 * v0.6 那条最贵的教训（能确定性拿到的事实不该让模型去猜）在这儿的延伸是：
 * **agent 不负责查数据，负责选。** 它判断「这几个搜索结果里哪个是用户手上这部」，
 * 那才是真需要判断力的事。
 *
 * ## 这个文件为什么拆成两半
 *
 * 同 `mediainfo.ts`：`scoreCandidate` / `normTitle` / `mapMovie` / `mapTv` 是纯函数，
 * 自检拿固定 fixture 验；`tmdbSearch` / `tmdbDetail` 才碰网络。
 * 真正容易错的是**匹配和映射规则**，不是能不能发出 HTTP 请求。
 *
 * ## 用户自带 key
 *
 * 不内置共享 key：违反 TMDB 服务条款，而且额度被打爆的那天所有用户一起失效。
 * 个人 key 免费，注册就有。域名可覆盖是因为 `api.themoviedb.org` 在国内多数
 * 网络下连不上，而这是个中文用户为主的工具 —— 没有这个覆盖，刮削对一大半
 * 用户直接不可用。
 *
 * 规格来源是 MoviePilot 的 `app/modules/themoviedb/`（GPL，**只当规格读，
 * 没抄代码**）：搜索端点的参数形状、`year` 对电影 / `first_air_date_year`
 * 对剧集的区别、以及「去标点 + 全大写 + 精确比」这条匹配惯例。
 */

import type { TmdbConfig } from '../../../src/types'

/* ============================== 输出形状 ============================== */

/** 一个搜索候选。给 agent 挑的那份清单就是这个 */
export interface TmdbCandidate {
  id: number
  media_type: 'movie' | 'tv'
  /** 当前语言（zh-CN）下的标题。TMDB 没有中文条目时它会退回原名 */
  title: string
  /** 原始语言的标题 */
  original_title: string
  /** 上映 / 首播年份。0 = TMDB 上也没有 */
  year: number
  overview: string
  /** 十分制 */
  rating: number
  votes: number
  /** 海报的相对路径（`/abc.jpg`），拼完整地址走 posterUrl */
  poster_path: string
  /** 原始语言代码（`zh` / `en` / `ja`），分类判断用得上 */
  original_language: string
  /** 匹配打分，由 scoreCandidate 现算，不是 TMDB 给的 */
  score: number
}

/** 一季的信息。剧集详情里带出来 */
export interface TmdbSeason {
  season_number: number
  name: string
  episode_count: number
  air_date: string
}

/** 一集。季详情里带出来 */
export interface TmdbEpisode {
  season_number: number
  episode_number: number
  name: string
  overview: string
  /** 首播日期的 Unix 秒。0 = 没写 */
  air_date_ts: number
  runtime_min: number
}

/** 详情。电影和剧集用同一个形状 —— 差别只在几个字段有没有值 */
export interface TmdbDetail {
  id: number
  media_type: 'movie' | 'tv'
  title: string
  original_title: string
  overview: string
  tagline: string
  year: number
  /** 剧集完结年份。0 = 电影，或者还在播 */
  end_year: number
  rating: number
  votes: number
  runtime_min: number
  genres: string[]
  countries: string[]
  studios: string[]
  directors: string[]
  writers: string[]
  /** 演员，按 TMDB 的 order 排好，最多前 15 个 */
  cast: Array<{ name: string; role: string }>
  poster_path: string
  backdrop_path: string
  imdb_id: string
  original_language: string
  /** 剧集状态（`Returning Series` / `Ended`）。电影是空串 */
  status: string
  /** 剧集的季列表。电影是空数组 */
  seasons: TmdbSeason[]
  /** 官方主页 */
  homepage: string
}

/* ============================== 纯逻辑 ============================== */

const DEFAULT_API_DOMAIN = 'api.themoviedb.org'
const DEFAULT_IMAGE_DOMAIN = 'image.tmdb.org'

/**
 * 用户填的域名归一。
 *
 * 用户会粘各种东西进来：带 `https://`、带尾斜杠、带 `/3`。全切掉只留主机名，
 * 因为拼地址时 `/3/search/movie` 是我们自己加的 —— 不切的话会拼出
 * `https://https://x.com/3/3/search/movie` 这种，而报错信息里只会说「连接失败」。
 */
export function normDomain(raw: string, fallback: string): string {
  const s = String(raw ?? '').trim()
  if (!s) return fallback
  return (
    s
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')
      .replace(/\/3$/, '')
      .split('/')[0] || fallback
  )
}

/** 这份配置能不能用来刮削 */
export function tmdbAvailable(cfg: TmdbConfig): boolean {
  return Boolean(cfg?.enabled && cfg.api_key?.trim())
}

/**
 * 标题归一，用于比较。**去标点 + 折叠空白 + 大写**。
 *
 * 惯例来自 MoviePilot 的 `__compare_names`。理由是同一部片在不同来源里的
 * 标点几乎从不一致：`蜘蛛侠：英雄无归` / `蜘蛛侠:英雄无归` /
 * `Spider-Man: No Way Home` / `Spider Man No Way Home`。
 * 不归一的话精确比对基本永远不命中，而模糊比对会把《教父》和《教父2》算成一个。
 *
 * CJK 不受影响：这里只删标点，不动字。
 */
export function normTitle(raw: string): string {
  return String(raw ?? '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, '')
    .toUpperCase()
}

/**
 * 给一个候选打分，用来排序。**不做自动取舍。**
 *
 * 分数只决定「哪个排在前面给 agent 看」，不决定「就是它」。这条界线是有意的：
 * 一个中文片库里，本地标题常常是发布组写的简称或别名，而 TMDB 上是官方译名，
 * 两个字都不一样却是同一部片 —— 这种情况下分数低但答案对。让分数替 agent
 * 做决定会在这里静默出错，而错了的表现是「刮到另一部片的简介和海报」。
 *
 * 打分构成，从硬到软：
 * - 标题归一后完全相等：+100（这是唯一强到接近确定的信号）
 * - 一方包含另一方：+40（`沙丘` vs `沙丘：第二部`，可能对也可能错）
 * - 年份完全相同：+50。年份差 1：+20 —— **差 1 年是常态不是错**：
 *   上映年和引进年不同、跨年首播的剧、以及发布组按发行年而 TMDB 按首映年
 * - 年份差 2 以上：-30（不是排除，只是往后排）
 * - 类型对得上（本地判是剧、候选也是 tv）：+25
 * - 有海报：+5；votes 多：最多 +10（冷门条目和同名的垃圾条目常常没有票数）
 */
export function scoreCandidate(
  c: Pick<TmdbCandidate, 'title' | 'original_title' | 'year' | 'media_type' | 'poster_path' | 'votes'>,
  want: { title: string; year: number; type?: 'movie' | 'series' }
): number {
  let score = 0
  const wantNorm = normTitle(want.title)
  const titles = [normTitle(c.title), normTitle(c.original_title)].filter(Boolean)

  if (wantNorm) {
    if (titles.includes(wantNorm)) score += 100
    else if (titles.some((t) => t.includes(wantNorm) || wantNorm.includes(t))) score += 40
  }

  if (want.year > 0 && c.year > 0) {
    const gap = Math.abs(want.year - c.year)
    if (gap === 0) score += 50
    else if (gap === 1) score += 20
    else score -= 30
  }

  if (want.type) {
    const wantMedia = want.type === 'series' ? 'tv' : 'movie'
    if (c.media_type === wantMedia) score += 25
  }

  if (c.poster_path) score += 5
  score += Math.min(10, Math.floor(Math.log10(Math.max(1, c.votes)) * 4))

  return score
}

/** 十分制。TMDB 的 vote_average 本来就是十分制，这里只做兜底和取整 */
function toRating(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(Math.min(10, n) * 10) / 10
}

/** `YYYY-MM-DD` 的年份。取不出来给 0 */
export function yearOf(date: unknown): number {
  const m = /^(\d{4})/.exec(String(date ?? '').trim())
  return m ? Number(m[1]) : 0
}

/** `YYYY-MM-DD` -> Unix 秒（UTC 零点）。和 nfo.ts 的 dateToEpochSec 同一个约定 */
function dateTs(raw: unknown): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(raw ?? '').trim())
  if (!m) return 0
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return 0
  return Math.floor(Date.UTC(y, mo - 1, d) / 1000)
}

function str(raw: unknown, max = 4000): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : ''
}

function names(raw: unknown, key = 'name'): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const v = str((item as Record<string, unknown>)?.[key], 80)
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * 搜索结果的一项 -> TmdbCandidate。
 *
 * 电影和剧集的字段名不一样（`title`/`release_date` vs `name`/`first_air_date`），
 * 这是 TMDB 的 API 形状，不是我们能选的。`/search/multi` 会在每项上带
 * `media_type`，单类型搜索不带 —— 所以类型由调用方传进来。
 */
export function mapCandidate(raw: unknown, fallbackType: 'movie' | 'tv'): TmdbCandidate | null {
  const r = raw as Record<string, unknown> | null
  const id = Number(r?.id)
  if (!r || !Number.isFinite(id) || id <= 0) return null

  const kind = r.media_type === 'movie' || r.media_type === 'tv' ? r.media_type : fallbackType
  const isMovie = kind === 'movie'

  return {
    id,
    media_type: kind,
    title: str(r[isMovie ? 'title' : 'name'], 200),
    original_title: str(r[isMovie ? 'original_title' : 'original_name'], 200),
    year: yearOf(r[isMovie ? 'release_date' : 'first_air_date']),
    overview: str(r.overview, 600),
    rating: toRating(r.vote_average),
    votes: Math.max(0, Math.round(Number(r.vote_count) || 0)),
    poster_path: str(r.poster_path, 200),
    original_language: str(r.original_language, 10),
    score: 0
  }
}

/**
 * 详情 -> TmdbDetail。电影和剧集共用，差别用 `isMovie` 分。
 *
 * 需要 `append_to_response=credits`，导演 / 编剧 / 演员都在那里。
 * 剧集的导演在 `created_by` 而不是 `credits.crew` —— 一部剧的每集导演都不同，
 * 「这部剧的导演」这个概念对剧集来说是主创，TMDB 的建模是对的。
 */
export function mapDetail(raw: unknown, kind: 'movie' | 'tv'): TmdbDetail | null {
  const r = raw as Record<string, unknown> | null
  const id = Number(r?.id)
  if (!r || !Number.isFinite(id) || id <= 0) return null

  const isMovie = kind === 'movie'
  const credits = (r.credits ?? {}) as Record<string, unknown>
  const crew = Array.isArray(credits.crew) ? (credits.crew as Array<Record<string, unknown>>) : []
  const castRaw = Array.isArray(credits.cast) ? (credits.cast as Array<Record<string, unknown>>) : []

  const byJob = (jobs: string[]): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const c of crew) {
      const job = str(c.job, 40)
      if (!jobs.includes(job)) continue
      const n = str(c.name, 80)
      if (!n || seen.has(n)) continue
      seen.add(n)
      out.push(n)
    }
    return out
  }

  const seasons: TmdbSeason[] = isMovie
    ? []
    : (Array.isArray(r.seasons) ? (r.seasons as Array<Record<string, unknown>>) : [])
        .map((s) => ({
          season_number: Math.round(Number(s.season_number) || 0),
          name: str(s.name, 80),
          episode_count: Math.max(0, Math.round(Number(s.episode_count) || 0)),
          air_date: str(s.air_date, 20)
        }))
        // 空季（还没开播、episode_count 为 0）不要：它会在详情页上摆一个点不开的空壳
        .filter((s) => s.episode_count > 0)
        .sort((a, b) => a.season_number - b.season_number)

  return {
    id,
    media_type: kind,
    title: str(r[isMovie ? 'title' : 'name'], 200),
    original_title: str(r[isMovie ? 'original_title' : 'original_name'], 200),
    overview: str(r.overview, 2000),
    tagline: str(r.tagline, 200),
    year: yearOf(r[isMovie ? 'release_date' : 'first_air_date']),
    end_year: isMovie ? 0 : yearOf(r.last_air_date),
    rating: toRating(r.vote_average),
    votes: Math.max(0, Math.round(Number(r.vote_count) || 0)),
    runtime_min: Math.max(
      0,
      Math.round(
        Number(isMovie ? r.runtime : Array.isArray(r.episode_run_time) ? r.episode_run_time[0] : 0) || 0
      )
    ),
    genres: names(r.genres),
    countries: names(r.production_countries),
    studios: names(r.production_companies),
    // 剧集的「导演」是主创（created_by）；电影才在 crew 里找 Director
    directors: isMovie ? byJob(['Director']) : names(r.created_by),
    writers: byJob(['Screenplay', 'Writer', 'Story']),
    cast: castRaw
      .slice(0, 15)
      .map((c) => ({ name: str(c.name, 80), role: str(c.character, 80) }))
      .filter((c) => c.name !== ''),
    poster_path: str(r.poster_path, 200),
    backdrop_path: str(r.backdrop_path, 200),
    // 电影的 imdb_id 在详情里直接有；剧集要 external_ids，见 detailPath
    imdb_id: str(r.imdb_id, 20) || str((r.external_ids as Record<string, unknown>)?.imdb_id, 20),
    original_language: str(r.original_language, 10),
    status: isMovie ? '' : str(r.status, 40),
    seasons,
    homepage: str(r.homepage, 300)
  }
}

/** 季详情 -> 集列表 */
export function mapSeasonEpisodes(raw: unknown, seasonNumber: number): TmdbEpisode[] {
  const r = raw as Record<string, unknown> | null
  const list = Array.isArray(r?.episodes) ? (r!.episodes as Array<Record<string, unknown>>) : []
  return list
    .map((e) => ({
      season_number: Math.round(Number(e.season_number) ?? seasonNumber) || seasonNumber,
      episode_number: Math.round(Number(e.episode_number) || 0),
      name: str(e.name, 200),
      overview: str(e.overview, 600),
      air_date_ts: dateTs(e.air_date),
      runtime_min: Math.max(0, Math.round(Number(e.runtime) || 0))
    }))
    .filter((e) => e.episode_number > 0)
    .sort((a, b) => a.episode_number - b.episode_number)
}

/**
 * 海报 / 背景图的完整地址。
 *
 * `size` 用 TMDB 的档位名。海报墙的框不大，`w500` 够用而且省流量 ——
 * `original` 是原图，一张能有好几 MB。
 */
export function imageUrl(cfg: TmdbConfig, relPath: string, size = 'w500'): string {
  const p = String(relPath ?? '').trim()
  if (!p) return ''
  const domain = normDomain(cfg?.image_domain ?? '', DEFAULT_IMAGE_DOMAIN)
  return `https://${domain}/t/p/${size}${p.startsWith('/') ? p : `/${p}`}`
}

/* ============================== 网络 ============================== */

const TIMEOUT = 20_000

/**
 * 进程内缓存。一次扫描里同一部剧的详情会被查好几次（agent 先看候选再取详情），
 * 而 TMDB 有速率限制。抱一重启即清空，不做持久化 —— 刮削结果本来就该能刷新。
 */
const cache = new Map<string, unknown>()

export function clearTmdbCache(): void {
  cache.clear()
}

/**
 * 发一个 TMDB 请求。
 *
 * 走 `api_key` query 参数而不是 v4 的 Bearer token：用户从 TMDB 设置页
 * 复制到的那串就是 v3 key，让他们分辨「API Key」和「API Read Access Token」
 * 是多余的负担，而填错了只会得到一个 401。
 */
async function get(cfg: TmdbConfig, endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const key = cfg.api_key.trim()
  if (!key) throw new Error('TMDB API Key 还没填')

  const domain = normDomain(cfg.api_domain, DEFAULT_API_DOMAIN)
  const query = new URLSearchParams({ api_key: key, language: 'zh-CN', ...params })
  const url = `https://${domain}/3${endpoint}?${query.toString()}`

  // 缓存键不含 api_key，免得把它留在内存里第二份
  const cacheKey = `${endpoint}?${new URLSearchParams({ language: 'zh-CN', ...params }).toString()}`
  const hit = cache.get(cacheKey)
  if (hit !== undefined) return hit

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT)
  })
  if (!res.ok) {
    // 401 和 404 的下一步动作完全不同，要分开说
    if (res.status === 401) throw new Error('TMDB 拒绝了这个 API Key（401），请检查设置里填的 key')
    if (res.status === 404) throw new Error(`TMDB 上没有这个条目（404）：${endpoint}`)
    if (res.status === 429) throw new Error('TMDB 限流了（429），稍后再试')
    const detail = await res.text().catch(() => '')
    throw new Error(`TMDB HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
  const json = await res.json()
  cache.set(cacheKey, json)
  return json
}

/**
 * 搜索。返回按分数排好的候选，**不替调用方选**。
 *
 * `type` 决定走哪个端点：给了就用单类型端点（`/search/movie` 或 `/search/tv`），
 * 没给走 `/search/multi`。单类型端点支持年份过滤，multi 不支持 ——
 * 所以本地已经判出形态时值得走单类型，那条路准得多。
 *
 * 年份参数对电影是 `year`，对剧集是 `first_air_date_year`。这不是我们的选择，
 * 是 TMDB 的 API 形状（`year` 传给 `/search/tv` 会被忽略，静默地）。
 */
export async function tmdbSearch(
  cfg: TmdbConfig,
  query: string,
  opts: { type?: 'movie' | 'series'; year?: number; limit?: number } = {}
): Promise<TmdbCandidate[]> {
  const q = String(query ?? '').trim()
  if (!q) return []

  const params: Record<string, string> = { query: q, include_adult: 'false' }
  let endpoint = '/search/multi'
  let fallbackType: 'movie' | 'tv' = 'movie'

  if (opts.type === 'movie') {
    endpoint = '/search/movie'
    fallbackType = 'movie'
    if (opts.year && opts.year > 0) params.year = String(opts.year)
  } else if (opts.type === 'series') {
    endpoint = '/search/tv'
    fallbackType = 'tv'
    if (opts.year && opts.year > 0) params.first_air_date_year = String(opts.year)
  }

  const json = (await get(cfg, endpoint, params)) as Record<string, unknown>
  const results = Array.isArray(json?.results) ? json.results : []

  const out: TmdbCandidate[] = []
  for (const raw of results) {
    const c = mapCandidate(raw, fallbackType)
    // multi 会回人物（`media_type: 'person'`），mapCandidate 会把它们
    // 当成 fallbackType —— 这里按有没有标题再筛一道
    if (!c || !c.title) continue
    c.score = scoreCandidate(c, { title: q, year: opts.year ?? 0, type: opts.type })
    out.push(c)
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, Math.max(1, opts.limit ?? 8))
}

/**
 * 取详情。
 *
 * `append_to_response` 把 credits 和 external_ids 一起带回来，省两次往返 ——
 * TMDB 有速率限制，而一次扫描可能有几十条。
 */
export async function tmdbDetail(
  cfg: TmdbConfig,
  kind: 'movie' | 'tv',
  id: number
): Promise<TmdbDetail | null> {
  if (!Number.isFinite(id) || id <= 0) return null
  const json = await get(cfg, `/${kind}/${Math.round(id)}`, {
    append_to_response: 'credits,external_ids'
  })
  return mapDetail(json, kind)
}

/** 一季的集列表 */
export async function tmdbSeasonEpisodes(
  cfg: TmdbConfig,
  tvId: number,
  seasonNumber: number
): Promise<TmdbEpisode[]> {
  if (!Number.isFinite(tvId) || tvId <= 0) return []
  const n = Math.max(0, Math.round(seasonNumber))
  const json = await get(cfg, `/tv/${Math.round(tvId)}/season/${n}`, {})
  return mapSeasonEpisodes(json, n)
}

/**
 * 按外部 id 反查。
 *
 * 这是 nfo 里那个 id 最值钱的地方：**一次精确查询，没有猜的余地**。
 * 有 imdb id 就不需要搜索、不需要打分、不需要 agent 判断。
 */
export async function tmdbFindByExternalId(
  cfg: TmdbConfig,
  source: 'imdb_id' | 'tvdb_id',
  externalId: string
): Promise<TmdbCandidate[]> {
  const id = String(externalId ?? '').trim()
  if (!id) return []
  const json = (await get(cfg, `/find/${encodeURIComponent(id)}`, {
    external_source: source
  })) as Record<string, unknown>

  const out: TmdbCandidate[] = []
  for (const [key, kind] of [
    ['movie_results', 'movie'],
    ['tv_results', 'tv']
  ] as Array<[string, 'movie' | 'tv']>) {
    const list = Array.isArray(json?.[key]) ? (json[key] as unknown[]) : []
    for (const raw of list) {
      const c = mapCandidate(raw, kind)
      if (c) {
        // 精确查来的，不参与打分排序 —— 它不是候选之一，它就是答案
        c.score = 1000
        out.push(c)
      }
    }
  }
  return out
}

/** 测试连接。设置页那个按钮用 */
export async function testTmdb(cfg: TmdbConfig): Promise<{ ok: boolean; message: string }> {
  if (!cfg.api_key.trim()) return { ok: false, message: '请先填写 TMDB API Key' }
  try {
    // 用一个一定存在的条目（《肖申克的救赎》，id 278）而不是搜索：
    // 搜索没结果时分不清是 key 不对还是关键词没命中
    const detail = await tmdbDetail({ ...cfg, enabled: true }, 'movie', 278)
    if (!detail) return { ok: false, message: '接口通了，但返回的内容认不出来，可能是反代改写了响应。' }
    const domain = normDomain(cfg.api_domain, DEFAULT_API_DOMAIN)
    return {
      ok: true,
      message: `连接正常（${domain}），测试条目：${detail.title}（${detail.year}）。`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 连不上是国内最常见的失败，直接把解法说出来，别让用户自己猜
    const hint = /fetch failed|timeout|ENOTFOUND|ECONNRESET|aborted/i.test(msg)
      ? ' —— api.themoviedb.org 在国内多数网络下连不上，可以在上面填一个反代域名。'
      : ''
    return { ok: false, message: msg + hint }
  }
}
