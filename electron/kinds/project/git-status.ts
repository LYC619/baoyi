import fs from 'node:fs/promises'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {projectRepoPath,nestedGitRoots} from '../../workspace/project-repositories.ts'
import type {ProjectGitStatus} from '../../../src/types/project.ts'

const exec=promisify(execFile),TTL=30_000
/** Porcelain -z uses destination then source for renames. Never split on newlines. */
export function parseGitStatus(raw:string){
  const records=raw.split('\0'),lines:string[]=[];let changed=0
  for(let i=0;i<records.length;i++){
    const record=records[i];if(!record)continue
    const flags=record.slice(0,2),file=record.slice(3)
    const from=/[RC]/.test(flags)?records[++i]:undefined
    lines.push(`${flags} ${from===undefined?'':JSON.stringify(from)+' → '}${JSON.stringify(file)}`);changed++
  }
  const status=lines.join('\n')
  return {changed,status:status.slice(0,12000),truncated:status.length>12000}
}
const empty=():ProjectGitStatus=>({available:false,branch:'',changed:0,status:'',message:'',readAt:Date.now(),head:'',repoPath:'',candidates:[],truncated:false})
function gitEnvironment(){
  const env:NodeJS.ProcessEnv={GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}
  for(const [key,value] of Object.entries(process.env))if(/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|USERPROFILE|HOME|LOCALAPPDATA|APPDATA|TEMP|TMP)$/i.test(key))env[key]=value
  return env
}
export class ProjectGitCache {
  private cache=new Map<string,ProjectGitStatus>()
  private key(root:string,relative=''){return JSON.stringify([path.resolve(root).toLowerCase(),relative.replaceAll('\\','/')])}
  peek(root:string,relative=''){const value=this.cache.get(this.key(root,relative));return value?structuredClone(value):undefined}
  clear(){this.cache.clear()}
  async read(root:string,options:{repoPath?:string;refresh?:boolean;signal?:AbortSignal}={}):Promise<ProjectGitStatus>{
    const relative=options.repoPath||'',key=this.key(root,relative),cached=this.cache.get(key)
    options.signal?.throwIfAborted()
    if(cached&&!options.refresh&&Date.now()-cached.readAt<TTL)return structuredClone(cached)
    const timer=AbortSignal.timeout(5000),signal=options.signal?AbortSignal.any([options.signal,timer]):timer
    const result=empty()
    const run=async(directory:string,args:string[])=>{signal.throwIfAborted();return (await exec('git',['--no-optional-locks','-C',directory,...args],{signal,timeout:5000,maxBuffer:4*1024*1024,windowsHide:true,env:gitEnvironment()})).stdout}
    const independent=async(directory:string)=>{
      try{const top=(await run(directory,['rev-parse','--show-toplevel'])).trim();return (await fs.realpath(top)).toLowerCase()===(await fs.realpath(directory)).toLowerCase()}
      catch(error){signal.throwIfAborted();if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('未找到 Git，请安装后刷新');return false}
    }
    try{
      let directory=await projectRepoPath(root,relative,signal)
      if(!await independent(directory)){
        if(relative){result.message='所选子目录不是独立 Git 仓库，请重新选择';return this.store(key,result)}
        const scan=await nestedGitRoots(root,signal)
        result.candidates=scan.roots.map(value=>path.relative(root,value).split(path.sep).join('/'))
        if(scan.complete&&scan.roots.length===1&&await independent(scan.roots[0]))directory=scan.roots[0]
        else{result.message=!scan.complete?'子仓库搜索未完成，请选择或填写仓库目录':scan.roots.length?'发现多个子仓库，请选择要查看的仓库':'未发现项目内的独立 Git 仓库（不会读取上级仓库）';return this.store(key,result)}
      }
      result.repoPath=path.relative(root,directory).split(path.sep).join('/')
      const raw=await run(directory,['status','--porcelain=v1','-z','--untracked-files=normal'])
      const branch=(await run(directory,['symbolic-ref','--quiet','--short','HEAD']).catch(error=>{signal.throwIfAborted();if((error as {code?:number}).code===1)return '';throw error})).trim()
      const head=(await run(directory,['rev-parse','--verify','HEAD']).catch(error=>{signal.throwIfAborted();if((error as {code?:number}).code===128)return '';throw error})).trim()
      Object.assign(result,parseGitStatus(raw),{available:true,branch:branch||`detached ${head.slice(0,8)}`,head,readAt:Date.now()})
    }catch(error){
      options.signal?.throwIfAborted()
      result.message=timer.aborted?'Git 状态读取超时，请稍后刷新':(error as Error).message.includes('maxBuffer')?'Git 状态较大，暂时无法读取':(error as Error).message
    }
    return this.store(key,result)
  }
  private store(key:string,result:ProjectGitStatus){
    if(this.cache.size>=1000)this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key,result);return structuredClone(result)
  }
}
export const projectGitCache=new ProjectGitCache()
