import fs from 'node:fs'
import path from 'node:path'
import { parseNfo } from './nfo.ts'
import { numberedEpisode } from './episode-identity.ts'
import { toVideoCode } from './hentai/selectors.ts'
import type { VideoContentInput, VideoSourceRef } from '../../../src/types/video-library.ts'

const VIDEO = /\.(mp4|mkv|avi|mov|m4v|webm|wmv|mpg|mpeg|ts|m2ts|flv)$/i
const IMAGE = /\.(png|jpe?g|webp)$/i
const stem = (s: string) => path.basename(s, path.extname(s)).normalize('NFKC').toLowerCase()
const withoutQuality = (s: string) => s.replace(/[\s._-]+(?:2160|1080|720|480|360|240)p$/i, '')
const titleKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\[\d{3,20}\]|\d{3,4}p|中文字幕|無修正|无修正/gi, '').replace(/[^\p{L}\p{N}]/gu, '')
const text = (v: unknown) => typeof v === 'string' ? v.trim() : ''
export const metadataTags = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v : []).map(x => typeof x === 'string' ? x.trim() : text(x?.name)).filter(Boolean))].slice(0, 300)
function smallText(file: string): string { try { return fs.statSync(file).size <= 2 * 1024 * 1024 ? fs.readFileSync(file, 'utf8') : '' } catch { return '' } }
function publicationTime(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(value.trim())) return 0
  const input = value.trim(), day = input.slice(0, 10), calendar = Date.parse(day + 'T00:00:00Z')
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== day) return 0
  const stamp = Date.parse(input)
  return Number.isFinite(stamp) && stamp > 0 ? stamp : 0
}

/** Assign ambiguous info*.json only when its title uniquely matches this video. */
export function readVideoLocalMetadata(file: string): Partial<VideoContentInput> & { genres: string[]; mpaa: string; metadataFiles: string[] } {
  const directory = path.dirname(file)
  let names: string[] = []
  try { names = fs.readdirSync(directory).filter(n => { try { return fs.statSync(path.join(directory, n)).isFile() } catch { return false } }) } catch { /* Offline volume. */ }
  const base = stem(file), videos = names.filter(n => VIDEO.test(n))
  const same = (name: string) => [base,withoutQuality(base)].some(value => stem(name) === value || stem(name).startsWith(value + '.') || stem(name).startsWith(value + '-'))
  const attachments: NonNullable<VideoContentInput['attachments']> = []
  const add = (name: string, role: 'poster' | 'subtitle' | 'attachment') => attachments.push({ path: path.join(directory, name), role })
  const nfoName = names.find(n => /\.nfo$/i.test(n) && withoutQuality(stem(n)) === withoutQuality(base))
  const nfo = nfoName ? parseNfo(smallText(path.join(directory, nfoName))) : null
  if (nfoName) add(nfoName, 'attachment')
  const jsons = names.filter(n => /\.json$/i.test(n) && !/baoyi\.json$/i.test(n)).flatMap(name => {
    try { const data = JSON.parse(smallText(path.join(directory, name))); return data && typeof data === 'object' && typeof data.title === 'string' && ('videoUrls' in data || 'coverUrl' in data) ? [{ name, data }] : [] } catch { return [] }
  })
  const matches = (video: string, data: Record<string, unknown>) => {
    const key = titleKey(stem(video)), number = numberedEpisode(stem(video))?.number
    return [data.title, data.chineseTitle].some(title => {
      if (typeof title !== 'string' || titleKey(title).length < 3) return false
      const n = numberedEpisode(title)?.number
      return !(n != null && number != null && n !== number) && key.includes(titleKey(title))
    })
  }
  const matched = jsons.filter(j => matches(path.basename(file), j.data) && videos.filter(v => matches(v, j.data)).length === 1)
  const viewer = matched.length === 1 ? matched[0] : jsons.find(j => stem(j.name) === base)
  if (viewer) add(viewer.name, 'attachment')
  const data = viewer?.data
  const images = names.filter(n => IMAGE.test(n) && (same(n) || videos.length === 1 && /^(poster|cover|folder|thumb|fanart)\./i.test(n)))
  images.forEach(n => add(n, 'poster'))
  names.filter(n => /\.(srt|ass|ssa|sub|idx|vtt)$/i.test(n) && same(n)).forEach(n => add(n, 'subtitle'))
  const poster = images.find(n => /(?:poster|cover|folder)\./i.test(n)) || images[0]
  const preview = images.find(n => /(?:thumb|preview|fanart)\./i.test(n)) || (data ? images[0] : '')
  // Numeric filenames alone are not source IDs; require matching source metadata.
  const code = data ? toVideoCode(data.pageUrl || data.sourceUrl || data.url || data.videoCode || '')
    || (/^\d{3,20}$/.test(String(data.videoCode ?? '')) ? String(data.videoCode) : '')
    || /\[(\d{3,20})\]/.exec(path.basename(file))?.[1]
    || (/^\d{3,20}$/.test(path.basename(directory)) ? path.basename(directory) : '') : ''
  const sources: VideoSourceRef[] = code ? [{ provider: 'hanime', externalId: code, scope: 'episode', pageUrl: `https://hanime1.me/watch?v=${code}`, evidence: 'nfo' }] : []
  const tags = metadataTags([...(nfo?.tags || []), ...(nfo?.genres || []), ...metadataTags(data?.tags)])
  const cover = text(data?.coverUrl), thumbnail = text(data?.thumbnailUrl) || (/\/thumbnail\//i.test(cover) ? cover : '')
  return { title: nfo?.title || text(data?.chineseTitle) || text(data?.title) || undefined,
    originalTitle: nfo?.original_title || text(data?.title), description: nfo?.plot || text(data?.introduction), originalDescription: text(data?.introduction),
    publishedAt: publicationTime(data?.uploadTime), airDate: nfo?.premiered_ts || 0,
    studio: nfo?.studios.join('、') || text(data?.artist) || metadataTags(data?.artist).join('、'), durationSec: (nfo?.runtime_min || 0) * 60,
    tags, posterPath: poster ? path.join(directory, poster) : '', posterSource: cover,
    thumbnailPath: preview ? path.join(directory, preview) : '', thumbnailSource: thumbnail,
    sourceUrl: sources[0]?.pageUrl || '', sources, attachments, genres: nfo?.genres || [], mpaa: nfo?.mpaa || '',
    metadataFiles: attachments.filter(a => /\.(nfo|json)$/i.test(a.path)).map(a => a.path) }
}
