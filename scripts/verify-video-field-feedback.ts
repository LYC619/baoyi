import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { insertVideo, getVideo, listEpisodes, type VideoPayload } from '../electron/kinds/video/db.ts'
import { getVideoWorkLibrary } from '../electron/kinds/video/library.ts'
import { createVideoWorkflow } from '../electron/kinds/video/download/workflow.ts'
import { previewVideoOrganize, applyVideoOrganize, rollbackVideoOrganize } from '../electron/kinds/video/organize.ts'
import { linkLegacyEpisode } from '../electron/kinds/video/episode-details.ts'
import { promoteDownloadDirectory } from '../electron/kinds/video/download/placement.ts'
import { writeBundleFiles } from '../electron/kinds/video/bundle.ts'
import type { VideoDirectoryChange } from '../src/types/video-workflow.ts'

let passed = 0, failed = 0
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-field-feedback-'))
  const library = path.join(root, 'Library'), downloads = path.join(root, 'Downloads')
  fs.mkdirSync(library); fs.mkdirSync(downloads)
  const db = new DatabaseSync(path.join(root, 'library.db'))
  db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
  let transfers = 0
  const original = (n: number) => ['First original', 'Second original', '', 'Fourth original'][n - 1]
  const deps = {
    db, downloadsDirectory: () => downloads, libraryRoots: () => [library],
    resolveWork: async (code: string) => {
      const n = Number(code) - 100
      return { videoCode: code, title: 'Example series ' + n, description: 'Description for ' + n, posterUrl: '', tags: [], warnings: [],
        currentEpisode: { videoCode: code, title: 'Example series ' + n, originalTitle: original(n), description: 'Description for ' + n, posterUrl: '' },
        episodes: [4, 2, 1].map(number => ({ videoCode: String(100 + number), title: 'Example series ' + number })) }
    },
    resolveSources: async (code: string) => ({ videoCode: code, title: original(Number(code) - 100), originalTitle: original(Number(code) - 100), description: 'Description for ' + (Number(code) - 100),
      candidates: [{ url: 'https://fixture.invalid/' + code + '.mp4', label: '480p', extension: 'mp4' }], warnings: [] }),
    transfer: async (options: any) => {
      transfers++; fs.writeFileSync(options.destination, 'isolated downloaded video')
      return { destination: options.destination, receivedBytes: 25, totalBytes: 25, phase: 'finalizing' as const, bytesPerSecond: 0, warnings: [] }
    }
  }
  const workflow = createVideoWorkflow(deps)
  function legacy(number = 4) {
    const directory = path.join(library, 'Example series ' + number)
    fs.mkdirSync(directory)
    const file = path.join(directory, original(number) + ' [sub]_720P.mp4')
    fs.writeFileSync(file, 'isolated original video')
    const payload: VideoPayload = {
      path: directory, video_type: 'movie', name_zh: 'Example series ' + number, name_en: original(number),
      summary: 'Description for ' + number, description: 'Description for ' + number, category: '里番', tags: [], official_url: '', source_dir: directory,
      file_size: 23, year: 0, end_year: 0, rating: 0, duration_sec: 90, resolution: '720p', video_codec: '', source: '', release_group: '',
      audio_tracks: [], subtitle_tracks: [], parts: [{ path: file, label: '', file_size: 23, duration_sec: 90 }], linked_files: [],
      tmdb_id: '', imdb_id: '', douban_id: '', douban_rating: 0, hanime_id: String(100 + number), poster_path: '', fanart_path: '', episodes: []
    }
    payload.original_description = 'Original text for ' + number
    const id = insertVideo(db, payload).id
    db.prepare("UPDATE video_meta SET watch_status = 'watching', position_sec = 91 WHERE resource_id = ?").run(id)
    db.prepare('UPDATE resource SET notes = ? WHERE id = ?').run('Notes for ' + number, id)
    return { id, file, directory }
  }
  async function download(draft: any, codes: string[]) {
    const job = workflow.enqueue({ draftId: draft.id, videoCodes: codes, sourceLabel: '', strictQuality: false, register: true })
    await workflow.idle()
    return workflow.list().find(value => value.id === job.id)!
  }
  async function close() {
    await workflow.idle(); db.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('baoyi-field-feedback-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
  return { root, db, library, downloads, workflow, legacy, download, close, transfers: () => transfers }
}
type Fixture = ReturnType<typeof fixture>
async function test(name: string, run: (f: Fixture) => void | Promise<void>) {
  const f = fixture()
  try { await run(f); passed++ }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error instanceof Error ? error.message : error)) }
  finally { await f.close() }
}

