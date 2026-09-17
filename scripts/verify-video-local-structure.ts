import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { getVideo, listEpisodes, type VideoPayload } from '../electron/kinds/video/db.ts'
import { catalogueIdentity, episodeFilename, numberedEpisode } from '../electron/kinds/video/episode-identity.ts'
import { registerVideoContent, registerVideoPayload, registerVideoBundle } from '../electron/kinds/video/registration.ts'
import { getVideoWorkLibrary } from '../electron/kinds/video/library.ts'
import { readVideoBundle, writeBundleFiles } from '../electron/kinds/video/bundle.ts'
import { videoEpisodeLabel } from '../src/utils/video-content.ts'
import { syncVideoWorkFiles } from '../electron/kinds/video/local-sync.ts'
import { applyVideoCatalogue } from '../electron/kinds/video/catalogue.ts'
import { previewVideoCollectionName, renameVideoCollection } from '../electron/kinds/video/collection-name.ts'
import { createVideoWorkflow } from '../electron/kinds/video/download/workflow.ts'
import { createVideoJobStore } from '../electron/kinds/video/download/jobs.ts'
import type { VideoDownloadJob } from '../src/types/video-workflow.ts'

let passed = 0, failed = 0
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-local-structure-'))
  const directory = path.join(root, 'Library', 'Example 4')
  fs.mkdirSync(directory, { recursive: true })
  const db = new DatabaseSync(path.join(root, 'library.db'))
  db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
  const ref = (number: number) => ({ provider: 'hanime', externalId: String(100 + number), scope: 'episode' as const, pageUrl: 'https://hanime1.me/watch?v=' + (100 + number), evidence: 'bundle' as const })
  const file = (number: number) => {
    const filePath = path.join(directory, `Original lesson ${number} [${100 + number}] 720p.mp4`)
    fs.writeFileSync(filePath, 'synthetic media ' + number)
    return filePath
  }
  const files = [2, 3, 4].map(number => ({ path: file(number), title: 'Example ' + number, order: number, number,
    sourceId: String(100 + number), size: 17, originalTitle: 'Original lesson ' + number, description: 'Independent description ' + number }))
  const bundle = writeBundleFiles({ directory, title: 'Example 0-4', descriptionOptional: true, sources: [0, 1, 2, 3, 4].map(ref), files }).bundle
  const registered = registerVideoBundle(db, directory)
  const id = registered.resourceId
  function payload(number: number): VideoPayload {
    const filePath = files.find(file => file.number === number)!.path
    return { path: filePath, video_type: 'movie', name_zh: 'Example ' + number, name_en: 'Refreshed original ' + number,
      summary: 'Refreshed summary ' + number, description: 'Refreshed description ' + number, category: '其他', tags: [],
      official_url: ref(number).pageUrl, source_dir: directory, file_size: 17, year: 0, end_year: 0, rating: 0,
      duration_sec: 90, resolution: '720p', video_codec: '', source: '', release_group: '', audio_tracks: [], subtitle_tracks: [],
      parts: [{ path: filePath, label: '', file_size: 17, duration_sec: 90 }], linked_files: [], tmdb_id: '', imdb_id: '',
      douban_id: '', douban_rating: 0, hanime_id: String(100 + number), poster_path: '', fanart_path: '', episodes: [] }
  }
  function close() {
    db.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('baoyi-local-structure-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
  return { root, directory, db, id, files, bundle, file, ref, payload, close }
}
async function test(name: string, run: (f: ReturnType<typeof fixture>) => void | Promise<void>) {
  const f = fixture()
  try { await run(f); passed++; console.log('PASS ' + name) }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error instanceof Error ? error.message : String(error))) }
  finally { f.close() }
}

await test('a later prequel stays episode zero; an unnumbered first entry stays episode one', () => {
  const entries = [0, 4, 3, 2, 1].map(number => ({ videoCode: String(100 + number), title: 'Example' + (number === 1 ? '' : ' ' + number) }))
  const catalogue = catalogueIdentity('Example 4', entries)
  assert.deepEqual(catalogue.episodes.map(episode => [episode.videoCode, episode.order, episode.numbered]),
    [0, 1, 2, 3, 4].map(number => [String(100 + number), number, true]))
  assert.equal(numberedEpisode('Example 第零集')?.number, 0)
})

await test('episode zero is visible and keeps E00 in its filename', () => {
  assert.match(episodeFilename('Prologue', 0, '720p', 'mp4'), /E00/)
  assert.equal(videoEpisodeLabel({ season: 0, episode: 0, display_label: '' }), '第 0 集')
})

