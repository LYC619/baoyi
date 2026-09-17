import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { getVideo, listEpisodes, updateVideo, listVideos } from '../electron/kinds/video/db.ts'
import { createVideoAgentOrganizer } from '../electron/kinds/video/agent-organize.ts'
import { videoImportLibraryStamp } from '../electron/kinds/video/import-command.ts'
import { listVideoOrganizeJournal, rollbackVideoOrganize } from '../electron/kinds/video/organize.ts'
import type { VideoAgentActions, VideoAgentProgress } from '../src/types/video-agent-organize.ts'
const defaults: VideoAgentActions = { merge: true, artwork: false, metadata: false, transfer: 'none' }
let passed = 0, failed = 0
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-agent-organize-')), db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
  const work = (title: string, number = 1) => {
    const file = path.join(root, title, title + '.mp4'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'synthetic media')
    return registerVideoContent(db, { title, category: '里番', items: [{ title, order: number, number, season: 1,
      description: 'Original episode description', watch: { status: 'watching', position: 120, watchedAt: 0 }, files: [{ path: file }] }] }).resourceId
  }
  const ids = [work('Series E01'), work('Series E02', 2), work('Another Work')]
  let requestedGroups = [ids.slice(0, 2)], analyzed = 0
  const enrichments: { id: string; actions: VideoAgentActions }[] = []
  const progress: VideoAgentProgress[] = []
  const make = (cancel = false) => {
    const manager = createVideoAgentOrganizer({ db, config: () => ({ enabled: true, api_key: 'fixture-only', api_url: 'http://localhost', model: 'fixture' }), root: () => path.join(root, 'organized'),
      runAgent: async options => { analyzed++
        const candidates = JSON.parse(options.user) as { id: string; title: string }[]
        await options.tools[0].execute({ groups: requestedGroups.map(resourceIds => ({ resourceIds: resourceIds.map(id => candidates.find(work => work.title === getVideo(db, id)?.name_zh)?.id || id), reason: 'Matching series and distinct episode numbers' })) })
        return { stopReason: 'done', error: '', turns: 1, tokens: 21, text: '' } },
      enrich: async (id, actions) => { enrichments.push({ id, actions }); if (cancel) manager.cancel(); return { tokens: 3, message: 'Synthetic enrichment', ok: true } },
      progress: value => progress.push(value) })
    return manager
  }
  return { root, db, ids, make, progress, enriched: enrichments, analyzed: () => analyzed, groups: (groups: string[][]) => { requestedGroups = groups },
    close: () => { db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) } }
}
async function test(name: string, run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture()
  try { await run(f); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []); passed++; console.log('PASS ' + name) }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error instanceof Error ? error.stack : error)) }
  finally { f.close() }
}
await test('Agent proposes only selected series, without writing before confirmation', async f => {
  const manager = f.make(), before = videoImportLibraryStamp(f.db), plan = await manager.prepare(f.ids, defaults)
  assert.equal(f.analyzed(), 1); assert.equal(plan.groups.length, 1); assert.equal(plan.groups[0].title, 'Series 1-2')
  assert.equal(videoImportLibraryStamp(f.db), before)
  const result = await manager.run(plan.id, [plan.groups[0].id])
  assert.ok(result.outcomes[0].ok, result.outcomes[0].message)
  assert.equal(getVideo(f.db, f.ids[0])?.name_zh, 'Series 1-2')
  const episodes = listEpisodes(f.db, f.ids[0]); assert.equal(episodes.length, 2); assert.ok(episodes.every(episode => episode.position_sec === 120 && episode.season === 0))
  assert.equal(getVideo(f.db, f.ids[2])?.is_archived, false)
  assert.equal(f.enriched.length, 0)
  assert.deepEqual(await manager.run(plan.id, [plan.groups[0].id]), result)
  assert.equal(listVideoOrganizeJournal(f.db).length, 1)
})
await test('author-like or out-of-scope grouping cannot change the library', async f => {
  const before = videoImportLibraryStamp(f.db), manager = f.make()
  f.groups([[f.ids[0], f.ids[2]]]); const unrelated = await manager.prepare(f.ids, defaults)
  assert.equal(unrelated.groups.length, 0); assert.equal(unrelated.groupingStatus, 'failed')
  f.groups([[f.ids[0], 'outside-selection']]); const outside = await manager.prepare(f.ids, defaults)
  assert.equal(outside.groups.length, 0); assert.match(outside.warnings.join('\n'), /本批所选/)
  assert.equal(videoImportLibraryStamp(f.db), before)
})
await test('artwork-only scopes and cancellation preserve unprocessed works', async f => {
  const manager = f.make(true), plan = await manager.prepare(f.ids, { ...defaults, merge: false, artwork: true })
  const result = await manager.run(plan.id, [])
  assert.equal(f.analyzed(), 0); assert.equal(result.cancelled, true); assert.equal(f.enriched.length, 1)
  assert.equal(f.enriched[0].actions.metadata, false)
  assert.equal(listVideoOrganizeJournal(f.db).length, 0)
})
await test('saved organizer root creates a collection child directory and supports rollback', async f => {
  const originals = f.ids.slice(0,2).map(id => listEpisodes(f.db,id)[0].path)
  fs.mkdirSync(path.join(f.root, 'organized'))
  const manager = f.make(), plan = await manager.prepare(f.ids.slice(0,2), { ...defaults, transfer: 'move' })
  const preview = plan.groups[0].preview, target = path.join(f.root, 'organized', 'Series 1-2')
  assert.equal(preview.targetDirectory, target); assert.ok(preview.files.every(file => file.destination.startsWith(target + path.sep)))
  const result = await manager.run(plan.id, [plan.groups[0].id]); assert.ok(result.outcomes[0].ok, result.outcomes[0].message)
  assert.ok(listEpisodes(f.db, f.ids[0]).every(episode => fs.existsSync(episode.path) && episode.path.startsWith(target)))
  assert.ok(originals.every(file => !fs.existsSync(file)))
  assert.equal((await rollbackVideoOrganize(f.db, listVideoOrganizeJournal(f.db)[0].id)).status, 'rolled-back')
  assert.ok(originals.every(file => fs.existsSync(file)))
})
await test('stale plan refuses to merge and unassigned group matches only empty collection names', async f => {
  const manager = f.make(), plan = await manager.prepare(f.ids, defaults)
  updateVideo(f.db, f.ids[2], { collection_name: 'Saved', notes: 'User edit after preview' })
  await assert.rejects(manager.run(plan.id, [plan.groups[0].id]), /变化/)
  assert.equal(listVideoOrganizeJournal(f.db).length, 0)
  assert.deepEqual(listVideos(f.db, { type: 'hentai', collection: '' }).map(work => work.id).sort(), f.ids.slice(0,2).sort())
})
await test('a second execution while enrichment runs cannot return an unfinished result', async f => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const manager = createVideoAgentOrganizer({ db: f.db, config: () => ({ enabled: true, api_key: 'fixture', api_url: 'http://localhost', model: 'fixture' }),
    root: () => '', runAgent: async () => { throw new Error('No grouping requested') },
    enrich: async () => { await gate; return { tokens: 0, message: 'Finished', ok: true } } })
  const plan = await manager.prepare([f.ids[0]], { ...defaults, merge: false, artwork: true })
  const running = manager.run(plan.id, [])
  try { await assert.rejects(manager.run(plan.id, []), /正在进行/) } finally { release() }
  const result = await running
  assert.equal(result.outcomes.length, 1)
  assert.deepEqual(await manager.run(plan.id, []), result)
})
await test('completed progress uses the merged work count and reaches the final outcome count', async f => {
  const manager = f.make(), plan = await manager.prepare(f.ids, { ...defaults, artwork: true })
  const result = await manager.run(plan.id, plan.groups.map(group => group.id))
  assert.equal(result.outcomes.length, 3)
  assert.equal(f.progress.at(-1)?.processed, 3)
  assert.equal(f.progress.at(-1)?.total, 3)
})
await test('cancelling enrichment records completed work without claiming unprocessed work is finished', async f => {
  const manager = f.make(true), plan = await manager.prepare(f.ids, { ...defaults, merge: false, artwork: true })
  const result = await manager.run(plan.id, [])
  assert.equal(result.cancelled, true)
  assert.equal(f.progress.at(-1)?.processed, 1)
  assert.equal(f.progress.at(-1)?.total, 3)
})
await test('a submitted batch yields to cancellation before building all group previews', async f => {
  const before = videoImportLibraryStamp(f.db)
  const manager = createVideoAgentOrganizer({ db: f.db, config: () => ({ enabled: true, api_key: 'fixture', api_url: 'http://localhost', model: 'fixture' }),
    root: () => '', enrich: async () => ({ tokens: 0, message: '', ok: true }),
    runAgent: async options => {
      const candidates = JSON.parse(options.user) as { id: string }[]
      setImmediate(() => manager.cancel())
      await options.tools[0].execute({ groups: [{ resourceIds: candidates.map(candidate => candidate.id), reason: 'Same series' }] })
      return { stopReason: 'done', error: '', turns: 1, tokens: 0, text: '' }
    } })
  await assert.rejects(manager.prepare(f.ids, defaults), /已停止分析/)
  assert.equal(videoImportLibraryStamp(f.db), before)
})
console.log(`Video Agent organizer: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
