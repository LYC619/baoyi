/** Isolated native renderer and IPC. Synthetic downloads; no external model or source request. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {insertGame} from '../electron/kinds/game/db.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {inspectProject} from '../electron/kinds/project/scanner.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {pngImage} from './helpers/test-images.ts'
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/feedback-round2-2026-11-07/'+(packed?'packaged-ui':'native-ui'));fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=path.join(profile,'fixtures');fs.mkdirSync(fixture)
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hide_hentai:false,hanime_builtin_hosts:false,video_updates_weekly:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const cover=path.join(profile,'covers','wide.png');fs.mkdirSync(path.dirname(cover),{recursive:true});fs.writeFileSync(cover,pngImage(640,360))
const game=insertGame(db,{exe_path:path.join(fixture,'game.exe'),name_zh:'横封面验收游戏',name_en:'',summary:'',description:'',category:'其他',tags:[],official_url:'',source_dir:fixture,file_size:0,save_paths:[],linked_files:[]})
db.prepare('UPDATE game_meta SET cover_path=? WHERE resource_id=?').run(cover,game.id)
const projectDir=path.join(fixture,'删除验收项目');fs.mkdirSync(projectDir);fs.writeFileSync(path.join(projectDir,'README.md'),'保留这个源文件')
const projects=new ProjectLibrary(db),project=projects.register(await inspectProject(projectDir));projects.update(project.id,{name:'删除验收项目',tags:['验收']})
const docFile=path.join(fixture,'合成精读.md');fs.writeFileSync(docFile,'# 合成精读\n并行阅读验证。');const doc=await new DocumentLibrary(db).register(docFile,'book')
const videoFile=path.join(fixture,'present.mp4');fs.writeFileSync(videoFile,'synthetic')
const video=registerVideoContent(db,{title:'普通视频核验',category:'电影',items:[{title:'可用视频',order:1,files:[{path:videoFile}]},{title:'缺失视频',order:2,files:[{path:path.join(fixture,'missing.mp4')}]}]})
db.close()
const {_electron}=loadPlaywright(),app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()})
const page=await app.firstWindow(),checks:string[]=[],errors:string[]=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
const route=async(hash:string)=>{await page.evaluate(hash=>location.hash=hash,hash)}
async function check(name:string,action:()=>Promise<void>){await action();checks.push(name);console.log('PASS '+name)}
try{
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile)
  await page.waitForFunction(()=>!!window.baoyi?.video.updateCheckStatus)
  await check('全库检查跳过未绑定来源的本地电影，详情无重复检查入口',async()=>{
    await route('/video');await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'检查当前范围系列更新',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'批量检查视频更新'});await dialog.waitFor();await dialog.getByText('当前范围没有绑定有效来源的系列作品。').waitFor()
    assert.equal(await dialog.locator('.update-row').count(),0);await dialog.getByRole('button',{name:'关闭',exact:true}).click()
    await route('/video/'+video.resourceId);await page.getByRole('button',{name:'下载 / 补齐内容',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'检查更新',exact:true}).count(),0)
  })
  await check('每周启动检查设置可关闭开启，真实IPC保存，刷新后仍记忆',async()=>{
    await route('/settings?module=video&tab=downloads');const toggle=page.getByLabel('每周在启动时自动检查一次');await toggle.waitFor();assert.equal(await toggle.isChecked(),false)
    await toggle.check();await page.waitForFunction(async()=>(await window.baoyi.settings.getAll()).video_updates_weekly===true)
    await page.reload();await toggle.waitFor();assert.equal(await toggle.isChecked(),true)
    await toggle.uncheck();await page.waitForFunction(async()=>(await window.baoyi.settings.getAll()).video_updates_weekly===false)
  })
  await check('项目筛选只留一个排序下拉，标签可筛选，删除确认取消保留且确认仅删登记',async()=>{
    await route('/project');await page.locator('.pj-card').waitFor();assert.equal(await page.locator('.pj-toolbar select').count(),1)
    await page.getByRole('button',{name:'#验收',exact:true}).click();assert.equal(await page.locator('.pj-card').count(),1)
    await page.locator(`[data-project-id="${project.id}"]`).getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'删除项目',exact:true}).click()
    let dialog=page.getByRole('dialog',{name:'删除项目'});await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.ok(await page.evaluate(id=>window.baoyi.project.get(id),project.id))
    await route('/project/'+project.id);await page.getByRole('button',{name:'删除项目',exact:true}).waitFor();await route('/project')
    await page.locator(`[data-project-id="${project.id}"]`).getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'删除项目',exact:true}).click();dialog=page.getByRole('dialog',{name:'删除项目'});await page.screenshot({path:path.join(output,'project-delete.png')})
    await dialog.getByRole('button',{name:'确认删除项目'}).click();await dialog.waitFor({state:'detached'});assert.equal(await page.evaluate(id=>window.baoyi.project.get(id),project.id),null)
    assert.equal(fs.readFileSync(path.join(projectDir,'README.md'),'utf8'),'保留这个源文件')
  })
  await check('游戏横向封面16:9铺满展示且刷新记忆，仍可切回竖向',async()=>{
    await route('/game');await page.locator('.gameCard').waitFor();await page.getByRole('button',{name:'视图',exact:true}).click();await page.getByRole('button',{name:'横版 16:9',exact:true}).click();await page.keyboard.press('Escape')
    const ratio=await page.locator('.gameCard .game-cover').first().evaluate(el=>{const r=el.getBoundingClientRect();return r.width/r.height});assert.ok(Math.abs(ratio-16/9)<.03)
    assert.equal(await page.locator('.gameCard .cv-img').first().evaluate(el=>getComputedStyle(el).objectFit),'cover')
    await page.screenshot({path:path.join(output,'game-landscape.png')});await page.reload();await page.locator('.gameCard').waitFor()
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('library-view-game')!).coverShape),'landscape')
    await page.getByRole('button',{name:'视图',exact:true}).click();await page.getByRole('button',{name:'竖版 2:3',exact:true}).click();await page.keyboard.press('Escape')
  })
  await check('下载运行状态不再在archive:send前拒绝；调用到达模型配置检查',async()=>{
    const liveDb=new DatabaseSync(path.join(profile,'baoyi.db'))
    liveDb.prepare("INSERT INTO video_download_jobs(id,status,updated_at,payload) VALUES('synthetic-running','running',?,'{}')").run(Date.now());liveDb.close()
    const result=await page.evaluate(async id=>{try{await window.baoyi.archive.send({text:'精读这个资料',contextIds:[id]});return ''}catch(e){return String(e)}},doc.id)
    assert.match(result,/配置 AI 模型/);assert.doesNotMatch(result,/请先结束正在运行/)
    const cleanup=new DatabaseSync(path.join(profile,'baoyi.db'));cleanup.prepare("DELETE FROM video_download_jobs WHERE id='synthetic-running'").run();cleanup.close()
  })
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:checks.length,checks,errors,profile,executable:packed||'development',boundary:'Actual Electron, local files and deletion. No external model request. Running download row is synthetic; source comparison and locking are covered by service/IPC tests.',video:video.resourceId},null,2))
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors},null,2));throw error}
finally{await app.close()}
