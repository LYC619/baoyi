import fs from 'node:fs'
import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoItem } from '../../../src/types'

interface ListState {
  episode_total: number
  episode_watched: number
  episode_present: number
  available_files: number
  missing_files: number
  metadataPending: boolean
}
interface EpisodeRow { id: string; resource_id: string; path: string; watch_status: string }
type FileState = 'present' | 'missing' | 'offline' | 'directory'
const fileKey = (file: string) => path.resolve(file).toLowerCase()

/** Card refreshes read a snapshot; legacy projection and asset writes belong to explicit library operations. */
export async function readVideoListState(d: SqlDb, items: VideoItem[]): Promise<Map<string, ListState>> {
  const episodes: EpisodeRow[] = []
  const contentFiles = new Map<string, Set<string>>()
  const workFiles = new Map(items.map(item => [item.id, new Set<string>()]))
  const pending = new Set<string>(), paths = new Map<string, string>()
  const addFile = (resourceId: string, file: string, episodeId?: string) => {
    if (!file) return
    const key = fileKey(file)
    paths.set(key, file); workFiles.get(resourceId)!.add(key)
    if (episodeId) {
      if (!contentFiles.has(episodeId)) contentFiles.set(episodeId, new Set())
      contentFiles.get(episodeId)!.add(key)
    }
  }
  // Keep SQL parameter counts bounded for large libraries. No journal JSON or full episode descriptions are loaded.
  for (let offset = 0; offset < items.length; offset += 400) {
    const ids = items.slice(offset, offset + 400).map(item => item.id), slots = ids.map(() => '?').join(',')
    const rows = d.prepare(`SELECT id,resource_id,path,watch_status FROM episode WHERE resource_id IN (${slots})`).all(...ids) as EpisodeRow[]
    episodes.push(...rows)
    for (const episode of rows) addFile(episode.resource_id, episode.path, episode.id)
    const assets = d.prepare(`SELECT a.resource_id,a.path,e.id AS episode_id FROM video_assets a
      LEFT JOIN video_episode_assets ea ON ea.asset_id=a.id
      LEFT JOIN episode e ON e.id=ea.episode_id AND e.resource_id=a.resource_id
      WHERE a.resource_id IN (${slots}) AND a.role='video'`).all(...ids) as { resource_id: string; path: string; episode_id: string | null }[]
    for (const asset of assets) addFile(asset.resource_id, asset.path, asset.episode_id || undefined)
    const directories = d.prepare(`SELECT resource_id FROM video_directories WHERE resource_id IN (${slots}) AND metadata_state='pending'`).all(...ids) as { resource_id: string }[]
    directories.forEach(row => pending.add(row.resource_id))
  }
  // Older movies may only have resource.path/parts. Count those files without migrating data during a list read.
  for (const item of items) if (item.video_type === 'movie' || item.hanime_id) {
    if (/\.[a-z0-9]{2,5}$/i.test(item.path)) addFile(item.id, item.path)
    for (const part of item.parts) addFile(item.id, part.path)
  }
  const states = new Map<string, FileState>(), roots = new Map<string, Promise<boolean>>()
  async function inspect(file: string): Promise<FileState> {
    try { return (await fs.promises.stat(file)).isFile() ? 'present' : 'directory' }
    catch {
      const root = path.parse(path.resolve(file)).root
      if (!roots.has(root)) roots.set(root, fs.promises.stat(root).then(() => true, () => false))
      return await roots.get(root) ? 'missing' : 'offline'
    }
  }
  const files = [...paths]
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (cursor < files.length) {
      const [key, file] = files[cursor++]
      states.set(key, await inspect(file))
    }
  }))
  const result = new Map<string, ListState>(items.map(item => {
    const files = [...workFiles.get(item.id)!].map(key => states.get(key))
    return [item.id, { episode_total: 0, episode_watched: 0, episode_present: 0,
      available_files: files.filter(state => state === 'present').length,
      missing_files: files.filter(state => state === 'missing' || state === 'offline').length,
      metadataPending: pending.has(item.id) }] as const
  }))
  for (const episode of episodes) {
    const files = contentFiles.get(episode.id)
    if (!episode.path && !files?.size) continue
    const summary = result.get(episode.resource_id)!
    summary.episode_total++
    if (episode.watch_status === 'watched') summary.episode_watched++
    if ([...files || []].some(key => states.get(key) === 'present')) summary.episode_present++
  }
  for (const item of items) {
    const summary = result.get(item.id)!
    if (item.hanime_id && !summary.episode_total && summary.available_files + summary.missing_files > 0) {
      summary.episode_total = 1
      summary.episode_watched = item.watch_status === 'watched' ? 1 : 0
      summary.episode_present = summary.available_files > 0 ? 1 : 0
    }
  }
  return result
}
