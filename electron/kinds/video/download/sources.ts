import { parse } from 'node-html-parser'
import { fetchHanimeResource, looksLikeChallenge } from '../hentai/hanime.ts'
import { HANIME_BASE, parseDetail, parseSearch, searchUrl, toVideoCode, watchUrl } from '../hentai/selectors.ts'
import { abortable, DOWNLOAD_UA, httpUrl, safeDownloadError } from './transfer.ts'
import type { VideoWorkSource } from './workflow.ts'

export interface SourceCandidate { url: string; label: string; extension: string }
export interface VideoSources { publishedAt?: number; releaseDate?: number; durationSec?: number; artist?: string; videoCode: string; title: string; originalTitle?: string; description?: string; posterUrl?: string; thumbnailUrl?: string; artworkUrls?: string[]; tags?: string[]; candidates: SourceCandidate[]; warnings: string[] }
export interface SeriesEpisode { videoCode: string; title: string }
export interface VideoSeries { videoCode: string; title: string; episodes: SeriesEpisode[]; warnings: string[] }
const extensions = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv', 'ogg', 'mpg', 'mpeg'])
const mimeExtensions: Record<string, string> = {
  'video/mp4': 'mp4', 'application/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/quicktime': 'mov',
  'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi', 'video/ogg': 'ogv', 'video/mpeg': 'mpeg'
}
export function isVideoExtension(extension: string): boolean { return extensions.has(extension.toLowerCase()) }

/** Decode a quoted JS string only. Never execute player scripts or read unrelated scripts. */
function scriptString(literal: string): string {
  return literal.slice(1, -1).replace(/\\(u[\da-f]{4}|x[\da-f]{2}|[\s\S])/gi, (_whole, escaped: string) => {
    if (/^[ux][\da-f]+$/i.test(escaped)) return String.fromCharCode(parseInt(escaped.slice(1), 16))
    const chars: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }
    return chars[escaped] ?? escaped
  })
}
export function parseVideoSources(html: string, base = HANIME_BASE): VideoSources {
  const dom = parse(html)
  const metaUrl = dom.querySelector('meta[property="og:url"]')?.getAttribute('content')
  const videoCode = toVideoCode(metaUrl || base, base)
  const title = (dom.querySelector('#shareBtn-title')?.text || dom.querySelector('meta[property="og:title"]')?.getAttribute('content') || '')
    .replace(/\s+/g, ' ').trim().slice(0, 240)
  const candidates: SourceCandidate[] = []
  const warnings = new Set<string>()
  const add = (raw: string, size = '', type = '') => {
    if (!raw.trim()) return
    let url: string
    try { url = httpUrl(raw.trim(), base) } catch { return }
    const pathname = new URL(url).pathname.toLowerCase()
    const extension = /\.([a-z0-9]+)$/.exec(pathname)?.[1] ?? ''
    const mime = type.split(';')[0].trim().toLowerCase()
    if (['m3u8', 'mpd', 'ts', 'm4s'].includes(extension) || /mpegurl|dash\+xml|mp2t/.test(mime)) {
      warnings.add('部分清晰度使用 HLS/DASH 分片，当前只支持完整视频直链')
      return
    }
    // A video MIME must not turn an explicitly non-video file (image/executable) into a candidate.
    if (extension && !extensions.has(extension)) return
    if (mime && !mimeExtensions[mime] && !['application/octet-stream', 'binary/octet-stream'].includes(mime)) return
    const ext = extension || mimeExtensions[mime]
    if (!ext || candidates.some(candidate => candidate.url === url)) return
    const height = /^(\d{2,4})p?$/.exec(size.trim())?.[1]
    candidates.push({ url, label: height ? height + 'p' : '原始画质', extension: ext })
  }
  const player = dom.querySelector('video#player')
  for (const source of player?.querySelectorAll('source') ?? []) add(source.getAttribute('src') ?? '', source.getAttribute('size'), source.getAttribute('type'))
  if (player) add(player.getAttribute('src') ?? '', player.getAttribute('size'), player.getAttribute('type'))
  if (!candidates.length) {
    for (const script of dom.querySelectorAll('#player-div-wrapper script')) {
      const matches = script.rawText.matchAll(/\bconst\s+source\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)
      for (const match of matches) add(scriptString(match[1]))
    }
  }
  candidates.sort((a, b) => (parseInt(b.label) || 0) - (parseInt(a.label) || 0))
  const detail = parseDetail(html, base)
  return { videoCode, title, publishedAt: detail.publishedAt, releaseDate: detail.releaseDate, durationSec: detail.durationSec, artist: detail.artist, originalTitle: detail.title || title, description: detail.introduction, posterUrl: detail.posterUrl || detail.coverUrl, thumbnailUrl: detail.thumbnailUrl, artworkUrls: detail.artworkUrls, tags: detail.tags, candidates, warnings: [...warnings] }
}

export function parseVideoSeries(html: string, base = HANIME_BASE): VideoSeries {
  const detail = parseDetail(html, base)
  const episodes = detail.episodes
    .map(episode => ({ videoCode: episode.videoCode, title: episode.title || '站点单集 ' + episode.videoCode }))
  return {
    videoCode: detail.videoCode,
    title: detail.seriesName || detail.title || (detail.videoCode ? '站点系列 ' + detail.videoCode : ''),
    episodes,
    warnings: []
  }
}

interface LoadPageOptions { signal?: AbortSignal; timeoutMs?: number }

