import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {DatabaseSync} from 'node:sqlite'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {frameFfmpeg} from '../electron/kinds/video/frame-generator.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
const {_electron}=loadPlaywright(),ffmpeg=await frameFfmpeg(process.argv[2]||process.env.BAOYI_TEST_FFMPEG||''),packed=process.argv[4],output=path.resolve(process.argv[5]||'output/p1-p2-video-2026-11-06/native-codecs');assert.ok(ffmpeg,'显式提供FFmpeg路径（通过参数或 BAOYI_TEST_FFMPEG）')
await fs.mkdir(output,{recursive:true});const profile=await fs.mkdtemp(path.join(output,'profile-')),exec=promisify(execFile),matrix=process.argv[3]?path.resolve(process.argv[3]):path.join(profile,'matrix');if(!process.argv[3]){await fs.mkdir(matrix,{recursive:true});await exec(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-c:a','libopus','-threads','2',path.join(matrix,'vp9-opus.webm')],{windowsHide:true,timeout:90000});await exec(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libvpx','-deadline','realtime','-cpu-used','8','-c:a','libvorbis','-threads','2',path.join(matrix,'vp8-vorbis.webm')],{windowsHide:true,timeout:90000});await exec(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:size=640x360:rate=1','-t','3600','-c:v','libx264','-preset','ultrafast','-g','3600','-keyint_min','3600','-sc_threshold','0','-pix_fmt','yuv420p','-threads','2',path.join(matrix,'one-hour-long-gop.mp4')],{windowsHide:true,timeout:90000})}
const avc=path.join(profile,'h264-aac.mp4'),unsupported=path.join(profile,'ffv1.mkv')
await exec(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-threads','2',avc],{windowsHide:true,timeout:30000})
await exec(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-i',avc,'-c:v','ffv1','-an','-threads','2',unsupported],{windowsHide:true,timeout:30000})
const samples=[['H264 AAC',avc],['VP9 Opus',path.join(matrix,'vp9-opus.webm')],['VP8 Vorbis',path.join(matrix,'vp8-vorbis.webm')],['Unsupported FFV1',unsupported],['Long GOP',path.join(matrix,'one-hour-long-gop.mp4')]]
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hide_hentai:false,hanime_builtin_hosts:false,ffmpeg_path:ffmpeg}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
for(const [title,file] of samples)registerVideoContent(db,{title,category:'其他',videoType:'movie',items:[{title,order:1,files:[{path:file}]}]});db.close()
const app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()}),page=await app.firstWindow(),checks:string[]=[],errors:string[]=[],playback:any[]=[]
page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message))
try{
 assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile)
 await page.waitForFunction(()=>!!window.baoyi?.video?.preview);await page.getByRole('button',{name:/^影视\s/}).click()
 for(const [title] of samples.slice(0,4)){
  const card=page.locator('article.card').filter({hasText:title});await card.getByRole('button',{name:'试看视频',exact:true}).click()
  if(title==='Unsupported FFV1'){await page.locator('.preview-error').waitFor();assert.ok(await page.getByRole('button',{name:'系统播放器',exact:true}).isVisible());playback.push({title,status:'external fallback'})}
  else {await page.waitForFunction(()=>document.querySelector('video')!.readyState>=2);await page.locator('video').evaluate((video:HTMLVideoElement)=>video.play());await page.waitForFunction(()=>document.querySelector('video')!.currentTime>.1);playback.push(await page.locator('video').evaluate((video:HTMLVideoElement)=>({width:video.videoWidth,height:video.videoHeight,currentTime:video.currentTime})));checks.push(title+' 原生播放通过')}
  await page.keyboard.press('Escape');await page.locator('video').waitFor({state:'detached'})
 }
 checks.push('不支持的FFV1显示系统播放器降级入口')
 await page.evaluate(()=>{(window as any).__frames=[];window.baoyi.video.preview.onFrames(value=>(window as any).__frames.push({at:performance.now(),...value}))})
 const long=page.locator('article.card').filter({hasText:'Long GOP'});await long.getByRole('button',{name:'试看视频',exact:true}).click();await page.getByRole('button',{name:'展开代表帧',exact:true}).click()
 await page.waitForFunction(()=>(window as any).__frames.some((s:any)=>s.status==='running'&&s.times.length===8&&s.url))
 await page.locator('.frame-contact button').first().waitFor();await page.screenshot({path:path.join(output,'first-eight.png')})
 await page.waitForFunction(()=>(window as any).__frames.some((s:any)=>s.status==='ready'&&s.times.length===24))
 assert.equal(await page.locator('.frame-contact button').count(),24)
 const states=await page.evaluate(()=>(window as any).__frames),partial=states.find((s:any)=>s.status==='running'&&s.url),complete=states.find((s:any)=>s.status==='ready');assert.ok(partial.at<complete.at);assert.notEqual(partial.url,complete.url)
 const finalImage=await app.evaluate(async({net}:any,url:string)=>{const response=await net.fetch(url);return {status:response.status,bytes:(await response.arrayBuffer()).byteLength}},complete.url);assert.equal(finalImage.status,200);assert.ok(finalImage.bytes>0)
 checks.push('实际双worker先显示8帧再补齐24帧，最终图像可读')
 await page.screenshot({path:path.join(output,'complete.png')});await page.keyboard.press('Escape')
 const renamed=avc+'.renamed';await fs.rename(avc,renamed);await fs.rename(renamed,avc);checks.push('关闭试看后文件句柄释放')
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:checks.length,checks,playback,profile,packaged:!!packed,progressive:{firstMs:partial.at-states[0].at,completeMs:complete.at-states[0].at},errors},null,2))
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,playback,errors},null,2));throw error}
finally{await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows().forEach((w:any)=>w.destroy())).catch(()=>{});await app.close().catch(()=>{})}
