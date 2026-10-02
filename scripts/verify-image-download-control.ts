import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createImageDownloads } from '../electron/kinds/image/downloads.ts'
import { PicacomicSource } from '../electron/kinds/image/source.ts'
import { pngImage } from './helpers/test-images.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-image-control-'))
const db = new DatabaseSync(path.join(root, 'fixture.db'))
db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
const png = pngImage(14, 20)
const chapters = [{ id: 'c1', title: '第一章', order: 1 }]
const work = (id: string) => ({ id, title: id, author: 'fixture', description: '', tags: [], chapters: 1, pages: 0, finished: true })
const calls: string[] = [], timings: Array<{ key: string; at: number }> = []
let resume = false, active = 0, peak = 0, limitedAt = 0
const limitedWorks = new Set<string>()
const source = new PicacomicSource({ token: () => '', wait: async () => {}, fetch: async (raw, init) => {
  const url = new URL(raw)
  if (url.pathname.includes('/order/')) {
    const id = url.pathname.split('/')[2], count = id === 'parallel' ? 16 : ['paused', 'limited', 'failure'].includes(id) ? 4 : 1
    return Response.json({ code: 200, data: { pages: { pages: 1, docs: Array.from({ length: count }, (_, i) => ({
      _id: `p${i + 1}`, media: { fileServer: 'https://images.picacomic.com', path: `${id}/${i + 1}` },
    })) } } })
  }
  const [, , id, n] = url.pathname.split('/'), key = `${id}/${n}`
  calls.push(key); timings.push({ key, at: Date.now() })
  active++; peak = Math.max(peak, active)
  try {
    if ((id === 'paused' && n === '2' && !resume) || id === 'block' || (id === 'failure' && n !== '1')) {
      return await new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error('aborted'))
        else init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    if (id === 'failure') { await delay(20); return new Response('', { status: 404 }) }
    if (['limited', 'limitedPaused'].includes(id) && !limitedWorks.has(id)) { limitedWorks.add(id); limitedAt = Date.now(); return new Response('', { status: 429, headers: { 'retry-after': '0.5' } }) }
    await delay(id === 'parallel' ? (Number(n) % 3 + 1) * 8 : 5, undefined, { signal: init?.signal || undefined })
    return new Response(new Uint8Array(png))
  } finally { active-- }
} })
let queue = createImageDownloads({ db, source, changed: () => {} })
async function until(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check() && Date.now() < end) await delay(5)
  assert.ok(check(), 'fixture did not reach expected state')
}
try {
  assert.equal(typeof queue.pause, 'function', '下载必须支持明确的暂停状态')
  assert.equal(queue.options().concurrency, 2)
  assert.throws(() => queue.options({ concurrency: 0 }))
  assert.throws(() => queue.options({ concurrency: 4 }))
  queue.options({ concurrency: 1 })
  const paused = await queue.enqueue(work('paused'), chapters, root, null)
  await until(() => calls.includes('paused/2') && queue.list().find(j => j.id === paused.id)!.processed === 1)
  await queue.retry(paused.id)
  assert.equal(queue.list().find(j => j.id === paused.id)?.status, 'running', '运行中重试必须立即空操作，不能等完成后再启动一遍')
  await queue.pause(paused.id); await queue.idle()
  assert.equal(queue.list()[0].status, 'paused')
  assert.equal(active, 0, '暂停返回前全部传输已收敛')
  assert.equal(queue.list()[0].progress?.bytesPerSecond, 0)
  await assert.rejects(queue.enqueue(work('paused'), chapters, root, null), /已有下载任务/)
  queue = createImageDownloads({ db, source, changed: () => {} })
  assert.equal(queue.options().concurrency, 1)
  assert.equal(queue.list()[0].status, 'paused')
  resume = true
  await queue.resume(paused.id); await queue.idle()
  assert.equal(queue.list().find(j => j.id === paused.id)?.status, 'success')
  assert.equal(calls.filter(key => key === 'paused/1').length, 1)
  assert.equal(calls.filter(key => key === 'paused/2').length, 2)

  const block = await queue.enqueue(work('block'), chapters, root, null)
  await until(() => calls.includes('block/1'))
  const b = await queue.enqueue(work('b'), chapters, root, null)
  const c = await queue.enqueue(work('c'), chapters, root, null)
  const d = await queue.enqueue(work('d'), chapters, root, null)
  await queue.pause(b.id)
  queue.move(d.id, 'up')
  assert.deepEqual(queue.list().filter(j => j.status === 'queued').map(j => j.work.id), ['d', 'c'])
  const persistedOrder = (id: string) => JSON.parse((db.prepare('SELECT payload FROM image_download_jobs WHERE id=?').get(id) as { payload: string }).payload).queueOrder
  assert.ok(persistedOrder(d.id) < persistedOrder(c.id), '队列顺序必须持久化')
  const racing = await Promise.allSettled([queue.enqueue(work('race'), chapters, root, null), queue.enqueue(work('race'), chapters, root, null)])
  assert.equal(racing.filter(result => result.status === 'fulfilled').length, 1, '并发入队不能创建同作品的重复活动任务')
  assert.throws(() => queue.move(block.id, 'up'), /排队/)
  await queue.cancel(block.id); await queue.idle()
  assert.deepEqual(calls.filter(key => /^[bcd]\//.test(key)), ['d/1', 'c/1'])
  assert.equal(queue.list().find(j => j.id === b.id)?.status, 'paused')
  assert.equal(queue.list().find(j => j.id === c.id)?.status, 'success')
  await queue.resume(b.id); await queue.idle()
  assert.equal(calls.filter(key => key === 'b/1').length, 1)

  queue.options({ concurrency: 3 }); peak = 0
  const parallel = await queue.enqueue(work('parallel'), chapters, root, null)
  await queue.idle()
  const complete = queue.list().find(j => j.id === parallel.id)!
  assert.equal(complete.status, 'success', complete.error)
  assert.equal(peak, 3)
  assert.equal(complete.processed, 16)
  const resource = db.prepare('SELECT path FROM resource WHERE id=?').get(complete.resourceId) as { path: string }
  const manifest = JSON.parse(fs.readFileSync(path.join(resource.path, '.baoyi-image.json'), 'utf8'))
  assert.equal(Object.keys(manifest.pages).length, 16)
  for (const entry of Object.values(manifest.pages) as Array<{ file: string; sha256: string }>) {
    const bytes = fs.readFileSync(path.join(resource.path, entry.file))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256)
  }
  const pages = db.prepare('SELECT file FROM image_pages WHERE resource_id=? ORDER BY ordinal').all(complete.resourceId) as Array<{ file: string }>
  assert.deepEqual(pages.map(row => Number(path.basename(row.file).slice(0, 5))), Array.from({ length: 16 }, (_, i) => i + 1))

  const rate = await queue.enqueue(work('limited'), chapters, root, null)
  await queue.idle()
  assert.equal(queue.list().find(j => j.id === rate.id)?.status, 'success')
  assert.equal(queue.list().find(j => j.id === rate.id)?.progress?.effectiveConcurrency, 1)
  assert.ok(timings.filter(t => t.key.startsWith('limited/')).slice(3).every(t => t.at >= limitedAt + 450), '新请求和重试都受共享退避限制')

  const cooldown = await queue.enqueue(work('limitedPaused'), chapters, root, null)
  await until(() => queue.list().find(j => j.id === cooldown.id)?.progress?.phase === 'rate-limited')
  const cooldownStart = limitedAt
  await queue.pause(cooldown.id)
  queue = createImageDownloads({ db, source, changed: () => {} })
  await queue.resume(cooldown.id); await queue.idle()
  assert.ok(timings.filter(t => t.key.startsWith('limitedPaused/')).slice(1).every(t => t.at >= cooldownStart + 450), '暂停和重启不能绕过服务器尚未结束的等待时间')

  const failure = await queue.enqueue(work('failure'), chapters, root, null)
  await queue.idle()
  assert.equal(queue.list().find(j => j.id === failure.id)?.status, 'failed')
  assert.match(queue.list().find(j => j.id === failure.id)!.error, /404/)
  assert.equal(active, 0, '第一个失败发生后等待其他 worker 退出')
  assert.equal(fs.readdirSync(root, { recursive: true }).some(name => String(name).endsWith('.part')), false)
} finally { db.close() }
console.log('PASS 暂停续传、队列排序、重启持久化、三路并发、清单完整、共享限流及失败收敛')
