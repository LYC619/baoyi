import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, setSchemaVersion } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { DocumentCovers } from '../electron/workspace/document-covers.ts'
import { TextStreamService } from '../electron/workspace/text-stream.ts'
import { buildLibraryBackup, restoreLibraryBackup } from '../electron/services/storage/library-backup.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-review-'))
  const db = new DatabaseSync(':memory:')
  initSchema(db, KINDS)
  t.after(async () => {
    db.close()
    assert.ok(root.startsWith(os.tmpdir() + path.sep))
    await fs.rm(root, { recursive: true, force: true })
  })
  return { root, db, docs: new DocumentLibrary(db), stream: new TextStreamService(path.join(root, 'cache')) }
}

for (const id of ['reference', 'contract']) {
  test(`migration preserves renamed ${id} and its members`, async t => {
    const { db, docs, root } = await fixture(t)
    const behavior = id === 'reference' ? 'reading' : 'contract'
    db.prepare('INSERT INTO document_categories(id,name,description,behavior) VALUES(?,?,?,?)').run(id, '我的自定义名称', id === 'reference' ? '技术文档、教程与参考资料' : '合同、协议与相关方凭据', behavior)
    const file = path.join(root, 'file.pdf'); await fs.writeFile(file, 'fixture')
    const item = await docs.register(file, id)
    setSchemaVersion(db, 24); initSchema(db, KINDS)
    assert.equal(docs.require(item.id).type, id)
    assert.equal(docs.category(id).name, '我的自定义名称')
    initSchema(db, KINDS)
    assert.equal(docs.require(item.id).type, id)
  })
}

test('former pending import belongs to reading in list, get and metadata updates', async t => {
  const { root, docs } = await fixture(t)
  const file = path.join(root, 'ambiguous.pdf'); await fs.writeFile(file, 'fixture')
  const item = await docs.register(file, undefined, false, null)
  assert.equal(item.submodule, 'reading')
  assert.equal(item.readable, true)
  assert.equal(docs.list({ submodule: 'reading' }).length, 1)
  assert.equal(docs.list({ uncategorized: true }).length, 0)
  assert.equal(docs.update(item.id, { tags: ['待办'] }).submodule, 'reading')
  assert.equal(docs.moveToSubmodule(item.id, 'archive', 'certificate').id, item.id)
})

test('registration rejects a category from a different submodule', async t => {
  const { root, docs } = await fixture(t)
  const file = path.join(root, 'mixed.pdf'); await fs.writeFile(file, 'fixture')
  await assert.rejects(docs.register(file, 'certificate', false, 'reading'), /分类.*子模块/)
})

for (const encoding of ['utf-8', 'utf-16le', 'utf-16be', 'gb18030']) {
  test(`chapter offsets and complete text round trip: ${encoding} CRLF`, async t => {
    const { root, stream } = await fixture(t)
    const text = '开场文字\r\n第一章\r\n中文正文\r\n第二章\r\n末尾'
    const gb = Buffer.from('bfaab3a1cec4d7d60d0ab5dad2bbd5c20d0ad6d0cec4d5fdcec40d0ab5dab6fed5c20d0ac4a9ceb2', 'hex')
    const bytes = encoding === 'gb18030' ? gb : encoding === 'utf-8' ? Buffer.from(text) : Buffer.from('\ufeff' + text, 'utf16le')
    if (encoding === 'utf-16be') bytes.swap16()
    const file = path.join(root, encoding + '.txt'); await fs.writeFile(file, bytes)
    const index = await stream.indexNovel(file, encoding)
    const second = index.chapters.find(c => c.title === '第二章')
    assert.ok(second, 'must detect encoded chapter headings')
    assert.equal((await stream.sliceText(file, second.byteOffset, second.byteLength, encoding)).text, '第二章\r\n末尾')
    const parts = await Promise.all(index.chapters.map(c => stream.sliceText(file, c.byteOffset, c.byteLength, encoding)))
    assert.equal(parts.map(p => p.text).join(''), text, 'preamble and every byte must survive')
  })
}

