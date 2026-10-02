import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as schema from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
assert.match(fs.readFileSync('electron/main.ts', 'utf8'), /showErrorBox/, 'startup protection failure must be visible')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-startup-')), file = path.join(root, 'baoyi.db')
const initial = new DatabaseSync(file); schema.initSchema(initial, KINDS); initial.prepare('UPDATE settings SET value=? WHERE key=?').run('11', schema.SCHEMA_KEY); initial.close()
let fail = true, calls = 0
class TestDatabase extends DatabaseSync {
  constructor(file: string, options?: { readonly?: boolean }) { super(file, { readOnly: options?.readonly }) }
  pragma(sql: string) { this.exec('PRAGMA ' + sql) }
}
const schemaMock = { ...schema, initSchema: (db: schema.SqlDb, kinds: typeof KINDS) => { calls++; if (fail) throw new Error('schema initialization failure'); schema.initSchema(db, kinds) } }
const loader = createRendererLoader({
  'better-sqlite3': { default: TestDatabase }, electron: { app: { getPath: () => root, getVersion: () => '0.10.0', getAppPath: () => root, commandLine: { hasSwitch: () => true } } },
  'node:fs': { ...fs, default: fs }, 'node:path': { ...path, default: path },
  './schema': schemaMock, './schema.ts': schema, '../kinds': { KINDS },
  './activity': { readExternalActiveAt: () => 0 }, '../kinds/software/organize/plan': { rebase: () => '' },
  './taxonomy': { FALLBACK_CATEGORY: 'Other' }, './library-backup.ts': { buildLibraryBackup: () => ({}) },
  '../kinds/video/download/jobs.ts': { VIDEO_JOBS_SQL },
  './poster-storage.ts': { migratePosterStorage: () => ({ removed: 0, updated: 0, warnings: [] }), resolvePosterDirectory: () => root },
  './artwork-migration.ts': { migrateArtworkIntoLibrary: () => ({ moved: 0, relinked: 0, removed: 0, warnings: [] }) },
  '../kinds/video/catalogue.ts': { pruneStrayPlaceholders: () => 0 }, './portable': { isPortable: () => false }
}, { Buffer, Date, process })
const database = loader('electron/services/database.ts')
assert.throws(() => database.getDb(), /initialization failure/)
fail = false
assert.ok(database.getDb().prepare('SELECT 1 FROM settings').get()); assert.equal(calls, 2, 'failed initialization must not leave a cached half-initialized connection')
database.closeDb()

for (const primary of [true, false]) {
  const events: string[] = [], messages: string[] = []
  const app = {
    commandLine: { appendSwitch: () => {} }, requestSingleInstanceLock: () => { events.push('lock'); return primary },
    whenReady: () => Promise.resolve(), on: () => {}, quit: () => events.push('quit'), exit: (code: number) => events.push('exit:' + code),
    getPath: () => root
  }
  const loadMain = createRendererLoader({
    electron: { app, BrowserWindow: class { constructor() { events.push('window') } static getAllWindows() { return [] } }, dialog: { showErrorBox: (_title: string, detail: string) => messages.push(detail) }, protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} }, net: {}, shell: {} },
    'node:fs': { ...fs, default: fs }, 'node:path': { ...path, default: path },
    './ipc/handlers': { registerIpcHandlers: () => events.push('ipc') }, './kinds/game/service': { finalizeGameSessions: () => events.push('finalize') },
    './services/database': { getSettings: () => { events.push('read'); throw new Error('protection failed') }, interruptRunningTasks: () => { events.push('interrupt') }, closeDb: () => events.push('close') },
    './services/poster-protocol': {}, './services/portable': { initPortable: () => {} }, './services/proxy': { initProxy: () => {}, setHanimeHostsEnabled: () => {} },
    './services/hanime-network-rules': { pickStartupIp: () => '127.0.0.1', buildHanimeHostResolverRules: () => '', HANIME_HOSTS: [] },
    './services/timing.ts': { startHeartbeat: () => {} }, './kinds/image/protocol.ts': {}
  }, { process, __dirname: path.resolve('dist-electron'), Promise })
  loadMain('electron/main.ts'); await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(events[0], 'lock', 'instance lock must precede any upgrade/database initialization')
  if (primary) { assert.ok(messages.some(s => s.includes('protection failed'))); assert.ok(events.includes('exit:1')); assert.ok(!events.includes('window')); assert.ok(!events.includes('interrupt')) }
  else { assert.ok(events.includes('quit')); assert.ok(!events.includes('read')); assert.deepEqual(messages, []) }
}
console.log('PASS singleton retry, instance lock ordering and visible fail-closed startup')
