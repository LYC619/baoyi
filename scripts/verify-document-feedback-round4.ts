import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { createWorkspaceAgent } from '../electron/workspace/agent.ts'
import { WorkspaceChanges } from '../electron/workspace/agent-changes.ts'
import { recentGroupDocuments } from '../src/utils/document-library-view.ts'

type ToolCall = (name: string, args: Record<string, unknown>) => Promise<any>

// Exercise tools registered by a real send, replacing only the network/model turn.
async function withTools<T>(t: test.TestContext, db: DatabaseSync, documentIds: string[], action: (call: ToolCall, sessionId: string) => Promise<T>, updated?: () => void) {
  let output: T | undefined
  let completed = false
  const agent = createWorkspaceAgent({
    db: db as any,
    config: () => ({ enabled: true, api_key: 'fixture', api_url: 'http://localhost', model: 'fixture' }),
    updated,
    run: async ({ tools }) => {
      output = await action(async (name, args) => {
        const tool = tools.find(tool => tool.name === name)
        assert.ok(tool, `工具必须已注册：${name}`)
        return JSON.parse(await tool.execute(args))
      }, session.id)
      completed = true
      return { stopReason: 'done', text: 'fixture', turns: 1, tokens: 0, error: '' }
    },
  })
  t.after(() => agent.dispose())
  const session = agent.create('document', { documentIds })
  const reply = await agent.send(session.id, '按已确认方案整理资料')
  assert.equal(reply.status, 'idle', reply.error)
  assert.equal(completed, true, '必须实际执行工具断言，不能被助手错误处理吞掉')
  return { output: output as T, session }
}

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

test('2. agent-changes 支持 customGroupId 变更审计与撤销', async (t) => {
  const { db, docs, items } = await fixture(t)
  const agent = createWorkspaceAgent({
    db: db as any,
    config: () => ({ provider: 'custom', model: 'mock', apiKey: 'k', baseUrl: 'http://localhost', api_url: '', api_key: '', enabled: true } as any),
    execute: async <T>(action: () => Promise<T>): Promise<T> => action(),
  })
  const session = agent.create('document', { documentIds: [items[0].id] })

  const group = docs.saveCustomGroup({
    submodule: 'reading',
    categoryId: 'novel',
    name: '同人-海贼王',
  })

  const changes = new WorkspaceChanges(db as any)

  // Update document's customGroupId via changes journal
  const change = changes.updateDocument(session.id, items[0].id, {
    customGroupId: group.id,
  })

  assert.equal(change.after.customGroupId, group.id)
  assert.equal(change.state, 'applied')

  // Document in DB has been updated
  const updatedDoc = docs.require(items[0].id)
  assert.equal(updatedDoc.customGroupId, group.id)

  // Undo restores previous state (null)
  const undoResult = changes.undo(change.id)
  assert.equal(undoResult.undone, true)
  const restoredDoc = docs.require(items[0].id)
  assert.equal(restoredDoc.customGroupId, undefined)
})

