import {spawn} from 'node:child_process'
import path from 'node:path'
import {StringDecoder} from 'node:string_decoder'
import type {ComicCatalog,ComicBrowseQuery,ComicBrowseResult} from '../../../src/types/comic-ingest.ts'
import {comicCatalog,comicWorkId} from './comic-source-rules.ts'

export interface ComicPageResult {chapterId:string;pageId:string;file:string;sha256:string;size:number;width:number;height:number}
export interface ComicDownloadChapter {id:string;directory:string;pageIds:string[];skip:string[]}
export class ComicSourceError extends Error {
  code:string;retryAt:number
  constructor(code:string,message:string,retryAt=0){super(message);this.code=code;this.retryAt=retryAt}
}
interface Options {python:string;runtime:string;bridge:string;proxies:()=>Promise<Record<string,string>>}
export class ComicRuntime {
  private options:Options
  constructor(options:Options){this.options=options}
  private async run(request:Record<string,unknown>,signal:AbortSignal,onEvent:(event:any)=>void){
    signal.throwIfAborted();const proxies=await this.options.proxies();signal.throwIfAborted()
    const payload=JSON.stringify({protocolVersion:1,...request,proxies})+'\n'
    if(Buffer.byteLength(payload)>8*1024**2)throw new Error('漫画任务内容过大')
    return new Promise<void>((resolve,reject)=>{
      const environment:NodeJS.ProcessEnv={PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'}
      for(const name of ['SystemRoot','WINDIR','TEMP','TMP','PATH'])if(process.env[name])environment[name]=process.env[name]
      const child=spawn(this.options.python,['-I','-S','-X','utf8','-u',this.options.bridge,path.join(this.options.runtime,'site-packages')],{windowsHide:true,stdio:['pipe','pipe','pipe'],cwd:this.options.runtime,env:environment})
      let buffer='',lastAt=Date.now(),sequence=0,complete=false,failure:Error|undefined,stderr='',grace:ReturnType<typeof setTimeout>|undefined
      const started=Date.now(),pages=new Map<string,number>(),decoder=new StringDecoder('utf8')
      const fail=(error:Error)=>{failure??=error;child.kill()}
      const cancel=()=>{failure??=signal.reason instanceof Error?signal.reason:new Error('漫画下载已停止');child.stdin.write('{}\n',()=>{});grace??=setTimeout(()=>child.kill(),5000)}
      const watchdog=setInterval(()=>{
        if(Date.now()-lastAt>45000)fail(new ComicSourceError('timeout','来源进程没有响应，请重试'))
        if(request.action==='resolve'&&Date.now()-started>300000)fail(new ComicSourceError('timeout','解析作品超过 5 分钟，请稍后重试'))
        if(['browse','cover'].includes(String(request.action))&&Date.now()-started>60000)fail(new ComicSourceError('timeout','来源浏览超过 60 秒，请重试或更换连接方式'))
        if([...pages.values()].some(at=>Date.now()-at>120000))fail(new ComicSourceError('timeout','单页处理超过 120 秒，已完成页保留'))
      },1000)
      signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()
      child.stdout.on('data',(chunk:Buffer)=>{
        buffer+=decoder.write(chunk)
        while(buffer.includes('\n')){
          const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1)
          try{
            if(Buffer.byteLength(line)>65536)throw new Error('来源事件过大')
            const event=JSON.parse(line)
            if(event.protocolVersion!==1||event.jobId!==request.jobId||event.sequence!==++sequence)throw new Error('来源事件顺序无效')
            lastAt=Date.now()
            if(event.event==='error')fail(new ComicSourceError(String(event.code).slice(0,80),String(event.message).slice(0,500),Number.isSafeInteger(event.retryAt)?event.retryAt:0))
            else if(event.event==='complete')complete=true
            else if(event.event==='page_start')pages.set(event.chapterId+':'+event.pageId,Date.now())
            else if(event.event!=='heartbeat'){
              if(event.event==='page')pages.delete(event.chapterId+':'+event.pageId)
              onEvent(event)
            }
          }catch(error){fail(error as Error)}
        }
        if(Buffer.byteLength(buffer)>65536)fail(new Error('来源事件未正确结束'))
      })
      child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-4000)})
      child.stdin.on('error',()=>fail(new Error('漫画来源连接已中断')))
      child.once('error',error=>{failure=error})
      child.once('close',code=>{
        clearInterval(watchdog);clearTimeout(grace);signal.removeEventListener('abort',cancel)
        if(failure)reject(failure)
        else if(!complete||code!==0)reject(new Error('漫画来源进程意外退出；已完成页面保留'))
        else resolve()
        void stderr // Bounded locally; never expose dependency URLs or authentication in UI.
      })
      child.stdin.write(payload)
    })
  }
  async browse(jobId:string,query:ComicBrowseQuery,signal:AbortSignal):Promise<ComicBrowseResult>{
    if(!query||!['ranking','search'].includes(query.mode)||!Number.isSafeInteger(query.page)||query.page<1||query.page>1000)throw new Error('漫画浏览条件无效')
    if(query.mode==='search'&&(typeof query.query!=='string'||!query.query.trim()||query.query.length>200||!['all','author','tag'].includes(query.scope||'all')))throw new Error('漫画搜索条件无效')
    if(query.mode==='ranking'&&!['day','week','month','all'].includes(query.period||'day'))throw new Error('榜单周期无效')
    const result:ComicBrowseResult={items:[],page:query.page,pages:query.page}
    await this.run({...query,action:'browse',jobId},signal,event=>{
      if(event.event==='browse_item'){
        const value=event.value
        if(result.items.length>=100||!value||comicWorkId(value.id)!==value.id||typeof value.title!=='string'||value.title.length>500||!Array.isArray(value.tags)||value.tags.length>20||value.tags.some((tag:unknown)=>typeof tag!=='string'||tag.length>100))throw new Error('来源列表格式无效')
        result.items.push({id:value.id,title:value.title,tags:value.tags})
      }else if(event.event==='browse_page'){
        if(event.page!==query.page||!Number.isSafeInteger(event.pages)||event.pages<query.page||event.pages>1000)throw new Error('来源分页无效')
        result.pages=event.pages
      }
    });return result
  }
  async cover(jobId:string,input:string,signal:AbortSignal){let cover='';await this.run({action:'cover',jobId,workId:comicWorkId(input)},signal,event=>{if(event.event==='cover'&&typeof event.value==='string'&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(event.value)&&event.value.length<60000)cover=event.value});return cover}
  async resolve(jobId:string,input:string,signal:AbortSignal):Promise<ComicCatalog>{
    let work:Partial<ComicCatalog>={},pageCount=0;const chapters=new Map<string,ComicCatalog['chapters'][number]>()
    await this.run({action:'resolve',jobId,workId:comicWorkId(input)},signal,event=>{
      if(event.event==='work')work=event.value
      if(event.event==='cover')work.cover=event.value
      if(event.event==='chapter'){
        if(!Array.isArray(event.pageIds)||event.pageIds.length>200||(pageCount+=event.pageIds.length)>50000)throw new Error('来源章节页码无效')
        let chapter=chapters.get(event.id)
        if(!chapter){if(event.offset!==0||chapters.size>=1000)throw new Error('来源章节顺序无效');chapter={id:event.id,title:event.title,order:event.order,pageIds:[]};chapters.set(event.id,chapter)}
        if(event.offset!==chapter.pageIds.length||chapter.pageIds.length+event.pageIds.length>20000)throw new Error('来源页面顺序无效')
        chapter.pageIds.push(...event.pageIds)
      }
    })
    return comicCatalog({...work,chapters:[...chapters.values()]})
  }
  download(jobId:string,workId:string,directory:string,chapters:ComicDownloadChapter[],signal:AbortSignal,onPage:(value:ComicPageResult)=>void,onRetry:(value:{chapterId:string;pageId:string;attempt:number})=>void=()=>{}){
    return this.run({action:'download',jobId,workId:comicWorkId(workId),directory,chapters},signal,event=>{if(event.event==='page')onPage(event);else if(event.event==='retry')onRetry(event)})
  }
}
