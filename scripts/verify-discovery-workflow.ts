import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createDiscoveryCatalogue } from '../electron/kinds/video/discovery/catalogue.ts'
import { createDiscoveryWorkflow } from '../electron/kinds/video/discovery/workflow.ts'
import { createVideoJobStore } from '../electron/kinds/video/download/jobs.ts'
import { transferVideo } from '../electron/kinds/video/download/transfer.ts'
import { buildLibraryBackup, restoreLibraryBackup } from '../electron/services/library-backup.ts'
import { registerVideoBundle } from '../electron/kinds/video/registration.ts'

const output = path.resolve('output/discovery-verification'); fs.mkdirSync(output, { recursive: true })
let passed = 0
async function test(name: string, run: (env: ReturnType<typeof setup>) => Promise<void>) {
  const env = setup()
  try { await run(env); passed++ } catch (e) { console.error('FAIL', name); throw e } finally { env.db.close() }
}
function setup() {
  const db = new DatabaseSync(':memory:'); initSchema(db, KINDS)
  const root = fs.mkdtempSync(path.join(output, 'media-')), catalogue = createDiscoveryCatalogue(db)
  catalogue.importSource({ schemaVersion: 1, id: 'open', name: '开放影像', entries: [{ id: 'one', title: '离线影片', description: '测试影片',
    pageUrl: 'https://example.org/one', downloads: [{ label: '720p', url: 'https://example.org/one.mp4' }] }] })
  let transfers = 0, failRegister = false
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2000)])
  const deps = { db, catalogue, downloadsDirectory: () => root,
    transfer: (options: any) => { transfers++; return transferVideo({ ...options, fetch: async () => new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } }) }) },
    beforeRegister: () => { if (failRegister) throw new Error('测试登记失败') } }
  return { db, root, deps, workflow: createDiscoveryWorkflow(deps), transfers: () => transfers, failRegistration: (value: boolean) => { failRegister = value } }
}
const prepare = (env: ReturnType<typeof setup>) => env.workflow.prepare({ sourceId: 'open', entryId: 'one' })
function enqueue(env: ReturnType<typeof setup>, draft: Awaited<ReturnType<typeof prepare>>, register = true) {
  return env.workflow.enqueue({ draftId: draft.id, videoCodes: [draft.videoCode], sourceLabel: '', strictQuality: false, register })
}
await test('preview does not download or register, completion creates a playable movie', async env => {
  const draft = await prepare(env); assert.equal(env.transfers(), 0)
  assert.equal((env.db.prepare("SELECT count(*) n FROM resource WHERE kind='video'").get() as any).n, 0)
  enqueue(env, draft); await env.workflow.idle()
  const job = env.workflow.list()[0]; assert.equal(job.status, 'success'); assert.ok(fs.existsSync(job.items[0].path))
  const video = env.db.prepare('SELECT r.path,v.video_type FROM resource r JOIN video_meta v ON v.resource_id=r.id WHERE r.id=?').get(job.resourceId) as any
  assert.equal(video.path, job.items[0].path); assert.equal(video.video_type, 'movie')
  assert.equal((env.db.prepare('SELECT provider FROM video_sources WHERE resource_id=?').get(job.resourceId) as any).provider, 'catalogue:open')
  assert.equal(env.deps.catalogue.entry('open', 'one').resourceId, job.resourceId)
})
await test('duplicate active download is rejected', async env => {
  const draft = await prepare(env); enqueue(env, draft)
  assert.throws(() => enqueue(env, draft), /排队|进行/); await env.workflow.idle(); assert.equal(env.transfers(), 1)
})
await test('cancelling queued work does not start a transfer or create a library item', async env => {
  const job = enqueue(env, await prepare(env))
  assert.equal(env.workflow.cancel(job.id), true); await env.workflow.idle()
  assert.equal(env.workflow.list()[0].status, 'cancelled'); assert.equal(env.transfers(), 0)
  assert.equal((env.db.prepare("SELECT count(*) n FROM resource WHERE kind='video'").get() as any).n, 0)
})
await test('cancelling an active transfer can be retried through the same task', async env => {
  const original = env.deps.transfer
  let announce!: () => void
  const started = new Promise<void>(resolve => { announce = resolve })
  env.deps.transfer = (options: any) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); announce()
  })
  const job = enqueue(env, await prepare(env)); await started
  assert.equal(env.workflow.cancel(job.id), true); await env.workflow.idle()
  assert.equal(env.workflow.list()[0].status, 'cancelled')
  assert.equal((env.db.prepare("SELECT count(*) n FROM resource WHERE kind='video'").get() as any).n, 0)
  env.deps.transfer = original; env.workflow.retry(job.id, 'remaining'); await env.workflow.idle()
  assert.equal(env.workflow.list()[0].status, 'success'); assert.equal(env.transfers(), 1)
})
await test('save-only publishes file without local registration', async env => {
  enqueue(env, await prepare(env), false); await env.workflow.idle()
  const job = env.workflow.list()[0]; assert.equal(job.status, 'success'); assert.equal(job.items[0].registration, 'skipped')
  assert.equal((env.db.prepare("SELECT count(*) n FROM resource WHERE kind='video'").get() as any).n, 0)
})
await test('retry registration keeps the downloaded file and is idempotent', async env => {
  env.failRegistration(true); enqueue(env, await prepare(env)); await env.workflow.idle()
  const job = env.workflow.list()[0]; assert.equal(job.status, 'partial'); assert.equal(job.items[0].transfer, 'complete')
  env.failRegistration(false); env.workflow.retry(job.id, 'registration'); await env.workflow.idle()
  assert.equal(env.workflow.list()[0].status, 'success'); assert.equal(env.transfers(), 1)
  env.workflow.retry(job.id, 'registration'); await env.workflow.idle(); assert.equal(env.transfers(), 1)
  assert.equal((env.db.prepare("SELECT count(*) n FROM resource WHERE kind='video'").get() as any).n, 1)
})
await test('a strict missing quality fails before transfer', async env => {
  const draft = await prepare(env)
  assert.throws(() => env.workflow.enqueue({ draftId: draft.id, videoCodes: [draft.videoCode], sourceLabel: '1080p', strictQuality: true, register: true }), /画质|清晰度/)
  assert.equal(env.transfers(), 0)
})
await test('persisted generic jobs are not handed to the legacy worker', async env => {
  enqueue(env, await prepare(env)); await env.workflow.idle()
  assert.equal(createVideoJobStore(env.db, job => !job.discovery).list().length, 0)
  assert.equal(createVideoJobStore(env.db, job => !!job.discovery).list().length, 1)
  const restarted = createDiscoveryWorkflow(env.deps); assert.equal(restarted.list()[0].status, 'success')
})
await test('restart retains a completed file when registration was interrupted', async env => {
  enqueue(env, await prepare(env)); await env.workflow.idle()
  const job = env.workflow.list()[0], store = createVideoJobStore(env.db)
  job.status = 'running'; job.items[0].registration = 'running'; store.save(job)
  const restarted = createDiscoveryWorkflow(env.deps)
  assert.equal(restarted.list()[0].status, 'interrupted')
  assert.equal(restarted.list()[0].items[0].transfer, 'complete')
  restarted.retry(job.id, 'remaining'); await restarted.idle()
  assert.equal(restarted.list()[0].status, 'success'); assert.equal(env.transfers(), 1)
  assert.equal((env.db.prepare("SELECT count(*) n FROM resource WHERE kind='video'").get() as any).n, 1)
})
await test('re-importing saved sidecar keeps a movie playable', async env => {
  enqueue(env, await prepare(env)); await env.workflow.idle(); const job = env.workflow.list()[0]
  registerVideoBundle(env.db, job.directory)
  const row = env.db.prepare('SELECT r.path,v.video_type FROM resource r JOIN video_meta v ON v.resource_id=r.id WHERE r.id=?').get(job.resourceId) as any
  assert.equal(row.video_type, 'movie'); assert.equal(row.path, job.items[0].path)
})
await test('re-downloading a missing movie with another quality updates its playback path', async env => {
  enqueue(env, await prepare(env)); await env.workflow.idle(); const original = env.workflow.list()[0]
  fs.unlinkSync(original.items[0].path)
  const source = env.deps.catalogue.get('open'); source.entries[0].downloads[0].label = '1080p'; env.deps.catalogue.importSource(source)
  const replacement = enqueue(env, await prepare(env)); await env.workflow.idle()
  const job = env.workflow.list().find(value => value.id === replacement.id)!
  assert.equal(job.status, 'success'); assert.equal(job.resourceId, original.resourceId)
  const row = env.db.prepare('SELECT path FROM resource WHERE id=?').get(job.resourceId) as any
  assert.equal(row.path, job.items[0].path); assert.ok(fs.existsSync(row.path))
  assert.equal((env.db.prepare("SELECT count(*) n FROM resource WHERE kind='video'").get() as any).n, 1)
})
await test('metadata backups preserve source catalogues, personal marks and generic jobs', async env => {
  env.deps.catalogue.mark('open', 'one', { favorite: true, notes: '保留' }); enqueue(env, await prepare(env)); await env.workflow.idle()
  const backup = buildLibraryBackup(env.db)
  env.deps.catalogue.mark('open', 'one', { favorite: false, notes: '' })
  restoreLibraryBackup(env.db, backup)
  assert.equal(env.deps.catalogue.entry('open', 'one').mark.favorite, true)
  assert.equal(env.deps.catalogue.entry('open', 'one').mark.notes, '保留')
  assert.equal(createDiscoveryWorkflow(env.deps).list()[0].status, 'success')
})
console.log(`Discovery download workflow: ${passed} passed`)
