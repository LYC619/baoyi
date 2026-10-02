import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, type SqlDb } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { parseCatalogue, createDiscoveryCatalogue } from '../electron/kinds/video/discovery/catalogue.ts'

let passed = 0
function test(name: string, run: (db: SqlDb) => void) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
  try { run(db); passed++ } catch (error) { console.error('FAIL', name); throw error } finally { db.close() }
}
export const fixture = () => ({ schemaVersion: 1, id: 'open-films', name: '开放影像', homeUrl: 'https://example.org/', entries: [
  { id: 'film-1', code: 'DEMO-001', title: '森林纪录', description: '离线测试资料', pageUrl: 'https://example.org/film/1', playUrl: 'https://example.org/watch/1',
    coverUrl: 'https://example.org/cover.png', tags: ['纪录片'], year: 2024, rating: { value: 8, scale: 10, votes: 123 },
    rankings: [{ name: '编辑推荐', position: 2, period: '2024', source: '开放影像' }], downloads: [{ label: '720p', url: 'https://example.org/film.mp4' }] }
] })
test('source retains ranking provenance and explicit download choices', db => {
  const source = parseCatalogue(fixture()); assert.equal(source.entries[0].downloads[0].extension, 'mp4')
  assert.equal(source.entries[0].rankings[0].period, '2024'); assert.equal(source.entries[0].rating?.votes, 123)
  const catalogue = createDiscoveryCatalogue(db); catalogue.importSource(source)
  assert.equal(catalogue.sources().length, 1); assert.equal(catalogue.entry(source.id, 'film-1').entry.title, '森林纪录')
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM resource WHERE kind='video'").get() as { n: number }).n, 0)
})
test('refresh preserves personal state and deliberate empty notes', db => {
  const catalogue = createDiscoveryCatalogue(db); catalogue.importSource(fixture())
  catalogue.mark('open-films', 'film-1', { favorite: true, notes: '旧备注', userRating: 4, watched: true })
  const updated = fixture(); updated.entries[0].title = '新标题'; catalogue.importSource(updated)
  assert.equal(catalogue.entry('open-films', 'film-1').mark.notes, '旧备注')
  catalogue.mark('open-films', 'film-1', { favorite: false, notes: '', userRating: 0, watched: false })
  const mark = createDiscoveryCatalogue(db).entry('open-films', 'film-1').mark
  assert.equal(mark.favorite, false); assert.equal(mark.notes, ''); assert.equal(mark.userRating, 0); assert.equal(mark.watched, false)
})
test('same entry id in another source is independent', db => {
  const catalogue = createDiscoveryCatalogue(db); catalogue.importSource(fixture())
  catalogue.importSource({ ...fixture(), id: 'second' }); catalogue.mark('open-films', 'film-1', { favorite: true })
  assert.equal(catalogue.entry('second', 'film-1').mark.favorite, false)
})
test('failed refresh is atomic', db => {
  const catalogue = createDiscoveryCatalogue(db); catalogue.importSource(fixture())
  const bad = fixture(); bad.entries.push(bad.entries[0]); assert.throws(() => catalogue.importSource(bad), /重复/)
  assert.equal(catalogue.entries('open-films').length, 1)
})
test('entry identifiers use one case-insensitive identity across refreshes', db => {
  const catalogue = createDiscoveryCatalogue(db), original = fixture()
  original.entries[0].id = 'Film-1'; catalogue.importSource(original)
  assert.equal(catalogue.entries('open-films')[0].entry.id, 'film-1')
  catalogue.mark('open-films', 'film-1', { favorite: true })
  catalogue.importSource(fixture())
  assert.equal(catalogue.entries('open-films')[0].mark.favorite, true)
  const duplicate = fixture(); duplicate.entries.push({ ...duplicate.entries[0], id: 'FILM-1' })
  assert.throws(() => catalogue.importSource(duplicate), /重复/)
  assert.equal(catalogue.entries('open-films').length, 1)
})
for (const url of ['javascript:alert(1)', 'file:///C:/private', 'https://user:secret@example.org/a.mp4']) {
  test('rejects unsafe media address ' + url.split(':')[0], () => {
    const bad = fixture(); bad.entries[0].downloads[0].url = url; assert.throws(() => parseCatalogue(bad), /地址/)
  })
}
test('stream playlist is not offered as a full file', () => {
  const data = fixture(); data.entries[0].downloads[0].url = 'https://example.org/stream.m3u8'
  assert.throws(() => parseCatalogue(data), /完整视频/)
})
test('catalogue size, rating scale and schema are checked', () => {
  assert.throws(() => parseCatalogue({ ...fixture(), schemaVersion: 2 }), /版本/)
  assert.throws(() => parseCatalogue({ ...fixture(), entries: Array(2001).fill(fixture().entries[0]) }), /2000/)
  const bad = fixture(); bad.entries[0].rating.value = 11; assert.throws(() => parseCatalogue(bad), /评分/)
})
test('removing source does not delete local inventory', db => {
  const catalogue = createDiscoveryCatalogue(db); catalogue.importSource(fixture()); catalogue.remove('open-films')
  assert.equal(catalogue.sources().length, 0); assert.throws(() => catalogue.entry('open-films', 'film-1'), /来源/)
})
console.log(`Video discovery catalogue: ${passed} passed`)
