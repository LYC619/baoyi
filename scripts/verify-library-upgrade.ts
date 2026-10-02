import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, SCHEMA_KEY } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
assert.ok(fs.existsSync('electron/services/library-snapshots.ts'), 'verified pre-upgrade protection service is required')
const { openUpgradedDatabase, readSnapshotInventory, createLibrarySnapshot, APP_VERSION_KEY } = await import('../electron/services/library-snapshots.ts')
const root = fs.mkdtempSync(path.join(os.tmpdir(), "baoyi-upgrade-'")), file = path.join(root, 'baoyi.db')
const open = (file: string, readonly: boolean) => new DatabaseSync(file, { readOnly: readonly })
const migrate = (db: DatabaseSync) => { db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON'); initSchema(db, KINDS) }
let source = open(file, false)
source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); initSchema(source, KINDS)
source.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(SCHEMA_KEY, '11')
source.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('wal-sentinel', 'committed-in-wal')
source.exec('DROP TABLE image_bookmarks; DROP TABLE image_reader_state')
fs.writeFileSync(path.join(root, 'baoyi.db.v0.11.0.bak'), 'old backup sentinel')
try {
  let migrationCalls = 0
  let upgraded = openUpgradedDatabase({ file, version: '0.10.0', targetSchema: 12, open, migrate: db => { migrationCalls++; migrate(db) } })
  const inventory = readSnapshotInventory(root)
  assert.equal(inventory.snapshots.length, 1); assert.equal(inventory.legacyBackups, 1)
  const snapshot = inventory.snapshots[0]
  assert.equal(snapshot.fromSchema, 11); assert.equal(snapshot.targetSchema, 12); assert.equal(snapshot.fromVersion, '')
  assert.equal(snapshot.targetVersion, '0.10.0'); assert.equal(snapshot.reason, 'upgrade'); assert.equal(snapshot.state, 'available')
  const original = open(path.join(inventory.directory, snapshot.file), true)
  try {
    assert.equal(original.prepare('SELECT value FROM settings WHERE key=?').get(SCHEMA_KEY)!.value, '11')
    assert.equal(original.prepare('SELECT value FROM settings WHERE key=?').get('wal-sentinel')!.value, 'committed-in-wal')
    assert.equal(original.prepare("SELECT 1 FROM sqlite_master WHERE name='image_reader_state'").get(), undefined)
  } finally { original.close() }
  source.close()
  assert.equal(JSON.parse(upgraded.prepare('SELECT value FROM settings WHERE key=?').get(APP_VERSION_KEY)!.value as string), '0.10.0')
  upgraded.close()
  upgraded = openUpgradedDatabase({ file, version: '0.10.0', targetSchema: 12, open, migrate })
  assert.equal(readSnapshotInventory(root).snapshots.length, 1, 'same version restart must not create another upgrade snapshot')
  const manual = createLibrarySnapshot(upgraded, { directory: root, version: '0.10.0', targetSchema: 12, reason: 'manual', open })
  assert.notEqual(manual.file, snapshot.file)
  upgraded.close()
  upgraded = openUpgradedDatabase({ file, version: '0.11.0', targetSchema: 12, open, migrate })
  assert.equal(readSnapshotInventory(root).snapshots.length, 3, 'an app upgrade with unchanged schema is protected')
  upgraded.close()
  const oldBytes = fs.readFileSync(file)
  assert.throws(() => openUpgradedDatabase({ file, version: '0.8.0', targetSchema: 11, open, migrate }), /更新|版本|结构/)
  assert.deepEqual(fs.readFileSync(file), oldBytes)
  let writeOpened = false
  const failingOpen = (file: string, readonly: boolean) => {
    if (!readonly) writeOpened = true
    const db = open(file, readonly), prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => { if (sql.startsWith('VACUUM')) throw new Error('injected snapshot failure'); return prepare(sql) }) as typeof db.prepare
    return db
  }
  assert.throws(() => openUpgradedDatabase({ file, version: '0.12.0', targetSchema: 12, open: failingOpen, migrate }), /snapshot failure/)
  assert.equal(writeOpened, false); assert.equal(migrationCalls, 1)
  assert.deepEqual(fs.readFileSync(file), oldBytes)
  assert.throws(() => openUpgradedDatabase({ file, version: '0.12.0', targetSchema: 12, open, migrate: () => { throw new Error('injected migration failure') } }), /migration failure/)
  const afterFailure = readSnapshotInventory(root).snapshots.length
  upgraded = openUpgradedDatabase({ file, version: '0.12.0', targetSchema: 12, open, migrate })
  assert.equal(readSnapshotInventory(root).snapshots.length, afterFailure + 1, 'failed migration retry must preserve the first original snapshot')
  upgraded.close()
  assert.equal(fs.readFileSync(path.join(root, 'baoyi.db.v0.11.0.bak'), 'utf8'), 'old backup sentinel')
  const freshDir = path.join(root, 'fresh'); fs.mkdirSync(freshDir)
  const fresh = openUpgradedDatabase({ file: path.join(freshDir, 'baoyi.db'), version: '0.10.0', targetSchema: 12, open, migrate }); fresh.close()
  assert.equal(readSnapshotInventory(freshDir).snapshots.length, 0)
  const corrupt = path.join(root, 'corrupt.db'); fs.writeFileSync(corrupt, 'not a database')
  assert.throws(() => openUpgradedDatabase({ file: corrupt, version: '0.10.0', targetSchema: 12, open, migrate }))
  assert.equal(fs.readFileSync(corrupt, 'utf8'), 'not a database')
  const emptyFile = path.join(root, 'empty.db'); open(emptyFile, false).close()
  const empty = openUpgradedDatabase({ file: emptyFile, version: '0.10.0', targetSchema: 12, open, migrate }); empty.close()
  const badSchema = open(file, false); badSchema.prepare('UPDATE settings SET value=? WHERE key=?').run('not-a-version', SCHEMA_KEY); badSchema.close()
  assert.throws(() => openUpgradedDatabase({ file, version: '0.13.0', targetSchema: 12, open, migrate }), /版本无效/)
  const legacy = open(file, false); legacy.prepare('DELETE FROM settings WHERE key=?').run(SCHEMA_KEY); legacy.close()
  upgraded = openUpgradedDatabase({ file, version: '0.13.0', targetSchema: 12, open, migrate }); upgraded.close()
  assert.equal(readSnapshotInventory(root).snapshots[0].fromSchema, 0, 'unversioned legacy database still requires a snapshot')
  let writable = false
  const checkedOpen = (file: string, readonly: boolean) => { if (!readonly) writable = true; return open(file, readonly) }
  const failCopyOpen = (file: string, readonly: boolean) => { if (file.includes('library-snapshots') && file.endsWith('.db')) throw new Error('injected verification failure'); return checkedOpen(file, readonly) }
  assert.throws(() => openUpgradedDatabase({ file, version: '0.14.0', targetSchema: 12, open: failCopyOpen, migrate }), /verification failure/)
  assert.equal(writable, false)
  const brokenFs = { ...fs, openSync: (file: fs.PathLike, flags: string) => { if (flags === 'wx') throw new Error('injected manifest failure'); return fs.openSync(file, flags) } }
  const loader = createRendererLoader({ 'node:fs': { ...brokenFs, default: brokenFs }, 'node:path': { ...path, default: path } }, { Buffer, Date })
  assert.throws(() => loader('electron/services/library-snapshots.ts').openUpgradedDatabase({ file, version: '0.14.0', targetSchema: 12, open: checkedOpen, migrate }), /manifest failure/)
  assert.equal(writable, false)
  fs.unlinkSync(path.join(inventory.directory, manual.file))
  assert.equal(readSnapshotInventory(root).snapshots.find(s => s.file === manual.file)?.state, 'missing')
  fs.writeFileSync(path.join(inventory.directory, 'bad.json'), '{')
  assert.ok(readSnapshotInventory(root).warnings.length > 0)
  const manifest = path.join(inventory.directory, snapshot.id + '.json')
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8')); metadata.file = '../baoyi.db'; fs.writeFileSync(manifest, JSON.stringify(metadata))
  assert.equal(readSnapshotInventory(root).snapshots.some(s => s.id === snapshot.id), false, 'manifest paths cannot escape the snapshot directory')
  console.log('PASS upgrade snapshots, WAL, verification ordering, failure safety, retries, version changes and inventory')
} finally { try { source.close() } catch { /* Already closed after the WAL check. */ } }
