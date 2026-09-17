import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent, registerVideoPayload } from '../electron/kinds/video/registration.ts'
import { getVideo, listEpisodes, videoOwnerForFiles, type VideoPayload } from '../electron/kinds/video/db.ts'
import { resolveVideoOwnership } from '../electron/kinds/video/identity.ts'
import { getVideoWorkLibrary } from '../electron/kinds/video/library.ts'
import { applyVideoOrganize, previewVideoOrganize, rollbackVideoOrganize } from '../electron/kinds/video/organize.ts'
import { createVideoWorkflow } from '../electron/kinds/video/download/workflow.ts'
import type { VideoSourceRef } from '../src/types/video-library.ts'

let passed = 0, failed = 0
const source = (code: string): VideoSourceRef => ({ provider: 'hanime', externalId: code, scope: 'episode', pageUrl: 'https://hanime1.me/watch?v=' + code, evidence: 'confirmed' })
async function test(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => void | Promise<void>, mode: 'logical' | 'physical' = 'logical') {
  const f = await fixture(mode)
  try { await run(f); passed++ }
  catch (error) { failed++; console.error('FAIL', name, error) }
  finally {
    f.db.close()
    assert.equal(path.dirname(path.resolve(f.root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(f.root).startsWith('baoyi-organize-integration-'))
    fs.rmSync(f.root, { recursive: true, force: true })
  }
}
async function fixture(mode: 'logical' | 'physical') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-organize-integration-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
  function work(code: string, number: number) {
    const directory = path.join(root, 'works', code); fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, code + '.mp4'); fs.writeFileSync(file, 'isolated-video-' + code)
    const input = { title: code, directory, root, sources: [source(code)], items: [{ title: 'Content ' + number, order: number, season: 1, number, sources: [source(code)], files: [{ path: file }] }] }
    const result = registerVideoContent(db, input)
    return { ...result, input, file, directory, episodeId: listEpisodes(db, result.resourceId)[0].id }
  }
  const a = work('101', 1), b = work('102', 2)
  db.prepare("UPDATE resource SET name_zh = 'Chosen work', notes = 'Keep my notes' WHERE id = ?").run(a.resourceId)
  db.prepare("UPDATE episode SET position_sec = 91, watch_status = 'watching' WHERE id = ?").run(b.episodeId)
  const journal = await applyVideoOrganize(db, { preview: previewVideoOrganize(db, { resourceIds: [a.resourceId, b.resourceId], survivorId: a.resourceId, targetDirectory: a.directory, root }), mode })
  assert.equal(journal.status, 'applied')
  return { root, db, a, b, journal }
}

await test('donor directory and source resolve to one surviving work', f => {
  const result = resolveVideoOwnership(f.db, { title: 'Old title', sources: [source('102')], directory: f.b.directory })
  assert.equal(result.state, 'known')
  assert.equal(result.resourceId, f.a.resourceId)
  assert.equal(result.directory?.path, f.a.directory)
})
await test('old resource IDs and file paths open the surviving library', f => {
  assert.equal(videoOwnerForFiles(f.db, [f.b.file])?.id, f.a.resourceId)
  const library = getVideoWorkLibrary(f.db, f.b.resourceId)
  assert.equal(library.resourceId, f.a.resourceId)
  assert.equal(library.contents.length, 2)
})
await test('reimporting a donor preserves the chosen binding, history and identities', f => {
  const result = registerVideoContent(f.db, { ...f.b.input, resourceId: f.b.resourceId, bundleId: f.b.bundleId })
  assert.equal(result.resourceId, f.a.resourceId)
  assert.equal(result.created, false)
  assert.equal(result.itemsAdded, 0)
  assert.equal(getVideo(f.db, f.a.resourceId)?.path, f.a.directory)
  assert.equal(getVideo(f.db, f.a.resourceId)?.name_zh, 'Chosen work')
  assert.equal(listEpisodes(f.db, f.a.resourceId).find(e => e.id === f.b.episodeId)?.position_sec, 91)
  assert.equal(getVideo(f.db, f.b.resourceId)?.is_archived, true)
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM resource WHERE is_archived = 0").get()!.n, 1)
})
await test('rescanning old donor facts does not split the merged work again', f => {
  const payload: VideoPayload = { path: f.b.directory, video_type: 'series', name_zh: 'Outdated donor name', name_en: '', summary: '', description: '', category: '其他', tags: [], official_url: '', source_dir: f.b.directory, file_size: 18, year: 0, end_year: 0, rating: 0, duration_sec: 0, resolution: '', video_codec: '', source: '', release_group: '', audio_tracks: [], subtitle_tracks: [], parts: [], linked_files: [], tmdb_id: '', imdb_id: '', douban_id: '', douban_rating: 0, poster_path: '', fanart_path: '', episodes: [{ season: 1, episode: 2, title: 'Old content', path: f.b.file, file_size: 18 }] }
  const result = registerVideoPayload(f.db, payload)
  assert.equal(result.id, f.a.resourceId)
  assert.equal(result.created, false)
  assert.equal(getVideo(f.db, f.a.resourceId)?.name_zh, 'Chosen work')
  assert.equal(getVideo(f.db, f.a.resourceId)?.path, f.a.directory)
  assert.equal(listEpisodes(f.db, f.a.resourceId).length, 2)
  assert.equal(getVideoWorkLibrary(f.db, f.a.resourceId).directory?.root, f.root)
})
await test('download drafts opened from an archived donor use survivor directory', async f => {
  const workflow = createVideoWorkflow({ db: f.db, downloadsDirectory: () => f.root,
    resolveWork: async code => ({ videoCode: code, title: 'Source title', description: '', posterUrl: '', tags: [], warnings: [], episodes: [{ videoCode: code, title: 'Content' }] }),
    resolveSources: async () => { throw new Error('not needed for preview') }, transfer: async () => { throw new Error('no transfer in this test') } })
  const draft = await workflow.prepare({ resourceId: f.b.resourceId })
  assert.equal(draft.resourceId, f.a.resourceId)
  assert.equal(draft.directory, f.a.directory)
})
await test('a second copy with the donor bundle ID still requires explicit relocation', f => {
  const copy = path.join(f.root, 'other-copy'); fs.mkdirSync(copy)
  assert.throws(() => registerVideoContent(f.db, { ...f.b.input, directory: copy, bundleId: f.b.bundleId }), /副本|另一目录/)
})
await test('rollback restores donor directory ownership without losing later watch data', async f => {
  const restored = await rollbackVideoOrganize(f.db, f.journal.id)
  assert.equal(restored.status, 'rolled-back')
  assert.equal(resolveVideoOwnership(f.db, { title: 'Donor', directory: f.b.directory }).resourceId, f.b.resourceId)
  assert.equal(listEpisodes(f.db, f.b.resourceId)[0].position_sec, 91)
})
await test('reimporting retained originals after physical organization keeps published file identities', f => {
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM video_assets WHERE resource_id = ?').get(f.a.resourceId)!.n
  const published = listEpisodes(f.db, f.a.resourceId).find(ep => ep.id === f.b.episodeId)!.path
  assert.notEqual(published, f.b.file)
  const result = registerVideoContent(f.db, { ...f.b.input, resourceId: f.b.resourceId, bundleId: f.b.bundleId })
  assert.equal(result.itemsAdded, 0)
  assert.equal(result.filesAdded, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_assets WHERE resource_id = ?').get(f.a.resourceId)!.n, before)
  assert.equal(listEpisodes(f.db, f.a.resourceId).find(ep => ep.id === f.b.episodeId)!.path, published)
}, 'physical')
console.log(`organize integration: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