await test('a Japanese playlist and a Chinese zero-with-subtitle still resolve to zero through four', () => {
  const entries = [{ videoCode: '100', title: 'Example・零 -A prequel-' }, ...[1, 2, 3, 4].map(number => ({ videoCode: String(100 + number), title: 'Example・輪迴 ' + number }))]
  const catalogue = catalogueIdentity('エグザンプル・輪廻', entries)
  assert.equal(catalogue.title, 'Example・輪迴')
  assert.deepEqual(catalogue.episodes.map(ep => ep.order), [0, 1, 2, 3, 4])
  assert.ok(catalogue.episodes.every(ep => ep.numbered))
})

await test('scraping one managed episode cannot replace the work title or split its ownership', f => {
  const before = listEpisodes(f.db, f.id)
  const third = before.find(episode => episode.episode === 3)!
  f.db.prepare("UPDATE episode SET watch_status = 'watching', position_sec = 91 WHERE id = ?").run(third.id)
  for (const number of [2, 3]) {
    const result = registerVideoPayload(f.db, f.payload(number), f.id)
    assert.equal(result.id, f.id)
    assert.equal(getVideo(f.db, f.id)?.name_zh, 'Example 0-4')
    assert.equal(getVideo(f.db, f.id)?.path, f.directory)
    assert.equal(getVideo(f.db, f.id)?.video_type, 'series')
  }
  const after = listEpisodes(f.db, f.id)
  assert.deepEqual(after.map(episode => episode.id), before.map(episode => episode.id))
  assert.equal(after.find(episode => episode.id === third.id)?.position_sec, 91)
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM resource WHERE kind = 'video' AND is_archived = 0").get()!.n, 1)
})

await test('a moved bundle reattaches existing episode identities after the old directory disappears', f => {
  const before = listEpisodes(f.db, f.id)
  const target = path.join(path.dirname(f.directory), 'Example 0-4')
  assert.equal(path.dirname(target), path.dirname(f.directory))
  fs.renameSync(f.directory, target)
  const result = registerVideoBundle(f.db, target)
  assert.equal(result.resourceId, f.id)
  assert.deepEqual(listEpisodes(f.db, f.id).map(episode => episode.id), before.map(episode => episode.id))
  const library = getVideoWorkLibrary(f.db, f.id)
  assert.equal(library.directory?.path, target)
  assert.ok(library.assets.every(asset => fs.existsSync(asset.path)))
})

await test('reimporting a bundle discovers a manually added video beyond the old manifest', f => {
  const first = f.file(1)
  registerVideoBundle(f.db, f.directory)
  const library = getVideoWorkLibrary(f.db, f.id)
  assert.ok(library.assets.some(asset => asset.path === first && asset.state === 'present'))
  assert.equal(library.assets.filter(asset => asset.role === 'video').length, 4)
})

await test('each local video has portable episode metadata beside it', f => {
  for (const file of f.files) {
    const sidecar = file.path.replace(/\.[^.]+$/, '.baoyi.json')
    assert.ok(fs.existsSync(sidecar), 'missing episode sidecar')
    const metadata = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
    assert.equal(metadata.bundle_id, f.bundle.bundle_id)
    assert.equal(metadata.episode.number, file.number)
    assert.equal(metadata.episode.description, file.description)
  }
  assert.equal(readVideoBundle(f.directory)?.items.length, 3)
})

await test('local sync reports new files and writes their portable records', f => {
  const first = f.file(1)
  const result = syncVideoWorkFiles(f.db, f.id, { roots: [path.dirname(f.directory)] })
  assert.equal(result.filesAdded, 1)
  assert.match(result.message, /新增 1 个视频/)
  assert.ok(fs.existsSync(first.replace(/\.[^.]+$/, '.baoyi.json')))
  assert.equal(syncVideoWorkFiles(f.db, f.id).filesAdded, 0)
})

await test('unknown numbering cannot replace a known episode or duplicate the same file', f => {
  const before = listEpisodes(f.db, f.id).find(ep => ep.episode === 4)!
  registerVideoContent(f.db, { resourceId: f.id, title: 'Example', directory: f.directory,
    items: [{ title: 'Unnumbered original', number: -1, order: 1, files: [{ path: before.path }] }] })
  assert.equal(listEpisodes(f.db, f.id).length, 3)
  assert.equal(listEpisodes(f.db, f.id).find(ep => ep.id === before.id)?.episode, 4)
})

