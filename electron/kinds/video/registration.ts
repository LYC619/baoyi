import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoRegistration, VideoRegistrationResult, VideoSourceRef } from '../../../src/types/video-library.ts'
import { insertVideo, getVideo, listEpisodes, videoOwnerForFiles, type VideoPayload } from './db.ts'
import { ensureBundleId, resolveVideoOwnership } from './identity.ts'
import { registerVideoAsset, upsertVideoDirectory } from './library.ts'
import { resolveBundlePath } from './bundle.ts'
import type { VideoFacts } from './facts.ts'
import { isVideoOrganizeSurvivor, resolveVideoOrganizeOwner, resolveVideoOrganizePathOwner, videoOrganizeAssetPath, videoOrganizeEpisodeForFile } from './organize-owner.ts'
import { fillEpisodeDetails, reconcileEpisodeSlots, linkLegacyEpisode, sourceEpisodeFacts, type SourceEpisodeDetails } from './episode-details.ts'
import { hanimeChannel } from './hentai/channel.ts'
import { HENTAI_CATEGORY } from './taxonomy.ts'
import { numberedEpisode } from './episode-identity.ts'
import { absorbDuplicateVideoCards, localBundleItems, readLocalVideoBundle, rebaseMovedVideoDirectory, videoPathKey } from './local-files.ts'
import { ignoredVideoFile, clearVideoScanIgnores } from './scan-ignores.ts'

export function managedVideoOwner(d: SqlDb, files: string[]): string {
  const detached = files.length ? d.prepare('SELECT a.resource_id FROM video_assets a JOIN video_detached_owners o ON o.resource_id=a.resource_id WHERE a.path=? COLLATE NOCASE').get(path.resolve(files[0])) as { resource_id: string } | undefined : undefined
  if (detached) return detached.resource_id
  const directories = d.prepare('SELECT resource_id, directory_path FROM video_directories').all() as Array<{ resource_id: string; directory_path: string }>
  const matches = directories.filter(row => files.length && files.every(file => {
    const relative = path.relative(row.directory_path, file)
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  })).sort((a, b) => b.directory_path.length - a.directory_path.length)
  if (matches.length) return resolveVideoOrganizeOwner(d, matches[0].resource_id)
  const owner = videoOwnerForFiles(d, files)
  if (!owner) return ''
  return isVideoOrganizeSurvivor(d, owner.id)
    || directories.some(row => row.resource_id === owner.id) ? owner.id : ''
}

