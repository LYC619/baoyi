import type {ComicIngestJob} from '../../../src/types/comic-ingest.ts'
import {comicCatalog,comicName} from './comic-source-rules.ts'

export function comicJob(input:unknown):ComicIngestJob{
  if(!input||typeof input!=='object')throw new Error('漫画任务无效')
  const j=input as ComicIngestJob,catalog=comicCatalog(j.catalog)
  delete catalog.cover // Preview thumbnails are not task metadata or backup content.
  if(j.version!==2||j.provider!=='jm'||j.workId!==catalog.workId||!Array.isArray(j.selectedChapters)||!j.selectedChapters.length||new Set(j.selectedChapters).size!==j.selectedChapters.length||j.selectedChapters.some(id=>!catalog.chapters.some(c=>c.id===id)))throw new Error('漫画任务章节无效')
  for(const key of ['id','workId','name','root','directory','operationId','requestId','current','error','errorCode','resourceId','adapterVersion','catalogFingerprint','manifestDigest'] as const)if(typeof j[key]!=='string'||j[key].length>4000)throw new Error('漫画任务字段无效')
  if(!/^[a-f0-9-]{36}$/.test(j.id)||comicName(j.directory,150)!==j.directory||j.groupId!==null&&typeof j.groupId!=='string'||typeof j.requiresRevalidation!=='boolean')throw new Error('漫画任务身份无效')
  if(!['queued','running','paused','success','failed','cancelled','interrupted'].includes(j.status)||!['resolving','downloading','verifying','prepared','placed','indexing','done'].includes(j.phase))throw new Error('漫画任务状态无效')
  for(const key of ['processed','total','completedChapters','updatedAt','retryNotBefore'] as const)if(!Number.isSafeInteger(j[key])||j[key]<0)throw new Error('漫画任务进度无效')
  if(j.createdAt!==undefined&&(!Number.isSafeInteger(j.createdAt)||j.createdAt<0))throw new Error('漫画任务创建时间无效')
  return {version:2,provider:'jm',id:j.id,workId:j.workId,name:catalog.name,authors:catalog.authors,selectedChapters:[...j.selectedChapters],catalog,root:j.root,directory:j.directory,groupId:j.groupId,operationId:j.operationId,requestId:j.requestId,status:j.status,phase:j.phase,processed:j.processed,total:j.total,completedChapters:j.completedChapters,current:j.current,error:j.error,errorCode:j.errorCode,resourceId:j.resourceId,createdAt:j.createdAt??j.updatedAt,updatedAt:j.updatedAt,retryNotBefore:j.retryNotBefore,requiresRevalidation:j.requiresRevalidation,adapterVersion:catalog.adapterVersion,catalogFingerprint:catalog.catalogFingerprint,manifestDigest:j.manifestDigest}
}
export function backupComicJob(input:unknown):ComicIngestJob{
  const j=comicJob(input)
  return {...j,operationId:'',requestId:'',current:'',error:'',errorCode:'',requiresRevalidation:true,retryNotBefore:0,status:['running','queued'].includes(j.status)?'interrupted':j.status}
}
