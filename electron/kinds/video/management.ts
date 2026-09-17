import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoRemovalRequest, VideoRemovalPreview, VideoBulkPatch } from '../../../src/types/video-management.ts'
import { deleteVideo, getVideo, listEpisodes, updateVideo, syncSeriesStatus } from './db.ts'
import { getVideoWorkLibrary, registerVideoAsset } from './library.ts'
import { persistVideoWorkBundle } from './local-sync.ts'
import { metadataTags } from './local-metadata.ts'
import { episodeSidecarPath } from './bundle.ts'
import { referencedVideoFiles, videoFileKey } from './file-references.ts'

const key = (p: string) => path.resolve(p).normalize('NFC').toLowerCase()
function selected(d: SqlDb, input: VideoRemovalRequest) {
  if (!input || !Array.isArray(input.resourceIds) || !input.resourceIds.length || input.resourceIds.length > 500 || !['remove', 'detach'].includes(input.action)) throw new Error('请选择要管理的作品或单集')
  const ids = [...new Set(input.resourceIds)]
  const works = ids.map(id => getVideo(d, id))
  if (works.some(w => !w)) throw new Error('所选作品已变化，请重新选择')
  const libraries = ids.map(id => getVideoWorkLibrary(d, id))
  const episodes = libraries.flatMap(l => l.contents).filter(e => !input.episodeId || e.id === input.episodeId)
  if (input.episodeId && (ids.length !== 1 || episodes.length !== 1)) throw new Error('单集已变化，请重新选择')
  if (input.action === 'detach' && (!input.episodeId || input.deleteLocal)) throw new Error('移出合集只调整归属，请选择一集并保留文件')
  return { ids, works: works.map(w => w!), libraries, episodes }
}
export function previewVideoRemoval(d: SqlDb, input: VideoRemovalRequest): VideoRemovalPreview {
  const { ids, works, libraries, episodes } = selected(d, input)
  const paths = new Map<string, string>()
  const protectedFiles = referencedVideoFiles(d, { omitWorks: ids, omitEpisodes: episodes.map(e => e.id), keepWorks: input.episodeId ? ids : [] })
  const add = (p?: string) => { if (p && path.isAbsolute(p)) paths.set(key(p), p) }
  if (input.episodeId) episodes.forEach(e => { e.assets.forEach(a => add(a.path)); add(e.path); add(e.poster_path); add(e.thumbnail_path) })
  else for (const [i, library] of libraries.entries()) {
    library.assets.forEach(a => add(a.path))
    works[i].linked_files.forEach(a => add(a.path))
    works[i].parts.forEach(a => add(a.path))
  }
  for (const e of episodes) if (e.path) add(episodeSidecarPath(e.path))
  const files = [...paths.values()].map(file => {
    let size = 0, present = false
    try { const stat = fs.lstatSync(file); size = stat.size; present = stat.isFile() && !stat.isSymbolicLink() } catch { /* Missing content can still be removed. */ }
    return { path: file, size, present, shared: protectedFiles.has(videoFileKey(file)) }
  }).sort((a,b) => a.path.localeCompare(b.path))
  const request = { resourceIds: ids, episodeId: input.episodeId, action: input.action, deleteLocal: !!input.deleteLocal }
  const stamps = files.map(f => { try { const s = fs.lstatSync(f.path); return [f.path,s.ino,s.size,s.mtimeMs] } catch { return [f.path,'missing'] } })
  const fingerprint = createHash('sha256').update(JSON.stringify({ request, works,
    episodes: episodes.map(e => ({ ...e, assets: e.assets.map(({ checked_at: _checked, ...asset }) => asset) })), files, stamps })).digest('hex')
  return { fingerprint, request, titles: input.episodeId ? episodes.map(e => e.title) : works.map(w => w.name_zh || w.file_name), episodeCount: episodes.length, files }
}

