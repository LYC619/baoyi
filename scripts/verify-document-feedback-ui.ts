import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {_electron} from 'playwright'
import {expect} from 'playwright/test'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {outlinePdf} from './helpers/pdf-fixture.ts'

const packaged=Boolean(process.argv[2])
const output=path.resolve(process.argv[3]||'output/document-feedback-round2')
await fs.mkdir(output,{recursive:true})
const profile=await fs.mkdtemp(path.join(output,'ui-')),incoming=path.join(profile,'incoming'),dataRoot=path.join(profile,'data')
await fs.mkdir(incoming);await fs.mkdir(dataRoot)
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  const request=JSON.parse(body);assert.ok(request.tools.some((t:any)=>t.function.name==='suggest_document'))
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'fixture',type:'function',function:{name:'suggest_document',arguments:JSON.stringify({categoryId:'paper',name:'识别后的论文',author:'作者甲',tags:['研究'],reason:'依据标题与正文样本'})}}]},finish_reason:'tool_calls'}],usage:{total_tokens:25}}))
})})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const address=server.address() as {port:number}
for(const [key,value] of Object.entries({onboarded:true,theme:'dark',hanime_builtin_hosts:false,document_data_dir:dataRoot,ai:{enabled:true,api_url:`http://127.0.0.1:${address.port}/v1`,api_key:'fixture-only',model:'fixture'}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const docs=new DocumentLibrary(db)
const novelFile=path.join(profile,'长篇小说.txt')
await fs.writeFile(novelFile,Array.from({length:120},(_,i)=>`第${i+1}章 长标题测试与新的旅程\n${i===78?'跨章目标词在这里。跨章目标词第二处。':'本章平静地讲述故事。'}\n${'角色走进树林，看见远方灯火。\n'.repeat(30)}`).join('\n'))
const novel=await docs.register(novelFile,'novel')
const bookFile=path.join(profile,'技术笔记.md');await fs.writeFile(bookFile,'# 开始\n\n第一段普通文本。\n\n## 第二节\n\n本段有搜索定位词。')
const book=await docs.register(bookFile,'book')
const pdfFile=path.join(profile,'目录测试.pdf');await fs.writeFile(pdfFile,outlinePdf());const pdf=await docs.register(pdfFile,'book')
const certFile=path.join(profile,'证书.md');await fs.writeFile(certFile,'# 证书');await docs.register(certFile,'certificate')
const newFile=path.join(incoming,'待导入.md');await fs.writeFile(newFile,'# 学术论文\n研究数据与方法。')
db.close()
const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const app=await _electron.launch({executablePath:path.resolve(process.argv[2]||'node_modules/electron/dist/electron.exe'),args:[...(packaged?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env})
const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(18000)
async function home(){await page.evaluate(()=>location.hash='/document');await page.locator('.document-home').waitFor()}
async function selectNovel(){
  await page.locator('.novel-paragraph').first().evaluate(el=>{const node=el.firstChild!;const range=document.createRange();range.setStart(node,0);range.setEnd(node,Math.min(9,node.textContent!.length));const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))})
  await expect(page.getByRole('toolbar',{name:'选文操作'})).toBeVisible()
}
try{
  assert.equal(await app.evaluate(({app})=>app.getPath('userData')),profile)
  const runtime=await app.evaluate(({app})=>({version:app.getVersion(),packaged:app.isPackaged}))
  assert.equal(runtime.packaged,packaged)
  assert.equal(runtime.version,JSON.parse(await fs.readFile('package.json','utf8')).version)
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.unmaximize();w.setMinimumSize(600,600);w.setSize(1280,900)})
  await page.locator('.app__view').waitFor();await home()
  assert.equal(await page.locator('.ws-sidebar').getByRole('button',{name:/^全部\d/}).count(),0)
  assert.equal(await page.locator('.ws-sidebar').getByText('待归类',{exact:true}).count(),0)
  assert.equal(await page.locator('.ws-sidebar').getByText('来源目录',{exact:true}).count(),0)
  await page.locator('.sidebar-list').getByRole('button',{name:/^小说/}).click();await expect(page.locator('.document-row')).toHaveCount(1)
  await page.locator('.document-subnav').getByRole('button',{name:'阅读',exact:true}).click();await expect(page.locator('.document-row')).toHaveCount(3)
  await page.locator('.document-row').filter({hasText:'技术笔记'}).click()
  await expect(page.getByLabel('资料分类',{exact:true})).toBeVisible()
  await expect(page.locator('.document-inspector .ws-path')).toHaveCount(0)
  await page.getByLabel('资料作者',{exact:true}).fill('修改后的作者');await page.getByLabel('资料备注',{exact:true}).click()
  await expect.poll(()=>page.evaluate(id=>window.baoyi.workspace.documents.get(id).then(i=>i?.author),book.id)).toBe('修改后的作者')
  await page.getByLabel('设置自定义分组',{exact:true}).selectOption('__new__');await page.getByLabel('新分组名称').fill('新建研究组');await page.getByRole('button',{name:'新建',exact:true}).click()
  await expect.poll(()=>page.evaluate(id=>window.baoyi.workspace.documents.get(id).then(i=>!!i?.customGroupId),book.id)).toBe(true)
  await page.getByLabel('资料标签',{exact:true}).fill('重点，已读');await page.getByLabel('资料备注',{exact:true}).click()
  await expect.poll(()=>page.evaluate(id=>window.baoyi.workspace.documents.get(id).then(i=>i?.readState),book.id)).toBe('read')
  await page.getByLabel('资料分类',{exact:true}).selectOption('archive_other')
  await expect.poll(()=>page.evaluate(id=>window.baoyi.workspace.documents.get(id).then(i=>i?.submodule),book.id)).toBe('archive')
  await page.getByLabel('资料分类',{exact:true}).selectOption('book')
  await page.screenshot({path:path.join(output,'details-dark.png')})
  await page.getByRole('button',{name:'批量管理',exact:true}).click()
  await page.getByLabel('选择资料 技术笔记',{exact:true}).check();await page.getByLabel('选择资料 长篇小说',{exact:true}).check()
  await page.getByLabel('批量设置标签').fill('批量标签');await page.getByLabel('设置分组',{exact:true}).check()
  await page.getByLabel('设置自定义分组',{exact:true}).selectOption('__new__');await page.getByLabel('新分组名称').fill('批量新组');await page.getByRole('button',{name:'新建',exact:true}).click()
  await page.getByRole('button',{name:'应用到 2 份',exact:true}).click()
  await expect.poll(()=>page.evaluate(id=>window.baoyi.workspace.documents.get(id).then(i=>i?.tags.includes('批量标签')),novel.id)).toBe(true)
  await page.getByLabel('批量设置分类').selectOption('novel');await page.getByRole('button',{name:'应用到 2 份',exact:true}).click()
  await expect.poll(()=>page.evaluate(id=>window.baoyi.workspace.documents.get(id).then(i=>i?.type),book.id)).toBe('novel')
  await page.getByRole('button',{name:'批量管理',exact:true}).click()
  await page.evaluate(id=>location.hash='/document/'+id,novel.id);await page.locator('.novel-paragraph').first().waitFor()
  await selectNovel();await page.locator('.header-book-title').click();await expect(page.getByRole('toolbar',{name:'选文操作'})).toHaveCount(0)
  await selectNovel();await page.getByRole('button',{name:'复制选文',exact:true}).click();await expect(page.locator('.reader-toast')).toContainText('已复制选文');await expect(page.locator('.reader-toast')).toHaveCount(0,{timeout:4500})
  await selectNovel();await page.getByRole('toolbar',{name:'选文操作'}).getByRole('button',{name:'书签',exact:true}).click()
  await expect(page.locator('.annotation-card')).toHaveCount(1);await expect(page.locator('.annotation-card blockquote')).not.toHaveText('')
  await selectNovel();await page.getByRole('button',{name:'高亮',exact:true}).click();await expect(page.locator('.annotation-card')).toHaveCount(2)
  await page.getByLabel('全选标注').check();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'删除所选标注'}).click();await expect(page.locator('.annotation-card')).toHaveCount(0)
  await page.getByLabel('切换阅读目录').click();await expect(page.locator('.toc-chapter-item')).toHaveCount(120)
  const heights=await page.locator('.toc-chapter-item').evaluateAll(items=>items.map(i=>i.getBoundingClientRect().height));assert.ok(heights.every(h=>h>=32))
  await page.getByLabel('搜索正文',{exact:true}).fill('跨章目标词');await page.getByLabel('查找下一处').click()
  await expect(page.locator('.reader-search-message')).toHaveText('已找到 · 第 79 章');await expect(page.locator('.reader-controls')).toContainText('章')
  assert.equal(await page.locator('.reader-controls').getByText('100%',{exact:true}).count(),0)
  await page.screenshot({path:path.join(output,'novel-search-toc-dark.png')})
  await page.getByLabel('阅读偏好与设置').click();const before=await page.locator('.novel-prose').evaluate(e=>getComputedStyle(e).fontSize)
  await page.locator('.setting-row').filter({hasText:'字号'}).getByRole('button').last().click();assert.notEqual(await page.locator('.novel-prose').evaluate(e=>getComputedStyle(e).fontSize),before)
  await page.evaluate(id=>location.hash='/document/'+id,pdf.id);await page.locator('.pdf-page[data-rendered="true"]').first().waitFor()
  await page.getByLabel('搜索正文',{exact:true}).fill('chapter 2');await page.getByLabel('查找下一处').click();await expect(page.locator('.reader-search-message')).toHaveText('已找到 · 第 2 页')
  const beforePdf=await page.locator('[data-pdf-page="2"]').evaluate(e=>e.getBoundingClientRect().width);await page.getByLabel('放大页面',{exact:true}).click();await expect.poll(()=>page.locator('[data-pdf-page="2"]').evaluate(e=>e.getBoundingClientRect().width)).toBeGreaterThan(beforePdf)
  await page.waitForFunction(()=>{
    const range=(CSS as any).highlights.get('document-search')?.values().next().value as Range|undefined
    return document.querySelector('[data-pdf-page="2"]')?.getAttribute('data-rendered')==='true' && range?.startContainer.isConnected && range?.toString().toLowerCase().includes('chapter 2')
  })
  await page.screenshot({path:path.join(output,'pdf-search.png')})
  // A zoom can still be flushing its position; answer the existing leave guard as a user would.
  const leaveZoom = async (dialog:import('playwright').Dialog) => {assert.match(dialog.message(),/阅读位置尚未保存/);await dialog.accept()}
  page.on('dialog',leaveZoom)
  await page.evaluate(id=>location.hash='/document/'+id,book.id);await page.locator('.document-prose').waitFor()
  page.off('dialog',leaveZoom)
  await page.getByLabel('搜索正文',{exact:true}).fill('搜索定位词');await page.getByLabel('查找下一处').click();await expect(page.locator('.reader-search-message')).toContainText('已找到')
  await page.getByLabel('搜索正文',{exact:true}).fill('不存在的词句');await page.getByLabel('查找下一处').click();await expect(page.locator('.reader-search-message')).toHaveText('未找到匹配内容')
  await home()
  await app.evaluate(({dialog},file)=>{(globalThis as any).__pickOptions=[];dialog.showOpenDialog=(async(_w:any,opts:any)=>{(globalThis as any).__pickOptions.push(opts);return {canceled:false,filePaths:[file]}}) as any},newFile)
  await page.getByRole('button',{name:'导入资料',exact:true}).click();await page.getByRole('button',{name:'选择文件',exact:true}).click();await page.getByLabel('Agent 辅助识别分类、作者和标签').check();await page.getByRole('button',{name:'识别所选',exact:true}).click()
  await expect(page.getByLabel('识别作者 待导入.md')).toHaveValue('作者甲');await page.getByLabel('识别作者 待导入.md').fill('人工修订作者')
  await page.screenshot({path:path.join(output,'agent-import-preview.png')})
  await page.getByRole('button',{name:/导入所选 1 份资料/}).click();await expect(page.getByRole('dialog',{name:'导入资料预览'})).toHaveCount(0)
  const imported=await page.evaluate(()=>window.baoyi.workspace.documents.list().then(rows=>rows.find(i=>i.name==='识别后的论文')));assert.equal(imported?.author,'人工修订作者');assert.equal(imported?.type,'paper')
  await page.getByRole('button',{name:'导入资料',exact:true}).click();await page.getByRole('button',{name:'选择文件',exact:true}).click()
  assert.equal(await app.evaluate(()=>((globalThis as any).__pickOptions.at(-1)).defaultPath),incoming)
  await page.getByLabel('关闭对话框',{exact:true}).click()
  await page.getByRole('button',{name:'批量管理',exact:true}).click();await page.getByLabel('选择资料 识别后的论文',{exact:true}).check()
  await page.getByLabel('选择资料 长篇小说',{exact:true}).check()
  await page.getByRole('button',{name:'删除所选',exact:true}).click();await page.getByLabel('同时删除源文件（移入回收站）').check();await page.getByRole('button',{name:'预览删除范围',exact:true}).click();await expect(page.locator('.batch-preview')).toContainText('回收站')
  await page.getByRole('button',{name:'确认移入回收站',exact:true}).click();await expect(page.getByRole('dialog',{name:'批量删除资料'})).toHaveCount(0)
  await assert.rejects(fs.stat(newFile));assert.equal((await fs.readdir(path.join(dataRoot,'回收站'))).length,2)
  const recycled=await page.evaluate(()=>window.baoyi.workspace.recycle.list());assert.equal(recycled.length,2)
  for(const record of recycled)await page.evaluate(id=>window.baoyi.workspace.recycle.restore(id),record.id)
  assert.ok((await fs.stat(newFile)).isFile());assert.ok((await fs.stat(novelFile)).isFile())
  await page.getByRole('button',{name:'批量管理',exact:true}).click()
  for(const width of [1280,800]){
    await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setSize(w,900),width)
    await expect.poll(()=>page.evaluate(()=>innerWidth)).toBeLessThanOrEqual(width)
    assert.ok(await page.locator('.ws-main').evaluate(e=>e.scrollWidth<=e.clientWidth+2))
    await page.screenshot({path:path.join(output,`library-${width}-dark.png`)})
  }
  assert.deepEqual(errors,[])
  await fs.writeFile(path.join(output,'document-feedback-ui.json'),JSON.stringify({status:'passed',...runtime,profile,errors},null,2))
  console.log('PASS: navigation, inline metadata, batch edit/recycle/restore, selection lifecycle, bookmarks, deletion, novel/PDF search, TOC, zoom, import agent and browse memory. Profile: '+profile)
}catch(e){await page.screenshot({path:path.join(output,'failure.png')});console.error('PAGE ERRORS',errors);throw e}
finally{await app.close();server.close()}
