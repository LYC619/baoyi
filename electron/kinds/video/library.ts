import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoAsset, VideoDirectory } from '../../../src/types/video-library.ts'
import type { VideoWorkLibrary } from '../../../src/types/video-workflow.ts'
import { getVideo, listEpisodes } from './db.ts'
import { resolveVideoOrganizeOwner } from './organize-owner.ts'
import { isDirectory, linkLegacyEpisode } from './episode-details.ts'

export function upsertVideoDirectory(d: SqlDb, input: { resourceId: string; root?: string; directory: string; bundleId?: string; metadataState?: string }): VideoDirectory {
  const directory = path.resolve(input.directory)
  const root = input.root ? path.resolve(input.root) : path.dirname(directory)
  const relativePath = path.relative(root, directory)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) throw new Error('作品目录必须位于影视库根目录内')
  const old = d.prepare('SELECT bundle_id, directory_path FROM video_directories WHERE resource_id = ?').get(input.resourceId) as { bundle_id: string; directory_path: string } | undefined
  if (old && old.directory_path.toLowerCase() !== directory.toLowerCase()) throw new Error('作品已绑定另一目录，请使用重新定位或整理操作')
  const bundleId = old?.bundle_id || input.bundleId || randomUUID()
  const conflict = d.prepare('SELECT resource_id FROM video_directories WHERE bundle_id = ? OR directory_path = ? COLLATE NOCASE').get(bundleId, directory) as { resource_id: string } | undefined
  if (conflict && conflict.resource_id !== input.resourceId) throw new Error('目录或资源清单已绑定其他作品')
  const now = Date.now()
  d.prepare(`INSERT INTO video_directories (resource_id, bundle_id, root, relative_path, directory_path, metadata_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_id) DO UPDATE SET bundle_id = excluded.bundle_id, root = excluded.root,
      relative_path = excluded.relative_path, directory_path = excluded.directory_path,
      metadata_state = excluded.metadata_state, updated_at = excluded.updated_at`).run(
    input.resourceId, bundleId, root, relativePath, directory, input.metadataState || 'pending', now, now
  )
  return { resourceId: input.resourceId, bundleId, root, relativePath, path: directory, metadataState: input.metadataState || 'pending' }
}

function rowToAsset(row: Record<string, unknown>): VideoAsset {
  return { id: String(row.id), resource_id: String(row.resource_id), path: String(row.path), role: row.role as VideoAsset['role'], quality: String(row.quality ?? ''), file_size: Number(row.file_size) || 0, state: row.state as VideoAsset['state'], checked_at: Number(row.checked_at) || 0, created_at: Number(row.created_at) || 0 }
}

