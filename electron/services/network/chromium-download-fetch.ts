import { Readable } from 'node:stream'
import type { ClientRequest, ClientRequestConstructorOptions, Session } from 'electron'

/**
 * Electron 37 session.fetch({redirect:'manual'}) rejects on redirect rather than
 * returning a 3xx Response. Adapt net.request's redirect event for the caller's
 * bounded redirect loop, using the requested credential mode in the same session.
 * This adapter is intentionally GET/manual-only, not a general fetch replacement.
 */
export function createChromiumDownloadFetch(
  request: (options: ClientRequestConstructorOptions) => ClientRequest,
  session: Session
): typeof globalThis.fetch {
  return async (input, init) => {
    const address = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error('下载地址必须是不含凭据的 HTTP(S) 地址')
    const url = address.href
    if ((init?.method ?? 'GET').toUpperCase() !== 'GET' || init?.body || init?.redirect !== 'manual') throw new Error('下载网络适配器只支持手动重定向的 GET 请求')
    const signal = init?.signal
    signal?.throwIfAborted()
    return new Promise<Response>((resolve, reject) => {
      // CDN requests require the watch-page Referer. Chromium rejects an explicit
      // full cross-origin Referer under its default strict-origin policy.
      const credentials = init?.credentials === 'omit' ? 'omit' : 'include'
      const req = request({ url, method: 'GET', session, useSessionCookies: credentials === 'include', credentials, redirect: 'manual', referrerPolicy: 'unsafe-url' })
      let incoming: any
      let settled = false
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const fail = (err: Error) => {
        cleanup()
        if (!settled) { settled = true; reject(err) }
        if (incoming && !incoming.destroyed) incoming.destroy(err)
      }
      const abort = () => {
        fail(signal?.reason instanceof Error ? signal.reason : new Error('下载已取消'))
        req.abort()
      }
      req.on('error', fail)
      req.on('redirect', (status, _method, location) => {
        if (settled) return
        // Do NOT followRedirect: the transfer validates the new protocol and hop limit first.
        settled = true
        cleanup()
        resolve(new Response(null, { status, headers: { location } }))
        req.abort()
      })
      req.on('response', (response: any) => {
        if (settled) { response.destroy(); return }
        incoming = response
        let ended = false
        response.once('end', () => { ended = true; cleanup() })
        response.once('close', () => { cleanup(); if (!ended) req.abort() })
        response.on('error', fail)
        try {
          const headers = new Headers()
          for (const [name, values] of Object.entries(response.headers)) {
            for (const value of Array.isArray(values) ? values : [values]) if (value !== undefined) headers.append(name, value)
          }
          const noBody = [204, 205, 304].includes(response.statusCode)
          const body = noBody ? null : Readable.toWeb(response as any) as ReadableStream<Uint8Array>
          const result = new Response(body, { status: response.statusCode, headers })
          settled = true
          resolve(result)
          if (noBody) response.resume()
        } catch (err) { fail(err instanceof Error ? err : new Error(String(err))); req.abort() }
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const headers = new Headers(init?.headers)
        headers.forEach((value, name) => {
          if (/^(cookie|authorization|proxy-authorization)$/i.test(name)) throw new Error('下载凭据只能由专用网络会话管理')
          req.setHeader(name, value)
        })
        req.end()
      } catch (err) { fail(err instanceof Error ? err : new Error(String(err))); req.abort() }
    })
  }
}
