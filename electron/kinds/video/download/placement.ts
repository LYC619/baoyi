import fs from 'node:fs'
import path from 'node:path'
import type { SqlDb } from '../../../services/schema.ts'
import type { VideoItem } from '../../../../src/types/index.ts'
import type { VideoDirectoryChange } from '../../../../src/types/video-workflow.ts'
import { safeWorkFolderName } from '../bundle.ts'
import { isDirectory } from '../episode-details.ts'
import { numberedEpisode } from '../episode-identity.ts'
import { resolveVideoOrganizeOwner } from '../organize-owner.ts'
import { rebaseStoredVideoJobs } from './jobs.ts'

const same = (a: string, b: string) => path.resolve(a).normalize('NFC').toLowerCase() === path.resolve(b).normalize('NFC').toLowerCase()
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return !rel || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel) }

export function downloadPlacement(item: VideoItem | null, binding: { directory_path: string; root: string } | undefined, title: string, libraryRoots: string[], fallback: string) {
  const libraries = libraryRoots.filter(root => path.isAbsolute(root))
  let directory = binding?.directory_path || ''
  if (!directory && item) {
    if (isDirectory(item.path)) directory = item.path
    else if (item.parts.length && isDirectory(path.dirname(item.parts[0].path))) directory = path.dirname(item.parts[0].path)
    else if (path.isAbsolute(item.path) && path.extname(item.path)) directory = path.dirname(item.path)
  }
  const root = binding?.root || (directory ? libraries.filter(root => inside(root, directory)).sort((a, b) => b.length - a.length)[0] || path.dirname(directory) : libraries[0] || fallback)
  if (!directory) return { root, directory: path.join(root, safeWorkFolderName(title)), bound: false }
  // A loose file in the library root must never cause the whole library to be renamed.
  const numbered = numberedEpisode(path.basename(directory))
  const target = path.join(path.dirname(directory), safeWorkFolderName(title))
  const titleBase = title.replace(/\s+\d+\s*[-~–—～]\s*\d+$/, '').trim()
  const directoryBase = numbered?.title || path.basename(directory).replace(/\s+\d+\s*[-~–—～]\s*\d+$/, '').trim()
  const shouldRename = directoryBase.normalize('NFKC').toLowerCase() === titleBase.normalize('NFKC').toLowerCase()
    && !same(directory, root) && !libraries.some(root => same(root, directory)) && !same(directory, target)
  return { root, directory: shouldRename ? target : directory, bound: true,
    ...(shouldRename ? { directoryChange: { from: directory, to: target } as VideoDirectoryChange } : {}) }
}

/** The persisted job is the recovery journal for the filesystem/SQLite boundary. */
export function promoteDownloadDirectory(d: SqlDb, resourceId: string, change: VideoDirectoryChange, persist: () => void): void {
  if (change.applied) return
  const from = path.resolve(change.from), to = path.resolve(change.to), parent = path.dirname(from)
  if (!path.isAbsolute(change.from) || !path.isAbsolute(change.to) || same(from, to) || !same(parent, path.dirname(to)) || same(from, path.parse(from).root)) throw new Error('合集目录变更必须位于当前目录的同一上级目录内')
  if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('合集目录的上级是链接，请先选择实际目录')
  const sourceExists = fs.existsSync(from)
  if (sourceExists) {
    const stat = fs.lstatSync(from)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('当前作品位置不是可更名的普通目录')
    if (fs.existsSync(to)) throw new Error('合集目录已经存在，未覆盖原文件；请先在文件管理中确认目录归属')
    for (const row of d.prepare('SELECT id, path FROM resource WHERE is_archived = 0').all() as Array<{ id: string; path: string }>) {
      if (row.id !== resourceId && path.isAbsolute(row.path) && inside(from, row.path) && resolveVideoOrganizeOwner(d, row.id) !== resourceId) throw new Error('当前目录还包含其他作品，保留原目录，请先整理作品归属')
    }
    change.identity = { dev: stat.dev, ino: stat.ino }; persist()
    fs.renameSync(from, to)
  } else {
    const stat = fs.lstatSync(to)
    if (!change.identity || !stat.isDirectory() || stat.isSymbolicLink() || !stat.ino || stat.ino !== change.identity.ino || stat.dev !== change.identity.dev) throw new Error('无法确认中断任务的合集目录，请重新定位')
  }
  const remap = (value: unknown): unknown => {
    if (typeof value === 'string') return path.isAbsolute(value) && inside(from, value) ? path.join(to, path.relative(from, value)) : value
    if (Array.isArray(value)) return value.map(remap)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, remap(part)]))
    return value
  }
  d.exec('SAVEPOINT promote_directory')
  try {
    for (const [table, key, fields] of [
      ['resource', 'id', ['path', 'source_dir', 'icon_path']], ['video_meta', 'resource_id', ['poster_path', 'fanart_path']],
      ['episode', 'resource_id', ['path', 'poster_path']], ['video_assets', 'resource_id', ['path']],
      ['video_directories', 'resource_id', ['directory_path']]
    ] as Array<[string, string, string[]]>) {
      for (const row of d.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).all(resourceId) as Array<Record<string, any>>) {
        const pk = table === 'video_meta' || table === 'video_directories' ? 'resource_id' : 'id'
        for (const field of fields) if (row[field] && remap(row[field]) !== row[field]) d.prepare(`UPDATE ${table} SET ${field} = ? WHERE ${pk} = ?`).run(remap(row[field]), row[pk])
      }
    }
    const meta = d.prepare('SELECT parts, linked_files, subtitle_tracks, audio_tracks FROM video_meta WHERE resource_id = ?').get(resourceId) as Record<string, string>
    for (const [field, json] of Object.entries(meta || {})) d.prepare(`UPDATE video_meta SET ${field} = ? WHERE resource_id = ?`).run(JSON.stringify(remap(JSON.parse(json || '[]'))), resourceId)
    d.prepare('UPDATE resource SET file_name = ?, updated_at = ? WHERE id = ?').run(path.basename(to), Date.now(), resourceId)
    const binding = d.prepare('SELECT root FROM video_directories WHERE resource_id = ?').get(resourceId) as { root: string } | undefined
    if (binding) d.prepare('UPDATE video_directories SET relative_path = ?, updated_at = ? WHERE resource_id = ?').run(path.relative(binding.root, to), Date.now(), resourceId)
    rebaseStoredVideoJobs(d, resourceId, from, to, binding?.root || parent)
    d.exec('RELEASE SAVEPOINT promote_directory')
  } catch (error) {
    d.exec('ROLLBACK TO SAVEPOINT promote_directory'); d.exec('RELEASE SAVEPOINT promote_directory')
    if (sourceExists && !fs.existsSync(from)) { try { fs.renameSync(to, from) } catch { /* The persisted inode allows a later retry to finish recovery. */ } }
    throw error
  }
  // SQLite has committed. If persisting the completion flag fails, the saved
  // directory identity lets the next run repeat only the idempotent path update.
  change.applied = true
  persist()
}
