/**
 * HLS（m3u8）下载 + 合并 + FFmpeg 封装。
 *
 * 设计参考公开项目 xin0907/vget-cli 的 `download/hls.py`（Apache-2.0），用 TypeScript 重写。
 * 只处理 `AES-128` 与不加密；遇到 SAMPLE-AES / DRM 直接报错，不绕过。
 *
 * 分片落盘（可断点续传），合并后交给系统 FFmpeg 以 `-c copy` 封装成 MP4。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createDecipheriv, createHash } from 'node:crypto'
import { remuxToMp4 } from './ffmpeg.ts'

export interface HlsProgress {
  phase: 'downloading' | 'finalizing'
  receivedBytes: number
  totalBytes: number
  bytesPerSecond: number
  message: string
}

export interface HlsDownloadOptions {
  url: string
  destination: string
  headers: Record<string, string>
  signal: AbortSignal
  fetch: typeof globalThis.fetch
  ffmpeg: string
  workers?: number
  retries?: number
  onProgress?: (progress: HlsProgress) => void
}

interface ByteRange { start: number; end: number }
interface Segment { url: string; range?: ByteRange; init?: { url: string; range?: ByteRange }; key?: { method: string; url: string; iv?: string }; sequence: number }
type Playlist = { type: 'master'; variants: Array<{ url: string; height: number; bandwidth: number }> } | { type: 'media'; segments: Segment[] }

const attr = (line: string, name: string): string => {
  const match = new RegExp(name + '=("[^"]*"|[^,]*)').exec(line)
  return match ? match[1].replace(/^"|"$/g, '').trim() : ''
}
const absolute = (value: string, base: string) => new URL(value, base).href
function rangeOf(value: string, previousEnd: number | null): { range?: ByteRange; end: number | null } {
  if (!value) return { range: undefined, end: previousEnd }
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim())
  if (!match) throw new Error('无效的 HLS BYTERANGE：' + value)
  const length = Number(match[1])
  const start = match[2] !== undefined ? Number(match[2]) : (previousEnd ?? 0)
  const range = { start, end: start + length - 1 }
  return { range, end: range.end + 1 }
}

export function parsePlaylist(text: string, base: string): Playlist {
  const lines = text.split(/\r?\n/)
  if (!lines.some(line => line.trim() === '#EXTM3U')) throw new Error('来源返回的不是有效 M3U8')
  if (lines.some(line => line.startsWith('#EXT-X-STREAM-INF'))) {
    const variants: Array<{ url: string; height: number; bandwidth: number }> = []
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue
      const resolution = /RESOLUTION=\d+x(\d+)/i.exec(lines[index])
      const bandwidth = Number(attr(lines[index], 'BANDWIDTH')) || 0
      for (let next = index + 1; next < lines.length; next++) {
        const uri = lines[next].trim()
        if (!uri || uri.startsWith('#')) continue
        variants.push({ url: absolute(uri, base), height: resolution ? Number(resolution[1]) : 0, bandwidth })
        break
      }
    }
    if (!variants.length) throw new Error('主播放列表没有可用画质')
    return { type: 'master', variants }
  }
  const segments: Segment[] = []
  let key: Segment['key']
  let init: Segment['init']
  let pendingRange = ''
  let previousEnd: number | null = null
  let previousInitEnd: number | null = null
  const sequenceLine = lines.find(line => line.startsWith('#EXT-X-MEDIA-SEQUENCE')) || ''
  const mediaSequence = Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(sequenceLine)?.[1] || 0)
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-KEY:')) {
      const method = attr(line, 'METHOD').toUpperCase()
      if (method && method !== 'NONE' && method !== 'AES-128') throw new Error('HLS 使用不支持的加密方式 ' + method + '；不绕过 DRM')
      key = method && method !== 'NONE' ? { method, url: absolute(attr(line, 'URI'), base), iv: attr(line, 'IV') || undefined } : undefined
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const parsed = rangeOf(attr(line, 'BYTERANGE'), previousInitEnd)
      previousInitEnd = parsed.end
      init = { url: absolute(attr(line, 'URI'), base), range: parsed.range }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice('#EXT-X-BYTERANGE:'.length)
    } else if (line && !line.startsWith('#')) {
      const parsed = rangeOf(pendingRange, previousEnd)
      previousEnd = parsed.end; pendingRange = ''
      segments.push({ url: absolute(line, base), range: parsed.range, key, init, sequence: mediaSequence + segments.length })
    }
  }
  if (!segments.length) throw new Error('媒体播放列表不包含任何分片')
  return { type: 'media', segments }
}

export async function downloadHls(options: HlsDownloadOptions): Promise<{ destination: string; warnings: string[] }> {
  options.signal.throwIfAborted()
  const stopped = new AbortController()
  const signal = AbortSignal.any([options.signal, stopped.signal])
  const warnings: string[] = []
  const workers = Math.min(Math.max(options.workers ?? 8, 1), 16)
  const retries = options.retries ?? 4
  const started = Date.now()
  let lastTick = 0, receivedBytes = 0, totalBytes = 0
  const emit = (phase: HlsProgress['phase'], message: string, force = false) => {
    const now = Date.now()
    if (!force && now - lastTick < 300) return
    lastTick = now
    try { options.onProgress?.({ phase, receivedBytes, totalBytes, bytesPerSecond: Math.round(receivedBytes * 1000 / Math.max(1, now - started)), message }) } catch { /* UI 观察者不能影响下载 */ }
  }
  const request = async (url: string, range?: ByteRange): Promise<Buffer> => {
    const headers: Record<string, string> = { ...options.headers, Accept: '*/*', 'Accept-Encoding': 'identity' }
    if (range) headers.Range = `bytes=${range.start}-${range.end}`
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        signal.throwIfAborted()
        const response = await options.fetch(url, { headers, signal, redirect: 'follow' })
        if (range ? response.status !== 206 : !response.ok) throw new Error('HLS 请求失败：HTTP ' + response.status)
        const data = Buffer.from(await response.arrayBuffer())
        if (!data.length) throw new Error('HLS 资源为空')
        if (range && data.length !== range.end - range.start + 1) throw new Error('HLS BYTERANGE 返回长度不正确')
        return data
      } catch (error) {
        lastError = error
        if (signal.aborted) throw signal.reason
        if (attempt < retries) await new Promise(resolve => setTimeout(resolve, Math.min(attempt + 1, 5) * 500))
      }
    }
    throw lastError instanceof Error ? lastError : new Error('HLS 资源多次重试仍失败')
  }

  // 解析主清单 / 媒体清单，选最高画质。
  let mediaUrl = options.url, playlist = parsePlaylist((await request(options.url)).toString('utf8'), options.url)
  for (let depth = 0; playlist.type === 'master' && depth < 5; depth++) {
    const best = playlist.variants.reduce((a, b) => (b.height || b.bandwidth) > (a.height || a.bandwidth) ? b : a)
    mediaUrl = best.url
    playlist = parsePlaylist((await request(mediaUrl)).toString('utf8'), mediaUrl)
  }
  if (playlist.type !== 'media') throw new Error('M3U8 主清单嵌套层数异常')
  const segments = playlist.segments

  const tempDir = path.join(path.dirname(options.destination), '.' + path.basename(options.destination) + '.baoyi-hls')
  const identity = createHash('sha256').update(JSON.stringify(segments)).digest('hex')
  const manifestFile = path.join(tempDir, 'manifest.json')
  let manifest: { identity: string; files: Record<string, { size: number; hash: string }> } = { identity, files: {} }
  try {
    const savedManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    if (savedManifest.identity === identity && savedManifest.files) manifest = savedManifest
    else fs.rmSync(tempDir, { recursive: true, force: true })
  } catch { /* Only verified files from this playlist may be reused. */ }
  fs.mkdirSync(tempDir, { recursive: true })
  const saveManifest = () => {
    fs.writeFileSync(manifestFile + '.tmp', JSON.stringify(manifest))
    fs.renameSync(manifestFile + '.tmp', manifestFile)
  }
  saveManifest()
  const segmentFile = (index: number) => path.join(tempDir, String(index).padStart(6, '0') + '.segment')
  const saved = new Set<number>()
  for (let index = 0; index < segments.length; index++) {
    try {
      const expected = manifest.files[index], data = fs.readFileSync(segmentFile(index))
      if (expected && data.length === expected.size && createHash('sha256').update(data).digest('hex') === expected.hash) { saved.add(index); receivedBytes += data.length }
    } catch { /* 未下或损坏，重新下载 */ }
  }
  emit('downloading', `已下载 ${saved.size}/${segments.length} 个分片`, true)

  const keyCache = new Map<string, Buffer>()
  const fetchKey = async (url: string): Promise<Buffer> => {
    const cached = keyCache.get(url); if (cached) return cached
    const key = await request(url)
    if (key.length !== 16) throw new Error('AES-128 密钥长度错误')
    keyCache.set(url, key); return key
  }
  const decrypt = async (segment: Segment, data: Buffer): Promise<Buffer> => {
    if (!segment.key) return data
    const key = await fetchKey(segment.key.url)
    const iv = segment.key.iv
      ? Buffer.from(segment.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex')
      : (() => { const buf = Buffer.alloc(16); buf.writeBigUInt64BE(BigInt(segment.sequence), 8); return buf })()
    if (iv.length !== 16) throw new Error('AES-128 IV 必须为 16 字节')
    if (data.length % 16) throw new Error('加密分片长度不是 AES block 的整数倍')
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    return Buffer.concat([decipher.update(data), decipher.final()])
  }

  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++; if (index >= segments.length) return
      if (saved.has(index)) continue
      signal.throwIfAborted()
      const segment = segments[index]
      const data = await decrypt(segment, await request(segment.url, segment.range))
      signal.throwIfAborted()
      fs.writeFileSync(segmentFile(index) + '.tmp', data)
      fs.renameSync(segmentFile(index) + '.tmp', segmentFile(index))
      manifest.files[index] = { size: data.length, hash: createHash('sha256').update(data).digest('hex') }
      saveManifest()
      saved.add(index); receivedBytes += data.length
      emit('downloading', `已下载 ${saved.size}/${segments.length} 个分片`)
    }
  }
  let failure: unknown
  await Promise.allSettled(Array.from({ length: workers }, async () => {
    try { await worker() } catch (error) { if (!stopped.signal.aborted) { failure = error; stopped.abort(error) } }
  }))
  if (failure) throw failure
  signal.throwIfAborted()
  if (saved.size !== segments.length) throw new Error(`HLS 下载不完整：${saved.size}/${segments.length}`)

  emit('finalizing', '正在合并分片并生成 MP4', true)
  const merged = path.join(tempDir, 'merged-media.bin')
  const output = fs.openSync(merged, 'w')
  try {
    let lastInit: Segment['init']
    for (let index = 0; index < segments.length; index++) {
      signal.throwIfAborted()
      const segment = segments[index]
      if (segment.init && segment.init !== lastInit) { fs.writeSync(output, await request(segment.init.url, segment.init.range)); lastInit = segment.init }
      fs.writeSync(output, fs.readFileSync(segmentFile(index)))
    }
  } finally { fs.closeSync(output) }

  const temporary = options.destination + '.baoyi-part.mp4'
  fs.rmSync(temporary, { force: true })
  await remuxToMp4(options.ffmpeg, merged, temporary, options.signal)
  fs.renameSync(temporary, options.destination)
  fs.rmSync(tempDir, { recursive: true, force: true })
  emit('finalizing', '完成', true)
  return { destination: options.destination, warnings }
}
