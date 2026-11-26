import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { TimelineLibrary } from '../electron/workspace/timeline.ts'

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-history-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
  t.after(async () => { db.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }) })
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  // commit-tree creates a real deterministic history without 90 worktree updates.
  const tree = git('mktree'); let head = ''
  for (let i = 0; i < 91; i++) head = git('commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `历史步骤 ${i + 1}`)
  git('update-ref', 'HEAD', head)
  const project = new ProjectLibrary(db).register({ path: root, name: '历史样本', summary: '', category: '软件项目', source: 'self', version: '', entries: [], evidence: '', suggested: true, warnings: [] })
  return { root, db, git, project, timeline: new TimelineLibrary(db), head }
}

test('历史可翻过 80 条且分页固定 head，不受新增提交及已有日志影响', async t => {
  const f = await fixture(t)
  const module = await import('../electron/workspace/project-history.ts')
  const first = await module.projectHistory(f.root, { limit: 30 })
  assert.equal(first.commits.length, 30); assert.ok(first.next)
  const event = f.timeline.suggest(f.project.id, { title: '已有日志', body: '已记录', source: 'git', sourceKey: 'old', evidence: first.commits.map(c => 'commit:' + c.sha) })
  f.timeline.publish(f.project.id, event.id)
  f.git('commit', '--allow-empty', '-q', '-m', '新增提交')
  const shas = first.commits.map(c => c.sha); let cursor: Awaited<ReturnType<typeof module.projectHistory>>['next'] = first.next
  while (cursor) { const page = await module.projectHistory(f.root, { cursor, limit: 30 }); shas.push(...page.commits.map(c => c.sha)); cursor = page.next }
  assert.equal(shas.length, 91); assert.equal(new Set(shas).size, 91); assert.equal(shas[0], f.head)
  assert.equal((await module.projectHistory(f.root, { limit: 100 })).commits.length, 92)
  const detail = await module.projectCommit(f.root, shas[90]); assert.match(detail.text, /历史步骤 1/)
})

test('自动日志幂等保存、保留人工修订，并可撤销未修订生成结果', async t => {
  const f = await fixture(t)
  const { AgentJournal } = await import('../electron/workspace/agent-journal.ts')
  const journal = new AgentJournal(f.db)
  const input = { title: '完成历史梳理', body: '汇总已有提交', commits: [f.head], version: '', occurredAt: Date.now() }
  const saved = journal.record(f.project.id, 'session-one', input)
  assert.equal(saved.status, 'published'); assert.equal(saved.generated?.sessionId, 'session-one')
  assert.equal(journal.record(f.project.id, 'session-two', input).id, saved.id)
  f.timeline.save(f.project.id, { id: saved.id, title: '人工标题', body: '人工修订', version: '', milestone: false, occurredAt: saved.occurredAt })
  assert.equal(journal.record(f.project.id, 'session-three', input).body, '人工修订')
  const skipped = journal.undo(f.project.id, saved.id)
  assert.equal(skipped.undone, false); assert.match(skipped.reason, /人工/)
  f.git('commit', '--allow-empty', '-q', '-m', '第二组')
  const second = journal.record(f.project.id, 'session-two', { ...input, commits: [f.git('rev-parse', 'HEAD')] })
  assert.equal(journal.undo(f.project.id, second.id).undone, true)
  assert.equal(f.timeline.events(f.project.id).filter(e => e.status === 'published').length, 1)
  assert.equal(journal.record(f.project.id, 'session-two', { ...input, commits: [f.git('rev-parse', 'HEAD')] }).status, 'dismissed')
})

test('批次撤销先预览，保留人工修改和关联记录，只影响指定会话', async t => {
  const f = await fixture(t), { AgentJournal } = await import('../electron/workspace/agent-journal.ts')
  const journal = new AgentJournal(f.db), history = await (await import('../electron/workspace/project-history.ts')).projectHistory(f.root, {limit:5})
  const events = history.commits.map((c, i) => journal.record(f.project.id, i === 4 ? 'another' : 'batch', {title:'步骤 '+i, body:'自动记录', commits:[c.sha], occurredAt:Date.now()}))
  f.timeline.save(f.project.id, {id:events[1].id, title:'人工修订', body:'保留', occurredAt:events[1].occurredAt, milestone:false, version:''})
  assert.equal(typeof journal.undoBatch, 'function', '应提供批次预览和撤销')
  const preview = journal.undoBatch(f.project.id, 'batch', false)
  assert.equal(preview.undone, 0); assert.equal(preview.eligible.length, 3); assert.equal(preview.retained.length, 1)
  assert.equal(f.timeline.events(f.project.id).filter(e=>e.status==='published').length, 5)
  const result = journal.undoBatch(f.project.id, 'batch', true)
  assert.equal(result.undone, 3); assert.equal(result.retained[0].id, events[1].id)
  assert.equal(f.timeline.event(f.project.id, events[4].id).status, 'published')
  assert.equal(journal.undoBatch(f.project.id, 'batch', true).undone, 0)
})
