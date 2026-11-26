import assert from 'node:assert/strict'
import test from 'node:test'
import nativeFs from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { ImageFolderSync } from '../electron/kinds/image/folder-sync.ts'
import { imageOperation } from '../electron/kinds/image/activity.ts'
import { lockImageFiles } from '../electron/kinds/image/management.ts'
import { zipFixture } from './helpers/test-zip.ts'
import { pngImage } from './helpers/test-images.ts'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-photo-sync-')),
  db = new DatabaseSync(':memory:')
initSchema(db, KINDS)
const library = new ImageLibrary(db)
let events = 0
const skipped = new Set<string>(),
  scanned: string[] = []
let warning = false
const sync = new ImageFolderSync(
  () => db,
  () => events++,
  (folder) => skipped.has(folder),
  async (...args) => {
    scanned.push(args[0])
    const result = await scanImageImport(...args)
    if (warning) result[0].warnings.push('测试扫描不完整')
    return result
  }
)
try {
  const folder = path.join(root, '浏览保存')
  await fs.mkdir(folder)
  const first = path.join(folder, '1.png')
  await fs.writeFile(first, pngImage(80, 120))
  const item = library.register((await scanImageImport(folder, 'photo', false))[0])
  const group = library.saveGroup({ name: '浏览保存', type: 'photo', directory: folder })
  library.update(item.id, { groupId: group.id })
  const pid = library.pages(item.id)[0].id
  library.saveProgress(item.id, pid, 0)
  await sync.sync(true)
  await sync.sync(true)
  const baseline = events,
    stamp = library.get(item.id)!.updatedAt
  await sync.sync(true)
  assert.equal(events, baseline)
  assert.equal(library.get(item.id)!.updatedAt, stamp)
  const second = path.join(folder, '2.png')
  await fs.writeFile(second, pngImage(120, 80))
  await sync.sync(true)
  assert.equal(library.pages(item.id).length, 1, 'wait for stable copy')
  await sync.sync(true)
  assert.equal(library.pages(item.id).length, 2)
  assert.equal(library.get(item.id)!.groupId, group.id)
  assert.equal(library.get(item.id)!.progress!.pageId, pid)
  await fs.unlink(second)
  await sync.sync(true)
  await sync.sync(true)
  assert.equal(library.pages(item.id).length, 1)
  await fs.rename(folder, folder + '-offline')
  await sync.sync(true)
  assert.equal(library.pages(item.id).length, 1, 'offline root preserves index')
  await fs.rename(folder + '-offline', folder)
  await fs.unlink(first)
  await sync.sync(true)
  await sync.sync(true)
  assert.equal(library.pages(item.id).length, 0, 'empty accessible folder clears gallery only')
  await fs.writeFile(first, pngImage(80, 120))
  await sync.sync(true)
  await sync.sync(true)
  assert.equal(library.pages(item.id)[0].id, pid)
  library.remove(item.id)
  await sync.sync(true)
  assert.equal(library.list().length, 0, 'removed albums stay removed')
  const comic = path.join(root, '漫画'),
    other = path.join(root, '另一部漫画')
  const chapter = async (folder: string, name: string) => {
    const dir = path.join(folder, name)
    await fs.mkdir(dir, { recursive: true })
    for (let n = 1; n <= 3; n++) await fs.writeFile(path.join(dir, n + '.png'), pngImage(80, 120))
  }
  await chapter(comic, '第1章')
  await chapter(comic, '第2章')
  await chapter(other, '第1章')
  const book = library.register((await scanImageImport(comic, 'comic', false))[0])
  library.register((await scanImageImport(other, 'comic', false))[0])
  const reading = library.pages(book.id)[5]
  library.saveProgress(book.id, reading.id, 0.3)
  library.update(book.id, { coverPageId: reading.id })
  library.saveChapter(book.id, reading.chapterId!, '我的第二章', 0)
  await sync.sync(true)
  await sync.sync(true)
  await new Promise((r) => setTimeout(r, 100))
  await sync.sync()
  scanned.length = 0
  await sync.sync()
  assert.equal(scanned.length, 0, 'idle ticks do not scan pages')
  await chapter(comic, '第3章')
  await new Promise((r) => setTimeout(r, 100))
  scanned.length = 0
  await sync.sync()
  assert.equal(library.get(book.id)!.chapterCount, 2)
  await sync.sync()
  assert.equal(library.get(book.id)!.chapterCount, 3)
  assert.ok(
    scanned.length >= 2 && scanned.every((p) => p === comic),
    'only dirty/candidate work scanned'
  )
  assert.equal(library.get(book.id)!.progress!.pageId, reading.id)
  assert.equal(library.get(book.id)!.coverPageId, reading.id)
  assert.equal(
    library.get(book.id)!.chapters.find((c) => c.id === reading.chapterId)!.title,
    '我的第二章'
  )
  await fs.rm(path.join(comic, '第2章'), { recursive: true })
  await sync.sync(true)
  await sync.sync()
  assert.equal(library.get(book.id)!.chapterCount, 2)
  assert.equal(
    (db.prepare('SELECT missing FROM image_pages WHERE id=?').get(reading.id) as any).missing,
    1
  )
  assert.equal(
    (db.prepare('SELECT page_id FROM image_progress WHERE resource_id=?').get(book.id) as any)
      .page_id,
    reading.id
  )
  await chapter(comic, '第4章')
  skipped.add(comic)
  scanned.length = 0
  await sync.sync(true)
  assert.ok(!scanned.includes(comic))
  skipped.clear()
  const unlock = lockImageFiles(book.id)
  scanned.length = 0
  await sync.sync()
  assert.equal(scanned.length, 0)
  unlock()
  await imageOperation(async () => {
    scanned.length = 0
    await sync.sync(true)
    assert.equal(scanned.length, 0)
  })
  warning = true
  await sync.sync(true)
  await sync.sync()
  assert.equal(library.get(book.id)!.chapterCount, 2)
  warning = false
  await sync.sync()
  await sync.sync()
  assert.equal(library.get(book.id)!.chapterCount, 3)
  const zip = path.join(root, '归档.cbz')
  await fs.writeFile(zip, zipFixture([{ name: '1.png', data: pngImage(80, 120) }]))
  const archived = library.register((await scanImageImport(zip, 'comic', false))[0])
  await sync.sync(true)
  await sync.sync()
  scanned.length = 0
  await sync.sync(true)
  assert.ok(!scanned.includes(zip), 'unchanged archives skip page scans')
  const time = new Date(Date.now() + 2000)
  await fs.utimes(zip, time, time)
  scanned.length = 0
  await sync.sync(true)
  await sync.sync()
  assert.ok(scanned.includes(zip), 'changed archive mtime rescanned')
  assert.equal(library.get(archived.id)!.pageCount, 1)
  await chapter(path.join(root, '未登记作品'), '第1章')
  const count = library.list().length
  await sync.sync(true)
  assert.equal(library.list().length, count, 'new work directories require manual import')
  const hidden = library.saveGroup({ name: '隐藏漫画', type: 'comic' })
  library.update(book.id, { groupId: hidden.id })
  library.saveGroup({ ...hidden, hidden: true })
  scanned.length = 0
  await sync.sync(true)
  assert.ok(!scanned.includes(comic), 'hidden groups are excluded')
  console.log(
    'PASS photo/comic stable sync, dirty-only scanning, progress/custom metadata, missing pages, busy/locked/downloading skips, warnings and CBZ mtime'
  )
} finally {
  sync.stop()
  db.close()
  assert.equal(path.dirname(root), os.tmpdir())
  await fs.rm(root, { recursive: true, force: true })
}

