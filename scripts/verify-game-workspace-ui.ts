import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema,setSchemaVersion} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {insertGame,updateGame} from '../electron/kinds/game/db.ts'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {pngImage} from './helpers/test-images.ts'
import {zipWorkbook} from './helpers/game-workbook.ts'
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/game-design-v21-2026-11-08/development-ui');fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),root=path.join(profile,'fixtures');fs.mkdirSync(root);fs.mkdirSync(path.join(profile,'covers'))
const write=(name:string,content:string|Buffer='fixture')=>{const p=path.join(root,name);fs.writeFileSync(p,content);return p}
const tool=write('tool.cmd'),usage=write('usage.txt','先退出游戏，再打开工具。'),guide=write('guide.md','# 旅途手册\n\n## 行前准备\n\n'+Array.from({length:80},(_,i)=>'路线说明 '+i+'\n\n').join('')+'## 终点\n\n旅程结束。\n<script>window.__bad=true</script><img src="https://example.invalid/track"><input type="checkbox">'),sheet=write('guide.xlsx',zipWorkbook()),alt=write('alternate.cmd')
const portrait=path.join(profile,'covers','portrait.png'),wide=path.join(profile,'covers','wide.png');fs.writeFileSync(portrait,pngImage(400,600,[83,112,119]));fs.writeFileSync(wide,pngImage(800,450,[141,100,71]))
const tall=path.join(profile,'covers','tall.png'),panorama=path.join(profile,'covers','panorama.png');fs.writeFileSync(tall,pngImage(400,800,[80,120,90]));fs.writeFileSync(panorama,pngImage(1200,400,[120,80,90]))
const saveRoot=path.join(root,'saves');fs.mkdirSync(saveRoot);const saveFile=path.join(saveRoot,'slot.dat');fs.writeFileSync(saveFile,'before-backup')
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'dark',hide_hentai:false,video_updates_weekly:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const ids:string[]=[]
for(const [i,title] of ['星海旅记','雪落长街夜未央','The Wandering Journey','仅横图游戏','仅竖图游戏','失效路径'].entries()){
 const id=insertGame(db,{exe_path:write('game'+i+'.cmd'),name_zh:title,name_en:i===1?'A Quiet Winter Night':'',summary:'从营地出发，沿地图寻找下一段旅途。',description:'记录旅途中的路线、工具、存档与见闻。',category:'冒险',tags:['单机','剧情向'],official_url:'',source_dir:root,file_size:1,save_paths:i?[]:[{path:saveRoot,verified_at:0}],linked_files:i?[]:[{path:tool,type:'trainer',label:'旅途工具',features:[{key:'F1',label:'演示功能'}]},{path:usage,type:'trainer',role:'usage',label:'工具说明'},{path:guide,type:'guide',label:'旅行攻略'},{path:sheet,type:'guide',label:'路线表格'},{path:alt,type:'other',role:'launcher',label:'备用入口'}]}).id
 updateGame(db,id,{cover_path:[0,4].includes(i)?portrait:'',background_path:[0,3].includes(i)?wide:'',play_status:i===0?'playing':'unplayed',last_played_at:i===0?Date.now()-3600000:0,notes:i===0?'## 当前进度\n\n- [ ] 到达营地\n- [ ] 收集地图\n\n### 备忘\n\n保留原文。':''});ids.push(id)
}fs.unlinkSync(path.join(root,'game5.cmd'));setSchemaVersion(db,30);db.close()
const {_electron}=loadPlaywright(),app=await _electron.launch({executablePath:path.resolve(packed&&packed!=='development'?packed:'node_modules/electron/dist/electron.exe'),args:[...(packed&&packed!=='development'?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()})
app.process().stderr?.on('data',data=>process.stderr.write(data));const page=await app.firstWindow({timeout:30000}),checks:string[]=[],errors:string[]=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>void d.accept())
const route=async(hash:string)=>{await page.evaluate(hash=>location.hash=hash,hash)}
const check=async(name:string,fn:()=>Promise<void>)=>{await fn();checks.push(name);console.log('PASS '+name)}
const screenshot=async(name:string)=>page.screenshot({path:path.join(output,name+'.png')})
try{
 assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile)
 await page.waitForFunction(()=>!!window.baoyi?.game)
 await app.evaluate(({BrowserWindow,dialog,shell}:any,{portrait}:any)=>{BrowserWindow.getAllWindows()[0].setMinimumSize(800,640);BrowserWindow.getAllWindows()[0].setSize(1366,900);(globalThis as any).__opened=[];(globalThis as any).__picked=portrait;(globalThis as any).__failure='';dialog.showOpenDialog=async()=>({canceled:false,filePaths:[(globalThis as any).__picked]});dialog.showSaveDialog=async()=>({canceled:false,filePath:(globalThis as any).__picked});shell.openPath=async(p:string)=>{(globalThis as any).__opened.push(p);if((globalThis as any).__delay)await new Promise(r=>setTimeout(r,100));return (globalThis as any).__failure};shell.showItemInFolder=(p:string)=>(globalThis as any).__opened.push(p)},{portrait})
 await check('首页封面三种来源、110/160/260 缩放、横竖切换、路径修复与键盘搜索',async()=>{
  await route('/game');await page.locator('.gameCard').first().waitFor();assert.equal(await page.locator('.gameCard').count(),6)
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.cv-img')).every(i=>(i as HTMLImageElement).naturalWidth>0))
  assert.equal(await page.locator('.game-cover[data-mode=fallback]').count(),3)
  await page.keyboard.press('Control+k');assert.equal(await page.locator('.search__input').evaluate(e=>e===document.activeElement),true)
  for(const size of [110,160,260]){await page.getByRole('button',{name:'视图',exact:true}).click();await page.locator('input[type=range]').fill(String(size));await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await screenshot('home-'+size)}
  await page.getByRole('button',{name:'视图',exact:true}).click();await page.getByRole('button',{name:/横版/}).click();await page.keyboard.press('Escape');await page.locator('.game-cover--wide').first().waitFor();await screenshot('home-wide')
  const missing=page.locator('.gameCard').filter({hasText:'失效路径'});assert.equal(await missing.locator('.card__launch').count(),0);await missing.getByRole('button',{name:'修复',exact:true}).click();await page.getByRole('tab',{name:'文件与封面',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'文件与封面'}).getAttribute('aria-selected'),'true')
 })
 await check('三栏详情、分类标签、页签方向键与 1100/940 窗口布局',async()=>{
  await route('/game/'+ids[0]);await page.locator('.hero-meta').waitFor();await screenshot('overview-dark')
  const cover=await page.locator('.hero-cover').boundingBox(),meta=await page.locator('.hero-meta').boundingBox();assert.ok(cover&&meta&&Math.abs(cover.y-meta.y)<10)
  await page.getByRole('tab',{name:'简介',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'工具与修改器',exact:true}).getAttribute('aria-selected'),'true')
  for(const width of [1100,940]){await app.evaluate(({BrowserWindow}:any,w)=>BrowserWindow.getAllWindows()[0].setSize(w,900),width);await page.waitForFunction(w=>innerWidth<=w,width);const c=await page.locator('.hero-cover').boundingBox(),m=await page.locator('.hero-meta').boundingBox();assert.ok(c&&m&&m.y>c.y+c.height);assert.equal(await page.evaluate(()=>{const el=document.querySelector('.detail')!;return el.scrollWidth>el.clientWidth+1}),false);await screenshot('detail-'+width)}
  await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(1366,900))
 })
 await check('主封面存横图时保留全图；手工焦点优先于自动构图',async()=>{
  const original=await page.evaluate(id=>window.baoyi.game.get(id),ids[4])
  await page.evaluate(({id,wide})=>window.baoyi.game.update(id,{cover_path:wide,cover_focus:''}),{id:ids[4],wide})
  await route('/game');await page.locator('.gameCard').first().waitFor()
  await page.getByRole('button',{name:'视图',exact:true}).click();await page.getByRole('button',{name:/竖版/}).click();await page.keyboard.press('Escape')
  const card=page.locator('.gameCard').filter({hasText:'仅竖图游戏'})
  await card.locator('.game-cover[data-mode=composed]').waitFor()
  assert.equal(await card.locator('.cv-art img').evaluate((i:HTMLImageElement)=>i.naturalWidth/i.naturalHeight),800/450)
  await page.evaluate(id=>window.baoyi.game.update(id,{cover_focus:'20,70'}),ids[4]);await page.reload();await card.locator('.game-cover[data-mode=image]').waitFor()
  assert.match(await card.locator('.game-cover').getAttribute('style')||'',/20% 70%/)
  for(const [shape,file] of [['竖版',tall],['横版',panorama]]){
   await page.evaluate(({id,file})=>window.baoyi.game.update(id,{cover_path:file,background_path:file,cover_focus:''}),{id:ids[4],file});await page.reload();await card.waitFor()
   await page.getByRole('button',{name:'视图',exact:true}).click();await page.getByRole('button',{name:new RegExp(shape)}).click();await page.keyboard.press('Escape');await card.locator('.game-cover[data-mode=composed]').waitFor()
   assert.equal(await card.locator('.cv-art img').evaluate(i=>{const frame=i.closest('.game-cover')!.getBoundingClientRect(),art=i.getBoundingClientRect();return art.left>=frame.left&&art.top>=frame.top&&art.right<=frame.right&&art.bottom<=frame.bottom&&getComputedStyle(i).objectFit==='contain'}),true)
   assert.equal(await card.locator('.cv-cap').evaluate(i=>{const frame=i.closest('.game-cover')!.getBoundingClientRect(),cap=i.getBoundingClientRect();return cap.width>0&&cap.left>=frame.left&&cap.right<=frame.right}),true)
  }
  await page.evaluate(({id,cover})=>window.baoyi.game.update(id,{cover_path:cover,background_path:'',cover_focus:''}),{id:ids[4],cover:original!.cover_path})
  await route('/game/'+ids[0]);await page.locator('.hero-meta').waitFor()
 })
 await check('修改器功能编辑、联动启动顺序、失败与重复请求保护',async()=>{
  await page.getByRole('tab',{name:'工具与修改器',exact:true}).click();const card=page.locator('.tool-card').filter({hasText:'旅途工具'});await card.getByRole('button',{name:'管理 旅途工具',exact:true}).click();await card.getByRole('button',{name:'编辑名称与功能说明'}).click();await card.getByLabel('用法',{exact:true}).fill('打开游戏前运行');await card.getByRole('button',{name:'保存功能说明'}).click();await card.getByLabel('随游戏启动').check();await page.waitForFunction(id=>window.baoyi.game.get(id).then(g=>g?.linked_files.some(f=>f.launch_with_game)),ids[0]);await screenshot('tools')
  await app.evaluate(()=>(globalThis as any).__opened=[]);const r=await page.evaluate(id=>window.baoyi.game.launch(id),ids[0]);assert.ok(r.ok);assert.deepEqual(await app.evaluate(()=>(globalThis as any).__opened),[tool,path.join(root,'game0.cmd')]);assert.equal((await page.evaluate(id=>window.baoyi.game.get(id),ids[0]))!.use_count,1)
  await app.evaluate(()=>(globalThis as any).__failure='合成打开失败');assert.equal((await page.evaluate(id=>window.baoyi.game.launch(id),ids[0])).ok,false);await app.evaluate(()=>(globalThis as any).__failure='')
  assert.equal((await page.evaluate(id=>window.baoyi.game.launch(id,{trainers:['C:/unrelated.exe']}),ids[0])).ok,false)
  await app.evaluate(()=>(globalThis as any).__delay=true);const results=await page.evaluate(id=>Promise.all([window.baoyi.game.launch(id),window.baoyi.game.launch(id)]),ids[0]);assert.equal(results.filter(r=>r.ok).length,1);await app.evaluate(()=>(globalThis as any).__delay=false)
 })
 await check('Markdown 攻略章节跳转、进度回读、XLSX 预览、全屏和越界拒绝',async()=>{
  await page.getByRole('tab',{name:'攻略与说明'}).click();await page.locator('.doc-reader h1').waitFor();assert.equal(await page.locator('.doc-reader script,.doc-reader img,.doc-reader input').count(),0)
  await page.getByRole('button',{name:'终点',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.doc-reader')!.scrollTop>100);await page.waitForFunction(id=>window.baoyi.game.get(id).then(g=>g!.linked_files.some(f=>(f.read_progress||0)>.8)),ids[0]);await screenshot('guide')
  await page.getByRole('button',{name:/路线表格/}).click();await page.locator('.doc-reader td').first().waitFor();assert.ok((await page.locator('.doc-reader').textContent())!.includes('第一章'));await screenshot('xlsx')
  await page.getByRole('button',{name:'全屏阅读',exact:true}).click();await page.locator('.docs-panel--full').waitFor();await page.getByRole('button',{name:'退出全屏阅读'}).click()
  const message=await page.evaluate(async({id,file})=>{try{await window.baoyi.game.previewLink(id,file);return ''}catch(e){return String(e)}},{id:ids[0],file:path.join(root,'game0.cmd')});assert.match(message,/未关联/)
 })
 await check('旧笔记迁移、待办回写、目录跳转、多笔记自动保存与导出',async()=>{
  await page.getByRole('tab',{name:'笔记',exact:true}).click();await page.getByLabel('Markdown 笔记正文').waitFor();assert.equal((await page.evaluate(id=>window.baoyi.game.notes.list(id),ids[0])).length,1)
  await page.getByLabel('切换待办 1').check();await page.waitForFunction(id=>window.baoyi.game.notes.list(id).then(n=>n[0].body.includes('[x] 到达营地')),ids[0]);await page.locator('.note-heading').filter({hasText:'备忘'}).click();assert.ok((await page.getByLabel('Markdown 笔记正文').evaluate((el:HTMLTextAreaElement)=>el.value.slice(el.selectionStart,el.selectionEnd))).includes('备忘'));await screenshot('notes')
  await page.getByRole('button',{name:'新建笔记',exact:true}).click();await page.getByLabel('笔记标题',{exact:true}).fill('路线记录');await page.getByLabel('Markdown 笔记正文').fill('## 营地\n\n新的笔记');await page.locator('.note-item').first().click();await page.waitForFunction(id=>window.baoyi.game.notes.list(id).then(n=>n.some(x=>x.title==='路线记录'&&x.body.includes('新的笔记'))),ids[0]);
  const target=path.join(root,'export.md');await app.evaluate((_,p)=>(globalThis as any).__picked=p,target);await page.getByRole('button',{name:'笔记操作',exact:true}).click();await page.getByRole('button',{name:'导出 .md',exact:true}).click();await page.waitForFunction(()=>true);for(let i=0;i<30&&!fs.existsSync(target);i++)await new Promise(r=>setTimeout(r,100));assert.ok(fs.readFileSync(target,'utf8').includes('当前进度'))
  await page.reload();await page.getByLabel('Markdown 笔记正文').waitFor();assert.ok((await page.getByLabel('Markdown 笔记正文').inputValue()).includes('[x] 到达营地'))
 })
 await check('过期草稿与数据库冲突不会覆盖，保留复制与重新读取入口',async()=>{
  const notes=await page.evaluate(id=>window.baoyi.game.notes.list(id),ids[0]),note=notes[0];await page.evaluate(async({id,note})=>{await window.baoyi.game.notes.save(id,{id:note.id,title:note.title,body:'服务器新内容',expectedUpdatedAt:note.updated_at})},{id:ids[0],note});await page.getByLabel('Markdown 笔记正文').fill('本地待核对草稿');await page.locator('.note-error').waitFor();assert.equal((await page.evaluate(id=>window.baoyi.game.notes.list(id),ids[0]))[0].body,'服务器新内容');await page.reload();await page.locator('.note-error').waitFor();assert.equal(await page.getByLabel('Markdown 笔记正文').inputValue(),'本地待核对草稿');await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.locator('.app-dialog [data-dialog-confirm]').click();await page.waitForFunction(()=>!document.querySelector('.note-error'))
 })
 await check('存档验证、备份时间线、还原前保护与原文件恢复',async()=>{
  await page.getByRole('tab',{name:'存档与备份',exact:true}).click();const panel=page.locator('#game-panel-saves');await panel.getByRole('button',{name:'重新验证',exact:true}).click();await page.waitForFunction(id=>window.baoyi.game.get(id).then(g=>!!g?.save_paths[0]?.verified_at),ids[0]);await panel.getByRole('button',{name:'立即备份',exact:true}).click();await page.locator('.app-dialog [data-dialog-confirm]').click();await panel.locator('.backup').waitFor();await screenshot('saves');fs.writeFileSync(saveFile,'after-backup');await panel.getByRole('button',{name:'还原',exact:true}).first().click();await page.locator('.app-dialog [data-dialog-confirm]').click();await page.getByText(/已还原 1 个文件到/).waitFor();assert.equal((await page.evaluate(id=>window.baoyi.game.backups(id),ids[0])).length,2);assert.equal(fs.readFileSync(saveFile,'utf8'),'before-backup')
 })
 await check('还原预览支持迁移目标且拒绝未登记路径和过期预览',async()=>{
  const b=(await page.evaluate(id=>window.baoyi.game.backups(id),ids[0])).at(-1)!,moved=path.join(root,'moved-saves');fs.mkdirSync(moved);fs.writeFileSync(path.join(moved,'slot.dat'),'another-save');fs.writeFileSync(path.join(moved,'extra.dat'),'keep-in-safety')
  const message=await page.evaluate(async({backup,target})=>{try{await window.baoyi.game.previewRestore(backup,target);return ''}catch(e){return String(e)}},{backup:b.id,target:moved});assert.match(message,/已登记/)
  await page.evaluate(async({id,moved})=>{const g=await window.baoyi.game.get(id);await window.baoyi.game.update(id,{save_paths:[...g!.save_paths,{path:moved,verified_at:0}]})},{id:ids[0],moved})
  const p=await page.evaluate(({id,target})=>window.baoyi.game.previewRestore(id,target),{id:b.id,target:moved});assert.equal(p.changed.length,1);assert.equal(p.removed.length,1)
  fs.writeFileSync(path.join(moved,'slot.dat'),'changed-again')
  const stale=await page.evaluate(({id,p})=>window.baoyi.game.restoreBackup(id,p.target,p.expected),{id:b.id,p});assert.equal(stale.ok,false);assert.equal(fs.readFileSync(path.join(moved,'slot.dat'),'utf8'),'changed-again')
  await page.reload();const last=page.locator('#game-panel-saves .backup').last();await last.getByLabel('还原目标',{exact:true}).selectOption(moved);await last.getByRole('button',{name:'还原',exact:true}).click();await page.locator('.app-dialog [data-dialog-confirm]').click();await page.getByText(/已还原 1 个文件到/).waitFor();assert.equal(fs.readFileSync(path.join(moved,'slot.dat'),'utf8'),'before-backup');assert.ok(!fs.existsSync(path.join(moved,'extra.dat')));assert.equal(fs.readFileSync(saveFile,'utf8'),'before-backup')
 })
 await check('独立横图选择保留竖图、裁切焦点、默认入口持久化与仅横图 hero',async()=>{
  await page.getByRole('tab',{name:'文件与封面'}).click();await app.evaluate((_,p)=>(globalThis as any).__picked=p,wide);const before=(await page.evaluate(id=>window.baoyi.game.get(id),ids[0]))!.cover_path;await page.getByRole('button',{name:'横版图片',exact:true}).click();await page.waitForFunction(id=>window.baoyi.game.get(id).then(g=>g?.background_path.includes('-background')),ids[0]);assert.equal((await page.evaluate(id=>window.baoyi.game.get(id),ids[0]))!.cover_path,before);assert.ok(fs.existsSync(before));await page.getByLabel('横向焦点').fill('20');await page.getByLabel('纵向焦点').fill('70');await page.waitForFunction(id=>window.baoyi.game.get(id).then(g=>g?.cover_focus==='20,70'),ids[0]);await page.getByRole('button',{name:'设为默认',exact:true}).click();await page.waitForFunction(({id,alt})=>window.baoyi.game.get(id).then(g=>g?.path===alt),{id:ids[0],alt});await screenshot('files');await route('/game/'+ids[3]);await page.locator('.hero-cover--wide').waitFor();await screenshot('wide-only');await page.locator('.sidebar').getByRole('button',{name:/^全部游戏/}).click();await page.locator('.gameCard').first().waitFor();await route('/game/'+ids[3]);await page.locator('.hero-cover--wide').waitFor()
 })
 await check('浅色首页和详情、其他模块边界与零渲染错误',async()=>{
  await page.evaluate(()=>document.documentElement.dataset.theme='light')
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).mixBlendMode),'normal')
  await page.evaluate(()=>document.documentElement.dataset.theme='light');await screenshot('overview-light');await route('/game');await page.locator('.gameCard').first().waitFor();await screenshot('home-light');for(const hash of ['/','/video','/document']){await route(hash);await page.waitForFunction(()=>!!document.querySelector('main'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await screenshot((hash.slice(1)||'software')+'-light')}
  assert.deepEqual(errors,[])
 })
 fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({checks,passed:checks.length,errors,profile,executable:packed||'development',boundary:'Native Electron UI, IPC, SQLite migration and real local file reads. Synthetic fixtures; OS open/dialog dispatch stubbed. No game/trainer processes or external AI executed.'},null,2))
}catch(e){await screenshot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(e),checks,errors},null,2));throw e}finally{await app.close()}