test('long no-newline text chunks do not split Unicode characters', async t => {
  const { root, stream } = await fixture(t)
  const text = ('a中文𠮷😀').repeat(15000)
  const file = path.join(root, 'long.txt'); await fs.writeFile(file, text)
  const index = await stream.indexNovel(file)
  const parts = await Promise.all(index.chapters.map(c => stream.sliceText(file, c.byteOffset, c.byteLength, index.encoding)))
  assert.ok(index.chapters.every(c => c.byteLength <= 48 * 1024))
  assert.equal(parts.map(p => p.text).join(''), text)
})

test('favorite, original source and submodule survive a backup round trip', async t => {
  const { root, db, docs } = await fixture(t)
  db.exec(VIDEO_JOBS_SQL)
  const file = path.join(root, 'pending.pdf'); await fs.writeFile(file, 'fixture')
  const item = await docs.register(file, undefined, false, null)
  docs.update(item.id, { favorite: true })
  const backup = buildLibraryBackup(db)
  const target = new DatabaseSync(':memory:'); t.after(() => target.close())
  initSchema(target, KINDS); target.exec(VIDEO_JOBS_SQL)
  restoreLibraryBackup(target, backup)
  const restored = new DocumentLibrary(target).require(item.id)
  assert.equal(restored.favorite, true)
  assert.equal(restored.sourceDir, root)
  assert.equal(restored.submodule, 'reading')
})

test('custom category retains members in its submodule during v24 migration', async t => {
  const { root, db, docs } = await fixture(t)
  const category = docs.saveCategory({ name: '用途待定', behavior: 'other', description: '', order: 5 })
  const file = path.join(root, 'unknown.pdf'); await fs.writeFile(file, 'fixture')
  const item = await docs.register(file, category.id, false, null)
  setSchemaVersion(db, 24); initSchema(db, KINDS)
  assert.equal(docs.require(item.id).submodule, 'reading')
  assert.equal(docs.require(item.id).type, category.id)
})

for (const mib of [32, 100]) {
  test(`${mib}MiB unbroken TXT stays bounded and supports middle/end reads`, async t => {
    const { root, stream } = await fixture(t)
    const file = path.join(root, 'large.txt'), handle = await fs.open(file, 'w')
    const block = Buffer.from('中文𠮷😀没有空行'.repeat(4096))
    let size = 0
    while (size < mib * 1024 * 1024) { await handle.write(block); size += block.length }
    await handle.close()
    const started = Date.now(), index = await stream.indexNovel(file)
    assert.equal(index.chapters.reduce((n, c) => n + c.byteLength, 0), size)
    assert.ok(index.chapters.every(c => c.byteLength <= 48 * 1024))
    for (const n of [0, Math.floor(index.chapters.length / 2), index.chapters.length - 1]) {
      const chapter = index.chapters[n], part = await stream.sliceText(file, chapter.byteOffset, chapter.byteLength, index.encoding)
      assert.ok(part.text.length > 0 && !part.text.includes('\ufffd'))
    }
    t.diagnostic(`${mib}MiB indexed in ${Date.now() - started}ms; ${index.chapters.length} bounded blocks`)
  })
}

test('150MiB PDF cover source is range-backed and invalidates after source change', async t => {
  const { root, db, docs } = await fixture(t)
  const file = path.join(root, 'large.pdf')
  const handle = await fs.open(file, 'w'); await handle.write('%PDF-1.7'); await handle.truncate(150 * 1024 * 1024); await handle.close()
  const item = await docs.register(file, 'book')
  const covers = new DocumentCovers(() => db, path.join(root, 'covers'))
  const result = await covers.get(item.id)
  assert.equal(result.state, 'render')
  if (result.state !== 'render') return
  const source = await covers.source(item.id, result.token)
  assert.equal(source.size, 150 * 1024 * 1024)
  assert.equal(source.data, undefined, 'PDF must not be read in full')
  assert.equal(Buffer.from(await covers.range(item.id, result.token, 0, 8)).toString(), '%PDF-1.7')
  await fs.appendFile(file, 'changed')
  await assert.rejects(covers.range(item.id, result.token, 0, 8), /变化/)
})