await test('directory assets are repaired while genuinely missing video files remain visible', f => {
  const old = f.legacy()
  const missing = path.join(old.directory, 'Missing.mp4')
  for (const file of [old.directory, missing]) f.db.prepare(`INSERT INTO video_assets (id, resource_id, path, role, state, checked_at, created_at)
    VALUES (?, ?, ?, 'video', 'missing', 0, 0)`).run(randomUUID(), old.id, file)
  const library = getVideoWorkLibrary(f.db, old.id)
  assert.ok(!library.assets.some(asset => asset.path === old.directory), 'a directory was exposed as a video')
  assert.ok(library.assets.some(asset => asset.path === old.file && asset.state === 'present'))
  assert.ok(library.assets.some(asset => asset.path === missing && asset.state === 'missing'))
})

await test('new URL downloads default to the configured video library', async f => {
  const draft = await f.workflow.prepare({ url: 'https://hanime1.me/watch?v=104' })
  assert.equal(draft.root, f.library)
  assert.equal(path.basename(draft.directory), 'Example series 1-4')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM resource').get()!.n, 0)
})

await test('a legacy supplement previews its current library and canonical series folder', async f => {
  const old = f.legacy()
  const draft: any = await f.workflow.prepare({ resourceId: old.id })
  assert.equal(draft.root, f.library)
  assert.equal(draft.directory, path.join(f.library, 'Example series 1-4'))
  assert.equal(draft.directoryChange?.from, old.directory)
  assert.ok(fs.existsSync(old.file), 'a preview must not rename original files')
})

await test('legacy local episode is recognized by source ID despite its different original filename', async f => {
  const old = f.legacy()
  const draft = await f.workflow.prepare({ resourceId: old.id })
  assert.equal(draft.episodes.find(episode => episode.videoCode === '104')?.state, 'local')
  assert.deepEqual(draft.episodes.map(episode => episode.order), [1, 2, 4])
  assert.equal(draft.episodes.find(episode => episode.videoCode === '104')?.order, 4)
})

await test('supplement keeps local episode, watch history and references while promoting the folder', async f => {
  const old = f.legacy()
  const draft = await f.workflow.prepare({ resourceId: old.id })
  const done = await f.download(draft, ['102'])
  assert.equal(done.items[0].registration, 'complete', done.items[0].error)
  assert.equal(done.directory, path.join(f.library, 'Example series 1-4'))
  const episodes: any[] = listEpisodes(f.db, old.id)
  const fourth = episodes.find(ep => ep.episode === 4)
  assert.ok(fourth, 'original episode 4 disappeared from the content list')
  assert.equal(fourth.position_sec, 91)
  assert.equal(fourth.watch_status, 'watching')
  assert.equal(fourth.description, 'Description for 4')
  assert.equal(fourth.original_description, 'Original text for 4')
  assert.ok(fs.existsSync(fourth.path))
  assert.equal(path.dirname(fourth.path), done.directory)
  assert.equal(getVideo(f.db, old.id)?.name_zh, 'Example series 1-4')
  assert.equal(getVideo(f.db, old.id)?.name_en, '')
  assert.equal(getVideo(f.db, old.id)?.original_description, '')
  assert.equal(f.transfers(), 1)
  const again = await f.workflow.prepare({ resourceId: old.id })
  assert.deepEqual(again.episodes.filter(ep => ep.state === 'local').map(ep => ep.order), [2, 4])
})

await test('new episode files use the original title and actual episode number', async f => {
  const draft = await f.workflow.prepare({ url: 'https://hanime1.me/watch?v=104' })
  const done = await f.download(draft, ['102'])
  assert.equal(done.items[0].transfer, 'complete', done.items[0].error)
  assert.equal(path.basename(done.items[0].path), 'Second original - E02 480p.mp4')
  const second: any = listEpisodes(f.db, done.resourceId).find(ep => ep.episode === 2)
  assert.equal(second?.original_title, 'Second original')
  assert.equal(second?.description, 'Description for 2')
  const manifest = JSON.parse(fs.readFileSync(path.join(done.directory, 'baoyi.json'), 'utf8'))
  assert.equal(manifest.items.find((ep: any) => ep.number === 2).description, 'Description for 2')
})

await test('occupied canonical directory is never overwritten or bypassed by another download root', async f => {
  const old = f.legacy()
  const occupied = path.join(f.library, 'Example series 1-4'); fs.mkdirSync(occupied)
  const sentinel = path.join(occupied, 'keep.txt'); fs.writeFileSync(sentinel, 'keep')
  const draft = await f.workflow.prepare({ resourceId: old.id })
  const done = await f.download(draft, ['102'])
  assert.equal(done.status, 'failed')
  assert.equal(f.transfers(), 0)
  assert.ok(fs.existsSync(old.file))
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep')
})

