import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { createVideoImportManager } from '../electron/kinds/video/import-preview.ts'
import { videoImportLibraryStamp } from '../electron/kinds/video/import-command.ts'
import * as videoDb from '../electron/kinds/video/db.ts'
import { VIDEO_CATEGORIES } from '../electron/kinds/video/taxonomy.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'

function cloneDb(source: DatabaseSync) {
  const target = new DatabaseSync(':memory:'); initSchema(target, KINDS)
  target.exec('PRAGMA foreign_keys=OFF')
  for (const row of target.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const table = String(row.name)
    target.exec('DELETE FROM "' + table + '"')
    if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue
    for (const data of source.prepare('SELECT * FROM "' + table + '"').all()) {
      const keys = Object.keys(data), query = 'INSERT INTO "' + table + '" (' + keys.map(key => '"' + key + '"').join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')'
      target.prepare(query).run(...keys.map(key => data[key]))
    }
  }
  target.exec('PRAGMA foreign_keys=ON'); return { db: target, close: () => target.close() }
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-import-preview-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
  const file = (name: string, content = 'synthetic media') => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target }
  for (const name of ['Alpha', 'Beta']) {
    file(name + '/' + name + '.mp4')
    file(name + '/' + name + '.nfo', '<movie><title>' + name + '</title><plot>' + name + ' local description</plot></movie>')
  }
  file('Unknown/Unknown.mp4')
  let agentCalls = 0, logWrites = 0, agentMode: 'error' | 'success' = 'error'
  const load = createRendererLoader({
    'node:fs': { ...fs, default: fs }, 'node:path': { ...path, default: path },
    electron: { app: { getPath: () => root }, net: {}, shell: {} },
    '../../services/database.ts': { getDb: () => db, getSettings: () => ({ ai: { enabled: true, api_key: 'synthetic' }, search: {}, tmdb: {} }),
      listCategories: () => VIDEO_CATEGORIES, tagPool: () => [], saveIdentifyLog: () => { logWrites++; throw new Error('Preview wrote a live identification log') }, postersDir: () => root },
    '../../services/searchService.ts': { searchAvailable: () => false }, './tmdb.ts': { tmdbAvailable: () => false },
    './hentai/hanime.ts': { newBudget: () => ({}) }, './mediainfo.ts': { readContainerInfo: async () => null }, './db.ts': videoDb,
    '../../services/agent/loop.ts': { runAgent: async (options: any) => {
      agentCalls++
      if (agentMode === 'success') await options.tools.find((tool: any) => tool.name === 'register_video').execute({ name_zh: 'Reviewed Unknown', category: '其他', summary: 'Reviewed summary', description: 'Reviewed description', tags: [] })
      return { stopReason: agentMode === 'success' ? 'done' : 'error', tokens: 12, turns: 1 }
    } }
  }, { Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout })
  const service = load('electron/kinds/video/service.ts') as typeof import('../electron/kinds/video/service.ts')
  const make = (artwork?: (id: string) => Promise<void>) => createVideoImportManager({ db, cloneDb: () => cloneDb(db), scan: service.scanVideos, review: service.reviewVideoImportCandidate, artwork })
  return { root, db, file, make, service, clone: () => cloneDb(db), agent: (mode: 'error' | 'success') => { agentMode = mode }, calls: () => agentCalls, logs: () => logWrites, close: () => { db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) } }
}
let passed = 0, failed = 0
async function test(name: string, run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture()
  try { await run(f); assert.equal(f.logs(), 0); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []); passed++; console.log('PASS ' + name) }
  catch (cause) { failed++; console.error('FAIL ' + name + ': ' + (cause instanceof Error ? cause.stack : cause)) }
  finally { f.close() }
}
await test('local preview leaves the library and media untouched, with stable editable rows', async f => {
  const manager = f.make(), before = videoImportLibraryStamp(f.db)
  const batch = await manager.prepare([f.root])
  assert.equal(videoImportLibraryStamp(f.db), before); assert.equal(f.calls(), 0)
  assert.equal(batch.entries.length, 3); assert.equal(batch.entries.filter(entry => entry.status === 'ready').length, 2)
  assert.equal(batch.entries.filter(entry => entry.status === 'review').length, 1)
  assert.equal(batch.entries.filter(entry => entry.selected).length, 2)
  assert.ok(!fs.existsSync(path.join(f.root, 'Alpha/baoyi.json')))
  const alpha = batch.entries.find(entry => entry.title === 'Alpha')!
  const edited = manager.update(batch.id, { entry: { id: alpha.id, edits: { title: 'Edited Alpha' } } })
  assert.equal(edited.entries.find(entry => entry.id === alpha.id)?.title, 'Edited Alpha')
  assert.equal(videoImportLibraryStamp(f.db), before)
})
await test('confirm writes only the selected candidate and is idempotent', async f => {
  const manager = f.make(), batch = await manager.prepare([f.root]), first = batch.entries.find(entry => entry.title === 'Alpha')!
  const result = manager.confirm(batch.id, [first.id])
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM resource WHERE kind='video'").get()!.n, 1)
  assert.equal(result.entries.length, 3); assert.equal(result.entries.find(entry => entry.id === first.id)?.status, 'confirmed')
  assert.equal(result.entries.find(entry => entry.title === 'Beta')?.status, 'ready')
  manager.confirm(batch.id, [first.id])
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM resource WHERE kind='video'").get()!.n, 1)
})
await test('failed single-row Agent review preserves the entire batch and previous proposal', async f => {
  const manager = f.make(), batch = await manager.prepare([f.root]), entry = batch.entries.find(entry => entry.status === 'review')!
  const before = videoImportLibraryStamp(f.db), other = batch.entries.filter(row => row.id !== entry.id)
  const result = await manager.review(batch.id, [entry.id])
  assert.equal(f.calls(), 1); assert.equal(result.id, batch.id); assert.equal(result.entries.length, 3)
  assert.deepEqual(result.entries.filter(row => row.id !== entry.id), other)
  assert.equal(result.entries.find(row => row.id === entry.id)?.title, entry.title)
  assert.ok(result.entries.find(row => row.id === entry.id)?.reviewError)
  assert.equal(videoImportLibraryStamp(f.db), before)
})
await test('post-confirm artwork does not invalidate the remaining rows or repeat on retry', async f => {
  let calls = 0
  const manager = f.make(async id => { calls++; videoDb.updateVideo(f.db, id, { poster_path: f.file(`Covers/${id}.png`, 'synthetic artwork') }) })
  const batch = await manager.prepare([f.root]), first = batch.entries.find(entry => entry.title === 'Alpha')!, second = batch.entries.find(entry => entry.title === 'Beta')!
  await manager.confirmWithArtwork(batch.id, [first.id])
  await manager.confirmWithArtwork(batch.id, [first.id])
  assert.equal(calls, 1)
  await manager.confirmWithArtwork(batch.id, [second.id])
  assert.equal(calls, 2)
  assert.equal(manager.get(batch.id)?.entries.filter(entry => entry.status === 'confirmed').length, 2)
})
await test('user metadata edits during post-confirm artwork still invalidate stale previews', async f => {
  const manager = f.make(async id => { videoDb.updateVideo(f.db, id, { poster_path: 'synthetic.png', notes: 'User edit while artwork is downloading' }) })
  const batch = await manager.prepare([f.root]), first = batch.entries.find(entry => entry.title === 'Alpha')!, second = batch.entries.find(entry => entry.title === 'Beta')!
  await manager.confirmWithArtwork(batch.id, [first.id])
  assert.throws(() => manager.confirm(batch.id, [second.id]), /资料|变化/)
  assert.equal(manager.get(batch.id)?.entries.filter(entry => entry.status === 'confirmed').length, 1)
})
await test('refreshing presence timestamps preserves a draft while changing file state invalidates it', async f => {
  const manager = f.make(), batch = await manager.prepare([f.root]), first = batch.entries.find(entry => entry.title === 'Alpha')!, second = batch.entries.find(entry => entry.title === 'Beta')!
  manager.confirm(batch.id, [first.id])
  f.db.exec('UPDATE video_assets SET checked_at = checked_at + 1; UPDATE resource SET updated_at = updated_at + 1')
  manager.confirm(batch.id, [second.id])
  f.db.exec("UPDATE video_assets SET state = 'missing'")
  assert.throws(() => manager.confirm(batch.id, [batch.entries.find(entry => entry.status === 'review')!.id]), /资料|变化/)
})
await test('persisted drafts recover with edits and selections, while moved files block commit', async f => {
  const manager = f.make(), batch = await manager.prepare([f.root]), entry = batch.entries[0]
  manager.update(batch.id, { selectedIds: [entry.id], entry: { id: entry.id, edits: { description: 'Confirmed draft description' } } })
  const recovered = f.make(), restored = recovered.get(batch.id)!
  assert.equal(restored.entries.find(row => row.id === entry.id)?.description, 'Confirmed draft description')
  assert.deepEqual(restored.entries.filter(row => row.selected).map(row => row.id), [entry.id])
  const video = path.join(entry.path, path.basename(entry.path) + '.mp4')
  assert.ok(fs.existsSync(video)); fs.renameSync(video, video + '.moved')
  const before = videoImportLibraryStamp(f.db)
  assert.throws(() => recovered.confirm(batch.id, [entry.id]), /文件|变化/)
  assert.equal(videoImportLibraryStamp(f.db), before)
  assert.equal(recovered.get(batch.id)?.entries.length, 3)
})
await test('a consistent numbered series across folders is one preview and one registered collection', async f => {
  for (const n of [1, 2]) {
    f.file(`Series${n}/Series E0${n}.mp4`)
    f.file(`Series${n}/Series E0${n}.nfo`, `<movie><title>Series E0${n}</title><plot>Episode ${n} description</plot></movie>`)
  }
  const manager = f.make(), before = videoImportLibraryStamp(f.db), batch = await manager.prepare([f.root])
  assert.equal(videoImportLibraryStamp(f.db), before)
  const series = batch.entries.find(entry => entry.title === 'Series 1-2')
  assert.ok(series, JSON.stringify(batch.entries.map(entry => entry.title)))
  assert.equal(series.episodeCount, 2); assert.equal(series.fileCount, 2)
  const result = manager.confirm(batch.id, [series.id]), id = result.entries.find(entry => entry.id === series.id)!.resourceId
  assert.equal(videoDb.listEpisodes(f.db, id).length, 2)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM resource WHERE kind='video'").get()!.n, 1)
  assert.ok(fs.existsSync(path.join(f.root, 'Series1/Series E01.mp4')))
})
await test('successful Agent review only replaces its row and replays the validated payload on confirmation', async f => {
  const manager = f.make(), batch = await manager.prepare([f.root]), target = batch.entries.find(entry => entry.status === 'review')!
  const before = videoImportLibraryStamp(f.db), other = batch.entries.filter(entry => entry.id !== target.id)
  f.agent('success')
  const reviewed = await manager.review(batch.id, [target.id])
  assert.equal(reviewed.entries.find(entry => entry.id === target.id)?.title, 'Reviewed Unknown')
  assert.deepEqual(reviewed.entries.filter(entry => entry.id !== target.id), other)
  assert.equal(videoImportLibraryStamp(f.db), before)
  const confirmed = manager.confirm(batch.id, [target.id]), id = confirmed.entries.find(entry => entry.id === target.id)!.resourceId
  assert.equal(videoDb.getVideo(f.db, id)?.description, 'Reviewed description')
})
await test('a failing transaction preserves all unconfirmed rows and rolls back prior selected entries', async f => {
  const manager = f.make(), batch = await manager.prepare([f.root]), ids = batch.entries.filter(entry => entry.status === 'ready').map(entry => entry.id)
  f.db.exec("CREATE TRIGGER reject_beta BEFORE INSERT ON resource WHEN NEW.name_zh='Beta' BEGIN SELECT RAISE(ABORT,'synthetic rejection'); END")
  const before = videoImportLibraryStamp(f.db)
  assert.throws(() => manager.confirm(batch.id, ids), /synthetic rejection/)
  assert.equal(videoImportLibraryStamp(f.db), before)
  assert.equal(manager.get(batch.id)?.entries.filter(entry => entry.status === 'confirmed').length, 0)
})
await test('an interruption after recognition retains individually persisted draft rows', async f => {
  const manager = createVideoImportManager({ db: f.db, cloneDb: f.clone, review: f.service.reviewVideoImportCandidate,
    scan: async (...args) => { await f.service.scanVideos(...args); throw new Error('synthetic interruption') } })
  const batch = await manager.prepare([f.root])
  assert.equal(batch.status, 'interrupted'); assert.equal(batch.entries.length, 3)
  assert.equal(f.make().get(batch.id)?.entries.length, 3)
})
await test('a new local info file or edited library blocks stale registration', async f => {
  const manager = f.make(), batch = await manager.prepare([f.root]), target = batch.entries.find(entry => entry.status === 'review')!
  f.file('Unknown/info.json', JSON.stringify({ title: 'Unknown', introduction: 'New sidecar after preview', coverUrl: '', videoUrls: [] }))
  assert.throws(() => manager.confirm(batch.id, [target.id]), /资料|变化/)
  const refreshed = await manager.refresh(batch.id), alpha = refreshed.entries.find(entry => entry.title === 'Alpha')!
  const saved = manager.confirm(batch.id, [alpha.id]), id = saved.entries.find(entry => entry.id === alpha.id)!.resourceId
  videoDb.updateVideo(f.db, id, { name_zh: 'Manual library edit' })
  assert.throws(() => manager.confirm(batch.id, [target.id]), /作品资料|变化/)
})
await test('Agent enrichment uses an available version when another recorded version is missing', async f => {
  const playable = f.file('Available/Available.mp4'), missing = path.join(f.root, 'Available/Missing.mp4')
  const { resourceId } = registerVideoContent(f.db, { title: 'Available', items: [{ title: 'Available', order: 1, files: [{ path: missing }, { path: playable }] }] })
  const scratch = f.clone(); f.agent('success')
  try {
    const result = await f.service.enrichVideoWithAgent(resourceId, { metadata: true, artwork: false }, scratch.db, new AbortController().signal, () => {})
    assert.ok(result.ok, result.message); assert.equal(f.calls(), 1)
    const episodes = videoDb.listEpisodes(f.db, resourceId)
    assert.equal(episodes.length, 1); assert.equal(episodes[0].description, 'Reviewed description')
  } finally { scratch.close() }
})
console.log(`Video import preview: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
