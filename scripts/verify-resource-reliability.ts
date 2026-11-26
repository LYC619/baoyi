import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { DocumentFiles } from '../electron/workspace/document-files.ts'
import { pngImage } from './helpers/test-images.ts'
import { buildLibraryBackup, restoreLibraryBackup } from '../electron/services/storage/library-backup.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-reliability-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
  t.after(async () => { db.close(); assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }) })
  const file = async (name: string, value: string | Buffer = 'original') => { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, value); return target }
  return { root, db, file, images: new ImageLibrary(db), docs: new DocumentLibrary(db), files: new DocumentFiles(db) }
}

test('incomplete image rescan retains all pages, progress and manual metadata', async t => {
  const f = await fixture(t)
  await f.file('photos/1.png', pngImage(20, 30)); const second = await f.file('photos/2.png', pngImage(30, 20))
  const folder = path.dirname(second), item = f.images.register((await scanImageImport(folder, 'photo', false))[0])
  const pages = f.images.pages(item.id); f.images.saveProgress(item.id, pages[1].id, .4); f.images.update(item.id, { name: '我的照片', tags: ['保留'] })
  await fs.writeFile(second, '') // An in-progress replacement produces a partial scan.
  const partial = (await scanImageImport(folder, 'photo', false))[0]
  assert.equal(partial.chapters[0].pages.length, 1); assert.ok(partial.warnings.length)
  assert.throws(() => f.images.register(partial), /扫描不完整/)
  assert.deepEqual(f.images.pages(item.id), pages); assert.equal(f.images.get(item.id)!.name, '我的照片')
  assert.equal(f.images.get(item.id)!.progress!.pageId, pages[1].id)
  await fs.writeFile(second, pngImage(40, 20)); f.images.register((await scanImageImport(folder, 'photo', false))[0])
  assert.deepEqual(f.images.pages(item.id).map(p => p.id), pages.map(p => p.id))
})

test('image relocation refuses another registered folder before any write', async t => {
  const f = await fixture(t)
  const a = path.dirname(await f.file('a/1.png', pngImage(20, 30))), b = path.dirname(await f.file('b/1.png', pngImage(30, 20)))
  const first = f.images.register((await scanImageImport(a, 'comic', false))[0]), other = f.images.register((await scanImageImport(b, 'comic', false))[0])
  const scan = (await scanImageImport(b, 'comic', false))[0]
  assert.throws(() => f.images.register(scan, first.id), /其他作品|已登记/)
  assert.equal(f.images.get(first.id)!.path, a); assert.equal(f.images.get(other.id)!.path, b)
})

test('document relocation refuses a copy owned by another document', async t => {
  const f = await fixture(t), a = await f.file('a.txt'), b = await f.file('b.txt', 'other'), copy = path.join(f.root, 'copy.txt')
  const first = await f.docs.register(a), other = await f.docs.register(b)
  await f.files.execute(await f.files.plan(undefined, b, 'copy', copy)); await fs.rename(a, a + '.offline')
  await assert.rejects(f.docs.relocate(first.id, copy), /其他资料|已登记/)
  assert.equal(f.docs.require(first.id).path, a); assert.equal((await f.docs.register(copy)).id, other.id)
})

test('document relocation rechecks original availability after file inspection', async t => {
  const f = await fixture(t), a = await f.file('a.txt'), target = await f.file('new.txt')
  const doc = await f.docs.register(a); await fs.rename(a, a + '.offline')
  const inspect = f.docs.inspect.bind(f.docs)
  f.docs.inspect = async (...args) => { const result = await inspect(...args); await fs.rename(a + '.offline', a); return result }
  await assert.rejects(f.docs.relocate(doc.id, target), /原文件|变化/)
  assert.equal(f.docs.require(doc.id).path, a)
})

