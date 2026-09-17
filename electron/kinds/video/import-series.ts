import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoCandidate } from './scanner.ts'
import { videoOwnerForFiles } from './db.ts'
import { readVideoLocalMetadata } from './local-metadata.ts'
import { collectionName, seriesPart, seriesKey } from '../../../src/utils/video-series.ts'

/** Only a matching series stem with distinct episode numbers can unite new candidates. */
export function groupVideoImportCandidates(d: SqlDb, candidates: VideoCandidate[]): VideoCandidate[] {
  const groups = new Map<string, Array<{ candidate: VideoCandidate; title: string; part: NonNullable<ReturnType<typeof seriesPart>> }>>()
  for (const candidate of candidates) {
    const files = [...candidate.files, ...candidate.episodes.flatMap(ep => ep.files)]
    if (candidate.episodes.length > 1 || !files.length || videoOwnerForFiles(d, files.map(file => file.path))) continue
    const metadata = readVideoLocalMetadata(files[0].path)
    const title = metadata.title || candidate.title_zh || candidate.title_en || files[0].name
    const part = seriesPart(title) || seriesPart(files[0].name)
    if (!part) continue
    const key = seriesKey(part.title), rows = groups.get(key) || []
    rows.push({ candidate, title, part }); groups.set(key, rows)
  }
  const replacements = new Map<VideoCandidate, VideoCandidate>(), removed = new Set<VideoCandidate>()
  for (const rows of groups.values()) {
    if (rows.length < 2 || new Set(rows.map(row => `${row.part.season}:${row.part.number}`)).size !== rows.length) continue
    rows.sort((a, b) => a.part.season - b.part.season || a.part.number - b.part.number)
    const first = rows[0].candidate
    const episodes = rows.map(row => ({ season: row.part.season, episode: row.part.number, title: row.title,
      files: [...row.candidate.files, ...row.candidate.episodes.flatMap(ep => ep.files)] }))
    replacements.set(first, { ...first, path: episodes[0].files[0].path, directory: path.dirname(episodes[0].files[0].path), shared_directory: true,
      video_type: 'series', title_zh: collectionName(rows.map(row => row.title)), title_en: '', files: [], episodes,
      evidence: [...first.evidence, '本地片名具有相同系列前缀和不同集数，作为同一合集预览'],
      sidecars: { nfo: [...new Set(rows.flatMap(row => row.candidate.sidecars.nfo))], images: [...new Set(rows.flatMap(row => row.candidate.sidecars.images))], subtitles: [...new Set(rows.flatMap(row => row.candidate.sidecars.subtitles))] },
      extras: rows.flatMap(row => row.candidate.extras) })
    rows.slice(1).forEach(row => removed.add(row.candidate))
  }
  return candidates.filter(candidate => !removed.has(candidate)).map(candidate => replacements.get(candidate) || candidate)
}
