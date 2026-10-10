import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoBundle, VideoContentInput, VideoSourceRef } from '../../../src/types/video-library.ts'
import type { VideoLibrarySyncResult, VideoWorkLibrary } from '../../../src/types/video-workflow.ts'
import { getVideo, listEpisodes, syncSeriesStatus } from './db.ts'
import { isDirectory } from './episode-details.ts'
import { getVideoWorkLibrary, listVideoAssets } from './library.ts'
import { readVideoBundle, writeBundleFiles } from './bundle.ts'
import { localVideoFiles, readLocalVideoBundle, videoPathKey } from './local-files.ts'
import { registerVideoBundleData, registerVideoContent } from './registration.ts'
import { resolveVideoOrganizeOwner } from './organize-owner.ts'
import { numberedEpisode, cleanEpisodeTitle } from './episode-identity.ts'
import { readVideoLocalMetadata } from './local-metadata.ts'
import { referencedVideoFiles, videoFileKey } from './file-references.ts'
import { ignoredVideoFile } from './scan-ignores.ts'

const inside = (root: string, file: string) => {
  const rel = path.relative(root, file)
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

/** Locate moved works by their portable UUID, never by a similar folder name. */
export function locateVideoWorkDirectory(d: SqlDb, resourceId: string, roots: string[] = []): string {
  const item = getVideo(d, resourceId)
  if (!item) throw new Error('作品不存在')
  const binding = d.prepare('SELECT bundle_id,directory_path FROM video_directories WHERE resource_id = ?').get(resourceId) as { bundle_id: string; directory_path: string } | undefined
  if (binding && isDirectory(binding.directory_path)) {
    const manifest = readVideoBundle(binding.directory_path)
    if (manifest && manifest.bundle_id !== binding.bundle_id) throw new Error('当前目录的清单属于另一作品，请重新定位')
    return binding.directory_path
  }
  const candidates = new Set<string>()
  if (isDirectory(item.path)) candidates.add(item.path)
  for (const file of [...item.parts.map(part => part.path), ...listEpisodes(d, resourceId).map(ep => ep.path), ...listVideoAssets(d, resourceId).filter(asset => asset.role === 'video').map(asset => asset.path), item.path]) {
    if (file && fs.existsSync(file) && !isDirectory(file)) candidates.add(path.dirname(file))
  }
  if (binding) {
    const matches = new Map<string, string>()
    const inspect = (directory: string) => {
      try { if (readVideoBundle(directory)?.bundle_id === binding.bundle_id) matches.set(videoPathKey(directory), directory) }
      catch { /* Unrelated damaged manifests cannot prevent locating this work. */ }
    }
    for (const candidate of candidates) inspect(candidate)
    if (!matches.size) {
      let visited = 0
      const walk = (directory: string, depth: number) => {
        if (depth > 6 || ++visited > 10000 || !isDirectory(directory) || fs.lstatSync(directory).isSymbolicLink()) return
        inspect(directory)
        if (fs.existsSync(path.join(directory, 'baoyi.json'))) return
        let entries: fs.Dirent[]; try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
        for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')) walk(path.join(directory, entry.name), depth + 1)
      }
      for (const root of roots) walk(root, 0)
    }
    if (matches.size > 1) throw new Error('发现多个相同清单的副本，请重新定位到要使用的目录')
    if (matches.size === 1) return [...matches.values()][0]
    throw new Error('作品目录无法访问，请连接磁盘或重新定位；原条目与观看进度已保留')
  }
  if (isDirectory(item.path)) return item.path
  if (candidates.size === 1) return [...candidates][0]
  throw new Error('未找到唯一的作品目录，请先重新定位视频文件')
}

function snapshotWork(d: SqlDb, resourceId: string, directory: string): VideoBundle {
  const item = getVideo(d, resourceId)!
  const library = getVideoWorkLibrary(d, resourceId)
  const relative = (file?: string) => file && inside(directory, file) ? path.relative(directory, file).split(path.sep).join('/') : ''
  const sources = d.prepare('SELECT provider,external_id AS externalId,scope,page_url AS pageUrl,evidence FROM video_sources WHERE resource_id = ?').all(resourceId) as VideoSourceRef[]
  return { excluded_files: (d.prepare('SELECT path FROM video_scan_ignores WHERE resource_id = ?').all(resourceId) as Array<{ path: string }>).map(r => relative(r.path)).filter(Boolean),
    excluded_sources: (d.prepare("SELECT source_key FROM video_scan_ignores WHERE resource_id = ? AND source_key != '' AND source_key NOT LIKE 'detached:%'").all(resourceId) as Array<{ source_key: string }>).map(r => r.source_key),
    schema_version: 1, bundle_id: library.directory?.bundleId || randomUUID(), revision: 0, updated_at: Date.now(),
    work: { media_kind:item.media_kind,video_type:item.video_type,title: item.name_zh || item.name_en || item.file_name, name_en: item.name_en, description: item.description || item.summary,
      original_description: item.original_description, category: item.category, tags: item.hanime_tags.length ? item.hanime_tags : item.tags,
      sources, thumbnail: relative(item.thumbnail_path), thumbnail_source: item.thumbnail_source, poster: relative(item.poster_path), poster_source: item.poster_source || '', provenance: {} },
    items: library.contents.map(episode => ({ id: episode.id, title: episode.title, label: episode.display_label || '', order: episode.episode,
      published_at: episode.published_at, air_date: episode.air_date, duration_sec: episode.duration_sec, studio: episode.studio,
      season: episode.season, number: episode.episode, original_title: episode.original_title, description: episode.description,
      tags: episode.tags, thumbnail: relative(episode.thumbnail_path), thumbnail_source: episode.thumbnail_source, poster_source: episode.poster_source,
      attachments: episode.assets.filter(a => a.role !== 'video' && relative(a.path)).map(a => ({ path: relative(a.path), role: a.role as 'subtitle' | 'poster' | 'attachment' })),
      original_description: episode.original_description, poster: relative(episode.poster_path), source_url: episode.source_url, notes: episode.notes,
      watch: { status: episode.watch_status, position: episode.position_sec, watchedAt: episode.watched_at }, sources: episode.sources,
      files: episode.assets.filter(asset => asset.role === 'video' && relative(asset.path)).map(asset => ({ path: relative(asset.path), quality: asset.quality, size: asset.file_size })) })),
    managed_files: {}, missing: [] }
}

/** Persist the work index plus adjacent episode records using relative media paths. */
export function persistVideoWorkBundle(d: SqlDb, resourceId: string, directory?: string): { bundle: VideoBundle; warnings: string[] } {
  const item = getVideo(d, resourceId)
  if (!item) throw new Error('作品不存在')
  directory ||= locateVideoWorkDirectory(d, resourceId)
  const snapshot = snapshotWork(d, resourceId, directory)
  const library = getVideoWorkLibrary(d, resourceId)
  const files = library.contents.flatMap(ep => ep.assets.filter(asset => asset.role === 'video' && asset.state === 'present' && inside(directory!, asset.path))
    .map(asset => ({ id: ep.id, path: asset.path, title: ep.title, label: ep.display_label, order: ep.episode, season: ep.season, number: ep.episode,
      publishedAt: ep.published_at, airDate: ep.air_date, durationSec: ep.duration_sec, studio: ep.studio,
      quality: asset.quality, size: asset.file_size, sources: ep.sources, originalTitle: ep.original_title, description: ep.description,
      tags: ep.tags, thumbnailPath: ep.thumbnail_path, thumbnailSource: ep.thumbnail_source, posterSource: ep.poster_source,
      attachments: snapshot.items.find(item => item.id === ep.id)?.attachments,
      originalDescription: ep.original_description, posterPath: ep.poster_path, sourceUrl: ep.source_url, notes: ep.notes,
      watch: { status: ep.watch_status, position: ep.position_sec, watchedAt: ep.watched_at } })))
  const result = writeBundleFiles({ mediaKind:item.media_kind,videoType:item.video_type,directory, bundleId: snapshot.bundle_id, title: snapshot.work.title, replaceWorkTitle: true,
    description: snapshot.work.description, originalDescription: snapshot.work.original_description, descriptionOptional: true,
    category: item.category, tags: snapshot.work.tags, sources: snapshot.work.sources, poster: { path: item.poster_path, source: item.poster_source },
    thumbnail: { path: item.thumbnail_path || '', source: item.thumbnail_source }, replaceContents: true,
    excludedFiles: snapshot.excluded_files, excludedSources: snapshot.excluded_sources, contents: snapshot.items, files, episodePosters: Object.fromEntries(library.contents.map(ep => [ep.id, ep.poster_path || ''])) })
  for (const entry of result.bundle.items) if (entry.thumbnail) d.prepare('UPDATE episode SET thumbnail_path = ? WHERE id = ?').run(path.join(directory, entry.thumbnail), entry.id)
  for (const entry of result.bundle.items) if (entry.poster && library.contents.some(ep => ep.id === entry.id)) {
    d.prepare('UPDATE episode SET poster_path = ? WHERE id = ?').run(path.join(directory, entry.poster), entry.id)
  }
  d.prepare('UPDATE video_directories SET metadata_state = ?, missing = ?, updated_at = ? WHERE resource_id = ?').run(result.bundle.missing.length ? 'pending' : 'complete', JSON.stringify(result.bundle.missing), Date.now(), resourceId)
  return result
}

/** Discover siblings in known media folders without claiming their shared directories. */
function syncLooseCatalogue(d: SqlDb, resourceId: string, before: VideoWorkLibrary): VideoLibrarySyncResult {
  const work = getVideo(d, resourceId)!
  const directories = new Map<string, string>()
  if (isDirectory(work.path)) directories.set(videoPathKey(work.path), work.path)
  for (const file of [work.path, ...work.parts.map(part => part.path), ...before.contents.map(ep => ep.path), ...before.assets.filter(a => a.role === 'video').map(a => a.path)]) {
    if (file && !isDirectory(file) && isDirectory(path.dirname(file))) directories.set(videoPathKey(path.dirname(file)), path.dirname(file))
  }
  if (!directories.size) throw new Error('视频目录无法访问，请连接磁盘或重新定位；原条目与观看进度已保留')
  const others = referencedVideoFiles(d, { omitWorks: [resourceId] })
  const owned = new Set(before.assets.map(asset => videoPathKey(asset.path)))
  const stem = (title: string) => numberedEpisode(title)?.title.normalize('NFKC').toLowerCase() || ''
  const names = new Set(before.contents.flatMap(ep => [ep.title, ep.original_title || '', ep.path ? path.basename(ep.path) : ''])
    .map(stem).filter(Boolean))
  const items: VideoContentInput[] = []
  const candidates = new Map<string, string>()
  for (const directory of directories.values()) for (const file of localVideoFiles(directory, isDirectory(work.path) && videoPathKey(directory) === videoPathKey(work.path))) candidates.set(videoPathKey(file), file)
  let unmatched = 0
  for (const file of candidates.values()) {
    if (owned.has(videoPathKey(file)) || others.has(videoFileKey(file)) || ignoredVideoFile(d, file, resourceId)) continue
    const metadata = readVideoLocalMetadata(file)
    const localSources = metadata.sources || []
    const unavailableSource = localSources.some(source => {
      const owners = d.prepare(`SELECT s.resource_id FROM video_sources s JOIN resource r ON r.id=s.resource_id
        WHERE s.provider=? COLLATE NOCASE AND s.external_id=? COLLATE NOCASE AND r.is_archived=0`).all(source.provider, source.externalId) as Array<{ resource_id: string }>
      return owners.some(owner => resolveVideoOrganizeOwner(d, owner.resource_id) !== resourceId)
        || !!d.prepare('SELECT path FROM video_scan_ignores WHERE resource_id=? AND source_key=? COLLATE NOCASE').get(resourceId, source.provider + ':' + source.externalId)
    })
    if (unavailableSource) continue
    const labels = [path.basename(file), metadata.originalTitle || '', metadata.title || '']
    const parsed = labels.map(label => numberedEpisode(label)).find(value => value && names.has(value.title.normalize('NFKC').toLowerCase()))
    const sourceMatches = metadata.sources?.length ? before.contents.filter(ep => ep.sources.some(source => metadata.sources!.some(local =>
      source.provider.toLowerCase() === local.provider.toLowerCase() && source.externalId === local.externalId))) : []
    const matches = sourceMatches.length ? sourceMatches : parsed
      ? before.contents.filter(ep => ep.episode === parsed.number && (parsed.season === undefined || ep.season === parsed.season)) : []
    if (matches.length > 1 || !matches.length && !parsed) { unmatched++; continue }
    const episode = matches[0]
    if (episode && localSources.some(local => episode.sources.some(source => source.provider.toLowerCase() === local.provider.toLowerCase() && source.externalId !== local.externalId))) { unmatched++; continue }
    const number = episode?.episode ?? parsed!.number, season = episode?.season ?? parsed?.season ?? 0
    const previous = items.find(item => episode ? item.id === episode.id : item.number === number && item.season === season)
    if (previous && localSources.some(local => previous.sources?.some(source => source.provider.toLowerCase() === local.provider.toLowerCase() && source.externalId !== local.externalId))) { unmatched++; continue }
    const asset = { path: file, size: fs.statSync(file).size, quality: /(?:2160|1080|720|480|360)p/i.exec(path.basename(file))?.[0].toLowerCase() || '' }
    if (previous) { previous.files.push(asset); continue }
    items.push({ ...metadata, id: episode?.id, title: episode?.title || metadata.title || cleanEpisodeTitle(path.basename(file)),
      originalTitle: episode?.original_title || metadata.originalTitle || cleanEpisodeTitle(path.basename(file)), number, season, order: number,
      sources: localSources.length ? localSources : episode?.sources || [], files: [asset] })
  }
  const result = items.length ? registerVideoContent(d, { resourceId, title: work.name_zh || work.file_name, items }) : null
  if (result?.itemsAdded && listEpisodes(d, resourceId).length > 1) d.prepare("UPDATE video_meta SET video_type='series' WHERE resource_id=?").run(resourceId)
  syncSeriesStatus(d, resourceId)
  const library = getVideoWorkLibrary(d, resourceId)
  const missing = library.assets.filter(asset => asset.role === 'video' && asset.state !== 'present').length
  const unassigned = unmatched ? `另有 ${unmatched} 个视频无法确认归属，可用“导入视频”单独识别` : ''
  return { library, itemsAdded: result?.itemsAdded || 0, filesAdded: result?.filesAdded || 0, pathsRepaired: 0, duplicatesMerged: 0,
    warnings: [...result?.warnings || [], ...unassigned ? [unassigned] : []], message: `检查完成：新增 ${result?.filesAdded || 0} 个视频` + (missing ? `，${missing} 个文件不可用` : '') + (unassigned ? `；${unassigned}` : '') }
}

export function syncVideoWorkFiles(d: SqlDb, resourceId: string, options: { roots?: string[]; persist?: boolean } = {}): VideoLibrarySyncResult {
  resourceId = resolveVideoOrganizeOwner(d, resourceId)
  const before = getVideoWorkLibrary(d, resourceId)
  if (!before.directory) {
    return syncLooseCatalogue(d, resourceId, before)
  }
  const directory = locateVideoWorkDirectory(d, resourceId, options.roots)
  const bundle = readLocalVideoBundle(directory) || snapshotWork(d, resourceId, directory)
  let registered: ReturnType<typeof registerVideoBundleData>
  d.exec('SAVEPOINT video_work_sync')
  try {
    registered = registerVideoBundleData(d, directory, bundle, resourceId)
    if (registered.resourceId !== resourceId) throw new Error('目录资料指向另一作品，请核对目录归属')
    d.exec('RELEASE SAVEPOINT video_work_sync')
  } catch (error) { d.exec('ROLLBACK TO SAVEPOINT video_work_sync'); d.exec('RELEASE SAVEPOINT video_work_sync'); throw error }
  syncSeriesStatus(d, resourceId)
  const warnings = [...registered.warnings || []]
  if (options.persist !== false) {
    try { warnings.push(...persistVideoWorkBundle(d, resourceId, directory).warnings) }
    catch (error) { warnings.push('文件已检查，本地资料保存未完成：' + String(error)) }
  }
  const library = getVideoWorkLibrary(d, resourceId)
  const missing = library.assets.filter(asset => asset.role === 'video' && asset.state !== 'present').length
  const message = `检查完成：新增 ${registered.filesAdded} 个视频，修复 ${registered.pathsRepaired || 0} 处目录，合并 ${registered.duplicatesMerged || 0} 个重复条目` + (missing ? `，${missing} 个文件不可用` : '')
  return { library, itemsAdded: registered.itemsAdded, filesAdded: registered.filesAdded, pathsRepaired: registered.pathsRepaired || 0,
    duplicatesMerged: registered.duplicatesMerged || 0, warnings, message }
}
