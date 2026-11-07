/** Native renderer acceptance; costly/destructive services use explicit synthetic IPC fixtures. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {inspectProject} from '../electron/kinds/project/scanner.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {pngImage} from './helpers/test-images.ts'

const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/interaction-fixes-2026-11-07/native-ui'+(packed?'-packaged':''));fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=path.join(profile,'fixtures');fs.mkdirSync(fixture)
fs.writeFileSync(path.join(fixture,'README.md'),'# 合成项目\n仅用于前端隔离验证。')
const docFile=path.join(fixture,'合成交互书籍.md');fs.writeFileSync(docFile,'# 合成交互书籍\n这是隔离验收文本。')
const videos=['1080p.mp4','4k.mp4'].map(name=>{const file=path.join(fixture,name);fs.writeFileSync(file,'synthetic placeholder');return {path:file}})
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hide_hentai:false,hanime_builtin_hosts:false,project_preferences:{defaultTab:'overview'}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const project=new ProjectLibrary(db).register(await inspectProject(fixture))
await new DocumentLibrary(db).register(docFile,'book')
const wav=Buffer.alloc(44+8000*2*30);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
const audioFiles=['合成曲目一.wav','合成曲目二.wav'].map((name,index)=>{const file=path.join(fixture,name);fs.writeFileSync(file,wav);return {title:name,order:index+1,files:[{path:file}],durationSec:30}})
registerVideoContent(db,{mediaKind:'audio',title:'合成音频专辑',category:'音频',items:audioFiles})
const video=registerVideoContent(db,{title:'合成多版本影片',category:'其他',videoType:'movie',items:[{title:'合成视频内容',order:1,durationSec:8,files:videos}]});db.close()
const {_electron}=loadPlaywright(),app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()})
const page=await app.firstWindow(),checks:string[]=[],errors:string[]=[];page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message))
async function check(name:string,action:()=>Promise<void>){await action();checks.push(name);console.log('PASS '+name)}
async function route(value:string){await page.evaluate(value=>{location.hash=value},value)}
async function stats(){return app.evaluate(()=>JSON.parse(JSON.stringify((globalThis as any).__interactionFixture.stats)))}
try{
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile)
  await page.waitForFunction(()=>!!window.baoyi?.comic)
  assert.equal((await page.evaluate(()=>window.baoyi.app.info())).version,JSON.parse(fs.readFileSync(path.resolve('package.json'),'utf8')).version)
  await app.evaluate(({ipcMain}:any,{project,video,sprite,fixture}:any)=>{
    const stats={generated:[] as any[],previews:[] as any[],comicPreviews:[] as any[],starts:[] as any[],cleaned:[] as any[],browse:[] as any[],picaDownloads:[] as any[],policySaves:[] as any[],videoOpened:[] as any[]},tokens=new Map(),comicTokens=new Map();let seq=0
    const handle=(channel:string,fn:Function)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,(_e:any,...args:any[])=>fn(...args))}
    ;(globalThis as any).__interactionFixture={stats}
    handle('archive:project-handoff-preview',(id:string,includeRules=false)=>{const token='preview-'+(++seq);tokens.set(token,includeRules);stats.previews.push({token,includeRules});return {token,stamp:token,includeRules,remembered:false,configured:true,provider:'合成模型',localPrompt:'本地模板',snapshot:{projectId:id,name:'合成项目',context:{current:'合成便签',next:'检查交互'},git:{},rules:includeRules?[{path:'README.md',content:'合成规则'}]:[],warnings:[]}}})
    handle('archive:project-handoff-generate',async(input:any)=>{if(!tokens.has(input.token))throw new Error('旧令牌不能重用');const includeRules=tokens.get(input.token);tokens.delete(input.token);stats.generated.push({token:input.token,includeRules});return {projectId:project.id,sessionId:'synthetic',contextRevision:0,goal:'核对交互',facts:['合成事实'],constraints:['不执行命令'],prompt:'合成 Prompt '+stats.generated.length,acceptance:['验证返回范围']}})
    handle('archive:project-handoff-adopt',()=>({}))
    handle('image:download-target',()=>({root:fixture,directory:'',groupId:null,locked:false}))
    handle('image:choose-download-root',()=>fixture)
    handle('image:source-status',()=>true)
    const picaWork={id:'pica-fixture',title:'合成哔咔作品',author:'作者',description:'合成简介',tags:['合成'],chapters:2,pages:2,finished:true}
    handle('image:source-search',()=>({items:[picaWork],pages:1}));handle('image:source-ranking',()=>({items:[picaWork],pages:1}));handle('image:source-favorites',()=>({items:[picaWork],pages:1}))
    handle('image:source-detail',()=>({work:picaWork,chapters:[{id:'p1',title:'第一章',order:1},{id:'p2',title:'第二章',order:2}]}));handle('image:source-owned',()=>({owned:[],queued:[],chapters:{}}))
    handle('image:download',(...args:any[])=>{stats.picaDownloads.push(args);return {id:'pica-job'}})
    handle('comic:browse',(query:any)=>{stats.browse.push(query);return {page:query.page,pages:2,items:[{id:'123',title:'合成榜单作品',tags:['合成']}]}})
    handle('comic:cover',()=>sprite);handle('comic:cancel-browse',()=>{})
    handle('comic:defaults',()=>({proxy:{mode:'system'}}))
    handle('comic:preview',(input:string,proxy:any)=>{const token='comic-'+(++seq);comicTokens.set(token,proxy);stats.comicPreviews.push({input,proxy});return {token,directory:'合成目录',existingId:'',existingChapters:[],catalog:{workId:'123',name:'合成漫画预览',authors:['合成作者'],description:'前端验证',cover:sprite,chapters:[{id:'a',title:'第一章',order:1,pageIds:['1']},{id:'b',title:'第二章',order:2,pageIds:['2']}]}}})
    handle('comic:cancel-preview',()=>{})
    handle('comic:start',(token:string,chapters:string[],directory:string,group:string)=>{stats.starts.push({proxy:comicTokens.get(token),chapters,directory,group});return null})
    handle('comic:jobs',()=>[{id:'clean-test',name:'合成清理任务',status:'paused',phase:'downloading',processed:1,total:2,selectedChapters:['a'],current:'',error:'',retryNotBefore:0,requiresRevalidation:false}])
    handle('comic:clean',(id:string)=>{stats.cleaned.push(id)})
    handle('archive:insight-policy',()=>({automatic:false,categories:[],maxChars:12000,provider:'合成模型',authorized:false}))
    handle('archive:insight-save-policy',(value:any)=>{stats.policySaves.push(value);return value})
    const assets=['1080p','4k'].map(key=>({key,name:key,episodeId:'episode',label:key,quality:key,duration:8,format:'mp4'}))
    handle('video-preview:choices',()=>({resourceId:video.resourceId,title:'合成多版本影片',assets}))
    handle('video-preview:open',(_id:string,key:string)=>{stats.videoOpened.push(key);return {token:key,title:'合成多版本影片',url:'',asset:assets.find(a=>a.key===key)}})
    handle('video-preview:frames',()=>({id:'sprite',status:'ready',url:sprite,times:[0,1,2,3,4,5,6,7],duration:8,partial:false,message:'',completed:8,videoCodec:'synthetic',audioTracks:0}))
    handle('video-preview:release',()=>{});handle('video-preview:release-frames',()=>{})
  },{project,video,fixture,sprite:'data:image/png;base64,'+pngImage(1200,800).toString('base64')})
  await page.reload();await page.waitForFunction(()=>!!window.baoyi?.comic)
  await check('文库 grid 按钮、网格布局及刷新记忆已一致（无需源码改动）',async()=>{
    await route('/document');await page.getByRole('button',{name:'列表视图',exact:true}).click();await page.getByRole('button',{name:'网格视图',exact:true}).click()
    await page.locator('.document-grid').first().waitFor();assert.match(await page.getByLabel('网格视图',{exact:true}).getAttribute('class')||'',/active/)
    await page.reload();await page.locator('.document-grid').first().waitFor();assert.match(await page.getByLabel('网格视图',{exact:true}).getAttribute('class')||'',/active/)
  })
  await check('便签独立栏目；切 Tab 保留草稿；快捷键返回便签并聚焦',async()=>{
    await route('/project/'+project.id+'?tab=notes');await page.getByLabel('当前情况',{exact:true}).waitFor()
    const field=page.locator('.project-notes textarea').nth(1);await field.fill('切换栏目后保留这条计划')
    for(const name of ['工作区概览','项目日志','归档助理','项目入口','项目资料']){await page.getByRole('tab',{name,exact:true}).click();assert.equal(await field.isVisible(),false)}
    await page.keyboard.press('Control+Shift+M');await field.waitFor();assert.equal(await field.inputValue(),'切换栏目后保留这条计划');assert.equal(await field.evaluate(el=>el===document.activeElement),true)
    assert.equal(await field.evaluate(el=>!!el.closest('#project-panel-notes')),true)
    await page.screenshot({path:path.join(output,'project-overview.png')})
  })
  await check('Prompt 结果内重新生成、采用重置、返回修改范围及再次生成',async()=>{
    await page.getByRole('button',{name:'生成下一步 Prompt',exact:true}).click();await page.getByRole('button',{name:'生成 Prompt',exact:true}).click();await page.getByLabel('生成的下一步 Prompt').waitFor()
    await page.getByRole('button',{name:'设为关键 Prompt',exact:true}).click();await page.getByRole('button',{name:'已采用',exact:true}).waitFor()
    await page.getByRole('button',{name:'重新生成',exact:true}).click();await page.getByLabel('生成的下一步 Prompt').waitFor();assert.equal(await page.getByLabel('生成的下一步 Prompt').inputValue(),'合成 Prompt 2');assert.equal(await page.getByRole('button',{name:'设为关键 Prompt',exact:true}).isEnabled(),true)
    await page.getByRole('button',{name:'返回调整范围',exact:true}).click();await page.getByRole('button',{name:'生成 Prompt',exact:true}).waitFor();assert.equal((await stats()).generated.length,2)
    await page.getByLabel('同时发送项目内规则文件正文',{exact:false}).check();await page.getByRole('button',{name:'生成 Prompt',exact:true}).click();await page.getByLabel('生成的下一步 Prompt').waitFor();assert.equal((await stats()).generated.at(-1).includeRules,true)
    await page.screenshot({path:path.join(output,'handoff-result.png')});await page.keyboard.press('Escape')
  })
  await check('助理展开时运行药丸向左避让，输入区可正常输入',async()=>{
    await app.evaluate(({BrowserWindow}:any,id:string)=>BrowserWindow.getAllWindows()[0].webContents.send('project:run',{id:'synthetic-run',projectId:id,profileId:'fixture',profileName:'合成命令',status:'running',startedAt:Date.now()}),project.id)
    await page.locator('.project-run-chip').waitFor();await page.keyboard.press('Control+j');await page.locator('.archive-panel').waitFor()
    assert.ok(await page.evaluate(()=>{const panel=document.querySelector('.archive-panel')!,chip=document.querySelector('.project-run-chip')!,box=chip.getBoundingClientRect();return Number(getComputedStyle(panel).zIndex)>Number(getComputedStyle(chip).zIndex)&&box.right<=panel.getBoundingClientRect().left-10}))
    const input=page.locator('.archive-panel .composer textarea');await input.fill('仅用于遮挡检查，不发送');assert.equal(await input.inputValue(),'仅用于遮挡检查，不发送');await page.screenshot({path:path.join(output,'assistant-above-chip.png')});await page.getByLabel('收起归档助理',{exact:true}).click()
  })
  await check('漫画换代理保留封面与已选章节，新代理用于下载请求；改作品清预览',async()=>{
    await route('/image');await page.getByRole('button',{name:'在线漫画',exact:true}).click();await page.getByRole('button',{name:'JM',exact:true}).click();await page.getByRole('button',{name:/合成榜单作品/}).click();await page.getByRole('heading',{name:'合成漫画预览'}).waitFor()
    await page.locator('.comic-chapters input').first().uncheck();await page.getByLabel('连接方式',{exact:false}).selectOption('custom');await page.getByLabel('代理地址',{exact:true}).fill('127.0.0.1:7890')
    assert.equal(await page.locator('.comic-cover').isVisible(),true);assert.equal(await page.locator('.comic-chapters input:checked').count(),1)
    await page.getByRole('button',{name:'加入下载',exact:true}).click();await page.getByRole('button',{name:'加入下载',exact:true}).waitFor();const request=(await stats()).starts.at(-1);assert.deepEqual(request.proxy,{mode:'custom',url:'127.0.0.1:7890'});assert.deepEqual(request.chapters,['b'])
    await page.screenshot({path:path.join(output,'comic-proxy-preserved.png')});await page.getByLabel('作品编号或链接').fill('456');assert.equal(await page.locator('.comic-preview').count(),0);await page.getByLabel('返回 JM 列表').click();await page.getByRole('button',{name:'下载任务与记录',exact:true}).click()
  })
  await check('清理暂存前出现不可撤销提示，取消不调用，确认后才调用',async()=>{
    const clean=page.getByRole('button',{name:'停止并清理暂存',exact:true}).first();await clean.waitFor()
    let text='';page.once('dialog',async dialog=>{text=dialog.message();await dialog.dismiss()});await clean.click();assert.match(text,/将删除已下载的临时图片文件.*不可撤销/);assert.equal((await stats()).cleaned.length,0)
    page.once('dialog',async dialog=>{await dialog.accept()});await clean.click();assert.equal((await stats()).cleaned.length,1);await page.getByLabel('关闭在线漫画').click()
  })
  await check('多版本悬停使用首版本展示代表帧，列表试看图标尺寸统一',async()=>{
    await route('/video');const card=page.locator('article.card').filter({hasText:'合成多版本影片'});await card.locator('.card__poster').hover();await page.locator('.video-hover-picture').waitFor();assert.equal((await stats()).videoOpened.at(-1),'1080p');assert.equal(await card.locator('.card__frame,input[type=range]').count(),0);const frame=await page.locator('.video-hover-picture').boundingBox();assert.ok(frame&&Math.abs(frame.width/frame.height-16/9)<0.02);await page.screenshot({path:path.join(output,'video-hover.png')})
    await route('/video/'+video.resourceId);await page.getByRole('button',{name:'列表视图',exact:true}).click();const button=page.getByTitle('内嵌试看',{exact:true}).first();await button.waitFor();assert.equal(await button.locator('svg').getAttribute('width'),'15');assert.equal((await button.innerText()).trim(),'')
    const sizes=await page.locator('.video-item__actions').first().locator('button').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {width:b.width,height:b.height,y:b.y}}));assert.equal(sizes.length,4);assert.ok(sizes.every(b=>b.width===sizes[0].width&&b.height===sizes[0].height&&b.y===sizes[0].y));await page.screenshot({path:path.join(output,'video-actions.png')})
  })
  await check('自动精读空分类警告且不保存，选分类和手动模式可保存',async()=>{
    await route('/document');await route('/settings?module=document&tab=reader');const settings=page.locator('.insight-settings');await settings.locator('summary').first().click();await settings.getByLabel('触发方式').selectOption('true');await settings.getByRole('button',{name:'授权并保存自动精读'}).click();await settings.getByRole('alert').waitFor();assert.equal((await stats()).policySaves.length,0)
    await settings.locator('fieldset input').first().check();await settings.getByRole('button',{name:'授权并保存自动精读'}).click();await settings.getByRole('status').waitFor();assert.equal((await stats()).policySaves.length,1)
    await settings.locator('fieldset input').first().uncheck();await settings.getByLabel('触发方式').selectOption('false');await settings.getByRole('button',{name:'保存精读设置'}).click();assert.equal((await stats()).policySaves.length,2)
  })
  await check('JM四榜、综合作者标签搜索与Pica保留收藏；两源均显式目标直接下载',async()=>{
    await route('/image');await page.getByRole('button',{name:'在线漫画',exact:true}).click();await page.getByRole('button',{name:'JM',exact:true}).click()
    for(const period of ['week','month','all','day']){await page.getByLabel('JM 榜单周期').selectOption(period);await page.getByRole('button',{name:/合成榜单作品/}).waitFor()}
    await page.locator('.jm-browser').getByRole('button',{name:'搜索',exact:true}).click();await page.getByLabel('搜索 JM',{exact:true}).fill('合成查询')
    for(const scope of ['all','author','tag']){await page.getByLabel('JM 搜索范围').selectOption(scope);await page.locator('.jm-browser').getByRole('button',{name:'搜索作品',exact:true}).click();await page.getByRole('button',{name:/合成榜单作品/}).waitFor()}
    const calls=(await stats()).browse;for(const period of ['day','week','month','all'])assert.ok(calls.some((c:any)=>c.period===period&&c.mode==='ranking'));for(const scope of ['all','author','tag'])assert.ok(calls.some((c:any)=>c.scope===scope&&c.mode==='search'))
    await page.getByRole('button',{name:'哔咔 Pica',exact:true}).click();await page.getByRole('button',{name:'我的收藏',exact:true}).click();await page.getByRole('button',{name:/合成哔咔作品/}).click();await page.locator('.pica-source').getByRole('button',{name:'加入下载',exact:true}).click();await page.locator('.pica-source p[role=status]').waitFor();assert.equal((await stats()).picaDownloads.at(-1)[3],fixture)
    await page.screenshot({path:path.join(output,'source-hub-pica.png')});await page.getByRole('button',{name:'JM',exact:true}).click();assert.equal(await page.getByLabel('搜索 JM',{exact:true}).inputValue(),'合成查询');await page.screenshot({path:path.join(output,'source-hub-jm.png')});await page.getByLabel('关闭在线漫画').click()
  })
  await check('真实WAV跨模块持续播放；全局暂停下一曲及隐私关闭',async()=>{
    await route('/video');await page.getByRole('button',{name:/^音频\s+\d/}).click();await page.getByRole('button',{name:'播放 合成曲目一.wav',exact:true}).click();await page.locator('.audio-mini').waitFor();await page.waitForFunction(()=>{const a=document.querySelector('.audio-mini audio') as HTMLAudioElement;return a&&!a.paused&&a.currentTime>0})
    const before=await page.locator('.audio-mini audio').evaluate((a:HTMLAudioElement)=>a.currentTime);await route('/document');await page.waitForFunction(before=>{const a=document.querySelector('.audio-mini audio') as HTMLAudioElement;return !!a&&!a.paused&&a.currentTime>before+.15},before)
    await page.getByRole('button',{name:'暂停音频',exact:true}).click();assert.equal(await page.locator('.audio-mini audio').evaluate((a:HTMLAudioElement)=>a.paused),true);await page.getByRole('button',{name:'下一曲',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.audio-mini-title')?.textContent?.includes('合成曲目二'));await page.screenshot({path:path.join(output,'global-audio.png')});await page.evaluate(()=>window.baoyi.settings.patch({hide_hentai:true}));await page.locator('.audio-mini').waitFor({state:'detached'});await page.evaluate(()=>window.baoyi.settings.patch({hide_hentai:false}))
  })
  await check('网络设置旧online链接归并为同一栏目；待办无重复项目或到期区块',async()=>{
    await route('/video');await route('/settings?module=video&tab=online');await page.getByRole('heading',{name:'通用在线来源',exact:true}).waitFor();await page.getByRole('heading',{name:'Hanime 专用代理',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'找视频 · 网站与代理',exact:true}).count(),0)
    await route('/personal?section=todo');await page.getByRole('heading',{name:'待办',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'项目下一步',exact:true}).count(),0);assert.equal(await page.getByRole('heading',{name:'到期事项',exact:true}).count(),0)
  })
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:checks.length,checks,errors,profile,stats:await stats(),boundary:'Actual Electron renderer; model, comic, frame and policy IPC are synthetic; no real download, model request or destructive cleanup.'},null,2))
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors,stats:await stats()},null,2));throw error}
finally{await app.close()}
