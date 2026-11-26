import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, SCHEMA_KEY, SCHEMA_VERSION } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { bindKeyVault } from '../electron/services/storage/setting-keys.ts'
import { exportLibrarySnapshot } from '../electron/services/storage/snapshot-archive.ts'
assert.ok(fs.existsSync('electron/services/storage/library-snapshots.ts'), 'verified pre-upgrade protection service is required')
const { openUpgradedDatabase, readSnapshotInventory, createLibrarySnapshot, APP_VERSION_KEY } = await import('../electron/services/storage/library-snapshots.ts')
const root = fs.mkdtempSync(path.join(os.tmpdir(), "baoyi-upgrade-'")), file = path.join(root, 'baoyi.db')
const open = (file: string, readonly: boolean) => new DatabaseSync(file, { readOnly: readonly })
const migrate = (db: DatabaseSync) => { db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON'); initSchema(db, KINDS) }
let source = open(file, false)
source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); initSchema(source, KINDS)
source.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(SCHEMA_KEY, '11')
source.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('wal-sentinel', 'committed-in-wal')
source.exec('DROP TABLE image_bookmarks; DROP TABLE image_reader_state; DROP TABLE image_collection_members; DROP TABLE image_collections')
fs.writeFileSync(path.join(root, 'baoyi.db.v0.11.0.bak'), 'old backup sentinel')
try {
  let migrationCalls = 0
  let upgraded = openUpgradedDatabase({ file, version: '0.10.0', targetSchema: SCHEMA_VERSION, open, migrate: db => { migrationCalls++; migrate(db) } })
  const inventory = readSnapshotInventory(root)
  assert.equal(inventory.snapshots.length, 1); assert.equal(inventory.legacyBackups, 1)
  const snapshot = inventory.snapshots[0]
  assert.equal(snapshot.fromSchema, 11); assert.equal(snapshot.targetSchema, SCHEMA_VERSION); assert.equal(snapshot.fromVersion, '')
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
  upgraded = openUpgradedDatabase({ file, version: '0.10.0', targetSchema: SCHEMA_VERSION, open, migrate })
  assert.equal(readSnapshotInventory(root).snapshots.length, 1, 'same version restart must not create another upgrade snapshot')
  const manual = createLibrarySnapshot(upgraded, { directory: root, version: '0.10.0', targetSchema: SCHEMA_VERSION, reason: 'manual', open })
  assert.notEqual(manual.file, snapshot.file)
  upgraded.close()
  upgraded = openUpgradedDatabase({ file, version: '0.11.0', targetSchema: SCHEMA_VERSION, open, migrate })
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
  assert.throws(() => openUpgradedDatabase({ file, version: '0.12.0', targetSchema: SCHEMA_VERSION, open: failingOpen, migrate }), /snapshot failure/)
  assert.equal(writeOpened, false); assert.equal(migrationCalls, 1)
  assert.deepEqual(fs.readFileSync(file), oldBytes)
  assert.throws(() => openUpgradedDatabase({ file, version: '0.12.0', targetSchema: SCHEMA_VERSION, open, migrate: () => { throw new Error('injected migration failure') } }), /migration failure/)
  const afterFailure = readSnapshotInventory(root).snapshots.length
  upgraded = openUpgradedDatabase({ file, version: '0.12.0', targetSchema: SCHEMA_VERSION, open, migrate })
  assert.equal(readSnapshotInventory(root).snapshots.length, afterFailure + 1, 'failed migration retry must preserve the first original snapshot')
  upgraded.close()
  assert.equal(fs.readFileSync(path.join(root, 'baoyi.db.v0.11.0.bak'), 'utf8'), 'old backup sentinel')
  const freshDir = path.join(root, 'fresh'); fs.mkdirSync(freshDir)
  const fresh = openUpgradedDatabase({ file: path.join(freshDir, 'baoyi.db'), version: '0.10.0', targetSchema: SCHEMA_VERSION, open, migrate }); fresh.close()
  assert.equal(readSnapshotInventory(freshDir).snapshots.length, 0)
  const corrupt = path.join(root, 'corrupt.db'); fs.writeFileSync(corrupt, 'not a database')
  assert.throws(() => openUpgradedDatabase({ file: corrupt, version: '0.10.0', targetSchema: SCHEMA_VERSION, open, migrate }))
  assert.equal(fs.readFileSync(corrupt, 'utf8'), 'not a database')
  const emptyFile = path.join(root, 'empty.db'); open(emptyFile, false).close()
  const empty = openUpgradedDatabase({ file: emptyFile, version: '0.10.0', targetSchema: SCHEMA_VERSION, open, migrate }); empty.close()
  const badSchema = open(file, false); badSchema.prepare('UPDATE settings SET value=? WHERE key=?').run('not-a-version', SCHEMA_KEY); badSchema.close()
  assert.throws(() => openUpgradedDatabase({ file, version: '0.13.0', targetSchema: SCHEMA_VERSION, open, migrate }), /版本无效/)
  const legacy = open(file, false); legacy.prepare('DELETE FROM settings WHERE key=?').run(SCHEMA_KEY); legacy.close()
  upgraded = openUpgradedDatabase({ file, version: '0.13.0', targetSchema: SCHEMA_VERSION, open, migrate }); upgraded.close()
  assert.equal(readSnapshotInventory(root).snapshots[0].fromSchema, 0, 'unversioned legacy database still requires a snapshot')
  let writable = false
  const checkedOpen = (file: string, readonly: boolean) => { if (!readonly) writable = true; return open(file, readonly) }
  const failCopyOpen = (file: string, readonly: boolean) => { if (file.includes('library-snapshots') && file.endsWith('.db')) throw new Error('injected verification failure'); return checkedOpen(file, readonly) }
  assert.throws(() => openUpgradedDatabase({ file, version: '0.14.0', targetSchema: SCHEMA_VERSION, open: failCopyOpen, migrate }), /verification failure/)
  assert.equal(writable, false)
  const brokenFs = { ...fs, openSync: (file: fs.PathLike, flags: string) => { if (flags === 'wx') throw new Error('injected manifest failure'); return fs.openSync(file, flags) } }
  const loader = createRendererLoader({ 'node:fs': { ...brokenFs, default: brokenFs }, 'node:path': { ...path, default: path } }, { Buffer, Date })
  assert.throws(() => loader('electron/services/storage/library-snapshots.ts').openUpgradedDatabase({ file, version: '0.14.0', targetSchema: SCHEMA_VERSION, open: checkedOpen, migrate }), /manifest failure/)
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

// Historical boundaries: v31 splits legacy game notes, v32 encrypts settings,
// and v33 adds media indexes. Each case uses its own on-disk WAL database.
const vault = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from('test-only:' + text),
  decryptString: (bytes: Buffer) => bytes.toString().slice('test-only:'.length)
}
const migrateCurrent = (db: DatabaseSync) => {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON')
  bindKeyVault(db, vault)
  initSchema(db, KINDS)
}
const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
for (const from of [15, 18, 24, 30, 31, 32]) {
  const directory = path.join(root, 'from-' + from)
  fs.mkdirSync(directory)
  const file = path.join(directory, 'baoyi.db'), before = open(file, false)
  let beforeClosed = false
  try {
    before.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON')
    initSchema(before, KINDS)
    before.prepare('UPDATE settings SET value=? WHERE key=?').run(String(from), SCHEMA_KEY)
    before.prepare('INSERT INTO categories(id,kind,name,sort_order) VALUES(?,?,?,?)').run('custom-kept', 'game', '用户合成分类', 77)
    before.prepare('INSERT INTO tags(kind,name,source,created_at) VALUES(?,?,?,?)').run('game', '用户合成标签', 'confirmed', 1)
    before.prepare("DELETE FROM tags WHERE kind='game' AND source='user'").run()
    for (const [id, kind, note] of [
      ['legacy', 'game', '第一行\n第二行 😀'], ['blank', 'game', '   '],
      ['existing', 'game', '旧文本保留'], ['software', 'software', '软件备注保留']
    ]) {
      before.prepare('INSERT INTO resource(id,kind,path,file_name,name_zh,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,10,20)')
        .run(id, kind, path.join(directory, id), id, id, note)
      before.prepare(`INSERT INTO ${kind}_meta(resource_id) VALUES(?)`).run(id)
    }
    if (from < 31) before.exec('DROP TABLE game_notes')
    else before.prepare('INSERT INTO game_notes(id,resource_id,title,body,sort,created_at,updated_at) VALUES(?,?,?,?,0,10,20)')
      .run('existing-note', 'existing', '新笔记', '已由用户编辑')
    const originalResources = rows(before, 'resource'), originalCategories = rows(before, 'categories'), originalTags = rows(before, 'tags')
    const keyValue = JSON.stringify({ api_key: 'synthetic-api-key', enabled: true, model: 'fixture' })
    if (from < 32) before.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('ai', keyValue)
    // Capture while the writer is open: committed WAL pages must be included.
    const current = openUpgradedDatabase({ file, version: '0.20.3', targetSchema: SCHEMA_VERSION, open, migrate: migrateCurrent })
    const inventory = readSnapshotInventory(directory)
    assert.equal(inventory.total, 1)
    const snapshot = open(path.join(inventory.directory, inventory.snapshots[0].file), true)
    try {
      assert.equal(snapshot.prepare('SELECT value FROM settings WHERE key=?').get(SCHEMA_KEY)!.value, String(from))
      assert.deepEqual(rows(snapshot, 'resource'), originalResources)
      if (from < 31) assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='game_notes'").get(), undefined)
    } finally { snapshot.close() }
    try {
      assert.equal(current.prepare('SELECT value FROM settings WHERE key=?').get(SCHEMA_KEY)!.value, String(SCHEMA_VERSION))
      assert.deepEqual(rows(current, 'resource'), originalResources)
      assert.deepEqual(rows(current, 'categories'), originalCategories)
      assert.deepEqual(rows(current, 'tags'), originalTags, 'upgrades must not recreate user-deleted tags')
      const notes = rows(current, 'game_notes')
      if (from < 31) {
        assert.deepEqual(notes.map(n => n.resource_id).sort(), ['existing', 'legacy'])
        const note = notes.find(n => n.resource_id === 'legacy')!
        assert.equal(note.body, '第一行\n第二行 😀'); assert.equal(note.created_at, 10); assert.equal(note.updated_at, 20)
      } else assert.deepEqual(notes.map(n => n.body), ['已由用户编辑'], 'v31+ must not recreate intentionally deleted legacy notes')
      if (from < 32) {
        const secured = JSON.parse(current.prepare('SELECT value FROM settings WHERE key=?').get('ai')!.value as string)
        assert.ok(secured.api_key.safeStorageV1)
        assert.equal(vault.decryptString(Buffer.from(secured.api_key.safeStorageV1, 'base64')), 'synthetic-api-key')
        assert.equal(secured.model, 'fixture')
      }
      assert.equal(Object.values(current.prepare('PRAGMA integrity_check').get()!)[0], 'ok')
      assert.deepEqual(current.prepare('PRAGMA foreign_key_check').all(), [])
      migrateCurrent(current)
      assert.deepEqual(rows(current, 'game_notes'), notes, 'migration restart must be idempotent')
    } finally { current.close() }
    before.close()
    beforeClosed = true
    const restarted = openUpgradedDatabase({ file, version: '0.20.3', targetSchema: SCHEMA_VERSION, open, migrate: migrateCurrent })
    restarted.close()
    assert.equal(readSnapshotInventory(directory).total, 1, 'successful restart must not create another snapshot')
    // Export the real upgrade snapshot and reopen it as a separate rollback profile.
    const restored = path.join(directory, 'rollback.db')
    await exportLibrarySnapshot(directory, inventory.snapshots[0].id, restored)
    const rollback = open(restored, true)
    try {
      assert.deepEqual(rows(rollback, 'resource'), originalResources)
      assert.equal(rollback.prepare('SELECT value FROM settings WHERE key=?').get(SCHEMA_KEY)!.value, String(from))
      assert.deepEqual(rollback.prepare('PRAGMA foreign_key_check').all(), [])
    } finally { rollback.close() }
    console.log(`PASS schema ${from} -> ${SCHEMA_VERSION}: WAL snapshot, metadata, notes, settings, restart and rollback export`)
  } finally { if (!beforeClosed) before.close() }
}

