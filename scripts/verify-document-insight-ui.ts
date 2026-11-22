import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {DocumentInsights} from '../electron/workspace/document-insights.ts'
import {extractDocument} from '../electron/workspace/document-extraction.ts'
import type {DocumentInsightContent} from '../src/types/document-insight.ts'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {expect} from 'playwright/test'
const {_electron}=loadPlaywright()
const packed=process.argv[2],output=path.resolve(process.argv[3]||'output/document-insight-history/native-ui')
fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),fixture=fs.mkdtempSync(path.join(output,'fixtures-'))
const source=path.join(fixture,'合成精读资料.txt'),importFile=path.join(fixture,'导入不自动精读.txt')
fs.writeFileSync(source,'第一章\n精读帮助读者快速了解资料，同时保留原文证据。\n不得凭空编造结论。')
fs.writeFileSync(importFile,'第一章\n只导入本地资料，不自动调用模型。')
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value]of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const item=await new DocumentLibrary(db).register(source,'book'),extraction=await extractDocument({file:source,format:'txt',assets:''}),notes=new DocumentInsights(db)
const content:DocumentInsightContent={coreValue:'本资料说明如何在快速理解资料的同时保留可核对的原文证据。',keyConclusions:[{text:'精读应当保留原文证据',status:'supported',evidenceIds:['e1']},{text:null,status:'insufficient',evidenceIds:[]},{text:null,status:'insufficient',evidenceIds:[]}],suggestedCategoryId:'paper',suggestedTags:['合成精读'],evidence:[{id:'e1',sourceRef:extraction.fragments[0].id,quote:'同时保留原文证据',start:0}],limitations:[]}
notes.save({documentId:item.id,expectedRevision:0,requestId:randomUUID(),content,extraction,sourceFileId:'primary',model:'fixture',sessionId:''});db.close()
let app!:Awaited<ReturnType<typeof _electron.launch>>,page:Awaited<ReturnType<typeof app.firstWindow>>
const checks:string[]=[],errors:string[]=[]
async function open(){app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile);await page.waitForFunction(()=>!!window.baoyi?.archive?.insights)}
async function check(name:string,action:()=>Promise<void>){await action();checks.push(name);console.log('PASS '+name)}
async function route(value:string){await page.evaluate(value=>{location.hash=value},value)}
const detail=()=>page.evaluate(id=>window.baoyi.archive.insights.detail(id),item.id)
async function select(){await route('/document');await page.locator('.document-row').filter({hasText:'合成精读资料'}).first().click();await page.getByRole('region',{name:'资料精读速览'}).waitFor()}
await open()
try{
  await check('导入 TXT 不创建精读任务，旧精读卡片仍能打开',async()=>{
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},importFile)
    await route('/document');await page.getByLabel('导入资料',{exact:true}).click();await page.getByRole('button',{name:'选择文件',exact:true}).click()
    await page.getByRole('dialog',{name:'导入资料预览'}).waitFor();await page.getByRole('button',{name:/^导入所选/}).click()
    await expect(page.getByRole('dialog',{name:'导入资料预览'})).toHaveCount(0)
    assert.equal((await page.evaluate(()=>window.baoyi.workspace.documents.list())).length,2)
    assert.equal((await page.evaluate(()=>window.baoyi.archive.insights.list())).length,0)
    await select();await expect(page.locator('.insight-value')).toHaveText(content.coreValue)
    await expect(page.getByRole('button',{name:'在归档助理中精读',exact:true})).toBeVisible()
  })
  await check('人工修订、采用分类标签和撤销继续可用',async()=>{
    const panel=page.getByRole('region',{name:'资料精读速览'})
    await panel.getByRole('button',{name:'编辑并保存',exact:true}).click();await page.getByLabel('编辑核心价值').fill('这是用户保留的人工修订内容，需要在清理生成稿之后继续保持当前版本。');await page.getByRole('button',{name:'保存修订',exact:true}).click()
    await expect.poll(async()=>(await detail()).active?.userEdited).toBe(true)
    await panel.getByRole('button',{name:'采用分类与标签',exact:true}).click();await panel.getByRole('button',{name:'撤销采用',exact:true}).waitFor()
    const doc=await page.evaluate(id=>window.baoyi.workspace.documents.get(id),item.id);assert.equal(doc!.type,'paper');assert.ok(doc!.tags.includes('合成精读'));assert.equal(doc!.readState,'unread')
    await panel.getByRole('button',{name:'撤销采用',exact:true}).click();await expect.poll(async()=>(await page.evaluate(id=>window.baoyi.workspace.documents.get(id),item.id))!.type).toBe('book')
    await expect(panel.getByText('版本记录（2）',{exact:true})).toBeVisible()
  })
  await check('精读证据能跳到原文，重启后版本与人工修订保留',async()=>{
    const panel=page.getByRole('region',{name:'资料精读速览'});await panel.getByText('原文证据与覆盖范围',{exact:true}).click();await panel.locator('.insight-quote').first().click()
    await page.waitForFunction(()=>location.hash.includes('insight='));await expect(page.getByText('精读帮助读者快速了解资料，同时保留原文证据。',{exact:false}).first()).toBeVisible()
    await app.close();await open();await select();assert.equal((await detail()).active?.userEdited,true);assert.equal((await detail()).history.length,2)
  })
  await check('宽窄窗口和暗色下精读历史无横向溢出',async()=>{
    for(const width of [800,1360]){
      await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows()[0];win.setMinimumSize(640,600);win.setContentSize(width,900)},width)
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true)
    }
    await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'))
    await page.screenshot({path:path.join(output,'insight-dark.png')})
  })
  await check('清理生成稿保留人工修订',async()=>{
    await route('/settings?module=document&tab=scan');await page.locator('.insight-settings>summary').click();await page.getByText('精读数据维护',{exact:true}).click()
    await page.getByRole('button',{name:'预览生成稿清理',exact:true}).click();await page.getByRole('button',{name:'确认删除生成稿',exact:true}).click()
    await expect.poll(async()=>(await detail()).history.length).toBe(1);assert.equal((await detail()).active?.userEdited,true)
  })
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({checks,errors,profile,packaged:!!packed},null,2))
}finally{await app.close()}
