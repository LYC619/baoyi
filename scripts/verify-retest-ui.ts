import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import {createRequire} from 'node:module'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {inspectProject} from '../electron/kinds/project/scanner.ts'
import {ImageLibrary} from '../electron/kinds/image/library.ts'
import {scanImageImport} from '../electron/kinds/image/scanner.ts'
import {insertGame} from '../electron/kinds/game/db.ts'
const require=createRequire(import.meta.url)
const {_electron}=require(process.env.BAOYI_PLAYWRIGHT||'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output=path.resolve('output/retest-20261006');fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-retest-ui-'))
const course=path.join(root,'大学物理--清华张云翼老师主讲'),audio=path.join(root,'山水音乐'),photos=path.join(root,'秋日相册'),project=path.join(root,'写作项目')
for(const dir of [course,audio,photos,project])fs.mkdirSync(dir)
for(let i=1;i<=14;i++)fs.writeFileSync(path.join(course,`${i}.章节${i}.mp4`),'synthetic media')
const wav=Buffer.alloc(44+44100*2*5);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(44100,24);wav.writeUInt32LE(88200,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
for(const name of ['01.晨曲.wav','02.夜曲.wav'])fs.writeFileSync(path.join(audio,name),wav)
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7wAAAABJRU5ErkJggg==','base64')
fs.writeFileSync(path.join(photos,'1.png'),png);fs.writeFileSync(path.join(photos,'2.png'),png)
fs.writeFileSync(path.join(project,'README.md'),'# 写作项目\n\n用于整理调研资料和撰写报告的项目。主要入口是正文.md。')
fs.writeFileSync(path.join(project,'正文.md'),'# 正文\n继续写作')
const requests:any[]=[]
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part
  const body=JSON.parse(raw);requests.push(body)
  const last=body.messages.at(-1)
  let message:any
  if(last.role==='user')message={role:'assistant',content:'正在读取项目说明。',tool_calls:[{id:'read-project',type:'function',function:{name:'read_project_file',arguments:JSON.stringify({path:'README.md'})}}]}
  else if(last.tool_call_id==='read-project')message={role:'assistant',content:'已找到项目用途。',tool_calls:[{id:'propose-project',type:'function',function:{name:'propose_project_update',arguments:JSON.stringify({summary:'整理调研资料并撰写报告，主要入口为正文.md。',category:'调研写作',tags:['调研','写作']})}}]}
  else message={role:'assistant',content:'这个项目用于调研写作，正文.md 是主要入口。已提出资料建议，可核对后应用。'}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}],usage:{total_tokens:50}}))
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
for(const [key,value] of Object.entries({onboarded:true,theme:'dark',hanime_builtin_hosts:false,hide_hentai:false,ai:{enabled:true,api_url:`http://127.0.0.1:${port}`,api_key:'synthetic-test-only',model:'synthetic-project-model'}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const projectItem=new ProjectLibrary(db).register(await inspectProject(project)),imageLibrary=new ImageLibrary(db),imageItem=imageLibrary.register((await scanImageImport(photos,'photo',false))[0])
imageLibrary.saveGroup({name:'旅行'})
const imagePages=imageLibrary.pages(imageItem.id)

const game=insertGame(db,{exe_path:path.join(root,'game.exe'),source_dir:root,file_size:1,name_zh:'分类测试游戏',name_en:'',summary:'',description:'',category:'实测新分类',tags:[],official_url:'',save_paths:[],linked_files:[]})
db.close()
const packed=!!process.argv[2],executable=path.resolve(process.argv[2]||'node_modules/electron/dist/electron.exe'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const args=[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu']
let app=await _electron.launch({executablePath:executable,args,env,timeout:30000})
const checks:string[]=[],errors:string[]=[]
try {
  assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile)
  let page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',(error:Error)=>errors.push(error.message))
  await page.waitForFunction(()=>!!window.baoyi?.project);await page.evaluate(()=>{location.hash='/game'})
  await page.waitForURL(/game/);await page.evaluate(()=>{location.hash='/settings?tab=taxonomy'})
  await page.waitForFunction(()=>Array.from(document.querySelectorAll<HTMLInputElement>('.cats input')).some(e=>e.value==='实测新分类'))
  assert.ok((await page.locator('.cats input').evaluateAll((els:HTMLInputElement[])=>els.map(e=>e.value))).includes('实测新分类'))
  await page.evaluate((id:string)=>window.baoyi.game.update(id,{category:'后续新分类'}),game.id)
  await page.evaluate(()=>{location.hash='/game'});await page.waitForURL(/game/);await page.evaluate(()=>{location.hash='/settings?tab=taxonomy'})
  await page.waitForFunction(()=>Array.from(document.querySelectorAll<HTMLInputElement>('.cats input')).some(e=>e.value==='后续新分类'))
  checks.push('game-history-and-new-category-settings')
  await page.evaluate(()=>{location.hash='/video'});await page.waitForURL(/video/)
  let batch=await page.evaluate((root:string)=>window.baoyi.videoImport.prepare([root]),course)
  assert.equal(batch.entries.length,1);assert.equal(batch.entries[0].episodeCount,14);assert.notEqual(batch.entries[0].status,'skipped')
  await page.evaluate((b:any)=>window.baoyi.videoImport.confirm(b.id,b.entries.map((e:any)=>e.id)),batch)
  let videos=await page.evaluate(()=>window.baoyi.video.list());const courseItem=videos.find((v:any)=>v.path===course);assert.ok(courseItem);assert.equal(courseItem.media_kind,'other')
  const removal=await page.evaluate((id:string)=>window.baoyi.video.previewRemoval({resourceIds:[id],action:'remove',deleteLocal:false}),courseItem.id)
  await page.evaluate((value:any)=>window.baoyi.video.applyRemoval(value),removal)
  batch=await page.evaluate((root:string)=>window.baoyi.videoImport.prepare([root]),course)
  assert.equal(batch.entries.length,1);assert.notEqual(batch.entries[0].status,'skipped')
  await page.evaluate((b:any)=>window.baoyi.videoImport.confirm(b.id,b.entries.map((e:any)=>e.id)),batch)
  await page.reload();await page.waitForFunction(()=>!!window.baoyi?.video)
  await page.getByRole('button',{name:'批量管理',exact:true}).click();await page.getByRole('button',{name:'创建合集',exact:true}).waitFor();await page.getByRole('button',{name:'退出批量管理',exact:true}).click()
  checks.push('course-14-chapters-explicit-reimport-bulk-collection')
  const audioBatch=await page.evaluate((root:string)=>window.baoyi.videoImport.prepare([root]),audio)
  assert.equal(audioBatch.entries.length,1)
  await page.evaluate((b:any)=>window.baoyi.videoImport.confirm(b.id,b.entries.map((e:any)=>e.id)),audioBatch)
  await page.reload();await page.locator('.sidebar .row').filter({hasText:'音频'}).first().click();await page.locator('.audio-row').nth(1).waitFor()
  assert.equal(await page.locator('.audio-row:not(.audio-head)').count(),2)
  await page.getByRole('button',{name:/^播放 01/}).click();await page.locator('audio').waitFor()
  await page.locator('audio').evaluate((audio:HTMLAudioElement)=>{audio.muted=true;return audio.play()})
  await page.waitForFunction(()=>{const audio=document.querySelector('audio');return audio && audio.currentTime>0 && !audio.paused})
  await page.screenshot({path:path.join(output,'audio-dark.png')});await page.locator('audio').evaluate((audio:HTMLAudioElement)=>audio.pause())
  checks.push('audio-import-track-list-real-local-playback')
  await page.evaluate((id:string)=>{location.hash='/image/'+id},imageItem.id)
  await page.getByRole('button',{name:'选择或替换封面',exact:true}).click();await page.getByLabel('设第 2 页为封面',{exact:true}).click()
  assert.equal((await page.evaluate((id:string)=>window.baoyi.image.get(id),imageItem.id)).coverPageId,imagePages[1].id)
  await page.getByRole('tab',{name:'资料信息',exact:true}).click();await page.getByLabel('照片元数据').waitFor();assert.match(await page.getByLabel('照片元数据').innerText(),/图像规格/)
  await page.screenshot({path:path.join(output,'photo-dark.png')})
  await page.evaluate(()=>{location.hash='/image'});await page.getByRole('button',{name:'照片',exact:true}).click();assert.equal(await page.locator('.image-types').count(),0);checks.push('photo-isolated-cover-metadata')
  await page.evaluate((id:string)=>{location.hash='/project/'+id},projectItem.id);await page.getByRole('button',{name:'让助手了解项目',exact:true}).waitFor()
  await page.getByRole('button',{name:'让助手了解项目',exact:true}).click();await page.getByRole('button',{name:'应用资料建议',exact:true}).waitFor()
  await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('.chat-proposal button')?.disabled)
  assert.ok(requests.some(body=>body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('正文.md'))))
  await page.getByRole('button',{name:'应用资料建议',exact:true}).click()
  assert.equal((await page.evaluate((id:string)=>window.baoyi.project.get(id),projectItem.id)).summary,'整理调研资料并撰写报告，主要入口为正文.md。')
  await page.getByLabel('给项目助手发消息',{exact:true}).fill('接下来做什么？');await page.getByRole('button',{name:'发送',exact:true}).click()
  await page.waitForFunction(()=>document.querySelectorAll('.chat-message.assistant').length===2&&document.querySelectorAll('.chat-proposal').length===2)
  await page.waitForFunction(()=>!document.querySelector('.chat-composer button')?.textContent?.includes('停止'))
  assert.ok(requests.at(-1).messages.filter((m:any)=>m.role==='user').length>=2)
  await page.screenshot({path:path.join(output,'project-chat-dark.png')})
  await page.getByRole('button',{name:'助手设置',exact:true}).click();await page.getByRole('button',{name:'保存项目偏好',exact:true}).waitFor()
  assert.equal(await page.locator('.head__module').innerText(),'项目')
  await page.getByRole('button',{name:'保存项目偏好',exact:true}).click();await page.getByText('已保存',{exact:true}).waitFor()
  await page.getByRole('button',{name:'AI 配置',exact:true}).click();await page.getByRole('button',{name:'项目偏好',exact:true}).click()
  await page.screenshot({path:path.join(output,'project-settings-dark.png')});checks.push('project-agent-real-http-tools-history-proposal-settings')
  await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(960,640))
  await page.evaluate((id:string)=>{location.hash='/project/'+id},projectItem.id);await page.getByRole('tab',{name:'项目助手',exact:true}).click()
  await page.screenshot({path:path.join(output,'project-chat-960.png')})
  assert.equal(await page.locator('.project-workbench').evaluate((el:HTMLElement)=>el.scrollWidth>el.clientWidth),false)
  await page.evaluate(()=>{document.documentElement.setAttribute('data-theme','light')});await page.screenshot({path:path.join(output,'project-chat-light.png')})
  const sessions=await page.evaluate((id:string)=>window.baoyi.project.sessions(id),projectItem.id);assert.equal(sessions.length,1)
  await app.close();app=await _electron.launch({executablePath:executable,args,env,timeout:30000});page=await app.firstWindow();await page.waitForFunction(()=>!!window.baoyi?.project)
  const restored=await page.evaluate((id:string)=>window.baoyi.project.session(id),sessions[0].id);assert.equal(restored.messages.length,4);assert.equal(restored.messages[1].proposal.applied,true)
  assert.equal((await page.evaluate((id:string)=>window.baoyi.image.get(id),imageItem.id)).coverPageId,imagePages[1].id)
  assert.equal(fs.readdirSync(course).filter(f=>f.endsWith('.mp4')).length,14);checks.push('restart-persistence-minimum-window-themes-original-files')
  const importedRoot=path.join(root,'自动登记项目');fs.mkdirSync(importedRoot);fs.writeFileSync(path.join(importedRoot,'README.md'),'# 自动登记项目\n\n用于整理调研资料和撰写报告的项目。主要入口是正文.md。')
  await app.evaluate(({dialog}:any,target:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[target]})},importedRoot)
  await page.evaluate(()=>{location.hash='/project'});await page.getByRole('button',{name:'添加项目',exact:true}).first().click();await page.getByRole('button',{name:'导入一个项目',exact:false}).click();await page.locator('.pj-candidate').waitFor();await page.getByRole('button',{name:'导入所选项目',exact:true}).click();await page.getByRole('dialog',{name:'添加项目',exact:true}).waitFor({state:'hidden'})
  const imported=(await page.evaluate(()=>window.baoyi.project.list())).find((p:any)=>p.path===importedRoot);assert.ok(imported);assert.equal(imported.summary,'整理调研资料并撰写报告，主要入口为正文.md。')
  const importedSessions=await page.evaluate((id:string)=>window.baoyi.project.sessions(id),imported.id);const importSession=await page.evaluate((id:string)=>window.baoyi.project.session(id),importedSessions[0].id);assert.ok(importSession.messages.some((m:any)=>m.proposal?.applied))
  await page.evaluate((id:string)=>{location.hash='/project/'+id+'?tab=chat'},imported.id);await page.getByRole('tab',{name:'项目助手',exact:true}).waitFor();await page.locator('.chat-message.assistant').first().waitFor();assert.equal(await page.getByRole('tab',{name:'项目助手',exact:true}).getAttribute('aria-selected'),'true')
  await page.getByRole('tab',{name:'项目入口',exact:true}).click();await page.reload();await page.getByRole('button',{name:'添加入口',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'项目入口',exact:true}).getAttribute('aria-selected'),'true');await page.screenshot({path:path.join(output,'project-tabs-import.png')});checks.push('import-auto-agent-registration-and-tab-memory')
  await page.evaluate((id:string)=>window.baoyi.project.update(id,{category:'审查自定义分类'}),imported.id);await page.getByLabel('编辑项目',{exact:true}).click();await page.getByLabel('类型',{exact:true}).selectOption('审查自定义分类');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('dialog',{name:'编辑项目',exact:true}).waitFor({state:'hidden'});await page.getByRole('button',{name:'项目库',exact:true}).click();await page.locator('.pj-sidebar').getByRole('button',{name:/审查自定义分类/}).click();assert.equal(await page.locator('.pj-card').count(),1);checks.push('project-custom-category-editor-sidebar-sync')
  const currentVideos=await page.evaluate(()=>window.baoyi.video.list());assert.ok(currentVideos.length);await page.evaluate((id:string)=>{location.hash='/video/'+id+'?tab=notes'},currentVideos[0].id);await page.locator('#video-tab-notes').waitFor();assert.equal(await page.locator('#video-tab-notes').getAttribute('aria-selected'),'true');await page.reload();await page.locator('#video-tab-notes').waitFor();assert.equal(await page.locator('#video-tab-notes').getAttribute('aria-selected'),'true');checks.push('video-detail-tab-reload-memory')
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,packed?'packaged-report.json':'report.json'),JSON.stringify({executable,profile,root,checks,requests:requests.length,errors},null,2));console.log('PASS '+checks.join(', '))
}catch(error){try{await (await app.firstWindow()).screenshot({path:path.join(output,'failure.png')})}catch{}throw error}
finally{await app.close();server.close()}