// Failure after a committed write must leave an intact pre-upgrade recovery point.
{
  const directory = path.join(root, 'partial-failure'); fs.mkdirSync(directory)
  const file = path.join(directory, 'baoyi.db'), original = open(file, false)
  initSchema(original, KINDS)
  original.prepare('UPDATE settings SET value=? WHERE key=?').run('30', SCHEMA_KEY)
  original.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('sentinel', 'original')
  original.close()
  let failedDb: DatabaseSync | undefined
  assert.throws(() => openUpgradedDatabase({ file, version: '0.20.3', targetSchema: SCHEMA_VERSION, open, migrate: db => {
    failedDb = db
    db.prepare('UPDATE settings SET value=? WHERE key=?').run('partially changed', 'sentinel')
    throw new Error('injected failure after write')
  } }), /failure after write/)
  assert.throws(() => failedDb!.prepare('SELECT 1'), /not open|closed/, 'failed connection must be closed')
  const snapshot = readSnapshotInventory(directory).snapshots[0]
  const restoreFile = path.join(directory, 'rollback.db')
  await exportLibrarySnapshot(directory, snapshot.id, restoreFile)
  const restored = open(restoreFile, true)
  try {
    assert.equal(restored.prepare('SELECT value FROM settings WHERE key=?').get('sentinel')!.value, 'original')
    assert.equal(restored.prepare('SELECT value FROM settings WHERE key=?').get(SCHEMA_KEY)!.value, '30')
    assert.equal(restored.prepare('SELECT value FROM settings WHERE key=?').get(APP_VERSION_KEY), undefined)
  } finally { restored.close() }
  const retried = openUpgradedDatabase({ file: restoreFile, version: '0.20.3', targetSchema: SCHEMA_VERSION, open, migrate: migrateCurrent })
  assert.equal(retried.prepare('SELECT value FROM settings WHERE key=?').get('sentinel')!.value, 'original')
  retried.close()
  console.log('PASS failed-write snapshot recovery and migration retry')
}
