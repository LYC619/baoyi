import type { SqlDb } from '../../services/schema.ts'
import type { VideoContentInput } from '../../../src/types/video-library.ts'
import type { VideoWorkSource } from './download/workflow.ts'
import { getVideo, listEpisodes } from './db.ts'
import { catalogueIdentity, collectionRangeTitle, numberedEpisode } from './episode-identity.ts'
import { linkLegacyEpisode, sourceEpisodeFacts } from './episode-details.ts'
import { registerVideoContent } from './registration.ts'

const key = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * 作品名能不能提升为系列名（B7）。
 *
 * 之前只靠字符串比对：某集标题 == 作品名，或 numberedEpisode(作品名).title == 系列名。单集刮削写进
 * 去的 name_zh 是页面的中文标题（可能带全角空格、`＃1`），字符串对不上就永远不提升。
 * 现在**按来源编号**判：作品的 hanime_id 或它任一单集的来源编号命中系列目录里的任一条，就是同一部作品；
 * 字符串比对只留作没有编号时的兜底。用户手改过名字（user_edited 含 name_zh）仍然不动。
 */
export function canPromoteWorkTitle(d: SqlDb, resourceId: string, entries: Array<{ videoCode: string; title: string }>, catalogueTitle: string): boolean {
  const item = getVideo(d, resourceId)
  if (!item || item.user_edited.includes('name_zh')) return false
  const codes = new Set(entries.map(entry => entry.videoCode))
  if (item.hanime_id && codes.has(item.hanime_id)) return true
  const bound = d.prepare("SELECT external_id FROM video_sources WHERE resource_id = ? AND provider = 'hanime'").all(resourceId) as Array<{ external_id: string }>
  if (bound.some(row => codes.has(row.external_id))) return true
  const base = item.name_zh.replace(/\s+\d+\s*[-~–—～]\s*\d+$/, '').trim()
  return entries.some(ep => key(ep.title) === key(item.name_zh)) || key(numberedEpisode(item.name_zh)?.title || '') === key(catalogueTitle) || key(base) === key(catalogueTitle)
}

/**
 * 单集升合集时，作品级的简介（原来那一集刮的）挪到对应那一集，而不是丢掉（B7）。
 * 对应的那一集 = 作品 hanime_id 绑定的那一集；它自己已经有简介就不覆盖。作品简介随后由调用方置空。
 */
export function moveWorkDescriptionToEpisode(d: SqlDb, resourceId: string): void {
  const item = getVideo(d, resourceId)
  if (!item || item.user_edited.includes('description')) return
  const description = item.description || item.summary
  if (!description || !item.hanime_id) return
  const row = d.prepare("SELECT episode_id FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND external_id = ? AND episode_id IS NOT NULL").get(resourceId, item.hanime_id) as { episode_id: string } | undefined
  if (!row) return
  d.prepare("UPDATE episode SET description = ? WHERE id = ? AND description = ''").run(description, row.episode_id)
  if (item.original_description) d.prepare("UPDATE episode SET original_description = ? WHERE id = ? AND original_description = ''").run(item.original_description, row.episode_id)
}

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
  if (canPromoteWorkTitle(d, resourceId, entries, catalogue.title)) {
    const title = videoCollectionTitle(info.title, entries)
    d.prepare('UPDATE resource SET name_zh = ?,updated_at = ? WHERE id = ?').run(title, Date.now(), resourceId)
    if (entries.length > 1 && info.currentEpisode) {
      moveWorkDescriptionToEpisode(d, resourceId)
      for (const field of ['name_en', 'summary', 'description']) if (!item.user_edited.includes(field)) d.prepare(`UPDATE resource SET ${field} = '' WHERE id = ?`).run(resourceId)
      if (!item.user_edited.includes('original_description')) d.prepare("UPDATE video_meta SET original_description = '' WHERE resource_id = ?").run(resourceId)
    }
  }
  return { ...result, title: getVideo(d, resourceId)!.name_zh, catalogue }
}
