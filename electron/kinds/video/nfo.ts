/**
 * Kodi `.nfo` 侧车文件解析。
 *
 * 这是视频版的 `app.info` —— v0.6 那条最贵的教训（能在本地读到的事实，
 * 不该让模型去猜）在这儿收益最大：一个 nfo 常常直接带着 TMDB / IMDB id、
 * 简介、演员表、评分、首播日期。这些东西让 agent 去猜既慢又不准，
 * 而它们就明明白白躺在正片旁边的一个 XML 里。
 *
 * 纯逻辑：收字符串出结构，不读文件、不碰数据库、不碰 Electron，
 * 所以自检能把它整个跑一遍。读文件那一步在调用方。
 *
 * 字段覆盖的规格来源是 MediaElch 的 `src/media_center/kodi/`
 * （`MovieXmlReader` / `TvShowXmlReader` / `EpisodeXmlReader`，GPL，
 * **只当规格读，没抄代码**）。XML 解析用 fast-xml-parser（MIT，纯 JS，
 * 无原生依赖 —— 本机编译不了原生模块，这是硬要求）。
 *
 * ## 为什么不用正则硬解
 *
 * nfo 看着简单，但真实文件里有 CDATA（简介里带 HTML 的很常见）、
 * 实体转义（`&amp;`）、嵌套的 `<actor>`、以及同名标签重复出现
 * （多个 `<genre>`）。正则解这些会在某个用户的某个文件上悄悄解错，
 * 而解错的简介和演员表要等到界面上显示出来才有人发现。
 */

import { XMLParser } from 'fast-xml-parser'

/* ============================== 输出形状 ============================== */

/** nfo 里的一个演员 */
export interface NfoActor {
  name: string
  role: string
  /** 排序序号。nfo 没写时是 -1，调用方按数组顺序兜底 */
  order: number
  /** 头像 URL 或本地路径，nfo 里常是 URL */
  thumb: string
}

/**
 * 从 nfo 里读出来的一切。
 *
 * 所有字段都有零值，**不用 optional** —— 调用方拿到的永远是完整形状，
 * 少一层 `?.`。零值的含义统一是「nfo 里没写」，不是「值为零」：
 * `year = 0` 是不知道年份，`rating = 0` 是没有评分。
 * 这一条和 `video_meta` 那张表的约定一致。
 */
export interface NfoData {
  /** 根标签认出来的类型。'unknown' = 是个 XML 但不是这三种 */
  kind: 'movie' | 'tvshow' | 'episode' | 'unknown'

  title: string
  original_title: string
  sort_title: string
  /** 剧名。episode nfo 里的 `<showtitle>` */
  show_title: string

  plot: string
  /** 短简介。电影 nfo 的 `<outline>` */
  outline: string
  tagline: string

  year: number
  /** 首播 / 上映日期，原样的 `YYYY-MM-DD`。空串 = 没写 */
  premiered: string
  /** 上面那个日期的 Unix 秒（UTC 零点）。0 = 没写或解不出来 */
  premiered_ts: number

  /** 十分制。nfo 里可能是任意满分制，已按 `max` 折算过 */
  rating: number
  votes: number
  /** 用户自己打的分，和刮削来的 rating 分开 */
  user_rating: number

  /** 片长，分钟。0 = 没写 */
  runtime_min: number
  /** 分级（`PG-13`、`R`、`TV-MA`） */
  mpaa: string
  /** 剧集状态（`Continuing` / `Ended`） */
  status: string

  genres: string[]
  studios: string[]
  countries: string[]
  directors: string[]
  /** 编剧。nfo 里的标签叫 `<credits>` */
  writers: string[]
  tags: string[]
  actors: NfoActor[]

  /** 系列 / 合集名（`<set><name>`）。「教父三部曲」这种 */
  set: string

  tmdb_id: string
  imdb_id: string
  tvdb_id: string

  /** 集号信息。非 episode nfo 时都是 -1（0 是合法季号，不能当零值） */
  season: number
  episode: number

