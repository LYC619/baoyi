import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { scanProjects } from '../electron/kinds/project/scanner.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
const require=createRequire(import.meta.url)
const {_electron}=require(process.env.BAOYI_PLAYWRIGHT||'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output=path.resolve('output/project-verification');fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-project-ui-')),destinationParent=path.join(fixture,'整理后');fs.mkdirSync(destinationParent)
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
for(const [key,value] of Object.entries({onboarded:true,theme:'dark',hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const library=new ProjectLibrary(db),ids:string[]=[]
for(const [index,name] of ['自己的开发项目','第三方工具','工作调研报告'].entries()){
  const dir=path.join(fixture,name);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'README.md'),'# '+name+'\n\n用于隔离验证的项目，连接资料与常用工具。')
  fs.writeFileSync(path.join(dir,'笔记.md'),'# 测试笔记')
  if(index<2)fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name,description:'开发与使用入口集中管理',version:'1.0.0'}))
  const item=library.register((await scanProjects(dir,'single'))[0]);library.update(item.id,{source:index===1?'third-party':'self',group:index===2?'工作':'开发',tags:['验证样本'],pinned:index===0});ids.push(item.id)
}
db.prepare("INSERT INTO image_groups(id,name,hidden) VALUES('hidden-group','隐藏分组',1)").run()
db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name) VALUES('hidden-image','image',1,1,?,'hidden')").run(path.join(fixture,'hidden'))
db.prepare("INSERT INTO image_meta(resource_id,item_type,group_id) VALUES('hidden-image','comic','hidden-group')").run()
db.close()
const realRoots=[String.raw`D:\8.Project\0_0_维护\抱一`,String.raw`D:\8.Project\1_1_小说相关\character-arc`,String.raw`D:\8.Project\Work\260726 要报`,String.raw`D:\8.Project\Claude`]
const pilot=[]
for(const [i,root] of realRoots.entries())if(fs.existsSync(root)){const candidates=await scanProjects(root,i===3?'discover':'single');pilot.push({root,mode:i===3?'discover':'single',candidates:candidates.length,suggested:candidates.filter(c=>c.suggested).length,categories:[...new Set(candidates.map(c=>c.category))],entries:candidates.reduce((n,c)=>n+c.entries.length,0)})}
const packed=!!process.argv[2],executable=path.resolve(process.argv[2]||'node_modules/electron/dist/electron.exe'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const args=[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu']
let application=await _electron.launch({executablePath:executable,args,env,timeout:30000})
const errors:string[]=[],checks:string[]=[]
try{
  assert.equal(path.resolve(await application.evaluate(({app}:any)=>app.getPath('userData'))),profile)
  let page=await application.firstWindow();page.on('pageerror',(e:Error)=>errors.push(e.message));page.setDefaultTimeout(15000)
  await page.waitForFunction(()=>!!window.baoyi?.project);await page.evaluate(()=>{location.hash='/project'})
  await page.locator('.pj-card').first().waitFor();assert.equal(await page.locator('.pj-card').count(),3)
  await page.getByLabel('搜索项目',{exact:true}).fill('第三方');assert.equal(await page.locator('.pj-card').count(),1);await page.getByLabel('搜索项目',{exact:true}).fill('')
  assert.ok(!(await page.evaluate(()=>window.baoyi.project.resources())).some((r:{id:string})=>r.id==='hidden-image'));checks.push('project-tab-list-filter-hidden-resource')
  await page.getByRole('button',{name:'自己的开发项目',exact:true}).click();await page.getByLabel('编辑项目',{exact:true}).click()
  await page.getByLabel('项目名称',{exact:true}).fill('自己的开发项目 · 已整理');await page.getByLabel('备注',{exact:true}).fill('下次继续检查发布说明。');await page.getByRole('button',{name:'保存',exact:true}).click()
  await page.getByRole('dialog',{name:'编辑项目',exact:true}).waitFor({state:'hidden'});assert.equal((await page.evaluate(async (id:string)=>window.baoyi.project.get(id),ids[0]))?.notes,'下次继续检查发布说明。')
  await page.getByRole('tab',{name:'项目入口',exact:true}).click();await page.getByRole('button',{name:'添加入口',exact:true}).click();await page.getByLabel('入口名称',{exact:true}).fill('Obsidian 笔记');await page.getByLabel('打开方式',{exact:true}).selectOption('obsidian');await page.getByLabel('完整路径',{exact:true}).fill(path.join(fixture,'自己的开发项目','笔记.md'));await page.getByRole('button',{name:'保存入口',exact:true}).click();await page.getByRole('dialog',{name:'添加入口',exact:true}).waitFor({state:'hidden'})
  await application.evaluate(({shell}:any)=>{(globalThis as any).__projectOpened=[];shell.openPath=async(p:string)=>{(globalThis as any).__projectOpened.push(p);return ''};shell.openExternal=async(p:string)=>{(globalThis as any).__projectOpened.push(p)}})
  await page.getByRole('button',{name:'Obsidian 笔记',exact:false}).filter({has:page.locator('strong')}).click()
  assert.ok((await application.evaluate(()=>(globalThis as any).__projectOpened)).some((p:string)=>p.startsWith('obsidian://open?path=')))
  checks.push('metadata-edit-obsidian-entry-open')
  await application.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(1440,900));await page.screenshot({path:path.join(output,'detail-dark.png')})
  await application.evaluate(({dialog}:any,target:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[target]})},destinationParent)
  await page.getByRole('button',{name:'移动项目',exact:true}).click();await page.getByRole('button',{name:'预览移动',exact:true}).click();await page.getByLabel('我已关闭此项目相关程序，并核对移动范围').check();await page.getByRole('button',{name:'确认移动',exact:true}).click();await page.getByRole('dialog',{name:'移动项目',exact:true}).waitFor({state:'hidden'})
  const moved=await page.evaluate(async (id:string)=>window.baoyi.project.get(id),ids[0]);assert.equal(moved?.path,path.join(destinationParent,'自己的开发项目'));assert.equal(fs.readFileSync(path.join(fixture,'自己的开发项目','笔记.md'),'utf8'),'# 测试笔记');checks.push('move-dialog-native-files-rebase-old-junction')
  await page.getByRole('button',{name:'项目库',exact:true}).click();await page.locator('.pj-card').first().waitFor();await page.screenshot({path:path.join(output,'library-dark.png')})
  await page.getByRole('button',{name:'移动记录',exact:true}).click();await page.getByRole('dialog',{name:'项目移动记录',exact:true}).waitFor();assert.match(await page.locator('.pj-history').innerText(),/已完成/);await page.getByLabel('关闭对话框',{exact:true}).click()
  const loose=path.join(fixture,'混合目录');fs.mkdirSync(loose);for(const n of ['分析报告','临时稿件']){fs.mkdirSync(path.join(loose,n));fs.writeFileSync(path.join(loose,n,'README.md'),'# '+n)}
  await application.evaluate(({dialog}:any,target:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[target]})},loose)
  await page.getByRole('button',{name:'添加项目',exact:true}).click();await page.getByRole('button',{name:'从目录发现项目',exact:false}).click();await page.locator('.pj-candidate').first().waitFor();assert.equal(await page.locator('.pj-candidate').count(),2)
  await page.getByRole('button',{name:'切换全选',exact:true}).click();assert.equal(await page.locator('.pj-candidate>input:checked').count(),0);await page.getByRole('button',{name:'切换全选',exact:true}).click();assert.equal(await page.locator('.pj-candidate>input:checked').count(),2)
  await page.getByRole('button',{name:'导入所选项目',exact:true}).click();await page.getByRole('dialog',{name:'添加项目',exact:true}).waitFor({state:'hidden'});assert.equal(await page.locator('.pj-card').count(),5);checks.push('mixed-directory-discovery-import-select-all')
  const extra=path.join(fixture,'补充资料');fs.mkdirSync(extra);fs.writeFileSync(path.join(extra,'参考.md'),'external notes')
  await application.evaluate(({dialog}:any,target:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[target]})},extra)
  await page.getByRole('button',{name:'添加项目',exact:true}).click();await page.getByRole('button',{name:'导入一个项目',exact:false}).click();await page.locator('.pj-candidate').first().waitFor()
  await page.getByLabel('项目合并目标',{exact:true}).selectOption('existing:'+ids[1]);await page.getByRole('button',{name:'导入所选项目',exact:true}).click();await page.getByRole('dialog',{name:'添加项目',exact:true}).waitFor({state:'hidden'})
  const associated=await page.evaluate((id:string)=>window.baoyi.project.get(id),ids[1]);assert.ok(associated?.entries.some((e:{path:string})=>e.path===extra));assert.equal(associated?.name,'第三方工具');assert.equal((await page.evaluate(()=>window.baoyi.project.list())).length,5);checks.push('associate-existing-project-preserves-metadata')
  const relocated=path.join(fixture,'第三方工具.v2');fs.renameSync(path.join(fixture,'第三方工具'),relocated)
  await application.evaluate(({dialog}:any,target:string)=>{dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});dialog.showOpenDialog=async(_options:any,config:any)=>{if(!config.properties.includes('openDirectory'))throw new Error('Expected directory picker');return {canceled:false,filePaths:[target]}}},relocated)
  const relocatedItem=await page.evaluate((id:string)=>window.baoyi.project.relocate(id),ids[1]);assert.equal(relocatedItem?.path,relocated);assert.ok(relocatedItem?.entries.some((e:{path:string})=>e.path===extra))
  // Repeating after a dotted directory name proves relocation does not guess from its suffix.
  const relocatedAgain=path.join(fixture,'第三方工具.v3');fs.renameSync(relocated,relocatedAgain)
  await application.evaluate(({dialog}:any,target:string)=>{dialog.showOpenDialog=async(_options:any,config:any)=>{if(!config.properties.includes('openDirectory'))throw new Error('Expected directory picker');return {canceled:false,filePaths:[target]}}},relocatedAgain)
  assert.equal((await page.evaluate((id:string)=>window.baoyi.project.relocate(id),ids[1]))?.path,relocatedAgain);checks.push('relocate-dotted-directory-and-external-reference')
  await application.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(960,640));await page.screenshot({path:path.join(output,'library-960.png')});assert.equal(await page.locator('.pj-content').evaluate((el:HTMLElement)=>el.scrollWidth>el.clientWidth),false)
  await page.evaluate(()=>window.baoyi.settings.patch({theme:'light'}));await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));await page.screenshot({path:path.join(output,'library-light.png')});checks.push('minimum-window-light-dark')
  await application.close();application=await _electron.launch({executablePath:executable,args,env,timeout:30000});page=await application.firstWindow();await page.waitForFunction(()=>!!window.baoyi?.project);assert.equal((await page.evaluate(()=>window.baoyi.project.list())).length,5);assert.equal((await page.evaluate((id:string)=>window.baoyi.project.get(id),ids[0]))?.path,moved?.path);checks.push('restart-persistence')
  const reset=await page.evaluate(()=>window.baoyi.data.reset('library'));assert.equal(reset.summary.projects,5);assert.equal((await page.evaluate(()=>window.baoyi.project.list())).length,0);assert.equal(fs.readFileSync(path.join(destinationParent,'自己的开发项目','笔记.md'),'utf8'),'# 测试笔记');checks.push('reset-project-index-keeps-original-files')
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,packed?'packaged-report.json':'report.json'),JSON.stringify({profile,fixture,executable,checks,pilot,errors},null,2));console.log('PASS '+checks.join(', '))
}catch(error){try{const page=await application.firstWindow();await page.screenshot({path:path.join(output,'failure.png')})}catch{}throw error}
finally{await application.close()}
