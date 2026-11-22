import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { loadPlaywright,electronTestEnv } from './helpers/playwright.ts'
import { createCanvas } from '@napi-rs/canvas'

const packed=process.argv[2]==='development'?undefined:process.argv[2],output=path.resolve(process.argv[3]||'output/game-catalog-2026-11-09/development-ui')
fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),root=path.join(profile,'fixtures'),project=path.join(root,'星海旅记')
const write=(file:string,content='fixture')=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);return file}
const launcher=write(path.join(project,'启动游戏.cmd'),'@echo off\r\nexit /b 0'),tool=write(path.join(project,'修改器','打开工具.cmd'),'@echo off\r\nexit /b 0'),guide=write(path.join(project,'攻略.md'),'# 星海旅记 · 旅途手册\n\n从营地出发，沿地图寻找下一个补给点。\n\n## 行前准备\n\n| 物品 | 用途 |\n|---|---|\n| 地图 | 确认路线 |\n| 药品 | 途中补给 |\n\n<script>window.__bad=true</script><img src="https://example.invalid/track"><a href="javascript:alert(1)">危险链接</a>'),usage=write(path.join(project,'修改器','使用说明.txt'),'使用前关闭游戏。\n先备份存档，再选择需要调整的槽位。'),report=write(path.join(root,'.user','reports','验收.md'),'# 限定验收\n\n隔离存档读写通过。'),extra=write(path.join(project,'地图.txt'),'地图说明'),source=path.join(root,'.user','library.json')
write(source,JSON.stringify({root,entries:[{id:'demo',name:'星海旅记',assetRoot:project,kind:'game',platform:'Windows',availability:'present',category:'冒险',engine:'合成示例',launchers:[{path:launcher}],refinement:{status:'runtime_verified',guide:'路线与补给说明已核对',runtime:'隔离读写通过',report,remaining:['完整体验待验收']},trainer:{title:'星海旅记存档助手',launchers:[{path:tool}],usage,validationSummary:'支持备份与恢复；使用隔离数据验证'},guides:{docFiles:[{path:guide,name:'旅行攻略'},{path:report,name:'验收记录'}]},save:{locationHint:'游戏目录的 saves 文件夹'}},{id:'unfinished',name:'尚未精修的游戏',kind:'game',platform:'Windows',availability:'present',refinement:{status:'in_progress'}}]}))
const artworkCanvas=createCanvas(600,900),artworkPaint=artworkCanvas.getContext('2d');artworkPaint.fillStyle='#64878c';artworkPaint.fillRect(0,0,600,900)
const artworkFile=path.join(root,'demo.png');fs.writeFileSync(artworkFile,artworkCanvas.toBuffer('image/png'))
const catalog=JSON.parse(fs.readFileSync(source,'utf8'));catalog.entries[0].artwork={portrait:{path:artworkFile,kind:'local',source:artworkFile,form:'original',layout:'合成验收图'},wide:{path:artworkFile,kind:'local',source:artworkFile,form:'adapted',layout:'合成验收图'}};write(source,JSON.stringify(catalog))
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hide_hentai:false,video_updates_weekly:false,game_scan_dirs:[root]}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
db.close()
const {_electron}=loadPlaywright(),app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()})
const page=await app.firstWindow(),checks:string[]=[],errors:string[]=[];page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
const check=async(name:string,fn:()=>Promise<void>)=>{await fn();checks.push(name);console.log('PASS '+name)}
const route=async(hash:string)=>page.evaluate(hash=>location.hash=hash,hash)
let id=''
try{
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile)
  await page.waitForFunction(()=>!!window.baoyi?.game);await page.bringToFront()
  await app.evaluate(({dialog,shell}:any,{source}:any)=>{
    (globalThis as any).__picked=source;(globalThis as any).__opened=[];(globalThis as any).__openFailure=''
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[(globalThis as any).__picked]})
    shell.openPath=async(file:string)=>{(globalThis as any).__opened.push(file);return (globalThis as any).__openFailure}
    shell.showItemInFolder=(file:string)=>{(globalThis as any).__opened.push(file)}
  },{source})
  await route('/game')
  await check('清单预览排除未精修项，界面提交通过实际 IPC 入库',async()=>{
    await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'从项目清单登记',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'登记精修游戏项目'});await dialog.waitFor();assert.equal(await dialog.locator('.candidate').count(),1)
    await dialog.locator('.artwork-diff>summary').click();await dialog.getByLabel('星海旅记 竖图',{exact:true}).uncheck()
    assert.equal(await dialog.locator('.pictures img').count(),2)
    assert.ok(await dialog.locator('.pictures img').evaluateAll(images=>images.every(i=>(i as HTMLImageElement).complete&&(i as HTMLImageElement).naturalWidth>0)))
    await page.screenshot({path:path.join(output,'project-import.png')});await dialog.getByRole('button',{name:'登记所选 1 款'}).click();await dialog.waitFor({state:'detached'})
    const rows=await page.evaluate(()=>window.baoyi.game.list());assert.equal(rows.length,1);id=rows[0].id;assert.equal(rows[0].source_dir,project);assert.equal(rows[0].cover_path,'');assert.ok(rows[0].background_path);await page.locator('.gameCard').waitFor()
  })
  await check('横竖图独立选择，重复登记无变化，菜单撤销恢复图片并保留笔记',async()=>{
    await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'从项目清单登记',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'登记精修游戏项目'});await dialog.waitFor();await dialog.locator('.artwork-diff>summary').click()
    assert.equal(await dialog.getByLabel('星海旅记 横图',{exact:true}).isDisabled(),true)
    await dialog.getByRole('button',{name:'登记所选 1 款'}).click();await dialog.waitFor({state:'detached'})
    const game=await page.evaluate(id=>window.baoyi.game.get(id),id);assert.ok(game?.cover_path)
    const p=await page.evaluate(()=>window.baoyi.game.previewProjects());assert.ok(p!.candidates[0].artwork!.every(i=>i.state==='current'))
    assert.equal((await page.evaluate(token=>window.baoyi.game.importProjects(token,['demo']),p!.token)).unchanged,1)
    const receiptDir=path.join(profile,'project-artwork-recovery'),receipt=fs.readdirSync(receiptDir).sort().at(-1)!
    await page.evaluate(id=>window.baoyi.game.update(id,{notes:'登记后手写笔记'}),id)
    await app.evaluate(({dialog}:any,receipt:string)=>{(globalThis as any).__picked=receipt;dialog.showMessageBox=async()=>({response:1})},path.join(receiptDir,receipt,'artwork.json'))
    await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'撤销项目图片更新',exact:true}).click()
    await page.waitForFunction(id=>window.baoyi.game.get(id).then(g=>g?.cover_path===''),id)
    assert.equal((await page.evaluate(id=>window.baoyi.game.get(id),id))!.notes,'登记后手写笔记')
    await app.evaluate((_,source)=>(globalThis as any).__picked=source,source)
  })
  await check('修改器入口与使用说明独立显示；脚本打开失败如实返回且不计时',async()=>{
    await route('/game/'+id+'?tab=trainer');const panel=page.locator('#game-panel-trainer');await panel.getByRole('heading',{name:/星海旅记存档助手/}).waitFor()
    assert.equal(await panel.locator('.tool-card').count(),2);await panel.locator('.tool-card').first().getByRole('button',{name:'打开',exact:true}).click()
    assert.ok((await app.evaluate(()=>(globalThis as any).__opened)).includes(tool))
    await panel.getByRole('button',{name:'阅读',exact:true}).click();await panel.getByText('使用前关闭游戏。',{exact:false}).waitFor();await page.screenshot({path:path.join(output,'trainer.png')})
    await app.evaluate(()=>(globalThis as any).__openFailure='合成系统关联失败')
    const result=await page.evaluate(id=>window.baoyi.game.launch(id),id);assert.equal(result.ok,false);assert.match(result.message,/系统关联失败/);assert.equal(await page.evaluate(id=>window.baoyi.game.running(id),id),false)
    await app.evaluate(()=>(globalThis as any).__openFailure='');const success=await page.evaluate(id=>window.baoyi.game.launch(id),id);assert.equal(success.ok,true);assert.match(success.message,/不记录游玩时长/)
  })

  await check('用途编辑与其他字段共同保存，不产生冲突',async()=>{
    await route('/game/'+id+'?tab=trainer');const card=page.locator('.tool-card').filter({hasText:'星海旅记存档助手'});
    await card.getByRole('button',{name:/管理 星海旅记存档助手/}).click();await card.getByRole('button',{name:'编辑名称与功能说明'}).click();
    await card.getByLabel('工具用途',{exact:true}).selectOption('backup');await card.getByLabel('用法',{exact:true}).fill('本次编辑用途和说明');await card.getByRole('button',{name:'保存功能说明'}).click();
    await page.waitForFunction(id=>window.baoyi.game.get(id).then(g=>g?.linked_files.some(l=>l.purpose==='backup'&&l.usage==='本次编辑用途和说明')),id)
  })
  await check('攻略搜索、真实文本读取、危险 HTML 清理与页签刷新恢复',async()=>{
    await page.getByRole('tab',{name:'攻略与说明',exact:true}).click();const panel=page.locator('#game-panel-guide')
    await panel.getByLabel('搜索攻略与说明').fill('旅行');assert.equal(await panel.locator('.doc-item').count(),1);await panel.locator('.doc-item').click();await panel.locator('.doc-reader h1').waitFor()
    assert.equal(await panel.locator('.doc-reader script,.doc-reader img,.doc-reader [href]').count(),0);assert.equal(await page.evaluate(()=>(window as any).__bad),undefined)
    const width=await panel.boundingBox();assert.ok(width&&width.width>850,'reader tab must fill the detail width');
    await page.screenshot({path:path.join(output,'guide.png')});
    await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(940,760));await page.waitForFunction(()=>innerWidth<1000);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(output,'guide-narrow.png')});await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(1280,760));
    await page.reload();await page.getByRole('tab',{name:'攻略与说明',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'攻略与说明',exact:true}).getAttribute('aria-selected'),'true')
  })
  await check('资料添加使用当前类型；解除关联保留原文件',async()=>{
    await app.evaluate((_,extra)=>(globalThis as any).__picked=extra,extra);await page.locator('#game-panel-guide').getByRole('button',{name:'关联资料'}).click();await page.locator('#game-panel-guide .doc-item').filter({hasText:'地图.txt'}).waitFor()
    assert.equal((await page.evaluate(id=>window.baoyi.game.get(id),id))!.linked_files.find(link=>link.path===extra)?.type,'guide')
    const card=page.locator('#game-panel-guide .doc-item').filter({hasText:'地图.txt'});await card.click();await page.getByRole('button',{name:'管理资料',exact:true}).click();await page.getByRole('button',{name:'解除关联，保留文件',exact:true}).click();await card.waitFor({state:'detached'});assert.ok(fs.existsSync(extra))
  })
  await check('缺失文档显示状态，无法打开；越界读取被主进程拒绝',async()=>{
    fs.unlinkSync(usage);await page.getByRole('tab',{name:'工具与修改器',exact:true}).click();await page.getByText('文件缺失或所在磁盘未连接',{exact:false}).waitFor()
    const card=page.locator('#game-panel-trainer .tool-card').filter({hasText:'工具使用说明'});assert.equal(await card.getByRole('button',{name:'打开',exact:true}).isDisabled(),true)
    const message=await page.evaluate(async({id,source})=>{try{await window.baoyi.game.readLink(id,source);return ''}catch(error){return String(error)}},{id,source});assert.match(message,/未关联/)
    write(usage,'使用前关闭游戏。')
  })
  await check('实际清单 69 款独立登记、精修记录直读、安卓启动阻断与重复登记',async()=>{
    await app.evaluate(()=>(globalThis as any).__picked='E:/Games/.user/library.json')
    const p=await page.evaluate(()=>window.baoyi.game.previewProjects());assert.ok(p);const keys=p.candidates.map(c=>c.key);assert.equal(keys.length,69);assert.ok(keys.every(key=>p.candidates.some(c=>c.key===key&&!c.problem)))
    const artwork=Object.fromEntries(p.candidates.map(c=>[c.key,(c.artwork||[]).filter(a=>!['protected','unavailable','current'].includes(a.state)).map(a=>a.role)]))
    const result=await page.evaluate(({token,keys,artwork})=>window.baoyi.game.importProjects(token,keys,artwork),{token:p.token,keys,artwork});assert.equal(result.created,69)
    const p2=await page.evaluate(()=>window.baoyi.game.previewProjects());const second=await page.evaluate(({token,keys})=>window.baoyi.game.importProjects(token,keys),{token:p2!.token,keys});assert.equal(second.unchanged,69)
    await page.reload();assert.equal((await page.evaluate(()=>window.baoyi.game.list())).length,70)
    const real=await page.evaluate(id=>window.baoyi.game.get(id),result.items[0].id);assert.ok(real);const doc=real.linked_files.find(link=>link.type==='guide'&&link.path.endsWith('.md'))!;assert.ok((await page.evaluate(({id,file})=>window.baoyi.game.readLink(id,file),{id:real.id,file:doc.path})).text.length>100)
    const android=result.items.find(x=>x.key==='mobile_mesubuta')!
    await route('/game/'+android.id);await page.getByRole('region',{name:'精修工作记录'}).waitFor()
    await page.getByRole('button',{name:'阅读完整精修记录',exact:true}).click();await page.locator('.doc-reader h1').waitFor()
    assert.ok((await page.locator('.doc-reader').innerText()).includes('ZIP'))
    await page.getByRole('tab',{name:'简介',exact:true}).click()
    assert.equal(await page.locator('.split-launch').getByRole('button',{name:'安卓资料',exact:true}).isDisabled(),true)
    await app.evaluate(()=>(globalThis as any).__opened=[])
    const denied=await page.evaluate(id=>window.baoyi.game.launch(id),android.id);assert.equal(denied.ok,false);assert.match(denied.message,/安装包/)
    assert.equal(await page.evaluate(id=>window.baoyi.game.running(id),android.id),false)
    assert.deepEqual(await app.evaluate(()=>(globalThis as any).__opened),[])
    await page.screenshot({path:path.join(output,'android-record.png')})
    await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(940,760))
    await page.waitForFunction(()=>innerWidth<1000);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    const rows=await page.evaluate(()=>window.baoyi.game.list());assert.equal(rows.filter(g=>/\.apk$/i.test(g.path)).length,20)

    await page.getByRole('region',{name:'精修状态与问题'}).waitFor()
    assert.equal(await page.locator('.verification-details').getAttribute('open'),null)
    assert.equal(await page.locator('.project-record__details').getAttribute('open'),null)
    const positions=await page.evaluate(()=>({quick:document.querySelector('.quick-cards')!.getBoundingClientRect().top,record:document.querySelector('.project-detail')!.getBoundingClientRect().top}));assert.ok(positions.quick<positions.record)
    await page.locator('.verification-details>summary').click()
    const androidGame=await page.evaluate(id=>window.baoyi.game.get(id),android.id)
    const facets=androidGame!.linked_files.find(link=>link.role==='report'&&link.project)!.project!.facets
    assert.deepEqual(await page.locator('.facets article strong').allTextContents(),facets.map(f=>f.label))
    assert.deepEqual(await page.locator('.facets article span').allTextContents(),facets.map(f=>f.state))
    const guidePath=androidGame!.linked_files.find(link=>link.role==='report'&&link.project)!.project!.guidePath
    const guideTitle=fs.readFileSync(guidePath,'utf8').split(/\r?\n/).find(line=>line.startsWith('# '))!.slice(2).trim()
    await page.getByRole('button',{name:'使用与攻略导航',exact:true}).click()
    await page.locator('.doc-reader').getByRole('heading',{level:1,name:guideTitle,exact:true}).waitFor()
    assert.ok((await page.locator('.doc-group h4').allTextContents()).some(x=>x.includes('从这里开始')))
    await page.getByLabel('搜索攻略与说明').fill('不存在的资料关键词');await page.getByText('没有匹配的资料，试试其他关键词。',{exact:true}).waitFor();await page.getByLabel('搜索攻略与说明').fill('')
    await page.getByRole('tab',{name:'简介',exact:true}).click();await page.locator('.siblings button').first().click();await page.waitForFunction(id=>!location.hash.includes(id),android.id)
    await route('/game');await page.locator('.sidebar').getByRole('button',{name:/检查资料更新/}).click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(b=>b.textContent?.includes('检查中')))
    const checks=await page.evaluate(()=>window.baoyi.game.checkProjects())
    const unavailable=p2!.candidates.filter(c=>c.artwork?.some(a=>a.state==='unavailable')).map(c=>c.existingId).sort()
    assert.deepEqual(checks.filter(c=>c.id!==id&&c.state!=='current').map(c=>c.id).sort(),unavailable)
    await page.locator('.sidebar').getByRole('button',{name:/有待处理问题/}).click();await page.locator('.gameCard').first().waitFor();const count=await page.locator('.gameCard').count();assert.ok(count>0&&count<69)
    const categories=await page.evaluate(()=>window.baoyi.categories.list('game'))
    assert.equal(new Set(categories.map(category=>category.name)).size,categories.length,'批量登记不能重复创建分类')
    await page.evaluate(game=>window.baoyi.game.update(game.id,{category:game.category}),{id:android.id,category:androidGame!.category})
    assert.deepEqual(await page.evaluate(()=>window.baoyi.categories.list('game')),categories)
    fs.writeFileSync(path.join(output,'actual-catalog-import.json'),JSON.stringify(result,null,2))
  })
  await check('设置拒绝游戏分类重名并恢复输入框中的原名',async()=>{
    const original=await page.evaluate(()=>window.baoyi.categories.list('game'))
    assert.ok(original.length>=2)
    await route('/settings?scope=module&module=game&tab=categories')
    const field=page.getByPlaceholder('分类名',{exact:true}).first();await field.waitFor()
    const previous=await field.inputValue(),other=original.find(c=>c.name!==previous)!
    await field.fill(other.name);await field.press('Enter')
    await page.getByText(/已经有同名分类了/).first().waitFor()
    await page.waitForFunction(name=>document.querySelector<HTMLInputElement>('input[placeholder="分类名"]')?.value===name,previous)
    assert.deepEqual(await page.evaluate(()=>window.baoyi.categories.list('game')),original)
  })
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:checks.length,checks,errors,profile,executable:packed||'development',boundary:'Actual Electron UI, IPC, SQLite and local reads; file picker and OS shell dispatch stubbed. Game/trainer processes not executed. Actual catalog imported only into isolated profile.'},null,2))
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors},null,2));throw error}
finally{await app.close()}

