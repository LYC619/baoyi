/** Four-library acceptance with disposable data, no external services. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {insertGame} from '../electron/kinds/game/db.ts'
import {ImageLibrary} from '../electron/kinds/image/library.ts'
import {scanImageImport} from '../electron/kinds/image/scanner.ts'
import {pngImage} from './helpers/test-images.ts'
const require=createRequire(import.meta.url),{_electron}=require(process.env.BAOYI_PLAYWRIGHT||'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output=path.resolve('output/field-improvements/ui'+(process.argv[2]?'-packaged':''));fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),db=new DatabaseSync(path.join(profile,'baoyi.db'));db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
const gamesRoot=path.join(profile,'Games')
for(const [key,value] of Object.entries({onboarded:true,theme:'dark',hanime_builtin_hosts:false,game_scan_dirs:[gamesRoot]}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const gameIds:string[]=[]
for(const [index,title] of ['山河游记','策略实验室','待整理游戏'].entries()){
 const dir=path.join(gamesRoot,index===1?'1.SLG':'2.RPG',title),file=path.join(dir,'Game.exe');fs.mkdirSync(dir,{recursive:true});if(index!==2)fs.writeFileSync(file,'synthetic executable - never launch')
 gameIds.push(insertGame(db,{exe_path:file,source_dir:dir,file_size:1,name_zh:title,name_en:'',summary:'本地验证用合成游戏',description:'详情子页面切换验证',category:index===2?'':index===1?'SLG':'RPG',tags:[],official_url:'',save_paths:[],linked_files:[]}).id)
}
db.prepare("INSERT INTO resource(id,kind,path,created_at,updated_at,file_name,source_dir,name_zh,description,notes,ai_status) VALUES('soft','software',?,1,1,'Test.exe',?,'示例软件','软件简介','使用心得的合成说明','confirmed')").run(path.join(profile,'Test.exe'),profile)
db.prepare("INSERT INTO software_meta(resource_id) VALUES('soft')").run()
db.prepare("INSERT INTO resource(id,kind,path,created_at,updated_at,file_name,name_zh,category,ai_status) VALUES('video','video',?,1,1,'movie.mp4','秋日记录','纪录片','confirmed')").run(path.join(profile,'movie.mp4'))
db.prepare("INSERT INTO video_meta(resource_id) VALUES('video')").run()
db.prepare("INSERT INTO episode(id,resource_id,episode,published_at) VALUES('episode','video',1,?)").run(Date.parse('2026-09-20T00:00:00Z'))
const library=new ImageLibrary(db),imageIds:string[]=[]
for(const [index,title] of ['星际旅途 上','星际旅途 下','林间日记'].entries()){
 const dir=path.join(profile,'Comics',title);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'1.png'),pngImage(400,600,[70+index*50,100,155]));const item=library.register((await scanImageImport(dir,'comic',false))[0]);imageIds.push(item.id);if(index<2)library.update(item.id,{groupId:'image-group-1'})
}
db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const app=await _electron.launch({executablePath:path.resolve(process.argv[2]||'node_modules/electron/dist/electron.exe'),args:[...(process.argv[2]?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env})
const checks:string[]=[],errors:string[]=[]
try{
 const page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',(e:Error)=>errors.push(e.message));await page.waitForFunction(()=>!!window.baoyi?.image)
 await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(1440,900))
 const go=async(route:string)=>{await page.evaluate((r:string)=>{location.hash=r},route)}
 for(const [kind,route,tabs] of [['software','/detail/soft',['简介','使用心得','文件与启动']],['game','/game/'+gameIds[0],['简介','存档与备份','文件与封面','笔记']]] as const){
  await go(route);for(const name of tabs){await page.getByRole('tab',{name,exact:true}).click();assert.equal(await page.getByRole('tabpanel').count(),1);assert.equal(await page.getByRole('tab',{name,exact:true}).getAttribute('aria-selected'),'true')}
  await page.getByRole('tab',{name:'简介',exact:true}).click();await page.screenshot({path:path.join(output,kind+'-detail.png')});checks.push(kind+'-detail-tabs')
 }
 await go('/game');await page.getByLabel('游戏分组',{exact:true}).selectOption('directory');await page.getByRole('heading',{name:/1.SLG/}).waitFor();await page.getByRole('heading',{name:/2.RPG/}).waitFor()
 await page.getByLabel('游戏卡片大小',{exact:true}).fill('220');await page.screenshot({path:path.join(output,'game-groups.png')})
 await page.getByRole('button',{name:/^未分类/}).click();assert.equal(await page.locator('.wall .card').count(),1)
 await go('/game/'+gameIds[2]);await page.getByRole('alert').filter({hasText:'主程序已找不到'}).waitFor();await page.getByRole('button',{name:'重新定位文件夹',exact:true}).waitFor()
 const relocated=path.join(gamesRoot,'2.RPG','重命名后的游戏');fs.mkdirSync(relocated);fs.writeFileSync(path.join(relocated,'Game.exe'),'synthetic')
 await app.evaluate(({dialog}:any,dir:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]})},relocated)
 await page.getByRole('button',{name:'重新定位文件夹',exact:true}).click();await page.waitForFunction(async(id:string)=>(await window.baoyi.game.get(id))?.path_state==='present',gameIds[2]);await page.getByRole('alert').filter({hasText:'主程序已找不到'}).waitFor({state:'hidden'})
 checks.push('game-directory-groups-card-size-uncategorized-missing-path-relocation')
 await go('/video');await page.getByLabel('作品排序',{exact:true}).selectOption('published');await page.locator('.card').filter({hasText:'秋日记录'}).filter({hasText:'2026'}).waitFor();await page.screenshot({path:path.join(output,'video-published.png')});checks.push('video-publication-date')
 await go('/image');await page.getByLabel('漫画分组',{exact:true}).selectOption('category');await page.getByLabel('漫画卡片大小',{exact:true}).fill('180');await page.getByRole('button',{name:'批量整理',exact:true}).click()
 await page.getByLabel('选择 星际旅途 上',{exact:true}).check();await page.getByLabel('选择 星际旅途 下',{exact:true}).check();await page.getByLabel('新合集名称',{exact:true}).fill('星际旅途 合集');await page.getByRole('button',{name:'合并为合集',exact:true}).click()
 await page.getByRole('status').filter({hasText:'已保存合集'}).waitFor();await page.getByRole('button',{name:'批量整理',exact:true}).click()
 await page.locator('.image-card__open').filter({hasText:'星际旅途 合集'}).click();await page.getByRole('dialog',{name:'漫画合集',exact:true}).waitFor();assert.equal(await page.locator('.collection-members article').count(),2)
 await page.getByLabel('下移 星际旅途 上',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('.collection-members article strong')?.textContent==='星际旅途 下')
 await page.screenshot({path:path.join(output,'comic-collection.png')});await page.getByLabel('关闭合集',{exact:true}).click();await page.locator('.image-content').evaluate((el:HTMLElement)=>{el.scrollTop=0});await page.screenshot({path:path.join(output,'comic-shelf.png')})
 await page.getByRole('button',{name:'● 未分类',exact:true}).click();assert.equal(await page.locator('.image-card').count(),1)
 checks.push('comic-classification-size-collection-create-reorder-uncategorized')
 await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(960,640));await page.screenshot({path:path.join(output,'comic-shelf-960.png')})
 assert.equal(await page.locator('.image-content').evaluate((el:HTMLElement)=>el.scrollWidth>el.clientWidth+1),false)
 await go('/image/'+imageIds[2]);await page.getByRole('button',{name:'开始阅读',exact:true}).click();await page.getByLabel('关闭阅读器',{exact:true}).waitFor()
 await page.evaluate((id:string)=>window.baoyi.image.remove(id),imageIds[2]);await page.locator('.image-reader').waitFor({state:'hidden'});checks.push('reader-closes-when-resource-removed')
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,errors,profile},null,2));console.log('PASS '+checks.join(', '))
}catch(cause){await(await app.firstWindow()).screenshot({path:path.join(output,'failure.png')});throw cause}finally{await app.close()}
