import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { migratePosterStorage, resolvePosterDirectory } from '../electron/services/poster-storage.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { getVideo, listEpisodes, updateEpisode } from '../electron/kinds/video/db.ts'
import { applyVideoOrganize, previewVideoOrganize, rollbackVideoOrganize } from '../electron/kinds/video/organize.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { pngImage } from './helpers/test-images.ts'

let passed = 0, failed = 0
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-poster-storage-'))
  const legacy = path.join(root, 'old-profile', 'posters'), target = path.join(root, 'project', 'data', 'posters')
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS); db.exec(VIDEO_JOBS_SQL)
  const file = (relative: string, bytes: string | Buffer = pngImage(90, 135)) => { const p = path.join(root, relative); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p }
  const work = (number: number, poster = file('old-profile/posters/portrait.png')) => registerVideoContent(db, {
    title: '迁移演示 ' + number, posterPath: poster, items: [{ title: '单集 ' + number, number, order: number, posterPath: poster,
      sources: [{ provider: 'fixture', externalId: String(number), scope: 'episode', pageUrl: '', evidence: 'confirmed' }],
      attachments: [{ path: poster, role: 'poster' }], files: [{ path: file('videos/Episode ' + number + '.mp4', 'synthetic media ' + number) }] }]
  }).resourceId
  return { root, legacy, target, db, file, work, migrate: () => migratePosterStorage(db, legacy, target), close: () => {
    db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('baoyi-poster-storage-')); fs.rmSync(root, { recursive: true, force: true })
  } }
}
async function test(name: string, run: (f: ReturnType<typeof fixture>) => void | Promise<void>) {
  const f = fixture()
  try { await run(f); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []); passed++ }
  catch (cause) { failed++; console.error('FAIL ' + name + ': ' + (cause instanceof Error ? cause.message : cause)) }
  finally { f.close() }
}
function inside(directory: string, file: string) { const relative = path.relative(directory, file); return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }

