import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, SCHEMA_KEY } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { buildLibraryBackup, restoreLibraryBackup } from '../electron/services/library-backup.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { pngImage } from './helpers/test-images.ts'

assert.ok(fs.existsSync(new URL('../electron/kinds/image/reader-state.ts', import.meta.url)), '必须提供作品级阅读设置和书签服务')
const { ImageReaderState } = await import('../electron/kinds/image/reader-state.ts')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-image-reader-state-'))
const db = new DatabaseSync(path.join(root, 'fixture.db')); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS); db.exec(VIDEO_JOBS_SQL)
try {
  const library = new ImageLibrary(db), reader = new ImageReaderState(db)
  const items = []
  for (const name of ['first', 'second']) {
    const directory = path.join(root, name); fs.mkdirSync(directory)
    for (let n = 1; n <= 3; n++) fs.writeFileSync(path.join(directory, `${n}.png`), pngImage(24, 36))
    items.push(library.register((await scanImageImport(directory, 'comic', false))[0]))
  }
  const [first, second] = items, pages = library.pages(first.id), otherPage = library.pages(second.id)[0]
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('_image_reader', JSON.stringify({ mode: 'single', direction: 'rtl', fit: 'screen' }))
  const defaults = reader.preferences()
  assert.deepEqual(defaults, { mode: 'single', direction: 'rtl', fit: 'screen', coverSingle: true, zoom: 1 })
  assert.deepEqual(reader.forWork(first.id), { preferences: defaults, customized: false })
  const custom = { ...defaults, mode: 'double' as const, zoom: 1.5, coverSingle: false }
  assert.equal(reader.forWork(first.id, custom).customized, true)
  reader.preferences({ ...defaults, mode: 'scroll' })
  assert.deepEqual(reader.forWork(first.id).preferences, custom)
  assert.equal(reader.forWork(second.id).preferences.mode, 'scroll')
  assert.throws(() => reader.forWork(first.id, { ...custom, zoom: 9 }), /设置|缩放/)
  assert.throws(() => reader.forWork(first.id, { ...custom, coverSingle: 'yes' } as any), /设置/)
  assert.throws(() => reader.forWork(first.id, { ...custom, zoom: null } as any), /设置|缩放/)
  assert.throws(() => library.update(first.id, { name: 'Invalid edit', read: 'yes' } as any), /状态/)
  assert.equal(library.get(first.id)!.name, first.name, '无效已读输入不能留下部分资料修改')
  library.update(first.id, { read: true })
  library.saveProgress(first.id, pages[1].id, 0.45)
  assert.equal(library.get(first.id)!.read, true)
  assert.equal(library.get(first.id)!.publication, 'unknown')
  library.update(first.id, { publication: 'completed' })
  library.update(first.id, { read: false })
  assert.equal(library.get(first.id)!.publication, 'completed')
  assert.equal(library.get(first.id)!.progress?.pageId, pages[1].id)
  library.update(first.id, { read: true })
  const bookmark = reader.saveBookmark(first.id, pages[1].id, 0.45, 'Interesting page')
  assert.equal(reader.saveBookmark(first.id, pages[1].id, 0.6, 'Renamed').id, bookmark.id)
  assert.equal(reader.bookmarks(first.id).length, 1)
  assert.equal(reader.bookmarks(first.id)[0].offset, 0.6)
  assert.equal(reader.bookmarks(first.id)[0].label, 'Renamed')
  assert.throws(() => reader.saveBookmark(first.id, otherPage.id, 0), /页面/)
  assert.throws(() => reader.saveBookmark(first.id, pages[0].id, NaN), /位置/)
  assert.throws(() => reader.removeBookmark(second.id, bookmark.id), /书签/)
  fs.unlinkSync(pages[1].file)
  library.register((await scanImageImport(first.path, 'comic', false))[0])
  assert.equal(reader.bookmarks(first.id)[0].missing, true)
  fs.writeFileSync(pages[1].file, pngImage(24, 36)); library.register((await scanImageImport(first.path, 'comic', false))[0])
  assert.equal(reader.bookmarks(first.id)[0].missing, false)
  assert.equal(library.get(first.id)!.read, true)
  assert.deepEqual(new ImageReaderState(db).forWork(first.id).preferences, custom)
  const paused = { id: 'paused-fixture', status: 'paused', updatedAt: 1, work: { id: 'work' }, chapters: [], root, resourceId: '', retryNotBefore: Date.now() + 50000 }
  db.prepare('INSERT INTO image_download_jobs(id,status,updated_at,payload) VALUES(?,?,?,?)').run(paused.id, paused.status, paused.updatedAt, JSON.stringify(paused))
  const backup = buildLibraryBackup(db), restored = new DatabaseSync(':memory:'); restored.exec('PRAGMA foreign_keys=ON'); initSchema(restored, KINDS); restored.exec(VIDEO_JOBS_SQL)
  try {
    restoreLibraryBackup(restored, backup)
    assert.deepEqual(new ImageReaderState(restored).bookmarks(first.id), reader.bookmarks(first.id))
    assert.deepEqual(new ImageReaderState(restored).forWork(first.id).preferences, custom)
    assert.equal(new ImageLibrary(restored).get(first.id)!.read, true)
    assert.equal((restored.prepare('SELECT status FROM image_download_jobs').get() as any).status, 'paused')
    const invalid = structuredClone(backup)
    invalid.tables.image_bookmarks[0].resource_id = second.id
    assert.throws(() => restoreLibraryBackup(restored, invalid), /ownership/)
    assert.equal(new ImageReaderState(restored).bookmarks(first.id).length, 1, '失败恢复不得改变已有书签')
    for (const mutation of [
      (copy: typeof backup) => { copy.tables.image_bookmarks[0].scroll_offset = 2 },
      (copy: typeof backup) => { copy.tables.image_reader_state[0].is_read = 7 },
      (copy: typeof backup) => { copy.tables.image_reader_state[0].preferences = '{"mode":"invalid"}' },
    ]) {
      const copy = structuredClone(backup); mutation(copy)
      assert.throws(() => restoreLibraryBackup(restored, copy), /Library backup/)
      assert.equal(new ImageReaderState(restored).bookmarks(first.id).length, 1)
    }
    const legacy = structuredClone(backup) as any; legacy.schema_version = 11
    delete legacy.tables.image_bookmarks; delete legacy.tables.image_reader_state
    restoreLibraryBackup(restored, legacy)
    assert.equal(new ImageLibrary(restored).get(first.id)!.name, first.name)
    assert.deepEqual(new ImageReaderState(restored).bookmarks(first.id), [])
    assert.equal(new ImageLibrary(restored).get(first.id)!.read, false)
  } finally { restored.close() }
  reader.forWork(first.id, null)
  assert.equal(reader.forWork(first.id).customized, false)
  assert.equal(library.get(first.id)!.read, true, '恢复默认阅读设置不清除已读')
  const group = library.saveGroup({ name: 'private' }); library.update(first.id, { groupId: group.id }); library.saveGroup({ ...group, hidden: true })
  assert.throws(() => reader.forWork(first.id), /不可用/)
  assert.throws(() => reader.bookmarks(first.id), /不可用/)
  assert.throws(() => reader.saveBookmark(first.id, pages[0].id, 0), /不可用/)
  library.saveGroup({ ...group, hidden: false })
  library.remove(first.id)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM image_bookmarks WHERE resource_id=?').get(first.id) as any).n, 0)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM image_reader_state WHERE resource_id=?').get(first.id) as any).n, 0)
  db.exec('DROP TABLE image_bookmarks; DROP TABLE image_reader_state')
  db.prepare('UPDATE settings SET value=? WHERE key=?').run('11', SCHEMA_KEY)
  initSchema(db, KINDS)
  assert.equal(library.get(second.id)!.name, second.name)
  assert.equal(reader.forWork(second.id).customized, false)
  console.log('PASS 阅读设置隔离、书签与已读独立、隐藏保护、重扫/升级、备份恢复及暂停任务兼容')
} finally { db.close() }
