import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { transferVideo } from '../electron/kinds/video/download/transfer.ts'

const sourceModule: any = await import('../electron/kinds/video/download/sources.ts').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e
  return {}
})
assert.equal(typeof sourceModule.parseVideoSeries, 'function', '缺少系列播放清单解析（预期的 RED）')
const serviceModule: any = await import('../electron/kinds/video/download/service.ts').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e
  return {}
})
assert.equal(typeof serviceModule.createVideoDownloadService, 'function', '缺少系列下载协调器（预期的 RED）')
const { parseVideoSeries, loadVideoSeries } = sourceModule
const { createVideoDownloadService } = serviceModule

const playlistHtml = '<meta property="og:url" content="https://hanime1.me/watch?v=123">' +
  '<div id="shareBtn-title">系列主标题</div>' +
  '<div id="player-div-wrapper"><video id="player"><source src="https://cdn.test/ignored.mp4" size="720" type="video/mp4"></video></div>' +
  '<div class="video-playlist-wrapper"><div id="playlist-top-block"><h4><a>系列主标题</a></h4></div>' +
  '<div id="playlist-scroll">' +
  '<div class="playlist-hover-wrap" data-href="/watch?v=124"><h4 class="video-title"><a>第一集</a></h4><img src="thumb-1.jpg"></div>' +
  '<div class="playlist-hover-wrap" data-href="/watch?v=125"><h4 class="video-title"><a>第二集</a></h4><img src="thumb-2.jpg"></div>' +
  '<div class="playlist-hover-wrap" data-href="/watch?v=123"><h4 class="video-title"><a>主条目</a></h4></div>' +
  '</div></div><script>const source = "https://cdn.test/not-a-playlist.mp4"</script>'