await test('a packaged build under the checkout uses project data/posters', f => {
  f.file('project/package.json', JSON.stringify({ name: 'baoyi' }))
  fs.mkdirSync(path.join(f.root, 'project/src')); fs.mkdirSync(path.join(f.root, 'project/electron'))
  const exePath = f.file('project/release/version/win-unpacked/抱一.exe', '')
  assert.equal(resolvePosterDirectory({ exePath, appPath: path.join(path.dirname(exePath), 'resources/app.asar'), userDataPath: path.dirname(f.legacy) }), f.target)
})
await test('an external package keeps images beside its executable', f => {
  const exePath = f.file('standalone/抱一.exe', '')
  assert.equal(resolvePosterDirectory({ exePath, appPath: path.join(path.dirname(exePath), 'resources/app.asar'), userDataPath: path.dirname(f.legacy) }), path.join(path.dirname(exePath), 'data/posters'))
})
await test('explicit profiles and portable data remain isolated', f => {
  const context = { exePath: path.join(f.root, 'app/抱一.exe'), appPath: path.join(f.root, 'app'), userDataPath: path.dirname(f.legacy) }
  assert.equal(resolvePosterDirectory({ ...context, explicitUserData: true }), f.legacy)
  assert.equal(resolvePosterDirectory({ ...context, portable: true }), f.legacy)
  assert.deepEqual(migratePosterStorage(f.db, f.legacy, f.legacy), { copied: 0, removed: 0, updated: 0, warnings: [] })
})
await test('migration updates images, assets, nested jobs and keeps unrelated originals', f => {
  const poster = f.file('old-profile/posters/portrait.png'), thumbnail = f.file('old-profile/posters/thumbnail.png', pngImage(160, 90))
  const outside = f.file('videos/user-original.png'), unrelated = f.file('old-profile/posters/keep.txt', 'unrelated')
  const id = f.work(1, poster), episode = listEpisodes(f.db, id)[0]
  f.db.prepare('UPDATE resource SET icon_path = ? WHERE id = ?').run(poster, id)
  f.db.prepare('UPDATE video_meta SET thumbnail_path = ?, fanart_path = ?, linked_files = ? WHERE resource_id = ?').run(thumbnail, outside, JSON.stringify([{ path: poster, role: 'poster' }]), id)
  updateEpisode(f.db, episode.id, { thumbnail_path: thumbnail, notes: '保留笔记', position_sec: 42 })
  const job = { id: 'job', posterPath: poster, items: [{ posterPath: thumbnail, path: episode.path }], journal: JSON.stringify({ before: { poster_path: poster } }), sourceUrl: 'https://example.test/poster.png' }
  f.db.prepare('INSERT INTO video_download_jobs VALUES (?, ?, ?, ?)').run('job', 'completed', 0, JSON.stringify(job))
  const result = f.migrate()
  assert.equal(result.copied, 2); assert.equal(result.removed, 2); assert.deepEqual(result.warnings, [])
  const work = getVideo(f.db, id)!, ep = listEpisodes(f.db, id)[0]
  assert.ok(inside(f.target, work.poster_path)); assert.ok(work.thumbnail_path && inside(f.target, work.thumbnail_path)); assert.equal(work.fanart_path, outside)
  assert.equal(ep.poster_path, work.poster_path); assert.equal(ep.thumbnail_path, work.thumbnail_path)
  assert.equal(ep.notes, '保留笔记'); assert.equal(ep.position_sec, 42); assert.equal(ep.path, episode.path)
  assert.ok(fs.readFileSync(work.poster_path).equals(pngImage(90, 135)))
  assert.equal(f.db.prepare('SELECT icon_path FROM resource WHERE id=?').get(id)!.icon_path, work.poster_path)
  assert.ok((f.db.prepare("SELECT path FROM video_assets WHERE role = 'poster'").all() as any[]).every(row => inside(f.target, row.path)))
  const savedJob = JSON.parse(String(f.db.prepare('SELECT payload FROM video_download_jobs').get()!.payload))
  assert.equal(savedJob.posterPath, work.poster_path); assert.equal(savedJob.items[0].posterPath, work.thumbnail_path)
  assert.equal(JSON.parse(savedJob.journal).before.poster_path, work.poster_path); assert.equal(savedJob.sourceUrl, job.sourceUrl)
  assert.ok(fs.existsSync(outside)); assert.ok(fs.existsSync(unrelated)); assert.equal(fs.existsSync(poster), false)
  assert.ok(fs.existsSync(path.join(f.target, '..', 'artwork-migrations')), 'recovery records stay beside the new image directory')
  const again = f.migrate(); assert.equal(again.copied, 0); assert.equal(again.removed, 0); assert.equal(again.updated, 0)
})
await test('a conflicting destination is preserved and gets a separate migrated filename', f => {
  const old = f.file('old-profile/posters/portrait.png'), existing = f.file('project/data/posters/portrait.png', pngImage(80, 120, [80, 140, 30]))
  const previousBytes = fs.readFileSync(existing), id = f.work(1, old)
  f.migrate()
  const saved = getVideo(f.db, id)!.poster_path
  assert.notEqual(saved, existing); assert.ok(inside(f.target, saved)); assert.ok(fs.readFileSync(existing).equals(previousBytes))
  assert.ok(fs.readFileSync(saved).equals(pngImage(90, 135))); assert.equal(fs.existsSync(old), false)
})
await test('identical files already attached to the same work do not collide on asset uniqueness', f => {
  const old = f.file('old-profile/posters/portrait.png'), existing = f.file('project/data/posters/portrait.png'), id = f.work(1, old)
  f.db.prepare("INSERT INTO video_assets(id,resource_id,path,role,created_at) VALUES ('existing',?,?,'poster',0)").run(id, existing)
  f.migrate()
  const rows = f.db.prepare("SELECT path FROM video_assets WHERE resource_id=? AND role='poster'").all(id) as { path: string }[]
  assert.equal(new Set(rows.map(row => row.path)).size, 2)
  assert.ok(rows.every(row => inside(f.target, row.path))); assert.ok(fs.existsSync(existing)); assert.equal(fs.existsSync(old), false)
})
await test('a failed SQL migration keeps old files and all references for a safe retry', f => {
  const old = f.file('old-profile/posters/portrait.png'), id = f.work(1, old), before = getVideo(f.db, id)!.poster_path
  f.db.exec("CREATE TRIGGER migration_abort BEFORE UPDATE ON episode BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END")
  assert.throws(() => f.migrate(), /synthetic migration failure/)
  assert.equal(getVideo(f.db, id)!.poster_path, before); assert.equal(listEpisodes(f.db, id)[0].poster_path, before); assert.ok(fs.existsSync(old))
  f.db.exec('DROP TRIGGER migration_abort')
  f.migrate()
  assert.ok(inside(f.target, getVideo(f.db, id)!.poster_path)); assert.equal(fs.existsSync(old), false)
})
for (const transfer of ['copy', 'move'] as const) await test('organizer ' + transfer + ' rollback uses migrated artwork paths', async f => {
  const poster = f.file('old-profile/posters/portrait.png'), otherPoster = f.file('old-profile/posters/other.png', pngImage(100, 150)), a = f.work(1, poster), b = f.work(2, otherPoster)
  const preview = previewVideoOrganize(f.db, { resourceIds: [a, b], survivorId: a, collectionTitle: '迁移演示', transfer, root: f.root, targetDirectory: path.join(f.root, 'organized') })
  assert.notEqual(a, b); assert.equal(preview.canOrganize, true, JSON.stringify(preview.collisions))
  const journal = await applyVideoOrganize(f.db, { preview, mode: 'physical' })
  assert.equal(journal.status, 'applied', journal.conflicts.join('; '))
  if (transfer === 'move') assert.equal(fs.existsSync(poster), false)
  f.migrate()
  const data = JSON.parse(String(f.db.prepare('SELECT data FROM video_organize_journal WHERE id = ?').get(journal.id)!.data))
  const image = data.files.find((entry: any) => entry.source.endsWith('.png'))
  assert.ok(inside(f.target, image.source), 'historical source must resolve under project data even when the old file was moved')
  const result = await rollbackVideoOrganize(f.db, journal.id)
  assert.equal(result.status, 'rolled-back', result.conflicts.join('; '))
  for (const id of [a, b]) {
    assert.ok(inside(f.target, getVideo(f.db, id)!.poster_path)); assert.ok(fs.existsSync(getVideo(f.db, id)!.poster_path))
    assert.equal(listEpisodes(f.db, id).length, 1)
  }
  assert.equal(fs.existsSync(poster), false, 'rollback must not recreate an old profile image')
})
await test('missing managed images are redirected without deleting unrelated paths', f => {
  const missing = path.join(f.legacy, 'missing.png'), id = f.work(1, missing)
  f.migrate()
  assert.ok(inside(f.target, getVideo(f.db, id)!.poster_path)); assert.equal(fs.existsSync(missing), false)
})
await test('unreferenced managed images move too while nested user directories are left alone', f => {
  const unused = f.file('old-profile/posters/unused.png'), nested = f.file('old-profile/posters/keep/nested.png')
  const result = f.migrate()
  assert.equal(result.removed, 1); assert.equal(fs.existsSync(unused), false); assert.ok(fs.existsSync(nested)); assert.ok(fs.existsSync(path.join(f.target, 'unused.png')))
})

