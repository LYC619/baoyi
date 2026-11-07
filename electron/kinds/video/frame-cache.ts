import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import type {SqlDb} from '../../services/schema.ts'
import type {VideoFrameState} from '../../../src/types/video-preview.ts'
import {frameFingerprint,frameFfmpeg,generateFrames,type FrameGenerated} from './frame-generator.ts'
interface Options {
  db:SqlDb;root:string;file:(token:string)=>Promise<string>;ffmpeg:()=>{file:string;roots:string[]};changed:(state:VideoFrameState)=>void
  limit?:number;generate?:typeof generateFrames;locate?:typeof frameFfmpeg
}
interface Job {hash:string;file:string;controller:AbortController;subscribers:Set<string>;completed:number;preview?:FrameGenerated}
export class VideoFrameCache {
  private options:Options
  private subscriptions=new Map<string,{token:string;hash:string}>()
  private jobs=new Map<string,Job>()
  private queue:string[]=[]
  private active:Job|null=null
  private completion:Promise<void>=Promise.resolve()
  private stopped=false
  private clearing=false
  private initialized:Promise<void>
  constructor(options:Options){
    this.options=options
    options.db.exec("CREATE TABLE IF NOT EXISTS video_frame_cache(id TEXT PRIMARY KEY,state TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,accessed INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '',retry_at INTEGER NOT NULL DEFAULT 0,manifest TEXT NOT NULL DEFAULT '{}')")
    options.db.prepare("DELETE FROM video_frame_cache WHERE state IN ('queued','running')").run()
    this.initialized=this.reconcile()
  }
  private async reconcile(){
    await fs.mkdir(this.options.root,{recursive:true})
    const known=new Set((this.options.db.prepare('SELECT id FROM video_frame_cache').all() as any[]).map(row=>row.id))
    for(const entry of await fs.readdir(this.options.root,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()&&(entry.name==='.tmp'||/^[a-f0-9]{64}$/.test(entry.name)&&!known.has(entry.name)))await fs.rm(path.join(this.options.root,entry.name),{recursive:true,force:true})
  }
  private directory(hash:string){if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('预览缓存编号无效');return path.join(this.options.root,hash)}
  private row(hash:string){return this.options.db.prepare('SELECT * FROM video_frame_cache WHERE id=?').get(hash) as any}
  private state(id:string):VideoFrameState{
    const subscription=this.subscriptions.get(id),row=subscription&&this.row(subscription.hash),preview=subscription&&this.jobs.get(subscription.hash)?.preview,manifest:Partial<FrameGenerated>=row?.state==='running'?preview||{}:row?JSON.parse(row.manifest):{}
    return {id,status:row?.state||'failed',url:row?.state==='ready'?'baoyi://video-frame/'+id+'?stage=ready':preview&&row?.state==='running'?'baoyi://video-frame/'+id+'?stage=preview':'',times:manifest.times||[],duration:manifest.duration||0,partial:!!manifest.partial,message:row?.error||manifest.message||'',completed:subscription?this.jobs.get(subscription.hash)?.completed||manifest.times?.length||0:0,audioTracks:manifest.audioTracks??null,videoCodec:manifest.videoCodec||''}
  }
  private notify(hash:string){for(const [id,value]of this.subscriptions)if(value.hash===hash)this.options.changed(this.state(id))}
  async subscribe(token:string,retry=false):Promise<VideoFrameState>{
    await this.initialized
    if(this.stopped)throw new Error('预览服务已关闭')
    if(this.clearing)throw new Error('正在清理预览缓存，请稍后重试')
    const file=await this.options.file(token),fingerprint=await frameFingerprint(file);await this.options.file(token)
    if(this.stopped)throw new Error('预览服务已关闭')
    if(this.clearing)throw new Error('正在清理预览缓存，请稍后重试')
    const hash=fingerprint.hash
    if(this.jobs.get(hash)?.controller.signal.aborted){await this.completion;return this.subscribe(token,retry)}
    const id=randomUUID();this.subscriptions.set(id,{token,hash})
    let row=this.row(hash)
    if(row?.state==='ready'){try{const stat=await fs.stat(path.join(this.directory(hash),'sprite.jpg'));if(stat.size!==row.bytes)throw new Error('缓存大小变化')}catch{this.options.db.prepare('DELETE FROM video_frame_cache WHERE id=?').run(hash);row=undefined}}
    if(this.stopped||!this.subscriptions.has(id))throw new Error('预览已关闭')
    if(this.clearing){this.unsubscribe(id);throw new Error('正在清理预览缓存，请稍后重试')}
    if(row?.state==='ready'||row?.state==='failed'&&!retry&&row.retry_at>Date.now()){this.options.db.prepare('UPDATE video_frame_cache SET accessed=? WHERE id=?').run(Date.now(),hash);return this.state(id)}
    const existing=this.jobs.get(hash)
    if(existing)existing.subscribers.add(id)
    else{
      const job={hash,file,controller:new AbortController(),subscribers:new Set([id]),completed:0};this.jobs.set(hash,job);this.queue.push(hash)
      this.options.db.prepare("INSERT INTO video_frame_cache(id,state,accessed) VALUES(?,'queued',?) ON CONFLICT(id) DO UPDATE SET state='queued',accessed=excluded.accessed,error='',retry_at=0").run(hash,Date.now());void this.pump()
    }
    return this.state(id)
  }
  unsubscribe(id:string){const subscription=this.subscriptions.get(id);if(!subscription)return;this.subscriptions.delete(id);const job=this.jobs.get(subscription.hash);if(job){job.subscribers.delete(id);if(!job.subscribers.size){job.controller.abort(new Error('已离开预览'));if(this.active!==job){this.queue=this.queue.filter(hash=>hash!==job.hash);this.jobs.delete(job.hash);this.options.db.prepare('DELETE FROM video_frame_cache WHERE id=?').run(job.hash)}}}}
  async image(id:string){
    const subscription=this.subscriptions.get(id);if(!subscription)throw new Error('预览已关闭')
    await this.options.file(subscription.token)
    if(this.stopped||!this.subscriptions.has(id))throw new Error('预览已关闭')
    const row=this.row(subscription.hash)
    if(row?.state==='running'&&this.jobs.get(subscription.hash)?.preview)return path.join(this.options.root,'.tmp',subscription.hash,'preview.jpg')
    if(row?.state!=='ready')throw new Error('预览尚未完成')
    this.options.db.prepare('UPDATE video_frame_cache SET accessed=? WHERE id=?').run(Date.now(),subscription.hash)
    return path.join(this.directory(subscription.hash),'sprite.jpg')
  }
  async readImage(id:string,read:(file:string)=>Promise<Uint8Array<ArrayBuffer>>=file=>fs.readFile(file)){
    const file=await this.image(id),bytes=await read(file).catch(async error=>{if(error.code!=='ENOENT')throw error;return read(await this.image(id))})
    // A privacy change or unsubscribe can happen while the file read yields.
    await this.image(id)
    return bytes
  }
  stats(){const row=this.options.db.prepare("SELECT coalesce(sum(bytes),0) bytes,count(*) items FROM video_frame_cache WHERE state='ready'").get() as any;return {...row,limit:this.options.limit??1024**3}}
  private async evict(extra:number){
    let bytes=this.stats().bytes
    const pinned=new Set([...this.subscriptions.values()].map(value=>value.hash)),rows=this.options.db.prepare("SELECT id,bytes FROM video_frame_cache WHERE state='ready' ORDER BY accessed").all() as any[]
    for(const row of rows){if(bytes+extra<=this.stats().limit)break;if(pinned.has(row.id))continue;await fs.rm(this.directory(row.id),{recursive:true,force:true});this.options.db.prepare('DELETE FROM video_frame_cache WHERE id=?').run(row.id);bytes-=row.bytes}
    if(bytes+extra>this.stats().limit)throw new Error('预览缓存已满；关闭其他预览或清理缓存后重试')
  }
  private async pump(){
    if(this.active||this.stopped)return
    const hash=this.queue.shift(),job=hash&&this.jobs.get(hash);if(!job)return
    this.active=job;let completed!:()=>void;this.completion=new Promise(resolve=>completed=resolve)
    const stage=path.join(this.options.root,'.tmp',job.hash),db=this.options.db
    try{
      job.controller.signal.throwIfAborted();db.prepare("UPDATE video_frame_cache SET state='running' WHERE id=?").run(job.hash);this.notify(job.hash)
      await fs.mkdir(this.options.root,{recursive:true});const disk=await fs.statfs(this.options.root);if(disk.bavail*disk.bsize<128*1024**2)throw new Error('磁盘可用空间不足，暂停生成预览')
      const settings=this.options.ffmpeg(),ffmpeg=await (this.options.locate||frameFfmpeg)(settings.file,settings.roots)
      job.controller.signal.throwIfAborted();if(!ffmpeg)throw new Error('未找到 FFmpeg；可直接试看，或在下载与缓存设置选择 ffmpeg.exe')
      await fs.rm(stage,{recursive:true,force:true})
      const result=await (this.options.generate||generateFrames)({file:job.file,directory:stage,ffmpeg,duration:0,signal:job.controller.signal,progress:value=>{job.completed=value;this.notify(job.hash)},preview:async value=>{
        job.controller.signal.throwIfAborted();if(value.bytes>4*1024**2)throw new Error('预览超出单项 4 MiB 上限')
        if((await frameFingerprint(job.file)).hash!==job.hash)throw new Error('视频文件在处理期间发生变化，请稍后重试')
        job.preview=value;this.notify(job.hash)
      }})
      job.controller.signal.throwIfAborted();if((await frameFingerprint(job.file)).hash!==job.hash)throw new Error('视频文件在处理期间发生变化，请稍后重试')
      if(result.bytes>4*1024**2)throw new Error('预览超出单项 4 MiB 上限')
      await this.evict(result.bytes);job.controller.signal.throwIfAborted();await fs.rm(this.directory(job.hash),{recursive:true,force:true});await fs.rename(stage,this.directory(job.hash))
      job.controller.signal.throwIfAborted()
      db.prepare("UPDATE video_frame_cache SET state='ready',bytes=?,accessed=?,manifest=?,error='' WHERE id=?").run(result.bytes,Date.now(),JSON.stringify(result),job.hash)
      await fs.unlink(path.join(this.directory(job.hash),'preview.jpg')).catch(error=>{if(error.code!=='ENOENT')throw error})
    }catch(error){
      if(job.controller.signal.aborted){await fs.rm(this.directory(job.hash),{recursive:true,force:true}).catch(()=>{});db.prepare('DELETE FROM video_frame_cache WHERE id=?').run(job.hash)}
      else{db.prepare("UPDATE video_frame_cache SET state='failed',error=?,retry_at=? WHERE id=?").run((error as Error).message,Date.now()+600000,job.hash)}
    }finally{await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});this.jobs.delete(job.hash);this.active=null;completed();this.notify(job.hash);void this.pump()}
  }
  async clear(){
    if(this.clearing)throw new Error('正在清理预览缓存')
    this.clearing=true
    try{
    await this.initialized
    if(this.active||this.queue.length)throw new Error('请先关闭所有预览，再清理缓存')
    for(const id of [...this.subscriptions.keys()]){this.options.changed({...this.state(id),status:'failed',url:'',message:'预览缓存已清理，可重新预览'});this.unsubscribe(id)}
    for(const row of this.options.db.prepare('SELECT id FROM video_frame_cache').all() as any[])await fs.rm(this.directory(row.id),{recursive:true,force:true})
    this.options.db.prepare('DELETE FROM video_frame_cache').run()
    }finally{this.clearing=false}
  }
  async close(){this.stopped=true;for(const id of [...this.subscriptions.keys()])this.unsubscribe(id);this.queue=[];await Promise.all([this.completion,this.initialized]);this.jobs.clear()}
}
