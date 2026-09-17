import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPinia } from 'pinia'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import * as videoDb from '../electron/kinds/video/db.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'

let passed = 0, failed = 0
async function test(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log('PASS ' + name) }
  catch (cause) { failed++; console.error('FAIL ' + name + ': ' + (cause instanceof Error ? cause.stack : String(cause))) }
}
function serviceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-background-core-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
  const file = (name: string) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'synthetic media'); return target }
  const work = (title: string, files: string[]) => registerVideoContent(db, { title,
    ...(!files.some(Boolean) ? { directory: path.dirname(file(title + '/.keep')) } : {}),
    items: files.map((file, index) => ({ title: `${title} E${index + 1}`, order: index + 1, files: file ? [{ path: file }] : [] })) }).resourceId
  let syncReads = 0
  const imageReads: string[] = []
  const io = { ...fs }
  ;(io as any).promises = { ...fs.promises, readFile: async (...args: any[]) => {
    imageReads.push(String(args[0])); return (fs.promises.readFile as any)(...args)
  } }
  for (const method of ['statSync', 'lstatSync', 'existsSync', 'readFileSync'] as const) (io as any)[method] = (...args: any[]) => { syncReads++; return (fs[method] as any)(...args) }
  const load = createRendererLoader({
    'node:fs': { ...io, default: io }, 'node:path': { ...path, default: path },
    electron: { app: { getPath: () => root }, net: {}, shell: {} },
    '../../services/database.ts': { getDb: () => db, getSettings: () => ({ hide_hentai: false, ai: {}, search: {}, tmdb: {} }),
      listCategories: () => [], tagPool: () => [], saveIdentifyLog: () => {}, postersDir: () => path.join(root, 'posters') },
    './db.ts': videoDb, './tmdb.ts': {}, './hentai/hanime.ts': {}, './mediainfo.ts': {}, '../../services/searchService.ts': {}, './tools.ts': {}, '../../services/agent/loop.ts': {}
  }, { Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout })
  const service = load('electron/kinds/video/service.ts') as typeof import('../electron/kinds/video/service.ts')
  return { root, db, file, work, service, imageReads, syncReads: () => syncReads }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
function storeFixture() {
  const calls: { query: any; request: ReturnType<typeof deferred<any[]>> }[] = []
  const counts: ReturnType<typeof deferred<any>>[] = [], errors: string[] = []
  const load = createRendererLoader({ '@/composables/useToast': { useToast: () => ({ error: (text: string) => errors.push(text) }) } }, {
    window: { baoyi: { video: { list: (query: unknown) => { const request = deferred<any[]>(); calls.push({ query, request }); return request.promise },
      counts: () => { const request = deferred<any>(); counts.push(request); return request.promise } } } }, setTimeout, clearTimeout
  })
  const store = load('src/stores/video.ts').useVideoStore(createPinia())
  return { store, calls, counts, errors }
}

await test('listing 137 works is read-only and performs no synchronous file checks', async () => {
  const f = serviceFixture()
  try {
    for (let index = 0; index < 137; index++) f.work('Work ' + index, [f.file(`Library/${index}.mp4`)])
    const before = f.db.prepare('SELECT total_changes() AS n').get()!.n
    const items = await f.service.listVideoItems()
    assert.equal(items.length, 137); assert.ok(items.every(item => item.available_files === 1 && item.episode_total === 1))
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before, 'merely refreshing cards must not rewrite asset records')
    assert.equal(f.syncReads(), 0, 'media availability must be checked without blocking the main thread')
  } finally { f.db.close() }
})

await test('asynchronous list checks preserve missing-file filters and exclude unregistered catalogue entries', async () => {
  const f = serviceFixture()
  try {
    const one = f.work('One', [f.file('One.mp4')]), missingFile = f.file('Missing.mp4'), two = f.work('Two', [missingFile])
    const three = f.work('Catalogue', [''])
    f.db.prepare("UPDATE episode SET watch_status='watched' WHERE resource_id=?").run(one)
    fs.unlinkSync(missingFile)
    const available = await f.service.listVideoItems({ local: 'available' }), missing = await f.service.listVideoItems({ local: 'missing' })
    assert.deepEqual(Array.from(available, item => item.id), [one]); assert.equal(available[0].episode_watched, 1)
    assert.deepEqual(Array.from(missing, item => item.id), [two]); assert.equal(missing[0].episode_total, 1)
    assert.ok(missing[0].pending_reasons?.includes('files'))
    const undownloaded = await f.service.listVideoItems({ local: 'none' })
    assert.deepEqual(Array.from(undownloaded, item => item.id).sort(), [two, three].sort())
    assert.equal(undownloaded.find(item => item.id === three)?.episode_total, 0)
  } finally { f.db.close() }
})

