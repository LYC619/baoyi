/** Offline download safety tests: synthetic media only, no application or external requests. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'

const implementation: any = await import('../electron/kinds/video/download/transfer.ts').catch((err) => {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err
  return {}
})
assert.equal(typeof implementation.transferVideo, 'function', '缺少单集流下载实现 transferVideo（预期的 RED）')
const { transferVideo } = implementation
const media = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(128, 7)])
const url = 'https://cdn.example.test/episode.mp4?signature=secret'
let passed = 0
let failed = 0
async function test(name: string, run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-download-test-'))
  try { await run(dir); passed++ }
  catch (err) { failed++; console.error('FAIL ' + name, err) }
  finally {
    const absolute = path.resolve(dir)
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
    assert.ok(path.basename(absolute).startsWith('baoyi-download-test-'))
    await fs.rm(absolute, { recursive: true, force: true })
  }
}
const reply = (body: BodyInit | null = media, headers: Record<string, string> = {}) => new Response(body, {
  headers: { 'Content-Type': 'video/mp4', ...headers }
})
const request = (dir: string, extra: Record<string, unknown> = {}) => ({
  url, destination: path.join(dir, 'episode.mp4'), referer: 'https://hanime1.me/watch?v=123',
  signal: new AbortController().signal, fetch: async () => reply(), ...extra
})
async function expectCleanFailure(dir: string, extra: Record<string, unknown>, pattern: RegExp) {
  await assert.rejects(transferVideo(request(dir, extra)), pattern)
  assert.deepEqual(await fs.readdir(dir), [], '失败后不能留下伪完成文件或 part')
}
await test('normal: writes media, reports bytes, shares headers and publishes last', async dir => {
  const progress: any[] = []
  const r = await transferVideo(request(dir, {
    fetch: async (_url: string, init: RequestInit) => {
      assert.equal(new Headers(init.headers).get('referer'), 'https://hanime1.me/watch?v=123')
      assert.ok(new Headers(init.headers).get('user-agent'))
      assert.equal(new Headers(init.headers).get('cookie'), null)
      return reply(media, { 'Content-Length': String(media.length) })
    },
    onProgress: (p: any) => progress.push(p)
  }))
  assert.equal(r.receivedBytes, media.length)
  assert.equal(r.totalBytes, media.length)
  assert.deepEqual(await fs.readFile(r.destination), media)
  assert.deepEqual(await fs.readdir(dir), ['episode.mp4'])
  assert.equal(progress.at(-1).phase, 'finalizing')
  assert.ok(progress.some(p => p.phase === 'downloading'))
  assert.equal(progress.at(-1).receivedBytes, media.length)
  assert.equal(progress.at(-1).totalBytes, media.length)
  assert.ok(progress.every(p => Number.isFinite(p.bytesPerSecond) && p.bytesPerSecond >= 0))
})
await test('unknown content length stays indeterminate', async dir => {
  const ticks: any[] = []
  const r = await transferVideo(request(dir, { onProgress: (p: any) => ticks.push(p) }))
  assert.equal(r.totalBytes, 0)
  assert.ok(ticks.every(p => p.totalBytes === 0))
})
for (const status of [403, 404, 500, 206]) await test('HTTP ' + status, async dir => {
  await expectCleanFailure(dir, { fetch: async () => new Response(media, { status }) }, new RegExp(String(status)))
})
for (const body of ['', '<!doctype html><html>Just a moment</html>', '#EXTM3U\n#EXT-X-TARGETDURATION:3', '{"error":"login"}']) {
  await test('rejects empty/challenge/manifest disguised as media: ' + body.slice(0, 15), async dir => {
    await expectCleanFailure(dir, { fetch: async () => reply(body) }, /空|视频|清单|Cloudflare/)
  })
}
await test('text MIME cannot masquerade as media', async dir => {
  await expectCleanFailure(dir, { fetch: async () => reply(media, { 'Content-Type': 'text/html' }) }, /视频|HTML/)
})
await test('mismatched length', async dir => {
  await expectCleanFailure(dir, { fetch: async () => reply(media, { 'Content-Length': String(media.length + 8) }) }, /长度|大小|完整/)
})
await test('encoded response does not compare decompressed bytes to compressed size', async dir => {
  const r = await transferVideo(request(dir, { fetch: async () => reply(media, { 'Content-Encoding': 'gzip', 'Content-Length': '32' }) }))
  assert.equal(r.totalBytes, 0)
})
await test('stream error removes part, retains reason', async dir => {
  let n = 0
  await expectCleanFailure(dir, { fetch: async () => reply(new ReadableStream({ pull(c) {
    if (n++ === 0) c.enqueue(media)
    else c.error(new Error('连接中断'))
  } })) }, /连接中断/)
})
await test('cancel before request leaves no file', async dir => {
  const control = new AbortController(); control.abort()
  let called = false
  await expectCleanFailure(dir, { signal: control.signal, fetch: async () => { called = true; return reply() } }, /取消|abort/i)
  assert.equal(called, false)
})
await test('cancel in progress removes part and cancels reader', async dir => {
  const control = new AbortController()
  let cancelled = false
  await expectCleanFailure(dir, { signal: control.signal,
    fetch: async () => reply(new ReadableStream({ start(c) { c.enqueue(media) }, cancel() { cancelled = true } })),
    onProgress: (p: any) => { if (p.receivedBytes) control.abort() }
  }, /取消|abort/i)
  assert.equal(cancelled, true)
})
await test('idle timeout during stalled body', async dir => {
  await expectCleanFailure(dir, { idleTimeoutMs: 30,
    fetch: async () => reply(new ReadableStream({ start(c) { c.enqueue(media) } }))
  }, /超时/)
})
await test('timeout waiting for headers, even if fetch implementation ignores signal', async dir => {
  await expectCleanFailure(dir, { idleTimeoutMs: 30, fetch: () => new Promise(() => {}) }, /超时/)
})
await test('existing target is never fetched or changed', async dir => {
  const destination = path.join(dir, 'episode.mp4'); await fs.writeFile(destination, 'original')
  let called = false
  await assert.rejects(transferVideo(request(dir, { fetch: async () => { called = true; return reply() } })), /存在|EEXIST/)
  assert.equal(called, false)
  assert.equal(await fs.readFile(destination, 'utf8'), 'original')
  assert.deepEqual(await fs.readdir(dir), ['episode.mp4'])
})
await test('competing target appears during transfer and wins', async dir => {
  let created = false
  await assert.rejects(transferVideo(request(dir, { io: { ...fs, link: async (temp: string, target: string) => {
    assert.ok((await fs.stat(temp)).size > 0)
    await fs.writeFile(target, 'competitor'); created = true
    return fs.link(temp, target)
  } } })), /存在|EEXIST/)
  assert.equal(created, true)
  assert.equal(await fs.readFile(path.join(dir, 'episode.mp4'), 'utf8'), 'competitor')
  assert.deepEqual(await fs.readdir(dir), ['episode.mp4'])
})
await test('disk write error closes handle and removes part', async dir => {
  await expectCleanFailure(dir, { io: { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    return { writeFile: async () => { throw new Error('ENOSPC 磁盘空间不足') }, close: () => handle.close(), sync: () => handle.sync() }
  } } }, /ENOSPC/)
})
await test('publication error is not success', async dir => {
  await expectCleanFailure(dir, { io: { ...fs, link: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) } } }, /EPERM|NTFS/)
})
await test('late cancellation after publication stays success', async dir => {
  const control = new AbortController()
  const r = await transferVideo(request(dir, { signal: control.signal, io: { ...fs, link: async (a: string, b: string) => {
    await fs.link(a, b); control.abort()
  } } }))
  assert.deepEqual(await fs.readFile(r.destination), media)
})
await test('cleanup failure after success is explicit warning', async dir => {
  const r = await transferVideo(request(dir, { io: { ...fs, unlink: async () => { throw new Error('文件被占用') } } }))
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /清理.*baoyi-part.*文件被占用/)
  assert.deepEqual(await fs.readFile(r.destination), media)
})
await test('redirect is followed with finite bounds', async dir => {
  let calls = 0
  const r = await transferVideo(request(dir, { fetch: async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { Location: '/new.mp4' } }) : reply() }))
  assert.equal(calls, 2)
  assert.equal(r.receivedBytes, media.length)
})
await test('redirect loops fail, URLs/secrets are not exposed', async dir => {
  let calls = 0
  await expectCleanFailure(dir, { fetch: async () => {
    calls++; return new Response(null, { status: 302, headers: { Location: url } })
  } }, /重定向/)
  assert.ok(calls <= 6)
})
await test('redirect cannot switch protocol', async dir => {
  await expectCleanFailure(dir, { fetch: async () => new Response(null, { status: 302, headers: { Location: 'file:///C:/secret' } }) }, /协议|地址/)
})
await test('network errors redact signed URLs', async dir => {
  try { await transferVideo(request(dir, { fetch: async () => { throw new Error('failed at ' + url) } })); assert.fail('expected failure') }
  catch (err) { assert.ok(!String(err).includes('signature=secret')); assert.match(String(err), /failed/) }
})
await test('real Node fetch + local synthetic HTTP body', async dir => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.write(media.subarray(0, 4)); res.end(media.subarray(4)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const r = await transferVideo(request(dir, { url: 'http://127.0.0.1:' + address.port + '/synthetic.mp4', fetch: async (input: string, init: RequestInit) => {
      try { return await globalThis.fetch(input, init) }
      catch (error: any) { throw new Error(`Local HTTP fixture: ${error.message}; cause=${error.cause?.code || error.cause?.message || 'unknown'}`) }
    } }))
    assert.deepEqual(await fs.readFile(r.destination), media)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())) }
})
console.log('视频流下载回归：' + passed + ' 通过 / ' + failed + ' 失败')
if (failed) process.exitCode = 1
