import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SqlDb } from './schema.ts'
import { isPosterExt } from '../kinds/video/posters.ts'

export interface PosterStorageContext {
  appPath: string
  exePath: string
  userDataPath: string
  explicitUserData?: boolean
  portable?: boolean
}

export function resolvePosterDirectory(context: PosterStorageContext): string {
  if (context.explicitUserData || context.portable) return path.join(context.userDataPath, 'posters')
  // A packaged build can be several levels below the checkout. Never infer the
  // location from cwd: double-clicking the executable may set it to another disk.
  for (const start of [context.appPath, path.dirname(context.exePath)]) {
    let directory = path.resolve(start)
    while (true) {
      try {
        if (JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name === 'baoyi' &&
          fs.statSync(path.join(directory, 'src')).isDirectory() && fs.statSync(path.join(directory, 'electron')).isDirectory()) return path.join(directory, 'data', 'posters')
      } catch { /* Continue through app.asar and other non-project ancestors. */ }
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return path.join(path.dirname(context.exePath), 'data', 'posters')
}

export interface PosterMigrationResult { copied: number; removed: number; updated: number; warnings: string[] }

type Row = Record<string, unknown>
interface Stamp { dev: number; ino: number; size: number; mtimeMs: number }
interface Mapping { from: string; to: string; sha256: string }
interface Cell { table: string; key: string; id: unknown; column: string; value: unknown }
interface Rewrite extends Omit<Cell, 'value'> { before: unknown; after: unknown }
const keyPath = (file: string) => path.resolve(file).normalize('NFC').toLowerCase()
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const stamp = (stat: fs.Stats): Stamp => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs })
const sameStamp = (a: Stamp, b: Stamp) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

function stat(file: string): fs.Stats | null {
  try { return fs.lstatSync(file) } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause }
}
function directImage(directory: string, file: string): boolean {
  return path.isAbsolute(file) && keyPath(path.dirname(file)) === keyPath(directory) && isPosterExt(file)
}
function requireDirectory(directory: string, create = false): void {
  if (create) fs.mkdirSync(directory, { recursive: true })
  const info = stat(directory)
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('图片目录不是普通目录，保留原文件：' + directory)
}
function imageHash(file: string): string {
  const info = stat(file)
  if (!info?.isFile() || info.isSymbolicLink()) return ''
  const descriptor = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024), digest = createHash('sha256')
  try {
    for (;;) { const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null); if (!bytes) break; digest.update(buffer.subarray(0, bytes)) }
    return digest.digest('hex')
  } finally { fs.closeSync(descriptor) }
}
function writeJson(file: string, value: unknown): void {
  requireDirectory(path.dirname(file), true)
  if (stat(file)?.isSymbolicLink()) throw new Error('图片迁移记录不能是链接：' + file)
  const temporary = file + '.' + randomUUID() + '.tmp'
  const descriptor = fs.openSync(temporary, 'wx')
  try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(descriptor) }
  finally { fs.closeSync(descriptor) }
  try { fs.renameSync(temporary, file) }
  catch (cause) { fs.unlinkSync(temporary); throw cause }
}

