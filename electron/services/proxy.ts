/**
 * 出站代理：把设置里的那串规则铺到 Hanime 专用 Chromium session 上，并把
 * hanime 的取页切到该 session 的 `fetch`（才吃得到这份代理配置）。
 *
 * ## 为什么不是「设一下 session 就完了」
 *
 * 主进程里有两套网络栈，各走各的：
 *
 * | 谁 | 栈 | 吃 session 的代理吗 |
 * |---|---|---|
 * | `globalThis.fetch` | Node 的 undici | **不吃** |
 * | `hanimeSession.fetch` | Chromium | 吃 |
 * | 渲染进程里的请求、`<img>` | Chromium | 吃 |
 *
 * 所以只调 `session.setProxy` 而取页仍用 `globalThis.fetch` 的话，代理**完全
 * 不生效**，而表现是「配了没反应」—— 一个很难往网络栈上想的现象。反过来，
 * 只换 fetch 不设 session 也不行，session.fetch 得有地方读代理规则。两件事都要做，
 * 这个文件就是把它们绑在一起的地方。
 *
 * TMDB / 豆瓣以及默认 session 的其他请求不受这条代理管。代理只服务 Hanime，
 * 避免用户为刮削配置的线路意外改变其他来源的访问行为。
 */
import { app, BrowserWindow, session, type Session } from 'electron'
import {
  looksLikeChallenge,
  setHanimeChallengeHandler,
  setHanimeFetch
} from '../kinds/video/hentai/hanime.ts'
import {
  normalizeProxyRules,
  parseProxyInput,
  serializeProxyInput,
  toElectronProxyConfig,
  usesChromiumFetch
} from './proxy-rules.ts'
import {
  getHanimeHostsStatus,
  isConnectionFailure,
  isHanimeHost,
  isUnreachableLoadError,
  orderedHanimeIps,
  HANIME_BROWSER_UA,
  HANIME_CLOUDFLARE_IPS
} from './hanime-network-rules.ts'
import { fetchViaAddress } from './hanime-direct.ts'

export { normalizeProxyRules }

/**
 * **刻意不设 `proxyBypassRules`。**
 *
 * Chromium 默认就绕开 loopback，不用额外写规则。而看起来像是「排除回环」的那个
 * `<-loopback>` 恰恰相反 —— 它是**减掉**那条隐式规则，也就是把 `127.0.0.1`
 * 塞进代理。第一版就这么写的，`verify-proxy.cjs` 里
 * `resolveProxy('http://127.0.0.1:1/')` 回的是 `SOCKS5 127.0.0.1:10808`
 * 而不是 `DIRECT`，当场把它抓出来了。
 *
 * 那个写法的代价：本地回环请求全被塞给代理，代理未必转得动 —— 而现象会是
 * 「配上代理之后本地的东西开始出毛病」，几乎不会有人往代理的 bypass 规则上想。
 *
 * 留这段注释是因为 `<-loopback>` 这名字太像「排除 loopback」，下一个人很容易
 * 又加回去。要真需要自定义排除项，写域名列表（`*.example.com`），别碰这个符号。
 */

/** 记住上一次铺下去的规则，避免每次设置保存都白跑一趟 setProxy */
let applied: string | null = null
let hanimeSession: Session | null = null

/**
 * 内置 Hosts 的运行时状态。`enabled` 来自设置（main.ts 启动时、设置页改动时写入）；
 * `activeIp` 是运行时回退最近一次通了的地址，下次先试它。
 * 启动前写进 Chromium 的那条规则改不了，所以开关对 Chromium 那层要重启才生效，
 * 对这里的取页回退即时生效。
 */
const hosts = { enabled: true, activeIp: '', startupIp: HANIME_CLOUDFLARE_IPS[0] as string }
let proxyDirect = true
/** 回退换到新地址时把它记下来（main.ts 接到设置里），下次启动的 Chromium 规则直接用它 */
let rememberActiveIp: (ip: string) => void = () => {}

/**
 * `startupIp` / `remember` 只在 main.ts 启动时给一次；设置页开关走这里时只改 enabled，
 * 不传就保留原值 —— 启动地址在 Chromium 里已经定死，中途改这个数只会让状态页撒谎。
 */
