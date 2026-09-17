import path from 'node:path'
import fs from 'node:fs'
import type { SqlDb } from '../../services/schema.ts'

interface OwnerJournal {
  createdAt: number
  kind: string
  logicalApplied: boolean
  status: string
  sourceIds: string[]
  survivorId: string
  changes: Array<{ undone?: boolean; originId?: string; before: { resource_id?: string } | null; after: { resource_id?: string } }>
  snapshot: { resource: Array<{ id: string; path: string }>; video_directories: Array<{ resource_id: string; directory_path: string }> }
  files: Array<{ source: string; size: number; sourceIdentity?: { size: number; mtimeMs: number }; resourceIds: string[]; episodeIds: string[]; assetIds: string[] }>
}

function journals(d: SqlDb): OwnerJournal[] {
  if (!d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'video_organize_journal'").get()) return []
  return (d.prepare('SELECT data FROM video_organize_journal ORDER BY created_at, rowid').all() as Array<{ data: string }>).map(row => {
    try { return JSON.parse(row.data) as OwnerJournal }
    catch { throw new Error('整理记录无法读取，请先恢复资料库备份') }
  }).filter(j => j.kind === 'organize' && j.logicalApplied && j.status !== 'rolled-back')
}

function ownerFrom(records: OwnerJournal[], resourceId: string): string {
  let result = resourceId
  const seen = new Set<string>()
  while (!seen.has(result)) {
    seen.add(result)
    const next = records.find(j => j.sourceIds.includes(result) && j.survivorId !== result && (
      j.status !== 'rollback-partial' || j.changes.some(c => !c.undone && (
        c.before?.resource_id === result && c.after.resource_id === j.survivorId || c.before === null && c.originId === result
      ))
    ))
    if (!next) return result
    result = next.survivorId
  }
  throw new Error('整理记录中的作品归属出现循环，请先恢复资料库备份')
}

/** This module has no dependency on registration or file mutation code. */
export function resolveVideoOrganizeOwner(d: SqlDb, resourceId: string): string {
  if (d.prepare('SELECT resource_id FROM video_detached_owners WHERE resource_id = ?').get(resourceId)) return resourceId
  return ownerFrom(journals(d), resourceId)
}

/** Retained original files and directories remain aliases after explicit organization. */
export function resolveVideoOrganizePathOwner(d: SqlDb, file: string): string {
  if (!file) return ''
  const detached = d.prepare('SELECT a.resource_id FROM video_assets a JOIN video_detached_owners o ON o.resource_id=a.resource_id WHERE a.path=? COLLATE NOCASE').get(path.resolve(file)) as { resource_id: string } | undefined
  if (detached) return detached.resource_id
  const key = (value: string) => path.resolve(value).normalize('NFC').toLowerCase()
  const target = key(file), records = journals(d), owners = new Set<string>()
  for (const j of records) {
    for (const row of j.snapshot.resource) if (row.path && key(row.path) === target) owners.add(ownerFrom(records, row.id))
    for (const row of j.snapshot.video_directories) if (key(row.directory_path) === target) owners.add(ownerFrom(records, row.resource_id))
    for (const entry of j.files) if (key(entry.source) === target) for (const id of entry.resourceIds) owners.add(ownerFrom(records, id))
  }
  return owners.size === 1 ? [...owners][0] : ''
}

/** A rescan must not undo an explicit user merge by automatically splitting its files. */
export function isVideoOrganizeSurvivor(d: SqlDb, resourceId: string): boolean {
  const records = journals(d)
  return records.some(j => ownerFrom(records, j.survivorId) === resourceId)
}

/** Retained originals still identify the assets published by an active merge. */
export function videoOrganizeAssetPath(d: SqlDb, resourceId: string, file: string): string {
  const target = path.resolve(file).normalize('NFC').toLowerCase()
  const paths = new Set<string>()
  for (const j of journals(d)) for (const entry of j.files) {
    if (path.resolve(entry.source).normalize('NFC').toLowerCase() !== target) continue
    for (const id of entry.assetIds || []) {
      const row = d.prepare('SELECT path FROM video_assets WHERE id = ? AND resource_id = ?').get(id, resourceId) as { path: string } | undefined
      if (row) paths.add(row.path)
    }
  }
  return paths.size === 1 ? [...paths][0] : ''
}

export function videoOrganizeEpisodeForFile(d: SqlDb, resourceId: string, file: string, season?: number, number?: number): string {
  const target = path.resolve(file).toLowerCase()
  const candidates = new Map<string, { id: string; season: number; episode: number }>()
  for (const j of journals(d)) for (const entry of j.files) {
    if (path.resolve(entry.source).toLowerCase() !== target) continue
    for (const id of entry.episodeIds) {
      const row = d.prepare('SELECT id, season, episode FROM episode WHERE id = ? AND resource_id = ?').get(id, resourceId) as { id: string; season: number; episode: number } | undefined
      if (row) candidates.set(row.id, row)
    }
  }
  const rows = [...candidates.values()]
  return rows.find(row => row.season === season && row.episode === number)?.id || (rows.length === 1 ? rows[0].id : '')
}

/** Bootstrap older releases using exact journal entries, never a containing directory alone. */
export function unchangedOrganizedFiles(d: SqlDb, files: string[], metadataFiles: string[]): string {
  if (!files.length) return ''
  const records = journals(d), owners = new Set<string>()
  for (const file of files) {
    const target = path.resolve(file).normalize('NFC').toLowerCase()
    let matched = false
    for (const j of [...records].reverse()) {
      const entry = j.files.find(f => path.resolve(f.source).normalize('NFC').toLowerCase() === target)
      if (!entry) continue
      try {
        const stat = fs.statSync(file)
        if (!stat.isFile() || stat.size !== entry.size || (entry.sourceIdentity ? stat.mtimeMs !== entry.sourceIdentity.mtimeMs : stat.mtimeMs > j.createdAt)) return ''
        if (metadataFiles.some(p => fs.statSync(p).mtimeMs > j.createdAt)) return ''
        const current = entry.episodeIds.map(id => d.prepare('SELECT resource_id FROM episode WHERE id=?').get(id) as { resource_id: string } | undefined).filter(Boolean)
        if (!current.length) return ''
        current.forEach(e => owners.add(resolveVideoOrganizeOwner(d, e!.resource_id)))
        matched = true; break
      } catch { return '' }
    }
    if (!matched) return ''
  }
  if (owners.size !== 1) return ''
  const id = [...owners][0]
  return d.prepare('SELECT id FROM resource WHERE id=? AND is_archived=0').get(id) ? id : ''
}
