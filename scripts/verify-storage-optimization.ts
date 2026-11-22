import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { readSnapshotInventory } from '../electron/services/storage/library-snapshots.ts'
import { migrateArtworkIntoLibrary } from '../electron/services/media/artwork-migration.ts'
import { archiveLibrarySnapshots, exportLibrarySnapshot } from '../electron/services/storage/snapshot-archive.ts'
import { readStorageUsage, clearBrowserCacheSessions } from '../electron/services/storage/storage-usage.ts'

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
function fixture() { return fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-storage-')) }
function snapshotFixture(root: string, createdAt: number, reason: 'upgrade' | 'manual' = 'upgrade') {
  const directory = path.join(root, 'library-snapshots'), id = `${createdAt}-${randomUUID()}`, file = id + '.db'
  fs.mkdirSync(directory, { recursive: true })
  const db = new DatabaseSync(path.join(directory, file))
  db.exec('CREATE TABLE records(value TEXT); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)')
  db.prepare('INSERT INTO records VALUES(?)').run('local data '.repeat(12000))
  db.close()
  const bytes = fs.readFileSync(path.join(directory, file))
  const item = { format: 'baoyi-database-snapshot' as const, version: 1 as const, id, file, createdAt, reason, fromSchema: 25, targetSchema: 25, fromVersion: '0.17.4', targetVersion: '0.17.5', size: bytes.length, sha256: digest(bytes) }
  fs.writeFileSync(path.join(directory, id + '.json'), JSON.stringify(item))
  return item
}

test('compressed snapshots stay discoverable with their original recovery identity', () => {
  const root = fixture(), directory = path.join(root, 'library-snapshots')
  try {
    fs.mkdirSync(directory)
    const original = Buffer.alloc(8192, 7), compressed = gzipSync(original)
    const id = `${Date.now()}-${randomUUID()}`
    const snapshot = { format: 'baoyi-database-snapshot', version: 1, id, file: id + '.db.gz', createdAt: Date.now(), reason: 'upgrade', fromSchema: 25, targetSchema: 25, fromVersion: '0.17.4', targetVersion: '0.17.5', size: original.length, sha256: digest(original), compression: 'gzip', storedSize: compressed.length }
    fs.writeFileSync(path.join(directory, snapshot.file), compressed)
    fs.writeFileSync(path.join(directory, id + '.json'), JSON.stringify(snapshot))
    const inventory = readSnapshotInventory(root)
    assert.equal(inventory.total, 1, 'compressed history must remain visible and recoverable')
    assert.equal(inventory.snapshots[0].state, 'available')
    assert.equal(inventory.snapshots[0].sha256, snapshot.sha256)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('startup keeps unreferenced artwork without traversing the media library', () => {
  const root = fixture(), db = new DatabaseSync(':memory:')
  const cache = path.join(root, 'posters'), library = path.join(root, 'library'), artwork = path.join(library, 'film', '.baoyi', 'artwork')
  try {
    fs.mkdirSync(cache, { recursive: true }); fs.mkdirSync(artwork, { recursive: true })
    const bytes = Buffer.alloc(128 * 1024, 5), source = path.join(cache, 'orphan.jpg')
    fs.writeFileSync(source, bytes); fs.writeFileSync(path.join(artwork, 'twin.jpg'), bytes)
    const options = { cacheDirs: [cache], fallbackDir: cache, recoveryRoot: root, scanRoots: [library], orphanStrategy: 'count' as const }
    const result = migrateArtworkIntoLibrary(db, options)
    assert.ok(fs.existsSync(source), 'startup must preserve the orphan and avoid deep deduplication')
    assert.equal(result.orphans, 1)
    assert.equal(result.removed, 0)
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('older upgrades compress losslessly, newest three and manual copies remain, repeated requests are safe', async () => {
  const root = fixture(), stamp = Date.now()
  try {
    const originals = Array.from({ length: 6 }, (_, i) => snapshotFixture(root, stamp + i))
    const manual = snapshotFixture(root, stamp - 10, 'manual')
    const [first, second] = await Promise.all([archiveLibrarySnapshots(root), archiveLibrarySnapshots(root)])
    assert.equal(first.archived, 3); assert.ok(first.reclaimedBytes > 300000); assert.deepEqual(first.warnings, [])
    assert.equal(second.archived, 0); assert.equal(second.reclaimedBytes, 0)
    const inventory = readSnapshotInventory(root)
    assert.equal(inventory.total, 7)
    assert.equal(inventory.snapshots.filter(item => item.compression === 'gzip').length, 3)
    for (const item of [...originals.slice(3), manual]) assert.ok(fs.existsSync(path.join(root, 'library-snapshots', item.file)))
    for (const item of originals) {
      const exported = await exportLibrarySnapshot(root, item.id, path.join(root, 'export-' + item.id + '.db'))
      assert.equal(digest(fs.readFileSync(exported.file)), item.sha256)
      const db = new DatabaseSync(exported.file, { readOnly: true })
      assert.equal(db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok')
      assert.equal((db.prepare('SELECT value FROM records').get() as { value: string }).value.length, 132000)
      db.close()
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('same-sized changed originals are retained and reported instead of compressed', async () => {
  const root = fixture(), stamp = Date.now()
  try {
    const older = snapshotFixture(root, stamp)
    snapshotFixture(root, stamp + 1)
    const original = path.join(root, 'library-snapshots', older.file), bytes = fs.readFileSync(original)
    bytes[bytes.length - 1] ^= 1; fs.writeFileSync(original, bytes)
    const result = await archiveLibrarySnapshots(root, 1)
    assert.equal(result.archived, 0); assert.equal(result.warnings.length, 1)
    assert.deepEqual(fs.readFileSync(original), bytes)
    assert.ok(!fs.existsSync(original + '.gz'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('archive publication and raw-duplicate interruptions can resume without losing a recovery point', async () => {
  const root = fixture(), stamp = Date.now()
  try {
    const older = snapshotFixture(root, stamp)
    snapshotFixture(root, stamp + 1)
    const original = path.join(root, 'library-snapshots', older.file), bytes = fs.readFileSync(original)
    fs.writeFileSync(original + '.gz', gzipSync(bytes))
    assert.equal((await archiveLibrarySnapshots(root, 1)).archived, 1)
    fs.writeFileSync(original, bytes)
    const resumed = await archiveLibrarySnapshots(root, 1)
    assert.equal(resumed.reclaimedBytes, bytes.length)
    assert.ok(!fs.existsSync(original))
    const exported = await exportLibrarySnapshot(root, older.id, path.join(root, 'recovered.db'))
    assert.equal(digest(fs.readFileSync(exported.file)), older.sha256)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('damaged gzip and existing export targets cannot destroy user files', async () => {
  const root = fixture(), stamp = Date.now()
  try {
    const older = snapshotFixture(root, stamp)
    snapshotFixture(root, stamp + 1)
    await archiveLibrarySnapshots(root, 1)
    const destination = path.join(root, 'user.db')
    fs.writeFileSync(destination, 'keep me')
    await assert.rejects(exportLibrarySnapshot(root, older.id, destination), /已存在/)
    assert.equal(fs.readFileSync(destination, 'utf8'), 'keep me')
    const gzip = path.join(root, 'library-snapshots', older.file + '.gz'), bytes = fs.readFileSync(gzip)
    bytes[bytes.length - 6] ^= 1; fs.writeFileSync(gzip, bytes)
    await assert.rejects(exportLibrarySnapshot(root, older.id, path.join(root, 'damaged.db')))
    assert.ok(!fs.existsSync(path.join(root, 'damaged.db')))
    assert.ok(!fs.readdirSync(root).some(name => name.endsWith('.tmp')))
    assert.ok(fs.existsSync(gzip))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('linked snapshot directories are rejected and out-of-directory manifest paths are ignored', async () => {
  const root = fixture(), external = fixture(), stamp = Date.now()
  try {
    const older = snapshotFixture(external, stamp)
    snapshotFixture(external, stamp + 1)
    fs.symlinkSync(path.join(external, 'library-snapshots'), path.join(root, 'library-snapshots'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(archiveLibrarySnapshots(root, 1), /不能是链接/)
    assert.ok(fs.existsSync(path.join(external, 'library-snapshots', older.file)))
    fs.writeFileSync(path.join(external, 'library-snapshots', older.id + '.json'), JSON.stringify({ ...older, file: '../outside.db' }))
    assert.equal(readSnapshotInventory(external).total, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(external, { recursive: true, force: true }) }
})

test('archiving includes older entries beyond the UI hundred-row window', async () => {
  const root = fixture(), stamp = Date.now()
  try {
    for (let i = 0; i < 103; i++) snapshotFixture(root, stamp + i)
    const result = await archiveLibrarySnapshots(root)
    assert.equal(result.archived, 100)
    assert.deepEqual(result.warnings, [])
    assert.equal(readSnapshotInventory(root, 1000).snapshots.length, 103)
    assert.equal(readSnapshotInventory(root).snapshots.length, 100)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('whole-profile usage includes caches and backups, and does not follow external directory links', async () => {
  const root = fixture(), external = fixture()
  try {
    const inputs = [
      ['baoyi.db', 111, 'database'], ['baoyi.db-wal', 13, 'database'], ['library-snapshots/old.db', 221, 'snapshots'],
      ['Cache/Cache_Data/cache', 33, 'browser-cache'], ['Partitions/hanime-network/Code Cache/js/cache', 44, 'browser-cache'],
      ['cache/novel-index/a', 25, 'derived-cache'], ['Partitions/hanime-network/Network/Cookies', 17, 'site-data'],
      ['posters/manual.jpg', 99, 'assets'], ['save-backups/game/save', 88, 'assets'], ['unknown.data', 7, 'other']
    ] as const
    for (const [relative, size] of inputs) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(size)) }
    fs.writeFileSync(path.join(external, 'user-media.bin'), Buffer.alloc(5000))
    fs.symlinkSync(external, path.join(root, 'external-library'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await readStorageUsage(root)
    assert.equal(result.totalBytes, inputs.reduce((total, entry) => total + entry[1], 0))
    assert.equal(result.files, inputs.length)
    for (const item of result.items) assert.equal(item.bytes, inputs.filter(entry => entry[2] === item.category).reduce((total, entry) => total + entry[1], 0), item.category)
    assert.ok(result.warnings.some(warning => warning.includes('external-library')))
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(external, { recursive: true, force: true }) }
})

test('cache cleanup reports partial failures and continues without requesting cookie or site-data deletion', async () => {
  const calls: string[] = [], make = (name: string, fail = false) => ({
    clearCache: async () => { calls.push(name + ':http'); if (fail) throw new Error('locked') },
    clearCodeCaches: async ({ urls }: { urls: string[] }) => { assert.deepEqual(urls, []); calls.push(name + ':code') },
    clearStorageData: async () => { throw new Error('site data must be preserved') }
  })
  const warnings = await clearBrowserCacheSessions([{ name: 'one', session: make('one', true) }, { name: 'two', session: make('two') }])
  assert.deepEqual(calls, ['one:http', 'one:code', 'two:http', 'two:code'])
  assert.equal(warnings.length, 1); assert.match(warnings[0], /one/)
})
