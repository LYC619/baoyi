import assert from 'node:assert/strict'
import * as Vue from 'vue'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as schema from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { QuitCoordinator, stopServices } from '../electron/services/system/lifecycle.ts'
import { IpcActivity } from '../electron/ipc/main-window.ts'

{
  const log:string[]=[], event={preventDefault:()=>log.push('prevent')}
  const activity=new IpcActivity()
  let confirm!:(yes:boolean)=>void, release!:()=>void, fail=true
  const pending=activity.run(()=>new Promise<void>(resolve=>{release=()=>{log.push('work done');resolve()}}))
  const quit=new QuitCoordinator({confirm:()=>new Promise(resolve=>{log.push('confirm');confirm=resolve}),
    stop:()=>stopServices(()=>{log.push('stop');return activity.stop()},()=>{if(fail)throw Error('cannot stop')}),
    quit:()=>log.push('finalize','close'),failed:()=>log.push('failed')})
  const first=quit.beforeQuit(event);await quit.beforeQuit(event);confirm(false);await first
  assert.deepEqual(log,['prevent','confirm','prevent']);assert.equal(activity.unavailable,false)
  await activity.run(()=>log.push('still running'))
  const next=quit.beforeQuit(event);confirm(true);await new Promise(resolve=>setImmediate(resolve));await quit.beforeQuit(event)
  assert.equal(activity.unavailable,true);await assert.rejects(activity.run(()=>log.push('late IPC')))
  assert.ok(!log.includes('finalize')&&!log.includes('failed'));release();await Promise.all([pending,next])
  assert.deepEqual(log.slice(-2),['work done','failed']);assert.ok(!log.includes('close'))
  fail=false;await quit.beforeQuit(event);assert.deepEqual(log.slice(-2),['finalize','close']);assert.equal(log.filter(v=>v==='confirm').length,2)
  const count=log.length;await quit.beforeQuit(event);assert.equal(log.length,count)
  console.log('PASS cancelled, repeated, slow and failed shutdown; safe retry and late IPC rejection')
}
{
  const activity=new IpcActivity();let release!:()=>void
  const slow=()=>new Promise<void>(resolve=>{release=resolve})
  const read=activity.run(slow);await assert.rejects(activity.run(()=>activity.reset(slow)),/操作正在进行/);release();await read
  const reset=activity.run(()=>activity.reset(slow));await assert.rejects(activity.run(()=>activity.reset(slow)),/重置/)
  await assert.rejects(activity.run(()=>true),/重置/);release();await reset;assert.equal(await activity.run(()=>true),true)
}
assert.match(fs.readFileSync('electron/main.ts', 'utf8'), /showErrorBox/, 'startup protection failure must be visible')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-startup-')), file = path.join(root, 'baoyi.db')
const initial = new DatabaseSync(file); schema.initSchema(initial, KINDS); initial.prepare('UPDATE settings SET value=? WHERE key=?').run('11', schema.SCHEMA_KEY); initial.close()
let fail = true, calls = 0, startupOrphanStrategy = ''
class TestDatabase extends DatabaseSync {
  constructor(file: string, options?: { readonly?: boolean }) { super(file, { readOnly: options?.readonly }) }
  pragma(sql: string) { this.exec('PRAGMA ' + sql) }
}
const schemaMock = { ...schema, initSchema: (db: schema.SqlDb, kinds: typeof KINDS) => { calls++; if (fail) throw new Error('schema initialization failure'); schema.initSchema(db, kinds) } }
const loader = createRendererLoader({
  'better-sqlite3': { default: TestDatabase }, electron: { app: { getPath: () => root, getVersion: () => '0.10.0', getAppPath: () => root, commandLine: { hasSwitch: () => true } } },
  'node:fs': { ...fs, default: fs }, 'node:path': { ...path, default: path },
  './schema.ts': schemaMock, '../../kinds/index.ts': { KINDS },
  './activity': { readExternalActiveAt: () => 0 }, '../../kinds/software/organize/plan': { rebase: () => '' },
  '../taxonomy/taxonomy': { FALLBACK_CATEGORY: 'Other' }, './library-backup.ts': { buildLibraryBackup: () => ({}) },
  '../../kinds/video/download/jobs.ts': { VIDEO_JOBS_SQL },
  '../media/poster-storage.ts': { migratePosterStorage: () => ({ removed: 0, updated: 0, warnings: [] }), resolvePosterDirectory: () => root },
  '../media/artwork-migration.ts': { migrateArtworkIntoLibrary: (_db: unknown, options: { orphanStrategy?: string }) => { startupOrphanStrategy = options.orphanStrategy || ''; return { moved: 0, relinked: 0, removed: 0, warnings: [] } } },
  '../../kinds/video/catalogue.ts': { pruneStrayPlaceholders: () => 0 }, './portable.ts': { isPortable: () => false }
}, { Buffer, Date, process })
const database = loader('electron/services/storage/database.ts')
assert.throws(() => database.getDb(), /initialization failure/)
fail = false
assert.ok(database.getDb().prepare('SELECT 1 FROM settings').get()); assert.equal(calls, 2, 'failed initialization must not leave a cached half-initialized connection')
assert.equal(startupOrphanStrategy, 'count', 'the actual startup path must defer media-library deduplication')
database.closeDb()

