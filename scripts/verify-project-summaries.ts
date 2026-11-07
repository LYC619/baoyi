import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {TimelineLibrary} from '../electron/workspace/timeline.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {buildLibraryBackup,restoreLibraryBackup} from '../electron/services/library-backup.ts'
import {createProjectAgent} from '../electron/kinds/project/agent.ts'
test('天周版本摘要读取原始事件、保存来源、保护人工修订，备份后可撤销未修订摘要',async t=>{
  assert.ok(existsSync('electron/workspace/project-summaries.ts'),'分组视图需要实际持久摘要')
  const {ProjectSummaries}=await import('../electron/workspace/project-summaries.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL);t.after(()=>db.close())
  const item=new ProjectLibrary(db).register({path:process.cwd(),name:'摘要样本',summary:'',category:'软件项目',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]}),timeline=new TimelineLibrary(db),summaries=new ProjectSummaries(db)
  const a=timeline.save(item.id,{title:'实现入口',body:'新增入口；尚未运行验收。',occurredAt:new Date(2026,9,20,12).getTime(),milestone:false,version:'v1'}),b=timeline.save(item.id,{title:'修复错误',body:'修复保存错误，测试通过。',occurredAt:new Date(2026,9,21,12).getTime(),milestone:false,version:'v1'})
  assert.equal(summaries.sources(item.id,'day','2026-10-20').events.length,1);assert.equal(summaries.sources(item.id,'week','2026-10-19').events.length,2);assert.equal(summaries.sources(item.id,'version','v1').events.length,2)
  const source=summaries.sources(item.id,'week','2026-10-19'),summary=summaries.save(item.id,'session',{kind:'week',key:'2026-10-19',title:'入口与保存',body:'完成入口和保存修复；入口尚未验收。',stamp:source.stamp})
  assert.equal(summary.sources.length,2);assert.equal(summary.sessionId,'session');assert.equal(summary.revised,false)
  assert.equal(summaries.save(item.id,'session',{kind:'week',key:'2026-10-19',title:'入口与保存',body:summary.body,stamp:source.stamp}).id,summary.id)
  timeline.save(item.id,{id:a.id,title:a.title,body:'入口验收通过。',occurredAt:a.occurredAt,milestone:false,version:'v1'})
  assert.equal(summaries.list(item.id)[0].stale,true)
  assert.throws(()=>summaries.save(item.id,'session',{kind:'week',key:'2026-10-19',title:'过期写入',body:'旧内容',stamp:source.stamp}),/变化|过期/)
  summaries.edit(item.id,summary.id,{title:'人工摘要',body:'由用户保留的限制条件'})
  assert.throws(()=>summaries.save(item.id,'session',{kind:'week',key:'2026-10-19',title:'覆盖',body:'覆盖',stamp:summaries.sources(item.id,'week','2026-10-19').stamp}),/人工/)
  assert.equal(summaries.undo(item.id,summary.id).undone,false)
  const version=summaries.save(item.id,'other-session',{kind:'version',key:'v1',title:'v1 摘要',body:b.body,stamp:summaries.sources(item.id,'version','v1').stamp})
  const backup=buildLibraryBackup(db);restoreLibraryBackup(db,backup);assert.equal(summaries.list(item.id).length,2);assert.equal(summaries.undo(item.id,version.id).undone,true);assert.equal(summaries.list(item.id).length,1)
})
test('摘要入口创建真实会话，必须完整分页读取原始记录后才能保存',async t=>{
  const {ProjectSummaries}=await import('../electron/workspace/project-summaries.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS);t.after(()=>db.close())
  const project=new ProjectLibrary(db).register({path:process.cwd(),name:'分页摘要',summary:'',category:'软件项目',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]})
  new TimelineLibrary(db).save(project.id,{title:'较长原始记录',body:'尚未测试。'.repeat(5000),occurredAt:new Date(2026,9,20,12).getTime(),milestone:false,version:'v2'})
  let complete!:()=>void;const finished=new Promise<void>(resolve=>{complete=resolve})
  const manager=createProjectAgent({db,config:()=>({enabled:true,api_key:'fixture',api_url:'http://fixture.invalid',model:'fixture'}),run:async options=>{
    const read=options.tools.find(t=>t.name==='read_project_summary_sources'),save=options.tools.find(t=>t.name==='save_project_summary');assert.ok(read);assert.ok(save)
    let page=JSON.parse(await read.execute({kind:'version',key:'v2'}));assert.ok(page.next)
    await assert.rejects(save.execute({kind:'version',key:'v2',title:'不能跳过来源',body:'错误',stamp:page.stamp}),/完整|读取/)
    while(page.next!==null)page=JSON.parse(await read.execute({kind:'version',key:'v2',start:page.next,stamp:page.stamp}))
    const result=JSON.parse(await save.execute({kind:'version',key:'v2',title:'v2 摘要',body:'原记录尚未测试。',stamp:page.stamp}));assert.equal(result.saved,true)
    return {text:'摘要已保存',stopReason:'done',tokens:0,turns:1,error:''}
  },changed:session=>{if(session.status!=='running'&&session.messages.length)complete()}})
  assert.equal(typeof manager.summarize,'function','摘要操作必须创建真实会话')
  const session=manager.summarize(project.id,'version','v2');assert.ok(manager.get(session.id));await finished
  assert.equal(manager.get(session.id)?.status,'idle',manager.get(session.id)?.error);assert.equal(new ProjectSummaries(db).list(project.id)[0].sessionId,session.id)
})
