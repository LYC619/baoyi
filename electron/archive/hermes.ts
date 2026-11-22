import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {archiveRunSlot} from './run-slot.ts'

export interface HermesEvent {sessionId:string;event:string;[key:string]:unknown}
export interface HermesTool {name:string;description:string;parameters:Record<string,unknown>}
interface Options {
  runtime:string;bridge:string;home:string
  controlTimeoutMs?:number
  event:(event:HermesEvent)=>void
  execute:(sessionId:string,name:string,args:Record<string,unknown>)=>Promise<string>
}

/** Owns only the subprocess protocol. Hermes owns the agent and its history. */
export class HermesRuntime {
  private child:ChildProcessWithoutNullStreams|null=null
  private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
  private startup:Promise<void>|null=null
  private closing:Promise<void>|null=null
  private closed=false
  private stderr=''
  private options:Options
  constructor(options:Options){this.options=options}

  start():Promise<void>{
    if(this.closed)return Promise.reject(new Error('归档助理已关闭，请重新打开'))
    if(this.startup)return this.startup
    const attempt = Promise.resolve().then(() => this.startChild())
    this.startup = attempt
    void attempt.catch(() => { if (this.startup === attempt) this.startup = null })
    return attempt
  }
  private startChild(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('归档助理已关闭，请重新打开'))
    const {runtime,bridge,home}=this.options
    const python=path.join(runtime,'python','python.exe')
    if(!fs.existsSync(python)||!fs.existsSync(path.join(runtime,'hermes','run_agent.py')))return Promise.reject(new Error('归档助理运行组件缺失，请使用完整的抱一程序目录'))
    fs.mkdirSync(home,{recursive:true})
    this.stderr=''
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PYTHONPATH','PYTHONHOME','PYTHONSTARTUP'].includes(key.toUpperCase())))
    return new Promise((resolve,reject)=>{
      const child=spawn(python,['-I','-X','utf8','-u',bridge,home,runtime],{
        cwd:home,windowsHide:true,stdio:['pipe','pipe','pipe'],
        env:{...env,PYTHONNOUSERSITE:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',HERMES_HOME:home},
      })
      this.child=child
      const disconnect = (error: Error) => {
        clearTimeout(timer)
        reject(error)
        if (this.child !== child) return
        this.child = null
        this.startup = null
        for (const request of this.pending.values()) request.reject(error)
        this.pending.clear()
      }
      const timer=setTimeout(()=>{disconnect(new Error('归档助理启动超时，请重试'));child.kill()},90000)
      const lines=createInterface({input:child.stdout})
      lines.on('line',line=>{
        if (this.child !== child) return
        let frame:any
        try{frame=JSON.parse(line)}catch{this.stderr=(this.stderr+'\n'+line).slice(-4000);return}
        if(frame.type==='ready'){clearTimeout(timer);resolve()}
        else if(frame.type==='response'){
          const pending=this.pending.get(frame.id)
          if(pending){this.pending.delete(frame.id);frame.error?pending.reject(new Error(frame.error)):pending.resolve(frame.value)}
        }else if(frame.type==='event')this.options.event(frame)
        else if(frame.type==='host_tool'){
          const respond=(result:string)=>{if(this.child===child&&!child.stdin.destroyed&&!child.stdin.writableEnded)child.stdin.write(JSON.stringify({type:'tool_result',id:frame.id,result})+'\n')}
          void this.options.execute(frame.sessionId,frame.name,frame.args).then(respond,error=>respond(JSON.stringify({error:(error as Error).message})))
        }
      })
      child.stderr.on('data',chunk=>{this.stderr=(this.stderr+String(chunk)).slice(-4000)})
      child.stdin.on('error',()=>child.kill())
      child.on('error',disconnect)
      child.on('close',code=>{
        clearTimeout(timer);lines.close()
        const error=new Error(`归档助理已退出${code?`（${code}）`:''}，已保存的记录仍保留，请重新打开助理。`)
        disconnect(error)
      })
    })
  }
  async request<T=any>(method:string,args:Record<string,unknown>={}):Promise<T>{
    await this.start()
    const child=this.child,id=randomUUID()
    if(this.closed||!child||child.stdin.destroyed||child.stdin.writableEnded)throw new Error('归档助理连接已关闭，请重试')
    const payload = JSON.stringify({id,method,args})+'\n'
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<T>((resolve,reject) => {
        this.pending.set(id,{resolve,reject})
        if (method !== 'run') timer = setTimeout(() => reject(new Error('归档助理控制请求超时，请重试')), this.options.controlTimeoutMs ?? 20_000)
        child.stdin.write(payload, error => { if (error) reject(new Error('归档助理连接已断开，请重试')) })
      })
    } finally {
      clearTimeout(timer)
      this.pending.delete(id)
    }
  }
  run<T=any>(args:Record<string,unknown>,options:{priority?:'interactive'|'background';signal?:AbortSignal;onStart?:()=>void;cancelGraceMs?:number}={}):Promise<T>{
    return archiveRunSlot.run(async()=>{
      await this.start();options.signal?.throwIfAborted()
      options.onStart?.()
      let grace:ReturnType<typeof setTimeout>|undefined
      const runningChild=this.child
      const cancel=()=>{
        void this.request('cancel').catch(() => { /* best-effort */ })
        // A synchronous HTTP client can ignore Hermes cancellation until its
        // network timeout. Dedicated read-only workflows release the slot anyway.
        if(options.cancelGraceMs!==undefined)grace=setTimeout(()=>{if(this.child===runningChild)runningChild?.kill()},options.cancelGraceMs)
      }
      // Send the run before registering cancellation, so cancel always follows run on stdin.
      const pending=this.request<T>('run',args)
      options.signal?.addEventListener('abort',cancel,{once:true})
      if(options.signal?.aborted)cancel()
      try{const result=await pending;options.signal?.throwIfAborted();return result}
      catch(error){options.signal?.throwIfAborted();throw error}
      finally{clearTimeout(grace);options.signal?.removeEventListener('abort',cancel)}
    },options)
  }
  close():Promise<void>{
    if(this.closing)return this.closing
    this.closed=true
    const child=this.child;if(!child)return Promise.resolve()
    this.closing=new Promise(resolve=>{const timer=setTimeout(()=>child.kill(),5000);timer.unref();child.once('close',()=>{clearTimeout(timer);resolve()})})
    child.stdin.end();return this.closing
  }
}
