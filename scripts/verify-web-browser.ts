/** URL and bookmark persistence verification; no website requests. */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
const implementation: any = await import('../electron/services/web-browser-url.ts').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
  return {}
})
assert.equal(typeof implementation.normalizeWebUrl, 'function', 'Missing generic webpage URL normalizer')
const storage: any = await import('../electron/services/web-browser-sources.ts').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
  return {}
})
assert.equal(typeof storage.createWebBrowserSources, 'function', 'Missing generic webpage source storage')
const { normalizeWebUrl } = implementation, { createWebBrowserSources } = storage
let passed = 0
function test(name: string, run: () => void) { try { run(); passed++ } catch (error) { console.error('FAIL', name); throw error } }
test('ordinary addresses work without catalogue records', () => {
  assert.equal(normalizeWebUrl(' example.org/guide?q=1#part '), 'https://example.org/guide?q=1#part')
  assert.equal(normalizeWebUrl('https://EXAMPLE.org'), 'https://example.org/')
  assert.equal(normalizeWebUrl('http://127.0.0.1:5714/page'), 'http://127.0.0.1:5714/page')
  assert.equal(normalizeWebUrl('localhost:5714/page'), 'https://localhost:5714/page')
  assert.equal(normalizeWebUrl('//example.org/path'), 'https://example.org/path')
})
test('rejects local files, executable protocols, credentials and malformed input', () => {
  for (const input of ['', null, {}, 'file:///C:/private', 'javascript:alert(1)', 'data:text/html,x', 'mailto:a@example.org', 'ftp://example.org', 'https://a:b@example.org', 'https://example.org\n.evil.test', 'http://', 'not a url', 'x'.repeat(4001), 'C:\\private.txt']) assert.throws(() => normalizeWebUrl(input))
})
const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE resource(id TEXT PRIMARY KEY)')
try {
  const sources = createWebBrowserSources(db)
  test('save a named webpage without creating a work or catalogue', () => {
    assert.deepEqual(sources.list(), [])
    const saved = sources.save({ name: '参考资料', url: 'example.org' })
    assert.equal(saved.url, 'https://example.org/'); assert.equal(saved.name, '参考资料')
    assert.equal((db.prepare('SELECT count(*) n FROM resource').get() as any).n, 0)
    assert.equal(sources.list().length, 1)
  })
  test('same URL is not duplicated and a recreated service retains it', () => {
    const before = sources.list()[0]
    assert.equal(sources.save({ name: '资料站', url: 'https://example.org/' }).id, before.id)
    assert.equal(createWebBrowserSources(db).list()[0].name, '资料站'); assert.equal(sources.list().length, 1)
  })
  test('editing a source keeps its identity', () => {
    const before = sources.list()[0], edited = sources.save({ id: before.id, name: '资料新版', url: 'https://example.org/new' })
    assert.equal(edited.id, before.id); assert.equal(sources.list()[0].url, 'https://example.org/new')
    assert.throws(() => sources.save({ id: 'missing', name: 'x', url: 'https://example.org/' }))
  })
  test('invalid updates leave saved sources unchanged', () => {
    const before = sources.list()
    assert.throws(() => sources.save({ id: before[0].id, name: 'x', url: 'file:///C:/private' }))
    assert.deepEqual(sources.list(), before)
  })
  test('remove only changes saved webpage shortcuts', () => {
    db.prepare('INSERT INTO resource(id) VALUES (?)').run('local-video')
    sources.remove(sources.list()[0].id); assert.deepEqual(sources.list(), [])
    assert.equal((db.prepare('SELECT count(*) n FROM resource').get() as any).n, 1)
  })
  test('a long hostname without a name remains readable after restart', () => {
    const hostname = 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.example.org'
    const saved = sources.save({ url: 'https://' + hostname, name: ' ' })
    assert.ok(saved.name.length <= 100)
    assert.deepEqual(createWebBrowserSources(db).list(), [saved])
    sources.remove(saved.id)
  })
} finally { db.close() }
console.log(`Web browser URL and sources: ${passed} passed`)
