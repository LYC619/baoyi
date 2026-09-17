import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { listEpisodes, updateEpisode, getVideo, updateVideo } from '../electron/kinds/video/db.ts'
import { pngImage } from './helpers/test-images.ts'
const module: any = await import('../electron/kinds/video/download/workflow.ts').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {} })
assert.equal(typeof module.createVideoWorkflow, 'function', 'persistent download workflow is not implemented')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-workflow-'))
const dbFile = path.join(root, 'library.db')
let db = new DatabaseSync(dbFile)
db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
let transfers = 0
let rejectRegistration = false
let failCode = ''
let release: (() => void) | undefined
let gated = false
const deps = () => ({
  db, downloadsDirectory: () => root,
  resolveWork: async (code: string) => ({ videoCode: code, title: 'Example', description: 'Source introduction', posterUrl: '', tags: [], episodes: ['101', '104', '105'].map((videoCode, i) => ({ videoCode, title: 'Part ' + (i + 1) })), warnings: [] }),
  resolveSources: async (code: string) => ({ videoCode: code, title: 'Part ' + code, candidates: [{ url: 'https://fixture.invalid/' + code + '.mp4?temporary=secret', label: '720p', extension: 'mp4' }], warnings: [] }),
  transfer: async (options: any) => {
    transfers++
    if (gated) { gated = false; await new Promise<void>(resolve => { release = resolve }) }
    if (failCode && options.url.includes(failCode)) throw new Error('Fixture network failure')
    fs.writeFileSync(options.destination, 'fixture-video-' + transfers)
    return { destination: options.destination, receivedBytes: 15, totalBytes: 15, bytesPerSecond: 0, warnings: [] }
  },
  beforeRegister: () => { if (rejectRegistration) throw new Error('Fixture database failure') }
})
let svc = module.createVideoWorkflow(deps())
async function finish(id: string) { await svc.idle(); return svc.list().find((j: any) => j.id === id) }
const request = (draft: any, codes: string[], extra = {}) => ({ draftId: draft.id, videoCodes: codes, sourceLabel: '', strictQuality: false, register: true, ...extra })
let passed = 0; let failed = 0
async function test(name: string, fn: () => Promise<void>) { try { await fn(); passed++ } catch (error) { failed++; console.error('FAIL ' + name, error) } }
try {
  await test('draft creates no card; download saves a portable bundle and source membership', async () => {
    const draft = await svc.prepare({ url: 'https://hanime1.me/watch?v=104' })
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 0)
    const job = svc.enqueue(request(draft, ['104']))
    const done = await finish(job.id)
    assert.equal(done.items[0].transfer, 'complete')
    assert.equal(done.items[0].registration, 'complete')
    assert.equal(path.dirname(done.items[0].path), done.directory)
    assert.equal(path.basename(done.directory), 'Example')
    assert.ok(fs.existsSync(path.join(done.directory, 'baoyi.json')))
    assert.match(fs.readFileSync(path.join(done.directory, '简介.md'), 'utf8'), /Source introduction/)
    assert.ok(!JSON.stringify(svc.list()).includes('temporary=secret'))
    const ep = listEpisodes(db, done.resourceId).find(e => e.path)!
    updateEpisode(db, ep.id, { position_sec: 77, watch_status: 'watching' })
    updateVideo(db, done.resourceId, { name_zh: 'User title', notes: 'Keep notes' })
  })
  await test('restart and another episode link reuse work, directory, history and select only missing', async () => {
    const first = svc.list()[0]
    db.close(); db = new DatabaseSync(dbFile); db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS); svc = module.createVideoWorkflow(deps())
    const draft = await svc.prepare({ url: 'https://hanime1.me/watch?v=101' })
    assert.equal(draft.resourceId, first.resourceId)
    assert.equal(draft.directory, first.directory)
    assert.equal(draft.episodes.find((e: any) => e.videoCode === '104').state, 'local')
    const job = svc.enqueue(request(draft, ['101'])); const done = await finish(job.id)
    assert.equal(done.resourceId, first.resourceId)
    assert.equal(getVideo(db, done.resourceId)?.name_zh, 'User title')
    assert.equal(listEpisodes(db, done.resourceId).find(e => e.position_sec === 77)?.watch_status, 'watching')
    assert.equal(JSON.parse(fs.readFileSync(path.join(done.directory, 'baoyi.json'), 'utf8')).items.length, 2)
  })
  await test('database-stage retry never transfers the saved file again', async () => {
    const draft = await svc.prepare({ url: 'https://hanime1.me/watch?v=105' })
    rejectRegistration = true
    const job = svc.enqueue(request(draft, ['105'])); const done = await finish(job.id)
    assert.equal(done.items[0].transfer, 'complete'); assert.equal(done.items[0].registration, 'failed')
    const before = transfers; rejectRegistration = false
    svc.retry(job.id, 'registration'); const retried = await finish(job.id)
    assert.equal(retried.items[0].registration, 'complete'); assert.equal(transfers, before)
  })
  await test('strict quality skips without transferring and save-only does not claim registration', async () => {
    const draft = await svc.prepare({ url: 'https://hanime1.me/watch?v=101' })
    const before = transfers
    const job = svc.enqueue(request(draft, ['101'], { sourceLabel: '1080p', strictQuality: true, register: false })); const done = await finish(job.id)
    assert.equal(done.items[0].transfer, 'skipped'); assert.equal(transfers, before)
    assert.notEqual(done.items[0].registration, 'complete')
  })
  await test('multiple jobs queue serially, queued cancellation is retained', async () => {
    const draft = await svc.prepare({ url: 'https://hanime1.me/watch?v=101' })
    gated = true
    const a = svc.enqueue(request(draft, ['101'], { sourceLabel: 'original-a' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const b = svc.enqueue(request(draft, ['105']))
    assert.equal(svc.list().find((j: any) => j.id === b.id).status, 'queued')
    svc.cancel(b.id); release?.(); await finish(a.id)
    assert.equal(svc.list().find((j: any) => j.id === b.id).status, 'cancelled')
  })
  await test('startup marks pending work interrupted without restarting a transfer', async () => {
    const previous = svc.list()[0]
    const fixture = { ...previous, id: 'interrupted-fixture', status: 'running', items: previous.items.map((i: any) => ({ ...i, transfer: 'running' })) }
    db.prepare('INSERT INTO video_download_jobs (id, status, updated_at, payload) VALUES (?, ?, ?, ?)').run(fixture.id, 'running', Date.now(), JSON.stringify(fixture))
    const before = transfers
    svc = module.createVideoWorkflow(deps())
    assert.equal(svc.list().find((j: any) => j.id === fixture.id).status, 'interrupted')
    assert.equal(transfers, before)
  })
  await test('downloaded poster and thumbnail use decoded roles and survive portable registration', async () => {
    gated = false
    const posterUrl = 'https://fixture.invalid/cover.png', thumbnailUrl = 'https://fixture.invalid/thumbnail.png'
    const facts = { publishedAt: Date.UTC(2026, 7, 28), releaseDate: Date.UTC(2024, 0, 2), durationSec: 997, artist: 'Fixture Studio' }
    svc = module.createVideoWorkflow({ ...deps(),
      resolveWork: async (code: string) => ({ videoCode: code, title: 'Artwork', description: 'Artwork description', posterUrl, thumbnailUrl, tags: ['Artwork'], episodes: [{ videoCode: code, title: 'Artwork 1' }], warnings: [],
        currentEpisode: { ...facts, videoCode: code, title: 'Artwork 1', description: 'Episode details', tags: ['Independent'], posterUrl, thumbnailUrl } }),
      resolveSources: async (code: string) => ({ ...facts, videoCode: code, title: 'Artwork 1', description: 'Episode details', posterUrl, thumbnailUrl, tags: ['Independent'], candidates: [{ url: 'https://fixture.invalid/'+code+'.mp4', label: '720p', extension: 'mp4' }], warnings: [] }),
      savePoster: async (url: string) => { const image = path.join(root,path.basename(url)); fs.writeFileSync(image,pngImage(url === thumbnailUrl ? 400 : 640,url === thumbnailUrl ? 600 : 360)); return image },
      artworkSize: (file: string) => { const bytes = fs.readFileSync(file); return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } }
    })
    const draft = await svc.prepare({ url: 'https://hanime1.me/watch?v=802010' })
    const done = await finish(svc.enqueue(request(draft,['802010'])).id)
    assert.equal(done.items[0].registration,'complete')
    const episode = listEpisodes(db,done.resourceId)[0]
    assert.equal(episode.poster_source,thumbnailUrl); assert.equal(episode.thumbnail_source,posterUrl)
    assert.equal(fs.readFileSync(episode.poster_path!).readUInt32BE(20),600)
    assert.equal(fs.readFileSync(episode.thumbnail_path!).readUInt32BE(16),640)
    assert.deepEqual(episode.tags,['Independent'])
    assert.equal(episode.published_at, facts.publishedAt)
    assert.equal(episode.air_date, facts.releaseDate)
    assert.equal(episode.duration_sec, facts.durationSec)
    assert.equal(episode.studio, facts.artist)
    const manifest = JSON.parse(fs.readFileSync(path.join(done.directory,'baoyi.json'),'utf8'))
    assert.ok(manifest.work.thumbnail); assert.ok(manifest.items[0].thumbnail)
    assert.equal(manifest.items[0].published_at, facts.publishedAt)
    assert.equal(manifest.items[0].studio, facts.artist)
  })
  await test('library reset discards cached jobs and invalidates old download drafts', async () => {
    const draft = await svc.prepare({ url: 'https://hanime1.me/watch?v=101' })
    assert.ok(svc.list().length > 0)
    db.exec('DELETE FROM video_download_jobs')
    svc.clearHistory()
    assert.deepEqual(svc.list(), [])
    assert.throws(() => svc.enqueue(request(draft, ['101'])), /草稿/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_download_jobs').get()!.n, 0)
  })
} finally { await svc.idle(); db.close(); fs.rmSync(root, { recursive: true, force: true }) }
console.log('Video workflow: ' + passed + ' passed / ' + failed + ' failed')
if (failed) process.exitCode = 1
