import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { DocumentFiles, sanitizePathComponent } from '../electron/workspace/document-files.ts'

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-doc-organize-'))
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  initSchema(db, KINDS)
  db.exec(VIDEO_JOBS_SQL)
  t.after(async () => {
    db.close()
    assert.ok(root.startsWith(os.tmpdir() + path.sep))
    await fs.rm(root, { recursive: true, force: true })
  })

  const sourceDir = path.join(root, 'source_files')
  const targetDir = path.join(root, 'library_target')
  await fs.mkdir(sourceDir, { recursive: true })
  await fs.mkdir(targetDir, { recursive: true })

  const docs = new DocumentLibrary(db as any)
  const files = new DocumentFiles(db as any)

  return { root, sourceDir, targetDir, db, docs, files }
}

test('filename and path component sanitization for windows safety', () => {
  assert.equal(sanitizePathComponent('Normal Name'), 'Normal Name')
  assert.equal(sanitizePathComponent('Bad:Name*With?Chars<>"|'), 'Bad_Name_With_Chars____')
  assert.equal(sanitizePathComponent('Trailing.Dots...   '), 'Trailing.Dots')
  assert.equal(sanitizePathComponent('aux.txt'), '_aux.txt')
  assert.equal(sanitizePathComponent('con'), '_con')
  assert.equal(sanitizePathComponent('com1'), '_com1')
})

test('preview organize categorizes items into submodules, categories, and custom groups', async (t) => {
  const { sourceDir, targetDir, docs, files } = await fixture(t)

  // Create custom group
  const group = docs.saveCustomGroup({
    submodule: 'reading',
    name: '硬核科幻',
    sortOrder: 0
  })

  // Create sample files
  const file1 = path.join(sourceDir, 'santi.txt')
  const file2 = path.join(sourceDir, 'cert.pdf')
  await fs.writeFile(file1, '三体小说')
  await fs.writeFile(file2, '%PDF-1.4 证书')

  // Register in DB
  const item1 = await docs.register(file1, 'novel', false, 'reading', group.id)
  const item2 = await docs.register(file2, 'certificate', false, 'archive')

  // Generate preview with custom groups
  const preview = await files.previewOrganize({
    rootDir: targetDir,
    mode: 'move',
    useCustomGroups: true
  })

  assert.equal(preview.total, 2)
  assert.equal(preview.ready, 2)
  assert.equal(preview.skip, 0)
  assert.equal(preview.conflict, 0)

  const p1 = preview.items.find((i) => i.id === item1.id)!
  assert.equal(p1.submodule, 'reading')
  assert.equal(p1.categoryName, '小说')
  assert.equal(p1.groupName, '硬核科幻')
  assert.equal(
    p1.destination,
    path.join(targetDir, '阅读', '小说', '硬核科幻', 'santi.txt')
  )

  const p2 = preview.items.find((i) => i.id === item2.id)!
  assert.equal(p2.submodule, 'archive')
  assert.equal(p2.categoryName, '证书')
  assert.equal(p2.groupName, '')
  assert.equal(
    p2.destination,
    path.join(targetDir, '资料', '证书', 'cert.pdf')
  )
})

test('organize detects already organized items and conflict states', async (t) => {
  const { sourceDir, targetDir, docs, files } = await fixture(t)

  const file1 = path.join(sourceDir, 'book1.txt')
  await fs.writeFile(file1, '书籍 1')
  const item1 = await docs.register(file1, 'book', false, 'reading')

  // Destination already has a conflicting file
  const conflictDest = path.join(targetDir, '阅读', '书籍', 'book1.txt')
  await fs.mkdir(path.dirname(conflictDest), { recursive: true })
  await fs.writeFile(conflictDest, '已存在同名冲突内容')

  const preview = await files.previewOrganize({
    rootDir: targetDir,
    mode: 'move',
    useCustomGroups: false
  })

  const p1 = preview.items.find((i) => i.id === item1.id)!
  assert.equal(p1.status, 'conflict')
  assert.equal(preview.conflict, 1)
})

test('execute organize moves files, updates resource paths, and allows undo', async (t) => {
  const { sourceDir, targetDir, docs, files } = await fixture(t)

  const file1 = path.join(sourceDir, 'novel.txt')
  await fs.writeFile(file1, '小说正文内容12345')
  const item1 = await docs.register(file1, 'novel', false, 'reading')
  const origId = item1.id

  // Execute organize
  const result = await files.executeOrganize({
    rootDir: targetDir,
    mode: 'move',
    useCustomGroups: false
  })

  assert.equal(result.succeeded, 1)
  assert.equal(result.failed, 0)

  const expectedDest = path.join(targetDir, '阅读', '小说', 'novel.txt')
  assert.ok(existsSync(expectedDest), '目标文件应该存在')
  assert.ok(!existsSync(file1), '源文件应该已移动删除')

  // Check database updated
  const updatedDoc = docs.get(origId)!
  assert.equal(updatedDoc.path, expectedDest)
  assert.equal(updatedDoc.id, origId, '资源 ID 必须保持不变')

  // Test Undo
  const opId = result.items[0].operationId!
  assert.ok(opId)

  const undoResult = await files.undo(opId)
  assert.equal(undoResult.undone, true)

  assert.ok(existsSync(file1), '撤销后源文件应该恢复')
  assert.ok(!existsSync(expectedDest), '撤销后目标文件应该清除')

  const restoredDoc = docs.get(origId)!
  assert.equal(restoredDoc.path, file1)
})

test('undo is blocked if target file was modified externally', async (t) => {
  const { sourceDir, targetDir, docs, files } = await fixture(t)

  const file1 = path.join(sourceDir, 'paper.txt')
  await fs.writeFile(file1, '学术论文原版')
  await docs.register(file1, 'paper', false, 'reading')

  const result = await files.executeOrganize({
    rootDir: targetDir,
    mode: 'move',
    useCustomGroups: false
  })
  assert.equal(result.succeeded, 1)

  const expectedDest = path.join(targetDir, '阅读', '论文', 'paper.txt')
  // User modifies destination file
  await fs.writeFile(expectedDest, '用户在外部篡改了论文内容')

  const opId = result.items[0].operationId!
  const undoResult = await files.undo(opId)
  assert.equal(undoResult.undone, false)
  assert.ok(undoResult.reason?.includes('外部修改'))
})
