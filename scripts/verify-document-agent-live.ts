/** Real-model document acceptance. User DB is read-only; all documents and writes are fixtures. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {createWorkspaceAgent} from '../electron/workspace/agent.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {textPdf} from './helpers/pdf-fixture.ts'
import {makeTextAnchor} from '../src/utils/document-anchor.ts'
import {workspaceSources} from '../src/utils/workspace-sources.ts'
import type {AIConfig} from '../src/types/index.ts'
const source=new DatabaseSync(process.env.BAOYI_LIVE_AI_DB||path.join(process.env.APPDATA||'','抱一','baoyi.db'),{readOnly:true})
let config:AIConfig
try {config=JSON.parse(String(source.prepare("SELECT value FROM settings WHERE key='ai'").get()?.value||'{}'))} finally {source.close()}
assert.ok(config.enabled&&config.api_key&&config.api_url&&config.model,'现有 AI 配置不完整')
const output=path.resolve('output/agent-revision'),root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-document-live-'));await fs.mkdir(output,{recursive:true})
const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
let label='',sessionId='',timer:ReturnType<typeof setTimeout>|undefined
const manager=createWorkspaceAgent({db,config:()=>config,changed:session=>{const next=session.messages.at(-1)?.events.at(-1)?.label||session.status;if(next!==label){label=next;console.log('Agent:',label)}}})
try {
  const docs=new DocumentLibrary(db),custom=docs.saveCategory({name:'设备巡检规程',description:'用于机房设备的检查步骤、温度阈值与故障处置；不是学术论文。',behavior:'reading',order:10})
  await fs.writeFile(path.join(root,'fixture-a.md'),'# 分布式缓存研究\n作者：测试研究组\n摘要：本研究以三组隔离实验比较缓存策略。方法：固定请求集，记录命中率。结果：实验组命中率为 83%，对照组为 72%。结论仅适用于样本条件。\n这是虚构的学术论文验收样本。')
  await fs.writeFile(path.join(root,'fixture-b.pdf'),textPdf('Rack inspection protocol. Check temperature. Alarm threshold: 37 C.'))
  await fs.writeFile(path.join(root,'fixture-c.md'),'# 训练手册\n作者：测试教练\n这是一份模拟课程完成凭证，用户明确把它放在证书分类。仅用于验收。')
  const a=await docs.register(path.join(root,'fixture-a.md')),b=await docs.register(path.join(root,'fixture-b.pdf')),c=await docs.register(path.join(root,'fixture-c.md'),'certificate')
  const session=manager.create('document',{documentIds:[a.id,b.id,c.id]});sessionId=session.id
  console.log('Live model:',config.model)
  timer=setTimeout(()=>manager.cancel(sessionId),180000)
  const first=await manager.send(sessionId,'请实际读取本会话三份资料的正文，按内容和已有分类的说明分类，并补全有依据的作者信息。不要只凭文件名判断。用户明确指定的分类须保留。请直接保存可自动修改的字段，并说明已读范围和来源。文件都是不含个人信息的虚构验收样本。')
  clearTimeout(timer);assert.equal(first.status,'idle',first.error)
  assert.equal(docs.require(a.id).type,'paper');assert.equal(docs.require(b.id).type,custom.id);assert.equal(docs.require(c.id).type,'certificate');assert.equal(docs.require(c.id).typeLocked,true)
  const sources=first.messages.flatMap(m=>m.events).filter(e=>e.label==='read_document_text 结果'&&!e.error).map(e=>JSON.parse(e.detail||'{}'))
  assert.ok([a,b,c].every(d=>sources.some(s=>s.source?.documentId===d.id)),'模型必须实际读取每份正文')
  assert.ok(sources.some(s=>s.source?.documentId===b.id&&s.source.page===1&&s.text.includes('37 C')))
  timer=setTimeout(()=>manager.cancel(sessionId),180000)
  const second=await manager.send(sessionId,'刚才 PDF 的告警温度阈值是多少？请根据你读到的原句回答，并注明页码。不要改动任何元数据。')
  clearTimeout(timer);assert.equal(second.status,'idle',second.error);assert.match(second.messages.at(-1)!.text,/37/);assert.match(second.messages.at(-1)!.text,/(第\s*1\s*页|页码[^\d]*1|page\s*1|p\.?\s*1)/i)
  const pdfText='Rack inspection protocol. Check temperature. Alarm threshold: 37 C.',quote='Alarm threshold: 37 C.',anchor=makeTextAnchor(pdfText,pdfText.indexOf(quote),pdfText.length,'pdf')
  const selected=manager.create('document',{documentIds:[b.id],selection:{documentId:b.id,quote,location:{page:1,offset:0,anchor}}})
  timer=setTimeout(()=>manager.cancel(selected.id),180000)
  const explanation=await manager.send(selected.id,'这段选文的含义是什么？请用中文解释，只依据现有选文，不编造实际操作结果。')
  clearTimeout(timer);assert.equal(explanation.status,'idle',explanation.error);assert.match(explanation.messages.at(-1)!.text,/37/)
  const cited=workspaceSources(explanation,explanation.messages.at(-1)!.id);assert.equal(cited[0].quote,quote);assert.deepEqual(cited[0].location.anchor,anchor)
  const report={status:'passed',model:config.model,at:new Date().toISOString(),checks:['mixed-markdown-pdf-content-classification','custom-category-description','explicit-category-preserved','followup-real-source-page','selection-explanation-preserves-exact-source-anchor'],documents:docs.list(),changes:manager.changes(sessionId),session:manager.get(sessionId),selectionSession:explanation}
  await fs.writeFile(path.join(output,'document-agent-live.json'),JSON.stringify(report,null,2));console.log('PASS real document classification, explicit-category protection, and sourced followup')
}catch(error){const message=String(error).replaceAll(config.api_key,'[redacted]');await fs.writeFile(path.join(output,'document-agent-live.json'),JSON.stringify({status:'failed',model:config.model,error:message,session:manager.get(sessionId)},null,2));console.error(message);process.exitCode=1}
finally {clearTimeout(timer);manager.dispose();db.close();assert.ok(root.startsWith(os.tmpdir()+path.sep));await fs.rm(root,{recursive:true,force:true})}