/** Preserve text/URLs byte-for-byte; rewrite only exact file paths, including JSON inside JSON. */
function visit(value: unknown, replace: (value: string) => string, depth = 0): unknown {
  if (depth > 80) throw new Error('图片引用嵌套过深，保留原文件和资料')
  if (typeof value === 'string') {
    const direct = replace(value)
    if (direct !== value) return direct
    if (/^\s*[\[{]/.test(value)) {
      let parsed: unknown
      try { parsed = JSON.parse(value) } catch { return value }
      const next = visit(parsed, replace, depth + 1)
      return next === parsed ? value : JSON.stringify(next)
    }
    return value
  }
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const next = value.map(item => visit(item, replace, depth + 1))
    return next.every((item, index) => item === value[index]) ? value : next
  }
  const rows = Object.entries(value).map(([key, item]) => [key, visit(item, replace, depth + 1)] as const)
  return rows.every(([key, item]) => item === (value as Row)[key]) ? value : Object.fromEntries(rows)
}
function cells(db: SqlDb): Cell[] {
  const specs = [
    ['resource', 'id', ['path', 'icon_path']],
    ['video_meta', 'resource_id', ['poster_path', 'poster_source', 'thumbnail_path', 'thumbnail_source', 'fanart_path', 'parts', 'linked_files']],
    ['episode', 'id', ['path', 'poster_path', 'poster_source', 'thumbnail_path', 'thumbnail_source']],
    ['video_assets', 'id', ['path']],
    ['video_organize_journal', 'id', ['data']],
    ['video_download_jobs', 'id', ['payload']]
  ] as const
  const result: Cell[] = []
  for (const [table, key, columns] of specs) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue
    const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(row => row.name))
    const available = columns.filter(column => present.has(column))
    for (const row of db.prepare(`SELECT ${[key, ...available].join(',')} FROM ${table}`).all() as Row[]) {
      for (const column of available) result.push({ table, key, id: row[key], column, value: row[column] })
    }
  }
  return result
}
function rewriteJournal(value: string, mappings: Map<string, Mapping>): string {
  const journal = JSON.parse(value)
  // Copy/move retries compare file identities. The replacement was verified by
  // content; refresh its stamp only when it still matches the journal's hash.
  for (const file of journal.files || []) for (const field of ['source', 'destination'] as const) {
    const mapping = [...mappings.values()].find(entry => file[field] === entry.to)
    const identity = field === 'source' ? 'sourceIdentity' : 'targetIdentity'
    if (mapping && file[identity] && file.sha256 === mapping.sha256 && imageHash(mapping.to) === file.sha256) file[identity] = stamp(fs.lstatSync(mapping.to))
  }
  if (typeof journal.manifest?.before === 'string') journal.manifest.beforeHash = hash(journal.manifest.before)
  return JSON.stringify(journal)
}

/** Copy -> verify -> durable recovery map -> atomic references -> remove verified old copies.
 * No media directory is moved. Missing paths in organizer history are mapped too,
 * so a later move rollback cannot recreate an image in the old profile.
 */
