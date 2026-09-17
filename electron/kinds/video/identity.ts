import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoOwnership, VideoSourceRef } from '../../../src/types/video-library.ts'
import { resolveVideoOrganizeOwner, resolveVideoOrganizePathOwner } from './organize-owner.ts'

function sourceKey(source: VideoSourceRef): string {
  return `${source.provider}:${source.externalId}:${source.scope}`.toLowerCase()
}

/** Resolve a work from confirmed source membership before making title guesses. */
export function resolveVideoOwnership(d: SqlDb, input: {
  title: string
  sources?: VideoSourceRef[]
  directory?: string
}): VideoOwnership {
  const sources = input.sources ?? []
  const ids = new Set(sources.map(sourceKey))
  const candidates = new Map<string, { path: string; title: string; bundleId: string }>()
  const addOwner = (rawId: string) => {
    const id = resolveVideoOrganizeOwner(d, rawId)
    const row = d.prepare(`SELECT r.path, COALESCE(NULLIF(r.name_zh, ''), NULLIF(r.name_en, ''), r.file_name) AS title,
      COALESCE(vd.bundle_id, '') AS bundle_id FROM resource r LEFT JOIN video_directories vd ON vd.resource_id = r.id
      WHERE r.id = ? AND r.kind = 'video' AND r.is_archived = 0`).get(id) as Record<string, unknown> | undefined
    if (row) candidates.set(id, { path: String(row.path), title: String(row.title), bundleId: String(row.bundle_id) })
  }
  if (ids.size) {
    const rows = d.prepare(`SELECT DISTINCT r.id, r.path, COALESCE(r.name_zh, r.name_en, r.file_name) AS title,
      COALESCE(vd.bundle_id, '') AS bundle_id
      FROM video_sources vs JOIN resource r ON r.id = vs.resource_id
      LEFT JOIN video_directories vd ON vd.resource_id = r.id
      WHERE r.kind = 'video'`).all() as Array<Record<string, unknown>>
    for (const row of rows) {
      const rowSources = d.prepare(`SELECT provider, external_id, scope FROM video_sources WHERE resource_id = ?`).all(String(row.id)) as Array<Record<string, unknown>>
      if (rowSources.some(source => ids.has(sourceKey({
        provider: String(source.provider), externalId: String(source.external_id), scope: source.scope as 'work' | 'episode',
        pageUrl: '', evidence: 'legacy'
      })))) addOwner(String(row.id))
    }
  }
  if (input.directory) {
    const dir = path.resolve(input.directory)
    const rows = d.prepare(`SELECT resource_id, directory_path, bundle_id FROM video_directories WHERE directory_path = ? COLLATE NOCASE`).all(dir) as Array<Record<string, unknown>>
    for (const row of rows) {
      addOwner(String(row.resource_id))
    }
    const historical = resolveVideoOrganizePathOwner(d, dir)
    if (historical) addOwner(historical)
  }
  if (candidates.size === 1) {
    const [resourceId, value] = [...candidates.entries()][0]
    const directory = d.prepare(`SELECT resource_id AS resourceId, bundle_id AS bundleId, root, relative_path AS relativePath,
      directory_path AS path, metadata_state AS metadataState FROM video_directories WHERE resource_id = ?`).get(resourceId) as VideoOwnership['directory'] | undefined
    return { state: 'known', resourceId, candidates: [resourceId], title: value.title, reason: ids.size ? '已确认来源归属' : '已绑定作品目录', directory: directory ?? null }
  }
  if (candidates.size > 1) return { state: 'conflict', resourceId: '', candidates: [...candidates.keys()], title: input.title, reason: '来源或目录同时匹配多个作品', directory: null }
  return { state: 'new', resourceId: '', candidates: [], title: input.title, reason: '没有已确认的作品来源映射', directory: null }
}

export function ensureBundleId(value?: string): string {
  return /^[0-9a-f-]{16,64}$/i.test(String(value ?? '')) ? String(value) : randomUUID()
}
