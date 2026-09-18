import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import { getVideo, listEpisodes } from './db.ts'
import { registerVideoAsset } from './library.ts'
import { cleanEpisodeTitle, numberedEpisode } from './episode-identity.ts'

export interface SourceEpisodeDetails { publishedAt?: number; releaseDate?: number; durationSec?: number; artist?: string; artworkUrls?: string[]; videoCode: string; title: string; originalTitle?: string; description?: string; posterUrl?: string; thumbnailUrl?: string; tags?: string[] }
export function sourceEpisodeFacts(details?: Pick<SourceEpisodeDetails, 'publishedAt' | 'releaseDate' | 'durationSec' | 'artist'>) {
  return { publishedAt: details?.publishedAt, airDate: details?.releaseDate, durationSec: details?.durationSec, studio: details?.artist }
}
export interface NumberedSourceEpisode { videoCode: string; title: string; order: number; numbered?: boolean }
const fileKey = (file: string) => path.resolve(file).toLowerCase()
export function isDirectory(file: string): boolean { try { return fs.statSync(file).isDirectory() } catch { return false } }

export function fillEpisodeDetails(d: SqlDb, episodeId: string, details: {
  publishedAt?: number; airDate?: number; durationSec?: number; studio?: string
  originalTitle?: string; description?: string; originalDescription?: string; tags?: string[]; posterSource?: string; thumbnailPath?: string; thumbnailSource?: string; posterPath?: string; sourceUrl?: string; notes?: string
}): void {
  for (const [column, value] of Object.entries({ published_at: details.publishedAt, air_date: details.airDate, duration_sec: details.durationSec })) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) d.prepare(`UPDATE episode SET ${column} = ? WHERE id = ? AND ${column} = 0`).run(Math.round(value), episodeId)
  }
  if (details.tags?.length) d.prepare("UPDATE episode SET tags = ? WHERE id = ? AND tags = '[]'").run(JSON.stringify(details.tags), episodeId)
  const values = { studio: details.studio, poster_source: details.posterSource, thumbnail_path: details.thumbnailPath, thumbnail_source: details.thumbnailSource, original_title: details.originalTitle, description: details.description, original_description: details.originalDescription, poster_path: details.posterPath, source_url: details.sourceUrl, notes: details.notes }
  for (const [column, value] of Object.entries(values)) if (value?.trim()) {
    d.prepare(`UPDATE episode SET ${column} = ? WHERE id = ? AND ${column} = ''`).run(value.trim(), episodeId)
  }
}

