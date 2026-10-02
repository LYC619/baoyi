import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { PicacomicSource } from '../electron/kinds/image/source.ts'
import { createImageDownloads } from '../electron/kinds/image/downloads.ts'
import { auditImage } from '../electron/kinds/image/integrity.ts'
import { pngImage } from './helpers/test-images.ts'
import { setTimeout as delay } from 'node:timers/promises'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-image-repair-'))
const db = new DatabaseSync(path.join(root, 'fixture.db')); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
const calls: string[] = [], data = pngImage(30, 45)
let extraPage = false, removed = false, hold = false, changedFormat = false, extraFirst = false
const source = new PicacomicSource({ token: () => 'test', fetch: async (raw: string, init?: RequestInit) => {
  const url = new URL(raw)
  if (url.pathname.includes('/static/')) {
    calls.push(url.pathname)
    if (hold) await delay(30000, undefined, { signal: init?.signal || undefined })
    return new Response(new Uint8Array(changedFormat ? Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64') : data))
  }
  const first = url.pathname.includes('/order/1/')
  const ids = first ? [...(removed ? ['p1'] : ['p1', 'p2']), ...(extraPage ? ['p4'] : [])] : ['p3']
  if (first && extraFirst) ids.unshift(ids.pop()!)
  return Response.json({ code: 200, data: { pages: { pages: 1, docs: ids.map(id => ({ _id: id, media: { fileServer: 'https://images.picacomic.com', path: id } })) } } })
} })
try {
  const library = new ImageLibrary(db), originalGroup = library.saveGroup({ name: 'original' }), customGroup = library.saveGroup({ name: 'custom' })
  let queue = createImageDownloads({ db, source, changed: () => {} })
  const work = { id: 'repair-work', title: 'Original title', author: '', description: '', tags: ['remote'], pages: 3, chapters: 2, finished: false }
  const chapters = [{ id: 'c1', title: 'Chapter one', order: 1 }, { id: 'c2', title: 'Chapter two', order: 2 }]
  const original = await queue.enqueue(work, chapters, root, originalGroup.id); await queue.idle()
  assert.equal(queue.list()[0].status, 'success')
  assert.equal(typeof queue.repair, 'function', '队列必须支持按作品修复，不依赖旧任务记录')
  const item = library.list()[0], pages = library.pages(item.id)
  library.update(item.id, { name: 'My title', tags: ['custom'], groupId: customGroup.id, publication: 'completed' })
  library.saveChapter(item.id, item.chapters[1].id, 'My second chapter', -1)
  library.saveProgress(item.id, pages[2].id, 0.3)
  const custom = library.get(item.id)!, good = pages[2], before = fs.statSync(good.file).mtimeMs
  fs.unlinkSync(pages[0].file); fs.writeFileSync(pages[1].file, pngImage(30, 45, [1, 2, 3]))
  const audit = await auditImage(db, item.id)
  assert.equal(audit.catalogComplete, true)
  assert.deepEqual([audit.ok, audit.missing, audit.damaged], [1, 1, 1])
  queue.dismiss(original.id); extraPage = true; calls.length = 0
  const repair = await queue.repair(item.id)
  assert.ok(repair)
  await queue.idle()
  assert.equal(queue.list().find(j => j.id === repair.id)?.status, 'success')
  assert.deepEqual(calls.sort(), ['/static/p1', '/static/p2'])
  assert.equal(fs.statSync(good.file).mtimeMs, before)
  assert.deepEqual(fs.readFileSync(good.file), data)
  const after = library.get(item.id)!
  for (const field of ['name', 'tags', 'groupId', 'publication', 'chapters', 'progress'] as const) assert.deepEqual(after[field], custom[field], `保留 ${field}`)
  const repaired = await auditImage(db, item.id)
  assert.deepEqual([repaired.total, repaired.ok, repaired.missing, repaired.damaged], [3, 3, 0, 0])
  assert.equal(await queue.repair(item.id), null, '完好文件不创建任务')
  fs.unlinkSync(pages[1].file); removed = true; calls.length = 0
  const unavailable = await queue.repair(item.id); await queue.idle()
  assert.equal(queue.list().find(j => j.id === unavailable!.id)?.status, 'failed')
  assert.match(queue.list().find(j => j.id === unavailable!.id)!.error, /来源.*页面|页面.*来源/)
  assert.equal(calls.length, 0)
  removed = false; hold = true; calls.length = 0
  const resumable = await queue.repair(item.id)
  const deadline = Date.now() + 4000
  while (!calls.length && Date.now() < deadline) await delay(10)
  assert.ok(calls.length)
  await queue.pause(resumable!.id); await queue.idle()
  queue = createImageDownloads({ db, source, changed: () => {} })
  assert.equal(queue.list().find(j => j.id === resumable!.id)?.status, 'paused')
  hold = false; calls.length = 0
  await queue.resume(resumable!.id); await queue.idle()
  assert.deepEqual(calls, ['/static/p2'])
  assert.equal(queue.list().find(j => j.id === resumable!.id)?.status, 'success')
  fs.writeFileSync(pages[1].file, pngImage(30, 45, [8, 7, 6])); changedFormat = true
  const oldBytes = fs.readFileSync(pages[1].file)
  const incompatible = await queue.repair(item.id); await queue.idle()
  assert.equal(queue.list().find(j => j.id === incompatible!.id)?.status, 'failed', '来源换格式时不能创建重复页或丢失阅读位置')
  assert.match(queue.list().find(j => j.id === incompatible!.id)!.error, /格式/)
  assert.deepEqual(fs.readFileSync(pages[1].file), oldBytes)
  assert.equal(library.get(item.id)!.pageCount, 3)
  changedFormat = false
  await queue.repair(item.id); await queue.idle()
  const manifestFile = path.join(item.path, '.baoyi-image.json'), savedManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  savedManifest.chapters.find((c: any) => c.id === 'c1').pageIds.push('p4')
  fs.writeFileSync(manifestFile, JSON.stringify(savedManifest)); extraFirst = true
  const latePage = await queue.repair(item.id); await queue.idle()
  assert.equal(queue.list().find(j => j.id === latePage!.id)?.status, 'success')
  const finalManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  assert.match(path.basename(finalManifest.pages['c1:p4'].file), /^00003-/, '无旧文件的待修复页也要沿用本地清单顺序')
  library.saveGroup({ ...customGroup, hidden: true })
  await assert.rejects(queue.repair(item.id), /不可用/)
  console.log('PASS 按作品定向修复、原图字节、好页不动、旧任务可删除、远端新增隔离和本地编辑保留')
} finally { db.close() }