export function registerVideoAsset(d: SqlDb, input: { resourceId: string; episodeId?: string; path: string; role?: VideoAsset['role']; quality?: string; size?: number }): VideoAsset {
  const assetPath = path.resolve(input.path)
  if (isDirectory(assetPath)) throw new Error('文件夹不能作为视频文件登记')
  const role = input.role || 'video'
  const existing = d.prepare('SELECT * FROM video_assets WHERE resource_id = ? AND path = ? COLLATE NOCASE AND role = ?').get(input.resourceId, assetPath, role) as Record<string, unknown> | undefined
  const now = Date.now()
  const size = Number(input.size) || (() => { try { return fs.statSync(assetPath).size } catch { return 0 } })()
  let id = String(existing?.id || randomUUID())
  d.prepare(`INSERT INTO video_assets (id, resource_id, path, role, quality, file_size, state, checked_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_id, path, role) DO UPDATE SET quality = excluded.quality, file_size = excluded.file_size,
      state = excluded.state, checked_at = excluded.checked_at`).run(id, input.resourceId, String(existing?.path || assetPath), role, String(input.quality ?? existing?.quality ?? ''), size, fs.existsSync(assetPath) ? 'present' : 'missing', now, Number(existing?.created_at) || now)
  const row = d.prepare('SELECT * FROM video_assets WHERE resource_id = ? AND path = ? COLLATE NOCASE AND role = ?').get(input.resourceId, assetPath, role) as Record<string, unknown>
  id = String(row.id)
  if (input.episodeId) d.prepare('INSERT INTO video_episode_assets (episode_id, asset_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(input.episodeId, id)
  return rowToAsset(row)
}

export function listVideoAssets(d: SqlDb, resourceId: string, episodeId?: string): VideoAsset[] {
  const sql = episodeId
    ? `SELECT a.* FROM video_assets a JOIN video_episode_assets ea ON ea.asset_id = a.id WHERE a.resource_id = ? AND ea.episode_id = ? ORDER BY a.created_at`
    : 'SELECT * FROM video_assets WHERE resource_id = ? ORDER BY created_at'
  return (d.prepare(sql).all(...(episodeId ? [resourceId, episodeId] : [resourceId])) as Array<Record<string, unknown>>).map(rowToAsset)
}

export function checkVideoAssets(d: SqlDb, resourceId: string, allowOffline = false): number {
  const assets = listVideoAssets(d, resourceId)
  const now = Date.now()
  const update = d.prepare('UPDATE video_assets SET state = ?, checked_at = ? WHERE id = ?')
  let changed = 0
  for (const asset of assets) {
    let state: VideoAsset['state'] = 'missing'
    try { state = fs.statSync(asset.path).isFile() ? 'present' : 'missing' } catch { state = allowOffline || !fs.existsSync(path.parse(asset.path).root) ? 'offline' : 'missing' }
    if (state !== asset.state) changed++
    update.run(state, now, asset.id)
  }
  return changed
}

/** Legacy records are projected into assets without moving or deleting files. */
export function getVideoWorkLibrary(d: SqlDb, resourceId: string): VideoWorkLibrary {
  resourceId = resolveVideoOrganizeOwner(d, resourceId)
  const item = getVideo(d, resourceId)
  if (!item) throw new Error('作品不存在')
  // Earlier releases registered a movie's containing folder alongside its real parts.
  // Only remove proven directories; an unavailable video must retain its missing state.
  for (const asset of listVideoAssets(d, resourceId)) if (isDirectory(asset.path)) d.prepare('DELETE FROM video_assets WHERE id = ?').run(asset.id)
  linkLegacyEpisode(d, resourceId)
  const episodes = listEpisodes(d, resourceId)
  for (const episode of episodes) if (episode.path && !isDirectory(episode.path)) registerVideoAsset(d, { resourceId, episodeId: episode.id, path: episode.path, size: episode.file_size })
  if (item.video_type === 'movie') {
    if (item.path && !isDirectory(item.path) && /\.[a-z0-9]{2,5}$/i.test(item.path)) registerVideoAsset(d, { resourceId, path: item.path })
    for (const part of item.parts) if (part.path && !isDirectory(part.path)) registerVideoAsset(d, { resourceId, path: part.path })
  }
  checkVideoAssets(d, resourceId)
  const assets = listVideoAssets(d, resourceId)
  const directory = d.prepare(`SELECT resource_id AS resourceId, bundle_id AS bundleId, root, relative_path AS relativePath,
    directory_path AS path, metadata_state AS metadataState FROM video_directories WHERE resource_id = ?`).get(resourceId) as VideoDirectory | undefined
  return { resourceId, directory: directory || null, assets, contents: episodes.map(ep => ({ ...ep, assets: listVideoAssets(d, resourceId, ep.id),
    sources: d.prepare('SELECT provider, external_id AS externalId, scope, page_url AS pageUrl, evidence FROM video_sources WHERE episode_id = ?').all(ep.id) as VideoWorkLibrary['contents'][number]['sources'] })) }
}

export function setDefaultVideoAsset(d: SqlDb, episodeId: string, assetId: string): boolean {
  const row = d.prepare(`SELECT a.path, a.file_size FROM video_assets a JOIN video_episode_assets ea ON ea.asset_id = a.id WHERE ea.episode_id = ? AND a.id = ?`).get(episodeId, assetId) as { path: string; file_size: number } | undefined
  if (!row) return false
  d.prepare('UPDATE episode SET path = ?, file_size = ? WHERE id = ?').run(row.path, row.file_size, episodeId)
  return true
}

export function relocateVideoAsset(d: SqlDb, assetId: string, target: string): boolean {
  if (!path.isAbsolute(target) || !fs.statSync(target).isFile()) throw new Error('请选择实际视频文件')
  const asset = d.prepare('SELECT * FROM video_assets WHERE id = ?').get(assetId) as { path: string; resource_id: string } | undefined
  if (!asset) return false
  d.exec('SAVEPOINT relocate_video_asset')
  try {
    const size = fs.statSync(target).size
    d.prepare("UPDATE video_assets SET path = ?, state = 'present', checked_at = ?, file_size = ? WHERE id = ?").run(path.resolve(target), Date.now(), size, assetId)
    d.prepare('UPDATE episode SET path = ?, file_size = ? WHERE resource_id = ? AND path = ? COLLATE NOCASE').run(target, size, asset.resource_id, asset.path)
    d.prepare('UPDATE resource SET path = ?, updated_at = ? WHERE id = ? AND path = ? COLLATE NOCASE').run(target, Date.now(), asset.resource_id, asset.path)
    d.exec('RELEASE SAVEPOINT relocate_video_asset'); return true
  } catch (error) { d.exec('ROLLBACK TO SAVEPOINT relocate_video_asset'); d.exec('RELEASE SAVEPOINT relocate_video_asset'); throw error }
}
