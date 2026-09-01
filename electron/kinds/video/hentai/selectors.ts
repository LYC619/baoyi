/**
 * hanime1.me 的 HTML 解析。**这个文件里没有一行发请求** ——
 * URL 拼装、videoCode 提取、DOM 选择、标签清洗全是纯函数，自检拿固定 fixture 跑。
 *
 * 选择器抄自 Han1meViewer 的 `util/Parser.kt`（`hanimeVideoVer2` / `hanimeSearch`），
 * 对应关系记在 doc/hanime-api-notes.md 第三、四节。
 *
 * ## 为什么所有选择器集中在这一个文件里
 *
 * 站方改版会让它们全线失效，而失效的表现是「刮不到东西」而不是报错。
 * 散进业务逻辑的话，改版那天要在四五个文件里找 class 名；集中在这里，
 * 改版只改一个文件。这是 doc/hanime-api-notes.md 第八节第 3 条定下的。
 *
 * ## 为什么是 node-html-parser
 *
 * 纯 JS，两个依赖（entities + css-select），674 KB。选它的硬条件是**不能有原生
 * 模块** —— 本机编译不了原生模块（GitHub 二进制下载超时，得走 npmmirror），
 * 而主进程是 rollup 打包进 `dist-electron/main.js` 的，纯 JS 依赖直接内联进去，
 * 打包产物里不需要多一个 node_modules。
 *
 * cheerio 也是纯 JS 但拖着 undici / parse5 / htmlparser2 十来个包（1 MB），
 * 而这里用到的只有 `querySelector` 和 `getAttribute` —— 上游用的 Jsoup 选择器
 * 语法（含 `div[class^=video-caption-text]` 这种前缀匹配）node-html-parser 原样支持，
 * 实测过。多出来的那 300 KB 买不到任何这里用得上的东西。
 *
 * ## 两处 Jsoup 有、node-html-parser 没有的东西
 *
 * `ownText()`（只要本节点的直接文本，不含子元素）和 `absUrl()`（相对地址拼绝对）。
 * 都在下面自己实现了 —— 不是为了省依赖，是这两个语义在解析里是关键的：
 * 简介那个节点底下有 `<span>` 子节点，用 `.text` 会把子节点的文本一起吃进来。
 */

import { parse, type HTMLElement } from 'node-html-parser'

/* ============================== 常量 ============================== */

/** 默认站点。四个镜像同源内容，见 doc/hanime-api-notes.md 第二节 */
export const HANIME_BASE = 'https://hanime1.me/'

/** 四个镜像域名。`toVideoCode` 认它们，别的域名一律不认 */
export const HANIME_HOSTS = ['hanime1.me', 'hanime1.com', 'hanimeone.me', 'javchu.com']

/**
 * 里番那个 genre 的值，**繁体**。
 *
 * 站方 genre.json 里的 key 是繁体「裏番」，简体「里番」搜不到 ——
 * 这个字在两边不同形，是这份代码里最容易写错又最难发现的一个字面量
 * （写错了不报错，只是搜索结果里混进大量非里番条目）。
 */
export const HANIME_GENRE_HENTAI = '裏番'

/* ============================== URL ============================== */

/**
 * 拼搜索地址。
 *
 * `genre` 默认锁在「裏番」——抱一走到这条通道时已经确定这是一部里番了，
 * 不锁的话搜索结果里会混进同人作品和 MMD，而那些的命名规则完全不同。
 */
export function searchUrl(
  query: string,
  opts: { page?: number; genre?: string; tags?: string[]; base?: string } = {}
): string {
  const u = new URL('search', opts.base || HANIME_BASE)
  const q = String(query ?? '').trim()
  if (q) u.searchParams.set('query', q)
  u.searchParams.set('genre', opts.genre ?? HANIME_GENRE_HENTAI)
  if (opts.page && opts.page > 1) u.searchParams.set('page', String(opts.page))
  // tags[] 是可重复的同名参数，不是逗号分隔的一个值
  for (const t of opts.tags ?? []) if (t) u.searchParams.append('tags[]', t)
  return u.href
}

