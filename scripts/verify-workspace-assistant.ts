import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { TimelineLibrary } from '../electron/workspace/timeline.ts'
import { collectEvidence } from '../electron/workspace/evidence.ts'
import { generateTimeline } from '../electron/workspace/assistant.ts'

function fixture(t:test.TestContext){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS);t.after(()=>db.close())
  const item=new ProjectLibrary(db).register({path:process.cwd(),name:'抱一验证',summary:'',category:'软件项目',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]})
  return {db,item,timeline:new TimelineLibrary(db)}
}
test('已有日志不影响重读提交，事实草稿独立去重并保护人工修改',async t=>{
  const {db,item,timeline}=fixture(t),evidence=await collectEvidence(db,item.id)
  assert.equal(evidence.source,'git');assert.ok(evidence.evidence.length>0);assert.ok(evidence.evidence.length<=80)
  assert.ok(evidence.evidence.every(e=>/^commit:[a-f0-9]{40} /.test(e)))
  const event=timeline.suggest(item.id,{title:'仓库记录',body:'待核对意图',source:'git',sourceKey:evidence.key,evidence:evidence.evidence})
  timeline.publish(item.id,event.id);timeline.save(item.id,{id:event.id,title:'人工修订',body:'保留人工判断',occurredAt:Date.now(),milestone:false,version:''})
  assert.equal((await collectEvidence(db,item.id)).key,evidence.key)
  assert.equal(await generateTimeline(db,item.id,false,{} as any),null)
  assert.equal(timeline.events(item.id)[0].body,'保留人工判断')
})
test('旧一次性 AI 生成实现不再调用模型，必须使用持久会话入口',async t=>{
  const {db,item,timeline}=fixture(t)
  await assert.rejects(generateTimeline(db,item.id,true,{} as any),/会话/)
  assert.equal(timeline.events(item.id).length,0)
})