await test('a wrong source cannot silently move another episode into a known file', f => {
  const before = listEpisodes(f.db, f.id)
  const wrong = f.payload(2); wrong.hanime_id = '103'
  assert.throws(() => registerVideoPayload(f.db, wrong), /不同单集|来源/)
  wrong.hanime_id = '999'
  assert.throws(() => registerVideoPayload(f.db, wrong), /来源/)
  assert.deepEqual(listEpisodes(f.db, f.id), before)
})

await test('old duplicate cards merge metadata and progress by the same media identity', f => {
  const payload = f.payload(3)
  payload.path = path.join(f.root, 'Removed download', path.basename(payload.path))
  payload.source_dir = path.dirname(payload.path)
  payload.parts = [{ ...payload.parts[0], path: payload.path }]
  const donor = registerVideoPayload(f.db, payload)
  assert.notEqual(donor.id, f.id)
  f.db.prepare("UPDATE video_meta SET watch_status = 'watching', position_sec = 151 WHERE resource_id = ?").run(donor.id)
  const target = listEpisodes(f.db, f.id).find(ep => ep.episode === 3)!
  f.db.prepare("UPDATE episode SET watch_status = 'watching', position_sec = 91 WHERE id = ?").run(target.id)
  const result = registerVideoBundle(f.db, f.directory)
  assert.equal(result.duplicatesMerged, 1)
  assert.equal(listEpisodes(f.db, f.id).find(ep => ep.id === target.id)?.position_sec, 151)
  assert.equal(getVideo(f.db, donor.id)?.is_archived, true)
  assert.equal(listEpisodes(f.db, f.id).find(ep => ep.episode === 2)?.position_sec, 0)
  assert.equal(registerVideoBundle(f.db, f.directory).duplicatesMerged, 0)
})

await test('adjacent records restore episodes and history when the main index is lost', f => {
  const fourth = listEpisodes(f.db, f.id).find(ep => ep.episode === 4)!
  f.db.prepare("UPDATE episode SET watch_status = 'watching',position_sec = 123 WHERE id = ?").run(fourth.id)
  syncVideoWorkFiles(f.db, f.id)
  fs.unlinkSync(path.join(f.directory, 'baoyi.json'))
  const restored = new DatabaseSync(':memory:')
  try {
    restored.exec('PRAGMA foreign_keys = ON'); initSchema(restored, KINDS)
    const result = registerVideoBundle(restored, f.directory)
    assert.equal(listEpisodes(restored, result.resourceId).length, 3)
    assert.equal(listEpisodes(restored, result.resourceId).find(ep => ep.id === fourth.id)?.position_sec, 123)
  } finally { restored.close() }
})

await test('manually edited episode files remain intact when saving fresh metadata', f => {
  syncVideoWorkFiles(f.db, f.id)
  const sidecar = f.files[0].path.replace(/\.[^.]+$/, '.baoyi.json')
  const data = JSON.parse(fs.readFileSync(sidecar, 'utf8')); data.episode.notes = 'User notes outside the app'
  const edited = JSON.stringify(data); fs.writeFileSync(sidecar, edited)
  syncVideoWorkFiles(f.db, f.id)
  assert.equal(fs.readFileSync(sidecar, 'utf8'), edited)
})

await test('confirmed episode zero remains missing while episodes one to four keep their identities', f => {
  f.file(1)
  syncVideoWorkFiles(f.db, f.id)
  const before = listEpisodes(f.db, f.id)
  const result = applyVideoCatalogue(f.db, f.id, { videoCode: '104', title: 'Example 4', description: 'Fourth description',
    posterUrl: '', tags: [], warnings: [], currentEpisode: { videoCode: '104', title: 'Example 4', originalTitle: 'Original fourth', description: 'Fourth description' },
    episodes: [0, 4, 3, 2, 1].map(number => ({ videoCode: String(100 + number), title: 'Example' + (number === 1 ? '' : ' ' + number) })) })
  assert.equal(result.title, 'Example 0-4')
  assert.deepEqual(listEpisodes(f.db, f.id).map(ep => ep.episode), [0, 1, 2, 3, 4])
  assert.equal(listEpisodes(f.db, f.id)[0].path, '')
  for (const ep of before) assert.ok(listEpisodes(f.db, f.id).some(current => current.id === ep.id))
  syncVideoWorkFiles(f.db, f.id)
  const saved = readVideoBundle(f.directory)!
  assert.equal(saved.items.find(ep => ep.number === 0)?.files.length, 0)
  assert.equal(saved.items.filter(ep => ep.files.length).length, 4)
})

