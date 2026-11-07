import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {DocumentInsightService} from '../electron/workspace/document-insight-service.ts'
import {DocumentInsights} from '../electron/workspace/document-insights.ts'
type Workflow=Parameters<ConstructorParameters<typeof DocumentInsightService>[0]['run']>[0]
const config={enabled:true,api_url:'http://synthetic.invalid/v1',api_key:'synthetic-not-real',model:'fixture'}
async function waitUntil(check:()=>boolean){for(let i=0;i<300;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,20))}throw new Error('任务等待超时')}
async function submit(input:Workflow){
  const metadata=await input.execute('archive_get',{}) as any,categories=await input.execute('archive_catalog',{}) as any[]
  let data=await input.execute('archive_read',{}) as any
  if(data.format==='json-fragment'){let text='';while(true){text+=data.text;if(data.next===null)break;data=await input.execute('archive_read',{offset:data.next})}data=JSON.parse(text)}
  const first=data.fragments?.find((p:any)=>p.text.trim())||{id:data.candidates[0].evidence[0].sourceRef,text:data.candidates[0].evidence[0].quote}
  const result={requestId:metadata.requestId,sourceFingerprint:metadata.sourceFingerprint,expectedRevision:metadata.expectedRevision,coreValue:'本合成资料用于检查精读生成与引用校验，同时保留用户原先的阅读状态。',keyConclusions:[{text:'保留可核对的原文',status:'supported',evidenceIds:['e1']},{text:null,status:'insufficient',evidenceIds:[]},{text:null,status:'insufficient',evidenceIds:[]}],suggestedCategoryId:categories[0].id,suggestedTags:['测试'],evidence:[{id:'e1',sourceRef:first.id,quote:first.text.trim().slice(0,60)}],limitations:[]}
  await input.execute('archive_submit_insight',result);return {sessionId:'synthetic-session'}
}
async function fixture(t:test.TestContext,run:(input:Workflow)=>Promise<{sessionId:string}>=submit,extra:Partial<ConstructorParameters<typeof DocumentInsightService>[0]>={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-insight-service-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const file=path.join(root,'合成.md');await fs.writeFile(file,'# 合成资料\n这里的正文用来核对精读功能，不是真实个人资料。')
  const docs=new DocumentLibrary(db),item=await docs.register(file);let current=true
  const service=new DocumentInsightService({db,assets:path.resolve('dist/pdfjs'),scope:'public',current:()=>current,config:()=>config,run,changed:()=>{},...extra})
  t.after(async()=>{await service.close();db.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'baoyi-insight-service-')));await fs.rm(root,{recursive:true,force:true})})
  const start=(force=false)=>service.start(service.preview([item.id]).token,force)[0]
  return {root,db,file,item,service,docs,start,hide:()=>{current=false}}
}
test('确认后生成、重复不计费、读取状态保持；同文件内容变化标记需重做',async t=>{
  let calls=0;const {service,start,item,docs,file}=await fixture(t,async input=>{calls++;assert.equal(input.kind,'document_insight');assert.equal(input.priority,'background');const meta=await input.execute('archive_get',{});assert.ok(!JSON.stringify(meta).includes(path.dirname(file)));return submit(input)})
  const original=docs.require(item.id),run=start();assert.equal(start().id,run.id)
  await waitUntil(()=>!service.busy);assert.equal(service.list()[0].status,'ready');assert.equal(calls,1)
  const detail=await service.detail(item.id);assert.ok(detail.active);assert.equal(detail.sourceStatus,'verified')
  assert.equal(docs.require(item.id).readState,original.readState);assert.equal(docs.require(item.id).type,original.type)
  start();await waitUntil(()=>!service.busy);assert.equal(calls,1)
  await fs.appendFile(file,'\n已更新资料');assert.equal((await service.detail(item.id)).sourceStatus,'stale')
})
test('取消时迟到提交被拒绝，编辑和来源变化都不能覆盖现有版本',async t=>{
  let release!:()=>void,entered=false
  const {service,start,item,db}=await fixture(t,async input=>{entered=true;await new Promise<void>(resolve=>release=resolve);await assert.rejects(submit(input),/停止/);return {sessionId:'late'}})
  const run=start();await waitUntil(()=>entered);await service.cancel(run.id);release();await waitUntil(()=>!service.busy)
  assert.equal(new DocumentInsights(db).active(item.id),null);assert.equal(service.list()[0].status,'cancelled')
})
test('只读取本分块给出的证据；四组分块加一次合并，内容无本地路径',async t=>{
  let calls=0
  const {service,start,file}=await fixture(t,async input=>{calls++;return submit(input)})
  await fs.writeFile(file,('这是一段有证据的合成内容。\n').repeat(4000))
  start();await waitUntil(()=>!service.busy)
  assert.equal(service.list()[0].status,'ready',service.list()[0].error);assert.equal(calls,5)
})
test('工作流中途来源变化拒绝保存；重启任务为中断，不会自动续费',async t=>{
  const {service,start,file,db,item}=await fixture(t,async input=>{const result=await submit(input);await fs.appendFile(file,'\n变化');return result})
  start();await waitUntil(()=>!service.busy);assert.equal(service.list()[0].status,'failed');assert.match(service.list()[0].error,/变化/)
  assert.equal(new DocumentInsights(db).active(item.id),null)
  db.prepare("UPDATE document_insight_runs SET status='running'").run()
  const recovered=new DocumentInsightService({db,assets:'',scope:'public',current:()=>true,config:()=>config,run:()=>{throw new Error('不得自动执行')},changed:()=>{}})
  assert.equal(recovered.list()[0].status,'interrupted');assert.equal(recovered.busy,false);await recovered.close()
})
test('默认导入不上传；自动授权只匹配分类和服务商，变更后暂停',async t=>{
  let calls=0
  const {service,item,db}=await fixture(t,async input=>{calls++;return submit(input)})
  assert.equal(service.afterImport([item.id]),'');assert.equal(calls,0)
  const policy=service.policy();service.savePolicy({...policy,automatic:true,categories:[item.type],maxChars:12000})
  assert.equal(service.afterImport([item.id],'skip'),'');assert.equal(service.busy,false)
  assert.match(service.afterImport([item.id]),/1 份/);await waitUntil(()=>!service.busy);assert.equal(calls,1)
  const stored=JSON.parse((db.prepare("SELECT value FROM settings WHERE key='_document_insight_policy'").get() as any).value);stored.provider='different provider'
  db.prepare("UPDATE settings SET value=? WHERE key='_document_insight_policy'").run(JSON.stringify(stored))
  assert.equal(service.policy().authorized,false);assert.match(service.afterImport([item.id]),/暂停/);assert.equal(calls,1)
  assert.match(service.afterImport([item.id],'different provider'),/变化/);assert.equal(calls,1)
})
test('读取范围变化不复用旧结果；清理预览阻止并发改版，人工修订保持当前',async t=>{
  let calls=0;const {service,start,item,db,file}=await fixture(t,async input=>{calls++;return submit(input)})
  await fs.appendFile(file,'\n后续范围内仍有可引用的合成正文。')
  start();await waitUntil(()=>!service.busy)
  const old=service.cleanupPreview(),notes=new DocumentInsights(db),first=notes.active(item.id)!
  const {keyConclusions,suggestedCategoryId,suggestedTags,evidence,limitations}=first
  notes.edit(item.id,first.revision,{keyConclusions,suggestedCategoryId,suggestedTags,evidence,limitations,coreValue:'这是一条需要永久保留的人工修订内容，不应被生成稿清理误删。'})
  assert.throws(()=>service.cleanup(old.token),/变化/)
  const range=service.preview([item.id],{start:7});service.start(range.token);await waitUntil(()=>!service.busy)
  assert.equal(calls,2);assert.equal(service.list()[0].status,'ready',service.list()[0].error)
  const preview=service.cleanupPreview();assert.equal(preview.generated,2);assert.equal(preview.edited,1)
  assert.equal(service.cleanup(preview.token),2);assert.equal(notes.history(item.id).length,1);assert.equal(notes.active(item.id)?.userEdited,true)
})
test('模型60%预算在调用前拒绝；隐私变化和关闭取消阻止迟到保存',async t=>{
  let called=false
  const limited=await fixture(t,async input=>{called=true;return submit(input)},{budget:async()=>({estimatedTokens:6001,inputLimit:6000})})
  limited.start();await waitUntil(()=>!limited.service.busy);assert.equal(called,false);assert.match(limited.service.list()[0].error,/60%/)
  let entered=false,release!:()=>void
  const hidden=await fixture(t,async input=>{entered=true;await new Promise<void>(resolve=>release=resolve);await assert.rejects(submit(input),/范围/);return {sessionId:'hidden'}})
  hidden.start();await waitUntil(()=>entered);hidden.hide();release();await waitUntil(()=>!hidden.service.busy)
  assert.equal(new DocumentInsights(hidden.db).active(hidden.item.id),null)
  await assert.rejects(hidden.service.detail(hidden.item.id),/范围/)
  let closingEntered=false
  const closing=await fixture(t,async input=>{closingEntered=true;await new Promise<void>(resolve=>input.signal!.addEventListener('abort',()=>resolve(),{once:true}));await assert.rejects(submit(input),/范围|停止/);return {sessionId:'closing'}})
  closing.start();await waitUntil(()=>closingEntered);await closing.service.close();assert.equal(closing.service.busy,false);assert.equal(new DocumentInsights(closing.db).active(closing.item.id),null)
})