test('3. propose_document_groups 工具自动创建分组并批量分配短编号小说', async (t) => {
  const { db, docs, items } = await fixture(t)
  assert.equal(docs.customGroups('reading', 'novel').length, 0)
  let updates = 0
  const { output, session } = await withTools(t, db, items.map(i => i.id), async call => call('propose_document_groups', {
    groups: [
      { name: '同人-海贼王', documentIds: items.slice(0, 2).map(i => i.id.slice(0, 8)) },
      { name: '同人-原神', documentIds: [items[2].name] },
    ],
  }), () => { updates++ })
  const [g1, g2] = ['同人-海贼王', '同人-原神'].map(name => docs.customGroups().find(g => g.name === name)!)
  assert.ok(g1 && g2)
  const sessionChanges = new WorkspaceChanges(db as any).list(session.id)
  assert.equal(sessionChanges.length, 3)
  assert.equal(sessionChanges[0].after.customGroupId, g1.id)
  assert.equal(sessionChanges[2].after.customGroupId, g2.id)
  assert.equal(output.applied, 3)
  assert.equal(output.proposed, 0)
  assert.equal(updates, 1)
  assert.ok(output.groups.flatMap((g: any) => g.items).every((i: any) => i.state === 'applied' && i.changeId))
  assert.equal(docs.require(items[0].id).customGroupId, g1.id)
  assert.equal(docs.require(items[1].id).customGroupId, g1.id)
  assert.equal(docs.require(items[2].id).customGroupId, g2.id)
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

test('5. 未分组资料连续补全、重试与撤销，兼容缺少分组键的旧审计', async t => {
  const { db, docs, items } = await fixture(t)
  await withTools(t, db, [items[0].id], async (call, sessionId) => {
    const first = await call('update_document_metadata', { id: items[0].id, patch: { author: '作者甲' } })
    const second = await call('update_document_metadata', { id: items[0].id, patch: { notes: '内容简介' } })
    const retry = await call('update_document_metadata', { id: items[0].id, patch: { notes: '内容简介' } })
    assert.equal(retry.id, second.id)
    const journal = new WorkspaceChanges(db as any)
    assert.equal(journal.list(sessionId).length, 2)
    assert.equal(journal.undo(second.id).undone, true)
    // Older JSON snapshots omitted customGroupId entirely when ungrouped.
    delete first.before.customGroupId
    delete first.after.customGroupId
    db.prepare('UPDATE workspace_changes SET before_json=?,after_json=? WHERE id=?').run(JSON.stringify(first.before), JSON.stringify(first.after), first.id)
    assert.equal(new WorkspaceChanges(db as any).undo(first.id).undone, true)
    assert.equal(docs.require(items[0].id).author, '')
    assert.equal(docs.require(items[0].id).notes, '')
    assert.equal(docs.require(items[0].id).customGroupId, undefined)
  })
})

test('6. 未分组资料可接受人工字段建议，仍拒绝过期建议与覆盖后续编辑', async t => {
  const { db, docs, items } = await fixture(t)
  const target = items[0].id
  docs.update(target, { author: '手填作者' })
  await withTools(t, db, [target], async call => {
    const proposal = await call('update_document_metadata', { id: target, patch: { author: '建议作者' } })
    assert.equal(proposal.state, 'proposed')
    delete proposal.before.customGroupId
    db.prepare('UPDATE workspace_changes SET before_json=? WHERE id=?').run(JSON.stringify(proposal.before), proposal.id)
    const journal = new WorkspaceChanges(db as any)
    assert.equal(journal.apply(proposal.id).state, 'applied')
    assert.equal(docs.require(target).author, '建议作者')
    docs.update(target, { notes: '保留人工新备注' })
    assert.equal(journal.undo(proposal.id).undone, false)
    const outdated = await call('update_document_metadata', { id: target, patch: { author: '另一个建议' } })
    docs.update(target, { author: '更新的人工值' })
    assert.throws(() => journal.apply(outdated.id), /变化|过期/)
    assert.equal(docs.require(target).author, '更新的人工值')
  })
})

test('7. 批次含错分类、无效或越界资料时拒绝整批，不留下新组与审计', async t => {
  const { db, docs, items } = await fixture(t)
  docs.update(items[1].id, { type: 'book' })
  docs.update(items[3].id, { name: '同名小说' })
  docs.update(items[4].id, { name: '同名小说' })
  let updates = 0
  await withTools(t, db, items.slice(0, 2).map(i => i.id), async (call, sessionId) => {
    for (const ref of [items[1].id, '不存在的小说', items[2].id.slice(0, 8), '同名小说']) {
      await assert.rejects(call('propose_document_groups', { groups: [{ name: '不应留下', documentIds: [items[0].id, ref] }] }), /分类|不存在|范围|唯一/)
      assert.equal(docs.customGroups().length, 0)
      assert.equal(new WorkspaceChanges(db as any).list(sessionId).length, 0)
      assert.equal(docs.require(items[0].id).customGroupId, undefined)
    }
  }, () => { updates++ })
  assert.equal(updates, 0)
})

test('8. 审计写入失败时新组、前面的资料变更和审计一起回滚', async t => {
  const { db, docs, items } = await fixture(t)
  db.exec(`CREATE TRIGGER reject_second_change BEFORE INSERT ON workspace_changes WHEN NEW.target_id='${items[1].id}' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END`)
  await withTools(t, db, items.map(i => i.id), async (call, sessionId) => {
    await assert.rejects(call('propose_document_groups', { groups: [{ name: '原子批次', documentIds: items.slice(0, 2).map(i => i.id) }] }), /fixture audit failure/)
    assert.equal(docs.customGroups().length, 0)
    assert.equal(new WorkspaceChanges(db as any).list(sessionId).length, 0)
    assert.ok(items.every(i => docs.require(i.id).customGroupId === undefined))
  })
})

test('9. 同批分别返回已保存、待确认与未变化，保留人工分组', async t => {
  const { db, docs, items } = await fixture(t)
  const old = docs.saveCustomGroup({ submodule: 'reading', categoryId: 'novel', name: '人工原组' })
  const target = docs.saveCustomGroup({ submodule: 'reading', categoryId: 'novel', name: '目标组' })
  docs.update(items[0].id, { customGroupId: old.id })
  docs.update(items[2].id, { customGroupId: target.id })
  await withTools(t, db, items.map(i => i.id), async (call, sessionId) => {
    const args = { groups: [{ name: target.name, documentIds: items.slice(0, 3).map(i => i.id) }] }
    const result = await call('propose_document_groups', args)
    assert.deepEqual([result.applied, result.proposed, result.unchanged], [1, 1, 1])
    assert.match(result.message, /待确认 1/)
    const rows = result.groups[0].items
    assert.deepEqual(rows.map((i: any) => i.state), ['proposed', 'applied', 'unchanged'])
    assert.equal(rows[2].changeId, null)
    assert.equal(docs.require(items[0].id).customGroupId, old.id)
    assert.equal(docs.require(items[1].id).customGroupId, target.id)
    const journal = new WorkspaceChanges(db as any)
    assert.equal(journal.list(sessionId).length, 2)
    const retry = await call('propose_document_groups', args)
    assert.deepEqual([retry.applied, retry.proposed, retry.unchanged], [0, 1, 2])
    assert.equal(retry.groups[0].items[0].changeId, rows[0].changeId)
    assert.equal(journal.list(sessionId).length, 2)
    assert.equal(journal.apply(rows[0].changeId).state, 'applied')
    assert.equal(docs.require(items[0].id).customGroupId, target.id)
    assert.equal(journal.undo(rows[0].changeId).undone, true)
    assert.equal(docs.require(items[0].id).customGroupId, old.id)
  })
})

test('10. 所有选中资料工具先解析别名，保留越界和歧义保护', async t => {
  const { db, docs, items } = await fixture(t)
  const target = items[0]
  docs.annotate(target.id, { kind: 'excerpt', quote: '第一章', note: '测试摘录', location: { page: 1, offset: 0 } })
  await withTools(t, db, [target.id.slice(0, 8)], async call => {
    assert.equal((await call('read_document_metadata', { id: target.name })).items[0].id, target.id)
    const text = await call('read_document_text', { id: target.id.slice(0, 8) })
    assert.equal(text.source.documentId, target.id)
    assert.match(text.text, /第一章/)
    assert.equal((await call('read_document_annotations', { id: target.name })).items[0].documentId, target.id)
    assert.equal((await call('update_document_metadata', { id: target.id.slice(0, 8), patch: { author: '正确的作者' } })).targetId, target.id)
    await assert.rejects(call('read_document_metadata', { id: items[1].id.slice(0, 8) }), /范围/)
    docs.update(items[1].id, { name: target.name })
    await assert.rejects(call('read_document_metadata', { id: target.name }), /不存在|唯一/)
  })
})

test('11. 同一资料分到不同组和空方案会拒绝，同组重复引用不重复修改', async t => {
  const { db, docs, items } = await fixture(t)
  await withTools(t, db, [items[0].id], async (call, sessionId) => {
    await assert.rejects(call('propose_document_groups', { groups: [] }), /分组|方案/)
    await assert.rejects(call('propose_document_groups', { groups: [{ name: '空组', documentIds: [] }] }), /资料|分组/)
    await assert.rejects(call('propose_document_groups', { groups: [
      { name: '甲', documentIds: [items[0].id] }, { name: '乙', documentIds: [items[0].name] },
    ] }), /多个|重复|不同/)
    assert.equal(docs.customGroups().length, 0)
    const result = await call('propose_document_groups', { groups: [
      { name: '合并组', documentIds: [items[0].id] }, { name: '合并组', documentIds: [items[0].name] },
    ] })
    assert.equal(result.applied, 1)
    assert.equal(result.groups.length, 1)
    assert.equal(new WorkspaceChanges(db as any).list(sessionId).length, 1)
  })
})

test('12. 歧义短编号不能靠选中范围强行消歧', async t => {
  const { db, docs, items, root } = await fixture(t)
  const prefix = items[0].id.slice(0, 8)
  const collision = prefix + '-ffff-4fff-afff-ffffffffffff'
  db.prepare("INSERT INTO resource(id,kind,path,file_name,name_zh,created_at,updated_at,ai_status) VALUES(?,'document',?,?,?,1,1,'done')").run(collision, path.join(root, 'collision.txt'), 'collision.txt', '编号碰撞资料')
  db.prepare("INSERT INTO document_meta(resource_id,format,document_type,category_id,submodule) VALUES(?,'txt','book','novel','reading')").run(collision)
  assert.equal(docs.get(prefix), null)
  await withTools(t, db, [items[0].id], async call => {
    await assert.rejects(call('read_document_metadata', { id: prefix }), /不存在|唯一/)
    assert.equal((await call('read_document_metadata', { id: items[0].id })).items[0].id, items[0].id)
  })
})

test('13. 资料子模块使用自己的分类默认值，显式错配整批拒绝', async t => {
  const { db, docs, items } = await fixture(t)
  docs.update(items[0].id, { type: 'archive_other' })
  await withTools(t, db, [items[0].id], async call => {
    await assert.rejects(call('propose_document_groups', {
      submodule: 'reading', categoryId: 'archive_other', groups: [{ name: '错误组', documentIds: [items[0].id] }],
    }), /分类|子模块/)
    const result = await call('propose_document_groups', {
      submodule: 'archive', groups: [{ name: '资料组', documentIds: [items[0].id] }],
    })
    assert.equal(result.applied, 1)
    assert.equal(docs.customGroups('archive', 'archive_other')[0].name, '资料组')
    assert.equal(docs.customGroups('reading').length, 0)
  })
})

test('14. 人工清空分组后需要确认，接受与撤销都能恢复未分组', async t => {
  const { db, docs, items } = await fixture(t)
  docs.update(items[0].id, { customGroupId: '' })
  await withTools(t, db, [items[0].id], async call => {
    const result = await call('propose_document_groups', { groups: [{ name: '建议分组', documentIds: [items[0].id] }] })
    assert.deepEqual([result.applied, result.proposed], [0, 1])
    assert.equal(docs.require(items[0].id).customGroupId, undefined)
    const journal = new WorkspaceChanges(db as any), changeId = result.groups[0].items[0].changeId
    assert.equal(journal.apply(changeId).state, 'applied')
    assert.equal(docs.require(items[0].id).customGroupId, result.groups[0].groupId)
    assert.equal(journal.undo(changeId).undone, true)
    assert.equal(docs.require(items[0].id).customGroupId, undefined)
  })
})
