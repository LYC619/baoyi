import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { SCHEMA_KEY, type SqlDb } from './schema.ts'
import type { LibraryExportInfo, LibrarySafetyInfo, LibrarySnapshot, LibrarySnapshotEntry, LibrarySnapshotInventory } from '../../src/types/library-snapshot.ts'

export const APP_VERSION_KEY = '_last_successful_app_version'
const EXPORT_KEY = '_last_library_metadata_export'
export interface SnapshotDatabase extends SqlDb { close(): void }
type Opener<T extends SnapshotDatabase = SnapshotDatabase> = (file: string, readonly: boolean) => T
const snapshotDirectory = (directory: string) => path.join(directory, 'library-snapshots')

function databaseState(db: SqlDb) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
  if (!tables.length) return { empty: true, schema: 0, version: '' }
  if (!tables.some(t => t.name === 'settings')) throw new Error('无法识别现有资料库，未执行升级')
  const raw = db.prepare('SELECT value FROM settings WHERE key=?').get(SCHEMA_KEY) as { value: string } | undefined
  const schema = raw ? Number(raw.value) : 0
  if (!Number.isSafeInteger(schema) || schema < 0) throw new Error('资料库结构版本无效，未执行升级')
  const previous = db.prepare('SELECT value FROM settings WHERE key=?').get(APP_VERSION_KEY) as { value: string } | undefined
  let version = ''
  try { const parsed = JSON.parse(previous?.value || 'null'); if (typeof parsed === 'string' && parsed.length <= 80) version = parsed } catch { /* Legacy installs have no app-version record. */ }
  return { empty: false, schema, version }
}
function verifyDatabase(db: SqlDb) {
  const checks = db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[]
  if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') throw new Error('数据库完整性校验失败，未执行升级')
}
function fileHash(file: string): string {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(file, 'r')
  try { let bytes: number; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)); return hash.digest('hex') }
  finally { fs.closeSync(fd) }
}