  /**
   * 观看状态的原始事实。**刻意只读出来，不在这一层折算成 watch_status。**
   *
   * 它来自别的媒体中心（Kodi / Jellyfin / Emby），是「那边的记录」而不是
   * 「这边的事实」。要不要采信、怎么合并，是入库策略要决定的事，
   * 不该由一个解析函数替它决定。
   */
  playcount: number
  /** 上次播放时间，原样字符串 */
  last_played: string
  /** 断点续播的位置和总长，秒。0 = 没有断点 */
  resume_position_sec: number
  resume_total_sec: number

  /** `<thumb>` 里的图片 URL，海报候选 */
  thumbs: string[]
  /** `<fanart>` 下的背景图 URL */
  fanarts: string[]
}

/* ============================== 解析器 ============================== */

/**
 * `parseTagValue: false` 是有意的：让 fast-xml-parser 把所有值原样当字符串给出来，
 * 数字转换这一层自己做。
 *
 * 理由是它的自动转换会在几个地方悄悄出错 —— `<episode>007</episode>` 变成 7
 * 还算好的，`<premiered>2023-01-02</premiered>` 这种会被当成表达式或日期处理，
 * 而 `<imdbid>tt0111161</imdbid>` 和 `<votes>1,234</votes>` 各有各的坑。
 * 全当字符串拿到手再自己转，坑在自己代码里，看得见也测得着。
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // 同名标签只出现一次时也给数组，省掉「是对象还是数组」的分支。
  // 只对真正会重复的那些开，全开会让简单字段也变成数组
  isArray: (name) =>
    ['genre', 'studio', 'country', 'director', 'credits', 'tag', 'actor', 'thumb', 'uniqueid', 'rating'].includes(name)
})

/** 空的 NfoData。所有零值的定义集中在这一处 */
function emptyNfo(): NfoData {
  return {
    kind: 'unknown',
    title: '', original_title: '', sort_title: '', show_title: '',
    plot: '', outline: '', tagline: '',
    year: 0, premiered: '', premiered_ts: 0,
    rating: 0, votes: 0, user_rating: 0,
    runtime_min: 0, mpaa: '', status: '',
    genres: [], studios: [], countries: [], directors: [], writers: [], tags: [], actors: [],
    set: '',
    tmdb_id: '', imdb_id: '', tvdb_id: '',
    season: -1, episode: -1,
    playcount: 0, last_played: '', resume_position_sec: 0, resume_total_sec: 0,
    thumbs: [], fanarts: []
  }
}

/* ---------------------------- 取值小工具 ---------------------------- */

/**
 * 取标签的文本。
 *
 * fast-xml-parser 对 `<title>沙丘</title>` 给字符串，对
 * `<title lang="zh">沙丘</title>` 给 `{ '#text': '沙丘', '@_lang': 'zh' }`。
 * 两种都要认，否则带属性的标签会静默读成空。
 */
function text(node: unknown): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node.trim()
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (Array.isArray(node)) return node.length > 0 ? text(node[0]) : ''
  if (typeof node === 'object') {
    const t = (node as Record<string, unknown>)['#text']
    return t === undefined ? '' : text(t)
  }
  return ''
}

/** 整数。取不出来返回 fallback —— 注意 0 是合法值，不能拿它当失败标记 */
function int(node: unknown, fallback = 0): number {
  const s = text(node).replace(/,/g, '')
  if (!s) return fallback
  const m = /-?\d+/.exec(s)
  if (!m) return fallback
  return Number(m[0])
}

/** 浮点。同上 */
function num(node: unknown, fallback = 0): number {
  const s = text(node).replace(/,/g, '')
  if (!s) return fallback
  const m = /-?\d+(?:\.\d+)?/.exec(s)
  if (!m) return fallback
  return Number(m[0])
}

