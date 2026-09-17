import type { SqlDb } from '../../services/schema.ts'
import type { VideoContentInput } from '../../../src/types/video-library.ts'
import type { VideoWorkSource } from './download/workflow.ts'
import { getVideo, listEpisodes } from './db.ts'
import { catalogueIdentity, collectionRangeTitle, numberedEpisode } from './episode-identity.ts'
import { linkLegacyEpisode, sourceEpisodeFacts } from './episode-details.ts'
import { registerVideoContent } from './registration.ts'

export function videoCollectionTitle(title: string, entries: Array<{ videoCode: string; title: string }>): string {
  const catalogue = catalogueIdentity(title, entries)
  const sameSeries = entries.some(ep => numberedEpisode(ep.title)?.title.normalize('NFKC').toLowerCase() === catalogue.title.normalize('NFKC').toLowerCase())
  return sameSeries ? collectionRangeTitle(catalogue.title, catalogue.episodes.filter(ep => ep.numbered).map(ep => ep.order)) : catalogue.title
}

/** Source membership records missing episodes too; filenames never become catalogue order. */
export function applyVideoCatalogue(d: SqlDb, resourceId: string, info: VideoWorkSource) {
  const item = getVideo(d, resourceId)
  if (!item) throw new Error('作品不存在')
  const ignored = new Set((d.prepare('SELECT source_key FROM video_scan_ignores WHERE resource_id=?').all(resourceId) as Array<{source_key:string}>).map(r=>r.source_key))
  const entries = info.episodes.filter(ep=>!ignored.has('hanime:'+ep.videoCode))
  if (!ignored.has('hanime:'+info.videoCode) && !entries.some(ep => ep.videoCode === info.videoCode)) entries.push({ videoCode: info.videoCode, title: info.currentEpisode?.title || info.title })
  if (!entries.length) return { resourceId, bundleId: '', created: false, itemsAdded: 0, filesAdded: 0, warnings: [], title: item.name_zh, catalogue: catalogueIdentity(info.title, []) }
  const catalogue = catalogueIdentity(info.title, entries)
  linkLegacyEpisode(d, resourceId, catalogue.episodes, info.currentEpisode)
  const rows = listEpisodes(d, resourceId)
  let unknown = Math.min(0, ...rows.map(ep => ep.episode)) - 1
  const contents: VideoContentInput[] = catalogue.episodes.map(entry => {
    const source = { provider: 'hanime', externalId: entry.videoCode, scope: 'episode' as const, pageUrl: 'https://hanime1.me/watch?v=' + entry.videoCode, evidence: 'playlist' as const }
    const bound = d.prepare("SELECT episode_id FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND external_id = ? AND episode_id IS NOT NULL").get(resourceId, entry.videoCode) as { episode_id: string } | undefined
    const old = rows.find(ep => ep.id === bound?.episode_id)
    const details = entry.videoCode === info.currentEpisode?.videoCode ? info.currentEpisode : undefined
    return { ...sourceEpisodeFacts(details), id: old?.id, title: entry.title, order: entry.order, number: entry.numbered ? entry.order : old?.episode ?? unknown--,
      season: old?.season || 0, tags: details?.tags, posterSource: details?.posterUrl, thumbnailSource: details?.thumbnailUrl, originalTitle: details?.originalTitle, description: details?.description, sourceUrl: source.pageUrl, sources: [source], files: [] }
  })
  const result = registerVideoContent(d, { resourceId, title: item.name_zh || catalogue.title, items: contents })
  const base = item.name_zh.replace(/\s+\d+\s*[-~–—～]\s*\d+$/, '').trim()
  const canPromote = !item.user_edited.includes('name_zh') && (entries.some(ep => ep.title === item.name_zh)
    || numberedEpisode(item.name_zh)?.title === catalogue.title || base === catalogue.title)
  if (canPromote) {
    const title = videoCollectionTitle(info.title, entries)
    d.prepare('UPDATE resource SET name_zh = ?,updated_at = ? WHERE id = ?').run(title, Date.now(), resourceId)
    if (entries.length > 1 && info.currentEpisode) {
      for (const field of ['name_en', 'summary', 'description']) if (!item.user_edited.includes(field)) d.prepare(`UPDATE resource SET ${field} = '' WHERE id = ?`).run(resourceId)
      if (!item.user_edited.includes('original_description')) d.prepare("UPDATE video_meta SET original_description = '' WHERE resource_id = ?").run(resourceId)
    }
  }
  return { ...result, title: getVideo(d, resourceId)!.name_zh, catalogue }
}
