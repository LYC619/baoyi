import { readVideoLocalMetadata } from './local-metadata.ts'
import fs from 'node:fs'
import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoBundle, VideoContentInput } from '../../../src/types/video-library.ts'
import { getVideo, listEpisodes } from './db.ts'
import { readEpisodeSidecar, readVideoBundle, resolveBundlePath } from './bundle.ts'
import { linkLegacyEpisode } from './episode-details.ts'
import { numberedEpisode, cleanEpisodeTitle } from './episode-identity.ts'
import { rebaseStoredVideoJobs } from './download/jobs.ts'

export const videoPathKey = (value: string) => path.resolve(value).normalize('NFC').toLowerCase()
export function localVideoFiles(directory: string, recursive = true): string[] {
  const files: string[] = []
  const walk = (folder: string, depth: number) => {
    if (depth > 8 || files.length > 10000) throw new Error('作品目录过大，请选择单个合集目录')
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const file = path.join(folder, entry.name)
      if (recursive && entry.isDirectory() && !entry.name.startsWith('.')) walk(file, depth + 1)
      else if (entry.isFile() && /\.(mp4|mkv|avi|mov|m4v|webm|wmv|mpg|mpeg|ts|m2ts|flv)$/i.test(entry.name)) files.push(file)
    }
  }
  walk(path.resolve(directory), 0)
  return files.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
}

/** Adjacent records can rebuild the work index if only baoyi.json was lost. */
export function readLocalVideoBundle(directory: string): VideoBundle | null {
  const existing = readVideoBundle(directory)
  if (existing) return existing
  const records = localVideoFiles(directory).flatMap(file => {
    const record = readEpisodeSidecar(file)
    return record ? [{ file, record }] : []
  })
  if (!records.length) return null
  const first = records[0].record
  if (records.some(({ record }) => record.bundle_id !== first.bundle_id)) throw new Error('目录包含多个合集的单集资料，请分别导入各合集目录')
  const items = new Map<string, VideoBundle['items'][number]>()
  for (const { file, record } of records) {
    const previous = items.get(record.episode.id)
    items.set(record.episode.id, { ...record.episode,
      poster: record.episode.poster ? path.relative(directory, resolveBundlePath(path.dirname(file), record.episode.poster)).split(path.sep).join('/') : '',
      thumbnail: record.episode.thumbnail ? path.relative(directory, resolveBundlePath(path.dirname(file), record.episode.thumbnail)).split(path.sep).join('/') : '',
      attachments: record.episode.attachments?.map(a => ({ ...a, path: path.relative(directory, resolveBundlePath(path.dirname(file),a.path)).split(path.sep).join('/') })),
      files: [...previous?.files || [], { path: path.relative(directory, file).split(path.sep).join('/'), size: fs.statSync(file).size, quality: record.file.quality }] })
  }
  return { schema_version: 1, bundle_id: first.bundle_id, revision: 0, updated_at: Date.now(),
    work: { title: first.work_title || path.basename(directory), name_en: '', description: '', original_description: '', category: '其他',
      tags: [], sources: [...items.values()].flatMap(item => item.sources), poster: '', poster_source: '', provenance: { title: 'episode-sidecar' } },
    items: [...items.values()], managed_files: {}, missing: ['poster'] }
}

