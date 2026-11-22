import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron } from 'playwright'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

const output=path.resolve('output/agent-revision');await fs.mkdir(output,{recursive:true})
const profile=await fs.mkdtemp(path.join(output,'category-ui-')),root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-category-ui-'))
const pdf=path.join(root,'证书验收.pdf'),md=path.join(root,'研究内容.md')
await fs.writeFile(pdf,'%PDF-1.4\n isolated import fixture');await fs.writeFile(md,'# 研究内容\n资料分类说明验收')
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value));db.close()
const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const launch=()=>_electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[path.resolve('.'),'--user-data-dir='+profile,'--disable-gpu'],env,timeout:30000})
let app=await launch(),page=await app.firstWindow();const checks:string[]=[],errors:string[]=[]
page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
const navigate=async(url:string)=>page.evaluate(url=>{location.hash=url},url)
const pick=async(file:string)=>app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},file)
try {
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile)
  await page.waitForFunction(()=>!!window.baoyi?.workspace)
  await navigate('/document');await page.locator('.document-subnav').getByRole('button',{name:'资料',exact:true}).click();await page.locator('.ws-sidebar button').filter({hasText:/^证书/}).click()
  await pick(pdf);await page.getByLabel('导入资料',{exact:true}).click();await page.getByRole('button',{name:'选择文件',exact:true}).click()
  assert.equal(await page.getByLabel('批量导入分类',{exact:true}).inputValue(),'certificate')
  await page.getByRole('button',{name:'导入所选 1 份资料',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  const certificate=(await page.evaluate(()=>window.baoyi.workspace.documents.list()))[0]
  assert.equal(certificate.type,'certificate');assert.equal(certificate.typeLocked,true)
  assert.doesNotMatch(await page.locator('.document-row').innerText(),/未读|书籍/);checks.push('certificate-import-inherits-category-through-preview')
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await page.getByRole('button',{name:'分类',exact:true}).click()
  await page.getByRole('button',{name:'新增分类',exact:true}).waitFor()
  await page.getByRole('button',{name:'新增分类',exact:true}).click()
  await page.getByLabel('分类名称',{exact:true}).fill('研究资料');await page.getByLabel('分类说明',{exact:true}).fill('研究方案、论证依据与实验说明')
  await page.getByLabel('资料用途',{exact:true}).selectOption('reading');await page.getByRole('button',{name:'保存分类',exact:true}).click()
  await page.getByRole('button',{name:'编辑 研究资料',exact:true}).click();await page.getByLabel('分类名称',{exact:true}).fill('研究档案');await page.getByRole('button',{name:'保存分类',exact:true}).click()
  const category=(await page.evaluate(()=>window.baoyi.workspace.documents.categories())).find(c=>c.name==='研究档案')!
  assert.ok(category);assert.equal(category.description,'研究方案、论证依据与实验说明')
  await navigate('/document');await page.locator('.document-subnav').getByRole('button',{name:'阅读',exact:true}).click();await page.locator('.ws-sidebar button').filter({hasText:/^研究档案/}).click()
  await pick(md);await page.getByLabel('导入资料',{exact:true}).click();await page.getByRole('button',{name:'选择文件',exact:true}).click();assert.equal(await page.getByLabel('批量导入分类',{exact:true}).inputValue(),category.id)
  await page.getByRole('button',{name:'导入所选 1 份资料',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  await page.locator('.document-row').filter({hasText:'研究内容'}).waitFor();await page.screenshot({path:path.join(output,'document-categories.png')})
  checks.push('custom-category-create-rename-import')
  await app.close();app=await launch();page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>!!window.baoyi?.workspace)
  await navigate('/document');const saved=(await page.evaluate(()=>window.baoyi.workspace.documents.list())).find(d=>d.type===category.id)!
  assert.equal(saved.typeName,'研究档案');assert.equal(saved.readable,true);checks.push('restart-keeps-stable-category-identity')
  await page.evaluate(()=>window.baoyi.data.reset('all'))
  assert.equal((await page.evaluate(()=>window.baoyi.workspace.documents.categories())).length,7,'恢复出厂后移除自建分类并装回七个默认分类')
  assert.ok(await fs.stat(pdf));checks.push('factory-reset-clears-categories-keeps-files')
  assert.deepEqual(errors,[])
  await fs.writeFile(path.join(output,'document-category-ui.json'),JSON.stringify({status:'passed',checks,errors,profile},null,2));console.log('PASS '+checks.join(', '))
} catch(error) {await page.screenshot({path:path.join(output,'document-category-ui-failure.png')}).catch(()=>{});throw error}
finally {await app.close();assert.ok(root.startsWith(os.tmpdir()+path.sep));await fs.rm(root,{recursive:true,force:true})}
