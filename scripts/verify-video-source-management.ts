import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import * as video from '../electron/kinds/video/db.ts'
import { registerVideoContent, bindVideoSource } from '../electron/kinds/video/registration.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'

let passed = 0, failed = 0
async function test(name: string, run: (h: ReturnType<typeof fixture>) => Promise<void>) {
  const h = fixture()
  try { await run(h); passed++ } catch (e) { failed++; console.error('FAIL', name, e) }
  finally { h.db.close(); assert.equal(path.dirname(h.root), os.tmpdir()); fs.rmSync(h.root, { recursive: true, force: true }) }
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-source-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
  const info = { videoCode: '501001', title: 'Series', tags: ['Work tag'], description: 'Series description', episodes: [], warnings: [],
    currentEpisode: { videoCode: '501001', title: 'Chapter one', originalTitle: 'Original one', description: 'Episode description', tags: ['Episode tag'], posterUrl: '', thumbnailUrl: '', publishedAt: Date.UTC(2026, 7, 28), releaseDate: Date.UTC(2024, 0, 2), durationSec: 997, artist: 'Fixture Studio' } }
  let resolve: (v: typeof info) => void = () => {}
  const pending = new Promise<typeof info>(done => { resolve = done })
  const load = createRendererLoader({
    'node:fs': { ...fs, default: fs }, 'node:path': { ...path, default: path },
    electron: { app: { getPath: () => root }, shell: {}, net: {} },
    '../../services/database.ts': { getDb: () => db, getSettings: () => ({}), postersDir: () => root },
    './download/sources.ts': { loadVideoWork: () => pending },
    './hentai/hanime.ts': {}, './mediainfo.ts': {}, './db.ts': video,
    '../../services/agent/loop.ts': {}, '../../services/searchService.ts': {}, './tmdb.ts': {}, './tools.ts': {}, './prompts.ts': {}, './facts.ts': {}
  }, { Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout })
  const service = load('electron/kinds/video/service.ts') as typeof import('../electron/kinds/video/service.ts')
  const file = path.join(root, 'episode.mp4'); fs.writeFileSync(file, '')
  const work = registerVideoContent(db, { title: 'Before', items: [{ title: 'Before', order: 1, files: [{ path: file }] }] })
  const episode = video.listEpisodes(db, work.resourceId)[0]
  return { db, root, file, service, work, episode, complete: () => resolve(info) }
}
await test('explicit source binding updates only its episode and clears removal exclusions', async h => {
  h.db.prepare('INSERT INTO video_scan_ignores(path,resource_id,source_key,created_at) VALUES (?,?,?,1)').run(h.file, h.work.resourceId, '')
  h.db.prepare('INSERT INTO video_scan_ignores(path,resource_id,source_key,created_at) VALUES (?,?,?,1)').run('source:'+h.work.resourceId+':hanime:501001', h.work.resourceId, 'hanime:501001')
  const task = h.service.scrapeVideoEpisode(h.work.resourceId, h.episode.id, '501001'); h.complete()
  const result = await task
  assert.equal(result.episode?.description, 'Episode description'); assert.deepEqual([...result.episode!.tags!], ['Episode tag'])
  assert.equal(result.episode?.published_at, Date.UTC(2026, 7, 28))
  assert.equal(result.episode?.air_date, Date.UTC(2024, 0, 2))
  assert.equal(result.episode?.duration_sec, 997)
  assert.equal(result.episode?.studio, 'Fixture Studio')
  assert.equal(video.getVideo(h.db, h.work.resourceId)?.hanime_id, '501001')
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM video_scan_ignores').get()?.n, 0)
})
await test('source binding rechecks a target removed during the remote request', async h => {
  const task = h.service.scrapeVideoEpisode(h.work.resourceId, h.episode.id, '501001')
  h.db.prepare('DELETE FROM episode WHERE id=?').run(h.episode.id); h.complete()
  await assert.rejects(task, /变化|不存在/)
  assert.equal(video.getVideo(h.db, h.work.resourceId)?.hanime_id, '')
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM video_sources').get()?.n, 0)
})
await test('a source claimed by another episode during lookup is not rebound', async h => {
  const task = h.service.scrapeVideoEpisode(h.work.resourceId, h.episode.id, '501001')
  const file = path.join(h.root,'other.mp4'); fs.writeFileSync(file,'')
  const other = registerVideoContent(h.db, { title: 'Other', items: [{ title: 'Other', order: 1, files: [{ path: file }] }] })
  bindVideoSource(h.db, other.resourceId, { provider: 'hanime', externalId: '501001', scope: 'episode', pageUrl: 'https://hanime1.me/watch?v=501001', evidence: 'confirmed' }, video.listEpisodes(h.db,other.resourceId)[0].id)
  h.complete(); await assert.rejects(task, /其他单集|冲突/)
  assert.equal(video.getEpisode(h.db,h.episode.id)?.title,'Before')
})
console.log(`Video source management: ${passed} passed / ${failed} failed`); process.exitCode = failed ? 1 : 0