/** Read both the work manifest and adjacent episode records; discover new media as well. */
export function localBundleItems(directory: string, bundle: VideoBundle): VideoContentInput[] {
  const items: VideoContentInput[] = bundle.items.map(item => ({ id: item.id, title: item.title, label: item.label,
    publishedAt: item.published_at, airDate: item.air_date, durationSec: item.duration_sec, studio: item.studio,
    order: item.order, season: item.season, number: item.number, originalTitle: item.original_title, description: item.description,
    tags: item.tags, posterSource: item.poster_source, thumbnailPath: item.thumbnail ? resolveBundlePath(directory, item.thumbnail) : "", thumbnailSource: item.thumbnail_source,
    attachments: item.attachments?.map(a => ({ ...a, path: resolveBundlePath(directory, a.path) })),
    originalDescription: item.original_description, notes: item.notes, watch: item.watch, sourceUrl: item.source_url, sources: item.sources,
    posterPath: item.poster ? resolveBundlePath(directory, item.poster) : '',
    files: item.files.map(file => ({ ...file, path: resolveBundlePath(directory, file.path) })) }))
  const sourceCodes = new Set([...bundle.work.sources, ...bundle.items.flatMap(item => item.sources)].filter(source => source.provider === 'hanime').map(source => source.externalId))
  let unknown = Math.min(0, ...items.map(item => Number(item.number ?? 0))) - 1
  for (const file of localVideoFiles(directory)) {
    if (bundle.excluded_files?.some(p => videoPathKey(resolveBundlePath(directory, p)) === videoPathKey(file))) continue
    const sidecar = readEpisodeSidecar(file)
    const local = readVideoLocalMetadata(file)
    if (sidecar && sidecar.bundle_id !== bundle.bundle_id) throw new Error('单集资料属于另一合集：' + path.basename(file))
    const code = /\[(\d{3,20})\]/.exec(path.basename(file))?.[1]
    const source = local.sources?.[0] || (code && sourceCodes.has(code) ? { provider: 'hanime', externalId: code, scope: 'episode' as const,
      pageUrl: 'https://hanime1.me/watch?v=' + code, evidence: 'bundle' as const } : undefined)
    let item = items.find(item => item.files.some(asset => videoPathKey(asset.path) === videoPathKey(file)))
      || items.find(item => sidecar && item.id === sidecar.episode.id || source && item.sources?.some(value => value.provider === source.provider && value.externalId === source.externalId))
    if (!item) {
      const name = cleanEpisodeTitle(path.basename(file)).replace(/\s*\[\d{3,20}\]\s*$/, '').trim()
      const parsed = numberedEpisode(name)
      item = { id: sidecar?.episode.id, title: sidecar?.episode.title || local.title || name, number: sidecar?.episode.number ?? parsed?.number ?? unknown--,
        season: sidecar?.episode.season ?? parsed?.season ?? 0, order: sidecar?.episode.order ?? parsed?.number ?? items.length + 1,
        sources: sidecar?.episode.sources || (source ? [source] : []), files: [] }
      items.push(item)
    }
    for (const [key, value] of Object.entries(local)) {
      if (value && (!Array.isArray(value) || value.length) && (!(item as any)[key] || Array.isArray((item as any)[key]) && !(item as any)[key].length)) (item as any)[key] = value
    }
    if (sidecar) {
      const details = sidecar.episode
      Object.assign(item, { publishedAt: details.published_at || item.publishedAt, airDate: details.air_date || item.airDate, durationSec: details.duration_sec || item.durationSec, studio: details.studio || item.studio,
        tags: details.tags || item.tags, thumbnailPath: details.thumbnail ? resolveBundlePath(path.dirname(file), details.thumbnail) : item.thumbnailPath, thumbnailSource: details.thumbnail_source || item.thumbnailSource, posterSource: details.poster_source || item.posterSource, originalTitle: details.original_title || item.originalTitle, description: details.description || item.description,
        originalDescription: details.original_description || item.originalDescription, notes: details.notes || item.notes,
        sourceUrl: details.source_url || item.sourceUrl, sources: details.sources.length ? details.sources : item.sources, watch: details.watch || item.watch,
        posterPath: details.poster ? resolveBundlePath(path.dirname(file), details.poster) : item.posterPath,
        number: details.number ?? item.number, season: details.season ?? item.season })
    } else {
      // The old download manifest stored playlist position. Only legacy entries need this repair.
      const parsed = numberedEpisode(item.title)
      if (parsed) { item.number = parsed.number; item.order = parsed.number }
    }
    const recorded = item.files.find(asset => videoPathKey(asset.path) === videoPathKey(file))
    if (recorded) recorded.size = fs.statSync(file).size
    else item.files.push({ path: file, size: fs.statSync(file).size, quality: sidecar?.file.quality || /(?:2160|1080|720|480|360)p/i.exec(file)?.[0].toLowerCase() || '' })
  }
  return items
}

/** A matching manifest may reattach a moved directory, but never steal a live copy. */
export function rebaseMovedVideoDirectory(d: SqlDb, resourceId: string, from: string, to: string, root = path.dirname(to)): void {
  if (videoPathKey(from) === videoPathKey(to)) return
  if (fs.existsSync(from)) throw new Error('清单已绑定到另一目录；这是资源副本，请选择重新定位或作为副本导入')
  const rebase = (value: string): string => {
    const relative = path.relative(from, value)
    return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? path.join(to, relative) : value
  }
  for (const asset of d.prepare('SELECT id,path,role FROM video_assets WHERE resource_id = ?').all(resourceId) as Array<{ id: string; path: string; role: string }>) {
    const next = rebase(asset.path)
    if (next === asset.path) continue
    const existing = d.prepare('SELECT id FROM video_assets WHERE resource_id = ? AND path = ? COLLATE NOCASE AND role = ?').get(resourceId, next, asset.role) as { id: string } | undefined
    if (existing && existing.id !== asset.id) {
      d.prepare('INSERT OR IGNORE INTO video_episode_assets (episode_id,asset_id) SELECT episode_id,? FROM video_episode_assets WHERE asset_id = ?').run(existing.id, asset.id)
      d.prepare('DELETE FROM video_assets WHERE id = ?').run(asset.id)
    } else d.prepare('UPDATE video_assets SET path = ? WHERE id = ?').run(next, asset.id)
  }
  for (const [table, key, fields] of [['episode', 'resource_id', ['path', 'poster_path', 'thumbnail_path']], ['video_meta', 'resource_id', ['poster_path', 'fanart_path', 'thumbnail_path']], ['resource', 'id', ['path', 'source_dir']]] as const) {
    for (const row of d.prepare(`SELECT rowid AS row_id,${fields.join(',')} FROM ${table} WHERE ${key} = ?`).all(resourceId) as Array<Record<string, string | number>>) {
      for (const field of fields) if (row[field] && rebase(String(row[field])) !== row[field]) d.prepare(`UPDATE ${table} SET ${field} = ? WHERE rowid = ?`).run(rebase(String(row[field])), row.row_id)
    }
  }
  const nested = (value: unknown): unknown => typeof value === 'string' ? (path.isAbsolute(value) ? rebase(value) : value)
    : Array.isArray(value) ? value.map(nested) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, nested(v)])) : value
  const meta = d.prepare('SELECT parts,linked_files,subtitle_tracks,audio_tracks FROM video_meta WHERE resource_id = ?').get(resourceId) as Record<string, string>
  for (const [field, value] of Object.entries(meta || {})) d.prepare(`UPDATE video_meta SET ${field} = ? WHERE resource_id = ?`).run(JSON.stringify(nested(JSON.parse(value || '[]'))), resourceId)
  // 排除记录和扫描指纹也跟着走：不然整理后再扫一次，之前明确移除的文件会被当成新文件重新导进来
  for (const table of ['video_scan_ignores', 'video_scan_state']) {
    for (const row of d.prepare(`SELECT rowid AS row_id, path FROM ${table} WHERE resource_id = ?`).all(resourceId) as Array<{ row_id: number; path: string }>) {
      if (path.isAbsolute(row.path) && rebase(row.path) !== row.path) d.prepare(`UPDATE OR REPLACE ${table} SET path = ? WHERE rowid = ?`).run(rebase(row.path), row.row_id)
    }
  }
  d.prepare('UPDATE video_directories SET directory_path = ?,root = ?,relative_path = ?,updated_at = ? WHERE resource_id = ?').run(to, root, path.relative(root, to), Date.now(), resourceId)
  rebaseStoredVideoJobs(d, resourceId, from, to, root)
}

