import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {execFileSync} from 'node:child_process'
import {frameFfmpeg} from '../electron/kinds/video/frame-generator.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
const {_electron}=loadPlaywright(),ffmpeg=await frameFfmpeg(process.argv[2]||process.env.BAOYI_TEST_FFMPEG||''),packed=process.argv[5]
assert.ok(ffmpeg,'显式提供FFmpeg路径（通过参数或 BAOYI_TEST_FFMPEG）')
const output=path.resolve(process.argv[4]||'output/p1-p2-video-2026-11-06/native-hover');fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),file=path.join(profile,'synthetic.mp4'),source=process.argv[3]?path.resolve(process.argv[3]):path.join(profile,'source.mp4');if(!process.argv[3])execFileSync(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-t','8','-c:v','libx264','-preset','ultrafast','-threads','2','-pix_fmt','yuv420p',source],{windowsHide:true,timeout:30000});fs.copyFileSync(source,file)
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value]of Object.entries({onboarded:true,theme:'light',hide_hentai:false,hanime_builtin_hosts:false,ffmpeg_path:ffmpeg}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const registration=registerVideoContent(db,{title:'合成代表帧',category:'其他',videoType:'movie',items:[{title:'本地合成视频',order:1,durationSec:8,files:[{path:file}]}]});db.close()
const app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()})
const page=await app.firstWindow(),checks:string[]=[],errors:string[]=[],consoleErrors:string[]=[];page.setDefaultTimeout(30000);page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text())})
async function check(name:string,fn:()=>Promise<void>){await fn();checks.push(name);console.log('PASS '+name)}
const cacheRoot=path.join(profile,'cache','video-frames')
try{
  assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile)
  await page.waitForFunction(()=>!!window.baoyi?.video?.preview)
  const card=page.locator('article.card').filter({hasText:'合成代表帧'}),poster=card.locator('.card__poster')
  await page.evaluate(()=>{
    const events:any[]=[];(window as any).__frameEvents=events
    for(const type of ['pointerenter','pointerleave','focusout'])document.addEventListener(type,event=>{const target=event.target as HTMLElement;if(target?.matches?.('article.card'))events.push({type,at:performance.now(),pointerType:(event as PointerEvent).pointerType})},true)
    setInterval(()=>{const text=document.querySelector('.card__frame-status')?.textContent;if(text!==events.at(-1)?.text)events.push({text,at:performance.now()})},150)
  })
  await page.getByRole('button',{name:/^影视\s/}).click();await card.waitFor()
  await check('快速扫过不创建缓存、不启动后台抽帧；停留后真实FFmpeg生成',async()=>{
    const box=(await poster.boundingBox())!
    await page.mouse.move(box.x+20,box.y+20);await page.waitForTimeout(80);await page.mouse.move(5,5);await page.waitForTimeout(350)
    assert.equal(fs.existsSync(path.join(cacheRoot,'index.sqlite')),false)
    await poster.hover();await page.locator('.video-hover-picture').waitFor();await page.waitForFunction(()=>document.querySelector('.video-hover-picture')?.getAttribute('style')?.includes('baoyi:'));await page.waitForTimeout(160);const frame=await page.locator('.video-hover-picture').boundingBox();assert.ok(frame&&Math.abs(frame.width/frame.height-16/9)<.02);assert.equal(await card.locator('.card__frame,input[type=range]').count(),0);await page.screenshot({path:path.join(output,'hover.png')})
    const cache=await page.evaluate(()=>window.baoyi.video.preview.frameCache());assert.equal(cache.items,1);assert.ok(cache.bytes>0&&cache.bytes<4*1024**2)
  })
  await check('鼠标移动与键盘时间滑块、缓存复用与从当前帧试看',async()=>{
    const dir=fs.readdirSync(cacheRoot).find(name=>/^[a-f0-9]{64}$/.test(name))!,sprite=path.join(cacheRoot,dir,'sprite.jpg'),before=fs.statSync(sprite).mtimeMs
    const box=(await page.locator('.video-hover-picture').boundingBox())!;await page.mouse.move(box.x+box.width*.9,box.y+box.height*.5)
    await page.waitForTimeout(40);assert.equal(await page.getByLabel('预览时间',{exact:true}).getAttribute('aria-valuenow'),'7')
    await page.getByLabel('预览时间',{exact:true}).focus();await page.keyboard.press('Home');assert.equal(await page.getByLabel('预览时间',{exact:true}).getAttribute('aria-valuenow'),'0')
    await page.mouse.move(5,5);await page.waitForTimeout(300);await poster.hover();await page.locator('.video-hover-picture').waitFor();await page.waitForFunction(()=>document.querySelector('.video-hover-picture')?.getAttribute('style')?.includes('baoyi:'));assert.equal(fs.statSync(sprite).mtimeMs,before)
    await page.mouse.move(box.x+box.width*.9,box.y+box.height*.5);await page.waitForTimeout(60);await page.getByRole('button',{name:'从当前帧试看',exact:true}).click()
    await page.waitForFunction(()=>!!document.querySelector('video')&&document.querySelector('video')!.readyState>=2)
    assert.ok(await page.locator('video').evaluate((element:HTMLVideoElement)=>element.currentTime>0))
    await page.getByRole('button',{name:'展开代表帧',exact:true}).click();await page.locator('.frame-contact button').first().waitFor();assert.equal(await page.locator('.frame-contact button').count(),8)
    assert.deepEqual(await page.locator('.frame-contact small').allTextContents(),['0:00','0:01','0:02','0:03','0:04','0:05','0:06','0:07'],'代表帧应显示可区分的精确时间码')
    assert.match(await page.locator('.preview-meta').innerText(),/0:08/)
    assert.equal(fs.statSync(sprite).mtimeMs,before);await page.screenshot({path:path.join(output,'contact.png')})
    await page.keyboard.press('Escape')
  })
  await check('切换隐私关闭帧访问；清理缓存不改变原视频与观看状态',async()=>{
    await page.mouse.move(5,5);await page.waitForTimeout(300);await poster.hover();await page.locator('.video-hover-picture').waitFor();await page.waitForFunction(()=>document.querySelector('.video-hover-picture')?.getAttribute('style')?.includes('baoyi:'))
    const style=await page.locator('.video-hover-picture').getAttribute('style'),url=/url\(["']?([^"')]+)/.exec(style!)![1]
    await page.evaluate(()=>window.baoyi.settings.patch({hide_hentai:true}));await page.locator('.video-hover-picture').waitFor({state:'detached'})
    assert.equal(await app.evaluate(async({net}:any,url:string)=>(await net.fetch(url)).status,url),404)
    await page.evaluate(()=>window.baoyi.video.preview.clearFrames());assert.equal((await page.evaluate(()=>window.baoyi.video.preview.frameCache())).items,0)
    assert.deepEqual(fs.readFileSync(file),fs.readFileSync(source));assert.equal((await page.evaluate(id=>window.baoyi.video.get(id),registration.resourceId))?.watch_status,'unwatched')
  })
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:checks.length,checks,errors,profile,source,ffmpeg},null,2))
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});const events=await page.evaluate(()=>(window as any).__frameEvents).catch(()=>[]);fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,consoleErrors,events,error:String(error),stack:(error as Error).stack},null,2));throw error}
finally{await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows().forEach((window:any)=>window.destroy())).catch(()=>{});await app.close().catch(()=>{})}
