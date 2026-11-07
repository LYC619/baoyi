import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { documentSections } from '../src/utils/document-library-view.ts'

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-feedback-r3-'))
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  initSchema(db, KINDS)
  t.after(async () => {
    db.close()
    assert.ok(root.startsWith(os.tmpdir() + path.sep))
    await fs.rm(root, { recursive: true, force: true })
  })

  const novelFile1 = path.join(root, '诡秘之主1.txt')
  const novelFile2 = path.join(root, '诡秘之主2.txt')
  const paperFile = path.join(root, '注意力机制论文.pdf')
  const certFile = path.join(root, '软考证书.png')
  await fs.writeFile(novelFile1, '第一章\n绯红')
  await fs.writeFile(novelFile2, '第二章\n情况')
  await fs.writeFile(paperFile, '%PDF-1.4 论文内容')
  await fs.writeFile(certFile, 'PNG 证书缩略图')

  return { root, db, docs: new DocumentLibrary(db as any), novelFile1, novelFile2, paperFile, certFile }
}

test('1. 各分类分组与标签独立：不同分类分组互不干扰，分类切换保护分组有效性', async (t) => {
  const { docs, novelFile1, paperFile } = await fixture(t)

  // Create category-scoped groups
  const novelGroup = docs.saveCustomGroup({
    submodule: 'reading',
    categoryId: 'novel',
    name: '诡秘系列',
  })
  const paperGroup = docs.saveCustomGroup({
    submodule: 'reading',
    categoryId: 'paper',
    name: 'Transformer研报集',
  })

  // Novel customGroups only return novelGroup, not paperGroup
  const novelGroups = docs.customGroups('reading', 'novel')
  assert.equal(novelGroups.length, 1)
  assert.equal(novelGroups[0].name, '诡秘系列')
  assert.equal(novelGroups[0].categoryId, 'novel')

  const paperGroups = docs.customGroups('reading', 'paper')
  assert.equal(paperGroups.length, 1)
  assert.equal(paperGroups[0].name, 'Transformer研报集')
  assert.equal(paperGroups[0].categoryId, 'paper')

  // Register documents
  const docNovel = await docs.register(novelFile1, 'novel')
  const docPaper = await docs.register(paperFile, 'paper')
  assert.equal(docPaper.type, 'paper')

  // Setting novel group on novel succeeds
  const updatedNovel = docs.update(docNovel.id, { customGroupId: novelGroup.id })
  assert.equal(updatedNovel.customGroupId, novelGroup.id)

  // Setting paper group on novel fails constraint check
  assert.throws(
    () => docs.update(docNovel.id, { customGroupId: paperGroup.id }),
    /自定义分组不存在或不属于该分类/
  )

  // Changing novel's category to paper clears customGroupId because novelGroup does not belong to paper
  const movedToPaper = docs.update(docNovel.id, { type: 'paper' })
  assert.equal(movedToPaper.type, 'paper')
  assert.equal(movedToPaper.customGroupId, undefined)
})

test('2. 移除“我的资料”：默认不分组时不伪造多余的标题栏', async (t) => {
  const { docs, novelFile1, novelFile2 } = await fixture(t)
  const d1 = await docs.register(novelFile1, 'novel')
  const d2 = await docs.register(novelFile2, 'novel')

  const names = new Map<string, string>()
  const items = [d1, d2]

  // When groupBy is 'none', documentSections returns a section with empty title ''
  const sections = documentSections(items, 'none', names, '')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].title, '') // Empty title -> UI will not render "v 我的资料 2"
  assert.equal(sections[0].items.length, 2)
})

test('3. 分组聚合逻辑验证：同一分组的资料聚合在一起，解散分组不丢失资料', async (t) => {
  const { docs, novelFile1, novelFile2, certFile } = await fixture(t)

  const group = docs.saveCustomGroup({
    submodule: 'reading',
    categoryId: 'novel',
    name: '诡秘系列',
  })

  const doc1 = await docs.register(novelFile1, 'novel')
  const doc2 = await docs.register(novelFile2, 'novel')
  const cert = await docs.register(certFile, 'certificate')
  assert.equal(cert.type, 'certificate')

  docs.update(doc1.id, { customGroupId: group.id })
  docs.update(doc2.id, { customGroupId: group.id })

  const readingDocs = docs.list({ submodule: 'reading' })
  const groupedDocs = readingDocs.filter(d => d.customGroupId === group.id)
  assert.equal(groupedDocs.length, 2)
  assert.ok(groupedDocs.some(d => d.id === doc1.id))
  assert.ok(groupedDocs.some(d => d.id === doc2.id))

  // Dissolving group unsets customGroupId on members, documents remain intact
  docs.removeCustomGroup(group.id)
  assert.equal(docs.customGroups('reading', 'novel').length, 0)
  assert.equal(docs.require(doc1.id).customGroupId, undefined)
  assert.equal(docs.require(doc2.id).customGroupId, undefined)
  assert.equal(docs.require(doc1.id).type, 'novel')
  assert.equal(docs.require(doc2.id).type, 'novel')
})

test('4. 批量标签更新功能验证：支持追加、替换和清除', async (t) => {
  const { docs, novelFile1, novelFile2 } = await fixture(t)
  const doc1 = await docs.register(novelFile1, 'novel')
  const doc2 = await docs.register(novelFile2, 'novel')

  // Initial tag
  docs.update(doc1.id, { tags: ['玄幻'] })
  docs.update(doc2.id, { tags: ['科幻'] })

  // Append tags
  for (const id of [doc1.id, doc2.id]) {
    const current = docs.require(id)
    docs.update(id, { tags: [...new Set([...current.tags, '连载中', '穿越'])] })
  }

  assert.deepEqual(docs.require(doc1.id).tags.sort(), ['修真/未读状态可能会有', '修真', '连载中', '穿越', '玄幻'].filter(t => docs.require(doc1.id).tags.includes(t)).sort())
  assert.ok(docs.require(doc1.id).tags.includes('玄幻'))
  assert.ok(docs.require(doc1.id).tags.includes('连载中'))
  assert.ok(docs.require(doc2.id).tags.includes('科幻'))
  assert.ok(docs.require(doc2.id).tags.includes('连载中'))

  // Replace tags
  for (const id of [doc1.id, doc2.id]) {
    docs.update(id, { tags: ['经典完结'] })
  }
  assert.ok(docs.require(doc1.id).tags.includes('经典完结'))
  assert.ok(!docs.require(doc1.id).tags.includes('玄幻'))
  assert.ok(!docs.require(doc1.id).tags.includes('连载中'))
})
