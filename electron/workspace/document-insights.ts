import {randomUUID} from 'node:crypto'
import type {SqlDb} from '../services/schema.ts'
import type {DocumentCoverage,DocumentExtraction,DocumentInsight,DocumentInsightContent} from '../../src/types/document-insight.ts'
import {DocumentLibrary} from './documents.ts'
import * as v from './validation.ts'

export function validateInsightContent(input:unknown):DocumentInsightContent{
  const value=v.object(input)
  v.keys(value,['coreValue','keyConclusions','suggestedCategoryId','suggestedTags','evidence','limitations'])
  const coreValue=v.text(value.coreValue,'核心价值',120).trim();if(coreValue.length<20)throw new Error('核心价值需要 20–120 字符')
  if(!Array.isArray(value.keyConclusions)||value.keyConclusions.length!==3)throw new Error('结论需要三个槽位；不足时标记证据不足')
  const keyConclusions=value.keyConclusions.map((item:unknown)=>{
    const row=v.object(item);v.keys(row,['text','status','evidenceIds'])
    if(!['supported','insufficient'].includes(row.status as string))throw new Error('结论证据状态无效')
    const status=row.status as 'supported'|'insufficient',text=row.text===null?null:v.text(row.text,'结论',180).trim(),evidenceIds=v.strings(row.evidenceIds,8)
    if(status==='supported'&&(!text||!evidenceIds.length))throw new Error('有依据的结论必须附带引文')
    if(status==='insufficient'&&(text!==null||evidenceIds.length))throw new Error('证据不足的槽位应为空，不应编造结论')
    return {text,status,evidenceIds}
  })
  if(!Array.isArray(value.evidence)||value.evidence.length>24)throw new Error('证据最多 24 条')
  const evidence=value.evidence.map((item:unknown)=>{
    const row=v.object(item);v.keys(row,['id','sourceRef','quote','page','start','startLine'])
    const result={id:v.text(row.id,'证据编号',100),sourceRef:v.text(row.sourceRef,'来源片段',100),quote:v.text(row.quote,'引文',120).trim(),start:v.number(row.start??0,'文字位置',0,1e9),...(row.page!==undefined?{page:v.number(row.page,'页码',1,100000)}:{}),...(row.startLine!==undefined?{startLine:v.number(row.startLine,'行号',1,1e9)}:{})}
    if(!result.id||!result.sourceRef||!result.quote)throw new Error('证据编号、来源和引文不可为空')
    return result
  })
  const ids=new Set(evidence.map(item=>item.id));if(ids.size!==evidence.length)throw new Error('证据编号不能重复')
  if(keyConclusions.some(item=>item.evidenceIds.some(id=>!ids.has(id))))throw new Error('结论引用了不存在的证据')
  const suggestedTags=v.strings(value.suggestedTags,8);if(suggestedTags.some(tag=>tag.length>40))throw new Error('每个标签最多 40 字符')
  const limitations=v.strings(value.limitations,12);if(limitations.some(text=>text.length>300))throw new Error('限制说明过长')
  return {coreValue,keyConclusions,suggestedCategoryId:value.suggestedCategoryId===null?null:v.text(value.suggestedCategoryId,'分类',128),suggestedTags,evidence,limitations}
}
export function validateCoverage(input:unknown):DocumentCoverage{
  const value=v.object(input);v.keys(value,['extractorVersion','strategy','totalPages','pages','emptyPages','skippedPages','truncatedPages','characters','complete','reasons'])
  if(!['all','head-tail','text','page','range'].includes(value.strategy as string)||typeof value.complete!=='boolean')throw new Error('读取覆盖信息无效')
  const totalPages=value.totalPages===null?null:v.number(value.totalPages,'总页数',1,100000)
  const pages=(key:string)=>{const items=value[key];if(!Array.isArray(items)||items.length>100000||items.some(page=>!Number.isSafeInteger(page)||page<1||page>(totalPages||0)))throw new Error('覆盖页码无效');return [...new Set(items)] as number[]}
  const result={extractorVersion:v.text(value.extractorVersion,'提取版本',40),strategy:value.strategy as DocumentCoverage['strategy'],totalPages,pages:pages('pages'),emptyPages:pages('emptyPages'),skippedPages:pages('skippedPages'),truncatedPages:pages('truncatedPages'),characters:v.number(value.characters,'读取字符数',0,48000),complete:value.complete,reasons:v.strings(value.reasons,20)}
  if(result.emptyPages.some(page=>!result.pages.includes(page))||result.truncatedPages.some(page=>!result.pages.includes(page))||result.skippedPages.some(page=>result.pages.includes(page)))throw new Error('读取页码互相矛盾')
  if(result.complete&&(result.emptyPages.length||result.skippedPages.length||result.truncatedPages.length||totalPages!==null&&result.pages.length!==totalPages))throw new Error('局部读取不能标为完整')
  return result
}
export function verifyInsightEvidence(input:unknown,extraction:DocumentExtraction,allowInsufficient=false){
  const content=validateInsightContent(input)
  content.evidence=content.evidence.map(item=>{
    const part=extraction.fragments.find(part=>part.id===item.sourceRef&&part.text.includes(item.quote)),offset=part?.text.indexOf(item.quote)??-1
    if(!part||offset<0)throw new Error('证据引文不在本次已读取的片段中')
    return {id:item.id,sourceRef:part.id,quote:item.quote,start:part.start+offset,...(part.page?{page:part.page}:{}),...(part.startLine?{startLine:part.startLine+part.text.slice(0,offset).split('\n').length-1}:{})}
  })
  if(!allowInsufficient&&!content.keyConclusions.some(item=>item.status==='supported'))throw new Error('正文不足以提炼有依据的结论；原精读笔记保留')
  return content
}
export function insightFromRow(row:Record<string,any>):DocumentInsight{
  return {id:row.id,documentId:row.resource_id,revision:row.revision,active:!!row.active,coreValue:row.core_value,keyConclusions:JSON.parse(row.conclusions),suggestedCategoryId:row.suggested_category,suggestedTags:JSON.parse(row.suggested_tags),evidence:JSON.parse(row.evidence),limitations:JSON.parse(row.limitations),model:row.model,promptVersion:row.prompt_version,sourceFingerprint:row.source_fingerprint,sourceFileId:row.source_file_id,coverage:JSON.parse(row.coverage),sessionId:row.session_id,generatedAt:row.generated_at,updatedAt:row.updated_at,userEdited:!!row.user_edited}
}
export class DocumentInsights {
  private db:SqlDb
  constructor(db:SqlDb){this.db=db}
  private require(id:string){new DocumentLibrary(this.db).require(id)}
  active(id:string){this.require(id);const row=this.db.prepare('SELECT * FROM document_insights WHERE resource_id=? AND active=1').get(id) as any;return row?insightFromRow(row):null}
  history(id:string){this.require(id);return (this.db.prepare('SELECT * FROM document_insights WHERE resource_id=? ORDER BY revision DESC').all(id) as any[]).map(insightFromRow)}
  save(input:{documentId:string;expectedRevision:number;requestId:string;content:DocumentInsightContent;extraction:DocumentExtraction;sourceFileId:string;model:string;sessionId:string;userEdited?:boolean}){
    this.require(input.documentId)
    const duplicate=this.db.prepare('SELECT * FROM document_insights WHERE resource_id=? AND request_id=?').get(input.documentId,input.requestId) as any
    if(duplicate)return insightFromRow(duplicate)
    const content=input.userEdited?validateInsightContent(input.content):verifyInsightEvidence(input.content,input.extraction)
    const coverage=validateCoverage(input.extraction.coverage)
    if(!/^[a-f0-9]{64}$/.test(input.extraction.fingerprint))throw new Error('来源指纹无效')
    if(content.suggestedCategoryId&&!this.db.prepare('SELECT 1 FROM document_categories WHERE id=?').get(content.suggestedCategoryId))throw new Error('建议分类不存在，请重新选择')
    this.db.exec('SAVEPOINT document_insight_save')
    try{
      const previous=this.active(input.documentId)
      if((previous?.revision||0)!==input.expectedRevision)throw new Error('精读笔记已变化，请重新查看后保存；当前编辑保留')
      const revision=((this.db.prepare('SELECT max(revision) AS value FROM document_insights WHERE resource_id=?').get(input.documentId) as any).value||0)+1
      const active=!!input.userEdited||!previous?.userEdited,now=Date.now(),id=randomUUID()
      if(active)this.db.prepare('UPDATE document_insights SET active=0 WHERE resource_id=?').run(input.documentId)
      this.db.prepare('INSERT INTO document_insights VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,input.documentId,revision,Number(active),content.coreValue,JSON.stringify(content.keyConclusions),content.suggestedCategoryId,JSON.stringify(content.suggestedTags),JSON.stringify(content.evidence),JSON.stringify(content.limitations),v.text(input.model,'模型',300),'v1',input.extraction.fingerprint,v.text(input.sourceFileId,'来源副本',128),JSON.stringify(coverage),v.text(input.sessionId,'会话',128),v.text(input.requestId,'请求',128),now,now,Number(!!input.userEdited))
      this.db.prepare('DELETE FROM document_insights WHERE resource_id=? AND user_edited=0 AND active=0 AND id NOT IN (SELECT id FROM document_insights WHERE resource_id=? AND user_edited=0 ORDER BY revision DESC LIMIT 5)').run(input.documentId,input.documentId)
      this.db.exec('RELEASE document_insight_save')
      return insightFromRow(this.db.prepare('SELECT * FROM document_insights WHERE id=?').get(id) as any)
    }catch(error){this.db.exec('ROLLBACK TO document_insight_save');this.db.exec('RELEASE document_insight_save');throw error}
  }
  edit(id:string,expectedRevision:number,content:DocumentInsightContent){
    const previous=this.active(id);if(!previous)throw new Error('尚无可编辑的精读笔记')
    return this.save({documentId:id,expectedRevision,requestId:randomUUID(),content:{...content,evidence:previous.evidence},extraction:{fingerprint:previous.sourceFingerprint,size:0,mtimeMs:0,coverage:previous.coverage,fragments:[]},sourceFileId:previous.sourceFileId,model:previous.model,sessionId:previous.sessionId,userEdited:true})
  }
  activate(id:string,versionId:string,expectedRevision:number){
    if((this.active(id)?.revision||0)!==expectedRevision)throw new Error('当前版本已变化，请刷新后选择')
    if(!this.db.prepare('SELECT 1 FROM document_insights WHERE id=? AND resource_id=?').get(versionId,id))throw new Error('精读版本不存在')
    this.db.exec('SAVEPOINT document_insight_activate')
    try{this.db.prepare('UPDATE document_insights SET active=0 WHERE resource_id=?').run(id);this.db.prepare('UPDATE document_insights SET active=1 WHERE id=?').run(versionId);this.db.exec('RELEASE document_insight_activate')}
    catch(error){this.db.exec('ROLLBACK TO document_insight_activate');this.db.exec('RELEASE document_insight_activate');throw error}
    return this.active(id)!
  }
}
