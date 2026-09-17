import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoSourceRef } from '../../../src/types/video-library.ts'

/** Detached files remain excluded from their former collection, but retain their own scan path. */
export function ignoredVideoFile(d: SqlDb, file: string, resourceId?: string): boolean {
  const row = d.prepare('SELECT resource_id,source_key FROM video_scan_ignores WHERE path=?').get(path.resolve(file)) as { resource_id: string; source_key: string } | undefined
  return !!row && (!row.source_key.startsWith('detached:') || resourceId === row.resource_id)
}

/** Explicit import, binding or download can re-add content; ordinary checks cannot. */
export function clearVideoScanIgnores(d: SqlDb, resourceId: string, files: string[], sources: VideoSourceRef[] = []): void {
  const affected = new Set([resourceId])
  for (const file of files) {
    const row = d.prepare('SELECT resource_id,source_key FROM video_scan_ignores WHERE path=?').get(path.resolve(file)) as { resource_id: string; source_key: string } | undefined
    if (row && !row.source_key.startsWith('detached:')) {
      affected.add(row.resource_id)
      d.prepare('DELETE FROM video_scan_ignores WHERE path=?').run(path.resolve(file))
    }
  }
  for (const id of affected) for (const source of sources) d.prepare('DELETE FROM video_scan_ignores WHERE resource_id=? AND source_key=?').run(id, source.provider + ':' + source.externalId)
}
