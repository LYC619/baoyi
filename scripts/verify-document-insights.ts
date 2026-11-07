import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {DocumentInsights} from '../electron/workspace/document-insights.ts'
import {buildLibraryBackup,restoreLibraryBackup} from '../electron/services/library-backup.ts'
import {extractDocument} from '../electron/workspace/document-extraction.ts'
import type {DocumentInsightContent} from '../src/types/document-insight.ts'
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-insights-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
  t.after(async()=>{db.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'baoyi-insights-')));await fs.rm(root,{recursive:true,force:true})})
  const file=path.join(root,'source.md');await fs.writeFile(file,'# 合成资料\n精读帮助读者快速了解资料，同时保留原文证据。\n不得凭空编造结论。')
  const item=await new DocumentLibrary(db).register(file),extraction=await extractDocument({file,format:'md',assets:''}),service=new DocumentInsights(db)
  const content:DocumentInsightContent={coreValue:'本资料说明如何在快速理解资料的同时保留可核对的原文证据。',keyConclusions:[{text:'精读应当保留原文证据',status:'supported',evidenceIds:['e1']},{text:null,status:'insufficient',evidenceIds:[]},{text:null,status:'insufficient',evidenceIds:[]}],suggestedCategoryId:'paper',suggestedTags:['阅读'],evidence:[{id:'e1',sourceRef:extraction.fragments[0].id,quote:'同时保留原文证据',start:0}],limitations:[]}
  const input={documentId:item.id,expectedRevision:0,requestId:randomUUID(),content,extraction,sourceFileId:'primary',model:'fixture',sessionId:'fixture'}
  return {db,item,service,input}
}
test('引用必须出自实际快照；主机计算位置，不接受模型编造引用',async t=>{
  const {service,input}=await fixture(t),bad=structuredClone(input);bad.content.evidence[0].quote='不存在的结果'
  assert.throws(()=>service.save(bad),/引文/);assert.equal(service.active(input.documentId),null)
  const result=service.save(input);assert.equal(result.evidence[0].startLine,2);assert.ok(result.evidence[0].start>0)
  assert.equal(service.save(input).id,result.id,'相同请求只保存一次')
  assert.throws(()=>service.save({...input,requestId:randomUUID()}),/变化/)
})
test('人工修订保留为当前版本；新模型结果只加入历史，显式选择才切换',async t=>{
  const {service,input}=await fixture(t),first=service.save(input)
  const edited=service.edit(input.documentId,first.revision,{...input.content,coreValue:'这是用户亲自修订的核心价值，重新生成时必须保留这段内容。'})
  assert.equal(edited.userEdited,true)
  const generated=service.save({...input,requestId:randomUUID(),expectedRevision:edited.revision})
  assert.equal(generated.active,false);assert.equal(service.active(input.documentId)!.id,edited.id)
  const adopted=service.activate(input.documentId,generated.id,edited.revision);assert.equal(adopted.id,generated.id)
  assert.throws(()=>service.activate(input.documentId,first.id,edited.revision),/变化/)
})
test('仅清理旧自动生成版本，人工修订和当前版本始终保留',async t=>{
  const {service,input}=await fixture(t),first=service.save(input),edited=service.edit(input.documentId,first.revision,input.content)
  for(let i=0;i<8;i++)service.save({...input,requestId:randomUUID(),expectedRevision:edited.revision})
  assert.equal(service.history(input.documentId).length,6);assert.equal(service.active(input.documentId)!.id,edited.id)
})
test('schema28旧库升级；精读JSON完整来回、旧备份补空、不导出运行队列；坏证据回滚',async t=>{
  const {db,service,input}=await fixture(t)
  db.exec("DROP TABLE document_insights; DROP TABLE document_insight_runs; UPDATE settings SET value='28' WHERE key='_schema'");initSchema(db,KINDS)
  service.save(input);const backup=buildLibraryBackup(db),before=service.history(input.documentId)
  assert.equal('document_insight_runs' in backup.tables,false)
  restoreLibraryBackup(db,backup);assert.deepEqual(service.history(input.documentId),before)
  const bad=structuredClone(backup);bad.tables.document_insights[0].conclusions='[]';assert.throws(()=>restoreLibraryBackup(db,bad),/结论/)
  assert.deepEqual(service.history(input.documentId),before)
  const old=structuredClone(backup) as any;old.schema_version=28;delete old.tables.document_insights;restoreLibraryBackup(db,old)
  assert.equal(service.active(input.documentId),null)
})
