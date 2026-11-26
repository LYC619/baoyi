import fs from 'node:fs/promises'
import {createReadStream} from 'node:fs'
import {createHash} from 'node:crypto'
import type {DocumentCoverage,DocumentExtraction,DocumentFragment} from '../../src/types/document-insight.ts'

export interface ExtractionRequest {
  file:string;format:string;assets:string;maxChars?:number
  page?:number;start?:number
  fromPage?:number;toPage?:number
}
export function selectedPdfPages(total:number){
  return total>30?[...Array.from({length:15},(_,i)=>i+1),...Array.from({length:10},(_,i)=>total-9+i)]:Array.from({length:total},(_,i)=>i+1)
}
function prefix(text:string,length:number){
  let end=Math.min(text.length,length)
  if(end<text.length&&end>0&&/[\uD800-\uDBFF]/.test(text[end-1]))end--
  return text.slice(0,end)
}
function fragments(text:string,page?:number,start=0,startLine?:number):DocumentFragment[]{
  const parts:DocumentFragment[]=[]
  for(let offset=0;offset<text.length;){
    const value=prefix(text.slice(offset),4000)
    parts.push({id:page?`p${page}-${start+offset}`:`t${start+offset}`,text:value,...(page?{page}:{}),start:start+offset,...(startLine?{startLine}:{})})
    if(startLine)startLine+=value.split('\n').length-1
    offset+=value.length
  }
  return parts
}
export async function extractDocumentFile(input:ExtractionRequest,progress:(page:number,total:number)=>void=()=>{}):Promise<DocumentExtraction>{
  try{return await extractAvailableFile(input,progress)}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('未在本地找到该文件，请核对路径后重新读取')
    throw error
  }
}
async function extractAvailableFile(input:ExtractionRequest,progress:(page:number,total:number)=>void):Promise<DocumentExtraction>{
  const before=await fs.lstat(input.file)
  if(!before.isFile()||before.isSymbolicLink())throw new Error('请选择实际资料文件')
  if(!['pdf','txt','md','markdown'].includes(input.format))throw new Error('此格式暂不支持精读；可继续使用外部应用阅读')
  if(before.size>128*1024*1024)throw new Error('资料超过 128 MB 提取预算，请先拆分；尚未读取正文')
  const maxChars=input.maxChars??48000
  if(!Number.isSafeInteger(maxChars)||maxChars<100||maxChars>48000)throw new Error('读取预算应为 100–48,000 字符')
  const coverage:DocumentCoverage={extractorVersion:'v1',strategy:input.format==='pdf'?'all':'text',totalPages:null,pages:[],emptyPages:[],skippedPages:[],truncatedPages:[],characters:0,complete:true,reasons:[]}
  const parts:DocumentFragment[]=[]
  const digest=createHash('sha256')
  for await(const bytes of createReadStream(input.file))digest.update(bytes)
  const fingerprint=digest.digest('hex')
  if(input.format==='pdf'){
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),worker=await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    // PDF.js' fake worker runs inside our bounded worker thread, never in the UI/main thread.
    ;(globalThis as any).pdfjsWorker={WorkerMessageHandler:worker.WorkerMessageHandler}
    const assets=input.assets.replaceAll('\\','/').replace(/\/$/,'')+'/'
    const task=pdfjs.getDocument({data:new Uint8Array(await fs.readFile(input.file)),useSystemFonts:true,disableFontFace:true,useWorkerFetch:false,cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',verbosity:0})
    try{
      const pdf=await task.promise,total=pdf.numPages
      coverage.totalPages=total
      if(input.page!==undefined&&(!Number.isSafeInteger(input.page)||input.page<1||input.page>total))throw new Error('PDF 页码超出范围')
      const custom=input.fromPage!==undefined
      if(custom&&(!Number.isSafeInteger(input.fromPage)||!Number.isSafeInteger(input.toPage)||input.fromPage!<1||input.toPage!<input.fromPage!||input.toPage!>total||input.toPage!-input.fromPage!>=80))throw new Error('请选择文件内连续 1–80 页')
      const pages=input.page?[input.page]:custom?Array.from({length:input.toPage!-input.fromPage!+1},(_,i)=>input.fromPage!+i):selectedPdfPages(total)
      coverage.strategy=input.page?'page':custom?'range':total>30?'head-tail':'all'
      coverage.skippedPages=Array.from({length:total},(_,i)=>i+1).filter(page=>!pages.includes(page))
      if(coverage.strategy==='head-tail')coverage.reasons.push('长 PDF 仅选取前 15 页和后 10 页')
      if(custom)coverage.reasons.push(`本次指定读取第 ${input.fromPage}–${input.toPage} 页`)
      const headBudget=coverage.strategy==='head-tail'?Math.floor(maxChars*.6):maxChars
      let headUsed=0,tailUsed=0
      for(const number of pages){
        progress(number,total)
        const page=await pdf.getPage(number)
        let text:string
        try{const content=await page.getTextContent();text=content.items.map(item=>'str' in item?item.str+(item.hasEOL?'\n':' '):'').join('')}
        finally{page.cleanup()}
        coverage.pages.push(number)
        if(!text.trim()){coverage.emptyPages.push(number);continue}
        const start=input.page?(input.start??0):0
        if(!Number.isSafeInteger(start)||start<0||start>text.length)throw new Error('PDF 文字起点超出范围')
        const tail=coverage.strategy==='head-tail'&&number>15
        const budget=tail?maxChars-headUsed-tailUsed:headBudget-headUsed
        const value=prefix(text.slice(start),Math.max(0,budget))
        if(value.length<text.length-start)coverage.truncatedPages.push(number)
        if(tail)tailUsed+=value.length;else headUsed+=value.length
        parts.push(...fragments(value,number,start))
      }
    }finally{await task.destroy()}
  }else{
    const start=input.start??0
    if(!Number.isSafeInteger(start)||start<0||start>128*1024*1024)throw new Error('文字起点超出范围')
    let text='',offset=0,startLine=1,truncated=false
    for await(const chunk of createReadStream(input.file,{encoding:'utf8',highWaterMark:16384})){
      if(chunk.includes('\0'))throw new Error('文件含二进制内容，不能作为文本读取')
      const skip=Math.min(chunk.length,Math.max(0,start-offset))
      startLine+=chunk.slice(0,skip).split('\n').length-1;offset+=chunk.length;text+=chunk.slice(skip)
      if(text.length>maxChars){truncated=true;break}
    }
    if(offset<start)throw new Error('文字起点超出文件范围')
    if(text&&/[\uDC00-\uDFFF]/.test(text[0]))throw new Error('文字起点位于 Unicode 字符中间，请前移一个字符')
    coverage.complete=!truncated&&!start
    if(start)coverage.reasons.push(`本次从第 ${start+1} 个字符继续读取`)
    if(truncated)coverage.reasons.push('已达到本次字符预算，部分正文未读取')
    parts.push(...fragments(prefix(text,maxChars),undefined,start,startLine))
  }
  const after=await fs.lstat(input.file)
  if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ino!==before.ino)throw new Error('资料正在变化，请稍后重新读取')
  coverage.characters=parts.reduce((sum,part)=>sum+part.text.length,0)
  if(coverage.truncatedPages.length)coverage.reasons.push('已达到本次字符预算，部分正文未读取')
  if(coverage.emptyPages.length)coverage.reasons.push('部分页面没有文字层；未执行 OCR')
  coverage.complete=coverage.complete&&!coverage.skippedPages.length&&!coverage.truncatedPages.length&&!coverage.emptyPages.length
  return {fingerprint,size:before.size,mtimeMs:before.mtimeMs,fragments:parts,coverage}
}
