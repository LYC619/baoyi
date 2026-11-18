import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import type {SqlDb} from '../../services/schema.ts'
import type {ComicCatalog,ComicIngestJob,ComicIngestPreview,ComicProxy} from '../../../src/types/comic-ingest.ts'
import {ComicRuntime,ComicSourceError,type ComicPageResult} from './comic-runtime.ts'
import {comicDirectory,comicName,comicProxy} from './comic-source-rules.ts'
import {comicJob} from './comic-job.ts'
import {ComicStage,comicRoot,comicDigest,emptyComicManifest,writeComicJson,type ComicRoot} from './comic-files.ts'
import {readImageManifest,readManifestPage,type ImageManifestV2} from './manifest.ts'
import type {ComicPageVerifier} from './comic-verifier.ts'
import {ImageLibrary} from './library.ts'
import {scanImageImport} from './scanner.ts'
import {imageOperation} from './activity.ts'
import {assertImageFilesIdle,lockImageFiles} from './management.ts'
import {ComicLog} from './comic-log.ts'

interface Grant {version:1;jobId:string;operationId:string;root:ComicRoot;directory:string;workId:string;proxy:ComicProxy;existing:ComicRoot|null}
interface Dependencies {
  db:SqlDb;authorizationDirectory:string;runtime:(proxy:ComicProxy)=>Pick<ComicRuntime,'resolve'|'download'>;
  verifier:()=>{verify:ComicPageVerifier;close:()=>Promise<unknown>};changed:()=>void;jobsChanged:()=>void;
  allowed:()=>boolean;assertIdle:()=>void;
}
export class ComicIngestService {
  private deps:Dependencies;private jobs=new Map<string,ComicIngestJob>();private library:ImageLibrary
  private previews=new Map<string,{catalog:ComicCatalog;proxy:ComicProxy;at:number}>()
  private active:{id:string;controller:AbortController;settled:Promise<void>}|null=null
  private resolving:AbortController|null=null;private closing=false
  private creating=false
  private maintaining=new Set<string>()
  private log:ComicLog
  constructor(deps:Dependencies){
    this.deps=deps;this.library=new ImageLibrary(deps.db);this.log=new ComicLog(path.join(path.dirname(deps.authorizationDirectory),'comic-logs'))
    for(const row of deps.db.prepare('SELECT payload FROM image_download_jobs').all() as {payload:string}[]){
      let job:ComicIngestJob
      try{const raw=JSON.parse(row.payload);if(raw.version!==2)continue;job=comicJob(raw)}
      catch{continue /* 无法解析的任务保留在数据库中，不启动文件操作。 */}
      if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='上次任务已中断，已完成页面保留';this.save(job)}
      this.jobs.set(job.id,job)
    }
  }
  private save(job:ComicIngestJob){job.updatedAt=Date.now();this.deps.db.prepare('INSERT INTO image_download_jobs(id,status,updated_at,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload=excluded.payload').run(job.id,job.status,job.updatedAt,JSON.stringify(job));this.log.append(job,()=>new Set([...this.jobs.values()].filter(j=>!['success','cancelled'].includes(j.status)).map(j=>j.id)));this.deps.jobsChanged()}
  private visible(job:ComicIngestJob){return this.deps.allowed()&&!this.library.groups().some(g=>g.id===job.groupId&&g.hidden)&&(!job.resourceId||!!this.library.get(job.resourceId))}
  list(){return [...this.jobs.values()].filter(j=>this.visible(j)).sort((a,b)=>(b.createdAt??b.updatedAt)-(a.createdAt??a.updatedAt)||a.id.localeCompare(b.id)).map(j=>({...j,catalog:undefined,operationId:'',requestId:''}))}
  private get(id:string){const job=this.jobs.get(id);if(!job||!this.visible(job))throw new Error('漫画任务不可用');return job}
  private check(){if(this.closing||!this.deps.allowed())throw new Error('请先开启隐私内容访问');this.deps.assertIdle()}
  private grantFile(id:string){return path.join(this.deps.authorizationDirectory,id+'.json')}
  private existing(workId:string){const row=this.deps.db.prepare("SELECT resource_id AS id FROM image_meta WHERE source='jm' AND source_id=?").get(workId) as {id:string}|undefined;if(!row)return null;const item=this.library.get(row.id);if(!item)throw new Error('已有作品所属分类不可用，请先核对分类');return item}
  async preview(input:string,proxyInput:ComicProxy):Promise<ComicIngestPreview>{
    this.check();if(this.resolving)throw new Error('正在解析上一部作品')
    const proxy=comicProxy(proxyInput),controller=this.resolving=new AbortController()
    try{
      const catalog=await this.deps.runtime(proxy).resolve(randomUUID(),input,controller.signal);controller.signal.throwIfAborted();this.check()
      const existing=this.existing(catalog.workId),manifest=existing?await readImageManifest(existing.path,catalog.workId,'jm'):null
      if(existing&&!manifest)throw new Error('已有作品缺少来源清单，请先核对原目录')
      const token=randomUUID();this.previews.clear();this.previews.set(token,{catalog,proxy,at:Date.now()})
      return {token,catalog,directory:existing?path.basename(existing.path):comicDirectory(catalog),existingId:existing?.id||'',existingChapters:manifest?.chapters.map(c=>c.id)||[]}
    }finally{if(this.resolving===controller)this.resolving=null}
  }
  cancelPreview(){this.resolving?.abort(new Error('已取消解析'));this.previews.clear()}
  async enqueue(token:string,selected:string[],rootPath:string,directory:string,groupId:string|null):Promise<string>{
    if(this.creating)throw new Error('正在添加漫画任务，请稍候')
    this.creating=true
    try{return await imageOperation(()=>this.createJob(token,selected,rootPath,directory,groupId))}finally{this.creating=false}
  }
  private async createJob(token:string,selected:string[],rootPath:string,directory:string,groupId:string|null):Promise<string>{
    this.check();const preview=this.previews.get(token)
    if(!preview||Date.now()-preview.at>1800000)throw new Error('作品预览已过期，请重新解析')
    if(!Array.isArray(selected)||!selected.length||new Set(selected).size!==selected.length||selected.some(id=>!preview.catalog.chapters.some(c=>c.id===id)))throw new Error('请选择有效章节')
    if([...this.jobs.values()].some(j=>j.workId===preview.catalog.workId&&!j.requiresRevalidation&&!['success','cancelled'].includes(j.status)))throw new Error('这部作品已有摄入任务，请从下载记录继续')
    if(groupId&&!this.library.groups().some(g=>g.id===groupId&&g.type==='comic'&&!g.hidden))throw new Error('漫画分类不可用')
    if(typeof directory!=='string'||comicName(directory,150)!==directory)throw new Error('目录名称含有不支持的字符')
    const root=await comicRoot(rootPath),existing=this.existing(preview.catalog.workId)
    let previous:ImageManifestV2|null=null,identity:ComicRoot|null=null
    if(existing){
      assertImageFilesIdle(existing.id)
      if(path.resolve(existing.path).toLowerCase()!==path.join(root.path,directory).toLowerCase())throw new Error('补章请选择原作品的根目录')
      previous=await readImageManifest(existing.path,preview.catalog.workId,'jm');identity=await comicRoot(existing.path)
      if(!previous?.selectionComplete||selected.some(id=>previous!.chapters.some(c=>c.id===id)))throw new Error('请选择尚未保存的章节')
    }
    this.check()
    const id=randomUUID(),operationId=randomUUID(),stage=await ComicStage.create(root,id,operationId,preview.catalog.workId,directory)
    if(previous){stage.intent.existingDigest=comicDigest(previous);await stage.checkpoint()}
    const manifest=emptyComicManifest(preview.catalog,selected);await writeComicJson(path.join(stage.payload,'.baoyi-image.json'),manifest)
    delete preview.catalog.cover
    const grant:Grant={version:1,jobId:id,operationId,root,directory,workId:preview.catalog.workId,proxy:preview.proxy,existing:identity}
    await fs.mkdir(this.deps.authorizationDirectory,{recursive:true});await writeComicJson(this.grantFile(id),grant)
    const job:ComicIngestJob={version:2,provider:'jm',id,workId:preview.catalog.workId,name:preview.catalog.name,authors:preview.catalog.authors,selectedChapters:selected,catalog:preview.catalog,root:root.path,directory,groupId:existing?.groupId||groupId,operationId,requestId:token,status:'queued',phase:'downloading',processed:0,total:manifest.chapters.reduce((n,c)=>n+c.pageIds.length,0),completedChapters:0,current:'',error:'',errorCode:'',resourceId:existing?.id||'',createdAt:Date.now(),updatedAt:Date.now(),retryNotBefore:0,requiresRevalidation:false,adapterVersion:preview.catalog.adapterVersion,catalogFingerprint:preview.catalog.catalogFingerprint,manifestDigest:''}
    this.jobs.set(id,job);this.save(job);this.previews.delete(token);this.pump();return id
  }
  private async authorized(job:ComicIngestJob){
    if(job.requiresRevalidation)throw new Error('从备份恢复的任务需重新解析作品并选择目录')
    const grant=JSON.parse(await fs.readFile(this.grantFile(job.id),'utf8')) as Grant
    if(grant.version!==1||grant.jobId!==job.id||grant.operationId!==job.operationId||grant.workId!==job.workId||grant.directory!==job.directory||grant.root.path!==job.root)throw new Error('任务缺少本机目录授权，请重新解析作品')
    if(grant.existing){const now=await comicRoot(grant.existing.path);if(now.dev!==grant.existing.dev||now.ino!==grant.existing.ino)throw new Error('原作品目录已变化，请核对')}
    return {grant,stage:await ComicStage.recover(grant.root,job.id,job.operationId,job.workId)}
  }
  private pump(){
    if(this.active||this.closing||!this.deps.allowed())return
    const job=[...this.jobs.values()].find(j=>j.status==='queued'&&this.visible(j));if(!job)return
    const controller=new AbortController(),active={id:job.id,controller,settled:Promise.resolve()};this.active=active
    active.settled=imageOperation(()=>this.run(job,controller)).catch(error=>{job.status='failed';job.error='任务记录未能保存：'+(error as Error).message;this.deps.jobsChanged()}).finally(()=>{if(this.active===active)this.active=null;this.pump()})
  }
  private async run(job:ComicIngestJob,controller:AbortController){
    const signal=controller.signal;let verifier:ReturnType<Dependencies['verifier']>|undefined,release:(()=>unknown)|undefined,writes=Promise.resolve(),writeError:unknown
    let progressTimer:ReturnType<typeof setTimeout>|undefined,flushProgress=async(_force=false)=>{}
    job.status='running';job.error='';this.save(job)
    try{
      verifier=this.deps.verifier()
      const verify=verifier.verify
      const {grant,stage}=await this.authorized(job)
      if(job.resourceId)release=lockImageFiles(job.resourceId)
      const index=async()=>{
        job.phase='indexing';this.save(job)
        const scan=(await scanImageImport(stage.destination,'comic',false))[0]
        if(!scan||scan.warnings.length)throw new Error('漫画已落盘，扫描未完整完成，请重试登记')
        const item=this.library.register(scan);job.resourceId=item.id
        if(!grant.existing&&job.groupId)this.library.update(item.id,{groupId:job.groupId})
        this.deps.changed()
      }
      if(!['placed','done'].includes(stage.intent.phase)&&stage.intent.phase!=='prepared'){
        let manifest=await readImageManifest(stage.payload,job.workId,'jm');if(!manifest)throw new Error('任务暂存清单缺失，请核对')
        if(manifest.catalogFingerprint!==job.catalogFingerprint)throw new Error('任务清单与来源目录不一致')
        // A chapter rename may have finished before its journal/DB write.
        if(stage.intent.merge)await imageOperation(()=>stage.supplement(manifest!,verify,index,true))
        const commitReady=async()=>{
          if(!grant.existing)return
          for(const chapter of manifest!.chapters){
            if(stage.intent.chapters.some(c=>c.id===chapter.id&&c.placed)||!chapter.pageIds.every(id=>manifest!.pages[chapter.id+':'+id]))continue
            const partial:ImageManifestV2={...manifest!,selectionComplete:true,chapters:[chapter],pages:Object.fromEntries(chapter.pageIds.map(id=>[chapter.id+':'+id,manifest!.pages[chapter.id+':'+id]]))}
            await imageOperation(()=>stage.supplement(partial,verify,async()=>{job.completedChapters=stage.intent.chapters.filter(c=>c.placed).length;await index()},false,false))
            job.phase='downloading';this.save(job)
          }
        }
        const requests=[];job.processed=0
        for(const chapter of manifest.chapters){
          if(stage.intent.chapters.some(c=>c.id===chapter.id&&c.placed)){job.processed+=chapter.pageIds.length;continue}
          const skip:string[]=[]
          for(const [i,id] of chapter.pageIds.entries()){
            signal.throwIfAborted();const key=chapter.id+':'+id,file=chapter.directory+'/'+String(i+1).padStart(5,'0')+'.png'
            let page=manifest.pages[key]
            if(!page){
              // Recover a renamed, complete page whose event was lost at process exit.
              const bytes=await readManifestPage(stage.payload,file).catch(e=>{if(e.code!=='ENOENT')throw e;return null})
              if(bytes)page={file,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
            }
            if(page){await verify(stage.payload,page);manifest.pages[key]=page;skip.push(id);job.processed++}
          }
          requests.push({id:chapter.id,directory:chapter.directory,pageIds:chapter.pageIds,skip})
        }
        await writeComicJson(path.join(stage.payload,'.baoyi-image.json'),manifest)
        await commitReady()
        job.phase='downloading';this.save(job)
        let dirtyPages=0,lastCheckpoint=Date.now()
        const completed=new Map(manifest.chapters.map(chapter=>[chapter.id,chapter.pageIds.filter(id=>!!manifest!.pages[chapter.id+':'+id]).length]))
        flushProgress=async(force=false)=>{
          if(!dirtyPages||!force&&dirtyPages<5&&Date.now()-lastCheckpoint<1500)return
          clearTimeout(progressTimer);progressTimer=undefined
          await writeComicJson(path.join(stage.payload,'.baoyi-image.json'),manifest)
          dirtyPages=0;lastCheckpoint=Date.now();this.save(job)
        }
        if(requests.some(c=>c.skip.length!==c.pageIds.length)){
          if(job.retryNotBefore>Date.now())throw new ComicSourceError('rate_limited','来源限流，请到时间后重试',job.retryNotBefore)
          const onPage=(page:ComicPageResult)=>{
            writes=writes.then(async()=>{
              if(writeError)return
              const chapter=manifest!.chapters.find(c=>c.id===page.chapterId),position=chapter?.pageIds.indexOf(page.pageId)??-1
              if(!chapter||position<0||page.file!==chapter.directory+'/'+String(position+1).padStart(5,'0')+'.png')throw new Error('来源页面与所选章节不一致')
              await verify(stage.payload,page)
              const key=page.chapterId+':'+page.pageId;if(!manifest!.pages[key]){job.processed++;completed.set(chapter.id,(completed.get(chapter.id)||0)+1)}
              manifest!.pages[key]={file:page.file,size:page.size,sha256:page.sha256}
              dirtyPages++;job.current=chapter.title
              const chapterDone=completed.get(chapter.id)===chapter.pageIds.length
              await flushProgress(chapterDone)
              if(dirtyPages&&!progressTimer)progressTimer=setTimeout(()=>{
                progressTimer=undefined
                writes=writes.then(()=>flushProgress(true)).catch(error=>{writeError=error;controller.abort(error)})
              },Math.max(1,1500-(Date.now()-lastCheckpoint)))
              if(chapterDone)await commitReady()
            }).catch(error=>{writeError=error;controller.abort(error)})
          }
          await this.deps.runtime(grant.proxy).download(job.id,job.workId,stage.payload,requests,signal,onPage)
          await writes;if(writeError)throw writeError
        }
        signal.throwIfAborted();manifest.selectionComplete=true;await writeComicJson(path.join(stage.payload,'.baoyi-image.json'),manifest)
        job.phase='verifying';this.save(job)
        await imageOperation(async()=>{
          if(grant.existing){await stage.supplement(manifest!,verify,async()=>{job.completedChapters=stage.intent.chapters.filter(c=>c.placed).length;await index()});await index()}
          else {await stage.place(verify);job.phase='placed';this.save(job);await index()}
          await stage.finish()
        })
      }else await imageOperation(async()=>{await stage.place(verify);await index();await stage.finish()})
      job.status='success';job.phase='done';job.processed=job.total;job.completedChapters=job.selectedChapters.length;job.manifestDigest=stage.intent.manifestDigest;job.current='';job.error=''
      this.save(job)
      // The committed DB state must precede cleanup. Unknown leftovers stay put.
      try{await stage.cleanFinished()}catch{job.current='作品已入库；暂存记录未清理，可稍后核对'}
    }catch(error){
      await writes
      if(!['paused','cancelled'].includes(job.status)){job.status='failed';job.error=(writeError||error as Error) instanceof Error?((writeError||error) as Error).message:'漫画摄入失败'}
      if(error instanceof ComicSourceError){job.errorCode=error.code;job.retryNotBefore=error.retryAt}
    }finally{
      clearTimeout(progressTimer)
      await writes
      try{await flushProgress(true)}catch(error){job.status='failed';job.error='暂存进度保存失败：'+(error as Error).message}
      await verifier?.close();release?.();this.save(job)
    }
  }
  async stop(id:string,status:'paused'|'cancelled'='paused'){
    const job=this.get(id);if(job.status==='success')return
    job.status=status;job.error='';this.save(job)
    if(this.active?.id===id){this.active.controller.abort(new Error('已停止，已完成页面保留'));await this.active.settled}
  }
  async retry(id:string,proxyInput?:ComicProxy){
    this.check();const job=this.get(id);if(['queued','running','success'].includes(job.status))return
    if(this.maintaining.has(id))throw new Error('正在核验或清理该任务，请稍候')
    if(this.active?.id===id)await this.active.settled
    const {grant}=await this.authorized(job)
    if(proxyInput){grant.proxy=comicProxy(proxyInput);await writeComicJson(this.grantFile(id),grant)}
    job.status='queued';job.error='';this.save(job);this.pump()
  }
  async revalidate(id:string,token:string,rootPath:string){
    if(this.creating)throw new Error('正在核验另一项漫画任务')
    if(this.maintaining.has(id))throw new Error('正在清理该任务，请稍候')
    this.creating=true
    this.maintaining.add(id)
    try{await imageOperation(async()=>{
      this.check();const job=this.get(id),preview=this.previews.get(token)
      if(['running','queued'].includes(job.status)||this.active?.id===id)throw new Error('请先暂停任务')
      if(!preview||Date.now()-preview.at>1800000||preview.catalog.workId!==job.workId)throw new Error('请重新解析原作品')
      for(const id of job.selectedChapters){
        const before=job.catalog.chapters.find(c=>c.id===id),after=preview.catalog.chapters.find(c=>c.id===id)
        if(!before||!after||JSON.stringify(before.pageIds)!==JSON.stringify(after.pageIds))throw new Error('来源章节已变化，保留原下载，请核对后另建任务')
      }
      const root=await comicRoot(rootPath)
      if(root.path.toLowerCase()!==path.resolve(job.root).toLowerCase())throw new Error('请选择任务原根目录；暂存不会自动迁移')
      const stage=await ComicStage.reauthorize(root,job.id,job.workId)
      if(stage.intent.directory!==job.directory)throw new Error('任务提交目录与备份不一致')
      const verifier=this.deps.verifier(),release=job.resourceId?lockImageFiles(job.resourceId):()=>{}
      try{
        let existing:ComicRoot|null=null
        if(stage.intent.existingDigest){
          existing=await comicRoot(stage.destination)
          const current=await stage.verified(stage.destination,verifier.verify),digest=comicDigest(current)
          if(![stage.intent.existingDigest,stage.intent.merge?.before,stage.intent.merge?.after].includes(digest))throw new Error('原作品清单已变化，请核对')
        }
        const payload=await fs.lstat(stage.payload).catch(e=>{if(e.code!=='ENOENT')throw e;return null})
        if(payload){
          await comicRoot(stage.payload)
          const manifest=await readImageManifest(stage.payload,job.workId,'jm'),expected=emptyComicManifest(job.catalog,job.selectedChapters)
          if(!manifest||manifest.catalogFingerprint!==job.catalogFingerprint||JSON.stringify(manifest.chapters)!==JSON.stringify(expected.chapters))throw new Error('暂存章节与备份不一致')
          for(const chapter of manifest.chapters){
            const inDestination=stage.intent.chapters.some(c=>c.id===chapter.id&&c.placed)||!!stage.intent.merge&&!(await fs.stat(path.join(stage.payload,chapter.directory)).catch(cause => { if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null; throw cause }))
            for(const pageId of chapter.pageIds){const page=manifest.pages[chapter.id+':'+pageId];if(page)await verifier.verify(inDestination?stage.destination:stage.payload,page)}
          }
        }else{
          if(!['prepared','placed','done'].includes(stage.intent.phase))throw new Error('任务暂存目录缺失，请核对')
          const manifest=await stage.verified(stage.destination,verifier.verify)
          if(comicDigest(manifest)!==stage.intent.manifestDigest)throw new Error('已落盘作品与任务不一致')
        }
        this.check()
        const grant:Grant={version:1,jobId:id,operationId:stage.intent.operationId,root,directory:job.directory,workId:job.workId,proxy:preview.proxy,existing}
        await fs.mkdir(this.deps.authorizationDirectory,{recursive:true});await writeComicJson(this.grantFile(id),grant)
        job.operationId=grant.operationId;job.requiresRevalidation=false;job.status='queued';job.error='';this.save(job);this.previews.delete(token)
      }finally{await verifier.close();release()}
    })}finally{this.creating=false;this.maintaining.delete(id)}
    this.pump()
  }
  async clean(id:string){
    this.check();const job=this.get(id)
    if(job.status==='success')throw new Error('任务已完成，可直接移除记录')
    if(job.requiresRevalidation)throw new Error('请先重新核验原目录；备份不授予清理权限')
    if(this.maintaining.has(id))throw new Error('正在核验或清理该任务，请稍候')
    this.maintaining.add(id)
    try{
    await this.stop(id,'cancelled')
    await imageOperation(async()=>{
      const {stage}=await this.authorized(job),verifier=this.deps.verifier()
      try{await stage.cleanPending(verifier.verify)}finally{await verifier.close()}
      await fs.unlink(this.grantFile(id));this.removeRecord(id)
    })
    }finally{this.maintaining.delete(id)}
  }
  private removeRecord(id:string){this.jobs.delete(id);this.deps.db.prepare('DELETE FROM image_download_jobs WHERE id=?').run(id);this.deps.jobsChanged()}
  async logs(id:string){this.get(id);const entries=await this.log.read(id);this.get(id);return entries}
  async dismiss(id:string){const job=this.get(id);if(['running','queued'].includes(job.status)||this.active?.id===id||this.maintaining.has(id))throw new Error('请等待当前操作完成');this.removeRecord(id)}
  async stopAll(){this.cancelPreview();this.closing=true;for(const job of this.jobs.values())if(['queued','running'].includes(job.status)){job.status='paused';this.save(job)}const active=this.active;active?.controller.abort(new Error('漫画摄入已暂停'));await active?.settled;await this.log.flush()}
  reopen(){this.closing=false}
}
