import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'

const require=createRequire(import.meta.url),{_electron}=require('playwright')
const packed=process.argv[2]||'',output=path.resolve(process.argv[3]||'output/archive-assistant-2026-11-05/native-ui')
fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=fs.mkdtempSync(path.join(output,'fixtures-'))
const inputFile=path.join(fixture,'青松桥验收.md');fs.writeFileSync(inputFile,'# 青松桥验收资料\n隔离验收口令：白鹭 42。\n原文依据来自测试文件。\n')
let docId='',calls=0,hold=false,steering=false
const requests:any[]=[]
const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'||!req.url?.includes('chat/completions')){res.writeHead(404);res.end();return}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk)
  const body=JSON.parse(Buffer.concat(chunks).toString()),messages=body.messages
  requests.push({model:body.model,stream:body.stream,tools:body.tools?.map((t:any)=>t.function.name)})
  const lastUser=messages.findLastIndex((m:any)=>m.role==='user'),prompt=String(messages[lastUser]?.content||'')
  const results=messages.slice(lastUser+1).filter((m:any)=>m.role==='tool')
  const parsed=results.map((r:any)=>{try{return JSON.parse(r.content)}catch{return null}})
  let tool:any=null,answer=''
  if(prompt.includes('取消测试')){hold=true;await new Promise(resolve=>setTimeout(resolve,10000));answer='取消测试延迟响应'}
  else if(prompt.includes('补充验收口令'))answer='已按补充要求处理：杉木海鸥。'
  else if(prompt.includes('补充测试')){steering=true;await new Promise(resolve=>setTimeout(resolve,6000));answer='准备接收补充。'}
  else if(prompt.includes('软件保存验收')){
    const detail=parsed.find((r:any)=>r?.metadata)
    if(!detail)tool={name:'archive_get',arguments:JSON.stringify({id:'fixture-software'})}
    else if(!parsed.some((r:any)=>typeof r?.changed==='number'))tool={name:'archive_update',arguments:JSON.stringify({changes:[{id:'fixture-software',version:detail.version,patch:{name:'已核验软件',category:'开发工具',notes:'软件保存验收通过',tags:['验收']}}],reason:'隔离软件保存验收'})}
    else answer='软件保存验收已完成。'
  }
  else if(prompt.includes('记住偏好')){
    if(!results.length)tool={name:'memory',arguments:JSON.stringify({action:'add',target:'user',content:'归档保留所有不同版本。'})}
    else answer='已记住：归档保留所有不同版本。'
  }else if(prompt.includes('续接')||prompt.includes('继续上次任务'))answer='我保留了此前的青松桥归档历史和工具结果。'
  else if(!results.length)tool={name:'archive_search',arguments:JSON.stringify({query:'青松桥'})}
  else if(!parsed.some((r:any)=>r?.metadata))tool={name:'archive_get',arguments:JSON.stringify({id:docId})}
  else if(!parsed.some((r:any)=>r?.text?.includes('白鹭')))tool={name:'archive_read',arguments:JSON.stringify({id:docId})}
  else if(!parsed.some((r:any)=>typeof r?.changed==='number')){
    const detail=parsed.find((r:any)=>r?.metadata);tool={name:'archive_update',arguments:JSON.stringify({changes:[{id:docId,version:detail.version,patch:{notes:'已核验：白鹭 42',tags:['已核验']}}],reason:'用户要求核验并补充归档备注'})}
  }else answer=`已核验并保存 1 份资料。[青松桥验收资料](baoyi://resource/${docId}) 的原文口令是 **白鹭 42**。备注与标签已保存，可在修改记录中撤销。`
  const id='fixture-'+(++calls)
  res.writeHead(200,{'Content-Type':body.stream?'text/event-stream':'application/json'})
  if(body.stream){
    const deltas=tool?[{tool_calls:[{index:0,id,type:'function',function:tool}]}]:[...answer.matchAll(/.{1,12}/gs)].map(x=>({content:x[0]}))
    for(const delta of deltas){if(res.destroyed)break;res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');await new Promise(r=>setTimeout(r,12))}
    res.end('data: '+JSON.stringify({id,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:200,completion_tokens:40,total_tokens:240}})+'\n\ndata: [DONE]\n\n')
  }else res.end(JSON.stringify({id,choices:[{index:0,message:{role:'assistant',content:answer,...(tool?{tool_calls:[{id,type:'function',function:tool}]}:{})},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:200,completion_tokens:40,total_tokens:240}}))
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const port=(server.address() as any).port,db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const[key,value]of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false,hide_hentai:true,ai:{enabled:true,api_url:`http://127.0.0.1:${port}/v1`,api_key:'isolated-only',model:'baoyi-fixture'}}))db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value))
docId=(await new DocumentLibrary(db).register(inputFile,'paper')).id
db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,name_zh,name_en,category) VALUES('fixture-software','software',1,1,?,'fixture.exe','','Fixture Software','其他')").run(path.join(fixture,'fixture.exe'))
db.prepare("INSERT INTO software_meta(resource_id) VALUES('fixture-software')").run();db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
let app:any,page:any;const checks:string[]=[],errors:string[]=[]
async function open(){console.log('Launching isolated Electron: '+profile);app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env,timeout:60000});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',(e:Error)=>errors.push(e.message));await page.waitForFunction(()=>!!(window as any).baoyi?.archive);assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile)}
async function check(name:string,fn:()=>Promise<void>){console.log('RUN '+name);await fn();checks.push(name);console.log('PASS '+name)}
const panel=()=>page.getByLabel('归档助理',{exact:true}).filter({has:page.locator('.panel-top')})
async function until(check:()=>Promise<boolean>,timeout=120000){const start=Date.now();while(!await check()){if(Date.now()-start>timeout)throw new Error('等待原生异步状态超时');await new Promise(resolve=>setTimeout(resolve,100))}}
async function finished(){await until(()=>page.evaluate(async()=>!(await(window as any).baoyi.archive.status()).active));await page.locator('.working').waitFor({state:'hidden',timeout:120000})}
try{
  await open()
  await check('global assistant opens and remains across module navigation',async()=>{
    await page.getByRole('button',{name:'归档助理',exact:true}).click();await page.getByRole('heading',{name:'想找什么， 或整理些什么？'}).waitFor()
    await page.evaluate(()=>{location.hash='/personal'});assert.equal(await panel().isVisible(),true)
    await page.screenshot({path:path.join(output,'welcome-light.png')})
  })
  await check('real Hermes invokes library tools, streams, saves notes and renders clickable source',async()=>{
    await page.getByLabel('给归档助理发消息').fill('查找青松桥资料，核验原文口令并保存备注和标签。')
    await page.getByRole('button',{name:'发送消息',exact:true}).click()
    await page.getByText('白鹭 42',{exact:false}).last().waitFor({timeout:120000});await finished()
    const doc=await page.evaluate((id:string)=>(window as any).baoyi.workspace.documents.get(id),docId)
    assert.equal(doc.notes,'已核验：白鹭 42');assert.ok(doc.tags.includes('已核验'))
    await page.locator('.prose a').filter({hasText:'青松桥验收资料'}).click();await page.waitForFunction((id:string)=>location.hash.includes(id),docId)
    await page.locator('.reader-body').getByText('隔离验收口令：白鹭 42。',{exact:false}).waitFor()
    await page.screenshot({path:path.join(output,'conversation-light.png')})
  })
  await check('audit undo changes real library and history is recoverable',async()=>{
    if(!await panel().isVisible())await page.getByRole('button',{name:'归档助理',exact:true}).click()
    await panel().getByRole('button',{name:'修改记录',exact:true}).click()
    await page.getByRole('button',{name:'撤销这次修改',exact:true}).click();await page.getByRole('button',{name:'已撤销',exact:true}).waitFor()
    assert.equal((await page.evaluate((id:string)=>(window as any).baoyi.workspace.documents.get(id),docId)).notes,'')
    await panel().getByRole('button',{name:'历史对话',exact:true}).click();await page.locator('.session-title').first().click()
    await page.locator('.prose a').first().waitFor()
  })
  await check('new conversation clears an in-flight history load without restoring the old selection',async()=>{
    await panel().getByRole('button',{name:'历史对话',exact:true}).click()
    await app.evaluate(({ipcMain}:any)=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get('archive:session');(globalThis as any).__historyOriginal=original;handlers.set('archive:session',async(...args:any[])=>{const result=await original(...args);await new Promise(resolve=>{(globalThis as any).__releaseHistory=resolve});return result})})
    await page.locator('.session-title').first().click()
    await page.getByText('正在读取对话…',{exact:true}).waitFor()
    await panel().getByRole('button',{name:'新对话',exact:true}).click()
    await page.getByText('正在读取对话…',{exact:true}).waitFor({state:'hidden'})
    await page.getByRole('heading',{name:'想找什么， 或整理些什么？'}).waitFor()
    await app.evaluate(()=>(globalThis as any).__releaseHistory())
    await page.waitForTimeout(150)
    assert.equal(await panel().locator('.archive-message').count(),0)
    await app.evaluate(({ipcMain}:any)=>(ipcMain as any)._invokeHandlers.set('archive:session',(globalThis as any).__historyOriginal))
    await panel().getByRole('button',{name:'历史对话',exact:true}).click();await page.locator('.session-title').first().click();await page.locator('.prose a').first().waitFor()
  })
  await check('native memory UI persists and edits preferences',async()=>{
    await panel().getByRole('button',{name:'记忆',exact:true}).click();await page.getByLabel('记忆内容').fill('归档时保留所有不同版本。')
    await page.getByRole('button',{name:'保存记忆',exact:true}).click();await page.locator('.memory-entry').filter({hasText:'不同版本'}).waitFor()
    const memory=await page.evaluate(()=>(window as any).baoyi.archive.memory());assert.ok(memory.user.some((x:string)=>x.includes('不同版本')))
  })
  await check('stop cancels active model request and enables continuation',async()=>{
    await panel().getByRole('button',{name:'对话',exact:true}).click();await page.getByLabel('给归档助理发消息').fill('取消测试')
    await page.getByRole('button',{name:'发送消息',exact:true}).click()
    const start=Date.now();while(!hold&&Date.now()-start<30000)await new Promise(r=>setTimeout(r,100))
    assert.ok(hold);await page.getByRole('button',{name:'停止任务',exact:true}).click();await finished()
    await page.getByRole('button',{name:'继续处理',exact:true}).waitFor()
  })
  await check('dark theme and compact window keep composer reachable',async()=>{
    await page.evaluate(async()=>{await(window as any).baoyi.settings.patch({theme:'dark'});document.documentElement.dataset.theme='dark'})
    await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(960,760))
    const box=await page.getByLabel('给归档助理发消息').boundingBox();assert.ok(box&&box.y+box.height<=760)
    await page.screenshot({path:path.join(output,'conversation-dark-960.png')})
  })
  const state=await page.evaluate(()=>(window as any).baoyi.archive.sessions()),session=state[0].id
  await app.close();app=null
  await check('cold restart keeps original conversation and native memory',async()=>{
    await open();await page.getByRole('button',{name:'归档助理',exact:true}).click();await page.getByRole('button',{name:'历史对话',exact:true}).click();await page.locator('.session-title').first().click()
    assert.ok((await page.evaluate((id:string)=>(window as any).baoyi.archive.session(id),session)).messages.some((m:any)=>m.role==='tool'&&String(m.content).includes('白鹭')))
    assert.ok((await page.evaluate(()=>(window as any).baoyi.archive.memory())).user.some((x:string)=>x.includes('不同版本')))
    await page.getByRole('button',{name:'继续处理',exact:true}).waitFor()
    await page.getByRole('button',{name:'继续处理',exact:true}).click();await finished()
    assert.equal((await page.evaluate((id:string)=>(window as any).baoyi.archive.session(id),session)).lastRun.status,'completed')
  })
  await check('native steering accepts an instruction during an active response',async()=>{
    await page.getByLabel('给归档助理发消息').fill('补充测试');await page.getByRole('button',{name:'发送消息',exact:true}).click()
    const start=Date.now();while(!steering&&Date.now()-start<30000)await new Promise(r=>setTimeout(r,100))
    assert.ok(steering);await page.getByLabel('给归档助理发消息').fill('补充验收口令：杉木海鸥')
    await page.getByRole('button',{name:'补充要求',exact:true}).click();await finished()
    const state=await page.evaluate((id:string)=>(window as any).baoyi.archive.session(id),session)
    assert.ok(state.messages.some((m:any)=>m.role==='assistant'&&String(m.content).includes('杉木海鸥')))
  })
  await check('privacy switch clears cached memory before the next scope loads',async()=>{
    await page.getByRole('button',{name:'收起归档助理',exact:true}).click()
    await page.evaluate(()=>{location.hash='/settings?scope=module&module=video&tab=hentai'})
    const privacy=page.locator('section.panel').filter({has:page.getByRole('heading',{name:'隐藏里番',exact:true})}).getByRole('checkbox')
    await privacy.uncheck();await page.getByText('里番已恢复显示',{exact:true}).waitFor();await until(()=>page.evaluate(async()=>!(await(window as any).baoyi.settings.getAll()).hide_hentai))
    await page.evaluate(()=>(window as any).baoyi.archive.editMemory({target:'user',action:'add',content:'完整范围的隔离私人偏好。'}))
    await page.getByRole('button',{name:'归档助理',exact:true}).click();await panel().getByRole('button',{name:'记忆',exact:true}).click()
    await page.locator('.memory-entry').filter({hasText:'私人偏好'}).waitFor()
    await page.getByRole('button',{name:'收起归档助理',exact:true}).click();await privacy.check();await page.getByText('里番已隐藏',{exact:true}).waitFor()
    await until(()=>page.evaluate(async()=>(await(window as any).baoyi.settings.getAll()).hide_hentai))
    await page.getByRole('button',{name:'归档助理',exact:true}).click()
    await app.evaluate(({ipcMain}:any)=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get('archive:memory');(globalThis as any).__memoryOriginal=original;handlers.set('archive:memory',async(...args:any[])=>{await new Promise(resolve=>setTimeout(resolve,1500));return original(...args)})})
    await panel().getByRole('button',{name:'记忆',exact:true}).click()
    assert.equal(await page.locator('.memory-entry').filter({hasText:'私人偏好'}).count(),0)
    await page.locator('.memory-entry').filter({hasText:'不同版本'}).waitFor()
    await app.evaluate(({ipcMain}:any)=>(ipcMain as any)._invokeHandlers.set('archive:memory',(globalThis as any).__memoryOriginal))
    assert.equal((await page.evaluate(()=>(window as any).baoyi.archive.sessions())).length,1)
  })
  await check('JSON backup restores Hermes conversations and memory alongside the library',async()=>{
    const backup=path.join(profile,'assistant-backup.json')
    await app.evaluate(({dialog}:any,file:string)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},backup)
    await page.evaluate(()=>(window as any).baoyi.data.exportJson())
    const value=JSON.parse(fs.readFileSync(backup,'utf8'));assert.equal(value.assistant.format,'baoyi-hermes-state')
    await page.evaluate(async(id:string)=>{await(window as any).baoyi.workspace.documents.update(id,{notes:'恢复前的临时内容'});await(window as any).baoyi.archive.editMemory({target:'user',action:'add',content:'不应进入备份的后续记忆'})},docId)
    await app.evaluate(({dialog,app}:any,file:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1});app.relaunch=()=>{};app.exit=()=>{}},backup)
    const restored=await page.evaluate(()=>(window as any).baoyi.data.restoreJson());assert.ok(fs.existsSync(restored.backupPath))
    await app.close();app=null;await open()
    assert.equal((await page.evaluate((id:string)=>(window as any).baoyi.workspace.documents.get(id),docId)).notes,'')
    const memory=await page.evaluate(()=>(window as any).baoyi.archive.memory());assert.ok(!JSON.stringify(memory).includes('不应进入备份'))
    assert.ok((await page.evaluate((id:string)=>(window as any).baoyi.archive.session(id),session)).messages.length>0)
    assert.ok(fs.readdirSync(path.join(profile,'recovery')).some(name=>name.startsWith('archive-assistant-')))
  })
  await check('failed restore rolls back both assistant files and library metadata',async()=>{
    const backup=path.join(profile,'assistant-backup.json')
    await page.evaluate(async(id:string)=>{await(window as any).baoyi.workspace.documents.update(id,{notes:'失败恢复必须保留'});await(window as any).baoyi.archive.editMemory({target:'user',action:'add',content:'失败回滚后仍在的记忆'})},docId)
    await app.evaluate(({dialog}:any,file:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=()=>new Promise(resolve=>{(globalThis as any).__finishRestoreConfirmation=resolve})},backup)
    const restoring=page.evaluate(async()=>{try{await(window as any).baoyi.data.restoreJson();return ''}catch(e){return String(e)}})
    await app.evaluate(async()=>{const started=Date.now();while(!(globalThis as any).__finishRestoreConfirmation&&Date.now()-started<15000)await new Promise(resolve=>setTimeout(resolve,20));if(!(globalThis as any).__finishRestoreConfirmation)throw new Error('没有进入恢复确认')})
    // Add a schema conflict after preview, so commit fails after assistant files were swapped.
    const connection=new DatabaseSync(path.join(profile,'baoyi.db'))
    try{
      connection.exec("CREATE TRIGGER isolated_restore_conflict BEFORE INSERT ON resource BEGIN SELECT RAISE(ABORT,'isolated restore failure'); END")
      await app.evaluate(()=>(globalThis as any).__finishRestoreConfirmation({response:1}))
      assert.match(await restoring,/trigger/)
    }finally{connection.exec('DROP TRIGGER IF EXISTS isolated_restore_conflict');connection.close()}
    assert.equal((await page.evaluate((id:string)=>(window as any).baoyi.workspace.documents.get(id),docId)).notes,'失败恢复必须保留')
    assert.match(JSON.stringify(await page.evaluate(()=>(window as any).baoyi.archive.memory())),/失败回滚后仍在/)
    assert.ok((await page.evaluate((id:string)=>(window as any).baoyi.archive.session(id),session)).messages.length>0)
    assert.ok(!fs.readdirSync(profile).some(name=>name.startsWith('archive-assistant-restore-')))
  })
  await check('legacy backup starts fresh assistant state and preserves the previous state in recovery',async()=>{
    const original=path.join(profile,'assistant-backup.json'),backup=path.join(profile,'legacy-backup.json'),value=JSON.parse(fs.readFileSync(original,'utf8'));delete value.assistant
    value.tables.archive_actions=[];value.tables.archive_runs=[];fs.writeFileSync(backup,JSON.stringify(value))
    await app.evaluate(({dialog,app}:any,file:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1});app.relaunch=()=>{};app.exit=()=>{}},backup)
    await page.evaluate(()=>(window as any).baoyi.data.restoreJson());await app.close();app=null;await open()
    assert.deepEqual(await page.evaluate(()=>(window as any).baoyi.archive.sessions()),[])
    assert.deepEqual((await page.evaluate(()=>(window as any).baoyi.archive.memory())).user,[])
    assert.ok(fs.readdirSync(path.join(profile,'recovery')).filter(name=>name.startsWith('archive-assistant-')).length>=2)
    const skills=await page.evaluate(()=>(window as any).baoyi.archive.skills());assert.match(JSON.stringify(skills),/baoyi-archive/)
  })
  await check('software metadata adapter saves actual fields and restores them on undo',async()=>{
    const before=await page.evaluate(()=>(window as any).baoyi.software.get('fixture-software'))
    const run=await page.evaluate(()=>(window as any).baoyi.archive.send({text:'软件保存验收'}))
    await finished()
    assert.equal((await page.evaluate((id:string)=>(window as any).baoyi.archive.session(id),run.sessionId)).lastRun.status,'completed')
    const after=await page.evaluate(()=>(window as any).baoyi.software.get('fixture-software'))
    assert.equal(after.name_zh,'已核验软件');assert.equal(after.category,'开发工具');assert.equal(after.notes,'软件保存验收通过')
    const actions=await page.evaluate(()=>(window as any).baoyi.archive.actions())
    assert.equal(actions.length,1);assert.equal(actions[0].after._protection.category_locked,1);await page.evaluate((id:string)=>(window as any).baoyi.archive.undo(id),actions[0].id)
    const restored=await page.evaluate(()=>(window as any).baoyi.software.get('fixture-software'))
    for(const key of ['name_zh','category','notes','tags'])assert.deepEqual(restored[key],before[key])
    const connection=new DatabaseSync(path.join(profile,'baoyi.db'),{readOnly:true})
    try{assert.equal((connection.prepare("SELECT category_locked FROM software_meta WHERE resource_id='fixture-software'").get() as any).category_locked,0)}finally{connection.close()}
  })
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({status:'passed',checks,profile,fixture,requests,errors},null,2))
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:path.join(output,'failure.png')});fs.writeFileSync(path.join(output,'failure-dom.txt'),await page.locator('body').innerText())}throw error}finally{if(app)await app.close();server.close();server.closeAllConnections();fs.writeFileSync(path.join(output,'progress.json'),JSON.stringify({checks,errors,profile,requests},null,2))}
