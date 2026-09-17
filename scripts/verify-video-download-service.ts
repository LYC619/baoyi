import assert from 'node:assert/strict'
import path from 'node:path'
import { setHanimeFetch } from '../electron/kinds/video/hentai/hanime.ts'

const sources: any = await import('../electron/kinds/video/download/sources.ts').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e
  return {}
})
assert.equal(typeof sources.parseVideoSources, 'function', '缺少播放器直链解析（预期的 RED）')
const serviceModule: any = await import('../electron/kinds/video/download/service.ts').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e
  return {}
})
assert.equal(typeof serviceModule.createVideoDownloadService, 'function', '缺少单集下载协调器（预期的 RED）')
const { parseVideoSources, loadVideoSources } = sources
const { createVideoDownloadService, downloadFilename } = serviceModule
let passed = 0; let failed = 0
async function test(name: string, run: () => Promise<void> | void) {
  try { await run(); passed++ } catch (err) { failed++; console.error('FAIL ' + name, err) }
}
const html = '<meta property="og:url" content="https://hanime1.me/watch?v=123"><meta property="og:image" content="https://cdn.example.test/image/cover/123.jpg"><div id="shareBtn-title">测试标题 01</div><video id="player" poster="https://cdn.example.test/image/thumbnail/123.jpg">' +
  '<source src="https://cdn.example.test/720.mp4?token=secret&amp;b=2" size="720" type="video/mp4">' +
  '<source src="//cdn.example.test/1080.mp4" size="1080" type="video/mp4"></video>'
