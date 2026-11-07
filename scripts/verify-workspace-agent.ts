import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {createServer} from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {PersonalLibrary} from '../electron/workspace/personal.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {buildLibraryBackup,restoreLibraryBackup} from '../electron/services/library-backup.ts'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {textPdf} from './helpers/pdf-fixture.ts'

test('个人持久会话通过真实 HTTP 工具登记、续接修改、重启后撤销',async t=>{
  assert.ok(existsSync('electron/workspace/agent.ts'),'资料与个人需要持久 agent 服务')
  const {createWorkspaceAgent}=await import('../electron/workspace/agent.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL);t.after(()=>db.close())
  let count=0;const requests:any[]=[]
  const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);count++
    const first=count===1,edit=count===3,record=new PersonalLibrary(db).list('asset')[0]
    const message=first||edit?{role:'assistant',content:null,tool_calls:[{id:'write-'+count,type:'function',function:{name:'save_personal_record',arguments:JSON.stringify(first?{kind:'asset',name:'VPS',body:'测试服务',data:{cost:8,currency:'USD',cycle:'monthly',expiresOn:'2026-11-20'}}:{id:record.id,data:{cycle:'yearly'}})}}]}:{role:'assistant',content:'已保存，可编辑或撤销。'}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message}],usage:{total_tokens:1}}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())}))
  const config=()=>({enabled:true,api_key:'fixture',api_url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,model:'fixture'})
  const manager=createWorkspaceAgent({db,config}),session=manager.create('personal')
  assert.equal((await manager.send(session.id,'登记 VPS，每月 8 美元，11 月 20 日到期')).status,'idle')
  const schema=requests[0].tools.find((t:any)=>t.function.name==='save_personal_record').function.parameters
  assert.equal(schema.properties.data.properties?.cost?.type,'number','工具应明确费用是 JSON 数值，不能让模型猜字段类型')
  assert.equal(schema.properties.data.properties?.done?.type,'boolean')
  const first=new PersonalLibrary(db).list('asset')[0];assert.equal(first.data.cost,8)
  assert.ok(manager.get(session.id)?.messages.some(m=>m.events.some(e=>e.label==='save_personal_record 结果')))
  const reopened=createWorkspaceAgent({db,config});await reopened.send(session.id,'改成每年')
  assert.equal(new PersonalLibrary(db).list('asset').length,1);assert.equal(new PersonalLibrary(db).get(first.id)?.data.cycle,'yearly')
  assert.ok(requests[2].messages.some((m:any)=>m.content?.includes(first.id)),'续接应保留所操作记录编号')
  const changes=reopened.changes(session.id);assert.equal(changes.length,2)
  assert.equal(reopened.undo(session.id,changes[1].id).undone,true)
  assert.equal(new PersonalLibrary(db).get(first.id)?.data.cycle,'monthly')
  const other=reopened.create('personal');assert.throws(()=>reopened.undo(other.id,changes[0].id),/会话/)
  const payload=reopened.get(session.id)!;payload.status='running';db.prepare('UPDATE workspace_sessions SET payload=? WHERE id=?').run(JSON.stringify(payload),session.id)
  const backup=buildLibraryBackup(db),target=new DatabaseSync(':memory:');initSchema(target,KINDS);target.exec(VIDEO_JOBS_SQL);t.after(()=>target.close())
  restoreLibraryBackup(target,backup)
  const restored=JSON.parse((target.prepare('SELECT payload FROM workspace_sessions WHERE id=?').get(session.id) as {payload:string}).payload)
  assert.equal(restored.status,'interrupted','恢复备份必须暂停未完成的模块会话')
  assert.equal((target.prepare('SELECT COUNT(*) AS n FROM workspace_changes').get() as {n:number}).n,2)
})

test('资料会话实际调用 PDF 正文工具、返回来源页并阻止读取未选资料',async t=>{
  const {createWorkspaceAgent}=await import('../electron/workspace/agent.ts'),root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-agent-pdf-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  t.after(async()=>{db.close();assert.ok(root.startsWith(os.tmpdir()+path.sep));await fs.rm(root,{recursive:true,force:true})})
  await fs.writeFile(path.join(root,'evidence.pdf'),textPdf());await fs.writeFile(path.join(root,'other.txt'),'不在本次范围')
  const docs=new DocumentLibrary(db),doc=await docs.register(path.join(root,'evidence.pdf')),other=await docs.register(path.join(root,'other.txt'))
  const results:string[]=[];const manager=createWorkspaceAgent({db,config:()=>({enabled:true,api_key:'fixture',api_url:'http://fixture.invalid',model:'fixture'}),run:async options=>{
    const tool=options.tools.find(t=>t.name==='read_document_text');assert.ok(tool,'需要正文读取工具')
    await assert.rejects(tool.execute({id:other.id}),/范围/)
    results.push(await tool.execute({id:doc.id}));return {stopReason:'done',text:'依据第 1 页',turns:1,tokens:0,error:''}
  }})
  const session=manager.create('document',{documentIds:[doc.id]});const finished=await manager.send(session.id,'解释这份资料的内容')
  assert.equal(finished.status,'idle',finished.error);assert.match(results[0],/Evidence belongs/);assert.equal(JSON.parse(results[0]).source.page,1)
})
