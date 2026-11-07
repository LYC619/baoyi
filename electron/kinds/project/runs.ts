import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { SqlDb } from '../../services/schema.ts'
import type { ProjectRun } from '../../../src/types/project-launch.ts'
import { ProjectLaunchProfiles } from './launch-profiles.ts'
import { previewProjectLaunch,projectChildEnvironment } from './launch-resolution.ts'
import { ProjectRunLog } from './run-log.ts'

type Active={run:ProjectRun;child:ChildProcessWithoutNullStreams;done:Promise<void>;io:Promise<void>;log:ProjectRunLog;bytes:number;timer?:ReturnType<typeof setTimeout>;failure:string}
export class ProjectRuns {
  private options:{db:()=>SqlDb;directory:string;python:string;supervisor:string;changed:(run:ProjectRun)=>void}
  private active=new Map<string,Active>()
  private starts=new Map<string,Promise<ProjectRun>>()
  private history=new Map<string,ProjectRun>()
  private ready:Promise<void>
  constructor(options:ProjectRuns['options']){this.options=options;this.ready=this.load()}
  get busy(){return this.active.size>0||this.starts.size>0}
  running(projectId?:string){return projectId?[...this.active.values()].some(a=>a.run.projectId===projectId)||[...this.starts.keys()].some(k=>k.startsWith(projectId+':')):this.busy}
  private async load(){
    await fs.mkdir(this.options.directory,{recursive:true})
    for(const file of await fs.readdir(this.options.directory,{withFileTypes:true})){
      if(!file.isDirectory()||!/^[a-f0-9-]{36}$/.test(file.name))continue
      try{
        const run=JSON.parse(await fs.readFile(path.join(this.options.directory,file.name,'state.json'),'utf8')) as ProjectRun
        if(run.id!==file.name||typeof run.projectId!=='string'||!Array.isArray(run.lines))continue
        if(['starting','running','stopping'].includes(run.status)){run.status='interrupted';run.error='上次抱一退出时中断；可核对配置后重跑';run.endedAt=Date.now();run.pid=null;await this.save(run)}
        this.history.set(run.id,run)
      }catch{/* An incomplete runtime record grants no authority over old PIDs. */}
    }
  }
  async list(projectId?:string):Promise<ProjectRun[]>{await this.ready;return [...this.history.values()].filter(r=>!projectId||r.projectId===projectId).sort((a,b)=>b.startedAt-a.startedAt).map(r=>({...r,lines:[...r.lines]}))}
  private async save(run:ProjectRun){
    const dir=path.join(this.options.directory,run.id);await fs.mkdir(dir,{recursive:true})
    await fs.writeFile(path.join(dir,'state.tmp'),JSON.stringify(run));await fs.rename(path.join(dir,'state.tmp'),path.join(dir,'state.json'))
  }
  private publish(active:Active,immediate=false){
    if(active.timer){if(!immediate)return;clearTimeout(active.timer);active.timer=undefined}
    const emit=()=>{
      active.timer=undefined;const snapshot={...active.run,lines:[...active.run.lines]}
      this.options.changed(snapshot)
      active.io=active.io.then(()=>this.save(snapshot)).catch(error=>{active.failure='运行记录保存失败：'+(error as Error).message})
    }
    if(immediate)emit();else active.timer=setTimeout(emit,250)
  }
  async start(projectId:string,profileId:string,approval?:{stamp:string;remember:boolean}):Promise<ProjectRun>{
    const key=projectId+':'+profileId,existing=this.starts.get(key)
    if(existing)return existing
    const active=[...this.active.values()].find(a=>a.run.projectId===projectId&&a.run.profileId===profileId)
    if(active)return {...active.run,lines:[...active.run.lines]}
    const start=this.launch(projectId,profileId,approval);this.starts.set(key,start)
    try{return await start}finally{this.starts.delete(key)}
  }
  private async launch(projectId:string,profileId:string,approval?:{stamp:string;remember:boolean}):Promise<ProjectRun>{
    await this.ready
    if(process.platform!=='win32')throw new Error('托管脚本当前需要 Windows；其他平台可使用独立终端')
    const preview=await previewProjectLaunch(this.options.db(),projectId,profileId)
    if(preview.profile.kind==='preview')throw new Error('此项是预览地址，请使用打开预览')
    if(!preview.trusted&&approval?.stamp!==preview.stamp)throw new Error('脚本或配置已变化，请查看当前启动内容并确认')
    const profiles=new ProjectLaunchProfiles(this.options.db())
    if(profiles.get(projectId,profileId).revision!==preview.profile.revision)throw new Error('配置已变化，请重新确认')
    if(approval?.remember)profiles.trust(projectId,profileId,preview.profile.revision,preview.stamp)
    const run:ProjectRun={id:randomUUID(),projectId,profileId,profileName:preview.profile.name,profileRevision:preview.profile.revision,status:'starting',startedAt:Date.now(),endedAt:0,pid:null,exitCode:null,previewUrl:preview.profile.url||(preview.profile.port?`http://127.0.0.1:${preview.profile.port}/`:''),lines:[],error:''}
    this.history.set(run.id,run);await this.save(run)
    const env=projectChildEnvironment(),child=spawn(this.options.python,['-I','-S','-u',this.options.supervisor],{stdio:'pipe',windowsHide:true,env})
    let finish!:()=>void,started!:(run:ProjectRun)=>void,failed!:(error:Error)=>void,gotExit=false
    const begun=new Promise<ProjectRun>((resolve,reject)=>{started=resolve;failed=reject})
    const active:Active={run,child,done:new Promise<void>(resolve=>finish=resolve),io:Promise.resolve(),log:new ProjectRunLog(),bytes:0,failure:''}
    this.active.set(run.id,active);this.publish(active,true)
    const timeout=setTimeout(()=>{active.failure='启动等待超过 15 秒';child.stdin.destroy()},15000)
    const output=(bytes:Buffer)=>{
      const lines=active.log.feed(bytes)
      run.lines=[...active.log.lines];run.previewUrl=active.log.previewUrl||run.previewUrl
      if(lines.length&&active.bytes<5*1024*1024){
        const log=lines.map(text=>JSON.stringify({at:Date.now(),text})+'\n').join('')
        if(active.bytes+Buffer.byteLength(log)<=5*1024*1024){active.bytes+=Buffer.byteLength(log);active.io=active.io.then(()=>fs.appendFile(path.join(this.options.directory,run.id,'output.jsonl'),log)).catch(error=>{active.failure='日志保存失败：'+(error as Error).message})}
      }
      this.publish(active)
    }
    createInterface({input:child.stdout}).on('line',line=>{
      try{
        const event=JSON.parse(line)
        if(event.version!==1)throw new Error('进程协议版本不符')
        if(event.type==='started'){clearTimeout(timeout);run.pid=event.pid;run.status='running';this.publish(active,true);started({...run,lines:[...run.lines]})}
        else if(event.type==='output')output(Buffer.from(event.data,'base64'))
        else if(event.type==='stopping'){run.status='stopping';this.publish(active,true)}
        else if(event.type==='error'){active.failure=String(event.message).slice(0,2000)}
        else if(event.type==='exited'){gotExit=true;run.exitCode=event.code;run.status=event.stopped||event.code===0?'exited':'failed'}
      }catch(error){active.failure='运行协议错误：'+(error as Error).message;child.stdin.destroy()}
    })
    child.stderr.on('data',bytes=>{active.failure=(active.failure+bytes.toString('utf8')).slice(-2000)})
    child.stdin.on('error',()=>{/* Close handler reports the final runner status. */})
    child.on('error',error=>{active.failure=error.message})
    child.on('close',async code=>{
      clearTimeout(timeout);active.log.finish();run.lines=[...active.log.lines]
      if(!gotExit)run.status='failed'
      run.error=active.failure||(!gotExit?'进程管理器意外退出，所属任务已停止':run.status==='failed'?`命令退出码 ${run.exitCode??code}`:'')
      if(active.failure)run.status='failed'
      run.endedAt=Date.now();this.publish(active,true)
      failed(new Error(run.error||'命令已结束'))
      try{await active.io;this.active.delete(run.id);await this.prune(projectId)}finally{finish()}
    })
    child.stdin.write(JSON.stringify({version:1,command:preview.command,args:preview.args,cwd:preview.cwd,env})+'\n')
    return begun
  }
  async stop(id:string):Promise<void>{
    const active=this.active.get(id);if(!active)return
    if(active.run.status!=='stopping'){active.run.status='stopping';this.publish(active,true);active.child.stdin.write('{"type":"stop"}\n')}
    await active.done
  }
  async stopAll(){await Promise.allSettled([...this.starts.values()]);await Promise.all([...this.active.keys()].map(id=>this.stop(id)))}
  async last(projectId:string):Promise<ProjectRun|null>{return (await this.list(projectId))[0]||null}
  private async prune(projectId:string){
    const runs=await this.list(projectId)
    for(const run of runs.slice(20))if(!this.active.has(run.id)){
      // IDs originate here or from a directory name checked during load.
      await fs.rm(path.join(this.options.directory,run.id),{recursive:true,force:true}).catch(()=>{})
      this.history.delete(run.id)
    }
  }
}