// Optional local-data presentation check. The caller must prepare an isolated DB copy.
if(process.env.BAOYI_PRESENTATION_PROFILE){
  const snapshot=path.resolve(process.env.BAOYI_PRESENTATION_PROFILE)
  assert.ok(snapshot.includes('副本演练')||snapshot.startsWith(path.resolve('output')+path.sep),'Only an isolated profile is allowed')
  const realApp=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+snapshot,'--disable-gpu'],env:electronTestEnv()})
  const realPage=await realApp.firstWindow({timeout:30000}),realErrors:string[]=[],imagesFailed:string[]=[]
  realPage.setDefaultTimeout(20000);realPage.on('pageerror',e=>realErrors.push(e.message))
  const shots=path.join(output,'presentation');fs.mkdirSync(shots,{recursive:true})
  try{
    assert.equal(path.resolve(await realApp.evaluate(({app})=>app.getPath('userData'))),snapshot)
    await realApp.evaluate(({BrowserWindow,shell}:any)=>{BrowserWindow.getAllWindows()[0].setMinimumSize(800,640);BrowserWindow.getAllWindows()[0].setSize(1366,900);shell.openPath=async()=>{throw Error('OS launch prohibited during presentation check')};shell.openExternal=async()=>{throw Error('External navigation prohibited')};shell.showItemInFolder=()=>{throw Error('OS reveal prohibited')}})
    await realPage.waitForFunction(()=>!!window.baoyi?.game)
    const all=await realPage.evaluate(()=>window.baoyi.game.list()),games=all.filter(g=>g.linked_files.some(f=>f.project))
    assert.equal(games.length,69)
    for(const g of games){
      for(const cover of [g.cover_path,g.background_path]){
        assert.ok(cover)
        const loaded=await realPage.evaluate(url=>new Promise<boolean>(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth>0);image.onerror=()=>resolve(false);image.src=url}),`baoyi://cover/${encodeURIComponent(path.basename(cover))}`)
        if(!loaded)imagesFailed.push(g.name_zh+':'+cover)
      }
    }
    assert.deepEqual(imagesFailed,[])
    await realPage.evaluate(()=>location.hash='/game');await realPage.locator('.gameCard').first().waitFor()
    await realPage.screenshot({path:path.join(shots,'library-dark.png'),animations:'disabled'})
    const selected=['game_1','game_1026_1','game_14','mobile_mesubuta'].map(key=>games.find(g=>g.linked_files.some(f=>f.project?.key===key))!)
    for(const [i,g] of selected.entries()){
      assert.ok(g)
      await realPage.evaluate(id=>location.hash='/game/'+id,g.id)
      await realPage.waitForFunction(title=>(document.querySelector('.hero__name') as HTMLInputElement)?.value===title,g.name_zh)
      await realPage.waitForFunction(()=>!document.querySelector('.page-enter-active,.page-leave-active'))
      await realPage.locator('.project-detail').waitFor()
      await realPage.locator('.hero-cover .cv-img').waitFor()
      assert.equal(await realPage.locator('.verification-details').getAttribute('open'),null)
      assert.equal(await realPage.evaluate(()=>document.querySelector('.detail')!.scrollWidth>document.querySelector('.detail')!.clientWidth+1),false)
      await realPage.screenshot({path:path.join(shots,`detail-${i}-dark.png`),animations:'disabled'})
    }
    await realApp.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(940,800))
    await realPage.evaluate(()=>document.documentElement.dataset.theme='light')
    await realPage.waitForFunction(()=>innerWidth<1000)
    assert.equal(await realPage.evaluate(()=>getComputedStyle(document.documentElement).mixBlendMode),'normal')
    await realPage.screenshot({path:path.join(shots,'detail-narrow-light.png'),animations:'disabled'})
    await realPage.getByRole('tab',{name:'攻略与说明',exact:true}).click();await realPage.locator('.doc-reader h1').waitFor()
    const project=selected[3].linked_files.find(f=>f.project)!.project!
    assert.equal(await realPage.locator('.doc-item.selected strong').innerText(),selected[3].linked_files.find(f=>f.path===project.guidePath)!.label)
    assert.equal(await realPage.evaluate(()=>document.querySelector('.docs-panel')!.scrollWidth>document.querySelector('.docs-panel')!.clientWidth+1),false)
    await realPage.locator('.docs-panel').scrollIntoViewIfNeeded()
    await realPage.screenshot({path:path.join(shots,'guide-narrow-light.png'),animations:'disabled'})
    await realPage.getByRole('tab',{name:'工具与修改器',exact:true}).click();await realPage.locator('.tools-panel').scrollIntoViewIfNeeded();await realPage.screenshot({path:path.join(shots,'tools-narrow-light.png'),animations:'disabled'})
    const updates=await realPage.evaluate(()=>window.baoyi.game.checkProjects());assert.equal(updates.filter(x=>x.state!=='current').length,0)
    assert.deepEqual(realErrors,[])
    fs.writeFileSync(path.join(shots,'verification.json'),JSON.stringify({games:games.length,loadedImages:games.length*2,selected:selected.map(g=>g.name_zh),errors:realErrors,imagesFailed,profile:snapshot,boundary:'Daily data COPY only; no games, tools, external pages or Android devices launched.'},null,2))
    console.log('PASS 真实库副本：69 项双向封面加载、四作详情、窄窗攻略与工具、资料状态')
  }finally{await realApp.close()}
}