export function setHanimeHostsEnabled(
  enabled: boolean,
  options: { startupIp?: string; remember?: (ip: string) => void } = {}
): void {
  hosts.enabled = enabled !== false
  if (options.startupIp) hosts.startupIp = options.startupIp
  if (options.remember) rememberActiveIp = options.remember
  if (!hosts.enabled) hosts.activeIp = ''
}
let challenge: { window: BrowserWindow; url: string; result: Promise<string | null> } | null = null
export function getHanimeSession(): Session {
  if (!app.isReady()) throw new Error('Hanime 网络 session 只能在应用 ready 后创建')
  return (hanimeSession ??= session.fromPartition('persist:hanime-network'))
}

/**
 * 把代理铺到 Hanime 专用 session，并按需把 hanime 的取页切到该 session 的 fetch。
 *
 * 空串 = 直连：这时**主动清掉** Hanime session 上的代理（`direct://`），并让
 * hanime 继续使用该 session。不清的话「把代理删掉再保存」不会真的断开代理，
 * 那属于设置骗人。
 *
 * 必须在 `app.whenReady()` 之后调 —— session 在那之前不能创建。
 */
export async function applyProxy(raw: string): Promise<string> {
  const input = parseProxyInput(raw)
  const rules = serializeProxyInput(input)
  if (rules === applied) return rules

  await getHanimeSession().setProxy(toElectronProxyConfig(input))
  applied = rules
  proxyDirect = input.mode === 'direct'

  // Hanime 无论直连还是代理都走 Chromium 网络栈：只有它能吃到内置 Hosts
  // 规则；代理模式另外决定 session 的路由。
  setHanimeFetch(usesChromiumFetch(input) ? hanimeFetch : null)
  setHanimeChallengeHandler(openHanimeChallenge)
  return rules
}

/**
 * Hanime session.fetch 的一层薄包装，签名对齐 `globalThis.fetch`。
 *
 * Hanime 的 Cloudflare 验证结果保存在这个专用 session 里，所以必须让请求带上
 * session cookie；该 session 只服务 Hanime，不会把 cookie 扩散到其他站点。
 */
const netFetch: typeof globalThis.fetch = (input, init) =>
  getHanimeSession().fetch(input as any, { ...(init as any), credentials: 'include' }) as any

function urlOf(input: Parameters<typeof globalThis.fetch>[0]): URL | null {
  try { return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) } catch { return null }
}

/** 把专用 session 里的 cookie（含 Cloudflare 验证结果）带到直连回退的请求上 */
async function sessionCookieHeader(url: URL): Promise<string> {
  try {
    const cookies = await getHanimeSession().cookies.get({ url: url.origin })
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch { return '' }
}

/**
 * 先走 Chromium（吃启动规则和代理）；线路不通且处于直连 + 内置 Hosts 开启时，
 * 按地址池顺序换 IP 直连重试。有回应（哪怕 403）就不算线路问题，不换。
 */
const hanimeFetch: typeof globalThis.fetch = async (input, init) => {
  try {
    return await netFetch(input, init)
  } catch (cause) {
    const url = urlOf(input)
    if (!hosts.enabled || !proxyDirect || !url || !isHanimeHost(url.hostname) || !isConnectionFailure(cause)) throw cause
    const cookie = await sessionCookieHeader(url)
    const headers = new Headers(init?.headers as HeadersInit | undefined)
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie)
    let last: unknown = cause
    for (const ip of orderedHanimeIps(hosts.activeIp, [hosts.startupIp])) {
      try {
        const response = await fetchViaAddress(url, ip, { ...init, headers })
        if (hosts.activeIp !== ip) {
          console.log(`[hanime] 内置 Hosts 启动地址 ${hosts.startupIp} 不通，已改用 ${ip}；重启后验证窗口和下载也会用它`)
          hosts.activeIp = ip
          try { rememberActiveIp(ip) } catch (error) { console.warn('[hanime] 可用地址没能写进设置：', (error as Error).message) }
        }
        return response
      } catch (error) {
        if (!isConnectionFailure(error)) throw error
        last = error
      }
    }
    throw last
  }
}


