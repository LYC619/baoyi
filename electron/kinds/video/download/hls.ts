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
import { readDownloadResource, retryableDownloadError } from './resource.ts'
import { withStreamOutput } from './stream-output.ts'
import { createFragmentCache, fragmentShape } from './fragment-cache.ts'

export interface HlsProgress {
  checkingCache?: boolean
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
  idleTimeoutMs?: number
  /** Internal recursion guard for an external audio rendition. */
  audioTrack?: boolean
  onProgress?: (progress: HlsProgress) => void
}

interface ByteRange { start: number; end: number }
interface Segment { url: string; range?: ByteRange; init?: { url: string; range?: ByteRange }; key?: { method: string; url: string; iv?: string }; sequence: number }
type Playlist = { type: 'master'; variants: Array<{ url: string; height: number; bandwidth: number; audioGroup?: string }>; audio: Array<{group:string;url:string;default:boolean}> } | { type: 'media'; segments: Segment[]; ended: boolean }

const attr = (line: string, name: string): string => {
  const match = new RegExp('(?:^|[:,])\\s*' + name + '=("[^"]*"|[^,]*)').exec(line)
  return match ? match[1].replace(/^"|"$/g, '').trim() : ''
}
const absolute = (value: string, base: string) => new URL(value, base).href
function rangeOf(value: string, previousEnd: number | null): { range?: ByteRange; end: number | null } {
  if (!value) return { range: undefined, end: previousEnd }
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim())
  if (!match) throw new Error('无效的 HLS BYTERANGE：' + value)
  const length = Number(match[1])
  if(match[2]===undefined && previousEnd===null)throw new Error('HLS BYTERANGE 隐式范围缺少同资源的前一个分片')
  const start = match[2] !== undefined ? Number(match[2]) : previousEnd!
  if(!Number.isSafeInteger(length) || length<1 || !Number.isSafeInteger(start) || start<0 || !Number.isSafeInteger(start+length))throw new Error('HLS BYTERANGE 字节范围无效')
  const range = { start, end: start + length - 1 }
  return { range, end: range.end + 1 }
}

export function parsePlaylist(text: string, base: string): Playlist {
  const lines = text.split(/\r?\n/)
  if (!lines.some(line => line.trim() === '#EXTM3U')) throw new Error('来源返回的不是有效 M3U8')
  if (lines.some(line => line.startsWith('#EXT-X-STREAM-INF'))) {
    const variants: Array<{ url: string; height: number; bandwidth: number; audioGroup?:string }> = []
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue
      const resolution = /RESOLUTION=\d+x(\d+)/i.exec(lines[index])
      const bandwidth = Number(attr(lines[index], 'BANDWIDTH')) || 0
      for (let next = index + 1; next < lines.length; next++) {
        const uri = lines[next].trim()
        if (!uri || uri.startsWith('#')) continue
        variants.push({ url: absolute(uri, base), height: resolution ? Number(resolution[1]) : 0, bandwidth, audioGroup:attr(lines[index],'AUDIO')||undefined })
        break
      }
    }
    if (!variants.length) throw new Error('主播放列表没有可用画质')
    const audio=lines.filter(line=>line.startsWith('#EXT-X-MEDIA:') && attr(line,'TYPE')==='AUDIO' && attr(line,'URI'))
      .map(line=>({group:attr(line,'GROUP-ID'),url:absolute(attr(line,'URI'),base),default:attr(line,'DEFAULT')==='YES'}))
    return { type: 'master', variants, audio }
  }
  const segments: Segment[] = []
  let key: Segment['key']
  let init: Segment['init']
  let pendingRange = ''
  let previousEnd: number | null = null
  let previousInitEnd: number | null = null
  let previousUrl='',previousInitUrl=''
  const sequenceLine = lines.find(line => line.startsWith('#EXT-X-MEDIA-SEQUENCE')) || ''
  const mediaSequence = Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(sequenceLine)?.[1] || 0)
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-KEY:')) {
      const method = attr(line, 'METHOD').toUpperCase()
      if (method && method !== 'NONE' && method !== 'AES-128') throw new Error('HLS 使用不支持的加密方式 ' + method + '；不绕过 DRM')
      key = method && method !== 'NONE' ? { method, url: absolute(attr(line, 'URI'), base), iv: attr(line, 'IV') || undefined } : undefined
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const initUrl=absolute(attr(line,'URI'),base)
      if(initUrl!==previousInitUrl)previousInitEnd=null
      const parsed = rangeOf(attr(line, 'BYTERANGE'), previousInitEnd)
      previousInitEnd = parsed.end;previousInitUrl=initUrl
      if(key && !key.iv)throw new Error('加密 HLS 初始化分片缺少显式 IV')
      if(key)throw new Error('加密 HLS 初始化分片暂不支持下载')
      init = { url: initUrl, range: parsed.range }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice('#EXT-X-BYTERANGE:'.length)
    } else if (line && !line.startsWith('#')) {
      const url=absolute(line,base)
      if(url!==previousUrl)previousEnd=null
      const parsed = rangeOf(pendingRange, previousEnd)
      previousEnd = parsed.range ? parsed.end : null; pendingRange = '';previousUrl=url
      segments.push({ url, range: parsed.range, key, init, sequence: mediaSequence + segments.length })
    }
  }
  if (!segments.length) throw new Error('媒体播放列表不包含任何分片')
  return { type: 'media', segments, ended:lines.some(line=>line.trim()==='#EXT-X-ENDLIST') }
}

