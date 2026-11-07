import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { PersonalLibrary } from '../electron/workspace/personal.ts'
import { SkillProfiles } from '../electron/workspace/skill-profiles.ts'
import { DEFAULT_MODULE_PREFERENCES } from '../src/types/workspace.ts'
const require=createRequire(import.meta.url),{_electron}=require('playwright')
const packed=process.argv[2],output=path.resolve(process.argv[3] || 'output/personal-optimization-2026-11-04/native-ui')
fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),db=new DatabaseSync(path.join(profile,'baoyi.db'))
initSchema(db,KINDS)
const date=(offset=0)=>{const d=new Date();d.setDate(d.getDate()+offset);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false,_module_preferences_personal:{...DEFAULT_MODULE_PREFERENCES,remindDays:7}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const lib=new PersonalLibrary(db),skills=new SkillProfiles(db)
const asset=lib.save({kind:'asset',name:'月付云服务',body:'隔离验收用途',data:{category:'服务',provider:'样例提供方',cost:20,currency:'CNY',cycle:'monthly',expiresOn:date(5)}})
lib.save({kind:'asset',name:'年付云服务',body:'',data:{category:'服务',cost:100,currency:'CNY',cycle:'yearly',expiresOn:date(10)}})
lib.save({kind:'asset',name:'待整理证件',body:'',data:{}})
lib.save({kind:'asset',name:'过期设备',body:'',data:{category:'设备保修',cost:900,currency:'CNY',cycle:'once',expiresOn:date(-3)}})
const draft=skills.propose({name:'跑步',summary:'从真实训练回看实践',metrics:[{key:'distance',label:'距离',unit:'公里',type:'number'}]}),skill=skills.confirm(draft.id)
skills.record({cardId:skill.id,metricKey:'distance',version:1,value:5,date:date(-1),requestId:'fixture-run',evidence:'隔离样例'})
lib.save({kind:'skill',name:'绘画',body:'保留人工描述',data:{}})
const metric=lib.save({kind:'metric',name:'体重',body:'',data:{unit:'kg'}})
for(let i=0;i<35;i++)lib.captureState('体重','kg',70-i/10,date(i-34))
lib.save({kind:'experience',name:'作品展示',body:'独立实践的记录',data:{date:date(-1),organization:'样例机构',category:'成果'}})
lib.save({kind:'experience',name:'课程证书',body:'保留凭证',data:{date:date(-10),organization:'另一机构',category:'证书'}})
for(const [name,offset,done]of [['逾期待办',-1,false],['今日事项',0,false],['下周事项',7,false],['远期待办',20,false],['完成事项',-1,true]] as const)lib.save({kind:'todo',name,body:'隔离样例',data:{dueOn:date(offset),done}})
db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const launch=()=>_electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env})
let app:any,page:any;const errors:string[]=[],checks:string[]=[]
async function open(){app=await launch();page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',(e:Error)=>errors.push(e.message));assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile);await page.waitForFunction(()=>!!(window as any).baoyi?.workspace);await page.evaluate(()=>{location.hash='/personal'});await page.locator('.personal-focus').waitFor()}
async function tab(name:string){await page.locator('.personal-home > .ws-sidebar').getByRole('button',{name,exact:true}).click()}
async function check(name:string,run:()=>Promise<void>){await run();checks.push(name);console.log('PASS '+name)}
try{
 await open()
 await check('overview uses configured due range and direct manual capture without AI',async()=>{
  assert.equal(await page.locator('.personal-focus button').nth(1).locator('strong').textContent(),'2')
  await page.getByRole('button',{name:'记一项资产',exact:true}).click();await page.getByRole('dialog').waitFor()
  await page.getByLabel('名称',{exact:true}).fill('手动登记')
  await page.getByRole('button',{name:'保存个人记录',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  await page.locator('.asset-detail h2').filter({hasText:'手动登记'}).waitFor()
  await page.getByRole('button',{name:'返回背包列表',exact:true}).click()
 })
 await check('asset filters, comparable costs and selected detail preserve browse context',async()=>{
  await page.getByLabel('背包到期筛选').selectOption('soon');assert.equal(await page.locator('.asset-card').count(),1)
  await page.getByLabel('背包到期筛选').selectOption('all');await page.getByLabel('筛选背包类别').selectOption('其他')
  assert.ok((await page.locator('.asset-card').allTextContents()).some((t:string)=>t.includes('待整理证件')))
  await page.getByRole('button',{name:'清除筛选',exact:true}).click()
  await page.getByLabel('搜索背包').fill('云服务');await page.getByLabel('背包排序').selectOption('cost')
  assert.equal(await page.locator('.asset-card h3').first().textContent(),'月付云服务')
  await page.locator('.asset-card').first().click();await page.locator('.asset-detail').waitFor()
  await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('月付云服务已核对')
  await page.getByRole('button',{name:'保存个人记录',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  await page.getByRole('button',{name:'返回背包列表',exact:true}).click();assert.equal(await page.getByLabel('搜索背包').inputValue(),'云服务')
  assert.equal(await page.getByLabel('背包排序').inputValue(),'cost');assert.equal(await page.locator('.asset-card').count(),2)
 })
 await check('overview skill deep-link opens real detail and search survives selection',async()=>{
  await tab('总览');await page.locator('.personal-card').filter({hasText:'跑步'}).click();await page.locator('.skill-detail h2').filter({hasText:'跑步'}).waitFor()
  await page.getByRole('button',{name:'返回技能列表',exact:true}).click();await page.getByLabel('搜索技能').fill('距离')
  assert.equal(await page.locator('.skill-card').count(),1);await page.locator('.skill-card').click();await page.getByRole('button',{name:'返回技能列表',exact:true}).click()
  assert.equal(await page.getByLabel('搜索技能').inputValue(),'距离')
 })
 await check('state history pages and historical unit changes are rejected without losing edits',async()=>{
  await tab('状态');assert.equal(await page.locator('.state-rows article').count(),10)
  await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByText('2 / 4 页 · 共 35 条',{exact:true}).waitFor()
  await page.getByRole('button',{name:'编辑指标',exact:true}).click();await page.getByLabel('单位',{exact:true}).fill('lb')
  await page.getByRole('button',{name:'保存个人记录',exact:true}).click();await page.getByRole('dialog').getByRole('alert').filter({hasText:'不能直接更改单位'}).waitFor()
  assert.equal(await page.getByLabel('单位',{exact:true}).inputValue(),'lb')
  await page.getByLabel('单位',{exact:true}).fill('kg');await page.getByLabel('名称',{exact:true}).fill('晨起体重')
  await page.getByRole('button',{name:'保存个人记录',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  assert.equal((await page.evaluate(()=> (window as any).baoyi.workspace.personal.list('measurement'))).length,35)
  await page.evaluate(()=>(window as any).baoyi.workspace.personal.save({kind:'metric',name:'晨起体重',body:'',data:{unit:'lb'}}))
  await page.locator('.state-capture').getByRole('button',{name:'晨起体重 · lb',exact:true}).click();await page.getByLabel('快捷状态数值').fill('154')
  await page.locator('.state-capture').getByRole('button',{name:'记录状态',exact:true}).click();await page.getByText('154 lb',{exact:true}).first().waitFor()
  const measured=await page.evaluate(()=>(window as any).baoyi.workspace.personal.list('measurement'));assert.equal(measured.length,36);assert.equal(measured.filter((r:any)=>r.data.metricId===metric.id).length,35)
 })
 await check('experience search and category combine without removing stored records',async()=>{
  await tab('奖项与经历');await page.getByLabel('搜索经历').fill('机构');await page.getByLabel('经历类型').selectOption('成果')
  assert.equal(await page.locator('.experience-timeline article').count(),1)
  await page.getByLabel('搜索经历').fill('不存在');assert.equal(await page.locator('.experience-timeline article').count(),0)
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();assert.equal(await page.locator('.experience-timeline article').count(),2)
 })
 await check('todo date views, quick due date and completion update overview accurately',async()=>{
  await tab('待办');await page.getByLabel('待办视图').selectOption('overdue');assert.equal(await page.locator('.personal-todos > article').count(),1)
  await page.getByLabel('待办视图').selectOption('upcoming');assert.equal(await page.locator('.personal-todos > article').count(),1)
  assert.match(await page.locator('.personal-todos > article').textContent(),/下周事项/)
  await page.getByLabel('快速添加待办').fill('新待办');await page.getByLabel('快速待办日期').fill(date())
  await page.locator('form').getByRole('button',{name:'添加',exact:true}).click();await page.getByLabel('待办视图').selectOption('today')
  await page.locator('.personal-todos > article').filter({hasText:'新待办'}).waitFor();await page.getByLabel('完成 新待办',{exact:true}).click()
  await page.locator('.personal-todos > article').filter({hasText:'新待办'}).waitFor({state:'hidden'})
  await page.getByLabel('待办视图').selectOption('completed');assert.equal(await page.locator('.personal-todos > article').count(),2)
 })
 await check('sidebar draft, light/dark and 800/1024/1360 layouts remain usable',async()=>{
  await page.locator('.personal-assistant-trigger').click();await page.getByRole('textbox',{name:'给归档助理发消息'}).fill('保留草稿')
  await page.getByRole('button',{name:'收起归档助理'}).click();await tab('总览');await page.locator('.personal-assistant-trigger').click()
  assert.equal(await page.getByRole('textbox',{name:'给归档助理发消息'}).inputValue(),'保留草稿');await page.getByRole('button',{name:'收起归档助理'}).click()
  await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setMinimumSize(800,600)) // Test narrow content below the ordinary 960px minimum.
  for(const width of [800,1024,1360]){
   await app.evaluate(({BrowserWindow}:any,w:number)=>BrowserWindow.getAllWindows()[0].setSize(w,900),width)
   for(const label of ['总览','背包','技能','状态','奖项与经历','待办']){
    await tab(label);await page.screenshot({path:path.join(output,`${label}-${width}.png`)})
    assert.equal(await page.locator('.personal-home > .ws-main').evaluate((e:HTMLElement)=>e.scrollWidth <= e.clientWidth+1),true,`${label} ${width}`)
   }
  }
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark'});await tab('总览');await page.screenshot({path:path.join(output,'overview-dark.png')})
 })
 await check('native backup restore and cold restart retain personal identities and values',async()=>{
  const backup=path.join(profile,'personal-export.json');await app.evaluate(({dialog}:any,file:string)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},backup)
  await page.evaluate(()=>(window as any).baoyi.data.exportJson());assert.ok(fs.statSync(backup).size>0)
  await page.evaluate(async(id:string)=>{const w=(window as any).baoyi.workspace;const r=(await w.personal.list()).find((r:any)=>r.id===id);await w.personal.save({id:r.id,kind:r.kind,name:'恢复前临时修改',body:r.body,data:r.data})},asset.id)
  await app.evaluate(({dialog,app}:any,file:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1});app.relaunch=()=>{};app.exit=()=>{}},backup)
  const restored=await page.evaluate(()=>(window as any).baoyi.data.restoreJson());assert.ok(fs.existsSync(restored.backupPath))
  await app.close();await open()
  const records=await page.evaluate(()=>(window as any).baoyi.workspace.personal.list())
  assert.equal(records.find((r:any)=>r.id===asset.id).name,'月付云服务已核对');assert.equal(records.find((r:any)=>r.id===metric.id).data.unit,'kg')
  assert.equal(records.filter((r:any)=>r.kind==='measurement').length,36)
  assert.equal((await page.evaluate(()=>(window as any).baoyi.workspace.skills.list())).find((r:any)=>r.id===skill.id).records[0].value,5)
 })
 await check('partial overview failure leaves records usable and retry removes the warning',async()=>{
  const overview=await page.evaluate(()=>(window as any).baoyi.workspace.personal.overview())
  await app.evaluate(({ipcMain}:any)=>{ipcMain.removeHandler('workspace:personal:overview');ipcMain.handle('workspace:personal:overview',()=>{throw new Error('fixture unavailable')})})
  await page.reload();await page.getByRole('alert').filter({hasText:'部分概览暂未载入'}).waitFor()
  await tab('背包');await page.getByLabel('搜索背包').fill('月付云服务已核对');assert.equal(await page.locator('.asset-card').count(),1)
  await app.evaluate(({ipcMain}:any,value:any)=>{ipcMain.removeHandler('workspace:personal:overview');ipcMain.handle('workspace:personal:overview',()=>value)},overview)
  await page.getByRole('button',{name:'重新加载',exact:true}).click();await page.getByRole('alert').waitFor({state:'hidden'})
 })
 await check('open window refreshes day-dependent todo views at midnight',async()=>{
  await tab('待办');await page.getByLabel('待办视图').selectOption('today');assert.equal(await page.locator('.personal-todos > article').count(),1)
  await page.clock.install({time:new Date()});await page.reload();await page.getByLabel('待办视图').waitFor();await page.clock.fastForward(24*60*60*1000)
  await page.locator('.personal-todos > article').waitFor({state:'hidden'})
  await page.getByLabel('待办视图').selectOption('overdue');assert.equal(await page.locator('.personal-todos > article').count(),2)
 })
 assert.deepEqual(errors,[])
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({status:'passed',checks,errors,profile,executable:packed || 'development'},null,2))
}catch(error){if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png')});throw error}finally{if(app)await app.close()}
