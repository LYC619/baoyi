import fs from 'node:fs/promises'
import path from 'node:path'
import type {ComicIngestJob,ComicLogEntry} from '../../../src/types/comic-ingest.ts'
const maximum=5*1024**2
export class ComicLog {
  private root:string;private tail=Promise.resolve();private previous=new Map<string,string>()
  constructor(root:string){this.root=root}
  private file(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('漫画任务编号无效');return path.join(this.root,id+'.jsonl')}
  append(job:ComicIngestJob,unfinished:()=>Set<string>){
    const entry:ComicLogEntry={at:Date.now(),status:job.status,phase:job.phase,processed:job.processed,total:job.total,completedChapters:job.completedChapters,errorCode:job.errorCode}
    const stamp=JSON.stringify([entry.status,entry.phase,entry.completedChapters,entry.errorCode,Math.floor(entry.processed/25)])
    if(this.previous.get(job.id)===stamp)return;this.previous.set(job.id,stamp)
    this.tail=this.tail.catch(()=>{}).then(async()=>{
      await fs.mkdir(this.root,{recursive:true});const file=this.file(job.id),line=JSON.stringify(entry)+'\n',stat=await fs.stat(file).catch(e=>{if(e.code!=='ENOENT')throw e;return null})
      if(stat&&stat.size+Buffer.byteLength(line)>maximum){
        const handle=await fs.open(file,'r'),buffer=Buffer.alloc(maximum/2)
        try{const {bytesRead}=await handle.read(buffer,0,buffer.length,stat.size-buffer.length);const text=buffer.subarray(0,bytesRead).toString('utf8');await fs.writeFile(file,text.slice(text.indexOf('\n')+1))}finally{await handle.close()}
      }
      await fs.appendFile(file,line)
      if(!['running','queued'].includes(entry.status)){
        const active=unfinished(),finished=[]
        for(const name of await fs.readdir(this.root)){const id=name.slice(0,-6);if(/^[a-f0-9-]{36}\.jsonl$/.test(name)&&!active.has(id)){const stat=await fs.lstat(path.join(this.root,name));if(stat.isFile()&&!stat.isSymbolicLink())finished.push({name,at:stat.mtimeMs})}}
        for(const item of finished.sort((a,b)=>b.at-a.at).slice(20))await fs.unlink(path.join(this.root,item.name))
      }
    }).catch(()=>{}) // Diagnostic disk errors never turn a saved work into failure.
  }
  async read(id:string):Promise<ComicLogEntry[]>{
    await this.tail;const file=this.file(id),handle=await fs.open(file,'r').catch(e=>{if(e.code!=='ENOENT')throw e;return null});if(!handle)return []
    try{const stat=await handle.stat(),buffer=Buffer.alloc(Math.min(stat.size,128*1024)),start=Math.max(0,stat.size-buffer.length);await handle.read(buffer,0,buffer.length,start);const text=buffer.toString('utf8');return (start?text.slice(text.indexOf('\n')+1):text).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))}finally{await handle.close()}
  }
  async flush(){await this.tail}
}
