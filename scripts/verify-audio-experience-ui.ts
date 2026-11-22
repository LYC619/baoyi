/** Actual Electron UI and media protocol with silent local WAV/LRC fixtures. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {pngImage} from './helpers/test-images.ts'
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/audio-experience-2026-11-08/development-ui')
fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),root=path.join(profile,'fixtures');fs.mkdirSync(root)
const wav=Buffer.alloc(44+8000*2*45);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
const write=(name:string,content:string|Buffer)=>{const file=path.join(root,name);fs.writeFileSync(file,content);return file}
const first=write('01-晨光.wav',wav),second=write('02-晚风.wav',wav),third=write('03-来信.wav',wav)
const lrc=write('01-晨光.lrc','[ti:晨光]\n[ar:山间电台]\n[00:00.00]城市慢慢醒来\n[00:08.00]光落在窗台\n[00:18.00]沿着河岸向前走\n[00:28.00]把昨天留给晚风\n[00:38.00]今天从这里开始')
write('03-来信.txt','这是一封写给旅人的信\n带上轻快的心情出发\n<script>只作为歌词文字显示</script>')
const cover=write('cover.png',pngImage(480,480,[93,128,112])),cover2=write('cover2.png',pngImage(480,480,[176,131,88]))
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hide_hentai:false,video_updates_weekly:false,video_card_size:190}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const album=registerVideoContent(db,{mediaKind:'audio',title:'沿途 / 山间电台',category:'音频',description:'在清晨与傍晚之间，留一段时间听听沿途的声音。',tags:['山间电台','器乐'],posterPath:cover,items:[{title:'晨光',order:1,durationSec:45,files:[{path:first}],attachments:[{path:lrc,role:'attachment'}]},{title:'晚风',order:2,durationSec:45,files:[{path:second}]},{title:'来信',order:3,durationSec:45,files:[{path:third}]}]}).resourceId
registerVideoContent(db,{mediaKind:'audio',title:'日落之后',category:'音频',tags:['独立音乐'],posterPath:cover2,items:[{title:'日落之后',order:1,files:[{path:write('日落.wav',wav)}]}]})
registerVideoContent(db,{mediaKind:'audio',title:'没有封面的播客',category:'音频',items:[{title:'第一期',order:1,files:[{path:write('播客.wav',wav)}]}]})
const movie=registerVideoContent(db,{mediaKind:'video',title:'合成电影',category:'电影',videoType:'movie',items:[{title:'电影内容',order:1,files:[{path:write('movie.mp4',wav)}]}]}).resourceId
db.close()
const {_electron}=loadPlaywright(),app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()})
const page=await app.firstWindow(),checks:string[]=[],errors:string[]=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message))
const route=async(value:string)=>page.evaluate(value=>location.hash=value,value)
const check=async(name:string,fn:()=>Promise<void>)=>{await fn();checks.push(name);console.log('PASS '+name)}
const detail=()=>page.getByRole('article',{name:'音频详情'})
try{
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile)
  await page.waitForFunction(()=>!!window.baoyi?.video)
  assert.equal((await page.evaluate(()=>window.baoyi.app.info())).version,JSON.parse(fs.readFileSync(path.resolve('package.json'),'utf8')).version)
  await app.evaluate(({shell}:any)=>{(globalThis as any).__opened=[];shell.openPath=async(p:string)=>{(globalThis as any).__opened.push(p);return ''};shell.showItemInFolder=(p:string)=>(globalThis as any).__opened.push(p)})
  await check('音频列表与方形卡片切换、真实封面和缺图占位，视图刷新后保留',async()=>{
    await route('/video')
    await page.getByText('合成电影',{exact:true}).waitFor()
    assert.equal(await page.getByText('沿途 / 山间电台',{exact:true}).count(),0,'全部影视不混入音频条目')
    const initialCounts=await page.evaluate(()=>window.baoyi.video.counts())
    assert.equal(initialCounts.all,1);assert.equal(initialCounts.audio,3)
    assert.equal(initialCounts.tags.some((t:any)=>t.name==='器乐'),false)
    assert.equal(initialCounts.audio_tags?.some((t:any)=>t.name==='器乐'),true)
    await page.getByRole('button',{name:/^音频\s+\d/}).first().click();await page.locator('.audio-row.audio-head').waitFor()
    await page.getByRole('button',{name:'视图',exact:true}).click();await page.getByRole('button',{name:'音频卡片视图',exact:true}).click();await page.keyboard.press('Escape')
    assert.equal(await page.locator('.audio-card').count(),3)
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('.audio-card img')).every(img=>(img as HTMLImageElement).naturalWidth>0))
    assert.equal(await page.locator('.audio-cover-fallback').count(),1)
    const box=await page.locator('.audio-card-art').first().boundingBox();assert.ok(box&&Math.abs(box.width-box.height)<1)
    await page.screenshot({path:path.join(output,'audio-cards.png')})
    await page.reload();await page.getByRole('button',{name:/^音频\s+\d/}).first().click();await page.locator('.audio-cards').waitFor()
    await page.getByRole('button',{name:'3 首'}).click();await page.locator('.audio-album-drawer').waitFor()
    assert.equal(await page.locator('.audio-drawer-tracks li').count(),3)
    await page.locator('.audio-album-drawer').getByRole('button',{name:'收起',exact:true}).click()
    assert.equal(await page.locator('.audio-album-drawer').count(),0)
  })
  await check('卡片进入音频专用详情，歌词真实读取且没有影视专用操作',async()=>{
    await page.getByRole('button',{name:'查看音频 沿途 / 山间电台',exact:true}).click();await detail().waitFor()
    await detail().getByText('城市慢慢醒来',{exact:true}).waitFor()
    assert.equal(await detail().locator('.audio-track').count(),3)
    assert.equal(await page.getByRole('button',{name:'按里番刮削',exact:true}).count(),0)
    assert.equal(await page.getByRole('tab',{name:'剧情简介',exact:true}).count(),0)
    assert.equal(await detail().locator('video').count(),0)
    await page.screenshot({path:path.join(output,'audio-detail.png')})
  })
  await check('真实本地音频播放、暂停、点击歌词定位及全局下一曲联动',async()=>{
    await detail().getByRole('button',{name:'播放当前曲目',exact:true}).click()
    await page.waitForFunction(()=>{const a=document.querySelector('.audio-mini audio') as HTMLAudioElement;return a&&!a.paused&&a.currentTime>0})
    await detail().getByRole('button',{name:/跳转到 .*沿着河岸/}).click();await page.waitForFunction(()=>{const a=document.querySelector('.audio-mini audio') as HTMLAudioElement;return a.currentTime>=18&&a.currentTime<25})
    await page.locator('.lyric-current').filter({hasText:'沿着河岸'}).waitFor()
    await detail().getByRole('button',{name:'暂停当前曲目',exact:true}).click();assert.equal(await page.locator('.audio-mini audio').evaluate((a:HTMLAudioElement)=>a.paused),true)
    await page.getByRole('button',{name:'下一曲',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.audio-mini-title')?.textContent?.includes('晚风'))
    await page.getByRole('button',{name:'播放清单',exact:true}).click();await page.locator('.audio-queue-panel').waitFor()
    assert.equal(await page.locator('.audio-queue-item').count(),3)
    await page.keyboard.press('Escape');assert.equal(await page.locator('.audio-queue-panel').count(),0)
    await detail().getByText(/暂无本地歌词。可将同名/).waitFor();assert.equal(await detail().getByText('城市慢慢醒来',{exact:true}).count(),0)
    await page.screenshot({path:path.join(output,'no-lyrics.png')})
  })
  await check('纯文本歌词安全展示，快速切曲不显示迟到歌词',async()=>{
    await detail().getByRole('button',{name:'查看歌词 来信',exact:true}).click();await detail().getByText('这是一封写给旅人的信',{exact:true}).waitFor()
    assert.equal(await detail().locator('.lyrics-body script').count(),0)
    await app.evaluate(({ipcMain}:any)=>{const original=ipcMain._invokeHandlers.get('video:audio-lyrics');(globalThis as any).__originalLyrics=original;(globalThis as any).__delayLyrics=true;ipcMain.removeHandler('video:audio-lyrics');ipcMain.handle('video:audio-lyrics',async(...args:any[])=>{const result=await original(...args);if((globalThis as any).__delayLyrics){(globalThis as any).__delayLyrics=false;await new Promise(resolve=>(globalThis as any).__releaseLyrics=resolve)}return result})})
    await detail().getByRole('button',{name:'查看歌词 晨光',exact:true}).click();for(let n=0;n<100&&!(await app.evaluate(()=>!!(globalThis as any).__releaseLyrics));n++)await page.waitForTimeout(30)
    await detail().getByRole('button',{name:'查看歌词 来信',exact:true}).click();await detail().getByText('这是一封写给旅人的信',{exact:true}).waitFor()
    await app.evaluate(({ipcMain}:any)=>{(globalThis as any).__releaseLyrics();ipcMain.removeHandler('video:audio-lyrics');ipcMain.handle('video:audio-lyrics',(globalThis as any).__originalLyrics)});await page.waitForTimeout(100)
    assert.equal(await detail().getByText('城市慢慢醒来',{exact:true}).count(),0)
  })
  await check('音频信息、笔记持久化和系统播放器目标正确',async()=>{
    await page.getByRole('tab',{name:'音频信息与文件'}).click();await detail().getByText('8 kHz',{exact:true}).waitFor()
    await detail().getByRole('button',{name:'系统播放器',exact:true}).click();assert.ok((await app.evaluate(()=>(globalThis as any).__opened)).includes(third))
    await page.getByRole('tab',{name:'简介与笔记'}).click();await detail().getByLabel('音频个人笔记').fill('喜欢这一段，周末再听。');await detail().getByRole('heading',{name:'个人笔记'}).click()
    await page.waitForFunction(async id=>(await window.baoyi.video.get(id))?.notes==='喜欢这一段，周末再听。',album)
    await page.reload();await detail().getByLabel('音频个人笔记').waitFor();assert.equal(await detail().getByLabel('音频个人笔记').inputValue(),'喜欢这一段，周末再听。')
  })
  await check('窄窗布局、返回音频范围及播放器标题直达当前曲目',async()=>{
    await page.getByRole('tab',{name:'曲目与歌词'}).click();await detail().getByRole('button',{name:'查看歌词 晚风',exact:true}).click();await detail().getByRole('button',{name:'播放当前曲目',exact:true}).click();await page.locator('.audio-mini-title').waitFor();await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(940,760));await page.waitForFunction(()=>innerWidth<1000)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(output,'audio-narrow.png')})
    await detail().getByRole('button',{name:'返回音频库',exact:true}).click();await page.locator('.audio-cards').waitFor();assert.equal(await page.locator('.audio-card').count(),3)
    await page.locator('.audio-mini-title').click();await detail().getByText(/暂无本地歌词。可将同名/).waitFor()
    await page.getByRole('button',{name:'关闭音频播放器',exact:true}).click();await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(1280,800))
  })
  await check('跨模块持续播放、全局暂停与下一曲，隐私切换撤销播放器',async()=>{
    await detail().getByRole('button',{name:'查看歌词 晨光',exact:true}).click();await detail().getByRole('button',{name:'播放当前曲目',exact:true}).click()
    await page.waitForFunction(()=>{const a=document.querySelector('.audio-mini audio') as HTMLAudioElement;return a&&!a.paused&&a.currentTime>0})
    const before=await page.locator('.audio-mini audio').evaluate((a:HTMLAudioElement)=>a.currentTime);await route('/document')
    await page.waitForFunction(before=>{const a=document.querySelector('.audio-mini audio') as HTMLAudioElement;return a&&!a.paused&&a.currentTime>before+.15},before)
    await page.getByRole('button',{name:'暂停音频',exact:true}).click();assert.equal(await page.locator('.audio-mini audio').evaluate((a:HTMLAudioElement)=>a.paused),true)
    await page.getByRole('button',{name:'下一曲',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.audio-mini-title')?.textContent?.includes('晚风'))
    await page.getByRole('button',{name:'播放清单',exact:true}).click();await page.locator('.audio-queue-panel').waitFor()
    assert.equal(await page.locator('.audio-queue-item').count(),3)
    await page.keyboard.press('Escape');assert.equal(await page.locator('.audio-queue-panel').count(),0)
    await page.evaluate(()=>window.baoyi.settings.patch({hide_hentai:true}));await page.locator('.audio-mini').waitFor({state:'detached'})
    await page.evaluate(()=>window.baoyi.settings.patch({hide_hentai:false}));await route('/video/'+album);await detail().waitFor()
  })
  await check('缺失曲目禁播且不残留歌词，原电影仍进入影视详情',async()=>{
    fs.unlinkSync(first);await page.reload();await detail().getByRole('button',{name:'查看歌词 晨光',exact:true}).click();await detail().getByText(/曲目文件不可用，无法读取歌词/).waitFor()
    assert.equal(await detail().getByRole('button',{name:'播放当前曲目',exact:true}).isDisabled(),true)
    await route('/video/'+movie);await page.getByRole('tab',{name:'剧情简介',exact:true}).waitFor();assert.equal(await page.locator('.audio-detail').count(),0)
  })
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:checks.length,checks,errors,profile,executable:packed||'development',boundary:'Real Electron UI, local audio protocol, silent WAV playback, LRC/TXT reads and SQLite. OS shell dispatch stubbed; no user data or online music fetched.'},null,2))
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors},null,2));throw error}
finally{await app.close()}