/** Scan/AI payloads share the same registration boundary and file/source records. */
export function registerVideoPayload(d: SqlDb, payload: VideoPayload, splitFromId = '') {
  const files = payload.video_type === 'movie'
    ? (payload.parts.length ? payload.parts : [{ path: payload.path, file_size: payload.file_size }])
    : payload.episodes.filter(ep => ep.path).map(ep => ({ path: ep.path!, file_size: ep.file_size }))
  const ownerId = resolveVideoOrganizePathOwner(d, payload.path) || managedVideoOwner(d, files.map(file => file.path))
  const owner = ownerId ? getVideo(d, ownerId) : null
  if (owner && ownerId && files.length) {
    const source: VideoSourceRef[] = payload.hanime_id ? [{ provider: 'hanime', externalId: payload.hanime_id, scope: 'episode',
      pageUrl: 'https://hanime1.me/watch?v=' + payload.hanime_id, evidence: 'legacy' }] : []
    const numbered = numberedEpisode(payload.name_zh || '')
    const existingEpisode = listEpisodes(d, ownerId).find(episode => files.some(file => file.path.toLowerCase() === episode.path.toLowerCase()))
    const items = payload.video_type === 'movie'
      ? [{ id: existingEpisode?.id || videoOrganizeEpisodeForFile(d, ownerId, files[0].path), title: payload.name_zh || payload.name_en,
          order: existingEpisode?.episode ?? numbered?.number ?? 1, number: existingEpisode?.episode ?? numbered?.number,
          season: existingEpisode?.season ?? numbered?.season ?? 0, originalTitle: payload.name_en, description: payload.description || payload.summary,
          durationSec: payload.duration_sec,
          tags: payload.hanime_tags?.length ? payload.hanime_tags : payload.tags, posterSource: payload.poster_path,
          attachments: payload.linked_files.map(a => ({ path: a.path, role: 'attachment' as const })),
          originalDescription: payload.original_description, sources: source, sourceUrl: source[0]?.pageUrl,
          posterPath: path.isAbsolute(payload.poster_path) ? payload.poster_path : '',
          files: files.map(file => ({ path: file.path, size: file.file_size, quality: payload.resolution })) }]
      : payload.episodes.filter(ep => ep.path).map((ep, index) => ({
          ...ep.local_metadata,
          durationSec: ep.duration_sec || ep.local_metadata?.durationSec, airDate: ep.air_date || ep.local_metadata?.airDate,
          id: videoOrganizeEpisodeForFile(d, ownerId, ep.path!, ep.season, ep.episode),
          title: ep.title || '', label: ep.display_label, order: index + 1, season: ep.season, number: ep.episode,
          files: [{ path: ep.path!, size: ep.file_size }]
        }))
    const result = registerVideoContent(d, {
      resourceId: ownerId, title: owner.name_zh || owner.name_en || owner.file_name,
      directory: (d.prepare('SELECT directory_path FROM video_directories WHERE resource_id = ?').get(ownerId) as { directory_path: string } | undefined)?.directory_path, items
    })
    const episodeId = listEpisodes(d, ownerId).find(episode => files.some(file => file.path.toLowerCase() === episode.path.toLowerCase()))?.id
    return { id: result.resourceId, created: result.created, episodesAdded: result.itemsAdded, episodeId, posterUrl: payload.poster_path }
  }
  d.exec('SAVEPOINT video_payload')
  try {
    const outcome = insertVideo(d, payload, splitFromId)
    const rows = listEpisodes(d, outcome.id)
    for (const ep of payload.episodes) {
      const row = rows.find(e => e.season === ep.season && e.episode === ep.episode)
      if (ep.path) registerVideoAsset(d, { resourceId: outcome.id, episodeId: row?.id, path: ep.path, size: ep.file_size })
      if (row && ep.local_metadata) {
        fillEpisodeDetails(d, row.id, ep.local_metadata)
        for (const source of ep.local_metadata.sources || []) bindVideoSource(d, outcome.id, source, row.id)
        for (const attachment of ep.local_metadata.attachments || []) registerVideoAsset(d, { resourceId: outcome.id, episodeId: row.id, ...attachment })
      }
    }
    if (payload.video_type === 'movie') for (const file of payload.parts.length ? payload.parts : [{ path: payload.path, file_size: payload.file_size }]) registerVideoAsset(d, { resourceId: outcome.id, path: file.path, size: file.file_size })
    if (payload.hanime_id) bindVideoSource(d, outcome.id, { provider: 'hanime', externalId: payload.hanime_id, scope: 'episode', pageUrl: 'https://hanime1.me/watch?v=' + payload.hanime_id, evidence: 'legacy' })
    d.exec('RELEASE SAVEPOINT video_payload'); return outcome
  } catch (error) { d.exec('ROLLBACK TO SAVEPOINT video_payload'); d.exec('RELEASE SAVEPOINT video_payload'); throw error }
}

/** One replayable boundary for both Agent registration and a reviewed import draft. */
export function registerVideoIdentification(d: SqlDb, payload: VideoPayload, sourceDetails?: SourceEpisodeDetails, splitFromId = '') {
  d.exec('SAVEPOINT video_identification')
  try {
    const outcome = registerVideoPayload(d, payload, splitFromId)
    if (sourceDetails) {
      linkLegacyEpisode(d, outcome.id, [], sourceDetails)
      const bound = d.prepare("SELECT episode_id FROM video_sources WHERE resource_id=? AND provider='hanime' AND external_id=? AND episode_id IS NOT NULL")
        .get(outcome.id, payload.hanime_id) as { episode_id: string } | undefined
      if (bound) fillEpisodeDetails(d, bound.episode_id, sourceEpisodeFacts(sourceDetails))
    }
    d.exec('RELEASE SAVEPOINT video_identification')
    return outcome
  } catch (error) { d.exec('ROLLBACK TO SAVEPOINT video_identification'); d.exec('RELEASE SAVEPOINT video_identification'); throw error }
}

