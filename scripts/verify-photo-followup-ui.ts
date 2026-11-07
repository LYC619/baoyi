import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { reserveWorkDirectory,writeBundleFiles } from '../electron/kinds/video/bundle.ts'
import { registerVideoBundleData } from '../electron/kinds/video/registration.ts'
import { pngImage } from './helpers/test-images.ts'
const require=createRequire(import.meta.url),{_electron}=require('playwright')
const packed=process.argv[2],output=process.argv[3]?path.resolve(process.argv[3]):path.resolve('output/photo-followup-2026-10-29',packed?'packaged-ui':'native-ui');fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value]of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const lib=new ImageLibrary(db),group=lib.saveGroup({name:'浏览保存',type:'photo'}),folder=path.join(profile,'photos');fs.mkdirSync(folder)
fs.writeFileSync(path.join(folder,'1.png'),pngImage(160,240));const photo=lib.register((await scanImageImport(folder,'photo',false))[0]);lib.update(photo.id,{groupId:group.id})
const firstId=lib.pages(photo.id)[0].id
fs.writeFileSync(path.join(folder,'2.png'),pngImage(240,160)) // Added while app is closed.
const {directory,bundleId}=reserveWorkDirectory(profile,'删除残留样例','ui-fixture'),video=path.join(directory,'1.mp4');fs.writeFileSync(video,'fixture')
const input={directory,bundleId,title:'删除残留样例',description:'自动生成资料',files:[{path:video,title:'第一集',order:1}]};writeBundleFiles(input)
const videoId=registerVideoBundleData(db,directory,writeBundleFiles(input).bundle).resourceId
db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env})
const checks:string[]=[],errors:string[]=[]
try {
 const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',(e:Error)=>errors.push(e.message))
 assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile)
 await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(1360,940))
 await page.waitForFunction(()=>!!window.baoyi?.image);await page.evaluate(()=>{localStorage.setItem('image-view-photo',JSON.stringify({display:'albums',layout:'adaptive',grouping:'directory'}));location.hash='/image'});await page.reload()
 await page.getByRole('navigation',{name:'图片分类'}).getByRole('button',{name:'照片',exact:true}).click()
 await page.getByLabel('图片展示方式').selectOption('albums')
 await page.locator('.image-types button').filter({hasText:'浏览保存'}).click()
 await page.getByRole('heading',{name:'浏览保存',exact:true}).waitFor()
 await page.waitForFunction(()=>document.querySelectorAll('.photo-tile').length===2)
 assert.equal(await page.locator('.image-card').count(),0);assert.equal(await page.locator('.photo-folder>header').count(),0)
 await page.locator('.photo-tile').first().click();await page.waitForFunction(()=>!!document.querySelector('.reader-bottom'));await page.getByLabel('关闭阅读器',{exact:true}).click()
 checks.push('category directly displays individual pictures despite legacy album preference; startup catches offline additions')
 fs.writeFileSync(path.join(folder,'3.png'),pngImage(260,170))
 await page.waitForFunction(()=>document.querySelectorAll('.photo-tile').length===3)
 fs.writeFileSync(path.join(folder,'1.png'),pngImage(360,180))
 await page.waitForFunction(()=>{const image=document.querySelector<HTMLImageElement>('.photo-tile img');return image?.complete&&image.naturalWidth===360&&image.naturalHeight===180})
 fs.unlinkSync(path.join(folder,'3.png'));await page.waitForFunction(()=>document.querySelectorAll('.photo-tile').length===2)
 const now=await page.evaluate(async(id:string)=>({item:await window.baoyi.image.get(id),pages:await window.baoyi.image.pages(id)}),photo.id)
 assert.equal(now.pages[0].id,firstId);assert.equal(now.item.groupId,group.id)
 await page.screenshot({path:path.join(output,'category-live.png')})
 checks.push('native folder events update add/replace/delete and thumbnails without refresh; IDs/categories retained')
 await page.getByRole('button',{name:'管理组合',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.image-card').length===1)
 await page.locator('.image-types button').filter({hasText:'全部照片'}).click();await page.locator('.image-types button').filter({hasText:'浏览保存'}).click();await page.waitForFunction(()=>document.querySelectorAll('.photo-tile').length===2)
 await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(1024,768))
 assert.ok(await page.locator('.image-content').evaluate((e:HTMLElement)=>e.scrollWidth<=e.clientWidth+1))
 checks.push('explicit management remains available; returning to category restores pictures; 1024px layout fits')
 await page.evaluate(()=>{location.hash='/settings?module=image&tab=scan'})
 await page.getByLabel('图片类型',{exact:true}).selectOption('photo');await page.getByText('已导入的本地文件夹自动更新：',{exact:false}).waitFor()
 checks.push('settings explain automatic synchronization scope')
 const preview=await page.evaluate(async(id:string)=>window.baoyi.video.previewRemoval({resourceIds:[id],action:'remove',deleteLocal:true}),videoId)
 assert.ok(preview.files.some((f:any)=>path.basename(f.path)==='baoyi.json.bak'))
 await page.evaluate((id:string)=>{location.hash='/video/'+id},videoId)
 await page.locator('summary').filter({hasText:'更多'}).click()
 await page.getByRole('button',{name:'移除',exact:true}).click()
 await page.getByLabel('同时将专属本地文件移入回收站').check()
 await page.locator('.video-removal li').filter({hasText:'baoyi.json.bak'}).waitFor()
 await page.screenshot({path:path.join(output,'video-removal-preview.png')})
 // Exercise Electron's real recycle-bin boundary only on this isolated fixture.
 await page.getByRole('button',{name:'删除记录并移入回收站',exact:true}).click()
 await page.waitForFunction(()=>!document.querySelector('.video-removal'))
 assert.equal(fs.existsSync(directory),false);assert.ok(fs.existsSync(folder))
 checks.push('native video removal IPC recycles managed companions and removes empty directory')
 // Restore only entries from this unique isolated fixture, never other recycle-bin files.
 fs.mkdirSync(directory,{recursive:true})
 const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'"
 const restoreScript=`$ErrorActionPreference='Stop'
$fixtureDirectory=${literal(directory)}
$shell=New-Object -ComObject Shell.Application
$bin=$shell.Namespace(10)
$items=@($bin.Items() | Where-Object { $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq $fixtureDirectory })
if($items.Count -eq 0){throw 'No isolated recycle entries found'}
foreach($item in $items){$item.InvokeVerb('undelete')}
$deadline=[DateTime]::UtcNow.AddSeconds(15)
while(!(Test-Path -LiteralPath ${literal(path.join(directory,'baoyi.json'))}) -or !(Test-Path -LiteralPath ${literal(video)})){
 if([DateTime]::UtcNow -gt $deadline){throw 'Isolated recycle restore timed out'}
 Start-Sleep -Milliseconds 100
}
Write-Output ('Restored isolated entries: '+$items.Count)`
 console.log(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(restoreScript,'utf16le').toString('base64')],{encoding:'utf8',timeout:25000,windowsHide:true}).trim())
 for(const file of preview.files) assert.ok(fs.existsSync(file.path),file.path)
 await app.evaluate(({dialog}:any,dir:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]})},directory)
 const restored=await page.evaluate(()=>window.baoyi.video.importBundle())
 assert.ok(restored?.resourceId)
 const repeated=await page.evaluate(()=>window.baoyi.video.importBundle())
 assert.equal(repeated?.resourceId,restored.resourceId);assert.equal(repeated?.created,false)
 checks.push('actual Windows recycle restoration allows native bundle reimport without duplicate registration')
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({status:'passed',checks,errors,profile},null,2));console.log('PASS followup native UI: '+checks.length+' groups')
}catch(error){await(await app.firstWindow()).screenshot({path:path.join(output,'failure.png')});throw error}finally{await app.close()}