await test('collection naming preserves each original description and can be rolled back', async f => {
  const fourth = f.legacy(4), second = f.legacy(2)
  const preview = previewVideoOrganize(f.db, { resourceIds: [fourth.id, second.id], survivorId: fourth.id, collectionTitle: 'Example series' } as any)
  const result = await applyVideoOrganize(f.db, { preview, mode: 'logical' })
  assert.equal(result.status, 'applied')
  assert.equal(getVideo(f.db, fourth.id)?.name_zh, 'Example series')
  const episodes: any[] = listEpisodes(f.db, fourth.id)
  assert.deepEqual(episodes.map(ep => ep.episode), [2, 4])
  assert.equal(episodes.find(ep => ep.episode === 2)?.description, 'Description for 2')
  assert.equal(episodes.find(ep => ep.episode === 4)?.notes, 'Notes for 4')
  assert.ok(fs.existsSync(fourth.file) && fs.existsSync(second.file))
  const rolled = await rollbackVideoOrganize(f.db, result.id)
  assert.equal(rolled.status, 'rolled-back')
  assert.equal(getVideo(f.db, fourth.id)?.name_zh, 'Example series 4')
})

await test('unconfirmed playlist order does not override a legacy episode number', f => {
  const old = f.legacy()
  linkLegacyEpisode(f.db, old.id, [{ videoCode: '104', title: 'Unnumbered caption', order: 1, numbered: false }])
  assert.equal(listEpisodes(f.db, old.id)[0].episode, 4)
})

await test('directory rename recovers when the process stopped before SQLite remapping', f => {
  const old = f.legacy(), target = path.join(f.library, 'Example series')
  const identity = fs.lstatSync(old.directory)
  const change: VideoDirectoryChange = { from: old.directory, to: target, identity: { dev: identity.dev, ino: identity.ino } }
  fs.renameSync(old.directory, target)
  promoteDownloadDirectory(f.db, old.id, change, () => {})
  assert.equal(getVideo(f.db, old.id)?.path, target)
  assert.equal(change.applied, true)
  assert.ok(fs.existsSync(path.join(target, path.basename(old.file))))
})

await test('a SQLite error restores the original folder; retry safely completes', f => {
  const old = f.legacy(), target = path.join(f.library, 'Example series')
  const change: VideoDirectoryChange = { from: old.directory, to: target }
  f.db.exec("CREATE TRIGGER fail_promotion BEFORE UPDATE OF path ON resource BEGIN SELECT RAISE(ABORT, 'simulated database failure'); END")
  assert.throws(() => promoteDownloadDirectory(f.db, old.id, change, () => {}), /simulated database failure/)
  assert.ok(fs.existsSync(old.file))
  assert.equal(getVideo(f.db, old.id)?.path, old.directory)
  f.db.exec('DROP TRIGGER fail_promotion')
  promoteDownloadDirectory(f.db, old.id, change, () => {})
  assert.equal(getVideo(f.db, old.id)?.path, target)
})

await test('journal failure after SQLite commit does not roll back a released savepoint or lose files', f => {
  const old = f.legacy(), target = path.join(f.library, 'Example series')
  const change: VideoDirectoryChange = { from: old.directory, to: target }
  let persisted: VideoDirectoryChange | undefined
  assert.throws(() => promoteDownloadDirectory(f.db, old.id, change, () => {
    if (change.applied) throw new Error('simulated journal failure')
    persisted = structuredClone(change)
  }), /simulated journal failure/)
  assert.equal(getVideo(f.db, old.id)?.path, target)
  assert.ok(fs.existsSync(path.join(target, path.basename(old.file))))
  promoteDownloadDirectory(f.db, old.id, persisted!, () => {})
  assert.equal(persisted?.applied, true)
})

await test('existing single-episode rows inherit their donor descriptions and notes before collection rename', async f => {
  const fourth = f.legacy(4), second = f.legacy(2)
  getVideoWorkLibrary(f.db, fourth.id); getVideoWorkLibrary(f.db, second.id)
  f.db.exec("UPDATE episode SET description = '', original_title = '', notes = ''")
  const preview = previewVideoOrganize(f.db, { resourceIds: [fourth.id, second.id], survivorId: fourth.id, collectionTitle: 'Example series' })
  const result = await applyVideoOrganize(f.db, { preview, mode: 'logical' })
  assert.equal(result.status, 'applied')
  assert.equal(listEpisodes(f.db, fourth.id).find(ep => ep.episode === 4)?.description, 'Description for 4')
  assert.equal(listEpisodes(f.db, fourth.id).find(ep => ep.episode === 2)?.notes, 'Notes for 2')
  const rollback = await rollbackVideoOrganize(f.db, result.id)
  assert.equal(rollback.status, 'rolled-back')
  assert.equal(listEpisodes(f.db, fourth.id)[0].description, '')
})

