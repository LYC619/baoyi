import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoCandidate } from './scanner.ts'
import { readVideoLocalMetadata } from './local-metadata.ts'
import { resolveVideoOrganizeOwner, unchangedOrganizedFiles } from './organize-owner.ts'

export const VIDEO_SCAN_STATE_SQL = `
CREATE TABLE IF NOT EXISTS video_detached_owners(resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS video_scan_state (
  path TEXT PRIMARY KEY COLLATE NOCASE, fingerprint TEXT NOT NULL,
  resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS video_scan_ignores (
  path TEXT PRIMARY KEY COLLATE NOCASE, resource_id TEXT NOT NULL DEFAULT '', source_key TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);`
export function candidateFingerprint(candidate: VideoCandidate): string {
  const files = [...new Set([...candidate.files, ...candidate.episodes.flatMap(e => e.files)].map(f => f.path))].sort()
  // Refresh legacy imports once so newly supported local dates/studios are read.
  const hash = createHash('sha256').update('video-local-first-v3')
  for (const file of files) {
    try {
      const s = fs.statSync(file); hash.update(JSON.stringify([path.resolve(file).toLowerCase(), s.size, s.mtimeMs]))
      for (const metadata of readVideoLocalMetadata(file).metadataFiles.sort()) hash.update(metadata).update(fs.readFileSync(metadata))
    } catch { hash.update('missing:' + file) }
  }
  return hash.digest('hex')
}
export function unchangedCandidate(d: SqlDb, candidate: VideoCandidate, fingerprint: string): string {
  const row = d.prepare('SELECT resource_id,fingerprint FROM video_scan_state WHERE path = ?').get(path.resolve(candidate.path)) as { resource_id: string; fingerprint: string } | undefined
  if (row) return row.fingerprint === fingerprint ? resolveVideoOrganizeOwner(d, row.resource_id) : ''
  const files = [...new Set([...candidate.files, ...candidate.episodes.flatMap(e => e.files)].map(f => f.path))]
  const owner = unchangedOrganizedFiles(d, files, files.flatMap(f => readVideoLocalMetadata(f).metadataFiles))
  if (owner) rememberCandidate(d, candidate, fingerprint, owner)
  return owner
}
export function rememberCandidate(d: SqlDb, candidate: VideoCandidate, fingerprint: string, resourceId: string): void {
  d.prepare('INSERT INTO video_scan_state (path,fingerprint,resource_id,updated_at) VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint,resource_id=excluded.resource_id,updated_at=excluded.updated_at')
    .run(path.resolve(candidate.path), fingerprint, resourceId, Date.now())
}
