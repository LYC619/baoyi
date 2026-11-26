import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initSchema, SCHEMA_VERSION } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-doc-submodule-'))
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  initSchema(db, KINDS)
  db.exec(VIDEO_JOBS_SQL)
  t.after(async () => {
    db.close()
    assert.ok(root.startsWith(os.tmpdir() + path.sep))
    await fs.rm(root, { recursive: true, force: true })
  })
  await fs.writeFile(path.join(root, 'novel.txt'), '第一章 苍穹之下\n这是小说的第一段话。')
  await fs.writeFile(path.join(root, 'cert.pdf'), '%PDF-1.4 证书文件内容')
  return { root, db, docs: new DocumentLibrary(db as any) }
}

test('submodule-aware categories and custom groups isolation', async (t) => {
  const { docs } = await fixture(t)

  const readingCats = docs.categories('reading')
  const archiveCats = docs.categories('archive')

  assert.ok(readingCats.some(c => c.id === 'novel' && c.submodule === 'reading'))
  assert.ok(readingCats.some(c => c.id === 'book' && c.submodule === 'reading'))
  assert.ok(archiveCats.some(c => c.id === 'certificate' && c.submodule === 'archive'))
  assert.ok(archiveCats.some(c => c.id === 'id_resume' && c.submodule === 'archive'))

  // Both submodules can have a category with same name without collision
  const cat1 = docs.saveCategory({ submodule: 'reading', name: '同名分类', description: '读物', behavior: 'reading', order: 10 })
  const cat2 = docs.saveCategory({ submodule: 'archive', name: '同名分类', description: '档案', behavior: 'other', order: 10 })
  assert.equal(cat1.submodule, 'reading')
  assert.equal(cat2.submodule, 'archive')

  // Duplicate name in same submodule fails
  assert.throws(
    () => docs.saveCategory({ submodule: 'reading', name: '同名分类', description: '', behavior: 'reading', order: 11 }),
    /该子模块下已存在“同名分类”分类/
  )

  // Custom groups
  const grp1 = docs.saveCustomGroup({ submodule: 'reading', categoryId: 'novel', name: '科幻小说' })
  const grp2 = docs.saveCustomGroup({ submodule: 'archive', categoryId: 'certificate', name: '入职档案' })
  const paperGrp = docs.saveCustomGroup({ submodule: 'reading', categoryId: 'paper', name: '大模型论文集' })
  assert.equal(docs.customGroups('reading').length, 2)
  assert.equal(docs.customGroups('reading', 'novel').length, 1)
  assert.equal(docs.customGroups('reading', 'novel')[0].name, '科幻小说')
  assert.equal(docs.customGroups('reading', 'paper').length, 1)
  assert.equal(docs.customGroups('reading', 'paper')[0].name, '大模型论文集')
  assert.equal(docs.customGroups('archive').length, 1)
  assert.equal(docs.customGroups('archive', 'certificate')[0].name, '入职档案')

  docs.removeCustomGroup(grp1.id)
  docs.removeCustomGroup(grp2.id)
  docs.removeCustomGroup(paperGrp.id)
  assert.equal(docs.customGroups('reading').length, 0)
  assert.equal(docs.customGroups('archive').length, 0)
})

test('document registration, list filtering, and cross-submodule move', async (t) => {
  const { root, docs } = await fixture(t)

  const novel = await docs.register(path.join(root, 'novel.txt'), 'novel')
  assert.equal(novel.submodule, 'reading')
  assert.equal(novel.type, 'novel')

  const cert = await docs.register(path.join(root, 'cert.pdf'), 'certificate')
  assert.equal(cert.submodule, 'archive')
  assert.equal(cert.type, 'certificate')

  // Filtering list by submodule
  const readingList = docs.list({ submodule: 'reading' })
  assert.equal(readingList.length, 1)
  assert.equal(readingList[0].id, novel.id)

  const archiveList = docs.list({ submodule: 'archive' })
  assert.equal(archiveList.length, 1)
  assert.equal(archiveList[0].id, cert.id)

  // Assign a custom group to novel
  const group = docs.saveCustomGroup({ submodule: 'reading', name: '玄幻小说' })
  docs.update(novel.id, { customGroupId: group.id })
  assert.equal(docs.require(novel.id).customGroupId, group.id)

  // Move novel to archive submodule
  const moved = docs.moveToSubmodule(novel.id, 'archive')
  assert.equal(moved.submodule, 'archive')
  assert.equal(moved.type, 'archive_other')
  // Incompatible custom group should be reset
  assert.equal(moved.customGroupId, undefined)

  // Now archive list has 2 items, reading has 0
  assert.equal(docs.list({ submodule: 'archive' }).length, 2)
  assert.equal(docs.list({ submodule: 'reading' }).length, 0)
})

test('current schema validation', () => {
  assert.ok(SCHEMA_VERSION >= 31)
})