const info = () => ({ videoCode: '123', title: '测试标题 01', candidates: [
  { url: 'https://cdn.example.test/main.mp4?secret=token', label: '1080p', extension: 'mp4' }
], warnings: [] })
const item = { id: 'v1', hanime_id: '123', name_zh: '本地系列名' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(extra: Record<string, unknown> = {}) {
  const chosen: any[] = []; const transfers: any[] = []; const logs: string[] = []
  const svc = createVideoDownloadService({
    getItem: async () => item, resolveSources: async () => info(), downloadsDirectory: () => path.resolve('test-downloads'),
    chooseFile: async (o: any) => { chosen.push(o); return o.defaultPath },
    transfer: async (o: any) => { transfers.push(o); o.onProgress({ phase: 'downloading', receivedBytes: 20, totalBytes: 40, bytesPerSecond: 10 });
      return { destination: o.destination, receivedBytes: 40, totalBytes: 40, bytesPerSecond: 10, warnings: [] } },
    log: (message: string) => logs.push(message), ...extra
  })
  return { svc, chosen, transfers, logs }
}
await test('player sources sorted, entities decoded and metadata retained', () => {
  const r = parseVideoSources(html)
  assert.equal(r.title, '测试标题 01'); assert.equal(r.videoCode, '123')
  assert.deepEqual(r.candidates.map((x: any) => x.label), ['1080p', '720p'])
  assert.match(r.candidates[1].url, /token=secret&b=2$/)
})
await test('ignores side list thumbnails, unrelated video and scripts', () => {
  const r = parseVideoSources(html + '<video><source src="https://ad.test/ad.mp4"></video><div id="playlist-scroll"><img src="https://cdn.test/thumb.jpg"></div><script>const source = "https://ad.test/ad.mp4"</script>')
  assert.equal(r.candidates.length, 2)
})
await test('script fallback is parsed as text, never executed', () => {
  const r = parseVideoSources(String.raw`<div id="player-div-wrapper"><script>throw new Error("must not run"); const source = "https:\/\/cdn.test\/episode.mp4?x=1\u0026y=2";</script></div>`)
  assert.equal(r.candidates[0].url, 'https://cdn.test/episode.mp4?x=1&y=2')
})
await test('player src supported, duplicate URLs removed', () => {
  const r = parseVideoSources('<video id="player" src="https://cdn.test/main.webm"><source src="https://cdn.test/main.webm" size="720"></video>')
  assert.equal(r.candidates.length, 1); assert.equal(r.candidates[0].extension, 'webm')
})
await test('HLS and DASH are not offered as completed video files', () => {
  const r = parseVideoSources('<video id="player"><source src="https://cdn.test/a.m3u8" type="video/mp4"><source src="https://cdn.test/a.mpd"><source src="https://cdn.test/a.mp4" size="720"></video>')
  assert.equal(r.candidates.length, 1); assert.ok(r.warnings.some((s: string) => /分片/.test(s)))
})
await test('reject unsafe scheme, credentials, images and unknown extension', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/x.mp4', 'https://user:pass@cdn.test/v.mp4', 'https://cdn.test/thumb.jpg', 'https://cdn.test/payload.exe']) {
    assert.equal(parseVideoSources('<video id="player"><source src="' + url + '"></video>').candidates.length, 0)
  }
})
await test('fresh resolution uses injected Hanime session and no persistent page cache', async () => {
  let calls = 0
  setHanimeFetch(async (_url, init) => { calls++; assert.equal(init?.cache, 'no-store'); return new Response(html) })
  try { await loadVideoSources('123'); await loadVideoSources('123'); assert.equal(calls, 2) }
  finally { setHanimeFetch(null) }
})
const previewOnly = html.replace('/image/cover/', '/image/thumbnail/')
const searchHit = (code: string) => `<div class="home-rows-videos-wrapper"><a href="/watch?v=${code}"><img src="https://cdn.example.test/image/cover/${code}.jpg"><div class="home-rows-videos-title">测试标题 01</div></a></div>`
await test('download metadata supplements the portrait from the exact source search hit', async () => {
  const requests: string[] = []
  const result = await loadVideoSources('123', async (input: string) => {
    requests.push(String(input))
    return new Response(String(input).includes('/search') ? searchHit('999') + searchHit('123') : previewOnly)
  })
  assert.equal(requests.length, 2)
  assert.match(requests[1], /search/)
  assert.equal(result.posterUrl, 'https://cdn.example.test/image/cover/123.jpg')
  assert.equal(result.thumbnailUrl, 'https://cdn.example.test/image/thumbnail/123.jpg')
  assert.equal(result.candidates.length, 2)
})
await test('source binding and download resolution use the same exact-match portrait fallback', async () => {
  let calls = 0
  setHanimeFetch(async input => { calls++; return new Response(String(input).includes('/search') ? searchHit('999') + searchHit('123') : previewOnly) })
  try {
    const work = await sources.loadVideoWork('123')
    assert.equal(calls, 2)
    assert.equal(work.posterUrl, 'https://cdn.example.test/image/cover/123.jpg')
    assert.equal(work.currentEpisode.posterUrl, work.posterUrl)
    assert.ok(work.artworkUrls.includes(work.posterUrl))
  } finally { setHanimeFetch(null) }
})
await test('missing exact match or unavailable search keeps the page-provided image', async () => {
  for (const search of [() => new Response(searchHit('999')), () => new Response('unavailable', { status: 503 })]) {
    const result = await loadVideoSources('123', async (input: string) => String(input).includes('/search') ? search() : new Response(previewOnly))
    assert.equal(result.posterUrl, result.thumbnailUrl)
    assert.equal(result.candidates.length, 2)
  }
})
await test('portrait lookup timeout is bounded and explicit cancellation is retained', async () => {
  const result = await loadVideoSources('123', (input: string) => String(input).includes('/search') ? new Promise(() => {}) : Promise.resolve(new Response(previewOnly)), { timeoutMs: 20 })
  assert.equal(result.posterUrl, result.thumbnailUrl)
  const control = new AbortController()
  let searched = false
  await assert.rejects(loadVideoSources('123', (input: string) => {
    if (!String(input).includes('/search')) return Promise.resolve(new Response(previewOnly))
    searched = true; control.abort(); return new Promise(() => {})
  }, { signal: control.signal, timeoutMs: 20 }), /abort|取消/i)
  assert.equal(searched, true)
})
await test('challenge, non-2xx, incorrect identity and no source fail explicitly', async () => {
  for (const body of ['<title>Just a moment...</title>', '<div id="shareBtn-title">no source</div>', html.replace('v=123', 'v=999')]) {
    await assert.rejects(loadVideoSources('123', async () => new Response(body)), /验证|直链|编号|不一致/)
  }
  await assert.rejects(loadVideoSources('123', async () => new Response('denied', { status: 403 })), /403.*验证|验证.*403/)
  await assert.rejects(loadVideoSources('abc', async () => new Response(html)), /编号/)
})
await test('source header timeout is bounded even when fetch ignores signal', async () => {
  await assert.rejects(loadVideoSources('123', () => new Promise(() => {}), { timeoutMs: 15 }), /超时/)
})
await test('source body timeout cancels its reader and oversized pages are rejected', async () => {
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  await assert.rejects(loadVideoSources('123', async () => new Response(body), { timeoutMs: 15 }), /超时/)
  assert.equal(cancelled, true)
  await assert.rejects(loadVideoSources('123', async () => new Response(html + ' '.repeat(4 * 1024 * 1024))), /过大|上限/)
})
await test('filename is safe, bounded and includes site ID', () => {
  const name = downloadFilename('CON : <> / .. \\ title\n'.repeat(25), '123', '1080p', 'mp4')
  assert.ok(name.length < 180); assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(name)); assert.match(name, /123.*1080p\.mp4$/)
  assert.ok(!/^CON(?:\.|$)/i.test(name))
})
await test('source tokens hide URLs and only selected sources can download', async () => {
  const h = harness(); const catalog = await h.svc.sources('v1')
  assert.ok(!JSON.stringify(catalog).includes('secret'))
  const r = await h.svc.run({ requestId: 'run-1', resourceId: 'v1', sourceId: catalog.sources[0].id }, () => {})
  assert.equal(r.status, 'success'); assert.equal(h.chosen.length, 1); assert.equal(h.transfers.length, 1)
  assert.match(h.transfers[0].referer, /watch\?v=123/)
  assert.equal(h.svc.completedPath('run-1'), r.path)
  assert.ok(h.logs.some(s => /完成/.test(s))); assert.ok(!h.logs.join('').includes('secret'))
})
await test('forged source/resource and changed site ID rejected before path choice', async () => {
  for (const mode of ['source', 'resource', 'changed']) {
    let current: any = item
    const h = harness({ getItem: async () => current }); const catalog = await h.svc.sources('v1')
    if (mode === 'changed') current = { ...item, hanime_id: '999' }
    const r = await h.svc.run({ requestId: 'run-forge', resourceId: mode === 'resource' ? 'v2' : 'v1', sourceId: mode === 'source' ? 'fake' : catalog.sources[0].id }, () => {})
    assert.equal(r.status, 'failed'); assert.equal(h.chosen.length, 0)
  }
})
await test('expired tokens ask to refresh without attempting transfer', async () => {
  let now = 1000
  const h = harness({ now: () => now }); const catalog = await h.svc.sources('v1'); now += 15 * 60_000
  const r = await h.svc.run({ requestId: 'expired', resourceId: 'v1', sourceId: catalog.sources[0].id }, () => {})
  assert.equal(r.status, 'failed'); assert.match(r.message, /过期|重新解析/); assert.equal(h.transfers.length, 0)
})
await test('save dialog cancellation has terminal cancelled state', async () => {
  const h = harness({ chooseFile: async () => null }); const catalog = await h.svc.sources('v1')
  const r = await h.svc.run({ requestId: 'pick-cancel', resourceId: 'v1', sourceId: catalog.sources[0].id }, () => {})
  assert.equal(r.status, 'cancelled'); assert.equal(h.transfers.length, 0); assert.equal(h.svc.completedPath('pick-cancel'), null)
})
await test('single active transfer and cancellation during native selection', async () => {
  const pick = deferred<string | null>(); const picked = deferred<void>()
  const h = harness({ chooseFile: async () => { picked.resolve(); return pick.promise } })
  const catalog = await h.svc.sources('v1')
  const run = h.svc.run({ requestId: 'first', resourceId: 'v1', sourceId: catalog.sources[0].id }, () => {})
  await picked.promise
  const other = await h.svc.run({ requestId: 'second', resourceId: 'v1', sourceId: catalog.sources[0].id }, () => {})
  assert.equal(other.status, 'failed'); assert.match(other.message, /进行|下载/)
  assert.equal(h.svc.cancel('wrong').ok, false); assert.equal(h.svc.cancel('first').ok, true)
  pick.resolve(path.resolve('test-downloads/file.mp4'))
  assert.equal((await run).status, 'cancelled'); assert.equal(h.transfers.length, 0)
})
await test('transfer errors retain reason and release lock for retry', async () => {
  const h = harness({ transfer: async () => { throw new Error('ENOSPC 磁盘空间不足') } })
  const catalog = await h.svc.sources('v1')
  for (const requestId of ['failure1', 'retry2']) {
    const r = await h.svc.run({ requestId, resourceId: 'v1', sourceId: catalog.sources[0].id }, () => {})
    assert.equal(r.status, 'failed'); assert.match(r.message, /ENOSPC/)
  }
})
await test('late cancel cannot relabel an already published result', async () => {
  let svc: any
  const h = harness({ transfer: async (o: any) => { svc.cancel('committed'); return { destination: o.destination, receivedBytes: 8, totalBytes: 8, warnings: [] } } })
  svc = h.svc; const catalog = await svc.sources('v1')
  const r = await svc.run({ requestId: 'committed', resourceId: 'v1', sourceId: catalog.sources[0].id }, () => {})
  assert.equal(r.status, 'success')
})
await test('unsafe final extension rejected, missing extension appended', async () => {
  for (const ext of ['exe', '']) {
    const h = harness({ chooseFile: async () => path.resolve('test-downloads/output' + (ext ? '.' + ext : '')) })
    const catalog = await h.svc.sources('v1')
    const r = await h.svc.run({ requestId: 'ext-' + (ext || 'none'), resourceId: 'v1', sourceId: catalog.sources[0].id }, () => {})
    assert.equal(r.status, ext ? 'failed' : 'success')
    if (!ext) assert.ok(r.path.endsWith('.mp4'))
  }
})
await test('progress callback failure does not corrupt a file result', async () => {
  const h = harness(); const catalog = await h.svc.sources('v1')
  const r = await h.svc.run({ requestId: 'observer', resourceId: 'v1', sourceId: catalog.sources[0].id }, () => { throw new Error('renderer gone') })
  assert.equal(r.status, 'success')
})
console.log('视频下载源/协调回归：' + passed + ' 通过 / ' + failed + ' 失败')
if (failed) process.exitCode = 1