function isHanimePageUrl(url: string): boolean {
  try {
    const target = new URL(url)
    return (target.protocol === 'https:' || target.protocol === 'http:') &&
      !target.username && !target.password && isHanimeHost(target.hostname)
  } catch {
    return false
  }
}

async function openHanimeChallenge(url: string): Promise<string | null> {
  if (!app.isReady() || !isHanimePageUrl(url)) return null
  url = new URL(url).href
  try {
    const active = challenge
    if (active && !active.window.isDestroyed()) {
      active.window.focus()
      if (active.url === url) return await active.result
      // HTML is returned to the scraper for its requested URL. Never share a
      // different page's HTML: finish this verification before opening that URL.
      await active.result
      return await openHanimeChallenge(url)
    }
    const win = new BrowserWindow({
      width: 900,
      height: 760,
      title: 'Hanime Cloudflare 验证',
      autoHideMenuBar: true,
      webPreferences: { session: getHanimeSession(), contextIsolation: true, nodeIntegration: false }
    })
    const attempt = { window: win, url, result: Promise.resolve<string | null>(null) }
    challenge = attempt
    attempt.result = waitForHanimePage(win, url).catch(() => null).finally(() => {
      // An old closed/load/evaluation continuation must only clean up its owner.
      if (challenge === attempt) challenge = null
      if (!win.isDestroyed()) win.close()
    })
    return await attempt.result
  } catch {
    return null
  }
}

export async function openHanimeVerification(url: string): Promise<boolean> {
  return (await openHanimeChallenge(url)) !== null
}

async function waitForHanimePage(win: BrowserWindow, requestedUrl: string): Promise<string | null> {
  const contents = win.webContents
  const requested = new URL(requestedUrl)
  let navigation = 0
  let httpStatus = 0
  let cancelled = false
  let cancel!: () => void
  const stopped = new Promise<null>((resolve) => {
    cancel = () => { cancelled = true; resolve(null) }
  })
  // This deadline also covers loadURL/executeJavaScript promises that never settle.
  const timeout = setTimeout(cancel, 120_000)
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  const onStart = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) { navigation++; httpStatus = 0 }
  }
  const onNavigate = (_event: Electron.Event, _url: string, status: number) => { httpStatus = status }
  const onFail = (_event: Electron.Event, code: number, description: string, _url: string, mainFrame: boolean) => {
    // ERR_ABORTED belongs to a superseded navigation, possibly after its successor.
    if (!mainFrame || code === -3) return
    navigation++; httpStatus = 0
    // 根本连不上（启动地址死了、断网、代理挂了）时窗口永远等不到内容，
    // 立刻结束而不是耗满 120 秒；真机上撞过：启动地址被拒，取页回退已经换了地址，
    // 验证窗口却还在死等那个旧地址
    if (isUnreachableLoadError(code, description)) {
      console.warn(`[hanime] 验证窗口连不上站点（${description}）；` +
        (hosts.enabled && hosts.activeIp ? `已记住可用地址 ${hosts.activeIp}，重启后生效` : '请检查网络或内置 Hosts 设置'))
      cancel()
    }
  }
  const onWillNavigate = (event: Electron.Event, url: string) => {
    if (!isHanimePageUrl(url)) event.preventDefault()
  }
  const onRedirect = (event: Electron.Event, url: string, _inPlace: boolean, mainFrame: boolean) => {
    // Do not block Cloudflare's isolated challenge iframe redirects.
    if (mainFrame) onWillNavigate(event, url)
  }
  try {
    win.once('closed', cancel)
    contents.once('destroyed', cancel)
    contents.once('render-process-gone', cancel)
    contents.on('did-start-navigation', onStart)
    contents.on('did-navigate', onNavigate)
    contents.on('did-fail-load', onFail)
    contents.on('will-navigate', onWillNavigate)
    contents.on('will-redirect', onRedirect)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.setUserAgent(HANIME_BROWSER_UA)
    // A click/reload can reject this initial promise while the window continues
    // navigating. Document events, not the initial load promise, decide readiness.
    void win.loadURL(requestedUrl).catch(() => {})
    while (!cancelled && !win.isDestroyed() && !contents.isDestroyed()) {
      const version = navigation
      if (!contents.isLoadingMainFrame() && httpStatus >= 200 && httpStatus < 300) {
        const currentUrl = contents.getURL()
        const page = await Promise.race([
          contents.executeJavaScript(
            `({
              ready: document.readyState === 'complete',
              href: location.href,
              title: document.title,
              html: document.documentElement?.outerHTML || '',
              hasContent: !!document.body?.innerText?.trim() && !!document.querySelector(
                '.content-padding-new, .home-rows-videos-wrapper, #shareBtn-title, .video-details-title'
              )
            })`,
            true
          ).catch(() => null),
          stopped
        ])
        if (cancelled || win.isDestroyed() || contents.isDestroyed()) return null
        if (version === navigation && !contents.isLoadingMainFrame() &&
          currentUrl === contents.getURL() && isHanimePageUrl(currentUrl) &&
          page?.href === currentUrl && page.ready && page.hasContent &&
          typeof page.html === 'string' && page.html.length > 1000 &&
          !looksLikeChallenge(page.title) && !looksLikeChallenge(page.html)) {
          const target = new URL(currentUrl)
          // Mirror redirects and fragment changes are fine; another search/detail
          // is not the HTML requested by the caller.
          if (target.pathname === requested.pathname && target.search === requested.search) return page.html
        }
      }
      await Promise.race([
        new Promise<void>((resolve) => { pollTimer = setTimeout(resolve, 1000) }),
        stopped
      ])
    }
    return null
  } finally {
    cancel()
    clearTimeout(timeout)
    clearTimeout(pollTimer)
    win.removeListener('closed', cancel)
    contents.removeListener('destroyed', cancel)
    contents.removeListener('render-process-gone', cancel)
    contents.removeListener('did-start-navigation', onStart)
    contents.removeListener('did-navigate', onNavigate)
    contents.removeListener('did-fail-load', onFail)
    contents.removeListener('will-navigate', onWillNavigate)
    contents.removeListener('will-redirect', onRedirect)
  }
}