for (const primary of [true, false]) {
  const events: string[] = [], messages: string[] = []
  const app = {
    commandLine: { appendSwitch: () => {} }, requestSingleInstanceLock: () => { events.push('lock'); return primary },
    whenReady: () => Promise.resolve(), on: () => {}, quit: () => events.push('quit'), exit: (code: number) => events.push('exit:' + code),
    getPath: () => root, getPreferredSystemLanguages: () => ['zh-CN']
  }
  const loadMain = createRendererLoader({
    electron: { app, BrowserWindow: class { constructor() { events.push('window') } static getAllWindows() { return [] } }, dialog: { showErrorBox: (_title: string, detail: string) => messages.push(detail) }, protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} }, net: {}, shell: {} },
    'node:fs': { ...fs, default: fs }, 'node:path': { ...path, default: path },
    './ipc/handlers': { registerIpcHandlers: () => events.push('ipc') }, './kinds/game/service': { finalizeGameSessions: () => events.push('finalize') },
    './services/storage/database': { closeDb: () => events.push('close'), getDb: () => ({}), readStartupNetworkSettings: () => {events.push('read');throw new Error('protection failed')} },
    './services/storage/settings-store.ts': { getSettings: () => { events.push('read'); throw new Error('protection failed') } },
    './services/storage/task-records.ts': { interruptRunningTasks: () => { events.push('interrupt') } },
    './services/media/poster-protocol': {}, './services/storage/portable': { initPortable: () => {} }, './services/network/proxy': { initProxy: () => {}, setHanimeHostsEnabled: () => {} },
    './services/hanime/hanime-network-rules': { pickStartupIp: () => '127.0.0.1', buildHanimeHostResolverRules: () => '', HANIME_HOSTS: [] },
    './services/system/timing.ts': { startHeartbeat: () => {} }, './kinds/image/protocol.ts': {}
    ,'./ipc/music.ts': {}, './ipc/video-preview.ts': {}, './kinds/image/folder-sync.ts': {}
    ,'./kinds/image/thumbnails.ts': { closeImageThumbnails: async () => {} }
  }, { process, __dirname: path.resolve('dist-electron'), Promise })
  loadMain('electron/main.ts'); await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(events[0], 'lock', 'instance lock must precede any upgrade/database initialization')
  if (primary) { assert.ok(messages.some(s => s.includes('protection failed'))); assert.ok(events.includes('exit:1')); assert.ok(!events.includes('window')); assert.ok(!events.includes('interrupt')) }
  else { assert.ok(events.includes('quit')); assert.ok(!events.includes('read')); assert.deepEqual(messages, []) }
}
{
  const messages: string[] = [], logged: unknown[] = []
  const listeners = new Map<string, (event: { reason: unknown }) => void>()
  let now = 10000
  const app = { config: { globalProperties: {}, errorHandler: undefined as undefined | ((error: unknown) => void) }, use() {}, mount() {} }
  const loadRenderer = createRendererLoader({
    vue: { ...Vue, createApp: () => app }, pinia: { createPinia: () => ({}) },
    './router': { default: { isReady: async () => {} } },
    './boot-error': { showBootError: (error: unknown) => { throw error } },
    './stores/categories': { useCategoriesStore: () => ({ load: async () => {} }) },
    './stores/settings': { useSettingsStore: () => ({ settings: {}, load: async () => {} }) },
    './stores/video': {}, './composables/useVideoWorkflow': {}, './composables/useVideoDiscovery': {},
    './composables/useToast': { useToast: () => ({ error: (message: string) => messages.push(message) }) },
    './styles/global.scss': {}
  }, {
    window: { baoyi: { video: {} }, addEventListener: (name: string, listener: (event: { reason: unknown }) => void) => listeners.set(name, listener) },
    Date: { now: () => now }, console: { error: (error: unknown) => logged.push(error) }
  })
  loadRenderer('src/main.ts')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(typeof app.config.errorHandler, 'function', 'Vue runtime errors must reach the shared reporter')
  assert.ok(listeners.has('unhandledrejection'), 'unhandled async errors must reach the same reporter')
  app.config.errorHandler!(new Error('网络读取失败'))
  now += 1000; listeners.get('unhandledrejection')!({ reason: '另一项失败' })
  now += 1999; listeners.get('unhandledrejection')!({ reason: new Error('网络读取失败') })
  assert.deepEqual(messages, ['网络读取失败', '另一项失败'], 'different messages must not defeat duplicate suppression')
  now += 1; app.config.errorHandler!(new Error('网络读取失败'))
  assert.deepEqual(messages, ['网络读取失败', '另一项失败', '网络读取失败'], 'the same failure can be shown again after 3 seconds')
  assert.equal(logged.length, 4, 'suppressed notifications still retain all console errors')
}
console.log('PASS singleton retry, startup ordering and global error notifications with shared deduplication')
