/**
 * hanime1.me 刮削通道的 IO 层。取页面、缓存、超时、错误分档。
 *
 * 解析一行都不在这儿 —— 全在 `selectors.ts`，那份是纯函数。这个分工照
 * `tmdb.ts` / `douban.ts` 的既有约定（doc/hanime-api-notes.md 第八节第 5 条）。
 *
 * ## 必须带正常 User-Agent
 *
 * 上游客户端挂了 `CloudflareInterceptor` 和 `UserAgentInterceptor`，说明这个站
 * 有 Cloudflare 盾。Electron 主进程里 `fetch` 默认 UA 带 `Electron/`，
 * 那是个非常显眼的非浏览器标记 —— 拿到的会是挑战页 HTML 而不是内容，
 * 而挑战页照样是 200，解析器只会安静地返回空结果。所以 UA 必须覆盖。
 *
 * ## 拿到挑战页要说出来，不能当「没搜到」
 *
 * 这是这个文件里最要紧的一条。盾挡下来和真的没有结果，HTTP 状态都是 200，
 * 区别只在 HTML 内容。不分辨的话用户看到的是「刮不到，重试也刮不到」，
 * 而真实原因是 IP 被盾盯上了 —— 那需要用户换网络或者等一会儿，
 * 是完全不同的下一步动作。`looksLikeChallenge` 就为这个存在。
 *
 * ## 配额按「别把用户 IP 打进挑战页」定，不按额度
 *
 * hanime 是免费公开页面，不烧用户的 API 额度。但请求太密会被盾盯上，
 * 而代价落在用户的 IP 上（之后用浏览器访问也要过挑战）。所以这里的上限
 * 比 TMDB 更紧，且带一个进程内缓存 —— 一次扫描里同一部作品的多集
 * 会命中同一个详情页。
 */

import {
  HANIME_BASE,
  parseDetail,
  parseSearch,
  searchUrl,
  watchUrl,
  type HanimeDetail,
  type HanimeHit
} from './selectors.ts'

/** 单次请求超时。盾的挑战页有时故意慢，等太久会把整次识别拖死 */
const TIMEOUT = 15_000

/**
 * 一次识别里最多取几个页面。
 *
 * 比 TMDB 的 4 次更紧，理由不是额度而是盾：被盯上之后代价落在用户 IP 上。
 * 搜索 1 次 + 详情 1 次是正常路径，留一点余量给「第一个候选不对，换第二个」。
 */
export const MAX_HANIME_FETCHES = 4

/** 装成一个普通 Chrome。Electron 默认 UA 带 `Electron/`，那是显眼的非浏览器标记 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 进程内缓存，按 URL。
 *
 * 和 tmdb.ts 的 cache 同一个用途：一次扫描里同一部作品的多个文件会查同一个
 * 详情页。这里比那边更需要它 —— 省下的不是额度，是「别被盾盯上」。
 */
const cache = new Map<string, string>()

export function clearHanimeCache(): void {
  cache.clear()
}

/**
 * 取页用哪个 fetch。默认 `globalThis.fetch`，主进程会换成 Electron 的
 * Hanime 专用 session.fetch（见 `electron/services/proxy.ts`）。
 *
 * ## 为什么非得能换
 *
 * 主进程里的 `globalThis.fetch` 是 **Node 的 undici**，它不看
 * `session.setProxy`，也不看 `--proxy-server` —— 配了代理却不生效，
 * 表现是「代理设置没保存」，很难往这儿想。只有走 Chromium 网络栈的
 * session.fetch 才吃对应 session 上那份代理配置。
 *
 * 而这个文件不能直接 `import { net } from 'electron'`：`npm run selfcheck` 和
 * `verify-hentai-e2e` 都在**纯 Node** 下跑，一 import 就崩在加载阶段。
 * 于是留一个注入点：主进程注入，脚本不注入、照旧走 `globalThis.fetch`
 * （e2e 正是靠替掉它来喂 fixture 的）。
 *
 * 类型用 `typeof globalThis.fetch`，因为 session.fetch 和它签名兼容，
 * 注入端不用包一层适配。
 */
let injected: typeof globalThis.fetch | null = null
let challengeHandler: ((url: string) => Promise<string | null>) | null = null

/** 传 `null` 恢复默认。主进程在代理配置变化时会重新注入 */
export function setHanimeFetch(f: typeof globalThis.fetch | null): void {
  injected = f
}

export function setHanimeChallengeHandler(
  handler: ((url: string) => Promise<string | null>) | null
): void {
  challengeHandler = handler
}

/** 供 Hanime 封面等同源资源复用与页面相同的网络栈。 */
export function fetchHanimeResource(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
): ReturnType<typeof globalThis.fetch> {
  return (injected ?? globalThis.fetch)(input, init)
}

