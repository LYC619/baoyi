import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { ProjectLaunchProfiles } from '../electron/kinds/project/launch-profiles.ts'
import { inspectProject } from '../electron/kinds/project/scanner.ts'
const require=createRequire(import.meta.url),{_electron}=require('playwright')
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/p1-p2-project-2026-11-06/native-ui')
fs.mkdirSync(output,{recursive:true});const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=fs.mkdtempSync(path.join(output,'fixtures-'))
const alpha=path.join(fixture,"甲项目 & ' 中文"),beta=path.join(fixture,'乙项目');fs.mkdirSync(alpha);fs.mkdirSync(beta)
fs.writeFileSync(path.join(alpha,'server.cjs'),"const s=require('node:http').createServer((q,r)=>r.end('fixture'));s.listen(0,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+s.address().port+'/'));process.on('SIGBREAK',()=>s.close(()=>process.exit(0)));")
fs.writeFileSync(path.join(alpha,'package.json'),JSON.stringify({scripts:{dev:'node server.cjs'}}));fs.writeFileSync(path.join(alpha,'README.md'),'# 合成项目规则')
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value]of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false,project_preferences:{maxTurns:8,contextMessages:12,defaultSource:'unknown',defaultState:'active',defaultTab:'overview'}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const library=new ProjectLibrary(db),a=library.register(await inspectProject(alpha)),b=library.register(await inspectProject(beta))
const launch=new ProjectLaunchProfiles(db).save(a.id,{name:'合成 HTTP 服务',kind:'script',command:process.execPath,args:['server.cjs'],cwd:'',source:'manual',sourceRef:'server.cjs',port:null,url:'',enabled:true})
db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
let app:any,page:any;const checks:string[]=[],errors:string[]=[]
async function open(){app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',(error:Error)=>errors.push(error.message));assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile);await page.waitForFunction(()=>!!window.baoyi?.project?.launch)}
async function route(value:string){await page.evaluate((value:string)=>{location.hash=value},value)}
async function check(name:string,action:()=>Promise<void>){await action();checks.push(name);console.log('PASS '+name)}
async function notes(id=a.id){return page.evaluate((id:string)=>window.baoyi.workspace.timeline.context(id),id)}
async function until(action:()=>Promise<boolean>){const end=Date.now()+15000;while(!await action()){if(Date.now()>end)throw new Error('UI state timeout');await new Promise(r=>setTimeout(r,80))}}
try{
  await open();await route('/project/'+a.id+'?tab=notes');await page.getByLabel('当前情况',{exact:true}).waitFor();await until(()=>page.getByLabel('当前情况',{exact:true}).isEnabled())
  await check('便签自动保存、切项 flush 与卡片摘要；Prompt 和规则保持',async()=>{
    await page.getByLabel('当前情况',{exact:true}).fill('已完成第一阶段');await page.getByLabel('下一步',{exact:true}).fill('从验收继续')
    await page.getByRole('button',{name:'展开关键 Prompt 与规则'}).click();await page.locator('textarea.prompt').fill('保留我的交接提示词')
    await page.getByLabel('规则相对路径').fill('README.md');await page.getByRole('button',{name:'添加',exact:true}).click()
    await route('/project/'+b.id+'?tab=notes');await until(async()=>((await notes()).rules.length===1))
    assert.equal((await notes()).prompt,'保留我的交接提示词');assert.equal((await notes(b.id)).current,'')
    await route('/project');const card=page.locator(`[data-project-id="${a.id}"]`);await card.waitFor();assert.match(await card.innerText(),/已完成第一阶段/)
  })
  await check('保存冲突保持输入；比较后主动采用自己的版本',async()=>{
    await route('/project/'+a.id+'?tab=notes');await until(()=>page.getByLabel('当前情况',{exact:true}).isEnabled())
    await app.evaluate(({ipcMain}:any)=>{const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get('workspace:timeline:update-context');(globalThis as any).__save=original;handlers.set('workspace:timeline:update-context',()=>{throw new Error('隔离并发冲突')})})
    await page.getByLabel('下一步',{exact:true}).fill('我的未保存计划');await page.getByRole('alert').filter({hasText:'隔离并发冲突'}).waitFor()
    await route('/project/'+b.id);assert.match(await page.getByLabel('下一步',{exact:true}).inputValue(),/我的未保存计划/)
    await page.getByRole('button',{name:'比较最新内容',exact:true}).click();await page.getByRole('button',{name:'保留我的内容并保存',exact:true}).waitFor()
    await app.evaluate(({ipcMain}:any)=>(ipcMain as any)._invokeHandlers.set('workspace:timeline:update-context',(globalThis as any).__save))
    await page.getByRole('button',{name:'保留我的内容并保存',exact:true}).click();await until(async()=>(await notes()).next==='我的未保存计划')
  })
  await check('首次确认后真实运行，动态端口预览、跨模块运行与停止',async()=>{
    await page.getByRole('button',{name:'启动项目',exact:true}).click();await page.getByRole('button',{name:'运行',exact:true}).click()
    await page.getByRole('dialog',{name:'确认运行项目命令'}).waitFor();assert.match(await page.getByRole('dialog',{name:'确认运行项目命令'}).innerText(),/server.cjs/)
    await page.getByRole('button',{name:'确认运行',exact:true}).click();await page.getByRole('button',{name:'打开预览',exact:true}).waitFor()
    const running=await page.evaluate((id:string)=>window.baoyi.project.launch.runs(id),a.id);assert.equal(running.filter((r:any)=>r.status==='running').length,1)
    await app.evaluate(({shell}:any)=>{(globalThis as any).__open=shell.openExternal;shell.openExternal=async(url:string)=>{(globalThis as any).__url=url}})
    await page.getByRole('button',{name:'打开预览',exact:true}).click();await until(()=>app.evaluate(()=>typeof(globalThis as any).__url==='string'));assert.match(await app.evaluate(()=>(globalThis as any).__url),/^http:\/\/127\.0\.0\.1:\d+\//)
    await app.evaluate(({shell}:any)=>shell.openExternal=(globalThis as any).__open)
    await page.keyboard.press('Escape');await route('/personal');assert.equal((await page.evaluate((id:string)=>window.baoyi.project.launch.runs(id),a.id))[0].status,'running')
    await page.locator('.project-run-chip').click();await page.getByRole('button',{name:'停止',exact:true}).click();await page.getByRole('button',{name:'重跑命令',exact:true}).waitFor();await page.keyboard.press('Escape')
  })
  await check('卡片重跑直接使用当前信任；修改脚本后必须重新预览',async()=>{
    await route('/project');const card=page.locator(`[data-project-id="${a.id}"]`);await card.getByRole('button',{name:'重跑上次',exact:true}).click();await page.getByRole('button',{name:'停止',exact:true}).waitFor();await page.getByRole('button',{name:'停止',exact:true}).click();await until(async()=>!(await page.evaluate((id:string)=>window.baoyi.project.launch.runs(id),a.id)).some((r:any)=>r.status==='running'||r.status==='stopping'));await page.keyboard.press('Escape')
    fs.appendFileSync(path.join(alpha,'server.cjs'),'\n// source changed\n');await card.getByRole('button',{name:'重跑上次',exact:true}).click();await page.getByRole('dialog',{name:'确认运行项目命令'}).waitFor();await page.getByRole('button',{name:'返回',exact:true}).click();await page.keyboard.press('Escape')
  })
  await check('发现命令加入启动菜单，中文路径及 800/1024/1360 布局',async()=>{
    await route('/project/'+a.id+'?tab=overview');await page.getByRole('button',{name:'加入启动菜单',exact:true}).click();await page.getByRole('button',{name:'保存启动配置',exact:true}).waitFor();await page.getByRole('button',{name:'保存启动配置',exact:true}).click();await page.getByText('dev',{exact:true}).last().waitFor();await page.keyboard.press('Escape')
    for(const width of [800,1024,1360]){
      await app.evaluate(({BrowserWindow}:any,width:number)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width);await page.screenshot({path:path.join(output,`notes-${width}.png`)})
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2))
    }
  })
  await check('冷启动保留便签与启动配置，不自动启动命令',async()=>{
    await app.close();await open();await route('/project/'+a.id+'?tab=notes');await until(()=>page.getByLabel('当前情况',{exact:true}).isEnabled());assert.equal(await page.getByLabel('下一步',{exact:true}).inputValue(),'我的未保存计划')
    const profiles=await page.evaluate((id:string)=>window.baoyi.project.launch.profiles(id),a.id);assert.equal(profiles.length,2)
    assert.equal((await page.evaluate(()=>window.baoyi.project.launch.runs())).some((r:any)=>r.status==='running'),false)
  })
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:checks.length,checks,errors,profile,fixture,launchId:launch.id,packaged:!!packed},null,2))
  console.log(`PASS ${checks.length} project launch UI groups`)
}catch(error){if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:(error as Error).stack},null,2));throw error}
finally{if(app){try{await page.evaluate(async()=>{for(const run of await window.baoyi.project.launch.runs())if(['starting','running','stopping'].includes(run.status))await window.baoyi.project.launch.stop(run.id)})}catch{}await app.evaluate(({BrowserWindow}:any)=>{for(const win of BrowserWindow.getAllWindows())win.destroy()}).catch(()=>{});await app.close().catch(()=>{})}}
