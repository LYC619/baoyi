import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const DOWNLOAD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
export interface TransferProgress {
  phase: 'downloading' | 'finalizing'
  receivedBytes: number
  /** 0 = unknown; do not invent a percentage. */
  totalBytes: number
  bytesPerSecond: number
}
export interface TransferResult extends TransferProgress {
  destination: string
  warnings: string[]
}
export interface TransferOptions {
  url: string
  destination: string
  referer: string
  signal: AbortSignal
  fetch: typeof globalThis.fetch
  onProgress?: (progress: TransferProgress) => void
  idleTimeoutMs?: number
  /** Filesystem boundary for offline failure injection. */
  io?: typeof fs
}

export class DestinationExistsError extends Error {}

/** Keep signed URLs / credentials out of user-facing errors and logs. */
export function safeDownloadError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/\b(cookie|authorization)\s*[:=][^\r\n]*/gi, '$1=[已隐藏]')
    .replace(/[\r\n]+/g, ' ').slice(0, 1000)
}
export function httpUrl(raw: string, base?: string): string {
  const url = new URL(raw, base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('下载地址必须是不含凭据的 HTTP(S) 地址')
  }
  return url.href
}

/** Abort stalled boundaries even when a mock/underlying reader ignores its fetch signal. */
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    pending.then(value => { signal.removeEventListener('abort', aborted); resolve(value) }, err => {
      signal.removeEventListener('abort', aborted); reject(err)
    })
  })
}

