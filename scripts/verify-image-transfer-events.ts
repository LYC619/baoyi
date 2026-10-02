import assert from 'node:assert/strict'
import { PicacomicSource } from '../electron/kinds/image/source.ts'
import { pngImage } from './helpers/test-images.ts'
import type { ImageTransferEvent } from '../src/types/image.ts'

const png = pngImage(12, 18), events: ImageTransferEvent[] = []
let attempt = 0
const source = new PicacomicSource({ token: () => 'private-fixture-token', wait: async () => {}, fetch: async () => {
  if (attempt++ === 0) {
    let reads = 0
    return new Response(new ReadableStream({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new Uint8Array(png.subarray(0, 10)))
      else controller.error(new TypeError('synthetic interrupted stream'))
    } }))
  }
  return new Response(new Uint8Array(png))
} })
assert.deepEqual((await source.image('https://images.picacomic.com/one', undefined, event => events.push(event))).data, png)
assert.equal(attempt, 2)
assert.equal(events.reduce((sum, event) => sum + (event.bytes || 0), 0), png.length + 10, '实际接收包含失败尝试的已接收数据')
assert.ok(events.some(event => event.phase === 'retrying' && event.waitMs === 500))
assert.equal(JSON.stringify(events).includes('private-fixture-token'), false)
assert.equal(JSON.stringify(events).includes('picacomic.com'), false)

const controller = new AbortController(), cancelled: ImageTransferEvent[] = []
let requests = 0
const limited = new PicacomicSource({ token: () => '', fetch: async () => { requests++; return new Response('', { status: 429 }) }, wait: async (_ms, signal) => { signal?.throwIfAborted() } })
await assert.rejects(limited.image('https://images.picacomic.com/two', controller.signal, event => {
  cancelled.push(event)
  if (event.phase === 'rate-limited') controller.abort()
}), /取消/)
assert.equal(requests, 1, '限流等待被取消后不得继续请求')
assert.ok(cancelled.some(event => event.phase === 'rate-limited'))

for (const retryAfter of ['12', new Date(Date.now() + 20000).toUTCString()]) {
  let calls = 0, waited = 0
  const patient = new PicacomicSource({ token: () => '', wait: async ms => { waited = ms }, fetch: async () => ++calls === 1 ? new Response(null, { status: 429, headers: { 'retry-after': retryAfter } }) : new Response(new Uint8Array(png)) })
  await patient.image('https://images.picacomic.com/wait')
  assert.ok(waited > 10000, 'Retry-After 的秒数或 HTTP 日期不能被截断为十秒')
}
console.log('PASS 传输事件、失败尝试字节、无凭据日志及限流等待取消')