/** A legacy source ID refers to one episode, even if its resource path is a directory. */
export function linkLegacyEpisode(d: SqlDb, resourceId: string, catalogue: NumberedSourceEpisode[] = [], current?: SourceEpisodeDetails): void {
  const item = getVideo(d, resourceId)
  if (!item?.hanime_id) return
  const code = item.hanime_id
  const source = catalogue.find(episode => episode.videoCode === code)
  const details = current?.videoCode === code ? current : undefined
  const parts = item.parts.length ? item.parts : !isDirectory(item.path) && /\.[a-z0-9]{2,5}$/i.test(item.path) ? [{ path: item.path, file_size: item.file_size }] : []
  const files = parts.filter(part => part.path && !isDirectory(part.path))
  if (!files.length) return
  const rows = listEpisodes(d, resourceId)
  const bound = d.prepare("SELECT episode_id FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND external_id = ? AND episode_id IS NOT NULL").get(resourceId, code) as { episode_id: string } | undefined
  let episode = rows.find(row => row.id === bound?.episode_id) || rows.find(row => row.path && files.some(file => fileKey(file.path) === fileKey(row.path)))
  const unclaimed = files.filter(file => {
    const linked = d.prepare(`SELECT ea.episode_id FROM video_assets a JOIN video_episode_assets ea ON ea.asset_id = a.id
      WHERE a.resource_id = ? AND a.path = ? COLLATE NOCASE`).all(resourceId, path.resolve(file.path)) as Array<{ episode_id: string }>
    return !linked.length || linked.every(row => row.episode_id === episode?.id)
  })
  if (!episode && !unclaimed.length) return
  const inferred = numberedEpisode(item.name_zh || item.file_name)
  let number = (source?.numbered !== false ? source?.order : undefined) ?? inferred?.number ?? 1
  const season = inferred?.season || 0
  if (!episode) {
    while (rows.some(row => row.season === season && row.episode === number)) number++
    const id = randomUUID()
    const first = unclaimed[0]
    d.prepare(`INSERT INTO episode (id, resource_id, season, episode, title, path, file_size, duration_sec, watch_status, position_sec, watched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, resourceId, season, number,
      source?.title || item.name_zh || item.file_name, first.path, first.file_size || 0, item.duration_sec,
      item.watch_status, item.position_sec, item.last_watched_at)
    episode = listEpisodes(d, resourceId).find(row => row.id === id)!
  }
  fillEpisodeDetails(d, episode.id, {
    ...sourceEpisodeFacts(details),
    originalTitle: details?.originalTitle || item.name_en || cleanEpisodeTitle(path.basename(files[0].path)),
    description: details?.description || item.description || item.summary || item.original_description,
    originalDescription: item.original_description,
    tags: details?.tags || (item.hanime_tags.length ? item.hanime_tags : item.tags), thumbnailPath: item.thumbnail_path, thumbnailSource: details?.thumbnailUrl || item.thumbnail_source, posterSource: details?.posterUrl || item.poster_source, posterPath: item.poster_path, sourceUrl: 'https://hanime1.me/watch?v=' + code, notes: item.notes
  })
  for (const file of unclaimed) registerVideoAsset(d, { resourceId, episodeId: episode.id, path: file.path, size: file.file_size, quality: item.resolution })
  if (!bound) {
    const old = d.prepare("SELECT id FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND external_id = ? AND scope = 'episode' AND episode_id IS NULL").get(resourceId, code) as { id: string } | undefined
    if (old) d.prepare('UPDATE video_sources SET episode_id = ?, updated_at = ? WHERE id = ?').run(episode.id, Date.now(), old.id)
    else d.prepare(`INSERT INTO video_sources (id, resource_id, episode_id, provider, external_id, scope, page_url, evidence, confirmed, created_at, updated_at)
      VALUES (?, ?, ?, 'hanime', ?, 'episode', ?, 'legacy', 0, ?, ?)`).run(randomUUID(), resourceId, episode.id, code, 'https://hanime1.me/watch?v=' + code, Date.now(), Date.now())
  }
}

/** Correct old playlist-position numbering without changing identity or watch state. */
export function reconcileEpisodeNumbers(d: SqlDb, resourceId: string, catalogue: NumberedSourceEpisode[]): string[] {
  const rows = listEpisodes(d, resourceId)
  const changes = new Map<string, { number: number; season: number }>()
  for (const source of catalogue) {
    if (source.numbered === false) continue
    const matches = d.prepare("SELECT DISTINCT episode_id FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND external_id = ? AND episode_id IS NOT NULL").all(resourceId, source.videoCode) as Array<{ episode_id: string }>
    if (matches.length !== 1) continue
    const row = rows.find(episode => episode.id === matches[0].episode_id)
    if (row) changes.set(row.id, { number: source.order, season: row.season })
  }
  return reconcileEpisodeSlots(d, resourceId, changes)
}

export function reconcileEpisodeSlots(d: SqlDb, resourceId: string, changes: Map<string, { number: number; season: number }>): string[] {
  const rows = listEpisodes(d, resourceId)
  const slots = new Set<string>()
  for (const [id, change] of changes) {
    const slot = `${change.season}:${change.number}`
    if (slots.has(slot) || rows.some(row => row.id !== id && !changes.has(row.id) && row.season === change.season && row.episode === change.number)) return ['部分本地集数编号存在冲突，请在合集内容中核对']
    slots.add(slot)
  }
  d.exec('SAVEPOINT episode_numbering')
  try {
    let temporary = -1
    for (const id of changes.keys()) {
      while (rows.some(row => row.episode === temporary)) temporary--
      d.prepare('UPDATE episode SET episode = ? WHERE id = ?').run(temporary--, id)
    }
    for (const [id, change] of changes) d.prepare('UPDATE episode SET season = ?, episode = ? WHERE id = ?').run(change.season, change.number, id)
    d.exec('RELEASE SAVEPOINT episode_numbering')
  } catch (error) { d.exec('ROLLBACK TO SAVEPOINT episode_numbering'); d.exec('RELEASE SAVEPOINT episode_numbering'); throw error }
  return []
}