export async function downloadHls(options: HlsDownloadOptions): Promise<{ destination: string; warnings: string[]; receivedBytes: number; totalBytes: number; bytesPerSecond: number }> {
  return withStreamOutput(options.destination,'hls',options.signal,(workspace,temporary) => downloadHlsParts(options,workspace,temporary))
}
async function downloadHlsParts(options: HlsDownloadOptions, tempDir: string, temporary: string) {
  options.signal.throwIfAborted()
  const stopped = new AbortController()
  const signal = AbortSignal.any([options.signal, stopped.signal])
  const warnings: string[] = []
  const workers = Math.min(Math.max(options.workers ?? 8, 1), 16)
  const retries = options.retries ?? 4
  const started = Date.now()
  let lastTick = 0, receivedBytes = 0, totalBytes = 0, cachedBytes = 0, checkingCache = true
  const receiving = new Map<string,number>()
  const emit = (phase: HlsProgress['phase'], message: string, force = false) => {
    const now = Date.now()
    if (!force && now - lastTick < 300) return
    lastTick = now
    const bytes=receivedBytes+[...receiving.values()].reduce((sum,n)=>sum+n,0)
    try { options.onProgress?.({ phase, checkingCache, receivedBytes:bytes, totalBytes, bytesPerSecond: checkingCache ? 0 : Math.round(Math.max(0, bytes - cachedBytes) * 1000 / Math.max(1, now - started)), message }) } catch { /* UI 观察者不能影响下载 */ }
  }
  const request = async (url: string, range?: ByteRange, progressKey?:string) => {
    const headers: Record<string, string> = { ...options.headers, Accept: '*/*', 'Accept-Encoding': 'identity' }
    if (range) headers.Range = `bytes=${range.start}-${range.end}`
    try { return await readDownloadResource({fetch:options.fetch,url,headers,signal,range,retries,idleTimeoutMs:options.idleTimeoutMs,
      conditional: progressKey === undefined ? undefined : cache.conditional(progressKey, segmentFile(Number(progressKey)), url),
      onProgress:bytes=>{if(progressKey!==undefined){const previous=receiving.get(progressKey)||0;receiving.set(progressKey,bytes);emit('downloading',`已下载 ${saved.size}/${segments.length} 个分片，正在接收`,bytes>0 && previous===0)}},
      onRetry:()=>emit('downloading','分片连接中断，正在重试；已完成分片保留',true)
    }) } finally { if(progressKey!==undefined)receiving.delete(progressKey) }
  }

  // 解析主清单 / 媒体清单，选最高画质。
  emit('downloading','正在请求 HLS 播放清单并校验缓存，上次进度暂时保留',true)
  const first = await readDownloadResource({fetch:options.fetch,url:options.url,headers:options.headers,signal,retries,idleTimeoutMs:options.idleTimeoutMs,maxBytes:4*1024*1024,
    onRetry:()=>emit('downloading','播放清单连接暂时失败，正在重试',true)})
  let mediaUrl = first.url, playlist = parsePlaylist(first.data.toString('utf8'), first.url)
  let audioUrl=''
  for (let depth = 0; playlist.type === 'master' && depth < 5; depth++) {
    const best = playlist.variants.reduce((a, b) => (b.height || b.bandwidth) > (a.height || a.bandwidth) ? b : a)
    if(best.audioGroup){const choices=playlist.audio.filter(audio=>audio.group===best.audioGroup);audioUrl=(choices.find(audio=>audio.default)||choices[0])?.url||audioUrl}
    const resolved = await readDownloadResource({fetch:options.fetch,url:best.url,headers:options.headers,signal,retries,idleTimeoutMs:options.idleTimeoutMs,maxBytes:4*1024*1024})
    mediaUrl = resolved.url
    playlist = parsePlaylist(resolved.data.toString('utf8'), mediaUrl)
  }
  if (playlist.type !== 'media') throw new Error('M3U8 主清单嵌套层数异常')
  if(!playlist.ended)throw new Error('HLS 直播或未结束的播放清单无法作为完整影片保存')
  if(options.audioTrack && audioUrl)throw new Error('HLS 音轨清单嵌套异常')
  const segments = playlist.segments

  const identity = createHash('sha256').update(JSON.stringify(segments)).digest('hex')
  const cache = createFragmentCache(tempDir, identity, fragmentShape(segments), !segments.some(segment => segment.key || segment.init))
  const segmentFile = (index: number) => path.join(tempDir, String(index).padStart(6, '0') + '.segment')
  const saved = new Set<number>()
  if (cache.message) emit('downloading', cache.message, true)
  for (let index = 0; index < segments.length; index++) {
    signal.throwIfAborted()
    let data = cache.exact(String(index), segmentFile(index))
    if (!data && cache.conditional(String(index), segmentFile(index), segments[index].url)) {
      const response = await request(segments[index].url, segments[index].range, String(index))
      data = response.data; cache.save(String(index), segmentFile(index), data, response, segments[index].url)
    }
    if (data) { saved.add(index); receivedBytes += data.length }
  }
  cachedBytes = receivedBytes; checkingCache = false
  emit('downloading', cache.message || `已下载 ${saved.size}/${segments.length} 个分片`, true)

  const keyCache = new Map<string, Buffer>()
  const fetchKey = async (url: string): Promise<Buffer> => {
    const cached = keyCache.get(url); if (cached) return cached
    const key = (await request(url)).data
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
  const deferred:number[]=[]
  const saveSegment = async(index:number) => {
    const segment=segments[index]
    const response=await request(segment.url,segment.range,String(index))
    const data=await decrypt(segment,response.data)
    signal.throwIfAborted()
    cache.save(String(index),segmentFile(index),data,segment.key ? undefined : response,segment.url)
    saved.add(index);receivedBytes+=data.length
    emit('downloading',`已下载 ${saved.size}/${segments.length} 个分片`)
  }
  const worker = async () => {
    for (;;) {
      const index = cursor++; if (index >= segments.length) return
      if (saved.has(index)) continue
      signal.throwIfAborted()
      try { await saveSegment(index) }
      catch(error){
        if(signal.aborted || !retryableDownloadError(error))throw error
        deferred.push(index);emit('downloading','一条分片连接暂时失败，其他分片继续下载',true)
      }
    }
  }
  let failure: unknown
  await Promise.allSettled(Array.from({ length: workers }, async () => {
    try { await worker() } catch (error) { if (!stopped.signal.aborted) { failure = error; stopped.abort(error) } }
  }))
  if (failure) throw failure
  signal.throwIfAborted()
  for(const index of deferred){emit('downloading',`单连接补齐分片；已下载 ${saved.size}/${segments.length}`,true);await saveSegment(index)}
  if (saved.size !== segments.length) throw new Error(`HLS 下载不完整：${saved.size}/${segments.length}`)

  emit('finalizing', '正在合并分片并生成 MP4', true)
  const merged = path.join(tempDir, 'merged-media.bin')
  const output = fs.openSync(merged, 'w')
  try {
    let lastInit: Segment['init']
    for (let index = 0; index < segments.length; index++) {
      signal.throwIfAborted()
      const segment = segments[index]
      if (segment.init && segment.init !== lastInit) { fs.writeSync(output, (await request(segment.init.url, segment.init.range)).data); lastInit = segment.init }
      fs.writeSync(output, fs.readFileSync(segmentFile(index)))
    }
  } finally { fs.closeSync(output) }

  let audioInput=''
  if(audioUrl){
    audioInput=path.join(tempDir,'audio-track.mp4')
    const videoBytes=receivedBytes
    const audio=await downloadHlsParts({...options,url:audioUrl,audioTrack:true,onProgress:progress=>options.onProgress?.({...progress,receivedBytes:videoBytes+progress.receivedBytes,message:'独立音轨：'+progress.message})},path.join(tempDir,'audio-fragments'),audioInput)
    receivedBytes+=audio.receivedBytes;warnings.push(...audio.warnings)
  }
  emit('finalizing','FFmpeg 正在封装 MP4，下载字节已接收完毕',true)
  await remuxToMp4(options.ffmpeg, audioInput?[merged,audioInput]:merged, temporary, options.signal)
  emit('finalizing', '完成', true)
  return { destination: options.destination, warnings, receivedBytes, totalBytes:receivedBytes, bytesPerSecond:Math.round(receivedBytes*1000/Math.max(1,Date.now()-started)) }
}
