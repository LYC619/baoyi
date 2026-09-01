/**
 * 出站代理：把设置里的那串规则铺到 Chromium 的 session 上，并把 hanime 的取页
 * 切到 `net.fetch`（走 Chromium 网络栈，才吃得到这份代理配置）。
 *
 * ## 为什么不是「设一下 session 就完了」
 *
 * 主进程里有两套网络栈，各走各的：
 *
 * | 谁 | 栈 | 吃 session 的代理吗 |
 * |---|---|---|
 * | `globalThis.fetch` | Node 的 undici | **不吃** |
 * | `net.fetch` / `net.request` | Chromium | 吃 |
 * | 渲染进程里的请求、`<img>` | Chromium | 吃 |
 *
 * 所以只调 `session.setProxy` 而取页仍用 `globalThis.fetch` 的话，代理**完全
 * 不生效**，而表现是「配了没反应」—— 一个很难往网络栈上想的现象。反过来，
 * 只换 fetch 不设 session 也不行，`net.fetch` 得有地方读代理规则。两件事都要做，
 * 这个文件就是把它们绑在一起的地方。
 *
 * TMDB / 豆瓣仍走 undici，不受代理管。它们本来也不在需要代理的名单上；真要加，
 * 照这里的注入点做一遍即可（各自的 `get()` 也要能换 fetch）。
 */
import { app, net, session } from 'electron'
import { setHanimeFetch } from '../kinds/video/hentai/hanime.ts'
import { normalizeProxyRules } from './proxy-rules.ts'

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

/**
 * 把代理铺到默认 session，并按需把 hanime 的取页切到 `net.fetch`。
 *
 * 空串 = 直连：这时**主动清掉** session 上的代理（`direct://`），并把 hanime 的
 * fetch 恢复成默认。不清的话「把代理删掉再保存」不会真的断开代理，
 * 那属于设置骗人。
 *
 * 必须在 `app.whenReady()` 之后调 —— `session.defaultSession` 在那之前是 undefined。
 */
export async function applyProxy(raw: string): Promise<string> {
  const rules = normalizeProxyRules(raw)
  if (rules === applied) return rules
  applied = rules

  await session.defaultSession.setProxy(
    rules === '' ? { mode: 'direct' } : { proxyRules: rules }
  )

  // 有代理时才切到 net.fetch。没代理时留在 undici 上，理由是少改动一处行为：
  // 直连这条路 v0.8 一路都是 undici 跑过来的，没必要换个栈重新赌一遍
  setHanimeFetch(rules === '' ? null : netFetch)
  return rules
}

/**
 * `net.fetch` 的一层薄包装，签名对齐 `globalThis.fetch`。
 *
 * `net.fetch` 默认用 `session.defaultSession`，也就是上面 `setProxy` 铺过的那个。
 * `credentials: 'omit'` 是刻意的：取的是公开页面，不该把 session 里的 cookie
 * 带出去。
 */
const netFetch: typeof globalThis.fetch = (input, init) =>
  net.fetch(input as any, { ...(init as any), credentials: 'omit' }) as any

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
  return session.defaultSession.resolveProxy(url)
}