export function registerLocalVideoFacts(d: SqlDb, facts: VideoFacts, splitFromId = '') {
  const f = facts
  const owner = videoOwnerForFiles(d, [...f.parts.map(part=>part.path), ...f.episodes.map(ep=>ep.path)].filter(Boolean))
  const previous = owner && owner.id !== splitFromId ? getVideo(d,owner.id) : null
  const localTitle = !!(f.nfo_files.length || f.local_metadata?.title)
  const tags = [...new Set([...(f.tags || []), ...f.genres])]
  const payload: VideoPayload = {
    path: f.path, video_type: f.video_type, name_zh: (!localTitle && previous?.name_zh) || f.title_zh || f.title_en || path.basename(f.path), name_en: (!localTitle && previous?.name_en) || f.original_title || f.title_en,
    summary: f.plot || previous?.summary || '', description: f.plot || previous?.description || '', category: f.hentai || f.files.some(file => hanimeChannel(file.name, '')) ? HENTAI_CATEGORY : previous?.category || '其他', tags: tags.length ? tags : previous?.tags || [], hanime_id: f.hanime_id || previous?.hanime_id || '', official_url: previous?.official_url || '', source_dir: f.dir,
    file_size: f.parts.reduce((sum, part) => sum + part.file_size, 0) + f.episodes.reduce((sum, ep) => sum + ep.file_size, 0),
    year: f.year || previous?.year || 0, end_year: previous?.end_year || 0, rating: f.nfo_rating || previous?.rating || 0, duration_sec: f.duration_sec || previous?.duration_sec || 0, resolution: f.resolution, video_codec: f.video_codec, source: f.source, release_group: f.release_group,
    audio_tracks: f.audio_tracks, subtitle_tracks: f.subtitle_tracks, parts: f.parts, linked_files: [...f.external_subtitles.map(p => ({ path: p, label: '字幕', type: 'other' as const })), ...[...new Set([...f.nfo_files, ...(f.attachments || []).map(a => a.path)])].map(p => ({ path: p, label: path.extname(p).slice(1).toUpperCase(), type: 'other' as const }))],
    tmdb_id: f.tmdb_id || previous?.tmdb_id || '', imdb_id: f.imdb_id || previous?.imdb_id || '', douban_id: previous?.douban_id || '', douban_rating: previous?.douban_rating || 0, poster_path: f.images.find(image => /(?:poster|cover|folder)\./i.test(path.basename(image))) || f.images[0] || previous?.poster_path || '', fanart_path: previous?.fanart_path || '',
    episodes: f.episodes.map(ep => ({ ...ep, ...(ep.watch ? { watch_status: ep.watch.watch_status, position_sec: ep.watch.position_sec, watched_at: ep.watch.watched_at } : {}) })),
    ...(f.watch ? { watch_status: f.watch.watch_status, position_sec: f.watch.position_sec, last_watched_at: f.watch.watched_at } : {})
  }
  const outcome = registerVideoPayload(d, payload, splitFromId)
  // Viewer exports often contain full metadata without a source ID. Store it on
  // a concrete content row so dates and artwork survive the offline import.
  if (f.video_type === 'movie' && f.local_metadata && (f.local_metadata.title || f.local_metadata.publishedAt || f.local_metadata.airDate)) {
    const number = numberedEpisode(f.local_metadata.title || payload.name_zh)
    const registered = registerVideoContent(d, { resourceId: outcome.id, title: payload.name_zh, items: [{ ...f.local_metadata,
      title: f.local_metadata.title || payload.name_zh, number: number?.number ?? 1, season: number?.season ?? 0, order: number?.number ?? 1,
      durationSec: f.duration_sec || f.local_metadata.durationSec,
      watch: f.watch ? { status: f.watch.watch_status, position: f.watch.position_sec, watchedAt: f.watch.watched_at } : undefined,
      files: payload.parts.length ? payload.parts.map(part => ({path:part.path,size:part.file_size,quality:f.resolution})) : [{path:payload.path,size:payload.file_size,quality:f.resolution}] }] })
    outcome.episodesAdded += registered.itemsAdded
  }
  if (f.local_metadata?.thumbnailPath) d.prepare("UPDATE video_meta SET thumbnail_path=?,thumbnail_source=? WHERE resource_id=? AND thumbnail_path=''").run(f.local_metadata.thumbnailPath, f.local_metadata.thumbnailSource || '', outcome.id)
  if (f.local_metadata?.posterSource) d.prepare("UPDATE video_meta SET poster_source=? WHERE resource_id=?").run(f.local_metadata.posterSource, outcome.id)
  const item = getVideo(d, outcome.id)!
  const needsReview = !(item.name_zh || item.name_en).trim() || !(item.description || item.summary || item.original_description).trim()
  d.prepare('UPDATE resource SET ai_status=? WHERE id=?').run(needsReview ? 'pending' : 'done', outcome.id)
  return outcome
}