/** 一串同名标签的文本，去空去重，保持原顺序 */
function list(node: unknown): string[] {
  const arr = Array.isArray(node) ? node : node === undefined ? [] : [node]
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of arr) {
    // `<genre>动作 / 冒险</genre>` 这种一格里塞多个的写法真实存在
    for (const piece of text(item).split(/\s*[/|,、]\s*/)) {
      const v = piece.trim()
      if (!v || seen.has(v)) continue
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/**
 * `YYYY-MM-DD` -> Unix 秒（UTC 零点）。解不出来给 0。
 *
 * 用 `Date.UTC` 而不是 `new Date(s)`：后者对没有时区的日期串，
 * 不同运行时的解释不一样（有的当本地时区有的当 UTC），
 * 会让同一个 nfo 在不同机器上差出一天。
 */
export function dateToEpochSec(raw: string): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(raw ?? '').trim())
  if (!m) return 0
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return 0
  return Math.floor(Date.UTC(y, mo - 1, d) / 1000)
}

/* ---------------------------- id 抽取 ---------------------------- */

const IMDB_RE = /\btt\d{7,10}\b/

/**
 * 从 `<uniqueid>` / `<id>` / `<tmdbid>` / `<imdbid>` / `<tvdbid>` 这一堆
 * 历史遗留写法里把三个 id 挖出来。
 *
 * 现代写法是 `<uniqueid type="tmdb" default="true">693134</uniqueid>`，
 * 老写法是 `<id>tt1160419</id>` 加一个独立的 `<tmdbid>`。两种都得认，
 * 因为用户的库里两种都有 —— nfo 是历年不同工具写下的沉积层。
 */
function extractIds(root: Record<string, unknown>): { tmdb: string; imdb: string; tvdb: string } {
  const out = { tmdb: '', imdb: '', tvdb: '' }

  const uids = Array.isArray(root.uniqueid) ? root.uniqueid : []
  for (const u of uids) {
    const type = String((u as Record<string, unknown>)?.['@_type'] ?? '').toLowerCase()
    const val = text(u)
    if (!val) continue
    if (type === 'tmdb' && !out.tmdb) out.tmdb = val
    else if (type === 'imdb' && !out.imdb) out.imdb = val
    else if (type === 'tvdb' && !out.tvdb) out.tvdb = val
  }

  // 专用标签，比 uniqueid 老但更明确
  if (!out.tmdb) out.tmdb = text(root.tmdbid)
  if (!out.imdb) out.imdb = text(root.imdbid)
  if (!out.tvdb) out.tvdb = text(root.tvdbid)

  // `<id>` 没有类型，只能靠形状认：tt 开头的是 IMDB，纯数字的归 TMDB。
  // 纯数字其实也可能是 TVDB id（老 XBMC 的剧集 nfo 就这么写），所以
  // 只在 tmdb 还空着、且这不是剧集 nfo 的时候才认 —— 认错了会去刮到另一部片
  const bare = text(root.id)
  if (bare) {
    if (IMDB_RE.test(bare)) {
      if (!out.imdb) out.imdb = IMDB_RE.exec(bare)![0]
    } else if (/^\d+$/.test(bare) && !out.tmdb && !out.tvdb) {
      out.tmdb = bare
    }
  }

  return out
}

/* ---------------------------- 评分 ---------------------------- */

/**
 * 评分统一折算成十分制。
 *
 * 现代写法 `<ratings><rating name="themoviedb" max="10" default="true">
 * <value>7.5</value><votes>1234</votes></rating></ratings>`，
 * 老写法是平铺的 `<rating>7.5</rating>` + `<votes>`。
 *
 * `max` 必须看：IMDB 是 10 分制，某些源写的是 100 分制，不折算的话
 * 一部 75 分的片子会在界面上显示成 75 星。
 */
