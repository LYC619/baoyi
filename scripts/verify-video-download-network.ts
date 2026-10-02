/** Test the Electron 37 manual-redirect adapter without launching Electron. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
const impl: any = await import('../electron/kinds/video/download/chromium-fetch.ts').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e
  return {}
})
assert.equal(typeof impl.createChromiumDownloadFetch, 'function', '缺少 Electron 37 手动重定向适配（预期 RED）')
let passed = 0; let failed = 0
async function test(name: string, run: () => Promise<void>) {
  try { await run(); passed++ } catch (err) { failed++; console.error('FAIL ' + name, err) }
}
function harness(start: (request: any) => void) {
  const session = {}; const options: any[] = []; const headers: Record<string, string> = {}
  let aborted = 0
  const request: any = new EventEmitter()
  request.setHeader = (name: string, value: string) => { headers[name.toLowerCase()] = value }
  request.abort = () => { aborted++ }
  request.end = () => queueMicrotask(() => start(request))
  const fetch = impl.createChromiumDownloadFetch((o: any) => { options.push(o); return request }, session)
  return { fetch, request, headers, options, session, aborted: () => aborted }
}
function response(req: any, text: string, statusCode = 200) {
  const body: any = new PassThrough()
  body.statusCode = statusCode; body.statusMessage = 'OK'; body.headers = { 'content-type': 'video/mp4', 'content-length': String(text.length) }
  req.emit('response', body); body.end(text)
  return body
}
const url = 'https://cdn.example.test/video.mp4'
await test('Chromium request uses same session cookies and returns streaming Response', async () => {
  const h = harness(req => response(req, 'test-video'))
  const r = await h.fetch(url, { redirect: 'manual', headers: { Referer: 'https://hanime1.me/watch?v=123', 'User-Agent': 'test' } })
  assert.equal(r.status, 200); assert.equal(await r.text(), 'test-video')
  assert.equal(h.options[0].session, h.session); assert.equal(h.options[0].useSessionCookies, true)
  assert.equal(h.options[0].redirect, 'manual'); assert.equal(h.headers.referer, 'https://hanime1.me/watch?v=123')
  assert.equal(h.headers.cookie, undefined)
})
await test('Electron redirect EVENT becomes a 3xx Response, no automatic follow', async () => {
  const h = harness(req => req.emit('redirect', 302, 'GET', 'https://cdn2.example.test/main.mp4', {}))
  const r = await h.fetch(url, { redirect: 'manual' })
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), 'https://cdn2.example.test/main.mp4')
  assert.ok(h.aborted() > 0)
})
await test('image requests explicitly omit session credentials', async () => {
  const h = harness(req => response(req, 'image'))
  const r = await h.fetch(url, { redirect: 'manual', credentials: 'omit' })
  assert.equal(await r.text(), 'image')
  assert.equal(h.options[0].credentials, 'omit')
  assert.equal(h.options[0].useSessionCookies, false)
})
await test('redirect body is never requested even for a non-HTTP redirect', async () => {
  const h = harness(req => req.emit('redirect', 302, 'GET', 'file:///C:/private.mp4', {}))
  const r = await h.fetch(url, { redirect: 'manual' })
  assert.equal(r.headers.get('location'), 'file:///C:/private.mp4'); assert.equal(h.options.length, 1)
})
await test('before-headers network error rejects and cannot leak token to callers', async () => {
  const h = harness(req => req.emit('error', new Error('ERR_CONNECTION_RESET')))
  await assert.rejects(h.fetch(url, { redirect: 'manual' }), /ERR_CONNECTION_RESET/)
})
await test('abort while awaiting headers aborts native request', async () => {
  const h = harness(() => {}); const controller = new AbortController()
  const pending = h.fetch(url, { redirect: 'manual', signal: controller.signal }); controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/); assert.ok(h.aborted() > 0)
})
await test('abort after headers rejects body read and destroys native stream', async () => {
  let body: any
  const h = harness(req => { body = new PassThrough(); body.statusCode = 200; body.headers = {}; req.emit('response', body) })
  const controller = new AbortController()
  const r = await h.fetch(url, { redirect: 'manual', signal: controller.signal })
  const reading = r.text(); controller.abort(new Error('cancelled'))
  await assert.rejects(reading, /cancelled/); assert.equal(body.destroyed, true); assert.ok(h.aborted() > 0)
})
await test('reader cancellation closes native stream and request', async () => {
  let body: any
  const h = harness(req => { body = new PassThrough(); body.statusCode = 200; body.headers = {}; req.emit('response', body) })
  const r = await h.fetch(url, { redirect: 'manual' }); await r.body.cancel()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(body.destroyed, true); assert.ok(h.aborted() > 0)
})
await test('late signal after fully read success does not abort completed request', async () => {
  const h = harness(req => response(req, 'ok')); const controller = new AbortController()
  const r = await h.fetch(url, { redirect: 'manual', signal: controller.signal }); await r.text()
  controller.abort(); assert.equal(h.aborted(), 0)
})
await test('does not accept non-HTTP requests, credentials or write methods', async () => {
  const h = harness(req => response(req, 'ok'))
  for (const input of ['file:///C:/a.mp4', 'https://user:pass@cdn.test/a.mp4']) await assert.rejects(h.fetch(input, { redirect: 'manual' }))
  await assert.rejects(h.fetch(url, { redirect: 'manual', method: 'POST' }))
  assert.equal(h.options.length, 0)
})
console.log('Chromium 下载网络回归：' + passed + ' 通过 / ' + failed + ' 失败')
if (failed) process.exitCode = 1