function validateSource(source: VideoSourceRef): void {
  if (!source || !['work', 'episode'].includes(source.scope) || !String(source.provider || '').trim() || !String(source.externalId || '').trim()) throw new Error('作品来源信息无效')
  if (String(source.externalId).length > 300 || String(source.provider).length > 60) throw new Error('作品来源编号过长')
}

/** NULL membership rows need an explicit lookup: SQLite UNIQUE does not deduplicate them. */
export function bindVideoSource(d: SqlDb, resourceId: string, source: VideoSourceRef, episodeId?: string): void {
  validateSource(source)
  const provider = source.provider.trim().toLowerCase()
  const externalId = source.externalId.trim()
  // A later work-level refresh must not recreate an unresolved copy of a source
  // that already belongs to an episode, or weaken its confirmed ownership.
  if (!episodeId && source.scope === 'episode' && d.prepare(`SELECT id FROM video_sources WHERE resource_id = ?
    AND provider = ? COLLATE NOCASE AND external_id = ? COLLATE NOCASE AND scope = 'episode' AND episode_id IS NOT NULL`).get(resourceId, provider, externalId)) {
    d.prepare(`DELETE FROM video_sources WHERE resource_id = ? AND provider = ? COLLATE NOCASE
      AND external_id = ? COLLATE NOCASE AND scope = 'episode' AND episode_id IS NULL`).run(resourceId, provider, externalId)
    return
  }
  const row = d.prepare(`SELECT id FROM video_sources WHERE resource_id = ? AND provider = ? COLLATE NOCASE
    AND external_id = ? COLLATE NOCASE AND scope = ? AND episode_id IS ?`).get(resourceId, provider, externalId, source.scope, episodeId || null) as { id: string } | undefined
  const now = Date.now()
  if (row) d.prepare('UPDATE video_sources SET page_url = ?, evidence = CASE WHEN confirmed = 1 THEN evidence ELSE ? END, confirmed = MAX(confirmed, ?), updated_at = ? WHERE id = ?').run(source.pageUrl || '', source.evidence || 'legacy', source.evidence === 'confirmed' ? 1 : 0, now, row.id)
  else d.prepare(`INSERT INTO video_sources (id, resource_id, episode_id, provider, external_id, scope, page_url, evidence, confirmed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), resourceId, episodeId || null, provider, externalId, source.scope, source.pageUrl || '', source.evidence || 'legacy', source.evidence === 'confirmed' ? 1 : 0, now, now)
  if (episodeId && source.scope === 'episode') d.prepare(`DELETE FROM video_sources WHERE resource_id = ? AND provider = ? COLLATE NOCASE
    AND external_id = ? COLLATE NOCASE AND scope = 'episode' AND episode_id IS NULL`).run(resourceId, provider, externalId)
}

/** Atomic, idempotent registration of a work and its content, sources and files. */
export function registerVideoContent(d: SqlDb, input: VideoRegistration): VideoRegistrationResult {
  if (!String(input.title || '').trim()) throw new Error('作品名称不能为空')
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('作品至少需要一个内容项')
  const sources = [...(input.sources || []), ...input.items.flatMap(item => item.sources || [])]
  sources.forEach(validateSource)
  const files = input.items.flatMap(item => item.files.map(file => file.path))
  if (files.some(file => !path.isAbsolute(file) || /\.(?:part|tmp)(?:-|$)/i.test(file))) throw new Error('视频文件路径无效或文件尚未完成')
  const directory = input.directory ? path.resolve(input.directory) : ''
  const bundleOwner = input.bundleId ? d.prepare('SELECT resource_id, directory_path FROM video_directories WHERE bundle_id = ?').get(input.bundleId) as { resource_id: string; directory_path: string } | undefined : undefined
  if (bundleOwner && directory.toLowerCase() !== bundleOwner.directory_path.toLowerCase()
    && resolveVideoOrganizePathOwner(d, directory) !== resolveVideoOrganizeOwner(d, bundleOwner.resource_id)) throw new Error('清单已绑定到另一目录；这是资源副本，请选择重新定位或作为副本导入')
  const ownership = resolveVideoOwnership(d, { title: input.title, sources, directory })
  if (ownership.state === 'conflict') throw new Error('来源对应多个作品，请先确认归属')
  const requestedId = input.resourceId ? resolveVideoOrganizeOwner(d, input.resourceId) : ''
  if (requestedId && ownership.resourceId && requestedId !== ownership.resourceId) throw new Error('来源归属与所选作品冲突，请先整理作品')
  const pathOwner = directory ? d.prepare("SELECT id FROM resource WHERE kind = 'video' AND path = ? COLLATE NOCASE").get(directory) as { id: string } | undefined : undefined
  const rawId = requestedId || bundleOwner?.resource_id || ownership.resourceId || pathOwner?.id || videoOwnerForFiles(d, files)?.id
  const resolvedId = rawId ? resolveVideoOrganizeOwner(d, rawId) : ''
  let existing = resolvedId ? getVideo(d, resolvedId) : null
  if (input.resourceId && !existing) throw new Error('所选作品已不存在')
  const resourcePath = existing?.path || directory || files[0]
  if (!resourcePath) throw new Error('缺少作品目录或视频文件')
  if (directory) {
    const occupied = d.prepare('SELECT id FROM resource WHERE path = ? COLLATE NOCASE').get(directory) as { id: string } | undefined
    if (occupied && resolveVideoOrganizeOwner(d, occupied.id) !== existing?.id) throw new Error('作品目录已属于其他资源')
  }
  d.exec('SAVEPOINT video_registration')
  try {
    let resourceId = existing?.id || ''
    const created = !existing
    if (!existing) {
      const payload: VideoPayload = {
        path: resourcePath, video_type: directory || input.items.length > 1 ? 'series' : 'movie', collection_name: '',
        name_zh: input.title.trim(), name_en: input.nameEn || '', summary: input.description || '', description: input.originalDescription || input.description || '',
        category: input.category || '其他', tags: input.tags || [], official_url: sources[0]?.pageUrl || '', source_dir: directory || path.dirname(resourcePath), file_size: 0,
        year: 0, end_year: 0, rating: 0, duration_sec: 0, resolution: '', video_codec: '', source: '', release_group: '', audio_tracks: [], subtitle_tracks: [], parts: [], linked_files: [],
        tmdb_id: '', imdb_id: '', douban_id: '', douban_rating: 0, hanime_id: sources.find(source => source.provider === 'hanime' && source.scope === 'episode')?.externalId || '',
        original_description: input.originalDescription || '', hanime_tags: [], poster_path: input.posterPath || '', fanart_path: '', episodes: []
      }
      resourceId = insertVideo(d, payload).id
      existing = getVideo(d, resourceId)!
    } else {
      // An additional file must not rescrape or blank existing metadata.
      const fill: Record<string, string> = { name_zh: input.title, name_en: input.nameEn || '', summary: input.description || '', description: input.originalDescription || input.description || '' }
      for (const [field, value] of Object.entries(fill)) {
        if (value && !(existing.user_edited || []).includes(field)) d.prepare(`UPDATE resource SET ${field} = ? WHERE id = ? AND (${field} = '' OR ${field} IS NULL)`).run(value, resourceId)
      }
      if (input.posterPath) d.prepare("UPDATE video_meta SET poster_path = ?, poster_source = ? WHERE resource_id = ? AND poster_path = ''").run(input.posterPath, input.posterSource || '', resourceId)
    }
    if (input.thumbnailPath) d.prepare("UPDATE video_meta SET thumbnail_path = ?,thumbnail_source = ? WHERE resource_id = ? AND thumbnail_path = ''").run(input.thumbnailPath, input.thumbnailSource || '', resourceId)
    const oldDirectory = d.prepare('SELECT bundle_id, directory_path, root FROM video_directories WHERE resource_id = ?').get(resourceId) as { bundle_id: string; directory_path: string; root: string } | undefined
    const bundleId = oldDirectory?.bundle_id || ensureBundleId(input.bundleId)
    const historicalDirectory = oldDirectory && directory.toLowerCase() !== oldDirectory.directory_path.toLowerCase()
      && resolveVideoOrganizePathOwner(d, directory) === resourceId
    if (directory && !historicalDirectory) {
      upsertVideoDirectory(d, { resourceId, directory, root: input.root || oldDirectory?.root, bundleId, metadataState: input.metadataState })
      d.prepare('UPDATE resource SET path = ?, source_dir = ?, file_name = ?, updated_at = ? WHERE id = ?').run(directory, directory, path.basename(directory), Date.now(), resourceId)
      d.prepare("UPDATE video_meta SET video_type = 'series' WHERE resource_id = ?").run(resourceId)
    }
    let itemsAdded = 0; let filesAdded = 0
    const numbering = new Map<string, { number: number; season: number }>()
    for (const [index, item] of input.items.entries()) {
      const itemFiles = item.files.map(file => {
        const published = videoOrganizeAssetPath(d, resourceId, file.path)
        if (published && published !== file.path) {
          try { if (statSync(published).isFile()) return { ...file, path: published } }
          catch { /* An unavailable published copy may be repaired from the original. */ }
        }
        return file
      })
      const rows = listEpisodes(d, resourceId)
      const sourceIds = new Set<string>()
      for (const source of item.sources || []) {
        const linked = d.prepare(`SELECT episode_id FROM video_sources WHERE resource_id = ? AND provider = ? COLLATE NOCASE
          AND external_id = ? COLLATE NOCASE AND scope = 'episode' AND episode_id IS NOT NULL`).all(resourceId, source.provider, source.externalId) as Array<{ episode_id: string }>
        linked.forEach(row => sourceIds.add(row.episode_id))
      }
      if (sourceIds.size > 1) throw new Error('同一内容的来源对应多个本地内容项')
      const declaredShared = (item.sources || []).length > 0 && input.items.some(other => other !== item && other.number !== item.number && (other.sources || []).length > 0 && other.files.some(f => itemFiles.some(own => videoPathKey(own.path) === videoPathKey(f.path))))
      const fileRows = rows.filter(ep => itemFiles.some(file => ep.path && videoPathKey(file.path) === videoPathKey(ep.path))
        || itemFiles.some(file => d.prepare(`SELECT a.id FROM video_assets a JOIN video_episode_assets ea ON ea.asset_id = a.id
          WHERE ea.episode_id = ? AND a.path = ? COLLATE NOCASE`).get(ep.id, path.resolve(file.path))))
      if (declaredShared) fileRows.splice(0, fileRows.length, ...fileRows.filter(row => sourceIds.has(row.id)))
      if (fileRows.length > 1 || fileRows.length && sourceIds.size && !sourceIds.has(fileRows[0].id)) throw new Error('文件与来源指向不同单集，请核对单集资料')
      if (fileRows.length) for (const source of (item.sources || []).filter(source => source.scope === 'episode')) {
        const known = d.prepare("SELECT external_id FROM video_sources WHERE episode_id = ? AND provider = ? COLLATE NOCASE AND scope = 'episode'").all(fileRows[0].id, source.provider) as Array<{ external_id: string }>
        if (known.length && !known.some(value => value.external_id.toLowerCase() === source.externalId.toLowerCase())) throw new Error('该文件已有其他单集来源，请核对后再更改')
      }
      let row = rows.find(ep => sourceIds.has(ep.id)) || fileRows[0] || (item.id ? rows.find(ep => ep.id === item.id) : undefined)
      const season = Number.isInteger(item.season) ? Number(item.season) : 0
      let number = Number.isInteger(item.number) ? Number(item.number) : Math.max(1, Math.round(item.order || index + 1))
      const desiredNumber = number
      if (!row) {
        const slot = rows.find(ep => ep.season === season && ep.episode === number)
        const hasOtherSource = slot && d.prepare("SELECT id FROM video_sources WHERE episode_id = ? AND scope = 'episode'").get(slot.id)
        const differentFiles = slot?.path && itemFiles.length && !itemFiles.some(file => videoPathKey(file.path) === videoPathKey(slot.path))
        if (slot && !differentFiles && (!hasOtherSource || !(item.sources || []).length)) row = slot
        else if (slot) { number = -1; while (rows.some(ep => ep.season === season && ep.episode === number)) number-- }
      }
      const defaultFile = itemFiles[0]
      if (!row) {
        const id = item.id && /^[\w-]{1,128}$/.test(item.id) && !d.prepare('SELECT id FROM episode WHERE id = ?').get(item.id) ? item.id : randomUUID()
        d.prepare(`INSERT INTO episode (id, resource_id, season, episode, title, display_label, path, file_size)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, resourceId, season, number, item.title || '', item.label || '', defaultFile?.path || '', defaultFile?.size || 0)
        row = listEpisodes(d, resourceId).find(ep => ep.id === id)!
        itemsAdded++
      } else {
        d.prepare(`UPDATE episode SET title = CASE WHEN title = '' THEN ? ELSE title END,
          display_label = CASE WHEN display_label = '' THEN ? ELSE display_label END,
          path = CASE WHEN path = '' THEN ? ELSE path END, file_size = CASE WHEN file_size = 0 THEN ? ELSE file_size END WHERE id = ?`).run(item.title || '', item.label || '', defaultFile?.path || '', defaultFile?.size || 0, row.id)
      }
      fillEpisodeDetails(d, row.id, item)
      if (item.watch && ['unwatched', 'watching', 'watched', 'dropped'].includes(item.watch.status)) {
        const watched = row.watch_status === 'watched' || item.watch.status === 'watched' ? 'watched'
          : row.watch_status !== 'unwatched' ? row.watch_status : item.watch.status
        d.prepare('UPDATE episode SET watch_status = ?,position_sec = ?,watched_at = ? WHERE id = ?').run(watched,
          Math.max(row.position_sec, Number(item.watch.position) || 0), Math.max(row.watched_at, Number(item.watch.watchedAt) || 0), row.id)
      }
      if (Number.isInteger(item.number) && (desiredNumber >= 0 || row.episode < 0)) numbering.set(row.id, { number: desiredNumber, season })
      for (const file of itemFiles) {
        const absolute = path.resolve(file.path)
        const before = d.prepare("SELECT id FROM video_assets WHERE resource_id = ? AND path = ? COLLATE NOCASE AND role = 'video'").get(resourceId, absolute)
        registerVideoAsset(d, { resourceId, episodeId: row.id, path: absolute, quality: file.quality, size: file.size })
        if (!before) filesAdded++
      }
      for (const attachment of item.attachments || []) registerVideoAsset(d, { resourceId, episodeId: row.id, ...attachment })
      for (const source of item.sources || []) bindVideoSource(d, resourceId, source, source.scope === 'episode' ? row.id : undefined)
      if (input.restoreRemoved) clearVideoScanIgnores(d, resourceId, item.files.map(f => f.path), item.sources)
    }
    for (const source of input.sources || []) {
      const bound = source.scope === 'episode' && d.prepare(`SELECT id FROM video_sources WHERE resource_id = ? AND provider = ? COLLATE NOCASE
        AND external_id = ? COLLATE NOCASE AND scope = 'episode' AND episode_id IS NOT NULL`).get(resourceId, source.provider, source.externalId)
      if (!bound) bindVideoSource(d, resourceId, source)
    }
    const warnings = reconcileEpisodeSlots(d, resourceId, numbering)
    d.prepare('UPDATE resource SET updated_at = ? WHERE id = ?').run(Date.now(), resourceId)
    d.exec('RELEASE SAVEPOINT video_registration')
    return { resourceId, bundleId, created, itemsAdded, filesAdded, warnings }
  } catch (error) {
    d.exec('ROLLBACK TO SAVEPOINT video_registration'); d.exec('RELEASE SAVEPOINT video_registration')
    throw error
  }
}