test('shared watchers stay bounded; focus is dirty-only and offline paths back off', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-sync-scale-'))
  const db = new DatabaseSync(':memory:')
  initSchema(db, KINDS)
  const library = new ImageLibrary(db),
    scans: string[] = [],
    watched: string[] = []
  const originalWatch = nativeFs.watch,
    originalStat = fs.lstat
  let probes = 0,
    now = Date.now()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(nativeFs, 'watch', (...args: Parameters<typeof nativeFs.watch>) => {
    watched.push(String(args[0]))
    return originalWatch(...args)
  })
  const sync = new ImageFolderSync(
    () => db,
    () => {},
    () => false,
    async (...args) => {
      scans.push(args[0])
      return scanImageImport(...args)
    }
  )
  t.after(async () => {
    await sync.stop()
    db.close()
    assert.equal(path.dirname(root), os.tmpdir())
    await fs.rm(root, { recursive: true, force: true })
  })
  const shelf = path.join(root, 'shelf')
  for (let index = 0; index < 40; index++) {
    const folder = path.join(shelf, String(index))
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, '1.png'), pngImage(8, 12))
    library.register((await scanImageImport(folder, 'photo', false))[0])
  }
  await sync.sync(true)
  await sync.sync()
  await new Promise((r) => setTimeout(r, 100))
  await sync.sync()
  assert.equal(watched.length, 1, 'sibling works share one parent watcher')
  scans.length = 0
  now += 11 * 60 * 1000
  sync.focus()
  await sync.sync()
  assert.equal(scans.length, 0, 'focus must not scan every page after ten minutes')
  const offline = path.join(shelf, '0')
  await fs.rename(offline, offline + '-offline')
  await new Promise((r) => setTimeout(r, 100))
  t.mock.method(fs, 'lstat', (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === offline) probes++
    return originalStat(...args)
  })
  await sync.sync(true)
  for (let tick = 0; tick < 8; tick++) await sync.sync()
  assert.equal(probes, 1, 'offline works are not retried on each tick')
  await fs.rename(offline + '-offline', offline)
  await fs.writeFile(path.join(offline, '2.png'), pngImage(9, 12))
  await new Promise((r) => setTimeout(r, 100))
  await sync.sync()
  await sync.sync()
  assert.equal(
    library.list().find((item) => item.path === offline)?.pageCount,
    2,
    'parent event restores an offline work'
  )
  for (let index = 0; index < 40; index++) {
    const folder = path.join(root, 'separate-' + index, 'work')
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, '1.png'), pngImage(8, 12))
    library.register((await scanImageImport(folder, 'photo', false))[0])
  }
  await sync.sync(true)
  assert.ok(
    watched.length <= 32,
    'at most 32 root watchers, remaining roots use periodic reconciliation'
  )
})
