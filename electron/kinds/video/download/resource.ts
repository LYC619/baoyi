import { abortable, httpUrl, createDownloadTimeout, DOWNLOAD_QUEUE, type DownloadRequestInit } from './transfer.ts'

export class DownloadHttpError extends Error {
  readonly status: number
  constructor(status: number) { super('下载 HTTP ' + status + (status === 403 ? '：来源已过期或需要验证，请重新解析' : '')); this.status=status }
}
export function retryableDownloadError(error: unknown): boolean {
  return error instanceof DownloadHttpError ? [408,429,500,502,503,504].includes(error.status)
    : /超时|fetch failed|ERR_CONNECTION|ERR_NETWORK|ERR_HTTP2_(?:PING_FAILED|PROTOCOL_ERROR)|ERR_QUIC_PROTOCOL_ERROR|ERR_SPDY_PROTOCOL_ERROR|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket|terminated|premature close|网络|连接中断/i.test(error instanceof Error ? error.message : String(error))
}
export async function downloadDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort',abort); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve() }, ms)
    signal.addEventListener('abort',abort,{once:true})
  })
}
export async function openDownloadResponse(fetcher: typeof fetch, raw: string, init: RequestInit, signal: AbortSignal, tick: () => void = () => {}): Promise<{ response: Response; url: string }> {
  let url = httpUrl(raw)
  for (let hop = 0; ; hop++) {
    signal.throwIfAborted()
    const pending = fetcher(url, { ...init, signal, redirect: 'manual', cache: 'no-store' })
    void pending.then(res => { if(signal.aborted) void res.body?.cancel().catch(() => { /* best-effort */ }) },()=>{})
    const response = await abortable(pending, signal)
    tick()
    if (![301,302,303,307,308].includes(response.status)) return { response, url }
    void response.body?.cancel().catch(() => { /* best-effort */ })
    if(hop >= 5) throw new Error('下载重定向次数过多')
    const location = response.headers.get('location')
    if(!location) throw new Error('下载重定向缺少目标地址')
    url = httpUrl(location,url)
  }
}
export interface ResourceOptions {
  fetch: typeof fetch; url: string; headers: Record<string,string>; signal: AbortSignal
  range?: { start: number; end: number }; retries?: number; idleTimeoutMs?: number; maxBytes?: number
  onProgress?: (receivedBytes: number, totalBytes: number) => void
  onRetry?: (attempt: number) => void
  /** Supplied only after validating the local fragment hash and unchanged playlist structure. */
  conditional?: { data: Buffer; etag: string; resolved: string }
}
export const resourceUrlKey = (raw: string): string => { const url = new URL(raw); return url.origin + url.pathname }
export const strongResourceEtag = (raw: string | null): string | undefined => raw && /^"[^"\r\n]+"$/.test(raw) ? raw : undefined
export async function readDownloadResource(options: ResourceOptions): Promise<{ data: Buffer; url: string; headers: Headers }> {
  const retries = Math.min(4,Math.max(0,options.retries ?? 2))
  for(let attempt = 0; ; attempt++) {
    const watchdog = createDownloadTimeout(options.idleTimeoutMs ?? 30_000, '下载连接或读取长时间无进展，已超时')
    const signal = AbortSignal.any([options.signal,watchdog.controller.signal]), tick = watchdog.tick
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      signal.throwIfAborted(); tick()
      const headers = { ...options.headers, Accept:'*/*','Accept-Encoding':'identity', ...(options.range ? {Range:`bytes=${options.range.start}-${options.range.end}`} : {}), ...(options.conditional ? {'If-None-Match':options.conditional.etag} : {}) }
      const opened = await openDownloadResponse(options.fetch,options.url,{headers,[DOWNLOAD_QUEUE]:watchdog.queue} as DownloadRequestInit,signal,tick); response=opened.response
      if (response.status === 304 && options.conditional) {
        if (strongResourceEtag(response.headers.get('etag')) === options.conditional.etag && resourceUrlKey(opened.url) === options.conditional.resolved) {
          return { data: options.conditional.data, url: opened.url, headers: response.headers }
        }
        // A weak/missing validator or changed redirect target cannot establish byte identity.
        return readDownloadResource({ ...options, conditional: undefined })
      }
      if(!response.ok) throw new DownloadHttpError(response.status)
      if(options.range) {
        const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('content-range') || '')
        if(response.status !== 206 || !match || Number(match[1]) !== options.range.start || Number(match[2]) !== options.range.end) throw new Error('分段响应范围不匹配')
      } else if(response.status === 206) throw new Error('服务器只返回了部分资源')
      if(!response.body) throw new Error('下载资源为空')
      reader=response.body.getReader()
      const chunks: Buffer[] = []; let size=0
      const total = Number(response.headers.get('content-length')) || 0
      try { options.onProgress?.(0,total) } catch (cause) { console.error('[后台通知或记录]', cause) }
      for(;;) {
        const item=await abortable(reader.read(),signal); if(item.done) break
        tick(); size+=item.value.length
        if(size > (options.maxBytes ?? 64*1024*1024)) throw new Error('下载资源超过大小上限')
        chunks.push(Buffer.from(item.value))
        try { options.onProgress?.(size,total) } catch (cause) { console.error('[后台通知或记录]', cause) }
      }
      if(!size) throw new Error('下载资源为空')
      const declared=response.headers.get('content-length'), encoding=response.headers.get('content-encoding')
      if((!encoding || encoding==='identity') && declared && /^\d+$/.test(declared) && Number(declared)!==size) throw new Error('下载资源长度不符，连接中断')
      if(options.range && size!==options.range.end-options.range.start+1) throw new Error('分段响应长度不符')
      return {data:Buffer.concat(chunks),url:opened.url,headers:response.headers}
    } catch(error) {
      if(options.signal.aborted) throw options.signal.reason
      if(attempt>=retries || !retryableDownloadError(error)) throw error
      try { options.onRetry?.(attempt+1) } catch (cause) { console.error('[后台通知或记录]', cause) }
    } finally {
      watchdog.close()
      if(reader) { void reader.cancel().catch(() => { /* best-effort */ }); reader.releaseLock() }
      else void response?.body?.cancel().catch(() => { /* best-effort */ })
    }
    await downloadDelay(300*(attempt+1),options.signal)
  }
}
