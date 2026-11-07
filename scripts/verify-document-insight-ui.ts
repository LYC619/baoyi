import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {outlinePdf} from './helpers/pdf-fixture.ts'
const require=createRequire(import.meta.url),{_electron}=require('playwright')
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/p1-p2-document-2026-11-06/native-ui')
fs.mkdirSync(output,{recursive:true});const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=fs.mkdtempSync(path.join(output,'fixtures-'))
const pdf=path.join(fixture,'合成精读论文.pdf');fs.writeFileSync(pdf,outlinePdf(31,false))
const requests:any[]=[];let calls=0
const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'||!req.url?.endsWith('/chat/completions')){res.writeHead(404);res.end();return}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk)
  const body=JSON.parse(Buffer.concat(chunks).toString()),messages=body.messages;requests.push(body)
  const parsed=messages.filter((m:any)=>m.role==='tool').map((m:any)=>{try{return JSON.parse(m.content)}catch{return null}})
  const meta=parsed.find((value:any)=>value?.requestId),catalog=parsed.find((value:any)=>Array.isArray(value)),data=parsed.find((value:any)=>value?.fragments)
  let tool:any=null
  if(!meta)tool={name:'archive_get',arguments:'{}'}
  else if(!catalog)tool={name:'archive_catalog',arguments:'{}'}
  else if(!data)tool={name:'archive_read',arguments:'{}'}
  else if(!parsed.some((value:any)=>value?.accepted)){
    const part=data.fragments.find((value:any)=>value.page===31)||data.fragments.at(-1)
    tool={name:'archive_submit_insight',arguments:JSON.stringify({requestId:meta.requestId,sourceFingerprint:meta.sourceFingerprint,expectedRevision:meta.expectedRevision,coreValue:'本合成论文通过分章节的原文证据，帮助读者验证长文首尾精读与结果保存。',keyConclusions:[{text:'尾部章节的证据也被纳入精读',status:'supported',evidenceIds:['e1']},{text:null,status:'insufficient',evidenceIds:[]},{text:null,status:'insufficient',evidenceIds:[]}],suggestedCategoryId:'paper',suggestedTags:['合成精读'],evidence:[{id:'e1',sourceRef:part.id,quote:part.text.trim().slice(0,95)}],limitations:['中间页未读取']})}
  }
  const id='insight-fixture-'+(++calls),answer=tool?'':'精读已提交。'
  res.writeHead(200,{'Content-Type':body.stream?'text/event-stream':'application/json'})
  if(body.stream){const delta=tool?{tool_calls:[{index:0,id,type:'function',function:tool}]}:{content:answer};res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');res.end('data: '+JSON.stringify({id,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:200,completion_tokens:40,total_tokens:240}})+'\n\ndata: [DONE]\n\n')}
  else res.end(JSON.stringify({id,choices:[{index:0,message:{role:'assistant',content:answer,...(tool?{tool_calls:[{id,type:'function',function:tool}]}:{})},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:200,completion_tokens:40,total_tokens:240}}))
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value]of Object.entries({ai:{enabled:true,model:'fixture',api_url:`http://127.0.0.1:${port}/v1`,api_key:'synthetic-only'},onboarded:true,theme:'light',hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const item=await new DocumentLibrary(db).register(pdf,'book');db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
let app:any,page:any;const checks:string[]=[],errors:string[]=[]
async function open(){app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',(error:Error)=>errors.push(error.message));assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile);await page.waitForFunction(()=>!!window.baoyi?.archive?.insights)}
async function until(check:()=>Promise<boolean>,timeout=90000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await page.waitForTimeout(150)}throw new Error('UI condition timed out')}
async function check(name:string,action:()=>Promise<void>){await action();checks.push(name);console.log('PASS '+name)}
async function route(value:string){await page.evaluate((value:string)=>location.hash=value,value)}
const detail=()=>page.evaluate((id:string)=>window.baoyi.archive.insights.detail(id),item.id)
async function select(){await route('/document');await page.locator('.document-row').filter({hasText:'合成精读论文'}).first().click();await page.getByRole('region',{name:'资料精读速览'}).waitFor()}
try{
  await open();await select()
  await check('精读发送范围确认，真实worker首尾提取与原版Hermes限定工具完成保存',async()=>{
    await page.getByRole('region',{name:'资料精读速览'}).getByRole('button',{name:'精读归档',exact:true}).click();await page.getByRole('dialog',{name:'精读所选资料'}).waitFor();assert.equal(requests.length,0)
    await page.getByRole('button',{name:'确认并开始精读',exact:true}).click()
    await until(async()=>!!(await detail()).active)
    const state=await detail();assert.equal(state.active.coverage.strategy,'head-tail');assert.equal(state.active.coverage.pages.length,25);assert.equal(state.active.coverage.totalPages,31);assert.equal(state.active.evidence[0].page,31)
    assert.ok(requests.length>=4);assert.ok(!JSON.stringify(requests).includes(fixture.replaceAll('\\','\\\\')))
    assert.ok(requests.every(body=>body.tools.every((tool:any)=>['archive_get','archive_catalog','archive_read','archive_submit_insight'].includes(tool.function.name))))
    await page.getByRole('button',{name:'编辑并保存',exact:true}).waitFor();await page.screenshot({path:path.join(output,'insight-generated.png')})
  })
  await check('人工修订、显式采用分类标签与撤销；精要视图和日志可见',async()=>{
    const panel=page.getByRole('region',{name:'资料精读速览'})
    await panel.getByRole('button',{name:'编辑并保存'}).click();await page.getByLabel('编辑核心价值').fill('这是用户保留的人工修订内容，需要在重新生成之后继续保持当前版本。');await page.getByRole('button',{name:'保存修订',exact:true}).click();await until(async()=>(await detail()).active.userEdited)
    await panel.getByRole('button',{name:'采用分类与标签',exact:true}).click();await panel.getByRole('button',{name:'撤销采用',exact:true}).waitFor()
    let doc=await page.evaluate((id:string)=>window.baoyi.workspace.documents.get(id),item.id);assert.equal(doc.type,'paper');assert.ok(doc.tags.includes('合成精读'));assert.equal(doc.readState,'unread')
    await panel.getByRole('button',{name:'撤销采用',exact:true}).click();await until(async()=>(await page.evaluate((id:string)=>window.baoyi.workspace.documents.get(id),item.id)).type==='book')
    await page.getByRole('button',{name:'精要视图',exact:true}).click();assert.ok(await page.locator('.insight-summary ol').first().isVisible())
    await page.getByRole('button',{name:/^资料日志：/}).click();await page.getByRole('region',{name:'资料精读任务'}).waitFor();await page.keyboard.press('Escape')
  })
  await check('重新生成不覆盖人工版本；精读证据能跳到尾页原文',async()=>{
    const panel=page.getByRole('region',{name:'资料精读速览'});await panel.getByRole('button',{name:'重新精读',exact:true}).click();await page.getByLabel('来源未变化也重新生成').check();await page.getByRole('button',{name:'确认并开始精读',exact:true}).click()
    await until(async()=>{const state=await detail();return state.history.length===3&&state.run.status==='ready'})
    assert.equal((await detail()).active.userEdited,true)
    await panel.getByText('原文证据与覆盖范围',{exact:true}).click();await panel.locator('.insight-quote').first().click();await until(()=>page.evaluate(()=>location.hash.includes('insight=')))
    await until(()=>page.locator('.pdf-page').count().then((n:number)=>n>0));await page.screenshot({path:path.join(output,'evidence-reader.png')});await select()
  })
  await check('800与1360内容宽度、暗色无横向溢出；冷启动保留精读版本',async()=>{
    for(const width of [800,1360]){await app.evaluate(({BrowserWindow}:any,width:number)=>{const win=BrowserWindow.getAllWindows()[0];win.setMinimumSize(640,600);win.setContentSize(width,900)},width);await page.waitForTimeout(250);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));await page.screenshot({path:path.join(output,`insight-${width}.png`)})}
    await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));await page.screenshot({path:path.join(output,'insight-dark.png')})
    await app.close();await open();await select();assert.equal((await detail()).active.userEdited,true);assert.equal((await detail()).history.length,3)
  })
  await check('指定中间页精读生成独立版本；清理数量确认保留人工修订',async()=>{
    await page.getByRole('region',{name:'资料精读速览'}).getByRole('button',{name:'重新精读',exact:true}).click()
    await page.getByText('指定范围继续精读',{exact:true}).click();await page.getByLabel('本次使用指定范围').check()
    await page.getByLabel('精读起始页').fill('16');await page.getByLabel('精读结束页').fill('20');await page.getByRole('button',{name:'确认并开始精读',exact:true}).click()
    await until(async()=>{const state=await detail();return state.history.length===4&&state.run.status==='ready'})
    assert.deepEqual((await detail()).history[0].coverage.pages,[16,17,18,19,20]);assert.equal((await detail()).active.userEdited,true)
    await route('/settings?module=document&tab=scan');await page.locator('.insight-settings>summary').click()
    await page.getByText('精读数据维护',{exact:true}).click();await page.getByRole('button',{name:'预览生成稿清理',exact:true}).click()
    await page.getByRole('button',{name:'确认删除生成稿',exact:true}).click();await until(async()=>(await detail()).history.length===1)
    assert.equal((await detail()).active.userEdited,true)
  })
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:checks.length,checks,errors,profile,fixture,packaged:!!packed,requests:requests.length},null,2))
}catch(error){if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:(error as Error).stack},null,2));throw error}
finally{if(app){await page?.evaluate(async()=>{for(const run of await window.baoyi.archive.insights.list())if(['running','queued'].includes(run.status))await window.baoyi.archive.insights.cancel(run.id)}).catch(()=>{});await app.evaluate(({BrowserWindow}:any)=>{for(const window of BrowserWindow.getAllWindows())window.destroy()}).catch(()=>{});await app.close().catch(()=>{})}server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
