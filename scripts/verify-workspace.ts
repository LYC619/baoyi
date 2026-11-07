import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { WorkspaceLinks } from '../electron/workspace/links.ts'
import { TimelineLibrary } from '../electron/workspace/timeline.ts'
import { PersonalLibrary } from '../electron/workspace/personal.ts'
import { buildLibraryBackup, restoreLibraryBackup } from '../electron/services/library-backup.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { collectEvidence } from '../electron/workspace/evidence.ts'

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-workspace-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS); db.exec(VIDEO_JOBS_SQL)
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }) })
  const file = path.join(root, '参考.md'); await fs.writeFile(file, '# 参考\n\n事务是一个逻辑单元。\n\n用于项目记录。')
  const project = new ProjectLibrary(db).register({ path: root, name: '研究项目', summary: '', category: '调研写作', source: 'self', version: '', entries: [], evidence: '', suggested: true, warnings: [] })
  return { db, root, file, project, docs: new DocumentLibrary(db), links: new WorkspaceLinks(db), timeline: new TimelineLibrary(db), personal: new PersonalLibrary(db) }
}

test('资料重复导入和重新定位保留人工内容、摘录与稳定引用', async t => {
  const { docs, links, project, file, root } = await fixture(t)
  const item = await docs.register(file)
  docs.update(item.id, { name: '自己的标题', type: 'paper', author: '作者', tags: ['事务'] })
  const annotation = docs.annotate(item.id, { kind: 'excerpt', quote: '事务是一个逻辑单元。', note: '我的理解', location: { page: 1, offset: .3 } })
  const link = links.add('project', project.id, item.id, annotation.id)
  assert.equal(links.add('project', project.id, item.id, annotation.id).id, link.id)
  assert.equal((await docs.register(file)).name, '自己的标题')
  docs.savePosition(item.id, { page: 2, offset: .4 }, 3)
  const moved = path.join(root, '改名.md'); await fs.rename(file, moved)
  assert.equal(docs.get(item.id)?.available, false)
  await docs.relocate(item.id, moved)
  assert.equal(docs.get(item.id)?.position.page, 2)
  assert.equal(links.list('project', project.id)[0].path, moved)
  assert.equal(docs.annotations(item.id)[0].note, '我的理解')
  docs.remove(item.id)
  assert.equal(links.list('project', project.id)[0].quote, '事务是一个逻辑单元。')
  assert.equal(links.list('project', project.id)[0].missing, true)
  assert.equal(await fs.readFile(moved, 'utf8'), '# 参考\n\n事务是一个逻辑单元。\n\n用于项目记录。')
})

test('资料类型、位置和摘录归属校验，扫描排除依赖和执行文件', async t => {
  const { docs, links, project, file, root } = await fixture(t)
  const a = await docs.register(file)
  const other = path.join(root, '合同.txt'); await fs.writeFile(other, '租赁合同')
  const contract=docs.saveCategory({name:'合同',description:'协议',behavior:'contract',order:8})
  const b = await docs.register(other); docs.update(b.id, { type: contract.id, counterpart: '出租方', expiresOn: '2027-01-01' })
  assert.equal(docs.get(b.id)?.readable, false)
  assert.throws(() => docs.savePosition(a.id, { page: -1, offset: 0 }, 2))
  assert.throws(() => docs.update(b.id, { expiresOn: '2026-02-30' }))
  const mark = docs.annotate(a.id, { kind: 'bookmark', quote: '', note: '位置', location: { page: 1, offset: 0 } })
  assert.throws(() => links.add('project', project.id, b.id, mark.id))
  await fs.mkdir(path.join(root, 'node_modules')); await fs.writeFile(path.join(root, 'node_modules', 'hidden.md'), 'hidden')
  await fs.writeFile(path.join(root, 'danger.ps1'), 'exit')
  const scan = await docs.scan([root]); assert.equal(scan.items.length, 2)
  assert.ok(scan.items.every(x => !x.path.includes('node_modules')))
})

test('项目草稿确认、重复来源去重和人工修订保护', async t => {
  const { timeline, project } = await fixture(t)
  timeline.updateContext(project.id, { ...timeline.context(project.id), current: '整理文献', next: '写研究方法' })
  const draft = timeline.suggest(project.id, { title: '文献更新', body: '新增两份资料', source: 'directory', sourceKey: 'change-1', evidence: ['参考.md'] })
  assert.equal(draft.status, 'draft')
  assert.equal(timeline.events(project.id).filter(x => x.status === 'published').length, 0)
  timeline.publish(project.id, draft.id)
  timeline.save(project.id, { id: draft.id, title: '人工说明', body: '确认研究范围', occurredAt: Date.now(), milestone: true, version: '' })
  timeline.suggest(project.id, { title: '再次生成', body: '不该覆盖', source: 'directory', sourceKey: 'change-1', evidence: [] })
  assert.equal(timeline.events(project.id)[0].body, '确认研究范围')
  assert.equal(timeline.events(project.id)[0].revised, true)
  assert.equal(timeline.events(project.id).length, 1)
  assert.match(timeline.export(project.id), /确认研究范围/)
  assert.throws(() => timeline.publish('wrong-project', draft.id))
})

