import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron } from 'playwright'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { scanProjects } from '../electron/kinds/project/scanner.ts'
import { SkillProfiles } from '../electron/workspace/skill-profiles.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

const output=path.resolve('output/workspace-verification');fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-workspace-ui-'))
const textFile=path.join(fixture,'事务与研究方法.md'),pdfFile=path.join(fixture,'原版资料.pdf'),certificateFile=path.join(fixture,'证书.txt')
fs.writeFileSync(textFile,'# 事务与研究方法\n\n事务是一个逻辑单元，所有操作应当一起成功或一起失败。\n\n## 研究实践\n\n将资料中的观点与自己的研究结果对应，留下可回看的来源。\n\n'+Array.from({length:30},(_,i)=>`## 第 ${i+1} 节\n\n这是一段用于验证阅读位置的内容。阅读资料，记录理解，再将摘录用于项目。`).join('\n\n'))
fs.writeFileSync(certificateFile,'验证证书；这里只用于独立测试。')
function pdfFixture(){const stream='BT /F1 18 Tf 50 740 Td (A transaction is one logical unit.) Tj 0 -40 Td (Keep evidence and personal notes together.) Tj ET';const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'];let text='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${o}\nendobj\n`});const xref=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return text}
fs.writeFileSync(pdfFile,pdfFixture())
const projectPath=path.join(fixture,'研究实践');fs.mkdirSync(projectPath);fs.writeFileSync(path.join(projectPath,'README.md'),'# 研究实践\n\n用于验证非代码项目的记录。')
const db=new DatabaseSync(path.join(profile,'baoyi.db'));db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const project=new ProjectLibrary(db).register((await scanProjects(projectPath,'single'))[0]);new SkillProfiles(db).propose({name:'研究写作',summary:'仍需加强论证与验证',metrics:[{key:'practice',label:'实践',unit:'',type:'text'}]});db.close()
const packed=!!process.argv[2],executablePath=path.resolve(process.argv[2]||'node_modules/electron/dist/electron.exe'),env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const args=[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu']
let application=await _electron.launch({executablePath,args,env,timeout:30000}),page=await application.firstWindow()
const errors:string[]=[],checks:string[]=[]
page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>void dialog.accept())
const navigate=async(url:string)=>{await page.evaluate(url=>{location.hash=url},url)}
const pick=async(files:string[])=>application.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files})},files)
try{
  assert.equal(path.resolve(await application.evaluate(({app})=>app.getPath('userData'))),profile)
  await page.waitForFunction(()=>!!window.baoyi?.workspace)
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1400,930))
  await navigate('/document');await page.getByRole('heading',{name:'资料',exact:false}).first().waitFor()
  await pick([textFile,pdfFile,certificateFile]);await page.getByRole('button',{name:'导入',exact:true}).click();await page.getByRole('button',{name:'导入所选 3 份资料',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  await page.waitForFunction(()=>document.querySelectorAll('.document-row').length===3)
  const docs=await page.evaluate(()=>window.baoyi.workspace.documents.list()),text=docs.find(d=>d.path.endsWith('.md'))!,pdf=docs.find(d=>d.format==='pdf')!,certificate=docs.find(d=>d.path.endsWith('.txt'))!
  await page.getByRole('button',{name:/证书 TXT|TXT 证书/}).count().catch(()=>0)
  await page.locator('.document-row').filter({hasText:'证书'}).click();await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('资料类型',{exact:true}).selectOption('certificate');await page.getByLabel('颁发机构',{exact:true}).fill('验证机构');await page.getByRole('button',{name:'保存资料',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  assert.doesNotMatch(await page.locator('.document-row').filter({hasText:'证书'}).innerText(),/未读|已读|在读/)
  await page.getByLabel('搜索资料',{exact:true}).fill('研究');assert.equal(await page.locator('.document-row').count(),1);await page.getByLabel('搜索资料',{exact:true}).fill('');checks.push('document-import-filter-type-fields')
  await page.locator('.document-row').filter({hasText:'事务与研究方法'}).dblclick();await page.locator('.document-prose').waitFor()
  await page.locator('.document-prose [data-paragraph="2"]').evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const selected=window.getSelection()!;selected.removeAllRanges();selected.addRange(range);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))})
  await page.getByRole('button',{name:'想法',exact:true}).click();await page.getByLabel('我的想法',{exact:true}).fill('项目写入也需要原子性。');await page.getByRole('button',{name:'保存标注',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  const ann=(await page.evaluate(id=>window.baoyi.workspace.documents.annotations(id),text.id))[0];assert.match(ann.quote,/逻辑单元/);assert.equal(ann.note,'项目写入也需要原子性。')
  await page.getByRole('button',{name:'书签',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.annotation-card').length===2)
  await page.screenshot({path:path.join(output,'reader-text.png')});checks.push('text-selection-annotation-bookmark')
  await navigate('/project/'+project.id);await page.getByRole('tab',{name:'项目日志',exact:true}).waitFor();await page.getByRole('button',{name:'记一笔',exact:true}).first().click();await page.getByLabel('一句话记录',{exact:true}).fill('整理研究方法');await page.getByLabel('经过与结果',{exact:true}).fill('采用资料中的事务概念，补充研究方案。');await page.getByLabel('标记为重要节点',{exact:true}).check();await page.getByRole('button',{name:'保存记录',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  await page.getByLabel('编辑当前情况与下一步',{exact:true}).click();await page.getByLabel('当前情况',{exact:true}).fill('已整理研究依据');await page.getByLabel('下一步',{exact:true}).fill('完成方法章节初稿');await page.getByRole('button',{name:'保存进展',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  await page.getByLabel('添加记录中的资料',{exact:true}).click();await page.getByLabel('选择关联资源',{exact:true}).selectOption(text.id);await page.getByLabel('选择关联摘录',{exact:true}).selectOption(ann.id);await page.getByRole('button',{name:'保存关联',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  await page.getByRole('button',{name:'周',exact:true}).click();assert.match(await page.locator('.timeline-group-title').innerText(),/1 次记录/)
  await page.getByRole('button',{name:'检查变化',exact:true}).click();await page.waitForFunction(()=>document.body.innerText.includes('已建立目录基线'))
  fs.writeFileSync(path.join(projectPath,'研究方案.md'),'# 新增研究方案')
  await page.getByRole('button',{name:'事实草稿',exact:true}).click();await page.getByRole('button',{name:'确认发布',exact:true}).waitFor();await page.getByRole('button',{name:'确认发布',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.timeline-drafts').length===0)
  await page.screenshot({path:path.join(output,'project-timeline.png')});checks.push('event-write-context-attachment-week-directory-draft-publish')
  await page.locator('.timeline-event .ws-link-main').filter({hasText:'事务与研究方法'}).first().click();await page.locator('.document-prose').waitFor();assert.match(page.url(),/page=2/);await page.getByLabel('返回来源',{exact:true}).click();await page.locator('.timeline').waitFor();checks.push('project-excerpt-return-to-source-and-back')
  await navigate('/personal?section=skill');await page.getByRole('button',{name:'确认录入',exact:true}).click();await page.locator('.skill-card').filter({hasText:'研究写作'}).click();await page.getByLabel('添加相关项目与凭证',{exact:true}).click();await page.getByLabel('选择关联资源',{exact:true}).selectOption(project.id);await page.getByRole('button',{name:'保存关联',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.screenshot({path:path.join(output,'personal-skill.png')})
  await navigate('/personal?section=asset');await page.getByRole('button',{name:'添加背包',exact:true}).first().click();await page.getByLabel('名称',{exact:true}).fill('研究域名');await page.getByLabel('费用',{exact:true}).fill('88');await page.getByLabel('到期日期',{exact:true}).fill('2026-11-01');await page.getByRole('button',{name:'保存个人记录',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  await navigate('/personal?section=experience');await page.getByRole('button',{name:'添加奖项与经历',exact:true}).first().click();await page.getByLabel('名称',{exact:true}).fill('研究训练证书');await page.getByRole('button',{name:'保存个人记录',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByRole('button',{name:'凭证与相关项目',exact:true}).click();await page.getByLabel('添加凭证与相关项目',{exact:true}).click();await page.getByLabel('选择关联资源',{exact:true}).selectOption(certificate.id);await page.getByRole('button',{name:'保存关联',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  await navigate('/personal?section=state');await page.getByLabel('快捷状态名称',{exact:true}).fill('睡眠');await page.getByLabel('快捷状态单位',{exact:true}).fill('小时');await page.getByLabel('快捷状态数值',{exact:true}).fill('7.5');await page.locator('.state-capture').getByRole('button',{name:'记录状态',exact:true}).click();await page.locator('.metric-trend circle').waitFor();checks.push('personal-skill-asset-experience-metric-measurement')
  await navigate('/personal?section=todo');await page.getByLabel('快速添加待办',{exact:true}).fill('检查研究引用');await page.getByLabel('快速添加待办',{exact:true}).press('Enter');await page.getByLabel('完成 检查研究引用',{exact:true}).check();assert.match(await page.locator('.personal-todos').innerText(),/完成方法章节初稿/);checks.push('todo-manual-project-next-assets')
  await navigate('/document/'+pdf.id);await page.locator('.textLayer span').first().waitFor();assert.match(await page.locator('[data-pdf-page="1"] .textLayer').innerText(),/logical unit/)
  const span=page.locator('.textLayer span').first(),box=await span.boundingBox();assert.ok(box);await page.mouse.move(box!.x+2,box!.y+box!.height/2);await page.mouse.down();await page.mouse.move(box!.x+box!.width-2,box!.y+box!.height/2,{steps:12});await page.mouse.up();await page.getByRole('button',{name:'高亮',exact:true}).click();await page.locator('.annotation-highlight').first().waitFor();await page.getByLabel('下一页',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('.reader-controls')?.textContent?.includes('2 / 2'));await page.screenshot({path:path.join(output,'reader-pdf.png')});checks.push('pdf-native-page-text-selection-next-page')
  await navigate('/personal');await page.locator('.personal-overview').waitFor();await page.screenshot({path:path.join(output,'personal-overview.png')})
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,680));await navigate('/document');await page.locator('.document-home').waitFor();await page.screenshot({path:path.join(output,'document-960.png')});assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth>el.clientWidth),false)
  await page.evaluate(()=>{document.documentElement.setAttribute('data-theme','dark')});await navigate('/personal');await page.locator('.personal-overview').waitFor();await page.screenshot({path:path.join(output,'personal-dark-960.png')});checks.push('wide-narrow-light-dark')
  await application.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},path.join(output,'test-library-backup.json'))
  const backupFile=await page.evaluate(()=>window.baoyi.data.exportJson());assert.ok(backupFile);const backup=JSON.parse(fs.readFileSync(backupFile!,'utf8'));assert.ok(backup.tables.personal_records.length>=6);assert.equal(backup.tables.document_meta.length,3);checks.push('export-backup-includes-new-modules')
  await application.close();application=await _electron.launch({executablePath,args,env,timeout:30000});page=await application.firstWindow();await page.waitForFunction(()=>!!window.baoyi?.workspace)
  assert.equal((await page.evaluate(()=>window.baoyi.workspace.documents.list())).length,3);assert.equal((await page.evaluate(id=>window.baoyi.workspace.documents.get(id),pdf.id))!.position.page,2);assert.equal((await page.evaluate(()=>window.baoyi.workspace.personal.list('skill')))[0].body,'仍需加强论证与验证');checks.push('restart-persists-reading-personal-events')
  await page.evaluate(()=>window.baoyi.data.reset('all'))
  assert.equal((await page.evaluate(()=>window.baoyi.workspace.personal.list())).length,0,'factory reset clears personal records')
  assert.equal(fs.existsSync(textFile),true);assert.equal(fs.existsSync(pdfFile),true);checks.push('factory-reset-keeps-source-files')
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,packed?'packaged-report.json':'report.json'),JSON.stringify({profile,fixture,executablePath,checks,errors},null,2));console.log('PASS '+checks.join(', '))
}catch(e){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error('UI errors:',errors);throw e}finally{await application.close()}
