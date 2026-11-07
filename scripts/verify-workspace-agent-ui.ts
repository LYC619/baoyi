import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createServer} from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {_electron} from 'playwright'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {textPdf} from './helpers/pdf-fixture.ts'
const output=path.resolve('output/agent-revision');await fs.mkdir(output,{recursive:true});const profile=await fs.mkdtemp(path.join(output,'workspace-agent-ui-'))
let count=0,recordId='',documentId=''
let releaseDocumentReply!:()=>void
const documentReplyGate=new Promise<void>(resolve=>{releaseDocumentReply=resolve})
const server=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const body=JSON.parse(text);count++
  if(count===5)await documentReplyGate
  if(count===2)recordId=JSON.parse(body.messages.find((m:any)=>m.role==='tool').content).targetId
  const message=count===5?{role:'assistant',content:null,tool_calls:[{id:'read-pdf',type:'function',function:{name:'read_document_text',arguments:JSON.stringify({id:documentId})}}]}:count===1||count===3?{role:'assistant',content:null,tool_calls:[{id:'ui-'+count,type:'function',function:{name:'save_personal_record',arguments:JSON.stringify(count===1?{kind:'asset',name:'验收 VPS',body:'测试服务器',data:{cost:8,currency:'USD',cycle:'monthly',expiresOn:'2026-11-20'}}:{id:recordId,data:{cycle:'yearly'}})}}]}:{role:'assistant',content:count>=6?'已读取第 1 页的来源信息。':'已保存，可从结果卡编辑和撤销。'}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message}],usage:{total_tokens:1}}))
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false,ai:{enabled:true,api_key:'fixture',api_url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,model:'fixture'}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const pdfFile=path.join(profile,'来源验收.pdf');await fs.writeFile(pdfFile,textPdf());documentId=(await new DocumentLibrary(db).register(pdfFile)).id;db.close()
const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const launch=()=>_electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[path.resolve('.'),'--user-data-dir='+profile,'--disable-gpu'],env,timeout:30000})
let app=await launch(),page=await app.firstWindow();const errors:string[]=[],checks:string[]=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
try {
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile);await page.waitForFunction(()=>!!window.baoyi?.workspace)
  await page.evaluate(()=>{location.hash='/personal?section=asset'})
  await page.getByRole('button',{name:'个人助手',exact:true}).click()
  await page.getByLabel('给个人助手的消息',{exact:true}).fill('登记一个 VPS，每月 8 美元，2026 年 11 月 20 日到期')
  await page.getByRole('button',{name:'发送给助手',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.assistant-change')?.textContent?.includes('已保存'))
  assert.match(await page.locator('.asset-browser').innerText(),/验收 VPS/)
  await page.getByLabel('给个人助手的消息',{exact:true}).fill('改成每年');await page.getByRole('button',{name:'发送给助手',exact:true}).click()
  await page.waitForFunction(()=>document.querySelectorAll('.assistant-change').length===2)
  await page.waitForFunction(()=>document.querySelector('.asset-browser')?.textContent?.includes('每年'))
  checks.push('natural-language-create-and-followup-same-record')
  await page.screenshot({path:path.join(output,'personal-agent.png')})
  await app.close();app=await launch();page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>!!window.baoyi?.workspace)
  await page.evaluate(()=>{location.hash='/personal?section=asset'});await page.getByRole('button',{name:'个人助手',exact:true}).click();await page.locator('.assistant-change').nth(1).waitFor()
  await page.locator('.assistant-change').nth(1).getByRole('button',{name:'撤销',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.asset-browser')?.textContent?.includes('每月'))
  assert.equal((await page.evaluate(()=>window.baoyi.workspace.personal.list('asset'))).length,1)
  checks.push('restart-undo-keeps-record-identity')
  await page.evaluate(()=>{location.hash='/document'});await page.getByRole('button',{name:'资料助手',exact:true}).click();await page.getByLabel('给资料助手的消息',{exact:true}).fill('阅读这份 PDF，解释内容并注明来源页码。');await page.getByRole('button',{name:'发送给助手',exact:true}).click()
  await page.getByRole('button',{name:'资料助手 · 正在处理',exact:true}).waitFor()
  await page.getByRole('button',{name:'收起资料助手',exact:true}).click()
  assert.equal(await page.locator('.document-assistant-panel:visible').count(),0)
  assert.ok((await page.evaluate(()=>window.baoyi.workspace.agent.sessions('document'))).some(s=>s.status==='running'))
  releaseDocumentReply()
  await page.getByRole('button',{name:'资料助手',exact:true}).waitFor()
  await page.getByRole('button',{name:'资料助手',exact:true}).click()
  checks.push('document-assistant-collapse-retains-running-task')
  await page.waitForFunction(()=>document.querySelector('.assistant-output')?.textContent?.includes('已读取第 1 页'))
  assert.match(await page.locator('.assistant-output').textContent()||'',/Evidence belongs to a source page/)
  checks.push('bundled-pdf-agent-extracts-real-text')
  await page.locator('.assistant-source').first().click();await page.locator('.textLayer span').first().waitFor();assert.match(page.url(),new RegExp('/document/'+documentId))
  const span=await page.locator('.textLayer span').first().boundingBox();assert.ok(span);await page.mouse.move(span!.x+1,span!.y+span!.height/2);await page.mouse.down();await page.mouse.move(span!.x+span!.width-2,span!.y+span!.height/2,{steps:10});await page.mouse.up()
  await page.getByRole('button',{name:'询问助手',exact:true}).click();await page.getByRole('button',{name:'发送给助手',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.reader-assistant .assistant-output')?.textContent?.includes('已读取'))
  const selectionSessions=await page.evaluate(()=>window.baoyi.workspace.agent.sessions('document'));assert.ok(selectionSessions.some(s=>s.context.selection?.documentId===documentId&&s.context.selection.quote.includes('Evidence')))
  await page.locator('.reader-assistant .assistant-source').first().click();await page.waitForFunction(()=>document.querySelectorAll('.annotation-highlight.active').length>0)
  checks.push('actual-read-source-card-opens-page','reader-selection-agent-context-and-return-to-quote');assert.deepEqual(errors,[])
  await fs.writeFile(path.join(output,'workspace-agent-ui.json'),JSON.stringify({status:'passed',checks,errors,profile},null,2));console.log('PASS '+checks.join(', '))
}catch(error){await page.screenshot({path:path.join(output,'workspace-agent-ui-failure.png')}).catch(()=>{});throw error}
finally{releaseDocumentReply();await app.close();await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())})}
