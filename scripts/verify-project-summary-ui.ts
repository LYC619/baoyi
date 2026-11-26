import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createServer} from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {_electron} from 'playwright'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {TimelineLibrary} from '../electron/workspace/timeline.ts'
const output=path.resolve('output/agent-revision');await fs.mkdir(output,{recursive:true});const profile=await fs.mkdtemp(path.join(output,'summary-ui-'))
let calls=0
const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls++
  const kind=calls<=3?'week':'version',key=kind==='week'?'2026-10-19':'v1',phase=(calls-1)%3
  const result=body.messages.filter((m:any)=>m.role==='tool').at(-1),source=result?JSON.parse(result.content):null
  const message=phase<2?{role:'assistant',content:null,tool_calls:[{id:'summary-'+calls,type:'function',function:{name:phase===0?'read_project_summary_sources':'save_project_summary',arguments:JSON.stringify(phase===0?{kind,key}:{kind,key,stamp:source.stamp,title:'入口与保存',body:'已实现入口并修复保存。入口尚未验收，不能当作全部通过。'})}}]}:{role:'assistant',content:'摘要已保存，保留原始事件来源。'}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message}],usage:{total_tokens:1}}))
});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false,ai:{enabled:true,api_key:'fixture',api_url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,model:'fixture'}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const project=new ProjectLibrary(db).register({path:profile,name:'项目摘要验收',summary:'',category:'软件项目',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]})
new TimelineLibrary(db).save(project.id,{title:'实现入口',body:'入口尚未验收。',occurredAt:new Date(2026,9,20,12).getTime(),milestone:false,version:'v1'});new TimelineLibrary(db).save(project.id,{title:'修复保存',body:'保存测试通过。',occurredAt:new Date(2026,9,21,12).getTime(),milestone:false,version:'v1'});db.close()
const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const launch=()=>_electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[path.resolve('.'),'--user-data-dir='+profile,'--disable-gpu'],env,timeout:30000})
let app=await launch(),page=await app.firstWindow();const errors:string[]=[],checks:string[]=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
try {
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile);await page.waitForFunction(()=>!!window.baoyi?.workspace)
  await page.evaluate(id=>{location.hash='/project/'+id},project.id);await page.getByRole('button',{name:'周',exact:true}).click();await page.getByRole('button',{name:'生成本组摘要',exact:true}).click();await page.locator('.timeline-summary-body').waitFor()
  assert.match(await page.locator('.timeline-summary-body').innerText(),/尚未验收/);assert.equal((await page.evaluate(id=>window.baoyi.workspace.timeline.events(id),project.id)).length,2)
  await page.getByRole('button',{name:'编辑摘要',exact:true}).click();await page.getByLabel('摘要内容',{exact:true}).fill('人工保留：入口需手动验收。');await page.getByRole('button',{name:'保存摘要',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  assert.equal(await page.getByRole('button',{name:'重新生成摘要',exact:true}).count(),0);checks.push('actual-week-summary-without-duplicate-events','manual-summary-edit-protected')
  await page.getByRole('button',{name:'版本',exact:true}).click();await page.getByRole('button',{name:'生成本组摘要',exact:true}).click();await page.locator('.timeline-summary-body').waitFor();await page.getByRole('button',{name:'撤销摘要',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.timeline-summary-body').length===0);checks.push('version-summary-undo-retains-original-events')
  await app.close();app=await launch();page=await app.firstWindow();await page.waitForFunction(()=>!!window.baoyi?.workspace);await page.evaluate(id=>{location.hash='/project/'+id},project.id);await page.getByRole('button',{name:'周',exact:true}).click();await page.locator('.timeline-summary-body').waitFor();assert.match(await page.locator('.timeline-summary-body').innerText(),/人工保留/);checks.push('restart-keeps-revised-summary')
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,'project-summary.png')});await fs.writeFile(path.join(output,'project-summary-ui.json'),JSON.stringify({status:'passed',checks,errors,profile},null,2));console.log('PASS '+checks.join(', '))
}catch(error){await page.screenshot({path:path.join(output,'project-summary-ui-failure.png')}).catch(()=>{});throw error}
finally{await app.close();await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())})}