/** No network or AI; validate every portable path before writing to the database. */
export function registerVideoBundle(d: SqlDb, directory: string, restoreRemoved = false): VideoRegistrationResult {
  const root = path.resolve(directory)
  const bundle = readLocalVideoBundle(root)
  if (!bundle) throw new Error('目录中没有 baoyi.json 资源清单')
  return registerVideoBundleData(d, root, bundle, undefined, restoreRemoved)
}

export function registerVideoBundleData(d: SqlDb, root: string, bundle: import('../../../src/types/video-library.ts').VideoBundle, resourceId?: string, restoreRemoved = false): VideoRegistrationResult {
  const owner = d.prepare('SELECT resource_id,directory_path FROM video_directories WHERE bundle_id = ?').get(bundle.bundle_id) as { resource_id: string; directory_path: string } | undefined
  const targetId = resourceId || owner?.resource_id
  const ignored = d.prepare('SELECT path,resource_id,source_key FROM video_scan_ignores').all() as Array<{ path: string; resource_id: string; source_key: string }>
  const rawItems = localBundleItems(root, restoreRemoved ? { ...bundle, excluded_files: [], excluded_sources: [] } : bundle)
  const items = rawItems.filter(item => restoreRemoved || !ignored.some(i => i.resource_id === targetId && item.sources?.some(s => s.provider + ':' + s.externalId === i.source_key)))
    .map(item => ({ ...item, files: item.files.filter(f => restoreRemoved
      ? !ignored.some(i => i.resource_id === targetId && i.source_key.startsWith('detached:') && videoPathKey(i.path) === videoPathKey(f.path))
      : !ignoredVideoFile(d, f.path, targetId)) }))
    .filter(item => item.files.length || !rawItems.find(r => r.id === item.id)?.files.length)
  if (!items.length) return { resourceId: targetId || '', bundleId: bundle.bundle_id, created: false, itemsAdded: 0, filesAdded: 0, skipped: true }
  d.exec('SAVEPOINT video_bundle_import')
  try {
    let pathsRepaired = 0
    if (owner && videoPathKey(owner.directory_path) !== videoPathKey(root)) {
      rebaseMovedVideoDirectory(d, owner.resource_id, owner.directory_path, root)
      pathsRepaired = 1
    }
    const duplicatesMerged = owner ? absorbDuplicateVideoCards(d, owner.resource_id, items) : 0
    const result = registerVideoContent(d, {
    restoreRemoved,
    resourceId, bundleId: bundle.bundle_id, directory: root, root: path.dirname(root), title: bundle.work.title,
    nameEn: bundle.work.name_en, description: bundle.work.description, originalDescription: bundle.work.original_description,
    category: bundle.work.category, tags: bundle.work.tags, posterPath: bundle.work.poster ? resolveBundlePath(root, bundle.work.poster) : '', posterSource: bundle.work.poster_source, thumbnailPath: bundle.work.thumbnail ? resolveBundlePath(root, bundle.work.thumbnail) : '', thumbnailSource: bundle.work.thumbnail_source,
    sources: bundle.work.sources, metadataState: bundle.missing?.length ? 'pending' : 'complete',
      items
    })
    if (!restoreRemoved) {
      for (const file of bundle.excluded_files || []) d.prepare('INSERT OR IGNORE INTO video_scan_ignores(path,resource_id,source_key,created_at) VALUES (?,?,?,?)').run(resolveBundlePath(root, file), result.resourceId, '', Date.now())
      for (const source of bundle.excluded_sources || []) if (!source.startsWith('detached:')) d.prepare('INSERT OR IGNORE INTO video_scan_ignores(path,resource_id,source_key,created_at) VALUES (?,?,?,?)').run('source:' + result.resourceId + ':' + source, result.resourceId, source, Date.now())
    }
    const work = getVideo(d, result.resourceId)!
    if (!work.user_edited.includes('name_zh') && work.name_zh !== bundle.work.title && bundle.items.some(item => item.title === work.name_zh)) {
      d.prepare('UPDATE resource SET name_zh = ? WHERE id = ?').run(bundle.work.title, result.resourceId)
      for (const field of ['name_en', 'summary', 'description']) if (!work.user_edited.includes(field)) d.prepare(`UPDATE resource SET ${field} = '' WHERE id = ?`).run(result.resourceId)
      if (bundle.work.poster && !work.user_edited.includes('poster_path')) d.prepare('UPDATE video_meta SET poster_path = ? WHERE resource_id = ?').run(resolveBundlePath(root, bundle.work.poster), result.resourceId)
    }
    d.exec('RELEASE SAVEPOINT video_bundle_import')
    return { ...result, pathsRepaired, duplicatesMerged }
  } catch (error) { d.exec('ROLLBACK TO SAVEPOINT video_bundle_import'); d.exec('RELEASE SAVEPOINT video_bundle_import'); throw error }
}
