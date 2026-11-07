import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {existsSync} from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {_electron} from 'playwright'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {DocumentRecycle} from '../electron/workspace/document-recycle.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {WorkspaceLinks} from '../electron/workspace/links.ts'

const output=path.resolve('output/agent-revision');await fs.mkdir(output,{recursive:true})
const profile=await fs.mkdtemp(path.join(output,'files-settings-ui-')),data=path.join(profile,'资料数据'),projectDir=path.join(profile,'项目'),source=path.join(profile,'资料样本.txt'),imported=path.join(profile,'导入证书.txt')
await fs.mkdir(data);await fs.mkdir(projectDir);await fs.writeFile(source,'需要保留的标注来源。');await fs.writeFile(imported,'导入分类样本')
const database=path.join(profile,'baoyi.db'),db=new DatabaseSync(database);initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false,document_data_dir:data,ai:{enabled:false,api_url:'',api_key:'',model:''}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const docs=new DocumentLibrary(db),doc=await docs.register(source),note=docs.annotate(doc.id,{kind:'excerpt',quote:'标注来源',note:'留下想法',location:{page:1,offset:0}})
const project=new ProjectLibrary(db).register({path:projectDir,name:'文件操作样本',summary:'',category:'其他',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]});new WorkspaceLinks(db).add('project',project.id,doc.id,note.id);db.close()
const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const executable=process.env.BAOYI_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe')
const launch=()=>_electron.launch({executablePath:executable,args:[...(process.env.BAOYI_TEST_EXE?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env,timeout:30000})
let app=await launch(),page=await app.firstWindow();page.setDefaultTimeout(15000)
const checks:string[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
async function until(check:()=>Promise<unknown>){const start=Date.now();while(!await check()){if(Date.now()-start>15000)throw new Error('Timed out waiting for persisted result');await new Promise(resolve=>setTimeout(resolve,100))}}
const navigate=async(url:string)=>{await page.evaluate(url=>{location.hash=url},url)}
const pick=async(file:string)=>app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},file)
const restorePage=async()=>{await navigate('/settings?module=document&tab=organize');await page.locator('.recycle-bin').waitFor()}
const selectDoc=async()=>{await navigate('/document');await page.locator('.document-row').filter({hasText:'资料样本'}).click()}
try{
 await page.waitForFunction(()=>!!window.baoyi?.workspace);assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile)
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1200,850))
 await page.locator('.titlebar-settings').click();await page.locator('.scope-nav').getByRole('button',{name:'全局',exact:true}).click();await page.getByRole('heading',{name:'全局设置',exact:true}).waitFor()
 await page.getByRole('button',{name:'AI 配置',exact:true}).click();assert.ok((await page.locator('h1').innerText()).includes('全局'))
 await navigate('/settings?module=document&tab=reader');await page.getByLabel('阅读字号',{exact:true}).fill('21');await page.getByRole('button',{name:'保存模块偏好'}).click();await page.getByRole('status').filter({hasText:'已保存'}).waitFor();await navigate('/settings?module=document&tab=scan');await page.getByLabel('在全部分类导入时默认归入').selectOption('certificate');await page.getByLabel('新导入资料的默认标签').fill('样本、默认标签');await page.getByRole('button',{name:'保存模块偏好'}).click();await page.getByRole('status').filter({hasText:'已保存'}).waitFor()
 await pick(imported);await navigate('/document');await page.getByRole('button',{name:'导入资料',exact:true}).click();await page.getByRole('button',{name:'选择文件',exact:true}).click();assert.equal(await page.getByLabel('批量导入分类',{exact:true}).inputValue(),'certificate');await page.getByRole('button',{name:/导入所选 1 份资料/}).click()
 await until(()=>page.evaluate(async()=>{const d=(await window.baoyi.workspace.documents.list()).find(d=>d.name==='导入证书');return d?.type==='certificate'&&d.tags.includes('默认标签')}))
 await navigate('/document/'+doc.id);await page.locator('.document-prose').waitFor();assert.equal(await page.locator('.document-prose').evaluate(e=>getComputedStyle(e).fontSize),'21px');checks.push('global-and-module-settings','import-category-and-tags','reading-preference-applied')
 await navigate('/settings?module=personal&tab=personal');await page.getByLabel('资产分类').fill('VPS、研究设备');await page.getByLabel('到期提醒提前天数').fill('14');await page.getByRole('button',{name:'保存模块偏好'}).click();await page.getByRole('status').filter({hasText:'已保存'}).waitFor()
 await navigate('/personal?section=asset');await page.getByRole('button',{name:'添加背包',exact:true}).first().click();assert.ok((await page.getByLabel('类别',{exact:true}).locator('option').allTextContents()).includes('研究设备'));await page.keyboard.press('Escape');checks.push('personal-custom-categories')
 await navigate('/project/'+project.id);await page.getByRole('button',{name:'选择电脑文件',exact:true}).waitFor()
 for(const mode of ['link','copy','move']){
  await pick(source);await page.getByRole('button',{name:'选择电脑文件',exact:true}).click();await page.getByLabel('处理方式').selectOption(mode)
  if(mode!=='link')await page.getByLabel('目标文件名').fill(mode+'.txt')
  await page.getByRole('button',{name:'预览文件操作'}).click();await page.getByRole('button',{name:/确认(链接|复制|移动)并关联/}).click();await page.getByRole('dialog',{name:'关联电脑文件'}).waitFor({state:'hidden'})
 }
 assert.ok(!existsSync(source));assert.equal(await fs.readFile(path.join(projectDir,'copy.txt'),'utf8'),'需要保留的标注来源。');assert.ok(existsSync(path.join(projectDir,'move.txt')))
 assert.equal((await page.evaluate(()=>window.baoyi.workspace.documents.list())).filter(d=>d.name==='资料样本').length,1);checks.push('project-link-copy-move-same-identity')
 await selectDoc();await page.getByRole('button',{name:'移除资料索引'}).click();await page.getByRole('button',{name:'预览移除范围'}).click();await page.getByRole('button',{name:'确认仅移除索引'}).click();await page.getByRole('dialog',{name:'移除资料',exact:true}).waitFor({state:'hidden'})
 await until(()=>page.evaluate(async id=>!(await window.baoyi.workspace.documents.get(id)),doc.id));assert.ok(existsSync(path.join(projectDir,'move.txt')))
 await restorePage();await page.locator('.recycle-row').filter({hasText:'资料样本'}).getByRole('button',{name:'恢复资料',exact:true}).click();await until(()=>page.evaluate(async id=>!!(await window.baoyi.workspace.documents.get(id)),doc.id));checks.push('index-only-removal-and-restore')
 await selectDoc();await page.getByRole('button',{name:'移除资料索引'}).click();await page.getByLabel('同时删除源文件（先移入回收站）').check()
 await page.getByLabel(path.join(projectDir,'move.txt'),{exact:false}).check();await page.getByRole('button',{name:'预览移除范围'}).click();await page.getByRole('button',{name:'确认移入回收站'}).click();await page.getByRole('dialog',{name:'移除资料',exact:true}).waitFor({state:'hidden'});await until(()=>page.evaluate(async id=>!(await window.baoyi.workspace.documents.get(id)),doc.id))
 assert.ok(!existsSync(path.join(projectDir,'move.txt')));assert.ok(existsSync(path.join(projectDir,'copy.txt')))
 await fs.writeFile(path.join(projectDir,'move.txt'),'占用的新文件');await restorePage();await page.locator('.recycle-row').filter({hasText:'资料样本'}).getByRole('button',{name:'恢复资料',exact:true}).click();await page.getByRole('alert').filter({hasText:'占用'}).waitFor()
 const restored=path.join(profile,'恢复的资料.txt');await pick(restored);await page.locator('.recycle-row').filter({hasText:'资料样本'}).getByRole('button',{name:'恢复到新位置'}).click();await until(()=>page.evaluate(async id=>!!(await window.baoyi.workspace.documents.get(id)),doc.id))
 assert.equal(await fs.readFile(path.join(projectDir,'move.txt'),'utf8'),'占用的新文件');assert.equal((await page.evaluate(id=>window.baoyi.workspace.documents.annotations(id),doc.id))[0].id,note.id);checks.push('selected-copy-only-recycle','collision-safe-restore-keeps-annotation')
 for(const theme of ['light','dark'])for(const width of [960,1440]){
  await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows()[0];win.unmaximize();win.setSize(width,900);if(width===1440)win.maximize()},width)
  await navigate('/settings?scope=global&tab=appearance');await page.getByRole('button',{name:theme==='dark'?'深色':'浅色',exact:true}).click();await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme)
  for(const url of ['/personal','/project','/','/game','/video','/image','/document']){
   await navigate(url);await page.locator('.settings').waitFor({state:'hidden'});await page.waitForFunction(()=>!!document.querySelector('.app__view')&&!document.querySelector('.page-enter-active,.page-leave-active'))
   assert.ok(await page.locator('.titlebar-settings').isVisible())
   await page.screenshot({path:path.join(output,`layout-${theme}-${width}-${url.slice(1)||'software'}.png`)})
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);assert.equal(overflow,false,`${theme}/${width}/${url}: horizontal overflow`)
  }
  await page.screenshot({path:path.join(output,`files-settings-${theme}-${width}.png`)})
 }
 checks.push('all-modules-light-dark-960-maximized')
 await app.close()
 const restartDb=new DatabaseSync(database),expirySource=path.join(profile,'到期样本.txt');await fs.writeFile(expirySource,'已到期')
 const expiryDoc=await new DocumentLibrary(restartDb).register(expirySource),recycle=new DocumentRecycle(restartDb,()=>data,()=>new Date(2025,0,31,12).getTime()),expired=await recycle.remove(await recycle.plan(expiryDoc.id,[expirySource]));restartDb.close()
 const loose=path.join(data,'回收站','用户自行保存.txt');await fs.writeFile(loose,'保留')
 app=await launch();page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>!!window.baoyi?.workspace)
 await until(()=>page.evaluate(async id=>(await window.baoyi.workspace.recycle.list()).find(r=>r.id===id)?.state==='purged',expired.id))
 assert.ok(!existsSync(expired.files[0].stored));assert.ok(existsSync(loose));assert.equal((await page.evaluate(()=>window.baoyi.workspace.preferences.get('document'))).fontSize,21)
 await navigate('/document/'+doc.id);await page.locator('.annotation-card').waitFor();checks.push('restart-preferences-annotations','startup-cleans-only-expired-recorded-files')
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,process.env.BAOYI_TEST_EXE?'files-settings-packaged-ui.json':'files-settings-ui.json'),JSON.stringify({status:'passed',checks,errors,profile,executable},null,2));console.log('PASS '+checks.join(', '))
}catch(error){await page.screenshot({path:path.join(output,'files-settings-failure.png')}).catch(()=>{});throw error}finally{await app.close().catch(()=>{})}
