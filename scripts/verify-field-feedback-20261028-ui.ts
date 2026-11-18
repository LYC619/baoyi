// Build first. All writes and HTTP/model requests stay in this isolated local profile.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createServer} from 'node:http'
import {execFileSync} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'
import {_electron} from 'playwright'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {createProjectAgent} from '../electron/kinds/project/agent.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'

const output=path.resolve('output/review-2026-10-28');await fs.mkdir(output,{recursive:true})
const profile=await fs.mkdtemp(path.join(output,'fix-ui-'))
const root=path.join(profile,'project');await fs.mkdir(root)
for(const name of ['first','second']){
  const directory=path.join(root,name);await fs.mkdir(directory)
  for(const args of [['init','-q'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-qm','界面续接样本']])execFileSync('git',['-C',directory,...args])
}
let modelCalls=0
const requests:Array<{url:string;range?:string}>=[],serverErrors:string[]=[]
const server=createServer(async(req,res)=>{
  try{
    if(req.method!=='POST'){
      requests.push({url:req.url!,range:req.headers.range})
      const code=req.url==='/forbidden'?403:req.url==='/server-error'?500:200
      res.writeHead(code,{'content-type':'text/html','set-cookie':'fixture=local; Path=/'})
      res.end(req.url==='/challenge'?'<title>Just a moment</title>':req.url==='/large'?'<title>Local page</title>'+'x'.repeat(200000):'<title>Local page</title>');return
    }
    let raw='';for await(const chunk of req)raw+=chunk
    const body=JSON.parse(raw),last=body.messages.at(-1);modelCalls++
    const tool=(name:string,args:object)=>({role:'assistant',content:null,tool_calls:[{id:'local-'+modelCalls,type:'function',function:{name,arguments:JSON.stringify(args)}}]})
    let message:any
    if(last.role!=='tool')message=tool('read_project_history',{})
      else if(last.content.includes('"commits"')){const page=JSON.parse(last.content);message=tool('record_project_event',{title:'选定仓库后继续整理',body:'已按用户选择读取 second 仓库并保存日志。',commits:page.commits.map((c:any)=>c.sha)})}
      else message={role:'assistant',content:'所选仓库日志已保存。'}

    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message}],usage:{total_tokens:1}}))
  }catch(error){serverErrors.push(String(error));res.writeHead(400);res.end(String(error))}
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const base=`http://127.0.0.1:${(server.address() as any).port}`,config={enabled:true,api_key:'local-fixture',api_url:base,model:'fixture'}
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
const softwareId='field-software',softwareFile=path.join(profile,'return-fixture.exe');await fs.writeFile(softwareFile,'isolated navigation fixture')
db.prepare('INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,name_zh) VALUES(?,?,?,?,?,?,?)').run(softwareId,'software',Date.now(),Date.now(),softwareFile,'return-fixture.exe','返回路径验收')
for(const [key,value] of Object.entries({onboarded:true,theme:'dark',hanime_builtin_hosts:false,video_online_proxy:'',ai:config}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const project=new ProjectLibrary(db).register({path:root,name:'10.28 仓库选择验收',summary:'',category:'软件项目',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]})
let paused!:()=>void;const pause=new Promise<void>(resolve=>{paused=resolve})
const projectAgent=createProjectAgent({db,config:()=>config,run:async options=>{await options.tools.find(tool=>tool.name==='read_project_history')!.execute({});return {stopReason:'done',turns:1,tokens:0,error:'',text:'等待选择'}},paused:()=>paused()})
const projectSession=projectAgent.organize(project.id);await pause;projectAgent.dispose()
db.close()
const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const launch=()=>_electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[path.resolve('.'),'--user-data-dir='+profile,'--disable-gpu'],env,timeout:30000})
let app=await launch(),page=await app.firstWindow()
const errors:string[]=[],checks:string[]=[]
page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message))
try{
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile)
  await page.waitForFunction(()=>!!window.baoyi?.project?.selectRepository)
  await page.evaluate(id=>{location.hash='/detail/'+id},softwareId)
  await page.getByRole('button',{name:'返回',exact:true}).waitFor()
  for(const module of ['游戏','影视','文库'])await page.getByTitle('切换到'+module,{exact:true}).click()
  await page.getByTitle('切换到软件',{exact:true}).click()
  await page.getByRole('button',{name:'返回',exact:true}).click()
  await page.waitForFunction(()=>location.hash==='#/')
  checks.push('software-detail-back-goes-home-after-cross-module-switches')
  await page.evaluate(id=>{location.hash='/project/'+id},project.id)
  await page.getByRole('button',{name:'选择仓库',exact:true}).click()
  await page.screenshot({path:path.join(output,'fix-repository-choice.png')})
  await page.getByLabel('仓库子目录（相对于项目目录）').fill('second')
  await page.getByRole('button',{name:'使用此仓库并继续整理',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.chat-messages')?.textContent?.includes('所选仓库日志已保存'))
  const selected=await page.evaluate(id=>window.baoyi.project.session(id),projectSession.id)
  assert.equal(selected?.workflow?.state,'complete');assert.equal(selected?.repository?.repoPath,'second')
  assert.equal((await page.evaluate(id=>window.baoyi.project.sessions(id),project.id)).length,1)
  checks.push('native-repository-selection-resumes-same-session-and-saves-log')
  await page.screenshot({path:path.join(output,'fix-project.png')})
  await page.evaluate(()=>{location.hash='/settings?module=video&tab=online'})
  await page.getByLabel('代理规则',{exact:true}).fill('http://127.0.0.1:1')
  assert.equal(await page.getByRole('button',{name:'检查网页响应',exact:true}).isDisabled(),true)
  await page.getByText('代理规则尚未保存。',{exact:false}).waitFor()
  await page.getByLabel('代理规则',{exact:true}).fill('')
  await page.getByRole('button',{name:'保存代理',exact:true}).click()
  for(const [target,expected] of [['challenge','人机验证'],['forbidden','网站拒绝访问'],['server-error','服务器错误'],['normal','已收到网页响应'],['large','仅检查了网页开头']]){
    await page.getByLabel('检查已保存配置的目标网址').fill(base+'/'+target)
    await page.getByRole('button',{name:'检查网页响应',exact:true}).click()
    await page.getByRole('status').filter({hasText:expected}).waitFor()
    const status=await page.getByRole('status').filter({hasText:expected}).boundingBox(),button=await page.getByRole('button',{name:'检查网页响应',exact:true}).boundingBox()
    assert.ok(status&&button&&status.y<button.y,'检查反馈应紧邻按钮且出现在其上方')
    assert.doesNotMatch(await page.locator('.ws-card').innerText(),/连接成功/)
  }
  assert.equal(requests.length,5);assert.ok(requests.every(req=>!req.range))
  checks.push('native-electron-get-status-challenge-and-bounded-body-diagnostics','unsaved-route-guard-and-checking-state')
  await page.screenshot({path:path.join(output,'fix-network.png')})
  const before=modelCalls
  await app.close();app=await launch();page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>!!window.baoyi?.project)
  const restored=await page.evaluate(id=>window.baoyi.project.session(id),projectSession.id)
  assert.equal(restored?.repository?.repoPath,'second');assert.equal(restored?.workflow?.state,'complete')
  assert.equal(modelCalls,before)
  checks.push('native-restart-restores-selected-repository-without-regeneration')
  assert.deepEqual(errors,[]);assert.deepEqual(serverErrors,[])
  await fs.writeFile(path.join(output,'fix-ui.json'),JSON.stringify({status:'passed',checks,errors,serverErrors,profile,modelCalls,requests},null,2))
  console.log('PASS '+checks.join(', '))
}catch(error){await page.screenshot({path:path.join(output,'fix-ui-failure.png')}).catch(()=>{});await fs.writeFile(path.join(output,'fix-ui.json'),JSON.stringify({status:'failed',error:String(error),errors,serverErrors,profile,modelCalls,requests},null,2));throw error}
finally{await app.close();await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())})}
