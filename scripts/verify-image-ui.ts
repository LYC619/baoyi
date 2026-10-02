/** Isolated application rehearsal. Arguments: [packaged executable] [optional reference artwork]. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { pngImage } from './helpers/test-images.ts'
const require=createRequire(import.meta.url)
const {_electron}=require(process.env.BAOYI_PLAYWRIGHT||'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output=path.resolve(process.env.BAOYI_IMAGE_UI_OUTPUT||'output/image-comic-verification');fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),media=path.join(profile,'media');fs.mkdirSync(media)
const db=new DatabaseSync(path.join(profile,'baoyi.db'));db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
for(const [key,value]of Object.entries({onboarded:true,theme:'dark',hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const library=new ImageLibrary(db),titles=['东京的雨','神社的阶梯','星际驾驶员','灯塔与海','雨中的咖啡馆','雪落的校园'],ids:string[]=[],covers:string[]=[]
for(const [i,title]of titles.entries()){
  const work=path.join(media,title)
  for(const chapter of ['第1话','第2话']){const dir=path.join(work,chapter);fs.mkdirSync(dir,{recursive:true});for(let n=1;n<=5;n++)fs.writeFileSync(path.join(dir,`${n}.png`),pngImage(320,470,[35+i*24,65+i*10,115+i*12]))}
  const item=library.register((await scanImageImport(work,'comic',false))[0]);ids.push(item.id);covers.push(library.pages(item.id)[0].file)
  library.update(item.id,{groupId:`image-group-${i%4}`,publication:i===3?'completed':'ongoing',tags:['合成验证'],description:'用于隔离界面验证的示例资料，不写入正式资料库。'})
  if(i<4)library.saveProgress(item.id,library.pages(item.id)[i+1].id,0)
}
const album=path.join(media,'旅行相册');fs.mkdirSync(album);for(let i=0;i<9;i++)fs.writeFileSync(path.join(album,`${i}.png`),pngImage(400,260,[60+i*12,100,140]))
library.register((await scanImageImport(album,'photo',false))[0]);db.close()
const packed=!!process.argv[2]&&process.argv[2]!=='-'
const executable=path.resolve(packed?process.argv[2]:'node_modules/electron/dist/electron.exe'),artwork=process.argv[3] ? path.resolve(process.argv[3]):''
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const args=[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu']
let application=await _electron.launch({executablePath:executable,args,env,timeout:30000})
const checks:string[]=[],errors:string[]=[]
try{
  assert.equal(path.resolve(await application.evaluate(({app}:any)=>app.getPath('userData'))),profile)
  if(artwork&&fs.existsSync(artwork))await application.evaluate(({nativeImage}:any,{artwork,covers}:any)=>{const fs=require('node:fs');const image=nativeImage.createFromPath(artwork);const positions=[347,647,932,1213,1474,1758];for(let i=0;i<covers.length;i++)fs.writeFileSync(covers[i],image.crop({x:positions[i],y:550,width:i===0?267:230,height:385}).toPNG())},{artwork,covers})
  const page=await application.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',(e:Error)=>errors.push(e.message))
  await page.waitForFunction(()=>!!window.baoyi?.image)
  await page.evaluate(()=>{location.hash='/image'})
  await page.waitForSelector('.image-card');assert.equal(await page.locator('.image-card').count(),6)
  const exposedPages=await page.evaluate(async(id:string)=>window.baoyi.image.pages(id),ids[0])
  assert.ok(exposedPages.length>0)
  assert.equal('file' in exposedPages[0],false,'页面列表不应向渲染进程暴露磁盘文件路径')
  assert.equal('entry' in exposedPages[0],false,'页面列表不应向渲染进程暴露归档条目路径')
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.image-card img')).every(i=>(i as HTMLImageElement).complete&&(i as HTMLImageElement).naturalWidth>0))
  checks.push('native-db-preload-and-thumbnail-protocol')
  await application.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(1440,900))
  await page.screenshot({path:path.join(output,'bookshelf.png')})
  await page.getByLabel('搜索图片库').fill('灯塔');assert.equal(await page.locator('.image-card').count(),1)
  await page.getByLabel('搜索图片库').fill('')
  await page.locator('.image-card').filter({hasText:'东京的雨'}).click();await page.getByRole('button',{name:'继续阅读',exact:true}).click()
  await page.waitForSelector('.image-reader');await page.waitForFunction(()=>{const img=document.querySelector('.reader-sheet img') as HTMLImageElement;return img?.complete&&img.naturalWidth>0})
  assert.match(await page.locator('.reader-bottom span').innerText(),/2 \/ 10/)
  await page.keyboard.press('ArrowRight');assert.match(await page.locator('.reader-bottom span').innerText(),/3 \/ 10/)
  await page.getByLabel('双页阅读',{exact:true}).click();assert.equal(await page.locator('.reader-sheet').count(),2)
  await page.getByLabel('阅读进度').evaluate((el:HTMLInputElement)=>{el.value='4';el.dispatchEvent(new Event('input',{bubbles:true}))})
  await page.waitForFunction(()=>document.querySelector('.reader-bottom span')?.textContent?.includes('4 / 10'))
  assert.equal(await page.locator('.reader-sheet').count(),2,'封面独立后，第一页的后一组应为本章第4-5页')
  await page.keyboard.press('ArrowRight');assert.match(await page.locator('.reader-bottom span').innerText(),/6 \/ 10/)
  await page.keyboard.press('ArrowLeft');assert.match(await page.locator('.reader-bottom span').innerText(),/4 \/ 10/)
  await page.getByLabel('阅读进度').evaluate((el:HTMLInputElement)=>{el.value='9';el.dispatchEvent(new Event('input',{bubbles:true}))})
  await page.waitForFunction(()=>document.querySelector('.reader-bottom span')?.textContent?.includes('10 / 10'))
  assert.equal(await page.locator('.reader-sheet').count(),1,'末章奇数页应独立显示')
  await page.getByLabel('连续阅读',{exact:true}).click();assert.ok(await page.locator('.reader-strip-page img').count()<=7)
  await page.screenshot({path:path.join(output,'reader.png')})
  await page.getByLabel('关闭阅读器',{exact:true}).click();await page.waitForSelector('.image-reader',{state:'detached'})
  const saved=await page.evaluate(async(id:string)=>(await window.baoyi.image.get(id))?.progress,ids[0]);assert.ok(saved)
  await page.reload();await page.waitForSelector('.detail-actions');const after=await page.evaluate(async(id:string)=>(await window.baoyi.image.get(id))?.progress,ids[0]);assert.equal(after?.pageId,saved.pageId)
  checks.push('single-double-scroll-reading-and-progress-persistence')
  await page.getByRole('button',{name:'返回书架',exact:true}).click();await page.getByRole('button',{name:'照片',exact:true}).click();assert.equal(await page.locator('.image-card').count(),1)
  await page.locator('.image-card').click();await page.getByRole('button',{name:'浏览照片',exact:true}).click();assert.equal(await page.getByLabel('阅读模式',{exact:true}).count(),0);await page.getByLabel('关闭阅读器',{exact:true}).click();checks.push('album-grid-and-lightbox')
  await page.getByRole('button',{name:'返回书架',exact:true}).click();await page.getByRole('button',{name:'漫画',exact:true}).click()
  await application.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(960,640))
  await page.screenshot({path:path.join(output,'bookshelf-960.png')})
  const overflow=await page.locator('.image-content').evaluate((el:HTMLElement)=>el.scrollWidth>el.clientWidth);assert.equal(overflow,false)
  await page.getByRole('button',{name:'从哔咔添加',exact:true}).click();await page.getByRole('dialog',{name:'从哔咔添加',exact:true}).waitFor()
  const accountInput=page.getByLabel('用户名',{exact:true});await accountInput.fill('comic_reader');assert.equal(await accountInput.getAttribute('type'),'text');assert.equal(await accountInput.evaluate((el:HTMLInputElement)=>el.checkValidity()),true)
  await page.getByLabel('关闭哔咔',{exact:true}).click();checks.push('minimum-window-and-source-login-dialog')
  await application.evaluate(({dialog}:any,root:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]})},path.join(media,titles[0]))
  await page.getByRole('button',{name:'导入目录',exact:true}).click();await page.getByRole('button',{name:'选择文件夹',exact:true}).click();await page.getByRole('button',{name:'确认导入',exact:true}).click();await page.getByRole('dialog',{name:'导入图片',exact:true}).waitFor({state:'hidden'})
  assert.equal(await page.locator('.image-card').count(),6);checks.push('native-import-preview-confirm-and-deduplication')
  await application.close();application=await _electron.launch({executablePath:executable,args,env,timeout:30000})
  const restarted=await application.firstWindow();await restarted.waitForFunction(()=>!!window.baoyi?.image)
  const resumed=await restarted.evaluate(async(id:string)=>(await window.baoyi.image.get(id))?.progress,ids[0]);assert.equal(resumed?.pageId,saved.pageId);checks.push('application-restart-progress-persistence')
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({profile,executable,checks,errors},null,2))
  console.log('PASS '+checks.join(', '))
}finally{await application.close()}
