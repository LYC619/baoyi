import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { createImageDownloads } from '../electron/kinds/image/downloads.ts'
import { PicacomicSource } from '../electron/kinds/image/source.ts'
import { pngImage } from './helpers/test-images.ts'
import { setTimeout as delay } from 'node:timers/promises'

assert.ok(fs.existsSync(new URL('../electron/kinds/image/updates.ts', import.meta.url)), '必须提供按来源章节 ID 检查更新的服务')
const { createImageUpdates } = await import('../electron/kinds/image/updates.ts')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-image-updates-'))
const db = new DatabaseSync(path.join(root, 'fixture.db')); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
const calls: string[] = [], data = pngImage(24, 36)
let remoteChapters = [{ _id: 'c1', title: 'Same title', order: 1 }, { _id: 'c2', title: 'Second', order: 2 }]
const source = new PicacomicSource({ token: () => 'fixture', fetch: async (raw, init) => {
  const url = new URL(raw); calls.push(url.pathname)
  if (url.pathname.includes('/static/')) {
    if (url.pathname.endsWith('/99')) await delay(30000, undefined, { signal: init?.signal || undefined })
    return new Response(new Uint8Array(data))
  }
  const match = url.pathname.match(/\/order\/(\d+)\/pages/)
  if (match) return Response.json({ code: 200, data: { pages: { pages: 1, docs: [{ _id: 'p' + match[1], media: { fileServer: 'https://images.picacomic.com', path: match[1] } }] } } })
  if (url.pathname.endsWith('/eps')) return Response.json({ code: 200, data: { eps: { pages: 1, docs: remoteChapters } } })
  return Response.json({ code: 200, data: { comic: { _id: 'work', title: 'Remote title', description: 'Remote description', tags: ['remote'], pagesCount: remoteChapters.length, epsCount: remoteChapters.length, finished: true } } })
} })
try {
  const library = new ImageLibrary(db), queue = createImageDownloads({ db, source, changed: () => {} })
  const details = await source.detail('work')
  await queue.enqueue(details.work, details.chapters, root, null); await queue.idle()
  const item = library.list()[0], pages = library.pages(item.id)
  const group = library.saveGroup({ name: 'custom' })
  library.update(item.id, { name: 'Local title', description: 'Local notes', tags: ['local'], groupId: group.id, favorite: true, publication: 'ongoing', coverPageId: pages[1].id })
  library.saveChapter(item.id, item.chapters[1].id, 'Local second', -1)
  library.saveProgress(item.id, pages[1].id, 0.4)
  fs.unlinkSync(pages[0].file)
  remoteChapters = [{ _id: 'c0', title: 'Preface', order: 0 }, { _id: 'c1', title: 'Remote renamed', order: 1 }, { _id: 'c2', title: 'Second renamed', order: 2 }, { _id: 'c3', title: 'Same title', order: 3 }]
  const updates = createImageUpdates({ db, source, queue })
  const before = library.get(item.id)!, fileTime = fs.statSync(pages[1].file).mtimeMs
  const manifestFile = path.join(item.path, '.baoyi-image.json'), manifestBytes = fs.readFileSync(manifestFile)
  calls.length = 0
  const check = await updates.check(item.id)
  assert.deepEqual(check.chapters.map(c => [c.id, c.status]), [['c0', 'new'], ['c1', 'incomplete'], ['c2', 'downloaded'], ['c3', 'new']])
  assert.equal(check.chapters.find(c => c.id === 'c2')?.localTitle, 'Local second')
  assert.ok(calls.every(url => !url.includes('/static/') && !url.includes('/order/')))
  assert.deepEqual(library.get(item.id), before)
  assert.deepEqual(fs.readFileSync(manifestFile), manifestBytes)
  await assert.rejects(updates.download(item.id, ['c1']), /新增/)
  await assert.rejects(updates.download(item.id, ['unknown']), /新增|来源/)
  await assert.rejects(updates.download(item.id, []), /选择/)
  calls.length = 0
  const job = await updates.download(item.id, ['c3', 'c0']); await queue.idle()
  assert.equal(queue.list().find(j => j.id === job.id)?.status, 'success')
  assert.deepEqual(calls.filter(url => url.includes('/static/')).sort(), ['/static/0', '/static/3'])
  assert.equal(fs.statSync(pages[1].file).mtimeMs, fileTime)
  assert.equal(fs.existsSync(pages[0].file), false, '补新章节不隐式修复旧章')
  const after = library.get(item.id)!
  for (const field of ['id', 'path', 'name', 'description', 'tags', 'groupId', 'publication', 'favorite', 'coverPageId', 'progress'] as const) assert.deepEqual(after[field], before[field], `保留 ${field}`)
  assert.deepEqual(after.chapters.map(c => c.sourceId), ['c2', 'c1', 'c0', 'c3'], '新增章节追加在用户手排章节之后')
  const { scanImageImport } = await import('../electron/kinds/image/scanner.ts')
  library.register((await scanImageImport(item.path, 'comic', false))[0])
  assert.deepEqual(library.get(item.id)!.chapters.map(c => c.sourceId), ['c2', 'c1', 'c0', 'c3'], '再次扫描不挤乱手排章节')
  await assert.rejects(updates.download(item.id, ['c3']), /新增/)
  remoteChapters = remoteChapters.filter(c => c._id !== 'c2')
  assert.equal((await updates.check(item.id)).chapters.find(c => c.id === 'c2')?.status, 'unavailable')
  assert.ok(fs.existsSync(pages[1].file), '来源下架不删除本地章节')
  const legacy = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); for (const chapter of legacy.chapters) delete chapter.pageIds
  fs.writeFileSync(manifestFile, JSON.stringify(legacy))
  assert.equal((await updates.check(item.id)).chapters.find(c => c.id === 'c3')?.status, 'unverified')
  library.saveGroup({ ...group, hidden: true }); calls.length = 0
  await assert.rejects(updates.check(item.id), /不可用/)
  await assert.rejects(updates.download(item.id, ['c9']), /不可用/)
  assert.equal(calls.length, 0, '隐藏作品不发来源请求')
  library.saveGroup({ ...group, hidden: false })
  remoteChapters.push({ _id: 'c9', title: 'Later chapter', order: 9 })
  const blocker = await queue.enqueue({ ...details.work, id: 'blocker' }, [{ id: 'blocking', title: 'Blocking fixture', order: 99 }], root, null)
  const queued = await updates.download(item.id, ['c9'])
  assert.equal(queued.status, 'queued')
  assert.equal(queued.resourceId, item.id)
  const beforeRemoval = fs.readFileSync(manifestFile)
  library.remove(item.id)
  await queue.cancel(blocker.id); await queue.idle()
  const terminal = db.prepare('SELECT status,payload FROM image_download_jobs WHERE id=?').get(queued.id) as { status: string; payload: string }
  assert.equal(terminal.status, 'failed')
  assert.match(JSON.parse(terminal.payload).error, /移除|隐藏/)
  assert.equal(library.get(item.id), null)
  assert.deepEqual(fs.readFileSync(manifestFile), beforeRemoval)
  console.log('PASS ID 对照、只读检查、选择新章、原目录与手改资料保留、顺序稳定、旧清单及隐藏保护')
} finally { db.close() }
