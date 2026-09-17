import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'

export const videoFileKey = (file: string) => path.resolve(file).normalize('NFC').toLowerCase()

/** Include legacy JSON paths as well as projected assets before removing a local file. */
export function referencedVideoFiles(d: SqlDb, options: { omitWorks?: string[]; omitEpisodes?: string[]; keepWorks?: string[] } = {}): Set<string> {
  const omitted = new Set(options.omitWorks || []), episodes = new Set(options.omitEpisodes || []), kept = new Set(options.keepWorks || [])
  const paths = new Set<string>()
  const add = (value: unknown) => { if (typeof value === 'string' && path.isAbsolute(value)) paths.add(videoFileKey(value)) }
  const list = (value: unknown) => {
    try { const rows = JSON.parse(String(value || '[]')); if (Array.isArray(rows)) rows.forEach(row => add(row?.path)) } catch { /* Other valid references still protect their files. */ }
  }
  const works = d.prepare('SELECT r.id,r.path,m.parts,m.linked_files,m.poster_path,m.thumbnail_path,m.fanart_path FROM resource r JOIN video_meta m ON m.resource_id=r.id WHERE r.is_archived=0').all() as Array<Record<string, unknown>>
  for (const work of works) {
    if (!omitted.has(String(work.id))) { add(work.path); list(work.parts); list(work.linked_files) }
    if (!omitted.has(String(work.id)) || kept.has(String(work.id))) { add(work.poster_path); add(work.thumbnail_path); add(work.fanart_path) }
  }
  const contents = d.prepare('SELECT e.id,e.resource_id,e.path,e.poster_path,e.thumbnail_path FROM episode e JOIN resource r ON r.id=e.resource_id WHERE r.is_archived=0').all() as Array<Record<string, unknown>>
  for (const e of contents) if (!omitted.has(String(e.resource_id)) || kept.has(String(e.resource_id)) && !episodes.has(String(e.id))) {
    add(e.path); add(e.poster_path); add(e.thumbnail_path)
  }
  const assets = d.prepare('SELECT a.resource_id,a.path,ea.episode_id FROM video_assets a JOIN resource r ON r.id=a.resource_id LEFT JOIN video_episode_assets ea ON ea.asset_id=a.id WHERE r.is_archived=0').all() as Array<Record<string, unknown>>
  for (const a of assets) if (!omitted.has(String(a.resource_id)) || kept.has(String(a.resource_id)) && (!a.episode_id || !episodes.has(String(a.episode_id)))) add(a.path)
  return paths
}
