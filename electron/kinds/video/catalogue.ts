import type { SqlDb } from '../../services/schema.ts'
import type { VideoContentInput } from '../../../src/types/video-library.ts'
import type { VideoWorkSource } from './download/workflow.ts'
import { getVideo, listEpisodes } from './db.ts'
import { catalogueIdentity, collectionRangeTitle, numberedEpisode } from './episode-identity.ts'
import { linkLegacyEpisode, sourceEpisodeFacts } from './episode-details.ts'
import { registerVideoContent } from './registration.ts'
import { releasePlaceholderClaims } from './placeholders.ts'
export { placeholderEpisodeIds, releasePlaceholderClaims } from './placeholders.ts'

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

/**
 * 「占位集」= 播放列表带来的、本地没有任何文件的集（实测第三轮）。
 * 之前 applyVideoCatalogue 把列表里每一条都建成占位集并绑定来源，哪怕标题根本不是同一系列
 * （作者频道的整个列表也会进来）；下载别的作品时 resolveVideoOwnership 查到这些来源就报「已在其他作品」，
 * 同系列不同部再也建不了自己的合集。现在：
 *   1. 只给 catalogueIdentity 判定为同系列（numbered）的条目建占位集；
 *   2. 别的作品要下载某一集时，占位集不算「已归属」，登记前把占位集让出去（releasePlaceholderClaims）。
 */
/** 启动时一次性清掉历史遗留的、不是同系列的占位集（幂等；真库里查到 51 条这种） */
export function pruneStrayPlaceholders(d: SqlDb): number {
  const rows = d.prepare(`SELECT e.id, e.resource_id, e.title, r.name_zh FROM episode e JOIN resource r ON r.id = e.resource_id
    WHERE e.path = '' AND e.episode < 0 AND e.position_sec = 0 AND e.watch_status = 'unwatched' AND e.description = '' AND e.poster_path = ''
      AND NOT EXISTS (SELECT 1 FROM video_episode_assets ea JOIN video_assets a ON a.id = ea.asset_id WHERE ea.episode_id = e.id AND a.role = 'video')
      AND NOT EXISTS (SELECT 1 FROM video_sources s WHERE s.episode_id = e.id AND s.evidence != 'playlist')`).all() as Array<{ id: string; resource_id: string; title: string; name_zh: string }>
  const byWork = new Map<string, typeof rows>()
  for (const row of rows) byWork.set(row.resource_id, [...(byWork.get(row.resource_id) || []), row])
  let removed = 0
  for (const [resourceId, group] of byWork) {
    const codes = d.prepare("SELECT episode_id, external_id FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND episode_id IS NOT NULL").all(resourceId) as Array<{ episode_id: string; external_id: string }>
    const entries = (d.prepare('SELECT id, title FROM episode WHERE resource_id = ?').all(resourceId) as Array<{ id: string; title: string }>)
      .flatMap(ep => { const code = codes.find(c => c.episode_id === ep.id)?.external_id; return code ? [{ videoCode: code, title: ep.title }] : [] })
    const catalogue = catalogueIdentity(group[0].name_zh, entries)
    for (const row of group) {
      const code = codes.find(c => c.episode_id === row.id)?.external_id
      if (catalogue.episodes.find(ep => ep.videoCode === code)?.numbered) continue
      d.prepare('DELETE FROM episode WHERE id = ?').run(row.id); removed++
    }
  }
  return removed
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
  // 没编号（不是同系列）的条目不建占位集，也不绑来源；已经有本地文件或已绑定的照旧保留
  const wanted = catalogue.episodes.filter(entry => entry.numbered || entry.videoCode === info.videoCode
    || d.prepare("SELECT 1 FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND external_id = ? AND episode_id IS NOT NULL").get(resourceId, entry.videoCode))
  for (const entry of wanted) releasePlaceholderClaims(d, entry.videoCode, resourceId)
  const contents: VideoContentInput[] = wanted.map(entry => {
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
  return { ...result, title: getVideo(d, resourceId)!.name_zh, catalogue: { ...catalogue, episodes: wanted } }
}