test('个人资产、状态、技能及经历持久保存并校验关系', async t => {
  const { personal, links, project } = await fixture(t)
  const asset = personal.save({ kind: 'asset', name: '域名', body: '个人站点', data: { cost: 88, currency: 'CNY', cycle: 'yearly', expiresOn: '2027-01-01', url: 'https://example.com' } })
  assert.equal(personal.get(asset.id)?.data.cost, 88)
  assert.throws(() => personal.save({ kind: 'asset', name: '错误', body: '', data: { cost: -1 } }))
  const skill = personal.save({ kind: 'skill', name: '研究写作', body: '能完成初稿', data: { stages: ['learned', 'used'], practice: '整理过研究方案' } })
  links.add('skill', skill.id, project.id)
  assert.equal(links.list('skill', skill.id)[0].kind, 'project')
  assert.throws(() => links.add('experience', skill.id, project.id))
  const metric = personal.save({ kind: 'metric', name: '睡眠', body: '', data: { unit: '小时' } })
  personal.save({ kind: 'measurement', name: '昨晚', body: '', data: { metricId: metric.id, value: 7.5, date: '2026-10-21' } })
  assert.equal(personal.list('measurement')[0].data.value, 7.5)
  assert.throws(() => personal.remove(metric.id), /记录/)
})

test('资料、事件、个人记录和引用包含在备份中并完整恢复', async t => {
  const { db, docs, links, project, file, personal, timeline } = await fixture(t)
  const doc = await docs.register(file)
  const annotation = docs.annotate(doc.id, { kind: 'excerpt', quote: '事务', note: '保留笔记', location: { page: 1, offset: 0 } })
  const event = timeline.save(project.id, { title: '研究记录', body: '得到结论', occurredAt: Date.now(), milestone: true, version: '' })
  links.add('event', event.id, doc.id, annotation.id)
  const skill = personal.save({ kind: 'skill', name: '写作', body: '我的自评', data: { stages: ['used'] } }); links.add('skill', skill.id, project.id)
  const backup = buildLibraryBackup(db)
  assert.equal((backup.tables as any).document_annotations.length, 1)
  assert.equal((backup.tables as any).personal_records.length, 1)
  const target = new DatabaseSync(':memory:'); target.exec('PRAGMA foreign_keys=ON'); initSchema(target, KINDS); target.exec(VIDEO_JOBS_SQL); t.after(() => target.close())
  restoreLibraryBackup(target, backup)
  assert.equal(new DocumentLibrary(target).annotations(doc.id)[0].note, '保留笔记')
  assert.equal(new PersonalLibrary(target).get(skill.id)?.body, '我的自评')
  assert.equal(new WorkspaceLinks(target).list('event', event.id)[0].quote, '事务')
})

test('非代码目录首次建立基线，后续变化建议不因查看而丢失', async t => {
  const { db, project, root } = await fixture(t)
  const first = await collectEvidence(db, project.id); assert.equal(first.key, '')
  await fs.writeFile(path.join(root, '新增资料.md'), '# 新资料')
  await fs.writeFile(path.join(root, '.env'), 'secret=hidden')
  const changed = await collectEvidence(db, project.id)
  assert.match(changed.text, /新增资料/); assert.doesNotMatch(changed.text, /secret=hidden|\.env/)
  assert.equal((await collectEvidence(db, project.id)).key, changed.key)
})

test('五库计数不会被资源选择器的一万项上限截断', async t => {
  const { db, links } = await fixture(t)
  db.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO resource(id,kind,path,file_name,created_at,updated_at) SELECT 'count-'||x,'document','/count/'||x,'sample',1,1 FROM n")
  assert.equal(links.counts().document, 10001)
})

test('项目日志导出包括资料、摘录和原文位置', async t => {
  const { docs, links, timeline, project, file } = await fixture(t)
  const doc = await docs.register(file),annotation=docs.annotate(doc.id,{kind:'excerpt',quote:'事务是一个逻辑单元。',note:'',location:{page:2,offset:0}})
  const event=timeline.save(project.id,{title:'采用研究依据',body:'记录结果',occurredAt:Date.now(),milestone:false,version:''})
  links.add('event',event.id,doc.id,annotation.id)
  assert.match(timeline.export(project.id),/事务是一个逻辑单元/)
  assert.match(timeline.export(project.id),/第 2 页/)
  docs.remove(doc.id)
  assert.match(timeline.export(project.id),/事务是一个逻辑单元/)
})
