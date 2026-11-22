import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadPlaywright, electronTestEnv } from './helpers/playwright.ts'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createVideoJobStore } from '../electron/kinds/video/download/jobs.ts'
const {_electron}=loadPlaywright()
const version=JSON.parse(fs.readFileSync('package.json','utf8')).version
const output=path.resolve(`output/release-${version}/progress-ui`);fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),db=new DatabaseSync(path.join(profile,'baoyi.db'))
initSchema(db,KINDS)
for(const[key,value]of Object.entries({onboarded:true,hanime_builtin_hosts:false,theme:'light'}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const job:any={id:'progress-fixture',resourceId:'',bundleId:'progress-fixture',title:'下载进度示例',category:'其他',videoCode:'100',root:profile,directory:profile,sourceLabel:'720p',strictQuality:false,register:false,episodeMetadata:{},status:'partial',createdAt:Date.now(),updatedAt:Date.now(),message:'等待重试',description:'',posterUrl:'',posterPath:'',sources:[],warnings:[],catalogue:[],items:[{videoCode:'100',title:'测试视频',order:1,path:path.join(profile,'test.mp4'),sourceLabel:'720p',transfer:'failed',metadata:'pending',registration:'pending',receivedBytes:0,totalBytes:0,error:'本地测试',warnings:[]}]}
createVideoJobStore(db).save(job);db.close()
const env = electronTestEnv();delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const application=await _electron.launch({executablePath:path.resolve(process.argv[2]||`release/${version}/win-unpacked/抱一.exe`),args:['--user-data-dir='+profile,'--disable-gpu'],env,timeout:30000})
const errors:string[]=[],checks:string[]=[]
try{
  const runtime=await application.evaluate(({app}:any)=>({profile:app.getPath('userData'),version:app.getVersion(),isPackaged:app.isPackaged}))
  assert.equal(runtime.profile.toLowerCase(),profile.toLowerCase());assert.equal(runtime.version,version);assert.equal(runtime.isPackaged,true)
  const page=await application.firstWindow();page.on('pageerror',(e:Error)=>errors.push(e.message))
  await page.getByRole('button',{name:/^影视\s/}).click()
  await page.getByRole('button',{name:/^影视日志/}).click()
  await page.getByRole('button',{name:/下载记录/}).click()
  const card=page.locator('.download-task').filter({hasText:'下载进度示例'})
  await card.waitFor()
  const update=async(message:string,bytes:number,total:number)=>{
    job.status='running';job.message='正在下载测试视频';Object.assign(job.items[0],{transfer:'running',error:'',transferMessage:message,receivedBytes:bytes,totalBytes:total,bytesPerSecond:bytes?1048576:0})
    await application.evaluate(({BrowserWindow}:any,data:any)=>BrowserWindow.getAllWindows()[0].webContents.send('video-workflow:changed',data),job)
    await card.locator('[role="status"]').filter({hasText:message}).waitFor()
  }
  await update('正在连接并请求 DASH 播放清单',0,0)
  assert.match(await card.locator('[role="status"]').innerText(),/0 B/);checks.push('unknown-size-connection-stage-is-visible')
  await update('已下载 4/32 个 HLS 分片，正在接收',50*1048576,0)
  assert.match(await card.locator('[role="status"]').innerText(),/50.*MB/)
  assert.equal(await card.locator('details').getAttribute('open'),null);checks.push('live-fragment-bytes-count-and-speed-with-collapsed-details')
  await update('从已校验的下载缓存继续',60*1048576,100*1048576)
  assert.match(await card.locator('[role="status"]').innerText(),/60%/);checks.push('resumed-byte-count-and-known-percentage')
  await update('已降为单连接，补齐未完成部分',60*1048576,100*1048576);checks.push('degraded-connection-stage-is-visible')
  await update('FFmpeg 正在合并音视频，下载字节已接收完毕',100*1048576,100*1048576)
  checks.push('ffmpeg-finalization-distinguished-from-transfer')
  for(const width of[1280,960]){await application.evaluate(({BrowserWindow}:any,w:number)=>BrowserWindow.getAllWindows()[0].setContentSize(w,800),width);await page.screenshot({path:path.join(output,`progress-${width}.png`)});assert.equal(await card.evaluate((el:HTMLElement)=>el.scrollWidth>el.clientWidth),false)}
  checks.push('1280-and-960-no-card-overflow');assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({status:'passed',version,profile,runtime,checks,errors},null,2)+'\n')
  console.log(`PASS packaged progress UI: ${checks.length} checks; ${errors.length} page errors`)
}catch(error){const page=application.windows()[0];if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error}finally{await application.close()}
