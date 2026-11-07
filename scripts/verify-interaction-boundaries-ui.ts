import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {ImageLibrary} from '../electron/kinds/image/library.ts'
import {scanImageImport} from '../electron/kinds/image/scanner.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {PersonalLibrary} from '../electron/workspace/personal.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {pngImage} from './helpers/test-images.ts'
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/interaction-fixes-2026-11-07/native-boundaries'+(packed?'-packaged':''));fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),media=path.join(profile,'合成漫画');fs.mkdirSync(media)
fs.writeFileSync(path.join(media,'1.png'),pngImage(720,1080));const file=path.join(profile,'合成摘录.txt');fs.writeFileSync(file,'第1章\n这是用于验证原生剪贴板的合成选文。\n第二段保留原文。')
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value]of Object.entries({onboarded:true,theme:'light',hide_hentai:false,hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const image=new ImageLibrary(db).register((await scanImageImport(media,'comic',false))[0]),doc=await new DocumentLibrary(db).register(file,'novel')
const asset=new PersonalLibrary(db).save({kind:'asset',name:'合成管理入口',body:'隔离验收',data:{url:'https://example.com/account'}})
// Legacy imported records can lack a protocol; seed that historical shape directly.
db.prepare('UPDATE personal_records SET data=? WHERE id=?').run(JSON.stringify({url:'example.com/account'}),asset.id)
const wav=Buffer.alloc(44+16000*30);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);const audioFile=path.join(profile,'浮条合成音频.wav');fs.writeFileSync(audioFile,wav)
const audio=registerVideoContent(db,{mediaKind:'audio',title:'浮条合成音频',category:'音频',items:[{title:'浮条合成曲目',order:1,files:[{path:audioFile}],durationSec:30}]});db.close()
const {_electron}=loadPlaywright(),app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()})
const page=await app.firstWindow(),checks:string[]=[],errors:string[]=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
const check=async(name:string,fn:()=>Promise<void>)=>{await fn();checks.push(name);console.log('PASS '+name)}
const route=async(value:string)=>{await page.evaluate(value=>location.hash=value,value)}
const resize=async(width:number)=>{await app.evaluate(({BrowserWindow}:any,width:number)=>{const win=BrowserWindow.getAllWindows()[0];win.unmaximize();win.setMinimumSize(640,600);win.setContentSize(width,900)},width)}
try{
  await page.waitForFunction(()=>!!window.baoyi?.image);assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile)
  await app.evaluate(({shell}:any)=>{(globalThis as any).__opened=[];shell.openExternal=async(value:string)=>{(globalThis as any).__opened.push(value)}})
  await check('个人管理入口补全HTTPS并走原生外链；主进程拒绝非HTTP协议',async()=>{
    await route('/personal?section=asset&record='+asset.id);await page.getByRole('button',{name:'管理入口',exact:true}).click();assert.deepEqual(await app.evaluate(()=>(globalThis as any).__opened),['https://example.com/account'])
    assert.equal(await page.evaluate(async()=>{try{await window.baoyi.app.openUrl('file:///C:/private');return false}catch{return true}}),true)
  })
  await check('阅读选文和标注Markdown使用Electron原生剪贴板',async()=>{
    await route('/document/'+doc.id);const paragraph=page.locator('.novel-paragraph').filter({hasText:'原生剪贴板'});await paragraph.waitFor()
    const select=async()=>{await paragraph.evaluate(e=>{const range=document.createRange();range.selectNodeContents(e);const s=getSelection()!;s.removeAllRanges();s.addRange(range);e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))})}
    await select();await page.getByRole('button',{name:'复制选文',exact:true}).click();assert.equal(await app.evaluate(({clipboard}:any)=>clipboard.readText()),'这是用于验证原生剪贴板的合成选文。')
    await select();await page.getByRole('button',{name:'高亮',exact:true}).click();await page.getByLabel('全选标注',{exact:true}).check();await page.getByRole('button',{name:'复制 Markdown',exact:true}).click();assert.match(await app.evaluate(({clipboard}:any)=>clipboard.readText()),/合成选文/)
  })
  await check('有精读摘要时仍渲染详情封面',async()=>{
    const docs=await page.evaluate(()=>window.baoyi.workspace.documents.list());docs[0].insight={coreValue:'合成精读摘要',conclusions:['结论'],userEdited:false,revision:1}
    await app.evaluate(({ipcMain}:any,docs:any)=>{ipcMain.removeHandler('workspace:documents:list');ipcMain.handle('workspace:documents:list',()=>docs)},docs)
    await route('/document');await page.getByRole('button',{name:'列表视图',exact:true}).click();await page.locator('.document-row').filter({hasText:'合成摘录'}).click();await page.locator('.document-details-fields .document-cover').waitFor();await page.screenshot({path:path.join(output,'cover-with-insight.png')})
  })
  await check('真实音频、项目药丸与最小化阅读器垂直排列；助理宽窄窗避让且播放器可控',async()=>{
    await resize(1360);await route('/video');await page.getByRole('button',{name:/^音频\s+\d/}).click();await page.getByRole('button',{name:'播放 浮条合成曲目',exact:true}).click();await page.waitForFunction(()=>!!document.querySelector<HTMLAudioElement>('.audio-mini audio')?.duration)
    await route('/image/'+image.id);await page.locator('.detail-actions .im-primary').click();await page.getByLabel('收起阅读器',{exact:true}).click()
    await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].webContents.send('project:run',{id:'synthetic',projectId:'synthetic',profileId:'fixture',profileName:'合成命令',status:'running',startedAt:Date.now()}))
    await page.locator('.project-run-chip').waitFor();await page.locator('.image-reader.minimized').waitFor()
    const stack=()=>page.waitForFunction(()=>{const reader=document.querySelector('.image-reader.minimized')!.getBoundingClientRect(),chip=document.querySelector('.project-run-chip')!.getBoundingClientRect(),audio=document.querySelector('.audio-mini')!.getBoundingClientRect();return reader.bottom<chip.top-8&&chip.bottom<audio.top-8})
    await stack();await page.keyboard.press('Control+j');await page.locator('.archive-panel').waitFor();await page.waitForFunction(()=>{const panel=document.querySelector('.archive-panel')!.getBoundingClientRect(),audio=document.querySelector('.audio-mini')!.getBoundingClientRect();return ['.project-run-chip','.image-reader.minimized'].every(s=>document.querySelector(s)!.getBoundingClientRect().right<panel.left-10)&&panel.bottom<=audio.top+1});await stack();await page.screenshot({path:path.join(output,'all-floating-wide.png')})
    await resize(720);await page.waitForFunction(()=>['.project-run-chip','.image-reader.minimized'].every(s=>getComputedStyle(document.querySelector(s)!).visibility==='hidden'));await page.getByLabel('暂停音频',{exact:true}).click();assert.equal(await page.locator('.audio-mini audio').evaluate((a:HTMLAudioElement)=>a.paused),true);await page.screenshot({path:path.join(output,'all-floating-narrow.png')})
    await page.getByLabel('收起归档助理',{exact:true}).click();await page.waitForFunction(()=>['.project-run-chip','.image-reader.minimized'].every(s=>getComputedStyle(document.querySelector(s)!).visibility==='visible'));await stack()
    await page.getByLabel('关闭阅读器',{exact:true}).click();await resize(1360)
  })
  await check('原生库移除事件关闭正在播放的曲目并撤销队列',async()=>{await page.evaluate(id=>window.baoyi.video.remove(id),audio.resourceId);await page.locator('.audio-mini').waitFor({state:'detached'})})
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:checks.length,checks,errors,profile,packed:packed||false},null,2))
}catch(e){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(e)},null,2));throw e}finally{await app.close()}
