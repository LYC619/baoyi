import test from 'node:test'
import assert from 'node:assert/strict'
import * as context from '../electron/services/agent/context.ts'
import type {ProjectMessage} from '../src/types/project.ts'
import {runAgent} from '../electron/services/agent/loop.ts'
import {createServer} from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {createProjectAgent} from '../electron/kinds/project/agent.ts'
import {buildLibraryBackup,restoreLibraryBackup} from '../electron/services/library-backup.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'

test(`project 持久调用接入预算、固定历史快照和检查点，重启后可恢复原文`,async t=>{
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL);t.after(()=>db.close())
  const config=()=>({enabled:true,api_key:'fixture',api_url:'http://fixture.invalid',model:'fixture'})
  let options:any
  const run:typeof runAgent=async o=>{options=o;return {stopReason:'max_turns',error:'已达到本次上下文预算，原始工具结果已保留；可从检查点继续。',turns:1,tokens:0,text:''}}
  const manager=createProjectAgent({db,config,run})
  const project=new ProjectLibrary(db).register({path:process.cwd(),name:'上下文样本',summary:'',category:'软件项目',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]})
  const session=manager.create(project.id)
  session.messages=Array.from({length:40},(_,i)=>message('m'+i,'证据'+i+'"\\'.repeat(15000)))
  const original=JSON.stringify(session.messages[0])
  const table='project_sessions'
  db.prepare(`UPDATE ${table} SET payload=? WHERE id=?`).run(JSON.stringify(session),session.id)
  const result=await manager.send(session.id,'继续')
  assert.ok(options.maxContextChars>48000&&options.maxContextChars<=200000,'实际持久调用必须启用上下文预算')
  assert.match(result.error,/上下文.*预算/,'调用方不能把预算暂停误报成轮数上限')
  assert.equal(result.contextCheckpoint?.through,28)
  assert.ok(JSON.stringify(options.history).length<40000)
  const tool=options.tools.find((x:any)=>x.name==='read_session_history')
  let cursor:any,joined=''
  do {const page=JSON.parse(await tool.execute(cursor?{cursor}:{message:0}));joined+=page.text;assert.equal(page.total,40);cursor=page.next?.message===0?page.next:null}while(cursor)
  assert.equal(joined,original)
  const reopened=createProjectAgent({db,config,run})
  assert.deepEqual(reopened.get(session.id)?.contextCheckpoint,result.contextCheckpoint)
  assert.equal(reopened.get(session.id)?.messages[0].text,session.messages[0].text)
  const backup=buildLibraryBackup(db),target=new DatabaseSync(':memory:');initSchema(target,KINDS);target.exec(VIDEO_JOBS_SQL);t.after(()=>target.close())
  restoreLibraryBackup(target,backup)
  const restored=JSON.parse((target.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(session.id) as {payload:string}).payload)
  assert.deepEqual(restored.contextCheckpoint,result.contextCheckpoint)
  assert.deepEqual(restored.messages,result.messages)
  const invalid=structuredClone(backup),rows=invalid.tables[table];const payload=JSON.parse(rows[0].payload as string);payload.contextCheckpoint.through=-1;rows[0].payload=JSON.stringify(payload)
  assert.throws(()=>restoreLibraryBackup(target,invalid),/checkpoint/i)
})

