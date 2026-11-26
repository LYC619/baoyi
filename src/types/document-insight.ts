export interface DocumentFragment {
  id:string
  text:string
  page?:number
  start:number
  startLine?:number
}
export interface DocumentCoverage {
  extractorVersion:string
  strategy:'all'|'head-tail'|'text'|'page'|'range'
  totalPages:number|null
  pages:number[]
  emptyPages:number[]
  skippedPages:number[]
  truncatedPages:number[]
  characters:number
  complete:boolean
  reasons:string[]
}
export interface DocumentExtraction {
  fingerprint:string
  size:number
  mtimeMs:number
  fragments:DocumentFragment[]
  coverage:DocumentCoverage
}
export interface DocumentInsightContent {
  coreValue:string
  keyConclusions:Array<{text:string|null;status:'supported'|'insufficient';evidenceIds:string[]}>
  suggestedCategoryId:string|null
  suggestedTags:string[]
  evidence:Array<{id:string;sourceRef:string;quote:string;page?:number;start:number;startLine?:number}>
  limitations:string[]
}
export interface DocumentInsight extends DocumentInsightContent {
  id:string;documentId:string;revision:number;active:boolean;userEdited:boolean
  sourceFingerprint:string;sourceFileId:string;coverage:DocumentCoverage
  model:string;promptVersion:string;sessionId:string;generatedAt:number;updatedAt:number
}
export interface DocumentInsightRun {
  id:string;documentId:string;name:string;status:'queued'|'running'|'ready'|'failed'|'cancelled'|'interrupted'
  attempt:number;phase:string;sessionId:string;createdAt:number;updatedAt:number;error:string
}
export interface DocumentInsightPreview {
  token:string;model:string;provider:string;configured:boolean;maxChars:number
  range?:DocumentInsightRange
  items:Array<{id:string;name:string;format:string;available:boolean;userEdited:boolean}>
}
export interface DocumentInsightDetail {
  active:DocumentInsight|null;history:DocumentInsight[];run:DocumentInsightRun|null
  sourceStatus:'verified'|'stale'|'unchecked'|'offline';sourceMessage:string
}
export interface DocumentInsightRange {fromPage?:number;toPage?:number;start?:number}
export interface DocumentInsightCleanup {token:string;generated:number;edited:number}
export interface DocumentInsightApi {
  onChanged(callback:()=>void):()=>void
  preview(ids:string[],range?:DocumentInsightRange):Promise<DocumentInsightPreview>
  cleanupPreview():Promise<DocumentInsightCleanup>
  cleanup(token:string):Promise<number>
  clearCache():Promise<void>
  start(token:string,force?:boolean):Promise<DocumentInsightRun[]>
  list():Promise<DocumentInsightRun[]>
  detail(id:string):Promise<DocumentInsightDetail>
  cancel(id:string):Promise<void>
  edit(id:string,revision:number,content:DocumentInsightContent):Promise<DocumentInsight>
  activate(id:string,versionId:string,revision:number):Promise<DocumentInsight>
  adopt(id:string,revision:number):Promise<{actionId:string}>
}
