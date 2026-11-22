import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { recentGroupDocuments } from '../src/utils/document-library-view.ts'

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-feedback-r4-'))
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  initSchema(db, KINDS)
  t.after(async () => {
    db.close()
    assert.ok(root.startsWith(os.tmpdir() + path.sep))
    await fs.rm(root, { recursive: true, force: true })
  })

  const f1 = path.join(root, '海贼：和康娜一起航海.txt')
  const f2 = path.join(root, '海贼王：海军中的咸鱼铁匠.txt')
  const f3 = path.join(root, '原神：如何正确地使用羁绊.txt')
  const f4 = path.join(root, '原神：播放刀子短视频.txt')
  const f5 = path.join(root, '综漫：外挂竟是我自己.txt')
  await fs.writeFile(f1, '第一章 航海')
  await fs.writeFile(f2, '第一章 咸鱼铁匠')
  await fs.writeFile(f3, '第一章 羁绊')
  await fs.writeFile(f4, '第一章 短视频')
  await fs.writeFile(f5, '第一章 外挂')

  const docs = new DocumentLibrary(db as any)
  const d1 = await docs.register(f1, 'novel')
  const d2 = await docs.register(f2, 'novel')
  const d3 = await docs.register(f3, 'novel')
  const d4 = await docs.register(f4, 'novel')
  const d5 = await docs.register(f5, 'novel')

  return { root, db, docs, items: [d1, d2, d3, d4, d5] }
}

test('1. documents.get 支持短哈希前缀和名称精确检索', async (t) => {
  const { docs, items } = await fixture(t)
  const target = items[0]

  // Full UUID match
  const byFull = docs.get(target.id)
  assert.equal(byFull?.id, target.id)

  // 8-character prefix match
  const shortId = target.id.slice(0, 8)
  const byShort = docs.get(shortId)
  assert.equal(byShort?.id, target.id, '应当支持 8 字符短编号唯一匹配')

  // Exact name match
  const byName = docs.get(target.name)
  assert.equal(byName?.id, target.id, '应当支持书名唯一匹配')
})

test('4. 合辑优先最近读过的四本，未读书只在不足四本时补位', async (t) => {
  const { items } = await fixture(t)
  items.forEach((item, index) => { item.lastReadAt = [1000, 4000, 2000, 5000, 0][index]; item.updatedAt = 10000 + index })
  const original = items.map(i => i.id)
  assert.deepEqual(recentGroupDocuments(items).map(i => i.id), [items[3], items[1], items[2], items[0]].map(i => i.id))
  assert.deepEqual(items.map(i => i.id), original, '不能重排传入的资料数组')
  items[0].lastReadAt = 0
  items[2].lastReadAt = 0
  assert.deepEqual(recentGroupDocuments(items).map(i => i.id), [items[3], items[1], items[4], items[2]].map(i => i.id))
  assert.deepEqual(recentGroupDocuments([]), [])
  assert.equal(recentGroupDocuments(items.slice(0, 1)).length, 1)
})
