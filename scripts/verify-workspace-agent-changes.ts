import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { PersonalLibrary } from '../electron/workspace/personal.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'

async function fixture(t:test.TestContext) {
  assert.ok(existsSync('electron/workspace/agent-changes.ts'),'需要真实写入、差异确认与撤销服务')
  const { WorkspaceChanges }=await import('../electron/workspace/agent-changes.ts')
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
  db.prepare("INSERT INTO workspace_sessions(id,module,title,created_at,updated_at,payload) VALUES('session','personal','验收',1,1,'{}')").run()
  t.after(()=>db.close());return {db,changes:new WorkspaceChanges(db),personal:new PersonalLibrary(db)}
}
test('个人 agent 登记幂等，续接修改同一记录并可逐步撤销',async t=>{
  const {db,changes,personal}=await fixture(t),input={kind:'asset' as const,name:'VPS',body:'测试服务',data:{cost:8,currency:'USD',cycle:'monthly',expiresOn:'2026-11-20'}}
  const created=changes.savePersonal('session',input)
  assert.equal(created.state,'applied');assert.equal(personal.list().length,1)
  assert.equal(changes.savePersonal('session',input).id,created.id,'工具重试不重复登记')
  const modified=changes.savePersonal('session',{id:created.targetId,kind:'asset',name:'VPS',body:'测试服务',data:{cycle:'yearly'}})
  assert.equal(modified.state,'applied');assert.equal(personal.list().length,1)
  assert.equal(personal.get(created.targetId)?.data.cost,8);assert.equal(personal.get(created.targetId)?.data.cycle,'yearly')
  const restarted=new (await import('../electron/workspace/agent-changes.ts')).WorkspaceChanges(db)
  assert.equal(restarted.undo(modified.id).undone,true);assert.equal(personal.get(created.targetId)?.data.cycle,'monthly')
  assert.equal(restarted.undo(created.id).undone,true);assert.equal(personal.list().length,0)
})
test('人工改过的记录必须先显示差异，过期建议不能覆盖新修改',async t=>{
  const {changes,personal}=await fixture(t)
  const created=changes.savePersonal('session',{kind:'asset',name:'VPS',body:'',data:{cost:8}})
  personal.save({id:created.targetId,kind:'asset',name:'VPS',body:'人工补充',data:{cost:9}})
  assert.equal(changes.undo(created.id).undone,false)
  const proposed=changes.savePersonal('session',{id:created.targetId,kind:'asset',name:'VPS',body:'人工补充',data:{cost:10}})
  assert.equal(proposed.state,'proposed');assert.equal(personal.get(created.targetId)?.data.cost,9)
  assert.equal(changes.apply(proposed.id).state,'applied');assert.equal(personal.get(created.targetId)?.data.cost,10)
  const another=personal.save({kind:'experience',name:'人工经历',body:'',data:{}})
  const pending=changes.savePersonal('session',{id:another.id,kind:another.kind,name:another.name,body:'拟补充',data:{}})
  personal.save({id:another.id,kind:'experience',name:'人工经历',body:'新编辑',data:{}})
  assert.throws(()=>changes.apply(pending.id),/变化|过期/);assert.equal(personal.get(another.id)?.body,'新编辑')
})
test('资料 agent 分类不能覆盖显式选择，自动补全可撤销且引用创建幂等',async t=>{
  const {db,changes,personal}=await fixture(t),root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-change-doc-'))
  t.after(async()=>{assert.ok(root.startsWith(os.tmpdir()+path.sep));await fs.rm(root,{recursive:true,force:true})})
  await fs.writeFile(path.join(root,'证书.pdf'),'fixture');const docs=new DocumentLibrary(db),doc=await docs.register(path.join(root,'证书.pdf'),'certificate')
  assert.throws(()=>changes.updateDocument('session',doc.id,{type:'book'}),/明确|分类/)
  const amended=changes.updateDocument('session',doc.id,{counterpart:'测试机构'})
  assert.equal(amended.state,'applied');assert.equal(docs.require(doc.id).counterpart,'测试机构')
  assert.equal(changes.undo(amended.id).undone,true);assert.equal(docs.require(doc.id).counterpart,'');assert.equal(docs.require(doc.id).typeLocked,true)
  docs.update(doc.id,{author:'人工作者'});docs.update(doc.id,{author:''})
  assert.equal(changes.updateDocument('session',doc.id,{author:'猜测作者'}).state,'proposed','人工清空字段也是明确编辑，不能当作可自动填空')
  const experience=changes.savePersonal('session',{kind:'experience',name:'取得证书',body:'',data:{date:'2026-10-21'}})
  const link=changes.addLink('session','experience',experience.targetId,doc.id)
  assert.equal(changes.addLink('session','experience',experience.targetId,doc.id).id,link.id)
  assert.equal(changes.undo(experience.id).undone,false,'有关联时不能静默移除记录')
  assert.equal(changes.undo(link.id).undone,true);assert.equal(changes.undo(experience.id).undone,true)
  assert.equal(personal.list().length,0)
})
