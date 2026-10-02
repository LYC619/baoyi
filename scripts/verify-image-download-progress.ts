import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { PicacomicSource } from '../electron/kinds/image/source.ts'
import { createImageDownloads } from '../electron/kinds/image/downloads.ts'
import { pngImage } from './helpers/test-images.ts'
import type { ImageDownloadJob } from '../src/types/image.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-image-progress-'))
const db = new DatabaseSync(path.join(root, 'fixture.db'))
db.exec('PRAGMA foreign_keys=ON')
initSchema(db, KINDS)
const png = pngImage(12, 18)
const chapters = [{ id: 'c1', title: '第一章', order: 1 }, { id: 'c2', title: '第二章', order: 2 }]
const work = { id: 'progress1', title: '下载进度测试', author: 'fixture', description: '', tags: [], chapters: 2, pages: 999, finished: true }
const snapshots: ImageDownloadJob[] = []
const imageTotals: number[] = []
let limited = false, firstImageCatalogs = 0, catalogs = 0, waits = 0, libraryChanges = 0
let queue: ReturnType<typeof createImageDownloads>
const source = new PicacomicSource({
  token: () => 'synthetic', wait: async () => { waits++ },
  fetch: async url => {
    if (url.includes('/order/')) {
      catalogs++
      const names = url.includes('/order/1/') ? ['a', 'b'] : ['c']
      return Response.json({ code: 200, data: { pages: { pages: 1, docs: names.map(name => ({
        _id: name, media: { fileServer: 'https://images.picacomic.com', path: name },
      })) } } })
    }
    if (!imageTotals.length) firstImageCatalogs = catalogs
    imageTotals.push(queue.list()[0].total)
    if (url.endsWith('/b') && !limited) { limited = true; return new Response('', { status: 429, headers: { 'retry-after': '1' } }) }
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(png.subarray(0, 12)))
      controller.enqueue(new Uint8Array(png.subarray(12)))
      controller.close()
    } }), { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } })
  },
})
queue = createImageDownloads({ db, source, changed: () => { libraryChanges++ }, jobsChanged: () => { const job = queue?.list()[0]; if (job) snapshots.push(job) } })
try {
  const first = await queue.enqueue(work, chapters, root, null)
  await queue.idle()
  assert.equal(queue.list()[0].status, 'success')
  assert.equal(imageTotals[0], 3, '整部总页数应在正文下载前确定，而不是逐章增长')
  assert.equal(firstImageCatalogs, 2, '先收集全部所选章节，而不是采用来源整部 pagesCount')
  assert.ok(imageTotals.every(total => total === 3))
  assert.ok(snapshots.filter(job => job.progress?.totalKnown).every(job => job.total === 3))
  assert.ok(snapshots.some(job => job.progress?.phase === 'catalog'))
  assert.ok(snapshots.some(job => job.progress?.phase === 'receiving'))
  assert.ok(snapshots.some(job => job.progress?.phase === 'rate-limited' && job.progress.retryAt > 0))
  assert.equal(waits, 1)
  assert.equal(libraryChanges, 2, '字节流和下载状态不能触发整个书架重载')
  const complete = queue.list()[0]
  assert.equal(complete.progress?.receivedBytes, png.length * 3)
  assert.equal(complete.progress?.storedBytes, png.length * 3)
  assert.equal(complete.progress?.reusedPages, 0)
  assert.equal(complete.progress?.chapterProcessed, 1)
  assert.equal(complete.progress?.chapterTotal, 1)
  assert.equal(complete.progress?.bytesPerSecond, 0)
  assert.equal(complete.progress?.retryAt, 0)

  const count = imageTotals.length
  await queue.retry(first.id)
  await queue.idle()
  const reused = queue.list()[0]
  assert.equal(imageTotals.length, count)
  assert.equal(reused.progress?.reusedPages, 3)
  assert.equal(reused.progress?.receivedBytes, 0)
  assert.equal(reused.progress?.storedBytes, png.length * 3)
  assert.equal(reused.processed, 3)

  const payload = { ...reused, status: 'running' }
  delete payload.progress
  db.prepare("UPDATE image_download_jobs SET payload=?,status='running' WHERE id=?").run(JSON.stringify(payload), first.id)
  queue = createImageDownloads({ db, source, changed: () => {} })
  const historic = queue.list()[0]
  assert.equal(historic.status, 'interrupted')
  assert.equal(historic.progress?.bytesPerSecond, 0)
  assert.equal(historic.progress?.receivedBytes, 0)
  assert.equal(historic.progress?.retryAt, 0)
  await queue.idle()
  assert.equal(imageTotals.length, count, '载入旧任务不应自动开始下载')

  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const stalled = new PicacomicSource({ token: () => '', fetch: async (url, init) => {
    if (url.includes('/order/')) return Response.json({ code: 200, data: { pages: { pages: 1, docs: [{ _id: 'stall', media: { fileServer: 'https://images.picacomic.com', path: 'stall' } }] } } })
    entered()
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new TypeError('cancelled fixture')), { once: true }))
  } })
  queue = createImageDownloads({ db, source: stalled, changed: () => {} })
  const stopping = await queue.enqueue({ ...work, id: 'cancelled1' }, chapters.slice(0, 1), root, null)
  await started
  queue.cancel(stopping.id)
  await queue.idle()
  const stopped = queue.list().find(job => job.id === stopping.id)!
  assert.equal(stopped.status, 'cancelled')
  assert.equal(stopped.progress?.phase, 'idle')
  assert.equal(stopped.progress?.bytesPerSecond, 0)
  assert.equal(stopped.progress?.retryAt, 0)
} finally { db.close() }
console.log('PASS 下载固定分母、分章进度、分块字节数、限流状态、复用页与旧任务兼容')