function checkContainer(head: Buffer): void {
  const text = head.toString('utf8').trimStart()
  if (/^#EXTM3U/i.test(text)) throw new Error('收到 HLS 分片清单，当前只支持直链视频下载')
  if (head.length === 0) throw new Error('服务器返回空视频文件')
  // Verify the container rather than trusting an .mp4 URL or a server's MIME header.
  const box = head.subarray(4, 8).toString('ascii')
  const iso = head.length >= 12 && ['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(box)
  const webm = head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  const avi = head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'AVI '
  const ogg = head.subarray(0, 4).toString() === 'OggS'
  const mpeg = head.length >= 4 && head[0] === 0 && head[1] === 0 && head[2] === 1 && [0xba, 0xb3].includes(head[3])
  if (!iso && !webm && !avi && !ogg && !mpeg) {
    throw new Error('返回内容不是受支持的视频文件，可能是登录或 Cloudflare 验证页面')
  }
}

/** Stream to a private sibling, then publish without ever replacing an existing target. */
export async function transferVideo(options: TransferOptions): Promise<TransferResult> {
  const io = options.io ?? fs
  const destination = path.resolve(options.destination)
  if (!path.isAbsolute(options.destination)) throw new Error('下载保存位置必须是绝对路径')
  let url = httpUrl(options.url)
  const referer = httpUrl(options.referer)
  const timeout = new AbortController()
  const signal = AbortSignal.any([options.signal, timeout.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  const resetTimer = () => {
    clearTimeout(timer)
    timer = setTimeout(() => timeout.abort(new Error('下载连接或读取长时间无进展，已超时')), options.idleTimeoutMs ?? 30_000)
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let response: Response | undefined
  let temporary = ''
  let published = false
  let failure: unknown
  let receivedBytes = 0
  let totalBytes = 0
  let bytesPerSecond = 0
  let lastTick = 0
  let phase: TransferProgress['phase'] = 'downloading'
  const warnings: string[] = []
  const started = Date.now()
  const emit = (force = false) => {
    const now = Date.now()
    if (!force && now - lastTick < 250) return
    lastTick = now
    bytesPerSecond = Math.round(receivedBytes * 1000 / Math.max(1, now - started))
    try { options.onProgress?.({ phase, receivedBytes, totalBytes, bytesPerSecond }) } catch { /* UI observers cannot damage a transfer. */ }
  }
  try {
    signal.throwIfAborted()
    try {
      await io.lstat(destination)
      throw new DestinationExistsError('目标文件已存在，请另选文件名；不会覆盖已有文件')
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
    resetTimer()
    for (let redirects = 0; ; redirects++) {
      const pending = options.fetch(url, {
        headers: { 'User-Agent': DOWNLOAD_UA, Referer: referer, Accept: '*/*', 'Accept-Encoding': 'identity' },
        signal, redirect: 'manual'
      })
      // If cancellation wins before headers, dispose a late response instead of leaking its body.
      void pending.then(res => { if (signal.aborted) void res.body?.cancel().catch(() => {}) }, () => {})
      response = await abortable(pending, signal)
      resetTimer()
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      void response.body?.cancel().catch(() => {})
      if (redirects >= 5) throw new Error('下载重定向次数过多')
      const location = response.headers.get('location')
      if (!location) throw new Error('下载重定向缺少目标地址')
      url = httpUrl(location, url)
    }
    if (!response.ok || response.status === 206 || response.headers.has('content-range')) {
      throw new Error('下载 HTTP ' + response.status + (response.status === 403 ? '：请完成内置 Cloudflare 验证后重新解析' : '：未收到完整视频响应'))
    }
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (mime && !mime.startsWith('video/') && !['application/octet-stream', 'binary/octet-stream', 'application/mp4'].includes(mime)) {
      throw new Error('服务器未返回视频内容（' + mime + '），请验证后重新解析；分片清单暂不支持')
    }
    const length = response.headers.get('content-length') ?? ''
    const encoding = response.headers.get('content-encoding')
    if ((!encoding || encoding === 'identity') && /^\d+$/.test(length) && Number.isSafeInteger(Number(length))) totalBytes = Number(length)
    if (!response.body) throw new Error('服务器返回空视频响应')
    const candidate = path.join(path.dirname(destination), '.' + path.basename(destination) + '.' + randomUUID() + '.baoyi-part')
    handle = await io.open(candidate, 'wx', 0o600)
    temporary = candidate // Never unlink a file that this invocation did not create.
    reader = response.body.getReader()
    let head = Buffer.alloc(0)
    let checked = false
    emit(true)
    for (;;) {
      signal.throwIfAborted()
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) break
      resetTimer()
      const bytes = Buffer.from(chunk.value)
      if (!bytes.length) continue
      if (!checked) {
        head = Buffer.concat([head, bytes.subarray(0, 32 - head.length)])
        if (head.length >= 16) { checkContainer(head); checked = true }
      }
      await handle.writeFile(bytes)
      receivedBytes += bytes.length
      if (totalBytes && receivedBytes > totalBytes) throw new Error('视频大小超过响应声明长度，文件完整性检查失败')
      emit(receivedBytes === bytes.length)
    }
    if (!checked) checkContainer(head)
    if (!receivedBytes) throw new Error('服务器返回空视频文件')
    if (totalBytes && receivedBytes !== totalBytes) throw new Error('视频大小与声明长度不符，下载不完整')
    signal.throwIfAborted()
    phase = 'finalizing'
    emit(true)
    await handle.sync()
    await handle.close(); handle = undefined
    emit(true)
    signal.throwIfAborted()
    try { await io.link(temporary, destination) }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') throw new DestinationExistsError('目标文件在下载期间已存在，未覆盖；请另选文件名')
      if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code ?? '')) {
        throw new Error('当前目录不支持安全发布下载文件，请改用 NTFS 目录（' + code + '）')
      }
      throw err
    }
    published = true // Commit point: a late cancel cannot undo this completed file.
  } catch (err) { failure = err }
  finally {
    clearTimeout(timer)
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock() }
    else if (response?.body) void response.body.cancel().catch(() => {})
    if (handle) {
      try { await handle.close() } catch (err) { warnings.push('关闭临时文件失败：' + safeDownloadError(err)) }
    }
    if (temporary) {
      try { await io.unlink(temporary) }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('清理临时文件失败：' + temporary + '；' + safeDownloadError(err))
      }
    }
  }
  if (!published) {
    if (failure instanceof DestinationExistsError && !warnings.length) throw failure
    throw new Error([safeDownloadError(failure ?? new Error('下载未完成')), ...warnings].join('；'))
  }
  return { phase, destination, receivedBytes, totalBytes, bytesPerSecond, warnings }
}