await test('copying a collection exports independent descriptions in the portable manifest', async f => {
  const fourth = f.legacy(4), second = f.legacy(2), target = path.join(f.library, 'Collected')
  const preview = previewVideoOrganize(f.db, { resourceIds: [fourth.id, second.id], survivorId: fourth.id, collectionTitle: 'Example series', targetDirectory: target })
  const result = await applyVideoOrganize(f.db, { preview, mode: 'physical' })
  assert.equal(result.status, 'applied', JSON.stringify(result.conflicts))
  const bundle = JSON.parse(fs.readFileSync(path.join(target, 'baoyi.json'), 'utf8'))
  assert.equal(bundle.items.find((ep: any) => ep.number === 4).description, 'Description for 4')
  assert.equal(bundle.items.find((ep: any) => ep.number === 2).notes, 'Notes for 2')
  assert.equal(bundle.items.find((ep: any) => ep.number === 4).original_description, 'Original text for 4')
  assert.equal(bundle.work.title, 'Example series')
})

await test('source-linked manifest numbering follows confirmed episode repair', f => {
  const old = f.legacy()
  const input = { directory: old.directory, title: 'Example series', files: [{ path: old.file, title: 'Example series 4', order: 1, number: 1, sourceId: '104' }] }
  writeBundleFiles(input)
  const written = writeBundleFiles({ ...input, files: [{ ...input.files[0], order: 4, number: 4 }] })
  assert.equal(written.bundle.items.length, 1)
  assert.equal(written.bundle.items[0].number, 4)
  assert.equal(written.bundle.items[0].order, 4)
})

await test('metadata-only retry fills an already registered episode without downloading again', async f => {
  const draft = await f.workflow.prepare({ url: 'https://hanime1.me/watch?v=104' })
  const done = await f.download(draft, ['102'])
  f.db.prepare("UPDATE episode SET description = '' WHERE resource_id = ?").run(done.resourceId)
  f.workflow.retry(done.id, 'metadata'); await f.workflow.idle()
  assert.equal(listEpisodes(f.db, done.resourceId).find(ep => ep.episode === 2)?.description, 'Description for 2')
  assert.equal(f.transfers(), 1)
})

await test('a promoted series updates a legacy single-episode bundle title', async f => {
  const old = f.legacy()
  writeBundleFiles({ directory: old.directory, title: 'Example series 4', description: 'Description for 4', files: [{ path: old.file, title: 'Example series 4', order: 1, number: 1, sourceId: '104' }] })
  const draft = await f.workflow.prepare({ resourceId: old.id })
  const done = await f.download(draft, ['102'])
  assert.equal(done.items[0].registration, 'complete', done.items[0].error)
  const bundle = JSON.parse(fs.readFileSync(path.join(done.directory, 'baoyi.json'), 'utf8'))
  assert.equal(bundle.work.title, 'Example series 1-4')
  assert.equal(bundle.work.description, '')
  assert.equal(bundle.items.find((episode: any) => episode.number === 4).description, 'Description for 4')
})

await test('copying a collection keeps each episode poster linked to the copied file', async f => {
  const fourth = f.legacy(4), second = f.legacy(2)
  for (const [entry, number] of [[fourth, 4], [second, 2]] as const) {
    const poster = path.join(entry.directory, 'cover-' + number + '.png')
    fs.writeFileSync(poster, 'isolated fixture poster ' + number)
    f.db.prepare('UPDATE video_meta SET poster_path = ? WHERE resource_id = ?').run(poster, entry.id)
  }
  const target = path.join(f.library, 'Collected')
  const preview = previewVideoOrganize(f.db, { resourceIds: [fourth.id, second.id], survivorId: fourth.id, collectionTitle: 'Example series', targetDirectory: target })
  const result = await applyVideoOrganize(f.db, { preview, mode: 'physical' })
  assert.equal(result.status, 'applied', JSON.stringify(result.conflicts))
  for (const episode of listEpisodes(f.db, fourth.id)) {
    assert.ok(path.relative(target,episode.poster_path!).startsWith('.baoyi' + path.sep + 'artwork'))
    assert.ok(fs.existsSync(episode.poster_path!))
  }
  const bundle = JSON.parse(fs.readFileSync(path.join(target, 'baoyi.json'), 'utf8'))
  assert.ok(bundle.items.every((episode: any) => episode.poster))
})

console.log('Video field feedback: ' + passed + ' passed / ' + failed + ' failed')
if (failed) process.exitCode = 1
