import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import type {SqlDb} from '../services/schema.ts'
import {DocumentLibrary} from './documents.ts'
import {readTextFilePage} from '../services/text-file.ts'
import {extractDocument} from './document-extraction.ts'

export type DocumentReadCursor={kind:'text';offset:number;line:number;version:string}|{kind:'pdf';page:number;start:number;version:string}
export interface DocumentTextPage {text:string;source:{documentId:string;name:string;format:string;page?:number;start?:number;startLine?:number};next:DocumentReadCursor|null;totalPages?:number}
export async function readDocumentText(db:SqlDb,id:string,options:{page?:number;start?:number;line?:number;cursor?:DocumentReadCursor}={},assets=path.resolve('dist/pdfjs')):Promise<DocumentTextPage> {
  try{return await readAvailableDocumentText(db,id,options,assets)}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('未在本地找到该文件，请核对路径，或在资料详情中重新定位')
    throw error
  }
}
async function readAvailableDocumentText(db:SqlDb,id:string,options:{page?:number;start?:number;line?:number;cursor?:DocumentReadCursor},assets:string):Promise<DocumentTextPage> {
  const docs=new DocumentLibrary(db),item=docs.require(id),stat=await docs.inspect(item.path)
  const source={documentId:id,name:item.name,format:item.format}
  if(['md','markdown','txt'].includes(item.format)){
    if(options.cursor&&options.cursor.kind!=='text')throw new Error('续读位置格式无效')
    const page=await readTextFilePage(item.path,options.line||1,options.cursor)
    return {text:page.text,source:{...source,startLine:page.startLine},next:page.next?{kind:'text',...page.next}:null}
  }
  if(item.format!=='pdf')throw new Error('此格式尚不能提取正文；图像或扫描件目前需外部查看，不能当作已读内容')
  if(stat.size>128*1024*1024)throw new Error('PDF 超过当前 128 MB 解析预算，请先拆分文件；尚未读取正文')
  const version=createHash('sha256').update(`${id}\0${item.path}\0${stat.size}\0${(await fs.stat(item.path)).mtimeMs}`).digest('hex')
  if(options.cursor&&(options.cursor.kind!=='pdf'||options.cursor.version!==version))throw new Error('资料已变化，续读位置失效，请重新读取')
  const page=options.cursor?.page??options.page??1,start=options.cursor?.start??options.start??0
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(start)||start<0)throw new Error('PDF 页码或起点无效')
  const result=await extractDocument({file:item.path,format:'pdf',assets,page,start,maxChars:4500})
  const text=result.fragments.map(part=>part.text).join(''),totalPages=result.coverage.totalPages!
  if(!text.trim())throw new Error('此 PDF 页面没有可提取文字层，可能是扫描页；当前无法理解其正文')
  return {text,source:{...source,page,start},totalPages,next:result.coverage.truncatedPages.length?{kind:'pdf',page,start:start+text.length,version}:page<totalPages?{kind:'pdf',page:page+1,start:0,version}:null}
}