export async function applyVideoRemoval(d: SqlDb, preview: VideoRemovalPreview, trash?: (file: string) => Promise<void>) {
  const current = previewVideoRemoval(d, preview.request)
  if (current.fingerprint !== preview.fingerprint) throw new Error('文件或资料已变化，请重新查看操作范围')
  const { ids, works, episodes } = selected(d, current.request)
  const { episodeId, deleteLocal, action } = current.request
  if (deleteLocal) {
    if (!trash) throw new Error('当前环境无法移入回收站')
    for (const file of current.files.filter(f => f.present && !f.shared)) await trash(file.path)
  }
  let detachedId = ''
  d.exec('SAVEPOINT video_removal')
  try {
    if (action === 'detach') {
      const episode = episodes[0], work = works[0]
      const files = episode.assets.filter(a => a.role === 'video')
      const first = files[0]?.path || episode.path
      if (!first) throw new Error('无本地文件的待补集请直接移除记录')
      const occupied = d.prepare('SELECT id,is_archived FROM resource WHERE path = ? COLLATE NOCASE').get(first) as { id: string; is_archived: number } | undefined
      if (occupied && !occupied.is_archived) throw new Error('该文件已属于独立作品，不能重复移出')
      detachedId = occupied?.id || randomUUID()
      if (occupied && listEpisodes(d, detachedId).length) throw new Error('原独立条目仍有内容，请先核对归属')
      const resource = { ...(d.prepare('SELECT * FROM resource WHERE id = ?').get(work.id) as Record<string, unknown>), id: detachedId,
        path: first, file_name: path.basename(first), source_dir: path.dirname(first), is_archived: 0, created_at: Date.now(), updated_at: Date.now(),
        name_zh: episode.title, name_en: episode.original_title || '', summary: episode.description || '', description: episode.description || '',
        tags: JSON.stringify(episode.tags || []), file_size: files.reduce((n,f) => n + f.file_size, 0) }
      const meta = { ...(d.prepare('SELECT * FROM video_meta WHERE resource_id = ?').get(work.id) as Record<string, unknown>), resource_id: detachedId,
        video_type: 'movie', hanime_tags: JSON.stringify(episode.tags || []), hanime_id: episode.sources.find(s => s.provider === 'hanime')?.externalId || '',
        poster_path: episode.poster_path || '', poster_source: episode.poster_source || '', thumbnail_path: episode.thumbnail_path || '', thumbnail_source: episode.thumbnail_source || '',
        parts: JSON.stringify(files.map(f => ({ path: f.path, file_size: f.file_size, duration_sec: 0, label: f.quality }))),
        watch_status: episode.watch_status, position_sec: episode.position_sec, linked_files: '[]' }
      for (const [table, row, primary] of [['resource', resource, 'id'], ['video_meta', meta, 'resource_id']] as const) {
        const entries = Object.entries(row)
        d.prepare(`INSERT INTO ${table} (${entries.map(([k]) => k).join(',')}) VALUES (${entries.map(() => '?').join(',')}) ON CONFLICT(${primary}) DO UPDATE SET ${entries.filter(([k]) => k !== primary).map(([k]) => `${k}=excluded.${k}`).join(',')}`).run(...entries.map(([,v]) => v))
      }
      d.prepare('INSERT OR REPLACE INTO video_detached_owners(resource_id) VALUES (?)').run(detachedId)
      d.prepare('UPDATE episode SET resource_id = ? WHERE id = ?').run(detachedId, episode.id)
      d.prepare('UPDATE video_sources SET resource_id = ? WHERE episode_id = ?').run(detachedId, episode.id)
      for (const asset of episode.assets) {
        const others = d.prepare('SELECT episode_id FROM video_episode_assets WHERE asset_id = ? AND episode_id != ?').all(asset.id, episode.id)
        if (others.length) {
          d.prepare('DELETE FROM video_episode_assets WHERE asset_id = ? AND episode_id = ?').run(asset.id, episode.id)
          registerVideoAsset(d, { resourceId: detachedId, episodeId: episode.id, path: asset.path, role: asset.role, quality: asset.quality, size: asset.file_size })
        } else d.prepare('UPDATE video_assets SET resource_id = ? WHERE id = ?').run(detachedId, asset.id)
      }
    }
    for (const episode of episodes) {
      const videoPaths = episode.assets.filter(a => a.role === 'video').map(a => a.path)
      for (const file of videoPaths) {
        d.prepare('INSERT OR REPLACE INTO video_scan_ignores(path,resource_id,source_key,created_at) VALUES (?,?,?,?)').run(path.resolve(file), episode.resource_id, action === 'detach' ? 'detached:' + detachedId : '', Date.now())
        if (action === 'detach') d.prepare('UPDATE video_scan_state SET resource_id=? WHERE path=?').run(detachedId, path.resolve(file))
        else d.prepare('DELETE FROM video_scan_state WHERE path = ?').run(path.resolve(file))
      }
      for (const s of episode.sources) d.prepare('INSERT OR REPLACE INTO video_scan_ignores(path,resource_id,source_key,created_at) VALUES (?,?,?,?)').run('source:' + episode.resource_id + ':' + s.provider + ':' + s.externalId, episode.resource_id, s.provider + ':' + s.externalId, Date.now())
    }
    if (episodeId) {
      const removedPaths = new Set(episodes[0].assets.filter(a => a.role === 'video').map(a => key(a.path)))
      const parts = works[0].parts.filter(p => !removedPaths.has(key(p.path)))
      d.prepare('UPDATE video_meta SET parts = ? WHERE resource_id = ?').run(JSON.stringify(parts), ids[0])
      const remainingSource = d.prepare("SELECT external_id FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND episode_id IS NOT NULL AND episode_id != ? LIMIT 1").get(ids[0], episodeId) as { external_id: string } | undefined
      d.prepare('UPDATE video_meta SET hanime_id = ? WHERE resource_id = ?').run(remainingSource?.external_id || '', ids[0])
    }
    if (action === 'remove' && episodeId) {
      d.prepare('DELETE FROM episode WHERE id = ?').run(episodeId)
      for (const asset of episodes[0].assets) if (!d.prepare('SELECT asset_id FROM video_episode_assets WHERE asset_id = ?').get(asset.id)) d.prepare('DELETE FROM video_assets WHERE id = ?').run(asset.id)
    } else if (action === 'remove') {
      for (const file of current.files) d.prepare('INSERT OR REPLACE INTO video_scan_ignores(path,resource_id,source_key,created_at) VALUES (?,?,?,?)').run(path.resolve(file.path), ids[0], '', Date.now())
      ids.forEach(id => deleteVideo(d, id))
    }
    if (episodeId && action === 'remove' && !listEpisodes(d,ids[0]).length && works[0].video_type === 'movie' && !d.prepare('SELECT resource_id FROM video_directories WHERE resource_id=?').get(ids[0])) deleteVideo(d,ids[0])
    d.exec('RELEASE SAVEPOINT video_removal')
  } catch (error) { d.exec('ROLLBACK TO SAVEPOINT video_removal'); d.exec('RELEASE SAVEPOINT video_removal'); throw error }
  const warnings: string[] = []
  if (episodeId) for (const id of ids) {
    if (!getVideo(d,id)) continue
    syncSeriesStatus(d, id)
    if (d.prepare('SELECT resource_id FROM video_directories WHERE resource_id = ?').get(id)) {
      try { warnings.push(...persistVideoWorkBundle(d,id).warnings) } catch (e) { warnings.push('库内操作已完成，本地清单待保存：' + String(e)) }
    }
  }
  return { detachedId, warnings }
}