/**
 * Cloudflare 挑战页的特征。
 *
 * 挑战页是 200 + 一段 JS，不是 403 —— 所以只能看内容。这几个标记里
 * `cf-browser-verification` 和 `__cf_chl` 是老版盾，`Just a moment` 是新版的
 * 页面标题。`challenge-platform` 不能单独作为判据：正常 Hanime 页面也会加载
 * 同名脚本。
 * 命中任一就当挑战页，宁可误报一次（表现是报错让用户重试），
 * 也别把挑战页当成「站上没有这部作品」。
 */
export function looksLikeChallenge(html: string): boolean {
  const s = String(html ?? '')
  if (s.length > 200_000) return false
  return /cf-browser-verification|__cf_chl|Just a moment|Checking your browser|Attention Required|cf-error-details|you have been blocked|verify you are human/i.test(s)
}

/** 这次识别的取页预算。一条 ctx 一份，用完就不再发请求 */
export interface HanimeBudget {
  used: number
}

export function newBudget(): HanimeBudget {
  return { used: 0 }
}

/**
 * 取一个页面的 HTML。这个文件里**唯一**碰网络的函数。
 *
 * 失败一律抛，由调用方（工具层）转成模型看得懂的一句话 —— 和 tmdb.ts 里
 * `get()` 的约定一致：解析层降级返回空，传输层抛。
 */
async function getHtml(url: string, budget: HanimeBudget): Promise<string> {
  const hit = cache.get(url)
  if (hit !== undefined) return hit

  if (budget.used >= MAX_HANIME_FETCHES) {
    throw new Error(`这次识别的 hanime 取页次数已经用完（上限 ${MAX_HANIME_FETCHES} 次）`)
  }
  budget.used += 1

  // 注入的优先。**每次都重新读** `injected` 而不是在模块顶层取一次 ——
  // 注入发生在主进程 ready 之后，而这个模块可能更早被 import
  const doFetch = injected ?? globalThis.fetch
  const request = () =>
    doFetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-TW,zh;q=0.9,ja;q=0.8,en;q=0.7',
        Accept: 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(TIMEOUT)
    })
  let res = await request()

  let html = await res.text()
  let recoveredFromBrowser = false
  const blocked = (r: Response, body = '') =>
    r.status === 403 || r.status === 503 || looksLikeChallenge(body) ||
    r.headers?.get?.('cf-mitigated') === 'challenge'

  if (blocked(res, html) && challengeHandler) {
    const browserHtml = await challengeHandler(url)
    if (browserHtml && !looksLikeChallenge(browserHtml)) {
      html = browserHtml
      recoveredFromBrowser = true
    }
  }

  if (!res.ok && !recoveredFromBrowser) {
    // 403 / 503 是盾的两种拒绝方式，和「这个页面不存在」要分开说
    if (res.status === 403 || res.status === 503) {
      throw new Error(`hanime 拒绝了这次请求（HTTP ${res.status}），大概是 Cloudflare 盾，稍后再试`)
    }
    if (res.status === 404) throw new Error('hanime 上没有这个页面（404）')
    throw new Error(`hanime HTTP ${res.status}`)
  }

  // 挑战页是 200，不看内容分辨不出来 —— 而它和「没搜到」的下一步动作完全不同
  if (looksLikeChallenge(html)) {
    throw new Error('hanime 返回了 Cloudflare 挑战页，不是内容。换个网络或稍后再试')
  }

  cache.set(url, html)
  return html
}

/**
 * 用作品名搜。返回按站方顺序排的候选，**不替调用方选** ——
 * 和 tmdbSearch 同一个约定：排序交给站方，挑哪个交给模型。
 */
export async function hanimeSearch(
  query: string,
  budget: HanimeBudget,
  opts: { page?: number; tags?: string[]; base?: string; limit?: number } = {}
): Promise<HanimeHit[]> {
  const q = String(query ?? '').trim()
  if (!q) return []
  const base = opts.base || HANIME_BASE
  const html = await getHtml(searchUrl(q, { ...opts, base }), budget)
  const hits = parseSearch(html, base)
  return opts.limit && opts.limit > 0 ? hits.slice(0, opts.limit) : hits
}

/** 按 videoCode 取详情。null = 这个 code 拼不出地址 */
export async function hanimeDetail(
  videoCode: string,
  budget: HanimeBudget,
  base = HANIME_BASE
): Promise<HanimeDetail | null> {
  const url = watchUrl(videoCode, base)
  if (!url) return null
  const detail = parseDetail(await getHtml(url, budget), base)
  // 页面上 og:url 缺失时回填传进来的那个 —— 调用方要靠它入库
  return { ...detail, videoCode: detail.videoCode || String(videoCode).trim() }
}
