import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {_electron} from 'playwright'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {crossPagePdf} from './helpers/pdf-fixture.ts'
const output=path.resolve(process.argv[3]||'output/agent-revision');await fs.mkdir(output,{recursive:true});const profile=await fs.mkdtemp(path.join(output,'crosspage-ui-'))
const textFile=path.join(profile,'重复句与跨行.txt'),pdfFile=path.join(profile,'来源.pdf')
const original='第一处：重复句在这里。\n\n第二处：重复句在这里。跨行文字继续\n下一行仍属于同一条标注。\n\n最后一段。'
await fs.writeFile(textFile,original);await fs.writeFile(pdfFile,crossPagePdf())
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const docs=new DocumentLibrary(db),pdf=await docs.register(pdfFile);db.close()
const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const launch=()=>_electron.launch({executablePath:path.resolve(process.argv[2]||'node_modules/electron/dist/electron.exe'),args:[...(process.argv[2]?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env,timeout:30000})
let app=await launch(),page=await app.firstWindow();const errors:string[]=[],checks:string[]=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
const navigate=async(id:string)=>{await page.evaluate(id=>{location.hash='/document/'+id},id)}
const rect=()=>page.locator('.reader-viewport').boundingBox()
try {
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile);await page.waitForFunction(()=>!!window.baoyi?.workspace)
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1200,820))
  await navigate(pdf.id)
  await page.locator('[data-pdf-page="2"] .textLayer span').first().waitFor()
  const first=page.locator('[data-pdf-page="1"] .textLayer span').first(),second=page.locator('[data-pdf-page="2"] .textLayer span').first()
  await first.scrollIntoViewIfNeeded()
  const a=await first.boundingBox(),b=await second.boundingBox();assert.ok(a&&b)
  const before=await rect()
  await page.mouse.move(a!.x+2,a!.y+a!.height/2);await page.mouse.down();await page.mouse.move(b!.x+b!.width-2,b!.y+b!.height/2,{steps:20});await page.mouse.up()
  await page.getByRole('button',{name:'高亮',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.annotation-highlight').length>=2)
  assert.deepEqual(await rect(),before)
  const note=(await page.evaluate(id=>window.baoyi.workspace.documents.annotations(id),pdf.id))[0]
  assert.equal(note.location.page,1);assert.equal(note.location.anchor?.pages?.[0].page,2);assert.match(note.quote,/First page/);assert.match(note.quote,/Second page/)
  for(const part of [note.location.anchor,...note.location.anchor!.pages!.map(p=>p.anchor)])assert.ok(part?.regions?.length)
  await page.getByLabel('放大页面',{exact:true}).click();await page.locator('.annotation-card').click();await page.waitForFunction(()=>document.querySelectorAll('.annotation-highlight.active').length>=2)
  checks.push('actual-cross-page-drag','per-page-normalized-ranges','cross-page-zoom-and-card-focus')
  await app.close();app=await launch();page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>!!window.baoyi?.workspace)
  await navigate(pdf.id);await page.locator('.annotation-card').click();await page.waitForFunction(()=>document.querySelectorAll('.annotation-highlight.active').length>=2)
  const saved=(await page.evaluate(id=>window.baoyi.workspace.documents.annotations(id),pdf.id))[0];assert.deepEqual(saved.location,note.location)
  await page.locator('.annotation-highlight').last().scrollIntoViewIfNeeded();const box=await page.locator('.annotation-highlight').last().boundingBox();assert.ok(box);await page.mouse.click(box!.x+2,box!.y+2);assert.equal(await page.locator('.annotation-card.active').count(),1)
  checks.push('restart-restores-both-pages','second-page-highlight-selects-same-card');assert.deepEqual(errors,[])
  await page.screenshot({path:path.join(output,'document-crosspage.png')})
  await fs.writeFile(path.join(output,process.argv[2]?'document-crosspage-packaged-ui.json':'document-crosspage-ui.json'),JSON.stringify({status:'passed',checks,errors,profile},null,2));console.log('PASS '+checks.join(', '))

}catch(error){await page.screenshot({path:path.join(output,'document-crosspage-ui-failure.png')}).catch(()=>{});throw error}
finally{await app.close()}