export function bulkUpdateVideos(d: SqlDb, resourceIds: string[], patch: VideoBulkPatch) {
  if (!Array.isArray(resourceIds) || !resourceIds.length || resourceIds.length > 500 || !patch || typeof patch !== 'object') throw new Error('批量操作参数无效')
  const add = metadataTags(patch.addTags), remove = new Set(metadataTags(patch.removeTags))
  d.exec('SAVEPOINT video_bulk')
  try {
    for (const id of [...new Set(resourceIds)]) {
      const item = getVideo(d, id); if (!item) throw new Error('所选作品已变化，请重新选择')
      updateVideo(d, id, { ...(patch.collection !== undefined ? { collection_name: String(patch.collection).trim().slice(0,80) } : {}),
        ...(patch.addTags || patch.removeTags ? { tags: metadataTags([...item.tags, ...add]).filter(t => !remove.has(t)) } : {}),
        ...(patch.removeTags ? { hanime_tags: item.hanime_tags.filter(t => !remove.has(t)) } : {}) })
    }
    d.exec('RELEASE SAVEPOINT video_bulk')
  } catch (e) { d.exec('ROLLBACK TO SAVEPOINT video_bulk'); d.exec('RELEASE SAVEPOINT video_bulk'); throw e }
  return resourceIds.length
}