await test('collection renaming changes the directory and portable titles without losing file history', f => {
  const before = listEpisodes(f.db, f.id)
  f.db.prepare("UPDATE episode SET watch_status = 'watching',position_sec = 234 WHERE id = ?").run(before[0].id)
  const preview = previewVideoCollectionName(f.db, f.id, 'Example 0-4', [path.dirname(f.directory)])
  assert.equal(preview.to, path.join(path.dirname(f.directory), 'Example 0-4'))
  assert.ok(fs.existsSync(f.files[0].path))
  const result = renameVideoCollection(f.db, f.id, 'Example 0-4', [path.dirname(f.directory)])
  assert.ok(!fs.existsSync(f.directory))
  const after = listEpisodes(f.db, f.id)
  assert.deepEqual(after.map(ep => ep.id), before.map(ep => ep.id))
  assert.equal(after[0].position_sec, 234)
  assert.ok(after.every(ep => fs.readFileSync(ep.path, 'utf8') === 'synthetic media ' + ep.episode))
  assert.equal(readVideoBundle(result.to)?.work.title, 'Example 0-4')
  assert.ok(after.every(ep => JSON.parse(fs.readFileSync(ep.path.replace(/\.[^.]+$/, '.baoyi.json'), 'utf8')).work_title === 'Example 0-4'))
  assert.equal(syncVideoWorkFiles(f.db, f.id).filesAdded, 0)
})

await test('collection naming never replaces another folder or renames the library root', f => {
  const occupied = path.join(path.dirname(f.directory), 'Occupied'); fs.mkdirSync(occupied)
  assert.throws(() => renameVideoCollection(f.db, f.id, 'Occupied'), /已存在/)
  assert.throws(() => previewVideoCollectionName(f.db, f.id, 'Example', [f.directory]), /根目录/)
  assert.ok(fs.existsSync(f.files[0].path))
})

await test('saved download retries follow renamed and relocated collections without downloading again', async f => {
  const job: VideoDownloadJob = {
    id: 'saved-download', resourceId: f.id, bundleId: f.bundle.bundle_id, title: 'Example 4', category: '其他', videoCode: '102',
    root: path.dirname(f.directory), directory: f.directory, sourceLabel: '720p', strictQuality: false, register: true,
    status: 'partial', createdAt: Date.now(), updatedAt: Date.now(), message: '', description: '', posterUrl: '', posterPath: '',
    sources: [f.ref(2)], warnings: [], episodeMetadata: true,
    items: [{ videoCode: '102', title: 'Example 2', order: 2, path: f.files[0].path, sourceLabel: '720p', transfer: 'complete',
      metadata: 'failed', registration: 'complete', receivedBytes: 17, totalBytes: 17, error: '', warnings: [] }]
  }
  createVideoJobStore(f.db).save(job)
  let transfers = 0
  const workflow = createVideoWorkflow({ db: f.db, downloadsDirectory: () => path.dirname(f.directory), libraryRoots: () => [path.dirname(f.directory)],
    resolveWork: async code => ({ videoCode: code, title: 'Example 2', description: 'Source description', posterUrl: '', tags: [], warnings: [],
      currentEpisode: { videoCode: code, title: 'Example 2', originalTitle: 'Original lesson 2', description: 'Second lesson' }, episodes: [{ videoCode: code, title: 'Example 2' }] }),
    resolveSources: async () => { throw new Error('A metadata retry must not resolve video downloads') },
    transfer: async () => { transfers++; throw new Error('A metadata retry must not transfer media') }
  })
  try {
    const renamed = renameVideoCollection(f.db, f.id, 'My collection 0-4', [path.dirname(f.directory)])
    assert.equal(workflow.list()[0].directory, renamed.to)
    for (const directory of [renamed.to, path.join(path.dirname(f.directory), 'Moved collection')]) {
      if (directory !== renamed.to) {
        assert.equal(path.dirname(directory), path.dirname(renamed.to))
        fs.renameSync(renamed.to, directory)
        syncVideoWorkFiles(f.db, f.id, { roots: [path.dirname(f.directory)] })
      }
      assert.equal(workflow.list()[0].directory, directory)
      workflow.retry(job.id, 'metadata'); await workflow.idle()
      const updated = workflow.list()[0]
      assert.equal(updated.directory, directory)
      assert.equal(updated.items[0].path, path.join(directory, path.basename(f.files[0].path)))
      assert.equal(updated.items[0].error, '')
      assert.equal(updated.items[0].registration, 'complete')
      assert.equal(readVideoBundle(directory)?.work.title, 'My collection 0-4')
      assert.ok(!fs.existsSync(f.directory))
    }
    assert.equal(transfers, 0)
  } finally { await workflow.idle() }
})

console.log(`Video local structure: ${passed} passed / ${failed} failed`)
if (failed) process.exitCode = 1
