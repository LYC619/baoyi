import { createHash } from 'node:crypto'
import { parse } from 'node-html-parser'
import type { DiscoveryEntry } from '../../../../../src/types/video-discovery.ts'
import { discoveryUrl, videoFileExtension } from '../catalogue.ts'

export const onlineId = (prefix: string, url: string) => prefix + createHash('sha256').update(url).digest('hex').slice(0, 32)
export function canonicalOnlineUrl(value: string): string {
  const url = new URL(discoveryUrl(value, true)); url.hash = ''; return url.href
}
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
function link(value: unknown, base: string): string {
  if (Array.isArray(value)) value = value[0]
  if (value && typeof value === 'object') { const obj = value as Record<string, unknown>; value = obj.url || obj['@id'] }
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) return ''
  try { return discoveryUrl(new URL(value, base).href) } catch { return '' }
}

/** Reads public structured data only. No scripts, remote contexts or linked pages are executed. */
export function parseVideoObjectPage(input: { html: string; url: string }): { name: string; entries: DiscoveryEntry[]; nextPageUrl: string } {
  const url = canonicalOnlineUrl(input.url)
  if (Buffer.byteLength(input.html) > 2 * 1024 * 1024) throw new Error('网页不能超过 2 MB')
  const root = parse(input.html), entries = new Map<string, DiscoveryEntry>(), ambiguous = new Set<string>()
  let visited = 0
  function visit(value: unknown, depth: number) {
    if (depth > 32 || ++visited > 20000 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
    const obj = value as Record<string, unknown>
    const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']]
    if (types.some(type => typeof type === 'string' && /^(?:https?:\/\/schema\.org\/)?VideoObject$/.test(type))) {
      const title = text(obj.name || obj.headline, 240)
      if (title) {
        const explicitPage = link(obj.url, url) || link(obj.mainEntityOfPage, url) || link(obj['@id'], url)
        const pageUrl = explicitPage || url
        const media = link(obj.contentUrl, url), extension = media ? videoFileExtension(media) : ''
        const mediaUrl = extension ? media : ''
        const date = text(obj.uploadDate || obj.datePublished, 30), year = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : 0
        const keywords = Array.isArray(obj.keywords) ? obj.keywords : typeof obj.keywords === 'string' ? obj.keywords.split(/[,，]/) : []
        const id = onlineId('video-', pageUrl)
        const entry: DiscoveryEntry = { id, code: '', title, description: text(obj.description, 8000), coverUrl: link(obj.thumbnailUrl || obj.thumbnail, url), pageUrl,
          playUrl: link(obj.embedUrl, url), mediaUrl, year, tags: [...new Set(keywords.map(tag => text(tag, 80)).filter(Boolean))].slice(0, 40), rankings: [],
          downloads: mediaUrl ? [{ label: '原始文件', url: mediaUrl, extension }] : [] }
        const rating = obj.aggregateRating as Record<string, unknown> | undefined
        if (rating && typeof rating === 'object') {
          const value = Number(rating.ratingValue), scale = Number(rating.bestRating ?? 5), votes = Number(rating.ratingCount ?? rating.reviewCount ?? 0)
          if (Number.isFinite(value) && scale >= 1 && scale <= 100 && value >= 0 && value <= scale && Number.isFinite(votes) && votes >= 0 && votes <= 1e10) entry.rating = { value, scale, votes }
        }
        const previous = entries.get(id)
        // Multiple anonymous videos share the document URL. Never let the last
        // recommendation silently replace the selected video's media.
        if (previous && (previous.title !== title || previous.mediaUrl && mediaUrl && previous.mediaUrl !== mediaUrl)) {
          ambiguous.add(id); entries.delete(id)
        } else if (!ambiguous.has(id) && (!previous || mediaUrl)) entries.set(id, entry)
        if (entries.size > 2000) throw new Error('来源作品不能超过 2000 项')
      }
    }
    for (const child of Object.values(obj)) visit(child, depth + 1)
  }
  for (const script of root.querySelectorAll('script')) {
    if (script.getAttribute('type')?.toLowerCase().split(';')[0].trim() !== 'application/ld+json') continue
    let data: unknown
    try { data = JSON.parse(script.innerHTML) } catch { continue }
    visit(data, 0)
  }
  const next = root.querySelectorAll('a,link').find(node => node.getAttribute('rel')?.toLowerCase().split(/\s+/).includes('next'))
  let nextPageUrl = link(next?.getAttribute('href'), url)
  if (nextPageUrl) {
    nextPageUrl = canonicalOnlineUrl(nextPageUrl)
    if (new URL(nextPageUrl).origin !== new URL(url).origin || nextPageUrl === url) nextPageUrl = ''
  }
  return { name: text(root.querySelector('title')?.textContent, 100) || new URL(url).hostname, entries: [...entries.values()], nextPageUrl }
}
