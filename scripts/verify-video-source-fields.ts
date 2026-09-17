import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { parseDetail } from '../electron/kinds/video/hentai/selectors.ts'
import { parseVideoSources } from '../electron/kinds/video/download/sources.ts'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent, registerVideoBundle } from '../electron/kinds/video/registration.ts'
import { listEpisodes } from '../electron/kinds/video/db.ts'
import { persistVideoWorkBundle } from '../electron/kinds/video/local-sync.ts'
import { readEpisodeSidecar, writeBundleFiles } from '../electron/kinds/video/bundle.ts'

let passed = 0, failed = 0
async function test(name: string, run: () => void | Promise<void>) {
  try { await run(); passed++ } catch (error) { failed++; console.error('FAIL', name, error) }
}
const base = 'https://hanime1.me/watch?v=407946'
const html = `<meta property="og:url" content="${base}"><meta property="og:video:duration" content="997">
  <div id="shareBtn-title">Source fixture</div><a id="video-artist-name">Current Studio</a>
  <div class="video-details-wrapper">观看次数：419万次&nbsp;&nbsp;2026-08-28</div>
  <div class="video-details-wrapper"><span>出版日期：</span><span>2024/01/02</span></div>
  <div class="meta-author"><a>Unrelated recommendation studio</a></div>
  <video id="player"><source src="https://example.invalid/video.mp4" type="video/mp4"></video>`

await test('current-page publication, original release, studio and duration stay distinct', () => {
  const detail = parseDetail(html, base)
  assert.equal(detail.publishedAt, Date.UTC(2026, 7, 28))
  assert.equal(detail.releaseDate, Date.UTC(2024, 0, 2))
  assert.equal(detail.durationSec, 997)
  assert.equal(detail.artist, 'Current Studio')
})
await test('unrelated dates and impossible calendar dates are not treated as publication dates', () => {
  const detail = parseDetail(`<div id="shareBtn-title">Fixture</div><footer>Copyright 2026-01-01</footer>
    <div class="recommendation"><time datetime="2025-04-02">Yesterday</time></div>
    <div class="video-details-wrapper">觀看次數：22次 2026-02-30</div>`, base)
  assert.equal(detail.publishedAt, 0)
  assert.equal(detail.releaseDate, 0)
  assert.equal(detail.durationSec, 0)
})
await test('VideoObject source metadata can supply publication and ISO duration', () => {
  const detail = parseDetail(`<meta property="og:url" content="${base}"><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'VideoObject', url: base, uploadDate: '2025-05-31T08:30:00+09:00', duration: 'PT1H2M3S'
  })}</script>`, base)
  assert.equal(detail.publishedAt, Date.UTC(2025, 4, 31))
  assert.equal(detail.durationSec, 3723)
  assert.equal(detail.releaseDate, 0)
})
await test('download source parsing carries the same verified metadata', () => {
  const result = parseVideoSources(html, base)
  assert.equal(result.publishedAt, Date.UTC(2026, 7, 28))
  assert.equal(result.releaseDate, Date.UTC(2024, 0, 2))
  assert.equal(result.durationSec, 997)
  assert.equal(result.artist, 'Current Studio')
})
await test('episode facts survive portable manifests, reimport and older empty inputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-source-fields-'))
  const db = new DatabaseSync(':memory:'), restored = new DatabaseSync(':memory:')
  try {
    for (const connection of [db, restored]) { connection.exec('PRAGMA foreign_keys = ON'); initSchema(connection, KINDS) }
    const directory = path.join(root, 'Media'); fs.mkdirSync(directory)
    const file = path.join(directory, 'Episode.mp4'); fs.writeFileSync(file, 'synthetic source facts')
    const registration = registerVideoContent(db, { directory, root, title: 'Facts', items: [{
      title: 'Episode', order: 1, publishedAt: Date.UTC(2026, 7, 28), airDate: Date.UTC(2024, 0, 2), durationSec: 997, studio: 'Fixture Studio', files: [{ path: file }]
    }] })
    const before = listEpisodes(db, registration.resourceId)[0]
    assert.equal(before.published_at, Date.UTC(2026, 7, 28))
    const saved = persistVideoWorkBundle(db, registration.resourceId)
    assert.equal(saved.bundle.items[0].published_at, before.published_at)
    assert.equal(saved.bundle.items[0].air_date, before.air_date)
    assert.equal(saved.bundle.items[0].duration_sec, 997)
    assert.equal(saved.bundle.items[0].studio, 'Fixture Studio')
    const imported = registerVideoBundle(restored, directory)
    registerVideoContent(restored, { resourceId: imported.resourceId, title: 'Facts', items: [{ id: before.id, title: 'Episode', order: 1, files: [{ path: file }] }] })
    const after = listEpisodes(restored, imported.resourceId)[0]
    for (const field of ['published_at', 'air_date', 'duration_sec', 'studio'] as const) assert.equal(after[field], before[field], field)
  } finally {
    db.close(); restored.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('baoyi-source-fields-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
await test('a later download with empty source facts preserves the saved manifest and episode sidecar facts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-source-fields-'))
  try {
    const file = path.join(root, 'Episode.mp4'); fs.writeFileSync(file, 'synthetic source facts')
    const entry = { path: file, title: 'Episode', order: 1, publishedAt: Date.UTC(2026, 7, 28), airDate: Date.UTC(2024, 0, 2), durationSec: 997, studio: 'Fixture Studio' }
    const before = writeBundleFiles({ directory: root, title: 'Facts', files: [entry] }).bundle.items[0]
    const after = writeBundleFiles({ directory: root, title: 'Facts', files: [{ ...entry, publishedAt: 0, airDate: 0, durationSec: 0, studio: '' }] }).bundle.items[0]
    const sidecar = readEpisodeSidecar(file)!
    for (const field of ['published_at', 'air_date', 'duration_sec', 'studio'] as const) {
      assert.equal(after[field], before[field], field)
      assert.equal(sidecar.episode[field], before[field], field + ' sidecar')
    }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('baoyi-source-fields-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
await test('an older episode table gains the new fields without recreating its rows', () => {
  const db = new DatabaseSync(':memory:')
  try {
    initSchema(db, KINDS)
    for (const column of ['published_at', 'studio']) if ((db.prepare('PRAGMA table_info(episode)').all() as Array<{ name: string }>).some(row => row.name === column)) db.exec('ALTER TABLE episode DROP COLUMN ' + column)
    initSchema(db, KINDS); initSchema(db, KINDS)
    const columns = db.prepare('PRAGMA table_info(episode)').all() as Array<{ name: string }>
    assert.ok(columns.some(column => column.name === 'published_at'))
    assert.ok(columns.some(column => column.name === 'studio'))
  } finally { db.close() }
})
console.log(`Video source fields: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
