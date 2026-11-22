import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {PersonalLibrary} from '../electron/workspace/personal.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {inspectProject} from '../electron/kinds/project/scanner.ts'
import {DEFAULT_MODULE_PREFERENCES} from '../src/types/workspace.ts'

const require=createRequire(import.meta.url),{_electron}=require('playwright')
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/review-fixes-2026-11-04/native-ui')
fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=fs.mkdtempSync(path.join(output,'fixtures-'))
const alpha=path.join(fixture,'甲项目'),beta=path.join(fixture,'乙项目')
for(const dir of [alpha,beta]){fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'README.md'),'# Review fixes isolated fixture\nNo commands executed.\n')}
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false,_module_preferences_personal:{...DEFAULT_MODULE_PREFERENCES,showCompleted:false}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const personal=new PersonalLibrary(db),projects=new ProjectLibrary(db)
for(const [name,done] of [['未完成样例',false],['已完成样例',true]] as const)personal.save({kind:'todo',name,body:'isolated',data:{done,dueOn:'2026-11-04'}})
const metricId=personal.save({kind:'metric',name:'无单位评分',body:'旧格式，无 unit 字段',data:{}}).id
const existing=personal.save({kind:'measurement',name:'旧评分',body:'保留原记录',data:{metricId,value:6,date:'2026-11-03'}})
const documentFile=path.join(fixture,'清理后阅读样例.txt');fs.writeFileSync(documentFile,'第一章\n旧助手清理后仍可阅读的正文。')
const documentItem=await new DocumentLibrary(db).register(documentFile,'novel')
const a=projects.register(await inspectProject(alpha)),b=projects.register(await inspectProject(beta));db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
let app:any,page:any;const checks:string[]=[],errors:string[]=[]
const route=async(url:string)=>page.evaluate((url:string)=>{location.hash=url},url)
async function open(){
 app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env})
 page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',(e:Error)=>errors.push(e.message))
 assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile)
 await page.waitForFunction(()=>!!(window as any).baoyi?.workspace)
}
async function check(name:string,run:()=>Promise<void>){await run();checks.push(name);console.log('PASS '+name)}
async function personalPage(section='todo'){
 await route('/personal?section='+section);await page.locator('.personal-home').waitFor()
 await page.waitForFunction(()=>!document.querySelector('.personal-home')?.textContent?.includes('正在更新个人记录'))
}
async function preference(show:boolean){
 await route('/settings?module=personal');await page.getByLabel('显示已完成待办',{exact:true}).waitFor()
 await page.getByLabel('显示已完成待办',{exact:true}).setChecked(show)
 await page.getByRole('button',{name:'保存模块偏好',exact:true}).click();await page.getByText('已保存',{exact:true}).waitFor()
 assert.equal((await page.evaluate(()=>(window as any).baoyi.workspace.preferences.get('personal'))).showCompleted,show)
}
async function settledSession(id:string){
 await page.waitForFunction((id:string)=>{
  const select=document.querySelector('[aria-label="项目对话"]') as HTMLSelectElement|null
  return select?.value===id&&!select.disabled&&new URLSearchParams(location.hash.split('?')[1]).get('session')===id
 },id)
}
let sessionA:string,sessionB:string,sessionOther:string
try{
 await open()
 await check('document reader opens after retiring the workspace assistant',async()=>{
  await route('/document/'+documentItem.id);await page.getByText('旧助手清理后仍可阅读的正文。',{exact:false}).first().waitFor()
 })
 await check('unitless legacy metric captures without manual normalization and keeps history',async()=>{
  await personalPage('state');await page.locator('.state-capture').getByRole('button',{name:'无单位评分',exact:true}).click()
  await page.getByLabel('快捷状态数值').fill('7');await page.locator('.state-capture').getByRole('button',{name:'记录状态',exact:true}).click()
  await page.waitForFunction(()=>document.querySelectorAll('.state-rows article').length===2)
  const rows=await page.evaluate(()=>(window as any).baoyi.workspace.personal.list())
  assert.equal(rows.find((r:any)=>r.id===existing.id).data.value,6)
  assert.equal(rows.filter((r:any)=>r.kind==='measurement'&&r.data.metricId===metricId).length,2)
  assert.deepEqual(rows.find((r:any)=>r.id===metricId).data,{})
  await page.getByRole('button',{name:'编辑指标',exact:true}).click();await page.getByLabel('单位',{exact:true}).fill('分')
  await page.getByRole('button',{name:'保存个人记录',exact:true}).click()
  await page.getByRole('dialog').getByRole('alert').filter({hasText:'已有历史记录'}).waitFor()
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click()
 })
 await check('todo preference controls fresh view and updates existing general views',async()=>{
  await preference(false);await page.evaluate(()=>sessionStorage.removeItem('personal-view-home'));await personalPage()
  assert.equal(await page.getByLabel('待办视图').inputValue(),'active');assert.equal(await page.locator('.personal-todos > article').count(),1)
  await preference(true);await personalPage()
  assert.equal(await page.getByLabel('待办视图').inputValue(),'all');assert.equal(await page.locator('.personal-todos > article').count(),2)
  await page.getByLabel('待办视图').selectOption('active');await page.getByLabel('搜索待办').fill('未完成')
  await route('/project');await page.locator('.pj-card').first().waitFor();await personalPage()
  assert.equal(await page.getByLabel('待办视图').inputValue(),'active');assert.equal(await page.getByLabel('搜索待办').inputValue(),'未完成')
  await preference(false);await personalPage();assert.equal(await page.getByLabel('待办视图').inputValue(),'active')
  await preference(true);await personalPage();assert.equal(await page.getByLabel('待办视图').inputValue(),'all')
  assert.equal(await page.getByLabel('搜索待办').inputValue(),'未完成')
 })
 await check('explicit date/completed filters survive preference changes and legacy state migrates',async()=>{
  await page.getByLabel('待办视图').selectOption('today');await preference(false);await personalPage()
  assert.equal(await page.getByLabel('待办视图').inputValue(),'today')
  await page.getByLabel('搜索待办').fill('');await page.getByLabel('待办视图').selectOption('completed')
  await preference(true);await personalPage();assert.equal(await page.getByLabel('待办视图').inputValue(),'completed')
  assert.match(await page.locator('.personal-todos > article').innerText(),/已完成样例/)
  await route('/project');await page.locator('.pj-card').first().waitFor()
  await page.evaluate(()=>sessionStorage.setItem('personal-view-home',JSON.stringify({todoView:'active',todoQuery:'',stateQuery:''})))
  await personalPage();assert.equal(await page.getByLabel('待办视图').inputValue(),'all')
  await page.screenshot({path:path.join(output,'todo-preference.png')})
 })
 await check('legacy project conversations remain selectable and survive reload',async()=>{
  const created=await page.evaluate(async({a,b}:any)=>({one:await window.baoyi.project.createSession(a),two:await window.baoyi.project.createSession(a),other:await window.baoyi.project.createSession(b)}),{a:a.id,b:b.id})
  sessionA=created.one.id;sessionB=created.two.id;sessionOther=created.other.id
  await route('/project/'+a.id+'?tab=chat&session='+sessionA+'&from=review');await settledSession(sessionA)
  assert.equal(await page.getByLabel('给项目助手发消息').count(),0)
  assert.ok((await page.evaluate(()=>location.hash)).includes('from=review'))
  await page.reload();await settledSession(sessionA)
  await page.getByLabel('项目对话',{exact:true}).selectOption(sessionB);await settledSession(sessionB)
  await page.reload();await settledSession(sessionB)
  const sessions=await page.evaluate((id:string)=>window.baoyi.project.sessions(id),a.id)
  assert.equal(sessions.length,2);assert.ok(sessions.some((s:any)=>s.id===sessionA))
 })
 await check('tab/module navigation preserves selected conversation and explicit links win',async()=>{
  await page.getByLabel('项目对话',{exact:true}).selectOption(sessionB);await settledSession(sessionB)
  await page.getByRole('tab',{name:'工作区概览',exact:true}).click()
  await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('tab')==='overview')
  assert.equal(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('session')),null)
  await page.getByRole('tab',{name:'归档助理',exact:true}).click();await settledSession(sessionB)
  await page.getByTitle('切换到个人',{exact:true}).click();await page.locator('.personal-home').waitFor()
  await page.getByTitle('切换到项目',{exact:true}).click();await settledSession(sessionB)
  await route('/project/'+a.id+'?session='+sessionA+'&from=review');await settledSession(sessionA)
  assert.equal(await page.getByRole('tab',{name:'归档助理',exact:true}).getAttribute('aria-selected'),'true')
  await page.getByRole('tab',{name:'项目日志',exact:true}).click()
  await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('tab')==='timeline')
  await route('/project/'+a.id+'?session='+sessionA+'&from=review');await settledSession(sessionA)
  assert.equal(await page.getByRole('tab',{name:'归档助理',exact:true}).getAttribute('aria-selected'),'true','same loaded conversation deep link reopens chat')
 })
 await check('failed and delayed selections cannot send into or reopen the wrong conversation',async()=>{
  await app.evaluate(({ipcMain}:any)=>{const h=(ipcMain as any)._invokeHandlers;(globalThis as any).__sessionOriginal=h.get('project:session')})
  await app.evaluate(({ipcMain}:any,id:string)=>{const h=(ipcMain as any)._invokeHandlers,original=(globalThis as any).__sessionOriginal;h.set('project:session',(e:any,target:string)=>{if(target===id)throw new Error('隔离选择故障');return original(e,target)})},sessionB)
  await page.getByLabel('项目对话',{exact:true}).selectOption(sessionB)
  await page.getByRole('alert').filter({hasText:'隔离选择故障'}).waitFor();await settledSession(sessionA)
  await app.evaluate(({ipcMain}:any,id:string)=>{const h=(ipcMain as any)._invokeHandlers,original=(globalThis as any).__sessionOriginal;h.set('project:session',async(e:any,target:string)=>{const value=await original(e,target);if(target===id)await new Promise(r=>setTimeout(r,600));return value})},sessionB)
  await page.getByLabel('项目对话',{exact:true}).selectOption(sessionB)
  assert.equal(await page.getByLabel('项目对话',{exact:true}).isDisabled(),true)
  await page.getByRole('tab',{name:'项目日志',exact:true}).click()
  await page.waitForTimeout(750)
  assert.equal(await page.getByRole('tab',{name:'项目日志',exact:true}).getAttribute('aria-selected'),'true')
  assert.equal(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('session')),null)
  await page.getByRole('tab',{name:'归档助理',exact:true}).click();await settledSession(sessionA)
  await route('/project/'+a.id+'?tab=chat&session='+sessionB)
  await route('/project/'+b.id+'?tab=chat&session='+sessionOther);await settledSession(sessionOther)
  await page.waitForTimeout(750);assert.equal(await page.getByLabel('项目对话',{exact:true}).inputValue(),sessionOther)
  await app.evaluate(({ipcMain}:any)=>{(ipcMain as any)._invokeHandlers.set('project:session',(globalThis as any).__sessionOriginal)})
 })
 await check('legacy conversation hands off its identity and project to the archive assistant',async()=>{
  await route('/project/'+a.id+'?tab=chat&session='+sessionA);await settledSession(sessionA)
  await page.getByRole('button',{name:'交给归档助理继续',exact:true}).click()
  await page.locator('.archive-panel .context').getByRole('button').waitFor()
  assert.match(await page.getByLabel('给归档助理发消息').inputValue(),new RegExp(sessionA))
  const contextName=await page.locator('.archive-panel .context button').getAttribute('title')
  assert.equal(contextName,(await page.evaluate((id:string)=>window.baoyi.project.get(id),a.id)).name)
  await page.getByRole('button',{name:'收起归档助理',exact:true}).click()
  await route('/project/'+b.id+'?tab=chat&session='+sessionOther);await settledSession(sessionOther)
 })
 await check('cold restart retains captured values, settings and conversation link',async()=>{
  const savedRoute=await page.evaluate(()=>location.hash.slice(1));await app.close();await open();await route(savedRoute);await settledSession(sessionOther)
  const records=await page.evaluate(()=>(window as any).baoyi.workspace.personal.list('measurement'))
  assert.equal(records.filter((r:any)=>r.data.metricId===metricId).length,2)
  assert.equal((await page.evaluate(()=>(window as any).baoyi.workspace.preferences.get('personal'))).showCompleted,true)
  await personalPage();assert.equal(await page.getByLabel('待办视图').inputValue(),'all')
  await page.screenshot({path:path.join(output,'final-personal.png')})
 })
 assert.deepEqual(errors,[])
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({status:'passed',checks,errors,profile,fixture,executable:packed||'development',liveModel:false,projectCommands:false,controlledFaults:'project:session failure/delay only'},null,2)+'\n')
}catch(error){
 fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors,profile},null,2)+'\n')
 if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png')})
 throw error
}finally{if(app)await app.close()}
