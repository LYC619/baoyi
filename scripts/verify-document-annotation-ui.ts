import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {_electron} from 'playwright'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {textPdf} from './helpers/pdf-fixture.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
const output=path.resolve('output/document-experience');await fs.mkdir(output,{recursive:true});const profile=await fs.mkdtemp(path.join(output,'annotation-ui-'))
const textFile=path.join(profile,'重复句与跨行.txt'),pdfFile=path.join(profile,'来源.pdf')
const original='第一处：重复句在这里。\n\n第二处：重复句在这里。跨行文字继续\n下一行仍属于同一条标注。\n\n最后一段。'
await fs.writeFile(textFile,original);await fs.writeFile(pdfFile,textPdf('Evidence belongs to a source page.'))
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const docs=new DocumentLibrary(db),text=await docs.register(textFile),pdf=await docs.register(pdfFile)
const project=new ProjectLibrary(db).register({path:profile,name:'摘录验收项目',summary:'',category:'调研写作',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]});db.close()
const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const launch=()=>_electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[path.resolve('.'),'--user-data-dir='+profile,'--disable-gpu'],env,timeout:30000})
let app=await launch(),page=await app.firstWindow();const errors:string[]=[],checks:string[]=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
const navigate=async(id:string)=>{await page.evaluate(id=>{location.hash='/document/'+id},id)}
const rect=()=>page.locator('.reader-viewport').boundingBox()
try {
  assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile);await page.waitForFunction(()=>!!window.baoyi?.workspace)
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1200,820))
  await navigate(text.id);await page.locator('.document-prose').waitFor();const before=await rect()
  const points=await page.locator('[data-paragraph="2"]').evaluate(el=>{
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),nodes:Node[]=[];for(let n=walker.nextNode();n;n=walker.nextNode())nodes.push(n)
    const first=document.createRange();first.setStart(nodes[0],4);first.setEnd(nodes[0],5);const last=document.createRange();last.setStart(nodes.at(-1)!,nodes.at(-1)!.textContent!.length-2);last.setEnd(nodes.at(-1)!,nodes.at(-1)!.textContent!.length-1)
    const a=first.getBoundingClientRect(),b=last.getBoundingClientRect();return {x1:a.left+1,y1:a.top+a.height/2,x2:b.right-1,y2:b.top+b.height/2}
  })
  await page.mouse.move(points.x1,points.y1);await page.mouse.down();await page.mouse.move(points.x2,points.y2,{steps:15});await page.mouse.up()
  await page.locator('.reader-selection').waitFor();assert.deepEqual(await rect(),before,'选文不能改变正文位置或大小')
  await page.getByRole('button',{name:'高亮',exact:true}).click();await page.locator('.annotation-highlight').first().waitFor()
  assert.deepEqual(await rect(),before,'保存提示不能改变正文位置或大小')
  const note=(await page.evaluate(id=>window.baoyi.workspace.documents.annotations(id),text.id))[0];assert.ok(note.location.anchor);assert.match(note.quote,/重复句/);assert.equal(note.location.page,2);assert.ok(note.location.anchor!.start>='第一处：重复句在这里。'.length);assert.match(note.quote,/继续\n下一行/)
  const oldHighlightWidth=await page.locator('.annotation-highlight').first().evaluate(e=>e.getBoundingClientRect().width)
  await page.getByLabel('阅读偏好与设置',{exact:true}).click()
  await page.locator('.setting-row').filter({hasText:'字号'}).getByRole('button').last().click()
  await page.waitForFunction(width=>Math.abs(document.querySelector('.annotation-highlight')!.getBoundingClientRect().width-width)>1,oldHighlightWidth,{timeout:3000})
  await page.getByLabel('阅读偏好与设置',{exact:true}).click();await page.locator('.annotation-card').first().click();await page.waitForFunction(()=>document.querySelectorAll('.annotation-highlight.active').length>0)
  const highlight=await page.locator('.annotation-highlight').first().boundingBox();assert.ok(highlight);await page.mouse.click(highlight!.x+2,highlight!.y+2);assert.equal(await page.locator('.annotation-card.active').count(),1)
  await page.locator('.annotation-heading input').first().check();await page.getByRole('button',{name:'复制 Markdown',exact:true}).click()
  await page.getByRole('status').filter({hasText:'已复制 Markdown'}).waitFor()
  const clipboard=await app.evaluate(({clipboard})=>clipboard.readText());assert.match(clipboard,/重复句与跨行/);assert.match(clipboard,/重复句/);assert.match(clipboard,/第 2/)
  await page.getByRole('button',{name:'引用到项目',exact:true}).first().click()
  await page.getByRole('button',{name:'摘录验收项目',exact:true}).click()
  await page.getByRole('button',{name:'已引用 → 摘录验收项目',exact:true}).waitFor()
  assert.deepEqual(await rect(),before,'就地引用保持正文尺寸')
  await page.getByRole('button',{name:'引用到项目',exact:true}).first().click()
  await page.locator('.picker-project').filter({hasText:'摘录验收项目'}).click()
  assert.equal((await page.evaluate(id=>window.baoyi.workspace.links.list('project',id),project.id)).length,1)
  await page.getByRole('button',{name:'已引用 → 摘录验收项目',exact:true}).click()
  await page.locator('.ws-link-main').filter({hasText:note.quote.slice(0,8)}).first().click()
  await page.waitForFunction(()=>document.querySelectorAll('.annotation-highlight.active').length>0)
  assert.ok(page.url().includes('annotation='+note.id))
  assert.equal(await page.getByRole('button',{name:'导出并在 Obsidian 打开',exact:true}).count(),0)
  checks.push('actual-drag-floating-highlight-no-layout-shift','repeated-crossline-text-bidirectional-font-resize','markdown-clipboard','in-place-project-link-idempotent-and-exact-return')
  await page.screenshot({path:path.join(output,'document-highlights.png')})
  await app.close();app=await launch();page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>!!window.baoyi?.workspace)
  await navigate(text.id);await page.locator('.annotation-highlight').first().waitFor();assert.equal((await page.evaluate(id=>window.baoyi.workspace.documents.annotations(id),text.id))[0].id,note.id)
  await navigate(pdf.id);await page.locator('.textLayer span').first().waitFor();const span=await page.locator('.textLayer span').first().boundingBox();assert.ok(span)
  await page.mouse.move(span!.x+2,span!.y+span!.height/2);await page.mouse.down();await page.mouse.move(span!.x+span!.width-2,span!.y+span!.height/2,{steps:15});await page.mouse.up();await page.getByRole('button',{name:'高亮',exact:true}).click();await page.locator('.annotation-highlight').first().waitFor()
  const pdfNote=(await page.evaluate(id=>window.baoyi.workspace.documents.annotations(id),pdf.id))[0];assert.ok(pdfNote.location.anchor?.regions?.length)
  await page.getByLabel('放大页面',{exact:true}).click();await page.locator('.annotation-card').click();await page.waitForFunction(()=>document.querySelectorAll('.annotation-highlight.active').length>0)
  checks.push('restart-keeps-text-range','pdf-drag-normalized-regions-and-zoom')
  await fs.writeFile(textFile,'新增前言。\n\n'+original);await navigate(text.id);await page.locator('.annotation-highlight').first().waitFor();assert.equal((await page.evaluate(id=>window.baoyi.workspace.documents.annotations(id),text.id))[0].id,note.id)
  await navigate(pdf.id);await fs.writeFile(textFile,'原文已被完整替换，不能伪装找到原句。');await navigate(text.id);await page.getByText('原文位置已变化',{exact:true}).waitFor();assert.equal(await page.locator('.annotation-highlight').count(),0)
  checks.push('changed-file-relocates-or-explicitly-reports-missing');assert.deepEqual(errors,[])
  await fs.writeFile(path.join(output,'document-annotation-ui.json'),JSON.stringify({status:'passed',checks,errors,profile},null,2));console.log('PASS '+checks.join(', '))
}catch(error){await page.screenshot({path:path.join(output,'document-annotation-ui-failure.png')}).catch(()=>{});throw error}
finally{await app.close()}