export function migratePosterStorage(db: SqlDb, legacyDirectory: string, targetDirectory: string): PosterMigrationResult {
  const result: PosterMigrationResult = { copied: 0, removed: 0, updated: 0, warnings: [] }
  const legacy = path.resolve(legacyDirectory), target = path.resolve(targetDirectory)
  if (keyPath(legacy) === keyPath(target)) return result
  requireDirectory(legacy); requireDirectory(target, true)
  if (stat(legacy) && keyPath(fs.realpathSync(legacy)) === keyPath(fs.realpathSync(target))) {
    result.warnings.push('新旧图片目录实际指向同一位置，已保留原图；请将项目图片目录放在独立位置。')
    return result
  }
  const recovery = path.join(target, '..', 'artwork-migrations', hash(keyPath(legacy)).slice(0, 20))
  const mapFile = path.join(recovery, 'mapping.json'), previous = new Map<string, Mapping>()
  if (stat(mapFile)) {
    if (stat(mapFile)!.isSymbolicLink()) throw new Error('图片迁移记录不能是链接')
    const saved = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
    if (saved.version !== 1 || saved.legacy !== legacy || saved.target !== target || !Array.isArray(saved.mappings)) throw new Error('图片迁移记录无效，未清理原文件')
    for (const entry of saved.mappings as Mapping[]) {
      if (!entry || typeof entry.from !== 'string' || typeof entry.to !== 'string' || typeof entry.sha256 !== 'string' ||
        !directImage(legacy, entry.from) || !directImage(target, entry.to) || entry.sha256 && !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('图片迁移记录包含无效路径，未清理原文件')
      previous.set(keyPath(entry.from), entry)
    }
  }
  const values = cells(db), sources = new Map<string, string>(), reserved = new Set<string>()
  for (const entry of previous.values()) { sources.set(keyPath(entry.from), entry.from); reserved.add(keyPath(entry.to)) }
  for (const cell of values) visit(cell.value, value => {
    if (directImage(legacy, value)) sources.set(keyPath(value), path.resolve(value))
    if (directImage(target, value)) reserved.add(keyPath(value))
    return value
  })
  if (stat(legacy)) for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
    if (!entry.isDirectory() && isPosterExt(entry.name)) { const file = path.join(legacy, entry.name); sources.set(keyPath(file), file) }
  }
  if (!sources.size) return result
  const mappings = new Map<string, Mapping>(), originals = new Map<string, Stamp>()
  function destination(from: string, digest: string): string {
    const parsed = path.parse(from), suffix = '-migrated-' + hash(keyPath(from) + digest).slice(0, 12)
    for (let index = 0; index < 10000; index++) {
      const filename = index === 0 ? parsed.base : parsed.name.slice(0, 100) + suffix + (index > 1 ? '-' + index : '') + parsed.ext
      const candidate = path.join(target, filename)
      if (reserved.has(keyPath(candidate))) continue
      if (!stat(candidate) || digest && imageHash(candidate) === digest) return candidate
    }
    throw new Error('无法为迁移图片选择空闲名称：' + from)
  }
  for (const [key, from] of sources) {
    try {
      const info = stat(from), prior = previous.get(key)
      if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('不是可迁移的普通图片文件')
      const digest = info ? imageHash(from) : prior?.sha256 || ''
      const to = prior && (!info || prior.sha256 === digest && imageHash(prior.to) === digest) ? prior.to : destination(from, digest)
      if (info) {
        if (!stat(to)) {
          fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
          if (imageHash(to) !== digest) throw new Error('复制校验失败，保留原图')
          result.copied++
        }
        if (imageHash(to) !== digest) throw new Error('目标内容已变化，保留原图')
        originals.set(key, stamp(info))
      }
      const entry = { from, to, sha256: digest }
      mappings.set(key, entry); reserved.add(keyPath(to))
    } catch (cause) { result.warnings.push('图片尚未迁移：' + from + '（' + errorText(cause) + '）') }
  }
  const changes: Rewrite[] = []
  for (const { value, ...cell } of values) {
    let after = visit(value, file => path.isAbsolute(file) ? mappings.get(keyPath(file))?.to || file : file)
    if (after === value) continue
    if (cell.table === 'video_organize_journal' && typeof after === 'string') after = rewriteJournal(after, mappings)
    changes.push({ ...cell, before: value, after })
  }
  if (!mappings.size) return result
  const saved = { version: 1, legacy, target, mappings: [...new Map([...previous, ...mappings]).values()] }
  if (changes.length || result.copied || originals.size) {
    writeJson(mapFile, saved)
    if (changes.length) writeJson(path.join(recovery, Date.now() + '-' + randomUUID() + '.json'), { ...saved, changes })
  } else if (!stat(mapFile)) writeJson(mapFile, saved)
  if (changes.length) {
    const savepoint = 'poster_migration_' + randomUUID().replaceAll('-', '')
    db.exec('SAVEPOINT ' + savepoint)
    try {
      for (const change of changes) {
        const outcome = db.prepare(`UPDATE ${change.table} SET ${change.column} = ? WHERE ${change.key} = ? AND ${change.column} IS ?`).run(change.after, change.id, change.before)
        if (Number(outcome.changes) !== 1) throw new Error('图片资料在迁移期间变化，已保留原文件')
      }
      db.exec('RELEASE SAVEPOINT ' + savepoint); result.updated = changes.length
    } catch (cause) { db.exec('ROLLBACK TO SAVEPOINT ' + savepoint); db.exec('RELEASE SAVEPOINT ' + savepoint); throw cause }
  }
  for (const [key, before] of originals) {
    const entry = mappings.get(key)!
    try {
      const now = stat(entry.from)
      if (!now || !now.isFile() || now.isSymbolicLink() || !sameStamp(before, stamp(now)) || imageHash(entry.from) !== entry.sha256 || imageHash(entry.to) !== entry.sha256) throw new Error('文件在迁移期间变化，保留原图')
      if (keyPath(fs.realpathSync(entry.from)) === keyPath(fs.realpathSync(entry.to))) throw new Error('新旧路径指向同一文件，保留原图')
      fs.unlinkSync(entry.from); result.removed++
    } catch (cause) { result.warnings.push('旧图片尚未清理：' + entry.from + '（' + errorText(cause) + '）') }
  }
  // Only remove an empty cache folder. Unknown files and user-created subfolders stay.
  if (stat(legacy) && fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy)
  return result
}