const message=(id:string,text:string):ProjectMessage=>({id,role:'assistant',text,createdAt:1,events:[]})
test('长会话以有来源的索引和显式摘录保持总预算，原始消息不变',()=>{
  const messages=Array.from({length:104},(_,i)=>({...message('m'+i,'答复 '+i+'证据'.repeat(16000)),events:[{label:'read_project_history 结果',detail:JSON.stringify({head:'a'.repeat(40),next:{head:'a'.repeat(40),offset:i+1},commits:[]})}]}))
  const before=JSON.stringify(messages),result=context.conversationContext(messages,30)
  assert.ok(JSON.stringify(result.history).length+result.archive.length<=48000,'上下文总大小必须有界，而不是每条消息各裁 22000 字')
  assert.match(result.archive,/消息 0/)
  assert.match(JSON.stringify(result.history),/摘录|省略/,'省略必须明确告知，并给出可回读来源')
  assert.equal(JSON.stringify(messages),before)
  assert.ok(result.checkpoint)
  assert.equal(result.checkpoint.through,74)
  assert.equal(result.checkpoint.lastMessageId,'m73')
  assert.match(result.checkpoint.digest,/^[a-f0-9]{64}$/)
  assert.equal(context.conversationContext(messages,30).checkpoint.digest,result.checkpoint.digest)
})
test('历史工具按 JSON 编码后预算分页，超长旧结果逐字可恢复且不递归读取自身',async()=>{
  assert.equal(typeof context.createConversationHistoryTool,'function','需要共享的可续读历史工具')
  const messages=[message('m0','开头'+('"\\\n\t').repeat(18000)+'尾部关键证据')]
  const tool=context.createConversationHistoryTool('read_session_history',messages)
  const original=JSON.stringify(messages[0]);messages[0].events.push({label:'read_session_history 结果',detail:'调用后的新结果不能进入同一快照'})
  let cursor:any=undefined,joined='',pages=0
  do{
    const raw=await tool.execute(cursor?{cursor}:{query:'尾部关键证据'})
    assert.ok(raw.length<=tool.maxOutput!,'不能在模型请求阶段再次裁坏 JSON')
    const page=JSON.parse(raw);joined+=page.text;cursor=page.next;pages++
    if(cursor)assert.ok(cursor.start>0)
    assert.ok(pages<200)
  }while(cursor)
  assert.equal(joined,original);assert.ok(pages>2)
  await assert.rejects(tool.execute({message:0,start:-1}),/位置/)
  await assert.rejects(tool.execute({cursor:{message:0,start:1,stamp:'changed'}}),/变化|失效/)
})
test('运行中达到上下文预算先暂停，已执行结果原样保留而非静默裁掉',async t=>{
  let calls=0
  const server=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'one',type:'function',function:{name:'read',arguments:'{}'}}]}}]}))})
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r())}))
  const events:any[]=[]
  const result=await runAgent({config:{enabled:true,api_key:'fixture',api_url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,model:'fixture'},system:'test',user:'read',maxTurns:2,maxContextChars:1000,
    tools:[{name:'read',description:'read',parameters:{type:'object'},execute:async()=>'完整证据'.repeat(1000),maxOutput:6000}],onEvent:e=>events.push(e)})
  assert.equal(result.stopReason,'max_turns');assert.match(result.error,/上下文.*预算/);assert.equal(calls,1)
  assert.equal(events.find(e=>e.type==='tool_result').text,'完整证据'.repeat(1000))
})

test('项目持久层保存完整模型答复和工具参数，预算只限制回传上下文',async t=>{
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS);t.after(()=>db.close())
  const project=new ProjectLibrary(db).register({path:process.cwd(),name:'完整原文',summary:'',category:'软件项目',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]})
  const text='答复原文'.repeat(7000),args={evidence:'参数原文'.repeat(2000)}
  const manager=createProjectAgent({db,config:()=>({enabled:true,api_key:'fixture',api_url:'http://fixture.invalid',model:'fixture'}),run:async options=>{
    options.onEvent?.({type:'text',text});options.onEvent?.({type:'tool_call',name:'fixture',args})
    return {stopReason:'done',text,error:'',turns:1,tokens:0}
  }})
  const session=manager.create(project.id);await manager.send(session.id,'读取')
  const answer=manager.get(session.id)!.messages.at(-1)!
  assert.equal(answer.text.length,text.length)
  assert.equal(answer.events[0].detail,JSON.stringify(args))
})

test('真实 HTTP 在历史分页后失败，重启沿原游标续读且原始结果保留',async t=>{
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS);t.after(()=>db.close())
  const project=new ProjectLibrary(db).register({path:process.cwd(),name:'失败续读',summary:'',category:'软件项目',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]})
  let count=0,cursor:any,first='',joined=''
  const server=createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);count++
    const last=body.messages.at(-1)
    if(last.role==='tool'){const page=JSON.parse(last.content);joined+=page.text;cursor=page.next;if(count===2)first=page.text}
    if(count===2){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'fixture interruption'}}));return}
    const next=count===1?{message:0}:cursor
    const message=next?.message===0?{role:'assistant',content:null,tool_calls:[{id:'page-'+count,type:'function',function:{name:'read_session_history',arguments:JSON.stringify(count===1?next:{cursor:next})}}]}:{role:'assistant',content:'完整读取结束'}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message}]}))
  })
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r())}))
  const config=()=>({enabled:true,api_key:'fixture',api_url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,model:'fixture'})
  const manager=createProjectAgent({db,config}),session=manager.create(project.id)
  session.messages=[message('old','旧证据'+('"\\\n').repeat(3000)+'末尾证据')]
  const original=JSON.stringify(session.messages[0]);db.prepare('UPDATE project_sessions SET payload=? WHERE id=?').run(JSON.stringify(session),session.id)
  const failed=await manager.send(session.id,'读取旧证据');assert.equal(failed.status,'failed');assert.equal(count,2);assert.match(failed.error,/400/)
  assert.ok(first.length>0&&cursor.start>0);assert.equal(failed.messages.at(-1)?.events.filter(e=>e.label==='read_session_history 结果').length,1)
  const reopened=createProjectAgent({db,config});const resumed=await reopened.send(session.id,'从上次页尾继续')
  assert.equal(resumed.status,'idle',resumed.error);assert.equal(joined,original)
  assert.equal(resumed.messages[0].text,session.messages[0].text);assert.ok(resumed.contextCheckpoint)
})
