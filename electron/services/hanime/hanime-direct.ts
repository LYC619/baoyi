/**
 * 绕过 DNS、直接连到指定 IP 取 Hanime 页面 —— 内置 Hosts 的运行时回退。
 *
 * Chromium 的 host-resolver-rules 一个域名只能指一个地址，且启动后改不了。
 * 那个地址不通时，这里用 Node 的 https 按地址池换下一个 IP：TCP 连 IP，
 * TLS 的 SNI 和 HTTP 的 Host 仍写域名，Cloudflare 靠这两样把请求路由到站点。
 *
 * 只在**直连**模式下使用：配了代理时 DNS 由代理那边做，本地换 IP 没有意义，
 * 而且绕开代理直接出去等于把用户的线路选择作废。
 *
 * 不 import Electron，自检脚本可以在纯 Node 下验它。
 */
import https from 'node:https'
import { isHanimeHost } from './hanime-network-rules.ts'

const MAX_REDIRECTS = 5
const MAX_BODY = 32 * 1024 * 1024

type FetchInput = Parameters<typeof globalThis.fetch>[0]
type FetchInit = Parameters<typeof globalThis.fetch>[1]

function headersOf(init: FetchInit): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = init?.headers
  if (!raw) return out
  if (raw instanceof Headers) { raw.forEach((v, k) => { out[k] = v }); return out }
  if (Array.isArray(raw)) { for (const [k, v] of raw) out[k] = v; return out }
  for (const [k, v] of Object.entries(raw)) out[k] = String(v)
  return out
}

function requestOnce(url: URL, ip: string, init: FetchInit, timeout: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = { ...headersOf(init), host: url.host }
    const req = https.request({
      host: ip,
      port: url.port ? Number(url.port) : 443,
      servername: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
      timeout
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY) { req.destroy(new Error('响应超过 32 MB')); return }
        chunks.push(chunk)
      })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        const responseHeaders = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue
          for (const item of Array.isArray(v) ? v : [v]) responseHeaders.append(k, item)
        }
        const body = status === 204 || status === 304 || method === 'HEAD' ? null : Buffer.concat(chunks)
        resolve(new Response(body, { status, statusText: res.statusMessage ?? '', headers: responseHeaders }))
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error(`连接 ${ip} 超时`), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    const signal = init?.signal
    if (signal) {
      if (signal.aborted) { req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted')); return }
      signal.addEventListener('abort', () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted')), { once: true })
    }
    const body = init?.body
    if (body === undefined || body === null) req.end()
    else if (typeof body === 'string' || body instanceof Uint8Array) req.end(body)
    else reject(new Error('直连回退只支持字符串或二进制请求体'))
  })
}

/**
 * 像 `fetch` 一样取 `url`，但连的是 `ip`。跟随同站重定向（最多 5 次），
 * 跨到非 Hanime 域名的重定向原样返回给调用方，不替它出站。
 */
export async function fetchViaAddress(input: FetchInput, ip: string, init?: FetchInit, timeout = 15_000): Promise<Response> {
  let url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.protocol !== 'https:') throw new Error('直连回退只支持 https')
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(url, ip, init, timeout)
    const location = res.headers.get('location')
    if (!location || ![301, 302, 303, 307, 308].includes(res.status) || hop >= MAX_REDIRECTS) return res
    const next = new URL(location, url)
    if (next.protocol !== 'https:' || !isHanimeHost(next.hostname)) return res
    const keepMethod = res.status === 307 || res.status === 308
    init = keepMethod ? init : { ...init, method: 'GET', body: undefined }
    url = next
  }
}