for (const changed of [false, true]) test(`interrupted undo resumes backwards and protects restored edits (${changed})`, async t => {
  const f = await fixture(t), source = await f.file('a.txt'), destination = path.join(f.root, 'moved.txt')
  const doc = await f.docs.register(source), op = await f.files.execute(await f.files.plan(undefined, source, 'move', destination))
  const unlink = fs.unlink
  fs.unlink = async target => { if (target === destination) throw new Error('fixture locked'); return unlink(target) }
  try { await assert.rejects(f.files.undo(op.id), /fixture locked/) } finally { fs.unlink = unlink }
  assert.equal(f.docs.require(doc.id).path, source)
  f.db.exec(VIDEO_JOBS_SQL)
  const backup = buildLibraryBackup(f.db)
  restoreLibraryBackup(f.db, backup)
  const freshService = new DocumentFiles(f.db)
  if (changed) {
    await fs.writeFile(source, 'user edit after undo')
    await assert.rejects(freshService.recover(op.id), /变化|修改/)
    assert.equal(await fs.readFile(source, 'utf8'), 'user edit after undo'); assert.equal(await fs.readFile(destination, 'utf8'), 'original')
  } else {
    const result = await freshService.recover(op.id)
    assert.equal(result.state, 'done'); assert.equal(result.undone, true)
    assert.equal(await fs.readFile(source, 'utf8'), 'original'); await assert.rejects(fs.stat(destination), { code: 'ENOENT' })
    await freshService.recover(op.id); assert.equal(f.docs.require(doc.id).path, source)
  }
})

test('completed undo cannot be replayed as a move', async t => {
  const f = await fixture(t), source = await f.file('a.txt'), destination = path.join(f.root, 'moved.txt')
  const op = await f.files.execute(await f.files.plan(undefined, source, 'move', destination))
  assert.equal((await f.files.undo(op.id)).undone, true)
  await f.files.recover(op.id)
  assert.equal(await fs.readFile(source, 'utf8'), 'original'); await assert.rejects(fs.stat(destination), { code: 'ENOENT' })
})

for (const legacyDone of [false, true]) test(`undo intent survives interruption before finishing (${legacyDone})`, async t => {
  const f = await fixture(t), source = await f.file('a.txt'), destination = path.join(f.root, 'moved.txt')
  const op = await f.files.execute(await f.files.plan(undefined, source, 'move', destination))
  const service = f.files as any, save = service.save.bind(service)
  service.save = (record: any) => {
    if (record.undoPending) {
      if (legacyDone) record.state = 'done'
      save(record)
      throw new Error('fixture process stopped after intent')
    }
    return save(record)
  }
  await assert.rejects(f.files.undo(op.id), /process stopped/)
  const fresh = new DocumentFiles(f.db)
  if (!legacyDone) assert.notEqual(fresh.operations().find(r => r.id === op.id)!.state, 'done')
  const recovered = await fresh.recover(op.id)
  assert.equal(recovered.undone, true); assert.equal(recovered.undoPending, false)
  assert.equal(f.docs.require(op.documentId).path, source)
  assert.equal(await fs.readFile(source, 'utf8'), 'original')
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' })
})

test('document relocation keeps annotations, position, ID and manual metadata', async t => {
  const f = await fixture(t), source = await f.file('source.txt'), target = path.join(f.root, 'relocated.txt')
  const doc = await f.docs.register(source, 'novel')
  f.docs.update(doc.id, { name: '人工书名', tags: ['保留'] })
  f.docs.savePosition(doc.id, { page: 2, offset: .4 }, 5)
  const note = f.docs.annotate(doc.id, { kind: 'excerpt', quote: 'original', note: '自己的想法', location: { page: 2, offset: .4 } })
  await fs.rename(source, target)
  assert.equal(f.docs.require(doc.id).available, false)
  const relocated = await f.docs.relocate(doc.id, target)
  assert.equal(relocated.id, doc.id); assert.equal(relocated.name, '人工书名'); assert.deepEqual(relocated.tags, ['保留'])
  assert.deepEqual(relocated.position, { page: 2, offset: .4 }); assert.equal(f.docs.annotations(doc.id)[0].id, note.id)
  assert.equal((await f.docs.register(target)).id, doc.id); assert.equal(f.docs.list().length, 1)
})

test('undoing an earlier move cannot overwrite a later relocation', async t => {
  const f = await fixture(t), a = await f.file('a.txt'), b = path.join(f.root, 'b.txt'), c = path.join(f.root, 'c.txt')
  const first = await f.files.execute(await f.files.plan(undefined, a, 'move', b))
  const second = await f.files.execute(await f.files.plan(undefined, b, 'move', c))
  assert.equal((await f.files.undo(first.id)).undone, false)
  assert.equal(f.docs.require(first.documentId).path, c); assert.equal(await fs.readFile(c, 'utf8'), 'original')
  assert.equal((await f.files.undo(second.id)).undone, true)
  assert.equal((await f.files.undo(first.id)).undone, true)
  assert.equal(f.docs.require(first.documentId).path, a)
})