function extractRating(root: Record<string, unknown>): { rating: number; votes: number } {
  const container = root.ratings as Record<string, unknown> | undefined
  const items = container && Array.isArray(container.rating) ? container.rating : []

  let pick: Record<string, unknown> | null = null
  for (const r of items) {
    const rec = r as Record<string, unknown>
    if (String(rec['@_default'] ?? '').toLowerCase() === 'true') { pick = rec; break }
    if (!pick) pick = rec
  }

  if (pick) {
    const max = num(pick['@_max'], 10) || 10
    const value = num(pick.value)
    return { rating: max === 10 ? value : round1((value / max) * 10), votes: int(pick.votes) }
  }

  // 平铺的老写法。注意此时 root.rating 因为 isArray 配置也是数组
  const flat = Array.isArray(root.rating) ? root.rating[0] : root.rating
  if (flat !== undefined) {
    const value = num(flat)
    // 老写法没有 max。超过 10 的按百分制折 —— 这是猜，但不折的话
    // 界面上会出现 85 分这种一眼假的值，折错了至少还在合理区间
    return { rating: value > 10 ? round1(value / 10) : value, votes: int(root.votes) }
  }

  return { rating: 0, votes: 0 }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/* ============================== 入口 ============================== */

/**
 * 解一个 nfo 的内容。不是能认的东西返回 null。
 *
 * 两种非 XML 的情况也要处理，它们在真实片库里都不少见：
 *
 * - **纯 URL 的 nfo**：整个文件就一行
 *   `https://www.imdb.com/title/tt0111161/`。这是 Kodi 明确支持的写法，
 *   老库里很多。抠出 id 当结果，比丢掉强得多 —— 有了 id，
 *   Step 5 的刮削就是一次精确查询而不是一次搜索。
 * - **XML 前面有垃圾**：某些工具会在 XML 前面塞注释或空行甚至 BOM。
 */
export function parseNfo(raw: string): NfoData | null {
  let s = String(raw ?? '')
  if (!s.trim()) return null

  // UTF-8 BOM。留着会让根标签名变成 `﻿movie`，认不出来
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)

  const start = s.search(/<(?:movie|tvshow|episodedetails)\b/i)
  if (start < 0) return urlOnlyNfo(s)
  s = s.slice(start)

  let doc: Record<string, unknown>
  try {
    doc = parser.parse(s) as Record<string, unknown>
  } catch {
    // 走到这儿的只有真正让解析器抛出来的输入。**大部分「坏 nfo」不走这条路** ——
    // fast-xml-parser 对没闭合的标签是静默恢复而不是抛异常，那种情况由
    // withIdBackfill 兜。这里纯粹是别让一个畸形文件把整次扫描带崩
    return urlOnlyNfo(raw)
  }

  if (doc.movie) return withIdBackfill(fill(doc.movie as Record<string, unknown>, 'movie'), raw)
  if (doc.tvshow) return withIdBackfill(fill(doc.tvshow as Record<string, unknown>, 'tvshow'), raw)
  if (doc.episodedetails) {
    // 多集合并的 nfo 里会有多个 `<episodedetails>`，这里只取第一个。
    // 要全部的走 parseNfoEpisodes
    const ep = doc.episodedetails
    return withIdBackfill(fill((Array.isArray(ep) ? ep[0] : ep) as Record<string, unknown>, 'episode'), raw)
  }

  return null
}

/**
 * 一个 id 都没解出来时，去原文里再捞一次。
 *
 * 起因是实测发现的一件事：**fast-xml-parser 遇到没闭合的标签不抛异常，
 * 而是静默恢复**。所以 `<movie><title>x <uniqueid>tt0111161</movie>` 这种
 * 被手改坏的 nfo 会「解析成功」，标题在，id 却悄悄没了 —— 上面那个
 * try/catch 根本等不到。
 *
 * 而 id 是整个 nfo 里最值钱的字段：有它，Step 5 的刮削是一次精确查询；
 * 没它就退回搜索加猜。所以宁可多扫一遍原文。
 *
 * 只在**一个 id 都没有**时才做，不覆盖已解析出来的值 —— 正常解析的结果
 * 比正则从原文里捞的可信。
 */
function withIdBackfill(data: NfoData, raw: string): NfoData {
  if (data.tmdb_id || data.imdb_id || data.tvdb_id) return data
  const salvaged = urlOnlyNfo(raw)
  if (!salvaged) return data
  data.tmdb_id = salvaged.tmdb_id
  data.imdb_id = salvaged.imdb_id
  return data
}

/**
 * 一个 nfo 里的所有 `<episodedetails>`。
 *
 * Kodi 的多集文件（`S01E01E02.mkv`）配的是一个 nfo 里两段 episodedetails，
 * 而扫描器那边这种文件也确实会拆成两集，两边对得上。
 */
