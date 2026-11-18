/** Actual packaged IPC, network streaming, audio playback and registration with a local GD-shaped server. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createServer} from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {pngImage} from './helpers/test-images.ts'
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/feedback-round3-2026-11-07/packaged-ui');fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=path.join(profile,'fixtures');fs.mkdirSync(fixture)
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hide_hentai:false,hanime_builtin_hosts:false,video_online_proxy:'direct://',video_updates_weekly:false,music_download_root:path.join(fixture,'music')}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const wav=Buffer.alloc(44+8000*2*30);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
const local=path.join(fixture,'local.wav');fs.writeFileSync(local,wav)
registerVideoContent(db,{mediaKind:'audio',title:'已有本地音频',category:'音频',items:[{title:'本地曲目',order:1,files:[{path:local}]}]})
const movieFile=path.join(fixture,'movie.mp4');fs.writeFileSync(movieFile,wav)
registerVideoContent(db,{mediaKind:'video',title:'本地电影',category:'电影',videoType:'movie',items:[{title:'电影',order:1,files:[{path:movieFile}]}]})
const series=['正常系列','有新集系列','缺失文件系列'].map((title,i)=>{const file=path.join(fixture,'series-'+i+'.mp4');fs.writeFileSync(file,wav);return registerVideoContent(db,{mediaKind:'video',title,category:'剧集',videoType:'series',items:[{title,order:1,files:[{path:file}]}]}).resourceId});db.close()
const network:string[]=[],cover=pngImage(460,215)
let delayPreview=false,releasePreview:(()=>void)|undefined
const server=createServer((req,res)=>{
  const url=new URL(req.url!,'http://fixture');network.push(url.pathname+url.search);res.setHeader('Access-Control-Allow-Origin','*')
  if(url.pathname==='/api.php'){
    const kind=url.searchParams.get('types'),id=url.searchParams.get('id')
    const result=kind==='search'?[{id:'1',name:'在线合成曲目',artist:['合成歌手'],album:'合成专辑',pic_id:'cover'},{id:'2',name:'可取消曲目',artist:['合成歌手'],album:'合成专辑'}]:kind==='url'?{url:'https://media.example.com/'+(id==='2'?'slow':'audio'),br:320,size:wav.length}:kind==='pic'?{url:'https://media.example.com/cover'}:{lyric:'[00:00.00]合成歌词'}
    res.setHeader('Content-Type','application/json');if(delayPreview&&kind==='url'){releasePreview=()=>res.end(JSON.stringify(result));return}res.end(JSON.stringify(result));return
  }
  if(url.pathname==='/cover'){res.setHeader('Content-Type','image/png');res.end(cover);return}
  res.setHeader('Content-Type','audio/wav');res.setHeader('Accept-Ranges','bytes')
  const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||''),start=Number(range?.[1]||0),end=range?.[2]?Number(range[2]):wav.length-1
  if(range){res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${wav.length}`)}res.setHeader('Content-Length',end-start+1)
  if(url.pathname==='/slow'){res.write(wav.subarray(start,start+100));const timer=setTimeout(()=>res.end(wav.subarray(start+100,end+1)),15000);res.once('close',()=>clearTimeout(timer))}
  else res.end(wav.subarray(start,end+1))
})
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port
const {_electron}=loadPlaywright(),app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()})
const page=await app.firstWindow(),checks:string[]=[],errors:string[]=[];page.setDefaultTimeout(18000);page.on('pageerror',e=>errors.push(e.message))
const route=async(value:string)=>page.evaluate(value=>location.hash=value,value)
async function waitJob(predicate:(j:any)=>boolean){for(let n=0;n<200;n++){const jobs=await page.evaluate(()=>window.baoyi.music.jobs());const job=jobs.find(predicate);if(job)return job;await new Promise(r=>setTimeout(r,50))}throw new Error('music job timeout: '+JSON.stringify(await page.evaluate(()=>window.baoyi.music.jobs())))}
const check=async(name:string,fn:()=>Promise<void>)=>{await fn();checks.push(name);console.log('PASS '+name)}
try{
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile)
  await page.waitForFunction(()=>!!window.baoyi?.music);await page.bringToFront()
  await app.evaluate(({session,ipcMain,BrowserWindow}:any,{port,series}:any)=>{
    session.fromPartition('persist:video-discovery').webRequest.onBeforeRequest({urls:['https://music-api.gdstudio.xyz/*','https://media.example.com/*']},(details:any,callback:any)=>{const url=new URL(details.url);callback({redirectURL:`http://127.0.0.1:${port}${url.pathname}${url.search}`})})
    const rows=series.map((id:string,i:number)=>({id,title:['正常系列','有新集系列','缺失文件系列'][i],source:true,newEpisodes:i===1?2:0,missingFiles:i===2?1:0,status:'complete',message:'合成检查结果'}))
    const state={running:false,total:3,checked:3,rows,finishedAt:Date.now(),cancelled:false}
    ;(globalThis as any).__updates=state
    for(const channel of ['video-updates:status','video-updates:start']){ipcMain.removeHandler(channel);ipcMain.handle(channel,()=>state)}
    BrowserWindow.getAllWindows()[0].webContents.send('video-updates:changed')
  },{port,series})
  await page.reload();await route('/video')
  await check('系列结果仅显示新集和缺失，正常作品不列卡片',async()=>{
    await page.getByRole('button',{name:/^剧集\s+\d/}).first().click();await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'查看当前范围检查结果',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'批量检查视频更新'});await dialog.waitFor();assert.equal(await dialog.locator('.update-row').count(),2);assert.equal(await dialog.getByText('正常系列',{exact:true}).count(),0)
    await page.screenshot({path:path.join(output,'series-attention.png')});await dialog.getByRole('button',{name:'关闭',exact:true}).click()
    await app.evaluate(({BrowserWindow}:any)=>{for(const r of (globalThis as any).__updates.rows){r.newEpisodes=0;r.missingFiles=0}BrowserWindow.getAllWindows()[0].webContents.send('video-updates:changed')})
    await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'查看当前范围检查结果',exact:true}).click();await dialog.getByText('共检查 3 部作品，均无新集或缺失。').waitFor();assert.equal(await dialog.locator('.update-row').count(),0);await dialog.getByRole('button',{name:'关闭',exact:true}).click()
  })
  await check('电影和音频均无系列检查菜单或提示条，跨路由关闭结果',async()=>{
    await app.evaluate(({BrowserWindow}:any)=>{(globalThis as any).__updates.rows[1].newEpisodes=2;BrowserWindow.getAllWindows()[0].webContents.send('video-updates:changed')})
    for(const type of ['电影','音频']){await page.getByRole('button',{name:new RegExp('^'+type+'\\s+\\d')}).first().click();await page.getByRole('button',{name:'更多',exact:true}).click();assert.equal(await page.getByRole('button',{name:/检查.*系列更新|查看当前范围检查结果|部作品有新集或文件缺失/}).count(),0);await page.keyboard.press('Escape')}
    await page.getByRole('button',{name:/^剧集\s+\d/}).first().click();await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'查看当前范围检查结果',exact:true}).click();await route('/document');await page.getByRole('dialog',{name:'批量检查视频更新'}).waitFor({state:'detached'})
  })
  await check('多源搜索与真实音频协议试听，关闭面板跨页面继续播放',async()=>{
    await route('/video');await page.getByRole('button',{name:/^音频\s+\d/}).click();await page.getByRole('button',{name:'找音乐',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'找音乐'});await dialog.getByLabel('歌曲、歌手或专辑').fill('合成');await dialog.getByLabel('音乐平台').selectOption('joox');await dialog.getByRole('button',{name:'搜索',exact:true}).click();await dialog.getByRole('button',{name:'试听 在线合成曲目'}).click()
    await page.waitForFunction(()=>{const a=document.querySelector('.audio-mini audio') as HTMLAudioElement;return a&&!a.paused&&a.currentTime>0})
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();const before=await page.locator('.audio-mini audio').evaluate((a:HTMLAudioElement)=>a.currentTime);await route('/document');await page.waitForFunction(before=>{const a=document.querySelector('.audio-mini audio') as HTMLAudioElement;return a&&!a.paused&&a.currentTime>before+.1},before)
    assert.ok(network.some(url=>url.includes('source=joox')));await page.getByRole('button',{name:'暂停音频',exact:true}).click();await page.getByRole('button',{name:'关闭音频播放器',exact:true}).click()
  })
  await check('试听尚未返回时换平台，不会迟到播放旧搜索结果',async()=>{
    await route('/video');await page.getByRole('button',{name:'找音乐',exact:true}).click();const dialog=page.getByRole('dialog',{name:'找音乐'});await dialog.getByLabel('歌曲、歌手或专辑').fill('合成');await dialog.getByRole('button',{name:'搜索',exact:true}).click()
    delayPreview=true;await dialog.getByRole('button',{name:'试听 在线合成曲目'}).click();for(let n=0;n<100&&!releasePreview;n++)await new Promise(r=>setTimeout(r,10));assert.ok(releasePreview)
    await dialog.getByLabel('音乐平台').selectOption('joox');releasePreview!();delayPreview=false;await new Promise(r=>setTimeout(r,150));assert.equal(await page.locator('.audio-mini').count(),0);await dialog.getByRole('button',{name:'关闭',exact:true}).click()
  })
  await check('原生网络下载音频、封面和歌词，完成事件立即刷新本地列表',async()=>{
    await route('/video');await page.evaluate(()=>{(window as any).__musicLibraryEvents=0;window.baoyi.video.onLibraryChanged(()=>(window as any).__musicLibraryEvents++)});await page.getByRole('button',{name:'找音乐',exact:true}).click();const dialog=page.getByRole('dialog',{name:'找音乐'});await dialog.getByLabel('歌曲、歌手或专辑').fill('合成');await dialog.getByRole('button',{name:'搜索',exact:true}).click();await dialog.getByRole('button',{name:'下载 在线合成曲目'}).click()
    const job=await waitJob(j=>j.status==='completed');assert.deepEqual(fs.readFileSync(job.file!),wav);assert.ok(fs.existsSync(path.join(job.directory,'cover.jpg')));assert.equal(fs.readFileSync(path.join(job.directory,'在线合成曲目.lrc'),'utf8'),'[00:00.00]合成歌词')
    await page.screenshot({path:path.join(output,'music-search.png')});await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('.audio-name').filter({hasText:'在线合成曲目'}).waitFor();await page.getByRole('button',{name:'播放 在线合成曲目',exact:true}).click();await page.waitForFunction(()=>{const a=document.querySelector('.audio-mini audio') as HTMLAudioElement;return a&&!a.paused})
    await page.screenshot({path:path.join(output,'music-library.png')});await page.getByRole('button',{name:'关闭音频播放器'}).click();await page.reload();await page.getByRole('button',{name:/^音频\s+\d/}).click();await page.locator('.audio-name').filter({hasText:'在线合成曲目'}).waitFor()
  })
  await check('关闭面板仍下载，任务中心独立音频类别，停止不产生入库记录',async()=>{
    await page.getByRole('button',{name:'找音乐',exact:true}).click();const dialog=page.getByRole('dialog',{name:'找音乐'});await dialog.getByLabel('歌曲、歌手或专辑').fill('合成');await dialog.getByRole('button',{name:'搜索',exact:true}).click();await dialog.getByRole('button',{name:'下载 可取消曲目'}).click();await waitJob(j=>j.status==='running'&&j.received>0)
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();const job=(await page.evaluate(()=>window.baoyi.music.jobs())).find(j=>j.status==='running')!;assert.ok(job)
    await page.waitForFunction(async()=>(await window.baoyi.tasks.list()).some(t=>t.kind==='audio-download'&&t.status==='running'))
    await page.getByRole('button',{name:'找音乐',exact:true}).click();await dialog.getByRole('button',{name:'停止下载',exact:true}).click();await waitJob(j=>j.status==='cancelled')
    assert.equal(fs.existsSync(path.join(job.directory,'audio.part')),false);assert.equal((await page.evaluate(()=>window.baoyi.music.jobs())).find(j=>j.id===job.id)?.resourceId,undefined)
  })
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:checks.length,checks,errors,profile,executable:packed,network,boundary:'Real packaged Electron network/IPC/player/files/registration; GD-shaped local server and synthetic update-result rows. Public sources and real model latency are separate.'},null,2))
}catch(error){fs.writeFileSync(path.join(output,'failure-state.json'),JSON.stringify(await page.evaluate(async()=>({hidden:document.hidden,events:(window as any).__musicLibraryEvents,audio:await window.baoyi.video.list({type:'audio'}),jobs:await window.baoyi.music.jobs()})),null,2));await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors,network},null,2));throw error}
finally{await app.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
