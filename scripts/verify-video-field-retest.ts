import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { getVideo, listEpisodes } from '../electron/kinds/video/db.ts'
import { registerVideoContent, bindVideoSource } from '../electron/kinds/video/registration.ts'
import { applyVideoCatalogue } from '../electron/kinds/video/catalogue.ts'
import { syncVideoWorkFiles } from '../electron/kinds/video/local-sync.ts'
import { previewVideoRemoval } from '../electron/kinds/video/management.ts'
import { previewVideoOrganize, applyVideoOrganize, rollbackVideoOrganize, listVideoOrganizeJournal } from '../electron/kinds/video/organize.ts'
import { createVideoWorkflow, type VideoWorkSource } from '../electron/kinds/video/download/workflow.ts'

let passed = 0, failed = 0
const filter = process.argv.find(arg => arg.startsWith('--filter='))?.slice(9)
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-field-retest-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
  const file = (name: string) => { const value = path.join(root, name); fs.mkdirSync(path.dirname(value), { recursive: true }); fs.writeFileSync(value, 'synthetic media'); return value }
  const source = (number: number) => ({ provider: 'hanime', externalId: String(800000 + number), scope: 'episode' as const, pageUrl: 'https://hanime1.me/watch?v=' + (800000 + number), evidence: 'confirmed' as const })
  const info = (number = 1): VideoWorkSource => ({ videoCode: source(number).externalId, title: '故事', description: '', posterUrl: '', tags: [], warnings: [],
    currentEpisode: { videoCode: source(number).externalId, title: '故事 LEVEL：' + number, originalTitle: 'Original Story LEVEL：' + number, publishedAt: Date.UTC(2026, 5, 4), durationSec: 975 },
    episodes: [1, 2].map(n => ({ videoCode: source(n).externalId, title: '故事 LEVEL：' + n })) })
  const work = (number: number, name = `Library/Original Story LEVEL：${number} [中文字幕]_720P.mp4`) => registerVideoContent(db, {
    title: '故事 LEVEL：' + number, items: [{ title: '故事 LEVEL：' + number, originalTitle: 'Original Story LEVEL：' + number, number, order: number,
      publishedAt: Date.UTC(2026, 5, 4), sources: [source(number)], files: [{ path: file(name), quality: '720p' }] }]
  }).resourceId
  const workflow = () => createVideoWorkflow({ db, downloadsDirectory: () => path.join(root, 'Downloads'), resolveWork: async code => info(Number(code) - 800000),
    resolveSources: async () => { throw new Error('No network expected') }, transfer: async () => { throw new Error('No transfer expected') } })
  const close = () => { db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('baoyi-field-retest-')); fs.rmSync(root, { recursive: true, force: true }) }
  return { root, db, file, source, info, work, workflow, close }
}
async function test(name: string, run: (f: ReturnType<typeof fixture>) => void | Promise<void>) {
  if (filter && !name.includes(filter)) return
  const f = fixture()
  try { await run(f); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []); passed++ }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error instanceof Error ? error.message : error)) }
  finally { f.close() }
}

await test('reidentification does not recreate unbound membership beside a bound source', f => {
  const id = f.work(1)
  bindVideoSource(f.db, id, { ...f.source(1), evidence: 'legacy' })
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_sources WHERE resource_id = ? AND episode_id IS NULL').get(id)!.n, 0)
  assert.equal(f.db.prepare('SELECT confirmed FROM video_sources WHERE resource_id = ?').get(id)!.confirmed, 1)
})

await test('legacy bound and unbound source rows can form a collection and roll back', async f => {
  const a = f.work(1), b = f.work(2)
  f.db.prepare(`INSERT INTO video_sources(id,resource_id,episode_id,provider,external_id,scope,page_url,evidence,confirmed,created_at,updated_at)
    VALUES (?,?,NULL,'hanime',?,'episode','','legacy',0,0,0)`).run(randomUUID(), a, f.source(1).externalId)
  const before = f.db.prepare('SELECT * FROM video_sources ORDER BY id').all()
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, { resourceIds: [a, b], survivorId: a, collectionTitle: '故事' }), mode: 'logical' })
  assert.equal(journal.status, 'applied', journal.warnings.join('; '))
  assert.equal(listEpisodes(f.db, a).length, 2)
  assert.equal(new Set(listEpisodes(f.db, a).map(ep => ep.path)).size, 2)
  assert.ok(listEpisodes(f.db, a).every(ep => ep.published_at === Date.UTC(2026, 5, 4)))
  assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rolled-back')
  assert.deepEqual(f.db.prepare('SELECT * FROM video_sources ORDER BY id').all(), before)
})