export function createLibrarySnapshot(db: SqlDb, options: { directory: string; version: string; targetSchema: number; reason: LibrarySnapshot['reason']; open: Opener }): LibrarySnapshotEntry {
  verifyDatabase(db)
  const before = databaseState(db), directory = snapshotDirectory(options.directory)
  fs.mkdirSync(directory, { recursive: true })
  const createdAt = Date.now(), id = `${createdAt}-${randomUUID()}`, file = id + '.db', target = path.join(directory, file)
  // VACUUM INTO reads a consistent SQLite snapshot, including committed WAL pages.
  db.prepare('VACUUM INTO ?').run(target)
  const copy = options.open(target, true)
  try {
    verifyDatabase(copy)
    const state = databaseState(copy)
    if (state.schema !== before.schema || state.version !== before.version) throw new Error('快照版本校验失败，未执行升级')
  } finally { copy.close() }
  const snapshot: LibrarySnapshot = {
    format: 'baoyi-database-snapshot', version: 1, id, file, createdAt, reason: options.reason,
    fromSchema: before.schema, targetSchema: options.targetSchema, fromVersion: before.version,
    targetVersion: options.version, size: fs.statSync(target).size, sha256: fileHash(target)
  }
  // A manifest is published only after verification. Orphan files remain recoverable on failure.
  const fd = fs.openSync(path.join(directory, id + '.json'), 'wx')
  try { fs.writeFileSync(fd, JSON.stringify(snapshot, null, 2)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  return { ...snapshot, state: 'available' }
}

export function openUpgradedDatabase<T extends SnapshotDatabase>(options: { file: string; version: string; targetSchema: number; open: Opener<T>; migrate: (db: T) => void }): T {
  if (fs.existsSync(options.file)) {
    const probe = options.open(options.file, true)
    try {
      verifyDatabase(probe)
      const before = databaseState(probe)
      if (before.schema > options.targetSchema) throw new Error(`资料库结构 ${before.schema} 高于当前程序支持的 ${options.targetSchema}，请使用更新版本`)
      if (!before.empty && (before.schema < options.targetSchema || before.version !== options.version)) {
        createLibrarySnapshot(probe, { directory: path.dirname(options.file), version: options.version, targetSchema: options.targetSchema, reason: 'upgrade', open: options.open })
      }
    } finally { probe.close() }
  }
  const db = options.open(options.file, false)
  try {
    options.migrate(db)
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(APP_VERSION_KEY, JSON.stringify(options.version))
    return db
  } catch (cause) { db.close(); throw cause }
}

function fileState(file: string, size: number): LibrarySnapshotEntry['state'] {
  try { const stat = fs.lstatSync(file); return stat.isFile() && stat.size === size ? 'available' : 'changed' }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw cause }
}
function readDirectory(directory: string): string[] {
  try { return fs.readdirSync(directory) } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []; throw cause }
}
function validSnapshot(value: unknown, name: string): value is LibrarySnapshot {
  if (!value || typeof value !== 'object') return false
  const s = value as LibrarySnapshot
  return s.format === 'baoyi-database-snapshot' && s.version === 1 && typeof s.id === 'string'
    && /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s.id)
    && name === s.id + '.json' && s.file === s.id + '.db'
    && ['upgrade', 'manual'].includes(s.reason) && Number.isSafeInteger(s.createdAt) && s.createdAt > 0
    && Number.isSafeInteger(s.fromSchema) && s.fromSchema >= 0 && Number.isSafeInteger(s.targetSchema) && s.targetSchema >= 0
    && typeof s.fromVersion === 'string' && s.fromVersion.length <= 80 && typeof s.targetVersion === 'string' && s.targetVersion.length <= 80
    && Number.isSafeInteger(s.size) && s.size > 0 && typeof s.sha256 === 'string' && /^[0-9a-f]{64}$/.test(s.sha256)
}
export function readSnapshotInventory(directory: string): LibrarySnapshotInventory {
  const root = snapshotDirectory(directory), names = readDirectory(root), snapshots: LibrarySnapshotEntry[] = [], warnings: string[] = []
  const manifests = names.filter(n => n.endsWith('.json')).sort().reverse()
  if (manifests.length > 1000) warnings.push('快照较多，仅检查最近 1000 份说明文件')
  for (const name of manifests.slice(0, 1000)) {
    try {
      const file = path.join(root, name), stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > 16384) throw new Error('说明文件无效')
      const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!validSnapshot(value, name)) throw new Error('说明内容无效')
      snapshots.push({ ...value, state: fileState(path.join(root, value.file), value.size) })
    } catch { warnings.push(`快照说明不可读：${name}`) }
  }
  const orphans = names.filter(n => n.endsWith('.db') && !names.includes(n.slice(0, -3) + '.json')).length
  if (orphans) warnings.push(`${orphans} 份数据库快照缺少说明文件，原文件已保留`)
  const legacyBackups = readDirectory(directory).filter(n => /^baoyi\.db\.v[0-9.]+\.bak$/.test(n)).length
  const recoveryDirectory = path.join(directory, 'recovery'), recoveryBackups = readDirectory(recoveryDirectory).filter(n => /^baoyi-before-restore-.+\.db$/.test(n)).length
  return { directory: root, snapshots: snapshots.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100), total: snapshots.length, legacyBackups, recoveryDirectory, recoveryBackups, warnings }
}
export function recordMetadataExport(db: SqlDb, file: string): void {
  const value = { file, createdAt: Date.now(), size: fs.statSync(file).size }
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(EXPORT_KEY, JSON.stringify(value))
}
export function librarySafetyInfo(db: SqlDb, directory: string, version: string): LibrarySafetyInfo {
  let lastExport: LibraryExportInfo | null = null
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(EXPORT_KEY) as { value: string } | undefined
  if (row) {
    try {
      const value = JSON.parse(row.value)
      if (typeof value.file === 'string' && path.isAbsolute(value.file) && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.size) && value.size > 0) lastExport = { file: value.file, createdAt: value.createdAt, size: value.size, state: fileState(value.file, value.size) }
    } catch { /* Invalid old export information never blocks the data page. */ }
  }
  return { version, schema: databaseState(db).schema, dataDirectory: directory, database: path.join(directory, 'baoyi.db'), inventory: readSnapshotInventory(directory), lastExport }
}