/** 拼详情页地址。videoCode 的地位等同 tmdb_id：有它就是一次精确查询 */
export function watchUrl(videoCode: string, base = HANIME_BASE): string {
  const code = String(videoCode ?? '').trim()
  if (!code) return ''
  const u = new URL('watch', base)
  u.searchParams.set('v', code)
  return u.href
}

/**
 * 从任意一段文本里抠出 videoCode（纯数字）。
 *
 * 正则照搬上游 `HanimeManager.kt` 的 `videoUrlRegex` 的**意图**，
 * 但用 URL 解析而不是一条长正则实现 —— 上游那条正则要同时兼容
 * 「站内相对链接」「四个镜像域名」「`v=` 前面还有别的查询参数」三件事，
 * 而 `new URL()` 加一个 host 白名单把这三件事变成两行，且不会因为
 * 正则里某个 `?:` 写错而静默漏认。
 *
 * 认不出来返回空串，不抛 —— 页面上本来就有非 watch 链接。
 */
export function toVideoCode(raw: unknown, base = HANIME_BASE): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''

  // 先把文本里像链接的片段挑出来，逐个按 URL 判。
  //
  // 不能只用一条正则直接抠 `v=(\d+)` —— 那样 `https://example.com/watch?v=1`
  // 也会被当成站内链接（实测踩到过）。镜像白名单是这个函数唯一的把关，
  // 绕过它就等于认任何域名的 watch 链接
  const tokens = s.match(/(?:https?:)?\/\/[^\s"'<>]+|\/?watch\?[^\s"'<>]+/gi) ?? []
  for (const t of tokens) {
    const code = codeFromUrl(t, base)
    if (code) return code
  }

  // 整个串本身就是一个地址的情况（相对路径靠 base 补全）
  return codeFromUrl(s, base)
}

/** 一个地址 -> videoCode。域名不在白名单、路径不是 /watch、v 不是纯数字，一律空串 */
function codeFromUrl(s: string, base: string): string {
  try {
    const u = new URL(s, base)
    if (!hostAllowed(u.hostname)) return ''
    if (!/(?:^|\/)watch\/?$/.test(u.pathname)) return ''
    const v = u.searchParams.get('v') ?? ''
    return /^\d+$/.test(v) ? v : ''
  } catch {
    return ''
  }
}

/** 镜像白名单。相对链接经 base 补全后 host 就是 base 的 host，照样过 */
function hostAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '')
  return HANIME_HOSTS.includes(h)
}

/** 相对地址拼绝对。node-html-parser 没有 Jsoup 的 absUrl，这是它的替代 */
export function absUrl(raw: unknown, base = HANIME_BASE): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  try {
    return new URL(s, base).href
  } catch {
    return ''
  }
}

/* ============================== 清洗 ============================== */

/**
 * 洗一个标签。页面上写成 `#巨乳 (1234)` —— 前面一个井号，括号里是该标签下的
 * 作品数，而那个数每天都在变。
 *
 * 不洗的话同一个标签会因为计数不同被当成不同的标签反复入池，
 * 标签池里于是躺着「#巨乳 (1231)」「#巨乳 (1244)」两条，而它们是一个东西。
 */
