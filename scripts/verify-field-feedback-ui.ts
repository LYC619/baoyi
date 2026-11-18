/** Isolated native UI, synthetic source/queue responses; no user library or media downloads. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {insertGame} from '../electron/kinds/game/db.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
import {HENTAI_CATEGORY} from '../electron/kinds/video/taxonomy.ts'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {pngImage} from './helpers/test-images.ts'
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/field-feedback-2026-11-07/'+(packed?'packaged-ui':'native-ui'));fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=path.join(profile,'fixtures');fs.mkdirSync(fixture)
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hide_hentai:false,hanime_builtin_hosts:false,_document_insight_policy:{automatic:true,categories:['book'],maxChars:12000,provider:'fixture'}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const game=insertGame(db,{exe_path:path.join(fixture,'game.exe'),name_zh:'合成返回游戏',name_en:'',summary:'',description:'',category:'其他',tags:[],official_url:'',source_dir:fixture,file_size:0,save_paths:[],linked_files:[]})
const docFile=path.join(fixture,'合成研读资料.md');fs.writeFileSync(docFile,'# 合成资料\n正文有原文证据。')
await new DocumentLibrary(db).register(docFile,'book')
const videoFile=path.join(fixture,'video.mp4');fs.writeFileSync(videoFile,'synthetic video placeholder')
const video=registerVideoContent(db,{title:'合成连载作品',category:HENTAI_CATEGORY,items:[{title:'第一集',order:1,files:[{path:videoFile}],sources:[{provider:'hanime',externalId:'123',scope:'episode',pageUrl:'https://hanime1.me/watch?v=123',evidence:'playlist'}]}]})
db.prepare('UPDATE video_meta SET hanime_id=? WHERE resource_id=?').run('123',video.resourceId);db.close()
const {_electron}=loadPlaywright(),app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()})
const page=await app.firstWindow(),checks:string[]=[],errors:string[]=[];page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message))
const route=async(hash:string)=>{await page.evaluate(hash=>location.hash=hash,hash)}
async function check(name:string,action:()=>Promise<void>){await action();checks.push(name);console.log('PASS '+name)}
const stats=()=>app.evaluate(()=>JSON.parse(JSON.stringify((globalThis as any).__field.stats)))
try{
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile)
  await page.waitForFunction(()=>!!window.baoyi?.comic)
  await app.evaluate(({ipcMain}:any,{sprite,fixture,video,category}:any)=>{
    const stats={covers:[] as string[],browse:0,prepares:0,enqueues:[] as any[]},state={stats,onlyLocal:false,progress:1};(globalThis as any).__field=state
    const handle=(name:string,fn:Function)=>{ipcMain.removeHandler(name);ipcMain.handle(name,(_event:any,...args:any[])=>fn(...args))}
    const updateState=()=>({running:false,checked:1,total:1,finishedAt:Date.now(),cancelled:false,rows:[{id:video.resourceId,title:'合成连载作品',source:true,newEpisodes:state.onlyLocal?0:1,missingFiles:state.onlyLocal?0:1,status:'complete',message:'合成检查结果'}]})
    handle('video-updates:start',updateState);handle('video-updates:status',updateState);handle('video-updates:cancel',updateState)
    handle('comic:defaults',()=>({proxy:{mode:'system'}}));handle('comic:cancel-browse',()=>{})
    handle('comic:browse',()=>{stats.browse++;return {page:1,pages:1,items:Array.from({length:80},(_,i)=>({id:String(1000+i),title:'可视作品 '+i,tags:[]}))}})
    handle('comic:cover',async(id:string)=>{stats.covers.push(id);await new Promise(resolve=>setTimeout(resolve,15));return sprite})
    handle('comic:preview',()=>({token:'fixture',directory:'合成目录',existingId:'',existingChapters:[],catalog:{workId:'1000',name:'可视作品详情',authors:[],description:'',chapters:[{id:'c',title:'第一章',order:1,pageIds:['p']}]}}))
    handle('image:download-target',()=>({root:fixture,locked:false,directory:''}));handle('image:source-status',()=>true)
    handle('comic:jobs',()=>['a','b'].map((id,i)=>({id,name:'固定任务 '+id,createdAt:100-i,updatedAt:i?1000:state.progress,processed:state.progress,total:100,status:'paused',phase:'downloading',selectedChapters:['c'],error:'',current:'',retryNotBefore:0})))
    handle('video-workflow:prepare',()=>{stats.prepares++;return {id:'draft-'+stats.prepares,resourceId:video.resourceId,videoCode:'123',title:'合成连载作品',description:'',category,pageUrl:'https://hanime1.me/watch?v=123',root:fixture,directory:fixture,bound:true,warnings:[],missing:[],episodes:(state.onlyLocal?['local','queued']:['local','available','missing','queued','other-work']).map((state,i)=>({videoCode:String(123+i),title:'合成第 '+(i+1)+' 集',order:i+1,numbered:true,state,qualities:[]}))}})
    handle('video-workflow:enqueue',(request:any)=>{stats.enqueues.push(request);return {id:'job',resourceId:video.resourceId,title:'合成连载作品',category,status:'queued',items:request.videoCodes.map((videoCode:string)=>({videoCode,transfer:'pending'})),message:'已加入合成队列',createdAt:Date.now(),updatedAt:Date.now()}})
  },{sprite:'data:image/png;base64,'+pngImage(180,240).toString('base64'),fixture,video,category:HENTAI_CATEGORY})
  await page.reload();await page.waitForFunction(()=>!!window.baoyi?.comic)
  await check('游戏返回明确进入游戏库，不受软件页历史影响',async()=>{
    await route('/');await route('/game/'+game.id);await page.getByRole('button',{name:'返回',exact:true}).click();await page.waitForFunction(()=>location.hash==='#/game')
  })
  await check('80 条榜单仅加载可视封面，滚动后加载新图，返回不重拉榜单',async()=>{
    await route('/image');await page.getByRole('button',{name:'在线漫画',exact:true}).click();await page.getByRole('button',{name:'JM',exact:true}).click()
    await page.locator('.jm-cover img').first().waitFor();await page.waitForTimeout(350)
    const initial=(await stats()).covers;assert.ok(initial.length>0&&initial.length<40,JSON.stringify(initial));assert.ok(!initial.includes('1079'))
    await page.locator('.jm-work').last().scrollIntoViewIfNeeded();await page.locator('.jm-work').last().locator('img').waitFor();assert.ok((await stats()).covers.includes('1079'))
    await page.locator('.jm-work').first().scrollIntoViewIfNeeded();await page.locator('.jm-work').first().click();await page.getByRole('heading',{name:'可视作品详情'}).waitFor();await page.getByLabel('返回 JM 列表').click()
    assert.equal(await page.locator('.jm-work').count(),80);assert.equal((await stats()).browse,1)
    await page.screenshot({path:path.join(output,'jm-visible.png')})
  })
  await check('任务进度更新后卡片顺序与滚动位置保持',async()=>{
    await page.getByRole('button',{name:'下载任务与记录',exact:true}).click();await page.getByText('固定任务 a',{exact:true}).waitFor()
    const before=await page.locator('.comic-task h4').allTextContents()
    await app.evaluate(({BrowserWindow}:any)=>{(globalThis as any).__field.progress=99999;BrowserWindow.getAllWindows()[0].webContents.send('image:jobs-changed')})
    await page.waitForTimeout(500);assert.deepEqual(await page.locator('.comic-task h4').allTextContents(),before)
    assert.ok((await page.locator('.comic-task').first().innerText()).includes('固定任务 a'));await page.getByLabel('关闭在线漫画').click()
  })
  await check('检查更新重新解析，仅选择未收录与缺失，已有/排队/其他作品不可重下',async()=>{
    await route('/video');await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'检查全部可见视频',exact:true}).click();await page.getByRole('dialog',{name:'批量检查视频更新'}).getByRole('button',{name:'下载 / 补齐',exact:true}).click();await page.getByText(/发现 1 项未收录内容、1 项文件缺失/).waitFor()
    const panel=page.locator('.download-panel');assert.equal(await panel.locator('input[type=checkbox]:checked').count(),2)
    await panel.getByRole('button',{name:'全选',exact:true}).click();assert.equal(await panel.locator('.download-contents input:checked').count(),2)
    await panel.getByRole('button',{name:'下载所选 2 项',exact:true}).click();assert.deepEqual((await stats()).enqueues[0].videoCodes,['124','125'])
    await panel.getByLabel('关闭下载面板').click();await app.evaluate(()=>{(globalThis as any).__field.onlyLocal=true})
    await page.getByRole('dialog',{name:'批量检查视频更新'}).getByRole('button',{name:'下载 / 补齐',exact:true}).click();await page.getByText(/当前没有待补齐内容/).waitFor();assert.equal((await stats()).prepares,2)
    assert.equal(await panel.getByRole('button',{name:'下载所选',exact:true}).isDisabled(),true);await page.screenshot({path:path.join(output,'video-updates.png')});await panel.getByLabel('关闭下载面板').click();await page.getByRole('dialog',{name:'批量检查视频更新'}).getByRole('button',{name:'关闭',exact:true}).click()
  })
  await check('原生精读策略停用，内置方法可列出并载入输入框，正文不自动发送',async()=>{
    await assert.rejects(page.evaluate(()=>window.baoyi.archive.insights.start('old-token')),/归档助理/)
    const imported=path.join(fixture,'新导入.md');fs.writeFileSync(imported,'# 导入不自动精读')
    await app.evaluate(({dialog}:any,file:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},imported)
    const preview=await page.evaluate(()=>window.baoyi.workspace.documents.prepareImport(false,'book'));assert.ok(preview)
    const result=await page.evaluate(({token,file})=>window.baoyi.workspace.documents.confirmImport(token,[file],'book'),{token:preview.token,file:imported})
    assert.equal(result.imported,1);assert.match(result.insightStatus||'',/主动加载/);assert.equal((await page.evaluate(()=>window.baoyi.archive.insights.list())).length,0)
    await route('/document');await page.locator('.document-row').filter({hasText:'合成研读资料'}).first().click();await page.getByRole('button',{name:'在归档助理中精读'}).click()
    const input=page.getByLabel('给归档助理发消息');await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('.composer textarea')?.value.includes('document-deep-reader'))
    assert.match(await input.inputValue(),/document-deep-reader/);assert.equal(await page.locator('.context button').count(),1)
    const methods=await page.evaluate(()=>window.baoyi.archive.skills()) as any;assert.ok(methods.skills.some((method:any)=>method.name==='document-deep-reader'))
    assert.equal((await page.evaluate(()=>window.baoyi.archive.status())).active,null)
    await page.getByRole('button',{name:'归档方法',exact:true}).click();await page.getByText('文档精读',{exact:true}).waitFor();await page.screenshot({path:path.join(output,'deep-reader-method.png')})
  })
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:checks.length,checks,profile,executable:packed||'development Electron',errors},null,2));console.log(JSON.stringify({passed:checks.length,checks}))
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error}finally{await app.close()}