await test('an empty failed collection allows a freshly reviewed attempt', async f => {
  const a = f.work(1), b = f.work(2)
  const request = { resourceIds: [a, b], survivorId: a, collectionTitle: '故事' }
  f.db.exec("CREATE TRIGGER field_retest_abort BEFORE UPDATE ON video_meta BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END")
  await assert.rejects(applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request), mode: 'logical' }), /synthetic database failure/)
  const failedId = listVideoOrganizeJournal(f.db)[0].id
  const data = JSON.parse(String(f.db.prepare('SELECT data FROM video_organize_journal WHERE id = ?').get(failedId)!.data))
  assert.equal(data.logicalApplied, false); assert.deepEqual(data.changes, [])
  assert.ok(data.files.every((file: any) => file.status === 'pending' && file.attempts === 0))
  assert.equal(listEpisodes(f.db, b).length, 1, 'the failed transaction kept the independent episode')
  f.db.exec('DROP TRIGGER field_retest_abort')
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request), mode: 'logical' })
  assert.equal(journal.status, 'applied')
  assert.equal(listEpisodes(f.db, a).length, 2)
  assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rolled-back')
})

await test('a failed journal with file attempts continues to protect its works', async f => {
  const a = f.work(1), b = f.work(2), request = { resourceIds: [a, b], survivorId: a, collectionTitle: '故事' }
  f.db.exec("CREATE TRIGGER field_retest_abort BEFORE UPDATE ON video_meta BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END")
  await assert.rejects(applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request), mode: 'logical' }), /synthetic database failure/)
  f.db.exec('DROP TRIGGER field_retest_abort')
  const failedId = listVideoOrganizeJournal(f.db)[0].id
  const data = JSON.parse(String(f.db.prepare('SELECT data FROM video_organize_journal WHERE id = ?').get(failedId)!.data))
  data.files[0].attempts = 1; data.files[0].status = 'failed'
  f.db.prepare('UPDATE video_organize_journal SET data = ? WHERE id = ?').run(JSON.stringify(data), failedId)
  await assert.rejects(applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request), mode: 'logical' }), /未完成的整理/)
})

await test('prepare respects independent episodes within the same source playlist', async f => {
  const a = f.work(1), b = f.work(2), workflow = f.workflow()
  const draft = await workflow.prepare({ resourceId: a })
  assert.equal(draft.resourceId, a)
  assert.equal(draft.episodes.find(ep => ep.videoCode === f.source(1).externalId)?.state, 'local')
  assert.equal(draft.episodes.find(ep => ep.videoCode === f.source(2).externalId)?.state, 'other-work')
  assert.equal(listEpisodes(f.db, a).length, 1)
  assert.equal(listEpisodes(f.db, b).length, 1)
  assert.throws(() => workflow.enqueue({ draftId: draft.id, videoCodes: [f.source(2).externalId], sourceLabel: '', strictQuality: false, register: true }), /归属|其他作品|来源列表/)
})

await test('prepare continues to reject a single source claimed by different works', async f => {
  const a = f.work(1)
  const b = registerVideoContent(f.db, { title: 'Different work', items: [{ title: 'Different', order: 1, files: [{ path: f.file('Other/video.mp4') }] }] }).resourceId
  bindVideoSource(f.db, b, f.source(1), listEpisodes(f.db, b)[0].id)
  await assert.rejects(f.workflow().prepare({ resourceId: a }), /来源.*多个|归属/)
})

await test('checking a loose work links the new file to its known catalogue episode', f => {
  const id = f.work(1)
  applyVideoCatalogue(f.db, id, f.info())
  const secondId = listEpisodes(f.db, id).find(ep => ep.episode === 2)!.id
  const second = f.file('Library/Original Story LEVEL：2 [中文字幕]_720P.mp4')
  f.file('Library/Unrelated Story LEVEL：2 [中文字幕]_720P.mp4')
  const result = syncVideoWorkFiles(f.db, id)
  const episode = result.library.contents.find(ep => ep.id === secondId)!
  assert.ok(episode.assets.some(asset => asset.path === second && asset.state === 'present'), 'the actual file must be linked to the existing second episode')
  assert.equal(result.filesAdded, 1)
  assert.equal(result.itemsAdded, 0)
  assert.equal(result.library.contents.length, 2)
  assert.equal(getVideo(f.db, id)?.path, path.join(f.root, 'Library/Original Story LEVEL：1 [中文字幕]_720P.mp4'))
  assert.ok(!fs.existsSync(path.join(f.root, 'Library/baoyi.json')), 'a loose work must not claim its shared directory')
  const removal = previewVideoRemoval(f.db, { resourceIds: [id], episodeId: secondId, action: 'remove', deleteLocal: true })
  assert.ok(removal.files.some(file => file.path === second && file.present && !file.shared), 'local removal includes the video')
  fs.unlinkSync(second)
  assert.equal(syncVideoWorkFiles(f.db, id).library.contents.find(ep => ep.id === secondId)!.assets.find(asset => asset.path === second)?.state, 'missing')
})

await test('checking files does not claim an independently registered sibling', f => {
  const id = f.work(1)
  applyVideoCatalogue(f.db, id, f.info())
  const second = f.file('Library/Original Story LEVEL：2 [中文字幕]_720P.mp4')
  const other = registerVideoContent(f.db, { title: 'Independent sibling', items: [{ title: 'Independent sibling', order: 1, files: [{ path: second }] }] }).resourceId
  const result = syncVideoWorkFiles(f.db, id)
  assert.ok(!result.library.contents.some(ep => ep.assets.some(asset => asset.path === second)))
  assert.equal(listEpisodes(f.db, other)[0].path, second)
})

console.log(`Video field retest: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
