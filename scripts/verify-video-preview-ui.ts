import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
const {_electron}=loadPlaywright(),packed=process.argv[2],output=path.resolve(process.argv[3]||'output/p1-p2-video-2026-11-06/native-preview')
fs.mkdirSync(output,{recursive:true});const profile=fs.mkdtempSync(path.join(output,'profile-')),media=path.join(profile,'media');fs.mkdirSync(media)
// Generated canvas/VP8 fixture from verify-online-source-ui.ts; no user media.
const file=path.join(media,'合成.webm'),broken=path.join(media,'损坏.mp4');fs.copyFileSync('output/online-source-ui/demo/video.webm',file);fs.writeFileSync(broken,'synthetic broken video')
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value]of Object.entries({onboarded:true,theme:'light',hide_hentai:false,hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const a=registerVideoContent(db,{title:'合成试看',category:'其他',videoType:'movie',items:[{title:'本地视频',order:1,files:[{path:file},{path:broken}]}]});db.close()
const app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()})
const page=await app.firstWindow(),checks:string[]=[],errors:string[]=[];page.setDefaultTimeout(20000);page.on('pageerror',(error:Error)=>errors.push(error.message))
async function check(name:string,fn:()=>Promise<void>){await fn();checks.push(name);console.log('PASS '+name)}
try{
  assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile)
  await page.waitForFunction(()=>!!window.baoyi?.video?.preview);await page.getByRole('button',{name:/^影视\s/}).click()
  await check('卡片独立试看按钮、多个副本明确选择、原生WebM播放与Range',async()=>{
    await page.getByRole('button',{name:'试看视频',exact:true}).click();await page.getByRole('dialog',{name:'视频试看'}).waitFor()
    assert.equal(await page.locator('video').count(),0)
    await page.getByLabel('选择本地视频').selectOption({label:'本地视频 · 合成.webm'})
    await page.waitForFunction(()=>document.querySelector('video')!.readyState>=2)
    await page.locator('video').evaluate((element:HTMLVideoElement)=>element.play())
    await page.waitForFunction(()=>document.querySelector('video')!.currentTime>.1)
    const url=(await page.locator('video').getAttribute('src'))!
    const range=await app.evaluate(async({net}:any,url:string)=>{const response=await net.fetch(url,{headers:{Range:'bytes=0-7'}});return {status:response.status,length:(await response.arrayBuffer()).byteLength}},url)
    assert.deepEqual(range,{status:206,length:8});await page.screenshot({path:path.join(output,'playing.png')})
  })
  let oldUrl=''
  await check('ESC释放token并恢复焦点；损坏文件给出降级入口',async()=>{
    oldUrl=(await page.locator('video').getAttribute('src'))!;await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'视频试看'}).waitFor({state:'detached'})
    assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'试看视频')
    assert.equal(await app.evaluate(async({net}:any,url:string)=>(await net.fetch(url)).status,oldUrl),404)
    await page.getByRole('button',{name:'试看视频',exact:true}).click();await page.getByLabel('选择本地视频').selectOption({label:'本地视频 · 损坏.mp4'})
    await page.locator('.preview-error').waitFor();assert.ok(await page.getByRole('button',{name:'系统播放器',exact:true}).isVisible())
    await app.evaluate(({shell}:any)=>{(globalThis as any).__previewOpens=[];shell.openPath=async(file:string)=>{(globalThis as any).__previewOpens.push(file);return ''}})
    await page.getByRole('button',{name:'系统播放器',exact:true}).click();assert.deepEqual(await app.evaluate(()=>(globalThis as any).__previewOpens),[broken])
  })
  await check('800px无横溢出，隐私切换关闭试看，不写观看进度',async()=>{
    await app.evaluate(({BrowserWindow}:any)=>{const win=BrowserWindow.getAllWindows()[0];win.setMinimumSize(640,600);win.setContentSize(800,800)})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));await page.screenshot({path:path.join(output,'preview-800.png')})
    await page.evaluate(()=>window.baoyi.settings.patch({hide_hentai:true}));await page.getByRole('dialog',{name:'视频试看'}).waitFor({state:'detached'})
    const item=await page.evaluate(id=>window.baoyi.video.get(id),a.resourceId);assert.equal(item?.watch_status,'unwatched')
  })
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({checks,passed:checks.length,errors,profile,packaged:!!packed},null,2))
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:(error as Error).stack},null,2));throw error}
finally{await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows().forEach((window:any)=>window.destroy())).catch(()=>{});await app.close().catch(()=>{})}
