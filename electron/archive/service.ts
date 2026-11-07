import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import type {SqlDb} from '../services/schema.ts'
import type {AIConfig,SearchConfig} from '../../src/types/index.ts'
import {search,searchAvailable} from '../services/searchService.ts'
import type {ArchiveRun,ArchiveEvent,ArchiveSession,ArchiveMessage} from '../../src/types/archive.ts'
import {ArchiveLibrary} from './library.ts'
import type {HermesTool} from './hermes.ts'
import {HermesRuntime} from './hermes.ts'
import {ARCHIVE_TOOLS,ARCHIVE_SYSTEM} from './tools.ts'
import {DocumentLibrary} from '../workspace/documents.ts'
import {DocumentFiles,actualDirectory} from '../workspace/document-files.ts'
import {WorkspaceLinks} from '../workspace/links.ts'
import {SkillProfiles} from '../workspace/skill-profiles.ts'
import * as v from '../workspace/validation.ts'
import {jsonTextPage} from '../services/agent/context.ts'
import {projectWorkbenchSnapshot} from '../kinds/project/handoff.ts'

interface Options {
  db:SqlDb;runtime:string;bridge:string;home:string;assets:string;hideHentai:()=>boolean
  config:(profileId?:string)=>AIConfig;current:()=>boolean
  searchConfig?:()=>SearchConfig
  event:(value:ArchiveEvent)=>void;changed:()=>void
  operation:<T>(action:()=>Promise<T>)=>Promise<T>
  updateResource:(kind:string,id:string,patch:Record<string,any>)=>unknown
  recoverRuns?:boolean
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class ArchiveAssistant {
  readonly runtime:HermesRuntime
  readonly library:ArchiveLibrary
  private workflow:{sessionId:string;names:Set<string>;execute:(name:string,args:Record<string,any>)=>Promise<unknown>}|null=null
  private options:Options
  private controller:AbortController|null=null
  private active:ArchiveRun|null=null
  private disposed=false
  private toolCalls=new Set<Promise<string>>()
  private previews=new Map<string,{options:any;stamp:string}>()
  private resultPages=new Map<string,{sessionId:string;tool:string;raw:string;changed?:number}>()
  constructor(options:Options){
    this.options=options;this.library=new ArchiveLibrary(options)
    if(options.recoverRuns!==false)options.db.prepare("UPDATE archive_runs SET status='interrupted',error='上次应用关闭，已完成的操作保留；可以继续本次任务',updated_at=? WHERE scope=? AND status IN ('starting','running')").run(Date.now(),this.library.scope)
    this.runtime=new HermesRuntime({...options,event:event=>{if(this.current())options.event(event)},execute:(id,name,args)=>this.execute(id,name,args)})
  }
  get running(){return this.active}
  private current(){return !this.disposed&&this.options.current()}
  private emit(event:ArchiveEvent){if(this.current())this.options.event(event)}
  private save(run:ArchiveRun){this.options.db.prepare('INSERT INTO archive_runs VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET status=excluded.status,text=excluded.text,error=excluded.error,started_at=excluded.started_at,updated_at=excluded.updated_at').run(run.sessionId,run.status,run.text,run.error,run.startedAt,run.updatedAt,this.library.scope);this.emit({sessionId:run.sessionId,event:'run',run:{...run}})}
  private lastRun(id:string):ArchiveRun|null {
    const r=this.options.db.prepare('SELECT * FROM archive_runs WHERE session_id=? AND scope=?').get(id,this.library.scope) as any
    return r?{sessionId:r.session_id,status:r.status,text:r.text,error:r.error,startedAt:r.started_at,updatedAt:r.updated_at}:null
  }
  private fallback(run:ArchiveRun):ArchiveSession{return {id:run.sessionId,title:run.text.slice(0,45),started_at:run.startedAt/1000,last_active:run.updatedAt/1000,message_count:1,model:''}}
  send(input:{sessionId?:string;text:string;contextIds?:string[];profileId?:string}):ArchiveRun{
    if(!this.current())throw new Error('归档助理已关闭，请重新打开')
    if(this.active)throw new Error('当前任务仍在进行，可以先停止或等待完成')
    const text=v.text(input.text,'消息',30000).trim();if(!text)throw new Error('请输入要处理的事情')
    const config=this.options.config(input.profileId);if(!config.enabled||!config.model||!config.api_url||!config.api_key)throw new Error('请先在设置中启用并配置 AI 模型')
    const context=v.strings(input.contextIds||[],20).map(id=>this.library.sourceById(id))
    const sessionId=input.sessionId?v.text(input.sessionId,'会话编号',128):randomUUID(),startedAt=Date.now()
    const stored=this.options.db.prepare('SELECT scope FROM archive_runs WHERE session_id=?').get(sessionId) as any
    if(stored&&stored.scope!==this.library.scope)throw new Error('这段对话在当前范围不可用，请新建对话')
    const previous=this.lastRun(sessionId),recover=previous&&['failed','interrupted','starting'].includes(previous.status)?previous:null
    this.controller=new AbortController()
    // Until Hermes is ready, preserve both requests in the durable fallback.
    const run:ArchiveRun={sessionId,status:'starting',text:recover?recover.text+'\n\n用户后续要求：'+text:text,error:'',startedAt,updatedAt:startedAt};this.active=run;this.save(run)
    void this.perform(run,config,context,text,recover,this.controller);return {...run}
  }
  private async perform(run:ArchiveRun,config:AIConfig,context:any[],text:string,previous:ArchiveRun|null,controller:AbortController){
    try{
      await this.runtime.start();controller.signal.throwIfAborted()
      if(previous)await this.runtime.request('ensure_session',{id:previous.sessionId,title:previous.text.slice(0,45),text:previous.text,timestamp:previous.startedAt/1000})
      controller.signal.throwIfAborted()
      run.text=text;run.status='running';run.updatedAt=Date.now();this.save(run)
      const result=await this.runtime.run({sessionId:run.sessionId,text,config,tools:ARCHIVE_TOOLS,system:ARCHIVE_SYSTEM+(context.length?'\n本次用户附带的资源（按需查详情）：'+JSON.stringify(context):'')},{signal:controller.signal})
      await Promise.allSettled(this.toolCalls)
      if(!this.current())return
      const original=run.sessionId
      run.sessionId=result.sessionId||run.sessionId;run.status=result.interrupted?'interrupted':result.completed?'completed':'failed';run.error=result.error||(run.status==='failed'?'本次任务未完成，可继续或重试':'');run.updatedAt=Date.now()
      if(run.sessionId!==original){this.options.db.prepare('DELETE FROM archive_runs WHERE session_id=?').run(original);this.options.db.prepare('UPDATE archive_actions SET session_id=? WHERE session_id=?').run(run.sessionId,original)}
      this.previews.clear();this.resultPages.clear();this.active=null;this.controller=null;this.save(run);this.emit({sessionId:run.sessionId,event:'finished',previousSessionId:original,result,run:{...run}})
    }catch(e){await Promise.allSettled(this.toolCalls);if(this.current()){run.status=controller.signal.aborted?'interrupted':'failed';run.error=(e as Error).message;run.updatedAt=Date.now();this.previews.clear();this.resultPages.clear();this.active=null;this.controller=null;this.save(run);this.emit({sessionId:run.sessionId,event:'finished',run:{...run}})}}
    finally{if(this.controller===controller){this.active=null;this.controller=null;this.previews.clear();this.resultPages.clear()}if(this.current())this.options.changed()}
  }
  async runWorkflow(input:{kind:'project_prompt'|'document_insight';text:string;config:AIConfig;tools:HermesTool[];system:string;execute:(name:string,args:Record<string,any>)=>Promise<unknown>;priority?:'interactive'|'background';signal?:AbortSignal}){
    if(!this.current())throw new Error('资料库或隐私范围已变化，请重新开始')
    if(this.active)throw new Error('归档助理正在处理任务，请等待完成或先停止')
    if(!input.config.enabled||!input.config.model||!input.config.api_url||!input.config.api_key)throw new Error('请先配置模型，或复制本地交接模板')
    const sessionId=randomUUID(),controller=new AbortController(),now=Date.now()
    input.signal?.throwIfAborted()
    let deadline:ReturnType<typeof setTimeout>|undefined
    const abort=()=>controller.abort(input.signal?.reason);input.signal?.addEventListener('abort',abort,{once:true})
    const run:ArchiveRun={sessionId,status:'starting',text:input.text,error:'',startedAt:now,updatedAt:now}
    this.controller=controller;this.active=run;this.workflow={sessionId,names:new Set(input.tools.map(tool=>tool.name)),execute:input.execute};this.save(run)
    try{
      const result=await this.runtime.run({sessionId,text:input.text,config:input.config,tools:input.tools,system:input.system,workflow:input.kind,maxIterations:12},{signal:controller.signal,priority:input.priority,cancelGraceMs:input.kind==='document_insight'?5000:undefined,onStart:()=>{
        if(input.kind==='document_insight')deadline=setTimeout(()=>controller.abort(new Error('本次模型调用超过 120 秒，已停止；可稍后重试')),120000)
      }})
      await Promise.allSettled(this.toolCalls);controller.signal.throwIfAborted()
      if(!this.current())throw new Error('资料库或隐私范围已变化，本次结果未采用')
      run.status=result.completed?'completed':'failed';run.error=result.error||(!result.completed?'生成未完成，请重试':'');run.updatedAt=Date.now();this.save(run)
      if(!result.completed)throw new Error(run.error)
      return {...result,sessionId:result.sessionId||sessionId}
    }catch(error){
      await Promise.allSettled(this.toolCalls)
      if(this.current()){run.status=controller.signal.aborted?'interrupted':'failed';run.error=(error as Error).message;run.updatedAt=Date.now();this.save(run)}
      throw error
    }finally{
      input.signal?.removeEventListener('abort',abort)
      clearTimeout(deadline)
      if(this.controller===controller){this.active=null;this.controller=null;this.workflow=null}
      if(this.current()){this.emit({sessionId,event:'finished',run:{...run}});this.options.changed()}
    }
  }
  async cancel(){this.controller?.abort(new Error('任务已停止'));if(this.active)await this.runtime.request('cancel')}
  async dispose(){this.disposed=true;this.controller?.abort(new Error('助手已关闭'));await Promise.allSettled(this.toolCalls);await this.runtime.close();this.resultPages.clear()}
  private async ensureSession(id:string){
    if(await this.runtime.request('session',{id}))return
    const run=this.lastRun(id);if(!run)throw new Error('对话不存在')
    await this.runtime.request('ensure_session',{id,title:run.text.slice(0,45),text:run.text,timestamp:run.startedAt/1000})
  }
  async rename(id:string,title:string){id=v.text(id,'会话编号',128);title=v.name(title);await this.ensureSession(id);await this.runtime.request('rename',{id,title})}
  async archive(id:string){id=v.text(id,'会话编号',128);if(this.active?.sessionId===id)throw new Error('请先停止本次任务');await this.ensureSession(id);await this.runtime.request('archive',{id})}
  async sessions(query=''){
    query=v.text(query,'历史关键词',200)
    const items=await this.runtime.request<ArchiveSession[]>('sessions',{query})
    const unfinished=this.options.db.prepare("SELECT session_id FROM archive_runs WHERE scope=? AND status IN ('failed','interrupted') ORDER BY updated_at DESC LIMIT 100").all(this.library.scope) as Array<{session_id:string}>
    for(const row of unfinished){
      if(items.some(x=>x.id===row.session_id))continue
      const run=this.lastRun(row.session_id)!
      if(query&&!run.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))continue
      if(!await this.runtime.request('session',{id:row.session_id}))items.push(this.fallback(run))
    }
    return items.sort((a,b)=>b.last_active-a.last_active)
  }
  async session(id:string){
    id=v.text(id,'会话编号',128)
    const state=await this.runtime.request<{session:ArchiveSession;messages:ArchiveMessage[]}|null>('session',{id}),lastRun=this.lastRun(id)
    if(state)return {...state,lastRun}
    return lastRun?{session:this.fallback(lastRun),messages:[{id:0,role:'user',content:lastRun.text,timestamp:lastRun.startedAt/1000}],lastRun}:null
  }
  private execute(sessionId:string,name:string,args:Record<string,any>):Promise<string>{
    const task=this.performTool(sessionId,name,args);this.toolCalls.add(task)
    void task.finally(()=>this.toolCalls.delete(task)).catch(()=>{})
    return task
  }
  private resultPage(sessionId:string,cursor:{token:string;offset:number}):string{
    const token=v.text(cursor?.token,'结果编号',128),entry=this.resultPages.get(token)
    if(!entry||entry.sessionId!==sessionId)throw new Error('这份结果快照已失效，请重新查询当前资料或修改记录，不要重复执行已完成的写入')
    return jsonTextPage(entry.raw,cursor.offset,18000,(text,end)=>({format:'json-fragment',tool:entry.tool,...(entry.changed===undefined?{}:{changed:entry.changed}),text,next:end<entry.raw.length?{token,offset:end}:null}))
  }
  private encodeResult(sessionId:string,tool:string,value:any):string{
    const raw=JSON.stringify(value)
    if(raw.length<=18000)return raw
    const token=randomUUID()
    this.resultPages.set(token,{sessionId,tool,raw,...(typeof value?.changed==='number'?{changed:value.changed}:{})})
    return this.resultPage(sessionId,{token,offset:0})
  }
  private async performTool(sessionId:string,name:string,args:Record<string,any>):Promise<string>{
    if(!this.current())throw new Error('资料库或隐私设置已经改变，请重新开始')
    this.controller?.signal.throwIfAborted()
    if(this.workflow){if(sessionId!==this.workflow.sessionId||!this.workflow.names.has(name))throw new Error('此工作流未授权该工具');return JSON.stringify(await this.workflow.execute(name,args))}
    const lib=this.library,db=this.options.db,docs=new DocumentLibrary(db),files=new DocumentFiles(db)
    let result:unknown
    switch(name){
      case 'archive_result':return this.resultPage(sessionId,args.cursor)
      case 'archive_search':result=lib.search(args);break
      case 'archive_get':result=lib.get(args.id);break
      case 'archive_project_workbench':lib.sourceById(args.id);result=await projectWorkbenchSnapshot(db,args.id,this.controller?.signal);break
      case 'archive_catalog':result=lib.catalog();break
      case 'archive_create_category':result=await this.options.operation(async()=>lib.createTaxonomy(args as any));this.options.changed();break
      case 'archive_read':result=await lib.read(args.id,args);break
      case 'archive_search_text':result=await lib.searchText(args as any,this.controller?.signal);break
      case 'archive_project_files':result=await lib.projectFiles(args.id,args);break
      case 'archive_project_search':result=await lib.projectSearch(args.id,args.path,args.query,args.cursor);break
      case 'archive_check':result=await lib.check(args.ids);break
      case 'archive_update':result=await this.options.operation(async()=>lib.update(sessionId,args.changes,args.reason));this.options.changed();break
      case 'archive_create_personal':result=await this.options.operation(async()=>lib.createPersonal(sessionId,args));this.options.changed();break
      case 'archive_actions':result=lib.actions(args.sessionId||sessionId);break
      case 'archive_undo':result=await this.options.operation(async()=>lib.undo(args.id));this.options.changed();break
      case 'archive_relocate':lib.get(args.id);result=await this.options.operation(async()=>{await docs.relocate(args.id,v.text(args.file,'文件位置',4096));return {relocated:true,source:lib.get(args.id)}});this.options.changed();break
      case 'archive_locate':result=await this.locate(args.id,args.directory);break
      case 'archive_organize':result=await this.organize(args,files);break
      case 'archive_link':{
        const links=new WorkspaceLinks(db,this.options.hideHentai())
        if(args.action==='list')result=links.list(args.owner,args.ownerId)
        else result=await this.options.operation(async()=>{if(args.action==='add'){lib.get(args.resourceId);return links.add(args.owner,args.ownerId,args.resourceId,args.annotationId)}if(args.action==='remove'){links.remove(args.owner,args.ownerId,args.linkId);return {removed:true}}throw new Error('关联操作无效')})
        this.options.changed();break
      }
      case 'archive_skill':{const skills=new SkillProfiles(db);if(args.action==='list')result={cards:skills.list(),proposals:skills.proposals()};else result=await this.options.operation(async()=>{if(args.action==='propose')return skills.propose(args.input);if(args.action==='record')return skills.record(args.input);throw new Error('技能操作无效')});this.options.changed();break}
      case 'archive_history':result=this.legacyHistory(args);break
      case 'archive_web_search':{
        const query=v.text(args.query,'公开搜索词',500)
        if(!query||/[a-z]:[\\/]|\\|\/(?:Users|home|root|AppData)\//i.test(query))throw new Error('请使用公开名称或关键词搜索，不要包含本地路径')
        const config=this.options.searchConfig?.()
        if(!config||!searchAvailable(config))throw new Error('网络搜索未启用或配置不完整，请在全局设置的网络搜索中选择服务商并补全配置')
        try{result={results:await search(query,config),provider:config.provider}}catch(e){throw new Error('公开信息搜索失败：'+(e as Error).message.replaceAll(config.api_key||'\0','[redacted]'))}
        break
      }
      default:throw new Error('未知归档工具：'+name)
    }
    return this.encodeResult(sessionId,name,result)
  }
  private async locate(id:string,directory:string){
    const item=this.library.get(id);if(item.kind!=='document')throw new Error('目前支持文库原文件重新定位')
    const root=v.text(directory,'查找目录',4096);await actualDirectory(root)
    const queue=[root],matches:any[]=[];let scanned=0
    while(queue.length&&scanned<10000){this.controller?.signal.throwIfAborted();const dir=queue.shift()!;for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(++scanned>10000)break;if(entry.isSymbolicLink())continue;const file=path.join(dir,entry.name);if(entry.isDirectory()){if(!['.git','node_modules','$RECYCLE.BIN','System Volume Information'].includes(entry.name))queue.push(file)}else if(entry.name.toLowerCase()===path.basename(item.registeredPath||item.path).toLowerCase()){const stat=await fs.stat(file);matches.push({file,size:stat.size,modifiedAt:stat.mtimeMs})}}}
    return {source:item,matches,scanned,truncated:queue.length>0||scanned>10000}
  }
  private async organize(args:any,files:DocumentFiles){
    if(args.action==='history')return files.operations().filter(x=>{try{this.library.get(x.documentId);return true}catch{return false}})
    if(['undo','recover'].includes(args.action)){const operation=files.operations().find(x=>x.id===args.operationId);if(!operation)throw new Error('文件操作不存在');this.library.get(operation.documentId);return this.options.operation(async()=>{try{return args.action==='undo'?await files.undo(args.operationId):await files.recover(args.operationId)}finally{this.options.changed()}})}
    if(args.action==='preview'){
      const ids=v.strings(args.ids,100);if(!ids.length)throw new Error('请选择资料');for(const id of ids)if(this.library.get(id).kind!=='document')throw new Error('文件整理仅支持文库资料')
      if(!['move','copy'].includes(args.mode))throw new Error('请选择移动或复制')
      const options={rootDir:v.text(args.rootDir,'目标目录',4096),mode:args.mode,selectedIds:ids,useCustomGroups:args.useCustomGroups??true}
      const preview=await files.previewOrganize(options),items=preview.items.filter(x=>ids.includes(x.id)),token=randomUUID()
      this.previews.set(token,{options,stamp:digest(items)});return {token,items}
    }
    if(args.action==='execute'){
      const plan=this.previews.get(args.token);if(!plan)throw new Error('请先预览本次文件整理')
      return this.options.operation(async()=>{const now=await files.previewOrganize(plan.options);if(digest(now.items.filter(x=>plan.options.selectedIds.includes(x.id)))!==plan.stamp)throw new Error('文件整理范围已变化，请重新预览');this.previews.delete(args.token);try{return await files.executeOrganize(plan.options)}finally{this.options.changed()}})
    }
    throw new Error('文件整理操作无效')
  }
  private legacyHistory(args:any){
    // Old transcripts have no privacy provenance and may contain cached sources.
    if(this.options.hideHentai())return {items:[],reason:'旧对话没有记录隐私范围。请在设置中关闭里番隐藏后读取旧历史；当前归档助理的新对话不受影响。'}
    const query=v.text(args.query||'','历史关键词',200).toLowerCase(),out:any[]=[]
    for(const kind of ['workspace','project']){if(args.kind&&args.kind!==kind)continue;for(const row of this.options.db.prepare(`SELECT * FROM ${kind}_sessions ORDER BY updated_at DESC LIMIT 200`).all() as any[]){
      if(args.id&&args.id!==row.id)continue
      const payload=String(row.payload)
      if(query&&!(row.title+' '+payload).toLowerCase().includes(query))continue
      out.push({id:row.id,kind,title:row.title,updatedAt:row.updated_at,...(args.id?{history:JSON.parse(payload)}:{})})
    }}return {items:out.slice(0,args.id?1:30)}
  }
}