let passed = 0
let failed = 0
async function test(name: string, run: () => Promise<void> | void) {
  try { await run(); passed++ } catch (err) { failed++; console.error('FAIL ' + name, err) }
}
function info() {
  return { videoCode: '123', title: '系列主标题', episodes: [
    { videoCode: '124', title: '第一集' }, { videoCode: '125', title: '第二集' }
  ], warnings: [] }
}
const item = { id: 'v1', hanime_id: '123' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(extra: Record<string, unknown> = {}) {
  const directories: any[] = []; const transfers: any[] = []; const logs: string[] = []; const order: string[] = []
  const svc = createVideoDownloadService({
    getItem: async () => item,
    resolveSeries: async () => info(),
    resolveSources: async (code: string) => {
      order.push('resolve:' + code)
      return { videoCode: code, title: code === '124' ? '第一集' : '第二集', candidates: [
        { url: 'https://cdn.test/' + code + '-1080.mp4?secret=hide', label: '1080p', extension: 'mp4' },
        { url: 'https://cdn.test/' + code + '-720.mp4', label: '720p', extension: 'mp4' }
      ], warnings: [] }
    },
    downloadsDirectory: () => path.resolve('series-downloads'),
    chooseDirectory: async () => { directories.push(true); return path.resolve('series-downloads') },
    chooseFile: async () => path.resolve('series-downloads/single.mp4'),
    transfer: async (options: any) => {
      order.push('transfer:' + path.basename(options.destination))
      transfers.push(options)
      options.onProgress({ phase: 'downloading', receivedBytes: 10, totalBytes: 20, bytesPerSecond: 5 })
      return { destination: options.destination, receivedBytes: 20, totalBytes: 20, bytesPerSecond: 5, warnings: [] }
    },
    log: (message: string) => logs.push(message),
    ...extra
  })
  return { svc, directories, transfers, logs, order }
}

await test('playlist parser keeps the current episode and the playlist title', () => {
  const r = parseVideoSeries(playlistHtml)
  assert.equal(r.videoCode, '123'); assert.equal(r.title, '系列主标题')
  assert.deepEqual(r.episodes.map((e: any) => [e.videoCode, e.title]), [['124', '第一集'], ['125', '第二集'], ['123', '主条目']])
  assert.equal(parseVideoSeries(playlistHtml.replace('<div id="shareBtn-title">系列主标题', '<div id="shareBtn-title">第一集标题')).title, '系列主标题')
  assert.ok(!JSON.stringify(r).includes('not-a-playlist'))
})
await test('playlist loader uses fresh no-store fetch and returns actual episode IDs', async () => {
  let calls = 0
  const r = await loadVideoSeries('123', async (_url: string, init: RequestInit) => {
    calls++; assert.equal(init?.cache, 'no-store'); return new Response(playlistHtml)
  })
  assert.equal(calls, 1)
  assert.deepEqual(r.episodes.map((e: any) => e.videoCode), ['124', '125', '123'])
  await assert.rejects(loadVideoSeries('123', async () => new Response('<meta property="og:url" content="https://hanime1.me/watch?v=123"><div id="shareBtn-title">单集</div>')), /系列|集/)
})
await test('series catalog exposes episodes but never signed source URLs', async () => {
  const h = harness(); const catalog = await h.svc.series('v1')
  assert.deepEqual(catalog.episodes.map((e: any) => e.videoCode), ['124', '125'])
  assert.ok(!JSON.stringify(catalog).includes('secret'))
})
await test('series queue chooses one directory and transfers strictly serially', async () => {
  const h = harness(); const catalog = await h.svc.series('v1')
  const progress: any[] = []
  const r = await h.svc.runSeries({ requestId: 'series-1', resourceId: 'v1', sourceLabel: '1080p' }, (p: any) => progress.push(p))
  assert.equal(r.status, 'success'); assert.equal(r.total, 2); assert.equal(r.completed, 2); assert.equal(r.failed, 0)
  assert.equal(h.directories.length, 1); assert.equal(h.transfers.length, 2)
  assert.deepEqual(h.order, ['resolve:124', 'transfer:系列主标题 - 第一集 [124] 1080p.mp4', 'resolve:125', 'transfer:系列主标题 - 第二集 [125] 1080p.mp4'])
  assert.equal(progress.at(-1).phase, 'done'); assert.equal(catalog.title, '系列主标题')
})
await test('quality missing on an episode falls back to its highest source with warning', async () => {
  const h = harness({ resolveSources: async (code: string) => ({ videoCode: code, title: code, candidates: [
    { url: 'https://cdn.test/' + code + '.mp4', label: code === '124' ? '1080p' : '720p', extension: 'mp4' }
  ], warnings: [] }) })
  await h.svc.series('v1'); const r = await h.svc.runSeries({ requestId: 'fallback', resourceId: 'v1', sourceLabel: '1080p' }, () => {})
  assert.equal(r.status, 'success'); assert.equal(r.fallback, 1); assert.ok(r.warnings.some((w: string) => /720p|清晰度/.test(w)))
})
await test('one episode failure does not prevent later episodes', async () => {
  const h = harness({ resolveSources: async (code: string) => {
    if (code === '124') throw new Error('403 验证失败')
    return { videoCode: code, title: code, candidates: [{ url: 'https://cdn.test/' + code + '.mp4', label: '720p', extension: 'mp4' }], warnings: [] }
  } })
  await h.svc.series('v1'); const r = await h.svc.runSeries({ requestId: 'partial', resourceId: 'v1', sourceLabel: '720p' }, () => {})
  assert.equal(r.status, 'failed'); assert.equal(r.failed, 1); assert.equal(r.completed, 1); assert.equal(h.transfers.length, 1); assert.ok(r.results[0].message.includes('403'))
})
await test('cancel stops the queue after current transfer cleanup', async () => {
  const started = deferred<void>(); const finish = deferred<any>(); let service: any
  const h = harness({ transfer: async (options: any) => { started.resolve(); await finish.promise; return { destination: options.destination, receivedBytes: 1, totalBytes: 1, warnings: [] } } })
  service = h.svc; await service.series('v1')
  const run = service.runSeries({ requestId: 'cancel-series', resourceId: 'v1', sourceLabel: '1080p' }, () => {})
  await started.promise; assert.equal(service.cancel('cancel-series').ok, true)
  finish.resolve({}); const r = await run
  assert.equal(r.status, 'cancelled'); assert.equal(r.completed, 1); assert.equal(r.results.length, 1)
})
await test('active series lock rejects a second single or series request', async () => {
  const pick = deferred<string | null>(); const h = harness({ chooseDirectory: async () => pick.promise })
  await h.svc.series('v1')
  const run = h.svc.runSeries({ requestId: 'lock-1', resourceId: 'v1', sourceLabel: '1080p' }, () => {})
  await new Promise(resolve => setImmediate(resolve))
  const other = await h.svc.run({ requestId: 'single-while-series', resourceId: 'v1', sourceId: 'fake' }, () => {})
  assert.equal(other.status, 'failed'); assert.match(other.message, /进行|下载/)
  assert.equal((await h.svc.runSeries({ requestId: 'series-while-series', resourceId: 'v1', sourceLabel: '' }, () => {})).status, 'failed')
  h.svc.cancel('lock-1'); pick.resolve(null); assert.equal((await run).status, 'cancelled')
})
await test('catalog retains current episode and deduplicates IDs without changing playlist order', async () => {
  const h = harness({ resolveSeries: async () => ({ ...info(), episodes: [
    { videoCode: '123', title: '当前集' }, ...info().episodes, ...info().episodes
  ] }) })
  const catalog = await h.svc.series('v1')
  assert.deepEqual(catalog.episodes.map((e: any) => e.videoCode), ['123', '124', '125'])
})
await test('selected subset downloads only selected episodes in playlist order', async () => {
  const h = harness(); await h.svc.series('v1')
  const r = await h.svc.runSeries({ requestId: 'subset', resourceId: 'v1', sourceLabel: '', videoCodes: ['125'] }, () => {})
  assert.equal(r.total, 1); assert.deepEqual(r.results.map((e: any) => e.videoCode), ['125'])
  assert.equal(h.transfers.length, 1)
})
await test('invalid selections are rejected before opening the directory dialog', async () => {
  for (const videoCodes of [[], ['999'], ['124', '999'], ['124', '124'], '124']) {
    const h = harness(); await h.svc.series('v1')
    const r = await h.svc.runSeries({ requestId: 'invalid-selection', resourceId: 'v1', sourceLabel: '', videoCodes }, () => {})
    assert.equal(r.status, 'failed'); assert.equal(h.directories.length, 0)
  }
})
await test('failed catalog refresh invalidates the previous catalog', async () => {
  let fail = false
  const h = harness({ resolveSeries: async () => { if (fail) throw new Error('network unavailable'); return info() } })
  await h.svc.series('v1'); fail = true
  await assert.rejects(h.svc.series('v1'), /network/)
  const r = await h.svc.runSeries({ requestId: 'stale-refresh', resourceId: 'v1', sourceLabel: '' }, () => {})
  assert.equal(r.status, 'failed'); assert.equal(h.directories.length, 0)
})
await test('expired and rebound catalogs cannot authorize a queue', async () => {
  let now = 100; let code = '123'
  const h = harness({ now: () => now, getItem: () => ({ ...item, hanime_id: code }) })
  await h.svc.series('v1'); now += 11 * 60_000
  assert.equal((await h.svc.runSeries({ requestId: 'expired', resourceId: 'v1', sourceLabel: '' }, () => {})).status, 'failed')
  await h.svc.series('v1'); code = '999'
  assert.equal((await h.svc.runSeries({ requestId: 'rebound', resourceId: 'v1', sourceLabel: '' }, () => {})).status, 'failed')
  assert.equal(h.directories.length, 0)
})
await test('cancelled queue remembers its authorized directory and committed episodes', async () => {
  const started = deferred<void>(); const finish = deferred<void>()
  const h = harness({ transfer: async (options: any) => {
    started.resolve(); await finish.promise
    return { destination: options.destination, receivedBytes: 1, totalBytes: 1, warnings: [] }
  } })
  await h.svc.series('v1')
  const run = h.svc.runSeries({ requestId: 'cancel-reveal', resourceId: 'v1', sourceLabel: '' }, () => {})
  await started.promise; h.svc.cancel('cancel-reveal'); finish.resolve()
  const r = await run
  assert.equal(r.status, 'cancelled'); assert.equal(r.completed, 1)
  assert.equal(h.svc.completedPath('cancel-reveal'), r.path)
  assert.equal(h.svc.completedIsDirectory('cancel-reveal'), true)
})
await test('cancel during source resolution cannot start a transfer even if resolver ignores signal', async () => {
  const started = deferred<void>(); const release = deferred<void>()
  const h = harness({ resolveSources: async (code: string) => {
    started.resolve(); await release.promise
    return { videoCode: code, title: '真实标题', candidates: [{ url: 'https://cdn.test/a.mp4', label: '720p', extension: 'mp4' }], warnings: [] }
  } })
  await h.svc.series('v1')
  const run = h.svc.runSeries({ requestId: 'cancel-resolve', resourceId: 'v1', sourceLabel: '' }, () => {})
  await started.promise; h.svc.cancel('cancel-resolve'); release.resolve()
  const r = await run
  assert.equal(r.status, 'cancelled'); assert.equal(h.transfers.length, 0)
  assert.equal(r.results[0].status, 'cancelled')
})
await test('episode warnings and actual titles survive into results and progress events', async () => {
  const h = harness({ resolveSources: async (code: string) => ({
    videoCode: code, title: '真实标题 ' + code,
    candidates: [{ url: 'https://cdn.test/a.mp4', label: '720p', extension: 'mp4' }],
    warnings: ['部分清晰度不可用 https://cdn.test/a?secret=hidden']
  }) })
  await h.svc.series('v1'); const progress: any[] = []
  const r = await h.svc.runSeries({ requestId: 'events', resourceId: 'v1', sourceLabel: '1080p' }, (p: any) => progress.push(p))
  assert.equal(r.results[0].title, '真实标题 124')
  assert.ok(r.results[0].warnings.some((w: string) => w.includes('部分清晰度')))
  assert.ok(r.results[0].warnings.some((w: string) => w.includes('1080p')))
  assert.equal(progress.filter(p => p.episodeResult).length, 2)
  assert.ok(!JSON.stringify(r).includes('secret=hidden'))
})
await test('network errors mentioning existing files are failures, not skipped episodes', async () => {
  const h = harness({ resolveSources: async () => { throw new Error('服务端会话已存在，请重试') } })
  await h.svc.series('v1')
  const r = await h.svc.runSeries({ requestId: 'not-a-file', resourceId: 'v1', sourceLabel: '' }, () => {})
  assert.equal(r.failed, 2); assert.equal(r.skipped, 0)
})
await test('existing destination files are left intact and recorded as skipped', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-series-'))
  try {
    const workDirectory = path.join(directory, '系列主标题')
    await fs.mkdir(workDirectory)
    const filename = path.join(workDirectory, '系列主标题 - 第一集 [124] 1080p.mp4')
    await fs.writeFile(filename, 'existing-video')
    const h = harness({ chooseDirectory: async () => directory, transfer: async (options: any) => transferVideo({
      ...options, fetch: async () => { throw new Error('must not fetch an existing destination') }
    }) })
    await h.svc.series('v1')
    const r = await h.svc.runSeries({ requestId: 'exists', resourceId: 'v1', sourceLabel: '', videoCodes: ['124'] }, () => {})
    assert.equal(r.status, 'success'); assert.equal(r.skipped, 1)
    assert.equal(await fs.readFile(filename, 'utf8'), 'existing-video')
    assert.equal((await fs.readdir(directory)).length, 1)
    assert.equal(r.path, workDirectory)
    assert.equal((await fs.readdir(workDirectory)).length, 1)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
console.log('系列视频下载回归：' + passed + ' 通过 / ' + failed + ' 失败')
if (failed) process.exitCode = 1
