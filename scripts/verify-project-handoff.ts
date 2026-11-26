import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {inspectProject} from '../electron/kinds/project/scanner.ts'
import {ProjectHandoffs,HANDOFF_TOOLS,projectWorkbenchSnapshot,projectHandoffPage} from '../electron/kinds/project/handoff.ts'
import {TimelineLibrary} from '../electron/workspace/timeline.ts'
import {ArchiveAssistant} from '../electron/archive/service.ts'
import {ArchiveRunSlot} from '../electron/archive/run-slot.ts'
import {ProjectApplications} from '../electron/kinds/project/applications.ts'
const config={enabled:true,model:'fixture',api_url:'http://fixture.invalid/v1',api_key:'fixture-only'}
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-handoff-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  t.after(async()=>{db.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'baoyi-handoff-')));await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50})})
  await fs.writeFile(path.join(root,'AGENTS.md'),'# 示例规则\n只做合成项目。');await fs.writeFile(path.join(root,'.env'),'DO_NOT_SEND_THIS=fixture')
  const project=new ProjectLibrary(db).register(await inspectProject(root)),timeline=new TimelineLibrary(db)
  timeline.updateContext(project.id,{...timeline.context(project.id),current:'已归档',next:'核对结果',rules:[{type:'path',label:'示例规则',value:'AGENTS.md'}]})
  return {root,db,project,timeline,handoffs:new ProjectHandoffs(db)}
}
test('默认发送范围不读取规则正文；授权后只读列出的规则，本地模板离线可用',async t=>{
  const {handoffs,project}=await fixture(t),preview=await handoffs.preview(project.id,config)
  assert.equal(preview.snapshot.rules.length,0);assert.ok(preview.localPrompt.includes('已归档'));assert.ok(!JSON.stringify(preview).includes('DO_NOT_SEND_THIS'))
  assert.equal((await handoffs.preview(project.id,{...config,enabled:false})).configured,false)
  const withRules=await handoffs.preview(project.id,config,true);assert.ok(withRules.snapshot.rules[0].content.includes('只做合成项目'))
  await handoffs.consume(withRules.token,withRules.stamp,config,true)
  const remembered=await handoffs.preview(project.id,config);assert.equal(remembered.remembered,true);assert.equal(remembered.includeRules,true)
  assert.equal((await handoffs.preview(project.id,{...config,api_url:'http://another.invalid'})).remembered,false)
})
test('预览后规则、便签变化使授权票据失效；旧票据不可重用',async t=>{
  const {handoffs,project,root,timeline}=await fixture(t),preview=await handoffs.preview(project.id,config,true)
  await fs.writeFile(path.join(root,'AGENTS.md'),'已变更规则')
  await assert.rejects(handoffs.consume(preview.token,preview.stamp,config,false),/变化/)
  const next=await handoffs.preview(project.id,config)
  timeline.updateContext(project.id,{...timeline.context(project.id),current:'用户的新进度'})
  await assert.rejects(handoffs.consume(next.token,next.stamp,config,false),/变化/)
  await assert.rejects(handoffs.consume(next.token,next.stamp,config,false),/失效/)
})
test('限定工作流拒绝普通写工具、错误会话；取消后迟到工具不得产生结果',async t=>{
  const {root,db}=await fixture(t),assistant=new ArchiveAssistant({db,home:root,runtime:root,bridge:root,assets:root,hideHentai:()=>true,current:()=>true,config:()=>config,event:()=>{},changed:()=>{},operation:async action=>action(),updateResource:()=>{throw new Error('不得写入')}})
  t.after(()=>assistant.dispose());assistant.runtime.start=async()=>{}
  let executed=0
  assistant.runtime.request=async(method:string,args:any={})=>{
    if(method==='run'){
      assert.equal(args.workflow,'project_prompt');assert.deepEqual(args.tools,HANDOFF_TOOLS)
      await assert.rejects((assistant as any).execute(args.sessionId,'archive_update',{}),/未授权/)
      await assert.rejects((assistant as any).execute('other','archive_project_workbench',{}),/未授权/)
      await (assistant as any).execute(args.sessionId,'archive_project_workbench',{});assert.equal(executed,1)
      await assistant.cancel()
      await assert.rejects((assistant as any).execute(args.sessionId,'submit_project_prompt',{}),/停止/)
      return {completed:true,sessionId:args.sessionId} as any
    }
    return true as any
  }
  await assert.rejects(assistant.runWorkflow({kind:'project_prompt',text:'合成任务',config,tools:HANDOFF_TOOLS,system:'fixture',execute:async()=>{executed++;return {ok:true}}}),/停止/)
  assert.equal(executed,1);assert.equal(assistant.running,null)
})
test('模型单槽优先交互；后台分块间让出，排队取消不会启动',async()=>{
  const slot=new ArchiveRunSlot(),order:string[]=[];let finish!:()=>void
  const first=slot.run(async()=>{order.push('first');await new Promise<void>(resolve=>finish=resolve)},{priority:'background'})
  const second=slot.run(async()=>{order.push('background')},{priority:'background'})
  const interactive=slot.run(async()=>{order.push('interactive')})
  const controller=new AbortController(),cancelled=slot.run(async()=>{order.push('must-not-start')},{signal:controller.signal})
  controller.abort(new Error('cancel'));const rejected=assert.rejects(cancelled,/cancel/)
  await new Promise(setImmediate);finish();await Promise.all([first,second,interactive,rejected]);assert.deepEqual(order,['first','interactive','background'])
})
test('编辑器探测使用已安装路径；自选保存，失效后可重新选择',async t=>{
  const {root,db}=await fixture(t),apps=new ProjectApplications(db,{LOCALAPPDATA:root}),exe=path.join(root,'Programs','Microsoft VS Code','Code.exe')
  await fs.mkdir(path.dirname(exe),{recursive:true});await fs.writeFile(exe,'synthetic-not-executed')
  assert.equal((await apps.list()).find(x=>x.id==='vscode')!.available,true)
  assert.equal((await apps.list()).find(x=>x.id==='cursor')!.available,false)
  await apps.select('cursor',exe);assert.equal((await apps.list()).find(x=>x.id==='cursor')!.available,true)
  await assert.rejects(apps.select('cursor',path.join(root,'AGENTS.md')),/EXE/)
  await fs.unlink(exe);assert.equal((await apps.list()).find(x=>x.id==='cursor')!.available,false)
})
test('只读工作台返回便签和配置，不读取其他正文或改变资料',async t=>{
  const {db,project,timeline}=await fixture(t),before=timeline.context(project.id)
  const snapshot=await projectWorkbenchSnapshot(db,project.id)
  assert.equal(snapshot.contextRevision,before.revision);assert.deepEqual(snapshot.context,before);assert.deepEqual(snapshot.launchers,[])
  assert.ok(!JSON.stringify(snapshot).includes('DO_NOT_SEND_THIS'));assert.deepEqual(timeline.context(project.id),before)
})
test('自选应用真实启动：目录作为单个参数，继承环境不含模型密钥',async t=>{
  const {root,db}=await fixture(t),apps=new ProjectApplications(db,{...process.env,OPENAI_API_KEY:'must-not-pass'})
  const directory=path.join(root,"中文 & ' 文件夹"),marker=path.join(directory,'opened.json');await fs.mkdir(directory)
  await fs.writeFile(path.join(directory,'index.js'),"require('fs').writeFileSync(require('path').join(__dirname,'opened.json'),JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),secret:!!process.env.OPENAI_API_KEY}))")
  await apps.select('cursor',process.execPath);await apps.open('cursor',directory)
  let value:any
  for(let i=0;i<60;i++){try{value=JSON.parse(await fs.readFile(marker,'utf8'));break}catch{await new Promise(resolve=>setTimeout(resolve,30))}}
  assert.ok(value,'实际子进程必须收到目录并运行合成入口');assert.equal(value.secret,false);assert.equal(value.cwd,directory);assert.deepEqual(value.args,[directory])
})

test('长便签按编码后预算分页，保留特殊字符并可完整拼接',()=>{
  const original={current:'中文 "\n😀'.repeat(5000),rules:[{label:'规则',path:'README.md'}]}
  let offset=0,text='',pages=0
  while(true){const page=projectHandoffPage(original,offset) as any;assert.ok(JSON.stringify(page).length<=18000);text+=page.text;pages++;if(page.next===null)break;assert.ok(page.next>offset);offset=page.next}
  assert.ok(pages>2);assert.deepEqual(JSON.parse(text),original)
})
