import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'

test('新提交稳定后才自动整理，空变化、禁用与忙碌时不调用模型', async () => {
  const db = new DatabaseSync(':memory:'); initSchema(db, KINDS)
  try {
    const { ProjectAutomation } = await import('../electron/workspace/project-automation.ts')
    const project = new ProjectLibrary(db).register({ path: process.cwd(), name: '自动记录样本', summary: '', category: '软件项目', source: 'self', version: '', entries: [], evidence: '', suggested: true, warnings: [] })
    let head = 'a'.repeat(40), calls = 0, busy = false
    const automation = new ProjectAutomation(db, { head: async () => head, busy: () => busy, start: async (_, after) => { assert.equal(after, 'a'.repeat(40)); calls++; return 'session-fixture' } })
    automation.completed(project.id, head)
    await automation.tick(1000); assert.equal(calls, 0)
    head = 'b'.repeat(40); await automation.tick(2000); assert.equal(calls, 0)
    await automation.tick(18000); assert.equal(calls, 1)
    await automation.tick(40000); assert.equal(calls, 1, '已提交任务不重复排队')
    automation.completed(project.id, head); head = 'c'.repeat(40); busy = true
    await automation.tick(50000); assert.equal(calls, 1)
    automation.preferences(project.id, false); busy = false; await automation.tick(90000); assert.equal(calls, 1)
  } finally { db.close() }
})
