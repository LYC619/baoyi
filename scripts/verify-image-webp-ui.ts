/** Regression for WebP thumbnails through the actual Electron protocol and renderer. */
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
const require=createRequire(import.meta.url),{_electron}=require(process.env.BAOYI_PLAYWRIGHT||'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output=path.resolve('output/webp-hotfix'+(process.argv[2]?'-packaged':''));fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),media=path.join(profile,'synthetic-webp');fs.mkdirSync(media)
const webp=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64')
fs.writeFileSync(path.join(media,'1.WebP'),webp);fs.writeFileSync(path.join(media,'2.jpg'),webp);fs.writeFileSync(path.join(media,'3.png'),pngImage(800,1000))
const db=new DatabaseSync(path.join(profile,'baoyi.db'));db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'dark',hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const library=new ImageLibrary(db),item=library.register((await scanImageImport(media,'comic',false))[0]),pages=library.pages(item.id)
const hidden=library.saveGroup({name:'合成隐藏分类'});db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const app=await _electron.launch({executablePath:path.resolve(process.argv[2]||'node_modules/electron/dist/electron.exe'),args:[...(process.argv[2]?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env})
try{
 const page=await app.firstWindow();page.setDefaultTimeout(8000);const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.locator('.titlebar').waitFor()
 const decoded=await app.evaluate(({nativeImage}:any,b64:string)=>nativeImage.createFromBuffer(Buffer.from(b64,'base64')).isEmpty(),webp.toString('base64'))
 assert.equal(decoded,true,'fixture must exercise the native decoder limitation')
 const fetchPage=async(id:string,thumb:boolean)=>app.evaluate(async({net}:any,{id,thumb}:{id:string;thumb:boolean})=>{const response=await net.fetch(`baoyi://image/${id}${thumb?'?thumb=1':''}`);return {status:response.status,mime:response.headers.get('content-type'),bytes:(await response.arrayBuffer()).byteLength}},{id,thumb})
 for(const p of pages.slice(0,2)){
  assert.equal((await fetchPage(p.id,false)).status,200)
  const thumb=await fetchPage(p.id,true);assert.equal(thumb.status,200,'valid WebP thumbnail must not become a 404');assert.equal(thumb.mime,'image/webp')
 }
 const pngThumb=await fetchPage(pages[2].id,true);assert.equal(pngThumb.status,200);assert.equal(pngThumb.mime,'image/jpeg')
 await page.evaluate(()=>{location.hash='/image'})
 await page.waitForFunction(()=>{const img=document.querySelector('.image-card img') as HTMLImageElement;return img?.naturalWidth===1})
 await page.locator('.image-card__open').click()
 await page.waitForFunction(()=>{const imgs=[...document.querySelectorAll('.image-detail .image-cover img')] as HTMLImageElement[];return imgs.length===4&&imgs.every(img=>img.complete&&img.naturalWidth>0)})
 await page.getByRole('button',{name:'开始阅读',exact:true}).click();await page.waitForFunction(()=>(document.querySelector('.reader-sheet img') as HTMLImageElement)?.naturalWidth===1)
 await page.getByLabel('后一页',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('.reader-bottom span')?.textContent?.includes('2 / 3'));await page.waitForFunction(()=>(document.querySelector('.reader-sheet img') as HTMLImageElement)?.naturalWidth===1)
 await page.getByLabel('关闭阅读器',{exact:true}).click()
 await page.evaluate(({id,groupId}:{id:string;groupId:string})=>window.baoyi.image.update(id,{groupId}),{id:item.id,groupId:hidden.id})
 await page.evaluate((group:any)=>window.baoyi.image.saveGroup({...group,hidden:true}),hidden)
 assert.equal((await fetchPage(pages[0].id,true)).status,404,'hidden works must remain protected after fallback')
 assert.equal((await fetchPage(pages[2].id,true)).status,404,'cached JPEG thumbnails must also stay protected')
 assert.deepEqual(errors,[])
 const checks=['WebP and mislabeled-JPG full images','native-decoder thumbnail fallback','PNG JPEG thumbnail unchanged','shelf/detail/preview/reader decoded','hidden group authorization after cache']
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,errors,profile},null,2));console.log('PASS '+checks.join(', '))
}finally{await app.close()}