await test('legacy movies keep availability without creating episode or asset rows on a list read', async () => {
  const f = serviceFixture()
  try {
    const id = f.work('Legacy', [f.file('Legacy.mp4')])
    f.db.prepare('DELETE FROM video_episode_assets WHERE episode_id IN (SELECT id FROM episode WHERE resource_id=?)').run(id)
    f.db.prepare('DELETE FROM episode WHERE resource_id=?').run(id)
    f.db.prepare('DELETE FROM video_assets WHERE resource_id=?').run(id)
    f.db.prepare("UPDATE video_meta SET video_type='movie',hanime_id='123456' WHERE resource_id=?").run(id)
    const before = f.db.prepare('SELECT total_changes() AS n').get()!.n
    const [item] = await f.service.listVideoItems()
    assert.equal(item.available_files, 1); assert.equal(item.episode_total, 1)
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before)
  } finally { f.db.close() }
})

await test('multiple video qualities count as one episode and poster-only entries remain unregistered', async () => {
  const f = serviceFixture()
  try {
    registerVideoContent(f.db, { title: 'Multiple qualities', items: [
      { title: 'Recorded episode', order: 1, files: [{ path: f.file('720.mp4') }, { path: f.file('1080.mp4') }] },
      { title: 'Unregistered catalogue episode', order: 2, files: [], attachments: [{ path: f.file('poster.png'), role: 'poster' }] }
    ] })
    const [item] = await f.service.listVideoItems()
    assert.equal(item.available_files, 2); assert.equal(item.episode_total, 1); assert.equal(item.episode_present, 1)
  } finally { f.db.close() }
})

await test('unchanged artwork is cached and removing its cache regenerates it asynchronously', async () => {
  const f = serviceFixture()
  try {
    const id = f.work('Artwork', [f.file('Artwork.mp4')]), source = f.file('Library/poster.png')
    f.db.prepare('UPDATE video_meta SET poster_path=? WHERE resource_id=?').run(source, id)
    const [first] = await f.service.listVideoItems(), [second] = await f.service.listVideoItems()
    assert.notEqual(first.poster_path, source); assert.equal(first.poster_path, second.poster_path)
    assert.equal(f.imageReads.filter(file => file === source).length, 1)
    assert.ok(!second.pending_reasons?.includes('poster')); assert.equal(f.syncReads(), 0)
    fs.unlinkSync(second.poster_path)
    const [third] = await f.service.listVideoItems()
    assert.equal(third.poster_path, second.poster_path); assert.ok(fs.existsSync(third.poster_path))
    assert.equal(f.imageReads.filter(file => file === source).length, 2)
  } finally { f.db.close() }
})

await test('40 simultaneous reloads share one list and one counts request', async () => {
  const f = storeFixture(), waiting = Array.from({ length: 40 }, () => f.store.reload())
  await flush()
  assert.equal(f.calls.length, 1); assert.equal(f.counts.length, 1)
  f.calls[0].request.resolve([{ id: 'latest' }]); f.counts[0].resolve({ all: 1 })
  await Promise.all(waiting)
  assert.equal(f.store.items[0].id, 'latest'); assert.equal(f.store.loading, false)
})

await test('changes during a read cause one final refresh with the newest filter', async () => {
  const f = storeFixture(), first = f.store.load(); await flush()
  f.store.items = [{ id: 'retained' }]
  const waiting: Promise<void>[] = []
  for (let index = 0; index < 40; index++) { f.store.keyword = 'Query ' + index; waiting.push(f.store.load()) }
  assert.equal(f.calls.length, 1)
  f.calls[0].request.resolve([{ id: 'stale' }]); await flush()
  assert.equal(f.store.items[0].id, 'retained'); assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].query.keyword, 'Query 39')
  f.calls[1].request.resolve([{ id: 'fresh' }]); await Promise.all([first, ...waiting])
  assert.equal(f.store.items[0].id, 'fresh'); assert.equal(f.store.loading, false)
})

await test('a failed refresh retains the current list and does not block the next refresh', async () => {
  const f = storeFixture(); f.store.items = [{ id: 'retained' }]
  const first = f.store.load(); await flush(); f.calls[0].request.reject(new Error('Temporary read failure')); await first
  assert.equal(f.store.items[0].id, 'retained'); assert.equal(f.store.loading, false); assert.equal(f.errors.length, 1)
  const next = f.store.load(); await flush(); f.calls[1].request.resolve([{ id: 'recovered' }]); await next
  assert.equal(f.store.items[0].id, 'recovered')
})

console.log(`Video Agent background core: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
