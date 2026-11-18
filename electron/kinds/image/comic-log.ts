import fs from 'node:fs/promises'
import path from 'node:path'
import type {ComicIngestJob,ComicLogEntry,JobLogEntry} from '../../../src/types/comic-ingest.ts'
import type {ImageDownloadJob} from '../../../src/types/image.ts'
const maximum=5*1024**2
export class JobLog<Entry extends JobLogEntry = JobLogEntry> {
  private root:string;private prefix:string;private tail=Promise.resolve();private previous=new Map<string,string>()
  constructor(root:string,prefix=''){this.root=root;this.prefix=prefix}
  private file(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('漫画任务编号无效');return path.join(this.root,this.prefix+id+'.jsonl')}
  append(id:string,entry:Entry,stamp:string,unfinished:()=>Set<string>){
    if(this.previous.get(id)===stamp)return;this.previous.set(id,stamp)
    this.tail=this.tail.catch(() => { /* 原始 Promise 的错误已交给调用方；这里只释放队列或监听。 */ }).then(async()=>{
      await fs.mkdir(this.root,{recursive:true});const file=this.file(id),line=JSON.stringify(entry)+'\n',stat=await fs.stat(file).catch(e=>{if(e.code!=='ENOENT')throw e;return null})
      if(stat&&stat.size+Buffer.byteLength(line)>maximum){
        const handle=await fs.open(file,'r'),buffer=Buffer.alloc(maximum/2)
        try{const {bytesRead}=await handle.read(buffer,0,buffer.length,stat.size-buffer.length);const text=buffer.subarray(0,bytesRead).toString('utf8');await fs.writeFile(file,text.slice(text.indexOf('\n')+1))}finally{await handle.close()}
      }
      await fs.appendFile(file,line)
      if(!['running','queued'].includes(entry.status)){
        const active=unfinished(),finished=[]
        for(const name of await fs.readdir(this.root)){const base=name.slice(this.prefix.length),id=base.slice(0,-6);if(name.startsWith(this.prefix)&&/^[a-f0-9-]{36}\.jsonl$/.test(base)&&!active.has(id)){const stat=await fs.lstat(path.join(this.root,name));if(stat.isFile()&&!stat.isSymbolicLink())finished.push({name,at:stat.mtimeMs})}}
        for(const item of finished.sort((a,b)=>b.at-a.at).slice(20))await fs.unlink(path.join(this.root,item.name))
      }
    }).catch(cause=>{console.error('[漫画任务日志]',cause);throw cause})
    void this.tail.catch(()=>{ /* read/flush 和下一次写入持有原始失败，避免未处理的拒绝。 */ })
  }
  async read(id:string):Promise<Entry[]>{
    await this.tail;const file=this.file(id),handle=await fs.open(file,'r').catch(e=>{if(e.code!=='ENOENT')throw e;return null});if(!handle)return []
    try{const stat=await handle.stat(),buffer=Buffer.alloc(Math.min(stat.size,128*1024)),start=Math.max(0,stat.size-buffer.length);await handle.read(buffer,0,buffer.length,start);const text=buffer.toString('utf8');return (start?text.slice(text.indexOf('\n')+1):text).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))}finally{await handle.close()}
  }
  async flush(){await this.tail}
}

export class ComicLog {
  private log:JobLog<ComicLogEntry>
  constructor(root:string){this.log=new JobLog(root)}
  append(job:ComicIngestJob,unfinished:()=>Set<string>){
    const entry:ComicLogEntry={at:Date.now(),status:job.status,phase:job.phase,processed:job.processed,total:job.total,completedChapters:job.completedChapters,errorCode:job.errorCode}
    this.log.append(job.id,entry,JSON.stringify([entry.status,entry.phase,entry.completedChapters,entry.errorCode,Math.floor(entry.processed/25)]),unfinished)
  }
  read(id:string){return this.log.read(id)}
  flush(){return this.log.flush()}
}

export class PicaLog {
  private log:JobLog
  constructor(root:string){this.log=new JobLog(root,'pica-')}
  append(job:ImageDownloadJob,unfinished:()=>Set<string>){
    const entry:JobLogEntry={at:Date.now(),status:job.status,phase:job.progress?.phase||'idle',processed:job.processed,total:job.total,completedChapters:job.completedChapters,errorCode:job.status==='failed'?'DOWNLOAD_FAILED':''}
    this.log.append(job.id,entry,JSON.stringify([entry.status,entry.phase,job.error,job.progress?.retryAt]),unfinished)
  }
  read(id:string){return this.log.read(id)}
  flush(){return this.log.flush()}
}