export function parseNfoEpisodes(raw: string): NfoData[] {
  let s = String(raw ?? '')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  const start = s.search(/<episodedetails\b/i)
  if (start < 0) return []

  // 多根文档 fast-xml-parser 直接给数组，不用自己切
  let doc: Record<string, unknown>
  try {
    doc = parser.parse(s.slice(start)) as Record<string, unknown>
  } catch {
    return []
  }
  const ep = doc.episodedetails
  if (ep === undefined) return []
  const arr = Array.isArray(ep) ? ep : [ep]
  return arr.map((e) => fill(e as Record<string, unknown>, 'episode'))
}

/** 整个文件不是 XML，但可能藏着一个 id */
function urlOnlyNfo(raw: string): NfoData | null {
  const s = String(raw ?? '')
  const imdb = IMDB_RE.exec(s)
  const tmdb = /themoviedb\.org\/(?:movie|tv)\/(\d+)/i.exec(s)
  if (!imdb && !tmdb) return null
  const out = emptyNfo()
  if (imdb) out.imdb_id = imdb[0]
  if (tmdb) out.tmdb_id = tmdb[1]
  return out
}

/** 把一个已解析的根节点填成 NfoData */
function fill(root: Record<string, unknown>, kind: NfoData['kind']): NfoData {
  const out = emptyNfo()
  out.kind = kind

  out.title = text(root.title)
  out.original_title = text(root.originaltitle)
  out.sort_title = text(root.sorttitle)
  out.show_title = text(root.showtitle)

  out.plot = text(root.plot)
  out.outline = text(root.outline)
  out.tagline = text(root.tagline)

  out.premiered = text(root.premiered) || text(root.aired)
  out.premiered_ts = dateToEpochSec(out.premiered)
  // `<year>` 常常缺，但 premiered 在的话年份就在里面
  out.year = int(root.year) || (out.premiered_ts > 0 ? Number(out.premiered.slice(0, 4)) : 0)

  const r = extractRating(root)
  out.rating = r.rating
  out.votes = r.votes
  out.user_rating = num(root.userrating)

  out.runtime_min = int(root.runtime)
  out.mpaa = text(root.mpaa)
  out.status = text(root.status)

  out.genres = list(root.genre)
  out.studios = list(root.studio)
  out.countries = list(root.country)
  out.directors = list(root.director)
  out.writers = list(root.credits)
  out.tags = list(root.tag)
  out.actors = extractActors(root.actor)

  // `<set>` 有两种写法：`<set>教父三部曲</set>` 和 `<set><name>教父三部曲</name></set>`
  const setNode = root.set as Record<string, unknown> | string | undefined
  out.set = typeof setNode === 'object' && setNode !== null ? text(setNode.name) : text(setNode)

  const ids = extractIds(root)
  out.tmdb_id = ids.tmdb
  out.imdb_id = ids.imdb
  out.tvdb_id = ids.tvdb

  out.season = int(root.season, -1)
  out.episode = int(root.episode, -1)

  out.playcount = int(root.playcount)
  out.last_played = text(root.lastplayed)
  const resume = root.resume as Record<string, unknown> | undefined
  if (resume) {
    out.resume_position_sec = Math.round(num(resume.position))
    out.resume_total_sec = Math.round(num(resume.total))
  }

  out.thumbs = Array.isArray(root.thumb) ? root.thumb.map((t) => text(t)).filter(Boolean) : []
  const fanart = root.fanart as Record<string, unknown> | undefined
  if (fanart && Array.isArray(fanart.thumb)) {
    out.fanarts = fanart.thumb.map((t) => text(t)).filter(Boolean)
  }

  return out
}

function extractActors(node: unknown): NfoActor[] {
  if (!Array.isArray(node)) return []
  return node
    .map((a) => {
      const rec = a as Record<string, unknown>
      return {
        name: text(rec.name),
        role: text(rec.role),
        order: int(rec.order, -1),
        thumb: text(rec.thumb)
      }
    })
    .filter((a) => a.name !== '')
}
