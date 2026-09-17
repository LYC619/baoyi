import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent, registerVideoBundle } from '../electron/kinds/video/registration.ts'
import { writeBundleFiles } from '../electron/kinds/video/bundle.ts'
import { getVideo, listEpisodes, updateEpisode } from '../electron/kinds/video/db.ts'
import { listVideoAssets } from '../electron/kinds/video/library.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-bundle-registration-'))
const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
const source = (code: string) => ({ provider: 'example', scope: 'episode' as const, externalId: code, pageUrl: 'https://example.invalid/watch/' + code, evidence: 'playlist' as const })
let passed = 0; let failed = 0
function test(name: string, fn: () => void) { try { fn(); passed++ } catch (error) { failed++; console.error('FAIL ' + name, error) } }
function fixture(name: string) { const dir = path.join(root, name); fs.mkdirSync(dir); const file = path.join(dir, 'one.mp4'); fs.writeFileSync(file, 'fixture-video'); return { dir, file } }
try {
  test('registration retains manifest identity, populated metadata, seasons and source identity on retry', () => {
    const f = fixture('seasons')
    const initial = registerVideoContent(db, { directory: f.dir, title: 'Course 1984', description: 'Original description', items: [{ title: 'First', order: 1, season: 1, number: 1, sources: [source('s1e1')], files: [{ path: f.file }] }], sources: [source('s1e1'), source('s2e1')] })
    const firstEpisode = listEpisodes(db, initial.resourceId)[0]
    updateEpisode(db, firstEpisode.id, { watch_status: 'watching', position_sec: 67 })
    const secondFile = path.join(f.dir, 'two.mp4'); fs.writeFileSync(secondFile, 'second-video')
    const second = registerVideoContent(db, { resourceId: initial.resourceId, directory: f.dir, title: 'Different scrape', items: [{ title: 'Second', order: 2, season: 2, number: 1, sources: [source('s2e1')], files: [{ path: secondFile }] }], sources: [source('s1e1'), source('s2e1')] })
    assert.equal(second.bundleId, initial.bundleId, 'bundle UUID must survive each added file')
    assert.equal(getVideo(db, initial.resourceId)?.name_zh, 'Course 1984')
    assert.equal(getVideo(db, initial.resourceId)?.summary, 'Original description')
    const ep2 = listEpisodes(db, initial.resourceId).find(e => e.season === 2)!
    assert.equal(listVideoAssets(db, initial.resourceId, ep2.id)[0]?.path, secondFile)
    registerVideoContent(db, { resourceId: initial.resourceId, directory: f.dir, title: 'Course', sources: [source('s1e1')], items: [{ title: 'First retitled', order: 4, season: 1, number: 4, sources: [source('s1e1')], files: [{ path: f.file }] }] })
    assert.equal(listEpisodes(db, initial.resourceId).length, 2, 'source identity takes precedence over changed numbering')
    assert.equal(listEpisodes(db, initial.resourceId).find(e => e.id === firstEpisode.id)?.position_sec, 67)
    const duplicated = db.prepare('SELECT COUNT(*) AS n FROM video_sources WHERE resource_id = ? AND external_id = ? AND episode_id IS NULL').get(initial.resourceId, 's1e1') as { n: number }
    assert.ok(duplicated.n <= 1, 'source membership must be idempotent')
  })
  test('a failed registration rolls back resource, directory and episode changes', () => {
    const f = fixture('rollback')
    const before = (db.prepare('SELECT COUNT(*) AS n FROM resource').get() as { n: number }).n
    assert.throws(() => registerVideoContent(db, { directory: f.dir, title: 'Rollback', items: [{ title: 'Bad source', order: 1, files: [{ path: f.file }], sources: [{ ...source('bad'), scope: 'invalid' as any }] }] }))
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM resource').get() as { n: number }).n, before)
  })
  test('incremental bundles retain UUID, all versions, full description and managed revisions', () => {
    const f = fixture('incremental')
    const a = writeBundleFiles({ directory: f.dir, title: 'Course', description: 'Description', files: [{ path: f.file, title: 'First', order: 1, sourceId: '1', quality: '1080p' }] })
    const second = path.join(f.dir, 'alternate.mp4'); fs.writeFileSync(second, 'alternate-video')
    const b = writeBundleFiles({ directory: f.dir, title: 'Course', files: [{ path: second, title: 'First', order: 1, sourceId: '1', quality: '1080p' }] })
    assert.equal(b.bundle.bundle_id, a.bundle.bundle_id)
    assert.equal(b.bundle.revision, a.bundle.revision + 1)
    assert.equal(b.bundle.items.length, 1)
    assert.equal(b.bundle.items[0].files.length, 2, 'same quality does not imply same file')
    assert.match(fs.readFileSync(path.join(f.dir, '简介.md'), 'utf8'), /Description/)
    fs.writeFileSync(path.join(f.dir, '简介.md'), 'User written notes')
    const c = writeBundleFiles({ directory: f.dir, title: 'Course', files: [] })
    assert.equal(fs.readFileSync(path.join(f.dir, '简介.md'), 'utf8'), 'User written notes')
    assert.ok(c.warnings.some(w => /简介|用户/.test(w)))
  })
  test('corrupt and foreign manifests remain intact', () => {
    const f = fixture('corrupt'); const manifest = path.join(f.dir, 'baoyi.json'); fs.writeFileSync(manifest, '{broken')
    assert.throws(() => writeBundleFiles({ directory: f.dir, title: 'Course', files: [] }), /清单/)
    assert.equal(fs.readFileSync(manifest, 'utf8'), '{broken')
  })
  test('bundle content identity distinguishes seasons and explicit providers', () => {
    const f = fixture('season-bundle')
    const second = path.join(f.dir, 'two.mp4'); fs.writeFileSync(second, 'second')
    const result = writeBundleFiles({ directory: f.dir, title: 'Seasons', files: [
      { path: f.file, title: 'Season one', order: 1, season: 1, number: 1, sources: [source('season-one')] },
      { path: second, title: 'Season two', order: 1, season: 2, number: 1, sources: [source('season-two')] }
    ] })
    assert.equal(result.bundle.items.length, 2)
    const again = writeBundleFiles({ directory: f.dir, title: 'Seasons', files: [{ path: second, title: 'Same source retitled', order: 7, season: 2, number: 7, sources: [source('season-two')] }] })
    assert.equal(again.bundle.items.length, 2)
  })
  test('offline import is idempotent and refuses silent rebinding of a copied bundle', () => {
    const f = fixture('portable')
    const made = writeBundleFiles({ directory: f.dir, title: 'Portable', description: 'Offline', files: [{ path: f.file, title: 'One', order: 1, sourceId: '8' }] })
    const first = registerVideoBundle(db, f.dir)
    assert.equal(registerVideoBundle(db, f.dir).resourceId, first.resourceId)
    assert.equal(first.bundleId, made.bundle.bundle_id)
    const copy = path.join(root, 'copy'); fs.cpSync(f.dir, copy, { recursive: true })
    const before = (db.prepare('SELECT COUNT(*) AS n FROM resource').get() as { n: number }).n
    assert.throws(() => registerVideoBundle(db, copy), /副本|已绑定|清单.*存在/)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM resource').get() as { n: number }).n, before)
    assert.equal(getVideo(db, first.resourceId)?.path, f.dir)
  })
  test('manifest paths cannot escape through cover, absolute file or parent traversal', () => {
    const f = fixture('paths')
    const made = writeBundleFiles({ directory: f.dir, title: 'Paths', files: [{ path: f.file, title: 'One', order: 1 }] })
    const manifest = path.join(f.dir, 'baoyi.json')
    made.bundle.work.poster = '../outside.jpg'
    fs.writeFileSync(manifest, JSON.stringify(made.bundle))
    assert.throws(() => registerVideoBundle(db, f.dir), /路径|目录外/)
  })
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
} finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
console.log('Video bundle and registration: ' + passed + ' passed / ' + failed + ' failed')
if (failed) process.exitCode = 1
