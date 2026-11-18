import fs from 'node:fs/promises'
import path from 'node:path'

const prefix='data:image/jpeg;base64,'
const valid=(bytes:Buffer)=>bytes.length>4&&bytes.length<=40000&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9

/** Disposable thumbnails only. Never accepts a path or a remote URL from the renderer. */
export class ComicCoverCache {
  private tail:Promise<unknown>=Promise.resolve()
  private entries=new Map<string,{size:number;at:number}>()
  private initialized=false
  private directory:string
  private options:{ttl:number;count:number;bytes:number}
  constructor(directory:string,options={ttl:24*60*60*1000,count:512,bytes:20*1024*1024}){this.directory=directory;this.options=options}
  private async prepare(){
    await fs.mkdir(this.directory,{recursive:true})
    const stat=await fs.lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('封面缓存目录不可用')
    if(this.initialized)return
    for(const name of await fs.readdir(this.directory)){
      if(!/^[1-9]\d{0,11}\.jpg$/.test(name))continue
      const entry=await fs.lstat(path.join(this.directory,name))
      if(entry.isFile()&&!entry.isSymbolicLink())this.entries.set(name,{size:entry.size,at:entry.mtimeMs})
    }
    this.initialized=true;await this.prune()
  }
  private async prune(){
    let bytes=[...this.entries.values()].reduce((sum,item)=>sum+item.size,0)
    for(const [name,entry] of [...this.entries].sort((a,b)=>a[1].at-b[1].at)){
      if(Date.now()-entry.at<=this.options.ttl&&this.entries.size<=this.options.count&&bytes<=this.options.bytes)break
      await fs.unlink(path.join(this.directory,name));this.entries.delete(name);bytes-=entry.size
    }
  }
  private serial<T>(action:()=>Promise<T>):Promise<T>{const next=this.tail.then(action);this.tail=next.catch(() => { /* 原始 Promise 的错误已交给调用方；这里只释放队列或监听。 */ });return next}
  async get(id:string,signal:AbortSignal,load:()=>Promise<string>):Promise<string>{
    if(!/^[1-9]\d{0,11}$/.test(id))throw new Error('作品编号无效')
    const name=id+'.jpg',file=path.join(this.directory,name)
    const hit=await this.serial(async()=>{
      await this.prepare();signal.throwIfAborted()
      const stat=await fs.lstat(file).catch(cause => { if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null; throw cause })
      if(!stat||!stat.isFile()||stat.isSymbolicLink()||stat.size>40000||Date.now()-stat.mtimeMs>this.options.ttl)return ''
      const bytes=await fs.readFile(file);return valid(bytes)?prefix+bytes.toString('base64'):''
    }).catch(()=> '')
    signal.throwIfAborted();if(hit)return hit
    const value=await load();signal.throwIfAborted()
    if(!value.startsWith(prefix))return value
    const bytes=Buffer.from(value.slice(prefix.length),'base64');if(!valid(bytes))return ''
    await this.serial(async()=>{
      await this.prepare();signal.throwIfAborted()
      // Removing only this cache entry also prevents following an existing symlink.
      await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error})
      const handle=await fs.open(file,'wx')
      try{await handle.writeFile(bytes)}finally{await handle.close()}
      this.entries.set(name,{size:bytes.length,at:Date.now()});await this.prune()
    })
    signal.throwIfAborted();return value
  }
}
