import assert from 'node:assert/strict'
import { imageOwnershipUI, videoQueryUI, projectImportUI, refreshPendingUI } from './helpers/review-remediation-ui.ts'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { insertGame } from '../electron/kinds/game/db.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { inspectProject } from '../electron/kinds/project/scanner.ts'

const require = createRequire(import.meta.url)
const candidates = [process.env.BAOYI_PLAYWRIGHT, 'playwright', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean) as string[]
let playwright: any
for (const candidate of candidates) { try { playwright = require(candidate); break } catch {} }
if (!playwright) throw new Error('Install Playwright or set BAOYI_PLAYWRIGHT to its module path')
const { _electron } = playwright
const stage = process.env.BAOYI_REVIEW_STAGE || 'E7'
const output=path.resolve(process.env.BAOYI_REVIEW_OUTPUT || 'output/review-remediation-20261009');fs.mkdirSync(output,{recursive:true})
const packagedExecutable = process.argv[2] ? path.resolve(process.argv[2]) : null
const expectedVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const profile=fs.mkdtempSync(path.join(output,'profile-')),root=fs.mkdtempSync(path.join(output,'fixtures-'))
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
for(const [key,value] of Object.entries({onboarded:true,theme:'dark',hanime_builtin_hosts:false,hide_hentai:true,view_mode:'grid',group_by_category:false,ai:{enabled:false}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
for(let i=1;i<=24;i++){
  const name=String(i).padStart(2,'0'),dir=path.join(root,'资源'+name);fs.mkdirSync(dir)
  const exe=path.join(dir,'tool.exe');fs.writeFileSync(exe,'synthetic fixture - never execute')
  db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,source_dir,name_zh,summary,category,tags,ai_status) VALUES(?,'software',1,1,?,?,?,?,?,'其他','[\"办公\",\"本地工具\"]','done')").run('layout-software-'+i,exe,'tool.exe',dir,'日常工具 '+name,'用于文档整理、检索和日常工作的本地工具。')
  db.prepare('INSERT INTO software_meta(resource_id,is_portable,move_risk) VALUES(?,1,?)').run('layout-software-'+i,'safe')
  const game=path.join(dir,'game.exe');fs.writeFileSync(game,'synthetic fixture - never execute')
  insertGame(db,{exe_path:game,source_dir:dir,file_size:7,name_zh:'游戏 '+name,name_en:'',summary:'本地游戏资料，用于界面密度审查。',description:'',category:'其他',tags:[],official_url:'',save_paths:[],linked_files:[]})
  const video=path.join(dir,'movie.mp4');fs.writeFileSync(video,'synthetic fixture - do not play')
  db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,source_dir,name_zh,category,tags,ai_status) VALUES(?,'video',1,1,?,?,?,?,'电影','[]','done')").run('layout-video-'+i,video,'movie.mp4',dir,'电影 '+name)
  db.prepare('INSERT INTO video_meta(resource_id,video_type) VALUES(?,?)').run('layout-video-'+i,'movie')
  if(i<=12){
    const project=path.join(dir,'项目');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'README.md'),'# 资料项目 '+name+'\n用于检索资料、管理文稿与项目入口的测试项目。')
    new ProjectLibrary(db).register(await inspectProject(project))
    const album=path.join(dir,'相册');fs.mkdirSync(album);fs.writeFileSync(path.join(album,'1.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7wAAAABJRU5ErkJggg==','base64'))
    new ImageLibrary(db).register((await scanImageImport(album,'photo',false))[0])
  }
}
db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const bootstrap=path.join(profile,'launch.cjs')
fs.writeFileSync(bootstrap,'const { BrowserWindow } = require("electron"); BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive; require('+JSON.stringify(path.resolve('dist-electron/main.js'))+');')
const app=await _electron.launch({executablePath:packagedExecutable || path.resolve('node_modules/electron/dist/electron.exe'),args:[...(packagedExecutable ? [] : [bootstrap]),'--user-data-dir='+profile,'--disable-gpu'],env,timeout:30000})
const page=await app.firstWindow().catch(async (error:unknown)=>{await app.close();throw error});page.setDefaultTimeout(9000)
const errors:string[]=[],results:any[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message))
const go=async(route:string)=>{await page.evaluate((r:string)=>{location.hash=r},route);await page.waitForURL((u:URL)=>u.hash==='#'+route);await page.waitForFunction(()=>!document.querySelector('.page-leave-active,.page-enter-active'))}
const configs:any={software:{route:'/',main:'.home__main',content:'.home__content',card:'.card'},game:{route:'/game',main:'.home__main',content:'.home__content',card:'.card'},video:{route:'/video',main:'.home__main',content:'.home__content',card:'.card'},image:{route:'/image',main:'.image-content',content:'.image-content',card:'.image-card'},project:{route:'/project',main:'.pj-content',content:'.pj-content',card:'.pj-card'}}
async function measure(name:string,kind:string){
  const value=await page.evaluate((config:any)=>{
    const bounds=(el:Element|null)=>{if(!el)return null;const r=el.getBoundingClientRect();return {top:r.top,left:r.left,width:r.width,height:r.height,bottom:r.bottom,right:r.right}}
    const main=document.querySelector(config.main)!,content=document.querySelector(config.content)!,cards=[...document.querySelectorAll(config.card)]
    const b=content.getBoundingClientRect(),clipTop=Math.max(38,b.top),clipBottom=Math.min(innerHeight,b.bottom)
    const parts:any={};for(const selector of ['.toolbar','.subbar','.management-entry','.library-bulk','.library-summary','.bulk-panel','.image-toolbar','.image-section-title','.shelf-controls','.image-bulk-panel','.pj-page-header','.pj-toolbar','.pj-result-count']){const el=main.querySelector(selector);if(el)parts[selector]=bounds(el)}
    const cardBounds=cards.map(el=>el.getBoundingClientRect())
    const controls=[...main.querySelectorAll('button,input,select')].filter(el=>!!el.getClientRects().length&&el.getBoundingClientRect().top<innerHeight&&el.getBoundingClientRect().bottom>38)
    const outside=controls.filter(el=>{const r=el.getBoundingClientRect();return r.right>innerWidth+1||r.left<0}).map(el=>({label:el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent?.trim(),...bounds(el)}))
    return {viewport:[innerWidth,innerHeight],main:bounds(main),content:bounds(content),firstCard:bounds(cards[0]),fullCards:cardBounds.filter(r=>r.top>=clipTop&&r.bottom<=clipBottom&&r.left>=0&&r.right<=innerWidth).length,partialCards:cardBounds.filter(r=>r.top<clipBottom&&r.bottom>clipTop).length,parts,outsideControls:outside,docWidth:document.documentElement.scrollWidth}
  },configs[kind]);results.push({name,kind,...value});return value
}async function settle() {
  await page.waitForFunction(() => !document.querySelector('.page-leave-active,.page-enter-active'))
  await page.waitForTimeout(350)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function capture(name: string) {
  await settle()
  const png = await app.evaluate(async ({ BrowserWindow }: any) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(png, 'base64'))
}
const checks: any[] = []
let runtime: { version: string; isPackaged: boolean; appPath: string } | null = null
async function check(name: string, run: () => Promise<void>) {
  try { await run(); checks.push({ name, ok: true }); console.log('PASS ' + name) }
  catch (cause) { checks.push({ name, ok: false, error: String(cause) }); console.log('FAIL ' + name + ': ' + String(cause).slice(0, 500)); await capture(name + '-failure').catch(() => {}) }
}
try {
  assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile)
  runtime = await app.evaluate(({app}:any)=>({version:app.getVersion(),isPackaged:app.isPackaged,appPath:app.getAppPath()}))
  if (packagedExecutable) {
    assert.equal(runtime!.isPackaged, true, 'release validation must run the packaged application')
    assert.equal(runtime!.version, expectedVersion)
    assert.equal(path.resolve(runtime!.appPath), path.join(path.dirname(packagedExecutable), 'resources', 'app.asar'))
  }
  await app.evaluate(({BrowserWindow}:any)=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.showInactive()})
  await page.waitForFunction(()=>!!window.baoyi?.video)
  if (stage === 'E7' || stage === 'E7-boundaries') {
    await check('image-real-ipc-ownership', async()=>{results.push({name:'image-ipc',...await imageOwnershipUI(app,page,capture)})})
    await check('video-real-ipc-query', async()=>{results.push({name:'video-ipc',...await videoQueryUI(app,page,capture)})})
    await check('project-import-manual-model', async()=>{results.push({name:'project-http',...await projectImportUI(app,page,root,capture)})})
  }
  if (!stage.startsWith('E6') && stage !== 'E7-boundaries') {
  for (const [width, height] of [[960,640],[1280,820]]) {
    await app.evaluate(({BrowserWindow}:any,size:number[])=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height])
    await check('software-inline-' + width, async () => {
      await go('/'); await page.locator('.card').nth(23).waitFor(); await settle()
      const result = await measure('software-browse-' + width, 'software')
      assert.ok(Math.abs(result.firstCard.top - 142) <= 2, JSON.stringify(result))
      assert.equal(result.parts['.toolbar'].height, 64); assert.equal(result.outsideControls.length, 0)
      await capture('software-browse-' + width)
      const search = page.locator('.toolbar__search input'); await search.fill('日常工具'); await search.fill(''); await settle()
      await page.getByRole('button',{name:'批量管理',exact:true}).click()
      await page.getByRole('button',{name:'退出批量管理',exact:true}).click()
    })
  }
  await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(960,640))
  await check('software-list-clearance', async () => {
    await go('/'); await page.getByTitle('列表视图',{exact:true}).click(); await page.locator('.card--list').nth(23).waitFor()
    const original = await page.evaluate(()=>window.baoyi.software.get('layout-software-1'))
    for (const variant of ['normal','long']) {
    if(variant==='long') {
      await page.evaluate(()=>window.baoyi.software.update('layout-software-1',{name_zh:'用于验证长标题截断和键盘操作的一份本地软件工具',tags:['这是较长的标签名称一','这是较长的标签名称二','这是较长的标签名称三'],last_used_at:Date.now()}))
      await go('/game');await go('/');await page.locator('.card--list').nth(23).waitFor()
    }
    const card = page.locator('.card--list').first()
    for (const state of ['normal','hover','focus']) {
      if (state === 'hover') await card.hover()
      if (state === 'focus') { await page.mouse.move(10,10); await card.locator('.card__play').focus() }
      await settle()
      const overlap = await card.evaluate((el: Element) => {
        const time = el.querySelector('.card__time')!, range = document.createRange(); range.selectNodeContents(time)
        const text = range.getBoundingClientRect()
        return ['.card__leaf','.card__play'].map(selector => { const icon=el.querySelector(selector)!.getBoundingClientRect();return Math.max(0,Math.min(text.right,icon.right)-Math.max(text.left,icon.left))*Math.max(0,Math.min(text.bottom,icon.bottom)-Math.max(text.top,icon.top)) })
      })
      assert.deepEqual(overlap, [0,0], state + ' text must not intersect icons')
      if(state==='focus') assert.ok(await card.locator('.card__play').evaluate((el:Element)=>Number(getComputedStyle(el).opacity)>0.9),'keyboard focused launch button must be visible')
    }
    await capture('software-list-'+variant+'-960')
    }
    await page.evaluate((item:any)=>window.baoyi.software.update(item.id,{name_zh:item.name_zh,tags:item.tags,last_used_at:item.last_used_at}),original)
    await capture('software-list-960'); await page.getByTitle('网格视图',{exact:true}).click()
  })
  await check('photo-effective-grouping', async () => {
    await go('/image'); await page.getByRole('button',{name:'漫画',exact:true}).click()
    const grouping = page.getByRole('combobox',{name:'图片分组',exact:true})
    await grouping.selectOption('category'); await page.getByRole('button',{name:'照片',exact:true}).click()
    assert.equal(await grouping.inputValue(),'directory')
    await page.getByRole('button',{name:'漫画',exact:true}).click(); assert.equal(await grouping.inputValue(),'category')
    await page.getByRole('button',{name:'照片',exact:true}).click(); await grouping.selectOption('none')
    await page.reload(); await page.getByRole('button',{name:'照片',exact:true}).click(); assert.equal(await grouping.inputValue(),'none')
    await page.evaluate(()=>localStorage.setItem('library-view-image','{broken'))
    await page.reload(); await page.getByRole('button',{name:'照片',exact:true}).click(); assert.equal(await grouping.inputValue(),'directory')
    await capture('image-grouping-960')
  })

  const matrix: Array<[string,number,number]> = stage === 'E7' ? [['dark',960,640],['dark',1280,820],['light',960,640],['light',1280,820]] : [['dark',960,640]]
  if (stage !== 'E4') for (const [theme,width,height] of matrix) for (const kind of Object.keys(configs)) {
    const suffix=theme+'-'+width
    await app.evaluate(({BrowserWindow}:any,size:number[])=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height])
    await page.evaluate((theme:string)=>document.documentElement.setAttribute('data-theme',theme),theme)
    await check(kind + '-bulk-states-'+suffix, async () => {
      await go(configs[kind].route)
      if (kind === 'image') await page.getByRole('button',{name:'照片',exact:true}).click()
      await page.locator(configs[kind].card).first().waitFor(); await settle()
      await page.locator(configs[kind].content).evaluate((el:HTMLElement)=>el.scrollTop=0)
      await measure(kind+'-browse-'+suffix,kind);await capture(kind+'-browse-'+suffix)
      await page.getByRole('button',{name:kind === 'image'?'批量整理':'批量管理',exact:true}).click(); await settle()
      const zero = await measure(kind + '-bulk-zero-'+suffix, kind)
      const panelSelector = kind === 'image' ? '.image-bulk-panel' : kind === 'video' ? '.bulk-panel' : '.library-bulk'
      const panel = page.locator(panelSelector)
      assert.equal(await panel.locator('fieldset').count(),0,'zero selection has no full form')
      if (kind !== 'image' && kind !== 'video') assert.ok(zero.parts['.library-bulk'].height <= 64,JSON.stringify(zero.parts))
      if (kind === 'video') assert.ok(zero.parts['.bulk-panel'].height + zero.parts['.library-summary'].height <= 64,JSON.stringify(zero.parts))
      assert.equal(zero.outsideControls.length,0)
      await capture(kind + '-bulk-zero-'+suffix)
      const selects = kind === 'video' ? page.locator('.card') : kind === 'image' ? page.locator('.shelf-select input') : kind === 'game' ? page.locator('.gameCard__select') : kind === 'software' ? page.locator('.card__select') : page.locator('.pj-card input[type=checkbox]')
      await selects.nth(0).click(); await settle()
      const single = await measure(kind + '-bulk-single-'+suffix,kind); assert.equal(single.outsideControls.length,0)
      await selects.nth(1).click(); await settle()
      await page.locator(configs[kind].content).evaluate((el:HTMLElement)=>el.scrollTop=0);await settle()
      const multi = await measure(kind + '-bulk-multi-'+suffix,kind); assert.equal(multi.outsideControls.length,0)
      if (kind==='game'||kind==='video') {
        const label=page.locator('.home__content .card__name').first()
        const box=await label.boundingBox();assert.ok(box && box.y+box.height<=height,'selected first row name must remain visible')
        if(kind==='video') { const meta=await page.locator('.home__content .card__meta').first().boundingBox();assert.ok(meta && meta.y+meta.height<=height,'video local metadata stays visible') }
      }
      await capture(kind + '-bulk-selected-'+suffix)
      // Input shortcuts remain text editing even in selection mode.
      if (kind === 'video') await panel.locator('input').fill('regression')
      else if (kind === 'image') await panel.getByLabel('批量标签',{exact:true}).fill('regression')
      else { await panel.getByLabel('批量操作',{exact:true}).selectOption('tags'); await panel.getByLabel('批量标签',{exact:true}).fill('regression') }
      const input = panel.locator('input').first(); await input.focus(); await input.press('Control+a')
      assert.equal(await input.evaluate((el:HTMLInputElement)=>el.selectionEnd! - el.selectionStart!),10)
      const selectedCount = await selects.evaluateAll((els:any[])=>els.filter(el=>el.checked || el.getAttribute('aria-pressed')==='true').length)
      assert.equal(selectedCount,2,'text Ctrl+A must not select all resources')
      const channel = kind === 'video' || kind === 'image' ? kind + ':bulk-update' : kind + ':update'
      await app.evaluate(({ipcMain}:any, channel:string) => {
        const original = ipcMain._invokeHandlers.get(channel)
        const state:any = {original, calls:[], released:false, failed:false}
        ;(globalThis as any).bulkTest = state
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async (event:any,...args:any[]) => {
          state.calls.push(args[0])
          if (!state.released) await new Promise(resolve=>{state.release=resolve})
          const atomic = channel.endsWith('bulk-update')
          if (!state.failed && (atomic || state.calls.length === 2)) {state.failed=true;throw new Error('synthetic-write-failure')}
          return original(event,...args)
        })
      },channel)
      try {
        const submit = panel.locator('button[type=submit]').first()
        await submit.click()
        await page.waitForFunction((selector:string)=>!!document.querySelector(selector+' fieldset:disabled'),panelSelector)
        assert.equal(await page.getByRole('button',{name:kind === 'image'?'批量整理':'退出批量管理',exact:true}).isDisabled(),true,'write locks exit')
        await capture(kind+'-bulk-busy-'+suffix)
        await app.evaluate(()=>{const s=(globalThis as any).bulkTest;s.released=true;s.release?.()})
        await panel.getByText(/synthetic-write-failure/).waitFor(); await capture(kind + '-bulk-failure-'+suffix)
        if (kind !== 'video' && kind !== 'image') assert.match(await panel.innerText(),/失败 1 项/)
        await submit.click()
        await page.waitForFunction((selector:string)=>!document.querySelector(selector+' fieldset:disabled'),panelSelector)
        await settle()
        const calls = await app.evaluate(()=>(globalThis as any).bulkTest.calls)
        assert.equal(calls.length,kind==='video'||kind==='image'?2:3,'retry keeps only failed items for per-item batches')
      } finally {
        await app.evaluate(({ipcMain}:any,channel:string)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,(globalThis as any).bulkTest.original)},channel)
      }
      const clear = page.getByRole('button',{name:'清空选择',exact:true}); if (await clear.count()) await clear.click()
      const exit=page.getByRole('button',{name:kind === 'image'?'批量整理':'退出批量管理',exact:true});await exit.focus();await exit.press('Escape')
      const entry=page.getByRole('button',{name:kind === 'image'?'批量整理':'批量管理',exact:true});await entry.waitFor();await settle()
      assert.equal(await entry.evaluate((el:Element)=>el===document.activeElement),true,'Esc returns focus to batch entry')
    })
  }
  }
  if (stage === 'E7') for (const kind of ['image','project'] as const) await check(kind+'-refresh-pending',async()=>{await refreshPendingUI(app,page,kind,capture)})
  if (stage.startsWith('E6') || stage === 'E7') {
    await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'))
    const kinds = stage.startsWith('E6-') ? [stage.slice(3)] : Object.keys(configs)
    for (const kind of kinds) await check(kind + '-toolbar', async () => {
      await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(960,640))
      await go(configs[kind].route)
      if (kind === 'image') await page.getByRole('button',{name:'照片',exact:true}).click()
      await page.locator(configs[kind].card).first().waitFor(); await settle()
      if (kind === 'game' || kind === 'video') {
        for (const label of ['视图','更多']) {
          const trigger=page.getByRole('button',{name:label,exact:true})
          await trigger.focus();await trigger.press('Enter')
          await page.getByRole('group',{name:label+'选项',exact:true}).waitFor()
          await page.keyboard.press('Escape')
          assert.equal(await trigger.getAttribute('aria-expanded'),'false')
          assert.equal(await trigger.evaluate((el:Element)=>el===document.activeElement),true,'Esc returns focus')
        }
      }
      await page.locator(configs[kind].content).evaluate((el:HTMLElement)=>el.scrollTop=0);await settle()
      const r=await measure(kind+'-browse-final-960',kind)
      const baseline:any={software:186,game:226,video:217,image:298,project:237.5}
      assert.ok(r.firstCard.top <= baseline[kind]+2,JSON.stringify(r))
      if (kind==='game') assert.ok(r.parts['.toolbar'].height<=108,JSON.stringify(r.parts))
      if (kind==='image'||kind==='project') assert.ok(r.firstCard.top<=baseline[kind]-34,JSON.stringify(r))
      assert.equal(r.outsideControls.length,0)
      await capture(kind+'-browse-final-960')
      if(stage==='E7' && (kind==='game'||kind==='video')) {
        const view=page.getByRole('button',{name:'视图',exact:true});await view.click()
        const size=page.getByRole('slider',{name:kind==='game'?'游戏卡片大小':'卡片大小',exact:true})
        await size.focus();await size.press('End');await page.keyboard.press('Escape');await settle()
        const enlarged=await measure(kind+'-largest-card-960',kind);assert.equal(enlarged.outsideControls.length,0);await capture(kind+'-largest-card-960')
        await view.click();await size.focus();await size.press('Home');for(let i=0;i<4;i++)await size.press('ArrowRight');await page.keyboard.press('Escape')
        if(kind==='video') {
          await view.click();await page.getByRole('button',{name:'紧凑列表',exact:true}).click();await page.locator('.list .card').first().waitFor();await capture('video-list-final')
          await view.click();await page.getByRole('button',{name:'海报视图',exact:true}).click()
          await page.locator('.sidebar .row').filter({has:page.locator('.row__label',{hasText:/^音频$/})}).click()
          await page.getByRole('button',{name:'导入音频',exact:true}).waitFor()
          assert.equal(await page.getByRole('button',{name:'扫描本地',exact:true}).count(),0)
        }
      }
    })
  }
} finally {
  await app.close()
  fs.writeFileSync(path.join(output, 'ui-' + stage + '.json'),JSON.stringify({profile,root,runtime,results,checks,errors},null,2))
}
assert.equal(checks.filter(check=>!check.ok).length,0,'UI checks failed')
assert.deepEqual(errors,[],'renderer errors')
console.log('PASS isolated UI stage ' + stage)
