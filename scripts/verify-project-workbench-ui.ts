import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {inspectProject,projectEntry} from '../electron/kinds/project/scanner.ts'
const require=createRequire(import.meta.url),{_electron}=require('playwright')
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/project-workbench-2026-11-04/native-ui')
fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=fs.mkdtempSync(path.join(output,'fixtures-')),alpha=path.join(fixture,'甲项目'),beta=path.join(fixture,'乙项目'),gone=path.join(fixture,'离线项目')
for(const dir of [alpha,beta,gone])fs.mkdirSync(dir)
fs.writeFileSync(path.join(alpha,'README.md'),'# 工作台验收\n'+Array.from({length:420},(_,i)=>`第 ${i+1} 行，保持文字内容😀\n`).join(''))
fs.writeFileSync(path.join(beta,'README.md'),'# 乙项目独立内容')
fs.writeFileSync(path.join(alpha,'.env'),'fixture-do-not-display')
fs.writeFileSync(path.join(alpha,'package.json'),JSON.stringify({packageManager:'pnpm@9.0.0',scripts:{dev:'echo SHOULD_NOT_RUN',build:'echo build'}}))
fs.mkdirSync(path.join(alpha,'子目录'))
fs.writeFileSync(path.join(alpha,'子目录','Makefile'),'.PHONY: check\ncheck:\n\t@echo CHILD_SHOULD_NOT_RUN')
for(let i=0;i<125;i++)fs.writeFileSync(path.join(alpha,`file-${String(i).padStart(3,'0')}.md`),'分页样例 '+i)
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false,project_preferences:{maxTurns:8,contextMessages:12,defaultSource:'unknown',defaultState:'active',defaultTab:'overview'}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const library=new ProjectLibrary(db),a=library.register(await inspectProject(alpha)),b=library.register(await inspectProject(beta)),missing=library.register(await inspectProject(gone))
library.update(a.id,{name:'甲工作台',group:'工作',tags:['文稿']});library.update(b.id,{name:'乙研究',group:'兴趣'});fs.rmdirSync(gone)
db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
let app:any,page:any;const errors:string[]=[],checks:string[]=[]
async function open(){app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',(e:Error)=>errors.push(e.message));page.on('dialog',(d:any)=>void d.accept());assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile);await page.waitForFunction(()=>!!(window as any).baoyi?.project)}
async function route(url:string){await page.evaluate((url:string)=>{location.hash=url},url)}
async function check(name:string,run:()=>Promise<void>){await run();checks.push(name);console.log('PASS '+name)}
async function until(check:()=>Promise<boolean>){const start=Date.now();while(!await check()){if(Date.now()-start>15000)throw new Error('等待项目异步状态超时');await new Promise(resolve=>setTimeout(resolve,100))}}
let savedClipboard:string|undefined
try{
 await open();savedClipboard=await app.evaluate(({clipboard}:any)=>clipboard.readText());await route('/project');await page.locator('.pj-card').first().waitFor()
 await check('catalog combines search, availability and list layout with browsing context',async()=>{
  await page.getByLabel('搜索项目',{exact:true}).fill('甲 工作');await page.waitForFunction(()=>document.querySelectorAll('.pj-card').length===1)
  await page.getByRole('button',{name:'列表视图',exact:true}).click();assert.equal(await page.locator('.pj-list').count(),1)
  await page.getByRole('button',{name:'甲工作台',exact:true}).click();await page.getByRole('tab',{name:'工作区概览',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'工作区概览',exact:true}).getAttribute('aria-selected'),'true')
  await page.getByRole('button',{name:'项目库',exact:true}).click();assert.equal(await page.getByLabel('搜索项目',{exact:true}).inputValue(),'甲 工作');assert.equal(await page.locator('.pj-list').count(),1)
  await page.getByRole('button',{name:'清空筛选',exact:true}).click();await page.locator('details summary').filter({hasText:'来源与位置'}).click();await page.getByRole('button',{name:'位置失效',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.pj-card').length===1);assert.match(await page.locator('.pj-card').innerText(),/离线项目/)
  await page.getByRole('button',{name:'清空筛选',exact:true}).click()
  await app.evaluate(({shell}:any)=>{(globalThis as any).__openOriginal=shell.openPath;shell.openPath=async(file:string)=>{(globalThis as any).__openedFile=file;return ''}})
  const entry=(await page.evaluate((id:string)=>window.baoyi.project.get(id),a.id)).entries[0]
  await page.getByLabel('打开项目入口 甲工作台',{exact:true}).selectOption(entry.id)
  await until(()=>page.evaluate((id:string)=>window.baoyi.project.get(id).then(p=>!!p?.lastOpenedAt),a.id))
  assert.equal(await app.evaluate(()=>(globalThis as any).__openedFile),entry.path)
  await app.evaluate(({shell}:any)=>{shell.openPath=(globalThis as any).__openOriginal})
 })
 await check('default tab preference and explicit links, independent directory pagination and text preview',async()=>{
  await route('/project/'+a.id);await page.getByLabel('搜索当前目录').waitFor();await page.locator('.work-files li').first().waitFor()
  assert.equal(await page.locator('.work-files li').count(),100);await page.getByRole('button',{name:'加载更多文件',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.work-files li').length>100)
  assert.doesNotMatch(await page.locator('.work-files').innerText(),/\.env/)
  await page.getByRole('button',{name:'预览文件 README.md',exact:true}).click();await page.locator('.work-text').waitFor();assert.match(await page.locator('.work-text').innerText(),/工作台验收/)
  await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.work-paging')?.textContent?.includes('第 2 页'))
  await page.getByRole('button',{name:'上一页',exact:true}).click();assert.match(await page.locator('.work-text').innerText(),/工作台验收/)
  await route('/project/'+a.id+'?tab=entries');await page.locator('.pj-entries').waitFor();assert.equal(await page.getByRole('tab',{name:'项目入口',exact:true}).getAttribute('aria-selected'),'true')
 })
 await check('entry edits preserve concurrent additions and reject stale edits; default action saves',async()=>{
  const original=(await page.evaluate((id:string)=>window.baoyi.project.get(id),a.id)).entries[0]
  await page.getByRole('button',{name:'编辑入口 '+original.label,exact:true}).click();await page.getByLabel('入口名称',{exact:true}).fill('保留我的入口')
  const extra=projectEntry(path.join(alpha,'file-124.md'))
  await page.evaluate(({id,entry}:any)=>window.baoyi.project.saveEntry(id,entry),{id:a.id,entry:extra})
  await page.getByRole('button',{name:'保存入口',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  assert.ok((await page.evaluate((id:string)=>window.baoyi.project.get(id),a.id)).entries.some((e:any)=>e.id===extra.id))
  await page.getByRole('button',{name:'设为默认入口 '+extra.label,exact:true}).click();await until(()=>page.evaluate(({id,entry}:any)=>window.baoyi.project.get(id).then(p=>p?.defaultEntryId===entry),{id:a.id,entry:extra.id}))
  await page.getByRole('button',{name:'编辑入口 保留我的入口',exact:true}).click();await page.getByLabel('入口名称',{exact:true}).fill('暂存输入')
  await page.evaluate(async(id:string)=>{const p=(await window.baoyi.project.get(id))!;const old=p.entries.find(e=>e.label==='保留我的入口')!;await window.baoyi.project.saveEntry(id,{...old,label:'另一处修改'},old)},a.id)
  await page.getByRole('button',{name:'保存入口',exact:true}).click();await page.getByRole('dialog').getByRole('alert').waitFor();assert.equal(await page.getByLabel('入口名称',{exact:true}).inputValue(),'暂存输入');await page.getByRole('button',{name:'取消',exact:true}).click()
 })
 await check('script discovery follows current directory and copy works without running commands',async()=>{
  await page.getByRole('tab',{name:'工作区概览',exact:true}).click();await page.getByRole('button',{name:'复制命令 dev package.json',exact:true}).waitFor()
  await page.getByRole('button',{name:'复制命令 dev package.json',exact:true}).click();await page.getByText('已复制',{exact:true}).first().waitFor();assert.equal(await app.evaluate(({clipboard}:any)=>clipboard.readText()),'pnpm run dev')
  await page.getByRole('button',{name:'进入目录 子目录',exact:true}).click();await page.getByRole('button',{name:/复制命令 check .*Makefile/}).waitFor();assert.equal(await page.getByRole('button',{name:'复制命令 dev package.json',exact:true}).count(),0)
  await page.getByRole('button',{name:/复制命令 check .*Makefile/}).click();assert.equal(await app.evaluate(({clipboard}:any)=>clipboard.readText()),'make check')
  await page.getByRole('button',{name:'项目根位置',exact:true}).click()
 })
 await check('native terminal opens correct cwd without executing project code',async()=>{
  await app.evaluate(()=>{const cp=process.getBuiltinModule('node:child_process')!,original=cp.execFile;(globalThis as any).__execOriginal=original;(cp as any).execFile=(file:string,args:string[],options:any,callback:any)=>{if(args.includes('-EncodedCommand'))return original(file,args,options,(error:any,stdout:string,stderr:string)=>{(globalThis as any).__terminalTrace={file,args,cwd:options.cwd,stdout,error:error?.message};callback(error,stdout,stderr)});return original(file,args,options,callback)}})
  await page.getByRole('button',{name:'在当前目录打开终端',exact:true}).click();await page.getByText('已在当前目录打开 PowerShell',{exact:true}).waitFor()
  const trace=await app.evaluate(()=>{const cp=process.getBuiltinModule('node:child_process')!;cp.execFile=(globalThis as any).__execOriginal;return (globalThis as any).__terminalTrace})
  assert.equal(trace.cwd,alpha);assert.equal(trace.error,undefined)
  const terminalPid=Number(trace.stdout.trim());assert.ok(Number.isInteger(terminalPid)&&terminalPid>0)
  const processInfo=await app.evaluate((_electron:any,pid:number)=>{const cp=process.getBuiltinModule('node:child_process')!;try{return cp.execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object Name,CommandLine | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true})}finally{cp.execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}},terminalPid)
  assert.match(processInfo,/-NoExit/);assert.doesNotMatch(processInfo,/SHOULD_NOT_RUN/)
  const command=Buffer.from(trace.args.at(-1),'base64').toString('utf16le');assert.ok(command.includes("-WorkingDirectory '"+alpha.replaceAll("'","''")+"'"));assert.ok(!command.includes('SHOULD_NOT_RUN'))
 })
 await check('failure and stale file cursors are recoverable, late project response cannot replace selection',async()=>{
  await page.getByLabel('搜索当前目录').fill('README');await page.getByRole('button',{name:'预览文件 README.md',exact:true}).click();await page.locator('.work-text').waitFor()
  fs.appendFileSync(path.join(alpha,'README.md'),'changed');await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByRole('alert').filter({hasText:'失效'}).waitFor();await page.getByRole('button',{name:'重新读取文件',exact:true}).click();await page.locator('.work-text').waitFor()
  await app.evaluate(({ipcMain}:any,id:string)=>{const handlers=(ipcMain as any)._invokeHandlers;const original=handlers.get('project:get');handlers.set('project:get',async(e:any,target:string)=>{const result=await original(e,target);if(target===id)await new Promise(r=>setTimeout(r,550));return result});(globalThis as any).__projectGetOriginal=original},a.id)
  await route('/project');await page.locator('.pj-card').first().waitFor();await route('/project/'+a.id);await route('/project/'+b.id);await page.locator('.pj-detail-title h1').filter({hasText:'乙研究'}).waitFor();await page.waitForTimeout(700);assert.equal(await page.locator('.pj-detail-title h1').textContent(),'乙研究')
  await app.evaluate(({ipcMain}:any)=>{(ipcMain as any)._invokeHandlers.set('project:get',(globalThis as any).__projectGetOriginal)})
  await app.evaluate(({ipcMain}:any)=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get('project:overview');handlers.set('project:overview',()=>{throw new Error('隔离概览故障')});(globalThis as any).__overviewOriginal=original})
  await route('/project/'+a.id+'?tab=overview');await page.getByRole('alert').filter({hasText:'隔离概览故障'}).waitFor();await page.getByLabel('搜索当前目录').fill('README');await page.getByRole('button',{name:'预览文件 README.md',exact:true}).waitFor()
  await app.evaluate(({ipcMain}:any)=>{(ipcMain as any)._invokeHandlers.set('project:overview',(globalThis as any).__overviewOriginal)});await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.getByRole('alert').filter({hasText:'隔离概览故障'}).waitFor({state:'hidden'})
 })
 await check('settings default tab, sidebar search, theme and narrow layout',async()=>{
  await route('/settings?module=project');await page.getByLabel('项目默认栏目').selectOption('entries');await page.getByRole('button',{name:'保存项目偏好',exact:true}).click();await page.getByText('已保存',{exact:true}).waitFor()
  await route('/project/'+b.id);await page.locator('.pj-entries').waitFor();assert.equal(await page.getByRole('tab',{name:'项目入口',exact:true}).getAttribute('aria-selected'),'true')
  await page.getByLabel('查找侧栏项目').fill('工作');assert.equal(await page.locator('.project-context-nav button').filter({hasText:'乙研究'}).count(),0);await page.getByLabel('查找侧栏项目').fill('')
  await route('/project/'+a.id+'?tab=overview')
  for(const width of [960,1360]){await app.evaluate(({BrowserWindow}:any,width:number)=>BrowserWindow.getAllWindows()[0].setSize(width,850),width);await page.screenshot({path:path.join(output,'workbench-'+width+'.png')});assert.equal(await page.locator('.pj-detail').evaluate((el:HTMLElement)=>el.scrollWidth>el.clientWidth),false)}
  await page.evaluate(()=>{document.documentElement.setAttribute('data-theme','dark')});await page.screenshot({path:path.join(output,'workbench-dark.png')})
  await page.getByLabel('搜索当前目录').fill('README');await page.getByRole('button',{name:'预览文件 README.md',exact:true}).click();await page.locator('.work-text').waitFor();await page.locator('.work-preview').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'files-preview-dark.png')})
  await route('/project');await page.locator('.pj-card').first().waitFor();await page.screenshot({path:path.join(output,'catalog-list-dark.png')});assert.equal(await page.locator('.pj-content').evaluate((el:HTMLElement)=>el.scrollWidth>el.clientWidth),false)
 })
 await check('existing manual timeline and assistant draft survive workbench navigation',async()=>{
  await route('/project/'+a.id+'?tab=timeline');await page.locator('.timeline>.ws-header').getByRole('button',{name:'记一笔',exact:true}).click();await page.getByLabel('一句话记录',{exact:true}).fill('工作台优化验收记录');await page.getByLabel('经过与结果',{exact:true}).fill('隔离资料，验证既有日志仍可保存。');await page.getByRole('button',{name:'保存记录',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.locator('.timeline-event h3').filter({hasText:'工作台优化验收记录'}).waitFor()
  await page.getByRole('tab',{name:'归档助理',exact:true}).click();await page.getByRole('button',{name:'打开归档助理',exact:true}).click();await page.getByLabel('给归档助理发消息').fill('尚未发送的本地草稿');await page.getByRole('button',{name:'收起归档助理',exact:true}).click();await page.getByRole('tab',{name:'工作区概览',exact:true}).click();await page.getByRole('tab',{name:'归档助理',exact:true}).click();await page.getByRole('button',{name:'打开归档助理',exact:true}).click();assert.equal(await page.getByLabel('给归档助理发消息').inputValue(),'尚未发送的本地草稿');await page.getByRole('button',{name:'收起归档助理',exact:true}).click()
 })
 await check('project metadata backup restore uses real handler and keeps source files unchanged',async()=>{
  const backup=path.join(profile,'project-export.json'),before=fs.readFileSync(path.join(alpha,'README.md'))
  await app.evaluate(({dialog}:any,file:string)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},backup)
  await page.evaluate(()=>window.baoyi.data.exportJson());assert.ok(fs.statSync(backup).size>0)
  await page.evaluate((id:string)=>window.baoyi.project.update(id,{name:'恢复前临时改名'}),a.id)
  await app.evaluate(({dialog,app}:any,file:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1});app.relaunch=()=>{};app.exit=()=>{}},backup)
  const result=await page.evaluate(()=>window.baoyi.data.restoreJson());assert.ok(fs.existsSync(result.backupPath));assert.deepEqual(fs.readFileSync(path.join(alpha,'README.md')),before)
 })
 await check('cold restart keeps entries, preferences and project identity',async()=>{
  await app.close();await open();await route('/project/'+a.id);await page.locator('.pj-entries').waitFor();assert.equal(await page.getByRole('tab',{name:'项目入口',exact:true}).getAttribute('aria-selected'),'true')
  const current=await page.evaluate((id:string)=>window.baoyi.project.get(id),a.id);assert.equal(current.id,a.id);assert.equal(current.name,'甲工作台');assert.ok(current.entries.some((e:any)=>e.label==='另一处修改'));assert.equal((await page.evaluate(()=>window.baoyi.project.list())).length,3)
  assert.ok((await page.evaluate((id:string)=>window.baoyi.project.get(id),missing.id)).available===false)
  await page.getByRole('tab',{name:'项目日志',exact:true}).click();await page.locator('.timeline-event h3').filter({hasText:'工作台优化验收记录'}).waitFor()
 })
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({status:'passed',checks,errors,profile,fixture,executable:packed||'development'},null,2))
}catch(e){if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(e)},null,2));throw e}
finally{if(app&&savedClipboard!==undefined)await app.evaluate(({clipboard}:any,text:string)=>clipboard.writeText(text),savedClipboard).catch(()=>{});await app?.close().catch(()=>{})}