await test('large historical images migrate without relying on current download size limits', f => {
  const bytes = Buffer.alloc(16 * 1024 * 1024, 7), old = f.file('old-profile/posters/large.png', bytes)
  const result = f.migrate()
  assert.equal(result.removed, 1); assert.ok(fs.readFileSync(path.join(f.target, 'large.png')).equals(bytes)); assert.equal(fs.existsSync(old), false)
})

await test('a linked cache directory cannot move unrelated artwork', f => {
  const unrelated = f.file('outside/portrait.png')
  fs.mkdirSync(path.dirname(f.legacy), { recursive: true })
  fs.symlinkSync(path.dirname(unrelated), f.legacy, 'junction')
  assert.throws(() => f.migrate(), /普通目录/)
  assert.ok(fs.existsSync(unrelated)); fs.unlinkSync(f.legacy)
})

await test('different directory names pointing to the same cache never delete the original', f => {
  const original = f.file('old-profile/posters/portrait.png'), id = f.work(1, original)
  fs.mkdirSync(path.join(f.root, 'project'))
  const alias = path.join(f.root, 'project/data')
  fs.symlinkSync(path.dirname(f.legacy), alias, 'junction')
  try {
    const result = f.migrate()
    assert.ok(fs.existsSync(original), 'an alias is the same file, not an independent verified copy')
    assert.equal(getVideo(f.db, id)!.poster_path, original)
    assert.equal(result.removed, 0)
    assert.ok(result.warnings.some(warning => warning.includes('同一')))
  } finally { fs.unlinkSync(alias) }
})

console.log(`Poster storage: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