async function loadHtml(
  pageUrl: string,
  fetcher: typeof globalThis.fetch = fetchHanimeResource,
  options: LoadPageOptions = {},
  expectedVideoCode?: string
): Promise<string> {
  const timeout = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
  const timer = setTimeout(() => timeout.abort(new Error('解析下载地址超时，请重试')), options.timeoutMs ?? 15_000)
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    signal.throwIfAborted()
    const pending = fetcher(pageUrl, { cache: 'no-store', signal, headers: { 'User-Agent': DOWNLOAD_UA, Referer: HANIME_BASE } })
    void pending.then(res => { if (signal.aborted) void res.body?.cancel().catch(() => {}) }, () => {})
    response = await abortable(pending, signal)
    if (!response.ok) throw new Error('解析 HTTP ' + response.status + (response.status === 403 ? '：请到设置完成内置 Cloudflare 验证后重新解析' : '：无法获取播放器页面'))
    if (expectedVideoCode && response.url && toVideoCode(response.url) !== expectedVideoCode) throw new Error('播放器页面发生跳转，站点编号不一致，请重新识别')
    if (!response.body) throw new Error('播放器页面为空')
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) break
      length += chunk.value.length
      if (length > 4 * 1024 * 1024) throw new Error('播放器页面过大，超过解析上限')
      chunks.push(chunk.value)
    }
    const html = Buffer.concat(chunks).toString('utf8')
    if (looksLikeChallenge(html)) throw new Error('需要 Cloudflare 验证，请到设置完成内置验证后重新解析')
    return html
  } catch (err) { throw new Error(safeDownloadError(err)) }
  finally {
    clearTimeout(timer)
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock() }
    else if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
  }
}

async function loadPageHtml(videoCode: string, fetcher: typeof globalThis.fetch, options: LoadPageOptions) {
  if (typeof videoCode !== 'string' || !/^\d{1,20}$/.test(videoCode)) throw new Error('站点单集编号无效')
  const pageUrl = watchUrl(videoCode)
  return { html: await loadHtml(pageUrl, fetcher, options, videoCode), pageUrl }
}

/** The watch page can expose only a player frame; search cards carry the published cover. */
export async function supplementPoster<T extends { title: string; posterUrl?: string; thumbnailUrl?: string; artworkUrls?: string[] }>(
  metadata: T, videoCode: string, fetcher: typeof globalThis.fetch, options: LoadPageOptions
): Promise<T> {
  options.signal?.throwIfAborted()
  if (!metadata.title || metadata.posterUrl && metadata.posterUrl !== metadata.thumbnailUrl) return metadata
  try {
    const html = await loadHtml(searchUrl(metadata.title), fetcher, options)
    const hit = parseSearch(html).find(candidate => candidate.videoCode === videoCode)
    if (hit?.coverUrl) return { ...metadata, posterUrl: hit.coverUrl, artworkUrls: [...new Set([hit.coverUrl, ...metadata.artworkUrls || []])] }
  } catch { /* Optional artwork lookup must not prevent a valid video transfer. */ }
  options.signal?.throwIfAborted()
  return metadata
}

export async function loadVideoSources(
  videoCode: string,
  fetcher: typeof globalThis.fetch = fetchHanimeResource,
  options: LoadPageOptions = {}
): Promise<VideoSources> {
  const { html, pageUrl } = await loadPageHtml(videoCode, fetcher, options)
  const result = parseVideoSources(html, pageUrl)
  if (result.videoCode !== videoCode) throw new Error('页面单集编号不一致，请重新识别后再下载')
  if (!result.candidates.length) throw new Error(result.warnings[0] || '播放器没有可下载的完整视频直链，请验证后重新解析')
  const metadata = await supplementPoster(result, videoCode, fetcher, options)
  return { ...metadata, title: result.title || '站点单集 ' + videoCode }
}

export async function loadVideoSeries(
  videoCode: string,
  fetcher: typeof globalThis.fetch = fetchHanimeResource,
  options: LoadPageOptions = {}
): Promise<VideoSeries> {
  const { html, pageUrl } = await loadPageHtml(videoCode, fetcher, options)
  const result = parseVideoSeries(html, pageUrl)
  if (result.videoCode !== videoCode) throw new Error('页面单集编号不一致，请重新识别后再下载')
  if (!result.episodes.length) throw new Error('这个站点条目没有可下载的系列集数')
  return result
}

/** Work metadata and membership are parsed together; no signed transfer URL is persisted. */
export async function loadVideoWork(videoCode: string, options: LoadPageOptions = {}): Promise<VideoWorkSource> {
  const { html, pageUrl } = await loadPageHtml(videoCode, fetchHanimeResource, options)
  const parsed = parseDetail(html, pageUrl)
  if (parsed.videoCode !== videoCode) throw new Error('来源编号不一致')
  const detail = await supplementPoster(parsed, videoCode, fetchHanimeResource, options)
  return { videoCode, artworkUrls: detail.artworkUrls, title: detail.seriesName || detail.chineseTitle || detail.title,
    description: detail.introduction, posterUrl: detail.posterUrl || detail.coverUrl, thumbnailUrl: detail.thumbnailUrl, tags: detail.tags,
    currentEpisode: { videoCode, publishedAt: detail.publishedAt, releaseDate: detail.releaseDate, durationSec: detail.durationSec, artist: detail.artist, artworkUrls: detail.artworkUrls, title: detail.chineseTitle || detail.title, originalTitle: detail.title, description: detail.introduction, posterUrl: detail.posterUrl || detail.coverUrl, thumbnailUrl: detail.thumbnailUrl, tags: detail.tags },
    episodes: detail.episodes.map(ep => ({ videoCode: ep.videoCode, title: ep.title })), warnings: [] }
}