export function cleanTag(raw: unknown): string {
  // 先 trim 再剥 `#`：页面上取下来的文本常带前后空白，
  // 顺序反了的话 ` #女教師 (12)` 里那个井号剥不掉（^ 卡在空格上）
  return String(raw ?? '')
    .trim()
    .split(' (')[0]
    .replace(/^#/, '')
    .trim()
}

/** 只要本节点的直接文本，不含子元素的。Jsoup 的 ownText() */
export function ownText(el: HTMLElement | null | undefined): string {
  if (!el) return ''
  return el.childNodes
    .filter((n) => n.nodeType === 3)
    .map((n) => n.rawText)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 折叠空白的 textContent。页面上的换行和缩进不是内容 */
function text(el: HTMLElement | null | undefined): string {
  return el ? el.text.replace(/\s+/g, ' ').trim() : ''
}

/**
 * `12:34` / `1:02:03` -> 秒。认不出返回 0。
 *
 * 0 的含义是「页面上没写」，不是「时长为零」—— 和 ParsedVideoName 里
 * `year: 0` 同一个约定。
 */
export function durationSec(raw: unknown): number {
  const s = String(raw ?? '').trim()
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return 0
  const [, h, mm, ss] = m
  const n = (Number(h ?? 0) || 0) * 3600 + Number(mm) * 60 + Number(ss)
  return Number.isFinite(n) ? n : 0
}

/* ============================== 搜索结果 ============================== */

/** 搜索结果里的一条候选 */
export interface HanimeHit {
  /** 纯数字。空串 = 这一项没解出链接，调用方该丢掉它 */
  videoCode: string
  title: string
  /** 绝对地址。空串 = 页面上没有 */
  coverUrl: string
  /** 秒。0 = 页面上没写 */
  durationSec: number
}

/**
 * 解析搜索结果页。
 *
 * 站上有两种版式（上游 `hanimeSearch` 先判版式再选选择器）：
 * `content-padding-new` 是正常版式，`home-rows-videos-wrapper` 是简化版式。
 * 这里不先判版式，而是**两套容器选择器都试**，理由是判版式那一步本身就是
 * 靠 class 名的，改版时它和条目选择器会一起失效 —— 多一层判断只多一个失效点。
 *
 * 解不出来返回空数组，不抛。站方改版时正确的行为是「这次刮不到」，
 * 不是让整次识别炸掉（doc/hanime-api-notes.md 第八节第 2 条）。
 */
export function parseSearch(html: string, base = HANIME_BASE): HanimeHit[] {
  const root = parse(String(html ?? ''))

  // 两种版式的条目容器。`.search-doujin-videos` 是简化版式里每行的那个块
  const items = [
    ...root.querySelectorAll('.content-padding-new .search-doujin-videos'),
    ...root.querySelectorAll('.home-rows-videos-wrapper a.home-rows-videos-div'),
    // 兜底：直接找带 watch 链接的卡片。上面两个都失效时还能捞回一部分
    ...root.querySelectorAll('div.card-mobile-panel, div.multiple-link-wrapper')
  ]

  const out: HanimeHit[] = []
  const seen = new Set<string>()

  for (const it of items) {
    // 链接可能在容器自己身上（简化版式的 <a>），也可能在里面第一个 <a> 上
    const href = it.getAttribute('href') || it.querySelector('a')?.getAttribute('href') || ''
    const code = toVideoCode(href, base)
    if (!code || seen.has(code)) continue

    const title =
      text(it.querySelector('div.card-mobile-title')) ||
      text(it.querySelector('div.title')) ||
      text(it.querySelector('h4.video-title')) ||
      text(it.querySelector('.home-rows-videos-title'))

    const img = it.querySelector('img')
    const cover = absUrl(img?.getAttribute('src') || img?.getAttribute('data-src'), base)

    const dur = durationSec(
      text(it.querySelector('div[class^=duration]')) || text(it.querySelector('.duration'))
    )

    seen.add(code)
    out.push({ videoCode: code, title, coverUrl: cover, durationSec: dur })
  }

  return out
}

/* ============================== 详情页 ============================== */

/** playlist 里的一集。站上没有季集层级，每一集是一个独立条目 */
export interface HanimeEpisode {
  videoCode: string
  title: string
  coverUrl: string
  durationSec: number
}

/** 详情页解析结果 */
export interface HanimeDetail {
  videoCode: string
  /** 站上的主标题（`#shareBtn-title`）。多数是日文原名 */
  title: string
  /** 中文名。在简介节点**前面**那个兄弟节点上。空串 = 页面上没有 */
  chineseTitle: string
  /** 简介正文 */
  introduction: string
  coverUrl: string
  /** 已洗过：去掉 `#` 前缀和 ` (1234)` 计数 */
  tags: string[]
  /** 厂牌 / 作者。空串 = 没解出来 */
  artist: string
  /** 系列名。空串 = 这部作品不在任何系列里 */
  seriesName: string
  /** 同系列的各集。单集作品是空数组，**不是一条自己** */
  episodes: HanimeEpisode[]
}

/**
 * 解析详情页。
 *
 * 每个字段独立降级：一个选择器失效只让那一个字段变空串，不影响别的 ——
 * 站方改版通常只动一部分 DOM，全靠一个 try 包起来会让能拿到的字段
 * 跟着一起丢掉。
 */
export function parseDetail(html: string, base = HANIME_BASE): HanimeDetail {
  const root = parse(String(html ?? ''))

  // 标题取分享按钮上那个，比正文标题稳（上游注释里就这么说的）。
  //
  // 兜底那个只写 class 不写标签名：上游笔记里只记了 `#shareBtn-title`，
  // 正文标题那个节点到底是 h3 还是 h4 没人验过 —— 写死一个标签名等于
  // 拿一个没验证的猜测去挡另一个没验证的猜测
  const title =
    text(root.querySelector('#shareBtn-title')) || text(root.querySelector('.video-details-title'))

  // 简介和中文名共处 video-details-wrapper 下，中文名在简介**前面**那个兄弟节点上。
  // 简介用 ownText：那个节点底下有 <span> 子节点，用 .text 会把它一起吃进来
  const cap = root.querySelector('div[class^=video-caption-text]')
  const introduction = ownText(cap)
  const chineseTitle = text(cap?.previousElementSibling as HTMLElement | null)

  // 封面优先取 og:image —— meta 标签比正文 DOM 稳得多
  const cover = absUrl(
    root.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      root.querySelector('#player-div-wrapper img')?.getAttribute('src') ||
      root.querySelector('video')?.getAttribute('poster'),
    base
  )

  const tags = [
    ...new Set(
      root
        .querySelectorAll('.single-video-tag')
        .map((el) => cleanTag(text(el.querySelector('a[href]')) || text(el)))
        .filter((t) => t && !/^\d+$/.test(t))
    )
  ]

  const artist = text(root.querySelector('.meta-author a')) || text(root.querySelector('#video-artist-name'))

  // 集数表两套结构，先试新的再试旧的（上游就是这个顺序）
  const wrap =
    root.querySelector('div.video-playlist-wrapper') || root.querySelector('div[id=video-playlist-wrapper]')
  const scroll = wrap?.querySelector('#playlist-scroll') ?? null
  const seriesName = text(wrap?.querySelector('#playlist-top-block h4 a'))

  const episodes: HanimeEpisode[] = []
  const seen = new Set<string>()
  for (const it of scroll?.querySelectorAll('div.playlist-hover-wrap, a, div.card-mobile-panel') ?? []) {
    // 新结构把链接放在 data-href 上，旧结构放在 href 上
    const code = toVideoCode(it.getAttribute('data-href') || it.getAttribute('href') || '', base)
    if (!code || seen.has(code)) continue
    seen.add(code)
    episodes.push({
      videoCode: code,
      title: text(it.querySelector('h4.video-title a')) || text(it.querySelector('.card-mobile-title')),
      coverUrl: absUrl(it.querySelector('img.main-thumb, img')?.getAttribute('src'), base),
      durationSec: durationSec(text(it.querySelector('.duration')))
    })
  }

  return {
    videoCode: toVideoCode(root.querySelector('meta[property="og:url"]')?.getAttribute('content'), base),
    title,
    chineseTitle,
    introduction,
    coverUrl: cover,
    tags,
    artist,
    seriesName,
    episodes
  }
}