export function getHanimeNetworkStatus(url = 'https://hanime1.me/') {
  return {
    ...getHanimeHostsStatus(hosts),
    proxyRules: applied ?? normalizeProxyRules(''),
    url
  }
}

/**
 * 启动时调一次。读设置里的 proxy 铺下去。
 *
 * 单独一个函数而不是让 main.ts 直接调 `applyProxy(getSettings().proxy)`：
 * 这里要吞掉异常。代理规则是用户填的，填错了 `setProxy` 会 reject，而那
 * **不该拦住启动** —— 拦住的表现是「填错一个代理地址，应用再也打不开」。
 */
export async function initProxy(read: () => string): Promise<void> {
  try {
    const rules = await applyProxy(read())
    if (rules !== '') console.log(`[proxy] 已启用：${rules}`)
  } catch (err) {
    applied = null
    // 首次启动就填了坏代理时，仍要让 Hanime 走 Chromium session，才能吃到
    // 启动前注入的内置 Hosts 规则。回退失败才退到默认 fetch。
    try {
      await getHanimeSession().setProxy({ mode: 'direct' })
      proxyDirect = true
      setHanimeFetch(hanimeFetch)
    } catch {
      setHanimeFetch(null)
    }
    console.error(`[proxy] 代理设置没能生效，这次按直连跑：${(err as Error).message}`)
  }
}

/** 供设置页保存后调用。返回一句给用户看的话，出错也不抛 */
export async function reapplyProxy(raw: string): Promise<{ ok: boolean; message: string }> {
  try {
    const rules = await applyProxy(raw)
    return { ok: true, message: rules === '' ? '已切回直连' : `代理已生效：${rules}` }
  } catch (err) {
    // 失败时把记录的状态清掉，否则下次填同样的值会被 `rules === applied` 短路掉，
    // 看起来像「保存了但没反应」
    applied = null
    return { ok: false, message: `代理设置没生效：${(err as Error).message}` }
  }
}

/** 诊断用：问 Chromium 某个地址实际会走哪条代理 */
export async function resolveProxyFor(url: string): Promise<string> {
  if (!app.isReady()) return '（应用还没 ready）'
  return getHanimeSession().resolveProxy(url)
}
