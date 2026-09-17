import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoFacts } from './facts.ts'
import type { VideoCandidate } from './scanner.ts'
import type { VideoPayload } from './db.ts'
import type { SourceEpisodeDetails } from './episode-details.ts'
import { registerLocalVideoFacts, registerVideoBundle, registerVideoIdentification } from './registration.ts'
import { readVideoLocalMetadata } from './local-metadata.ts'

export type VideoImportCommand =
  | { kind: 'local'; path: string; candidate: VideoCandidate; facts: VideoFacts; splitFromId?: string }
  | { kind: 'agent'; path: string; candidate: VideoCandidate; payload: VideoPayload; sourceDetails?: SourceEpisodeDetails; splitFromId?: string }
  | { kind: 'bundle'; path: string; directory: string; restoreRemoved: boolean }

export function replayVideoImport(d: SqlDb, command: VideoImportCommand) {
  if (command.kind === 'bundle') return registerVideoBundle(d, command.directory, command.restoreRemoved)
  const result = command.kind === 'local' ? registerLocalVideoFacts(d, command.facts, command.splitFromId)
    : registerVideoIdentification(d, command.payload, command.sourceDetails, command.splitFromId)
  return { resourceId: result.id, created: result.created, itemsAdded: result.episodesAdded }
}

/** Only video ownership and metadata participate; preview/task/log writes do not invalidate a batch. */
export function videoImportLibraryStamp(d: SqlDb, artworkResourceIds: string[] = []): string {
  const hash = createHash('sha256')
  const artwork = new Set(artworkResourceIds)
  const tables = ['resource', 'video_meta', 'episode', 'video_assets', 'video_episode_assets', 'video_sources', 'video_directories',
    'video_scan_state', 'video_scan_ignores', 'video_detached_owners', 'video_organize_journal']
  for (const table of tables) {
    if (!d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) { hash.update(table).update('[]'); continue }
    const rows = d.prepare(`SELECT * FROM ${table}${table === 'resource' ? " WHERE kind='video'" : ''} ORDER BY rowid`).all()
    const values = rows.map(row => {
      const value = { ...(row as Record<string, unknown>) }
      // Library reads refresh presence/check times. Only their resulting state,
      // metadata and ownership matter to confirmation, not the observation time.
      if (['resource', 'video_sources', 'video_directories', 'video_scan_state'].includes(table)) delete value.updated_at
      if (table === 'video_assets') delete value.checked_at
      if (artwork.has(String(table === 'resource' ? value.id : value.resource_id))) {
        if (table === 'video_meta' || table === 'episode') {
          for (const field of ['poster_path', 'poster_source', 'thumbnail_path', 'thumbnail_source']) delete value[field]
          if (table === 'video_meta') value.user_edited = JSON.stringify((JSON.parse(String(value.user_edited || '[]')) as string[]).filter(field => !['poster_path', 'thumbnail_path'].includes(field)))
        }
      }
      return value
    })
    hash.update(table).update(JSON.stringify(values))
  }
  return hash.digest('hex')
}

export interface VideoImportFileStamp { path: string; stamp: string }
function stampFile(file: string): string {
  try {
    const stat = fs.statSync(file)
    const content = /\.(json|nfo)$/i.test(file) && stat.isFile() && stat.size <= 4 * 1024 * 1024
      ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : ''
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, content])
  } catch { return 'missing' }
}
export function videoImportFiles(commands: VideoImportCommand[]): VideoImportFileStamp[] {
  const files = new Set<string>()
  const add = (file?: string) => { if (file && path.isAbsolute(file)) files.add(path.resolve(file)) }
  for (const command of commands) {
    if (command.kind === 'bundle') {
      const visit = (directory: string, depth: number) => {
        if (depth > 10) return
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue
          const file = path.join(directory, entry.name)
          if (entry.isDirectory()) visit(file, depth + 1)
          else if (/\.(mp4|mkv|avi|mov|m4v|webm|wmv|mpg|mpeg|ts|m2ts|flv|json|nfo|png|jpe?g|webp)$/i.test(file)) add(file)
        }
      }
      visit(command.directory, 0)
    } else {
      for (const file of [...command.candidate.files, ...command.candidate.episodes.flatMap(episode => episode.files)]) {
        add(file.path)
        readVideoLocalMetadata(file.path).metadataFiles.forEach(add)
      }
      if (command.kind === 'local') {
        command.facts.nfo_files.forEach(add); command.facts.images.forEach(add)
        command.facts.external_subtitles.forEach(add); command.facts.attachments?.forEach(attachment => add(attachment.path))
      }
    }
  }
  return [...files].sort().map(file => ({ path: file, stamp: stampFile(file) }))
}
export function verifyVideoImportFiles(files: VideoImportFileStamp[]): void {
  for (const file of files) if (stampFile(file.path) !== file.stamp || file.stamp === 'missing') {
    throw new Error('文件或本地资料已变化，请重新检查目录后确认：' + file.path)
  }
}
