import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createDiscoveryCatalogue, parseCatalogue } from '../electron/kinds/video/discovery/catalogue.ts'

assert.ok(existsSync('electron/kinds/video/discovery/online.ts'), '在线来源服务尚未实现')
assert.ok(existsSync('electron/kinds/video/discovery/adapters/video-object.ts'), 'VideoObject 适配器尚未实现')
const { parseVideoObjectPage } = await import('../electron/kinds/video/discovery/adapters/video-object.ts')
const { createOnlineSource, readOnlinePage } = await import('../electron/kinds/video/discovery/online.ts')
const base = 'https://example.org'
const film = (id: string, extra = {}) => ({ '@type': 'VideoObject', name: '影片 ' + id, url: '/film/' + id, thumbnailUrl: '/cover.png', ...extra })
const html = (data: unknown, next = '') => `<title>开放影像</title><script type="application/ld+json">${JSON.stringify(data)}</script>${next ? `<a rel="next" href="${next}">下一页</a>` : ''}`
const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
const catalogue = createDiscoveryCatalogue(db)
let passed = 0
async function test(name: string, run: () => unknown) { try { await run(); passed++; console.log('PASS', name) } catch (error) { console.error('FAIL', name); throw error } }
const pages = new Map<string, string>()
let active = 0, peak = 0, requests = 0
const fetchPage: typeof fetch = async input => {
  active++; peak = Math.max(active, peak); requests++
  try {
    await new Promise(resolve => setTimeout(resolve, 5))
    const body = pages.get(String(input))
    return new Response(body ?? 'missing', { status: body === undefined ? 404 : 200, headers: { 'Content-Type': 'text/html' } })
  } finally { active-- }
}
const online = createOnlineSource(catalogue, fetchPage)
try {
  await test('VideoObject / @graph / ItemList, relative URLs and metadata', () => {
    const parsed = parseVideoObjectPage({ url: base + '/list', html: html({ '@graph': [{ '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: film('a', {
      description: '介绍', uploadDate: '2025-01-02', keywords: '自然,短片', aggregateRating: { ratingValue: '4.5', bestRating: '5', ratingCount: '20' }, contentUrl: '/media/a.webm'
    }) }] }, film('b')] }, '/page2') })
    assert.equal(parsed.entries.length, 2); assert.equal(parsed.name, '开放影像')
    assert.equal(parsed.nextPageUrl, base + '/page2'); const entry = parsed.entries[0]
    assert.equal(entry.coverUrl, base + '/cover.png'); assert.equal(entry.mediaUrl, base + '/media/a.webm')
    assert.equal(entry.downloads[0].extension, 'webm'); assert.equal(entry.year, 2025); assert.equal(entry.rating?.value, 4.5)
    assert.deepEqual(entry.tags, ['自然', '短片'])
  })
  await test('web pages, playlists and unsafe URLs never become media downloads', () => {
    for (const url of ['/watch/1', '/watch.html', '/stream.m3u8', 'javascript:alert(1)', 'file:///test.mp4', 'https://a:b@example.org/a.mp4']) {
      const entry = parseVideoObjectPage({ url: base, html: html(film('a', { contentUrl: url, embedUrl: '/watch/1' })) }).entries[0]
      assert.equal(entry.mediaUrl, ''); assert.equal(entry.downloads.length, 0); assert.equal(entry.playUrl, base + '/watch/1')
    }
    const parsed = parseVideoObjectPage({ url: base, html: html(film('a'), 'https://other.example/page') })
    assert.equal(parsed.nextPageUrl, '')
    assert.throws(() => parseVideoObjectPage({ url: 'file:///x', html: '' }), /HTTP/)
  })
  await test('malformed JSON block does not hide valid metadata and traversal is bounded', () => {
    assert.equal(parseVideoObjectPage({ url: base, html: '<script type="application/ld+json">broken</script>' + html(film('a')) }).entries.length, 1)
    let nested: unknown = film('a'); for (let i = 0; i < 100; i++) nested = { nested }
    assert.equal(parseVideoObjectPage({ url: base, html: html(nested) }).entries.length, 0)
  })
  pages.set(base + '/list', html(film('a'), '/page2'))
  const source = await online.connect(base + '/list#top')
  const id = source.id, first = catalogue.entries(id)[0].entry.id
  await test('stable source and entry identity survives reconnect and title changes', async () => {
    catalogue.mark(id, first, { favorite: true, notes: '保留', userRating: 4 })
    pages.set(base + '/list', html(film('a', { name: '更新标题' }), '/page2'))
    assert.equal((await online.connect(base + '/list')).id, id)
    assert.equal(catalogue.entries(id)[0].entry.id, first); assert.equal(catalogue.entry(id, first).mark.favorite, true)
    assert.equal(catalogue.sources().length, 1); assert.equal(catalogue.sources()[0].online?.url, base + '/list')
    assert.equal(parseCatalogue(catalogue.get(id)).online?.nextPageUrl, base + '/page2')
  })
  await test('pagination merges duplicates, terminates loops, refresh retains cached favorites', async () => {
    pages.set(base + '/page2', html([film('a'), film('b')], '/list'))
    await online.next(id); assert.equal(catalogue.entries(id).length, 2)
    assert.equal(catalogue.get(id).online?.nextPageUrl, '')
    const before = requests; await online.next(id); assert.equal(requests, before)
    pages.set(base + '/list', html(film('c'), '/page2')); await online.refresh(id)
    assert.equal(catalogue.entries(id).length, 3); assert.equal(catalogue.entry(id, first).mark.notes, '保留')
  })
  await test('detail enriches only the selected work, retains identity and serializes requests', async () => {
    pages.set(base + '/film/a', html([film('recommendation', { contentUrl: '/wrong.mp4' }), film('a', { contentUrl: '/right.webm' })]))
    const [card] = await Promise.all([online.detail({ sourceId: id, entryId: first }), online.refresh(id)])
    assert.equal(card.entry.id, first); assert.equal(card.entry.mediaUrl, base + '/right.webm'); assert.equal(peak, 1)
    assert.equal(catalogue.entry(id, first).entry.mediaUrl, base + '/right.webm')
    assert.equal(parseCatalogue(catalogue.get(id)).entries.find(e => e.id === first)?.mediaUrl, base + '/right.webm')
    assert.equal(catalogue.entry(id, first).mark.userRating, 4)
  })
  await test('ambiguous detail and empty/failed refresh preserve all existing data', async () => {
    const snapshot = JSON.stringify(catalogue.get(id))
    pages.set(base + '/film/a', html(film('wrong', { contentUrl: '/wrong.mp4' })))
    await assert.rejects(() => online.detail({ sourceId: id, entryId: first }), /对应作品/)
    pages.set(base + '/list', '<h1>unsupported</h1>'); await assert.rejects(() => online.refresh(id), /VideoObject/)
    pages.delete(base + '/list'); await assert.rejects(() => online.refresh(id), /404/)
    assert.equal(JSON.stringify(catalogue.get(id)), snapshot)
  })
  await test('multiple videos without unique identities never resolve to a recommendation', async () => {
    pages.set(base + '/film/a', html([
      { '@type': 'VideoObject', name: '当前作品', contentUrl: '/right.webm' },
      { '@type': 'VideoObject', name: '推荐作品', contentUrl: '/wrong.webm' }
    ]))
    await assert.rejects(() => online.detail({ sourceId: id, entryId: first }), /对应作品|VideoObject/)
    assert.equal(catalogue.entry(id, first).entry.mediaUrl, base + '/right.webm')
  })
  await test('size limit checks declared size and streamed bytes', async () => {
    const huge: typeof fetch = async () => new Response('x', { headers: { 'Content-Type': 'text/html', 'Content-Length': String(3 * 1024 * 1024) } })
    await assert.rejects(() => readOnlinePage(base, huge), /2 MB/)
    const streamed: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close() } }))
    await assert.rejects(() => readOnlinePage(base, streamed), /2 MB/)
  })
  await test('redirect and content-type limits, HTTP credentials rejected before fetch', async () => {
    let count = 0
    const loop: typeof fetch = async () => { count++; return new Response(null, { status: 302, headers: { location: '/loop' } }) }
    await assert.rejects(() => readOnlinePage(base, loop), /重定向/); assert.equal(count, 6)
    await assert.rejects(() => readOnlinePage('https://user:pass@example.org', fetchPage), /HTTP/)
    const binary: typeof fetch = async () => new Response('data', { headers: { 'Content-Type': 'video/mp4' } })
    await assert.rejects(() => readOnlinePage(base, binary), /HTML/)
    const redirectOffsite: typeof fetch = async () => new Response(null, { status: 302, headers: { location: 'https://other.example/page' } })
    await assert.rejects(() => readOnlinePage(base + '/page2', redirectOffsite, base), /同站点/)
  })
  await test('invalid online payload and media cannot bypass catalogue validation', () => {
    const saved = catalogue.get(id)
    assert.throws(() => parseCatalogue({ ...saved, online: { ...saved.online, nextPageUrl: 'https://other.example/' } }), /同站点/)
    assert.throws(() => parseCatalogue({ ...saved, entries: [{ ...saved.entries[0], mediaUrl: base + '/watch.html' }] }), /视频文件/)
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM resource WHERE kind='video'").get() as { n: number }).n, 0)
  })
  console.log(`Online source verification: ${passed} passed`)
} finally { db.close() }