/** Repair old duplicate cards only when every donor file is the same owned media. */
export function absorbDuplicateVideoCards(d: SqlDb, resourceId: string, items: VideoContentInput[]): number {
  const codes = new Set(items.flatMap(item => item.sources || []).map(source => `${source.provider}:${source.externalId}`.toLowerCase()))
  const files = items.flatMap(item => item.files)
  let absorbed = 0
  for (const row of d.prepare("SELECT id FROM resource WHERE kind = 'video' AND is_archived = 0 AND id != ?").all(resourceId) as Array<{ id: string }>) {
    if (d.prepare('SELECT resource_id FROM video_directories WHERE resource_id = ?').get(row.id)) continue
    const sources = d.prepare('SELECT provider,external_id FROM video_sources WHERE resource_id = ?').all(row.id) as Array<{ provider: string; external_id: string }>
    if (!sources.length || !sources.every(source => codes.has(`${source.provider}:${source.external_id}`.toLowerCase()))) continue
    const donor = getVideo(d, row.id)!
    const donorFiles = [...new Map([...donor.parts, ...listEpisodes(d, row.id).filter(episode => episode.path).map(episode => ({ path: episode.path, file_size: episode.file_size }))].map(file => [videoPathKey(file.path), file])).values()]
    if (!donorFiles.length || !donorFiles.every(file => files.some(candidate => path.basename(candidate.path).toLowerCase() === path.basename(file.path).toLowerCase()
      && (!file.file_size || !candidate.size || file.file_size === candidate.size)
      && (videoPathKey(candidate.path) === videoPathKey(file.path) || !fs.existsSync(file.path))))) continue
    linkLegacyEpisode(d, row.id)
    const mapped = listEpisodes(d, row.id).map(episode => {
      const episodeSources = d.prepare('SELECT provider,external_id FROM video_sources WHERE episode_id = ?').all(episode.id) as Array<{ provider: string; external_id: string }>
      const item = items.find(item => item.sources?.some(source => episodeSources.some(old => source.provider.toLowerCase() === old.provider.toLowerCase() && source.externalId.toLowerCase() === old.external_id.toLowerCase()))
        && item.files.some(file => path.basename(file.path).toLowerCase() === path.basename(episode.path).toLowerCase()))
      return { episode, item }
    })
    if (mapped.some(value => !value.item)) continue
    for (const { episode, item: matched } of mapped) {
      const item = matched!
      item.originalTitle ||= episode.original_title || donor.name_en
      item.description ||= episode.description || donor.description
      item.originalDescription ||= episode.original_description || donor.original_description
      item.publishedAt ||= episode.published_at
      item.airDate ||= episode.air_date
      item.durationSec ||= episode.duration_sec
      item.studio ||= episode.studio
      item.posterPath ||= episode.poster_path || donor.poster_path
      item.notes ||= episode.notes || donor.notes
      const old = item.watch
      item.watch = { status: old?.status === 'watched' || episode.watch_status === 'watched' ? 'watched'
        : old && old.status !== 'unwatched' ? old.status : episode.watch_status,
        position: Math.max(old?.position || 0, episode.position_sec), watchedAt: Math.max(old?.watchedAt || 0, episode.watched_at) }
    }
    d.prepare('UPDATE resource SET is_archived = 1,updated_at = ? WHERE id = ?').run(Date.now(), row.id)
    absorbed++
  }
  return absorbed
}
