import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { ProjectLaunchProfiles } from '../electron/kinds/project/launch-profiles.ts'
import { inspectProject } from '../electron/kinds/project/scanner.ts'
const require=createRequire(import.meta.url),{_electron}=require('playwright')
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/p1-p2-project-2026-11-06/native-second')
fs.mkdirSync(output,{recursive:true});const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=fs.mkdtempSync(path.join(output,'fixtures-'))
const alpha=path.join(fixture,"甲项目 & ' 中文"),beta=path.join(fixture,'乙项目');fs.mkdirSync(alpha);fs.mkdirSync(beta)
fs.writeFileSync(path.join(alpha,'server.cjs'),"const s=require('node:http').createServer((q,r)=>r.end('fixture'));s.listen(0,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+s.address().port+'/'));process.on('SIGBREAK',()=>s.close(()=>process.exit(0)));")
fs.writeFileSync(path.join(alpha,'package.json'),JSON.stringify({scripts:{dev:'node server.cjs'}}));fs.writeFileSync(path.join(alpha,'README.md'),'# 合成项目规则')
const requests:any[]=[];let calls=0
const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'||!req.url?.includes('chat/completions')){res.writeHead(404);res.end();return}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk)
  const body=JSON.parse(Buffer.concat(chunks).toString()),messages=body.messages
  requests.push(body)
  const results=messages.filter((m:any)=>m.role==='tool'),parsed=results.map((r:any)=>{try{return JSON.parse(r.content)}catch{return null}})
  const snapshot=parsed.find((r:any)=>r?.context?.revision!==undefined),rule=parsed.find((r:any)=>r?.content?.includes('合成项目规则'))
  let tool:any=null
  if(!results.length)tool={name:'archive_update',arguments:JSON.stringify({changes:[],reason:'malicious-fixture-attempt'})}
  else if(!snapshot)tool={name:'archive_project_workbench',arguments:'{}'}
  else if(snapshot.rules.length&&!rule)tool={name:'archive_project_rule',arguments:JSON.stringify({path:'README.md'})}
  else if(!parsed.some((r:any)=>r?.submitted))tool={name:'submit_project_prompt',arguments:JSON.stringify({goal:'核对当前归档结果',facts:[snapshot.context.current],constraints:['保留既有文件'],prompt:'下一步：'+snapshot.context.next+'。核对来源后给出归档结果。',acceptance:['原文件不变','核验摘要与来源']})}
  const id='fixture-'+(++calls),answer=tool?'':'交接 Prompt 已生成，等待用户采用。'
  res.writeHead(200,{'Content-Type':body.stream?'text/event-stream':'application/json'})
  if(body.stream){
    const delta=tool?{tool_calls:[{index:0,id,type:'function',function:tool}]}:{content:answer}
    res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n')
    res.end('data: '+JSON.stringify({id,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:200,completion_tokens:40,total_tokens:240}})+'\n\ndata: [DONE]\n\n')
  }else res.end(JSON.stringify({id,choices:[{index:0,message:{role:'assistant',content:answer,...(tool?{tool_calls:[{id,type:'function',function:tool}]}:{})},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:200,completion_tokens:40,total_tokens:240}}))
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const modelPort=(server.address() as any).port
fs.writeFileSync(path.join(alpha,'.env'),'SECRET_CANARY_NOT_TO_SEND=fixture')
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value]of Object.entries({ai:{enabled:true,model:'fixture',api_url:`http://127.0.0.1:${modelPort}/v1`,api_key:'fixture-only'},onboarded:true,theme:'light',hanime_builtin_hosts:false,project_preferences:{maxTurns:8,contextMessages:12,defaultSource:'unknown',defaultState:'active',defaultTab:'overview'}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const library=new ProjectLibrary(db),a=library.register(await inspectProject(alpha)),b=library.register(await inspectProject(beta))
const launch=new ProjectLaunchProfiles(db).save(a.id,{name:'合成 HTTP 服务',kind:'script',command:process.execPath,args:['server.cjs'],cwd:'',source:'manual',sourceRef:'server.cjs',port:null,url:'',enabled:true})
db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
let app:any,page:any;const checks:string[]=[],errors:string[]=[]
async function open(){app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',(error:Error)=>errors.push(error.message));assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile);await page.waitForFunction(()=>!!window.baoyi?.project?.launch)}
async function size(width:number){
  await app.evaluate(({BrowserWindow}:any,width:number)=>{const win=BrowserWindow.getAllWindows()[0];win.setMinimumSize(640,600);win.setContentSize(width,900)},width)
  let requested=width
  for(let attempt=0;attempt<4;attempt++){
    await page.waitForTimeout(60);const actual=await page.evaluate(()=>innerWidth);if(actual===width)return
    requested+=width-actual;await app.evaluate(({BrowserWindow}:any,requested:number)=>BrowserWindow.getAllWindows()[0].setContentSize(requested,900),requested)
  }
  assert.equal(await page.evaluate(()=>innerWidth),width)
}
async function route(value:string){await page.evaluate((value:string)=>{location.hash=value},value)}
async function check(name:string,action:()=>Promise<void>){console.log('RUN '+name);await action();checks.push(name);console.log('PASS '+name)}
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
    await page.keyboard.press('Escape');await page.getByRole('button',{name:/^项目日志：/}).click();await page.getByRole('region',{name:'项目命令运行'}).waitFor();await page.getByRole('button',{name:'查看输出与运行详情',exact:true}).first().click();await page.getByRole('button',{name:'停止',exact:true}).waitFor();await page.keyboard.press('Escape');await route('/personal');assert.equal((await page.evaluate((id:string)=>window.baoyi.project.launch.runs(id),a.id))[0].status,'running')
    await page.locator('.project-run-chip').click();await page.getByRole('button',{name:'停止',exact:true}).click();await page.getByRole('button',{name:'重跑命令',exact:true}).waitFor();await page.keyboard.press('Escape')
  })
  await check('卡片重跑直接使用当前信任；修改脚本后必须重新预览',async()=>{
    await route('/project');const card=page.locator(`[data-project-id="${a.id}"]`);await card.getByRole('button',{name:'重跑上次',exact:true}).click();await page.getByRole('button',{name:'停止',exact:true}).waitFor();await page.getByRole('button',{name:'停止',exact:true}).click();await until(async()=>!(await page.evaluate((id:string)=>window.baoyi.project.launch.runs(id),a.id)).some((r:any)=>r.status==='running'||r.status==='stopping'));await page.keyboard.press('Escape')
    fs.appendFileSync(path.join(alpha,'server.cjs'),'\n// source changed\n');await card.getByRole('button',{name:'重跑上次',exact:true}).click();await page.getByRole('dialog',{name:'确认运行项目命令'}).waitFor();await page.getByRole('button',{name:'返回',exact:true}).click();await page.keyboard.press('Escape')
  })
  await check('发现命令加入启动菜单，中文路径及 800/1024/1360 布局',async()=>{
    await route('/project/'+a.id+'?tab=overview');await page.getByRole('button',{name:'加入启动菜单',exact:true}).click();await page.getByRole('button',{name:'保存启动配置',exact:true}).waitFor();await page.getByRole('button',{name:'保存启动配置',exact:true}).click();await page.getByText('dev',{exact:true}).last().waitFor();await until(()=>page.getByRole('button',{name:'关闭对话框',exact:true}).isEnabled());await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'})
    for(const width of [800,1024,1360]){
      await size(width);await page.screenshot({path:path.join(output,`notes-${width}.png`)})
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2))
    }
  })
  await check('便签快捷键、复制与规则状态；应用入口',async()=>{
    await route('/project/'+a.id+'?tab=notes');await until(()=>page.getByLabel('下一步',{exact:true}).isEnabled());await page.keyboard.press('Control+Shift+M');assert.equal(await page.getByLabel('下一步',{exact:true}).evaluate((e:any)=>e===document.activeElement),true)
    await page.keyboard.press('Control+Enter');await page.getByRole('button',{name:'展开关键 Prompt 与规则',exact:false}).click()
    await page.getByRole('button',{name:'复制 Prompt',exact:true}).click()
    assert.equal(await app.evaluate(({clipboard}:any)=>clipboard.readText()),'保留我的交接提示词')
    assert.match(await page.locator('.rule-link').innerText(),/可用/)
    await page.keyboard.press('Control+Shift+L');await page.getByRole('dialog',{name:a.name+' · 启动'}).waitFor()
    await until(async()=>await page.getByRole('button',{name:/^(选择 )?(VS Code|Cursor)$/}).count()===2)
    await page.keyboard.press('Escape')
  })
  await check('限定 Hermes 生成闭环、规则范围、恶意写工具拒绝与显式采用',async()=>{
    await page.getByRole('button',{name:'生成下一步 Prompt',exact:true}).click()
    await page.getByText('核对实际发送内容',{exact:true}).waitFor();const before=await notes()
    await page.getByLabel('同时发送项目内规则文件正文',{exact:false}).check()
    await page.getByLabel('记住此项目的发送范围',{exact:false}).check()
    await until(()=>page.getByRole('button',{name:'生成 Prompt',exact:true}).isEnabled())
    await page.getByRole('button',{name:'生成 Prompt',exact:true}).click()
    await page.getByLabel('生成的下一步 Prompt').waitFor({timeout:120000})
    assert.equal((await notes()).prompt,before.prompt)
    assert.match(await page.getByLabel('生成的下一步 Prompt').inputValue(),/我的未保存计划/)
    await page.getByRole('button',{name:'设为关键 Prompt',exact:true}).click();await page.getByRole('button',{name:'已采用',exact:true}).waitFor()
    assert.match((await notes()).prompt,/核对来源/)
    for(const request of requests)assert.deepEqual(request.tools.map((t:any)=>t.function.name).sort(),['archive_project_rule','archive_project_workbench','submit_project_prompt'])
    assert.ok(!JSON.stringify(requests).includes('SECRET_CANARY_NOT_TO_SEND'))
    assert.equal((await page.evaluate(()=>window.baoyi.archive.actions())).length,0)
    await page.keyboard.press('Escape')
  })
  await check('记住范围可再次一键生成；并发编辑保护，规则变化重新展示',async()=>{
    await page.getByRole('button',{name:'生成下一步 Prompt',exact:true}).click()
    await page.getByLabel('生成的下一步 Prompt').waitFor({timeout:120000})
    await page.evaluate(async(id:string)=>{const value=await window.baoyi.workspace.timeline.context(id);await window.baoyi.workspace.timeline.updateContext(id,{...value,prompt:'用户刚刚修改的 Prompt'})},a.id)
    await page.getByRole('button',{name:'设为关键 Prompt',exact:true}).click();await page.getByRole('alert').filter({hasText:'便签已更新'}).waitFor()
    assert.equal((await notes()).prompt,'用户刚刚修改的 Prompt');await page.keyboard.press('Escape')
    fs.appendFileSync(path.join(alpha,'README.md'),'\n新的规则')
    const before=requests.length;await page.getByRole('button',{name:'生成下一步 Prompt',exact:true}).click();await page.getByRole('button',{name:'生成 Prompt',exact:true}).waitFor();assert.equal(requests.length,before)
    await page.getByRole('button',{name:'复制本地交接模板',exact:true}).click();assert.match(await app.evaluate(({clipboard}:any)=>clipboard.readText()),/用户刚刚修改的 Prompt/)
    await page.screenshot({path:path.join(output,'handoff-preview-light.png')});await page.keyboard.press('Escape')
  })
  await check('暗色与实际800/1024/1360内容宽度无横向溢出',async()=>{
    await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'))
    for(const width of [800,1024,1360]){
      await size(width)
      assert.equal(await page.evaluate(()=>innerWidth),width);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.ok(await page.locator('.titlebar .tab>span:first-child').evaluateAll((nodes:any[])=>nodes.every(node=>node.getBoundingClientRect().height<25)))
      await page.screenshot({path:path.join(output,`project-dark-${width}.png`)})
    }
  })
  await check('冷启动保留便签与启动配置，不自动启动命令',async()=>{
    await app.close();await open();await route('/project/'+a.id+'?tab=notes');await until(()=>page.getByLabel('当前情况',{exact:true}).isEnabled());assert.equal(await page.getByLabel('下一步',{exact:true}).inputValue(),'我的未保存计划')
    const profiles=await page.evaluate((id:string)=>window.baoyi.project.launch.profiles(id),a.id);assert.equal(profiles.length,2)
    assert.equal((await page.evaluate(()=>window.baoyi.project.launch.runs())).some((r:any)=>r.status==='running'),false)
  })
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:checks.length,checks,errors,profile,fixture,launchId:launch.id,packaged:!!packed,requests:requests.length},null,2))
  console.log(`PASS ${checks.length} project launch UI groups`)
}catch(error){if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:(error as Error).stack},null,2));throw error}
finally{if(app){try{await page.evaluate(async()=>{for(const run of await window.baoyi.project.launch.runs())if(['starting','running','stopping'].includes(run.status))await window.baoyi.project.launch.stop(run.id)})}catch{}await app.evaluate(({BrowserWindow}:any)=>{for(const win of BrowserWindow.getAllWindows())win.destroy()}).catch(()=>{});await app.close().catch(()=>{})}server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
