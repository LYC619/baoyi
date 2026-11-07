import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { ProjectLaunchPreview } from '../../../src/types/project-launch.ts'
import { ProjectLibrary } from './library.ts'
import { ProjectLaunchProfiles } from './launch-profiles.ts'
import { resolveProjectFile } from './workspace.ts'

export function projectChildEnvironment(env:NodeJS.ProcessEnv=process.env):Record<string,string> {
  const allowed=/^(?:SystemRoot|WINDIR|PATH|PATHEXT|ComSpec|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LC_ALL)$/i
  return {...Object.fromEntries(Object.entries(env).filter(([key,value])=>allowed.test(key)&&typeof value==='string')) as Record<string,string>,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'}
}
async function exists(file:string){try{return (await fs.stat(file)).isFile()}catch{return false}}
async function executable(command:string,env:NodeJS.ProcessEnv):Promise<string> {
  if(path.isAbsolute(command)){if(await exists(command))return fs.realpath(command);throw new Error('应用路径已失效，请重新选择可执行程序')}
  if(!/^[a-zA-Z0-9_.-]+$/.test(command))throw new Error('程序名应是可执行文件；参数请分行填写，不要填写整条 shell 命令')
  const searchPath=Object.entries(env).find(([key])=>key.toLowerCase()==='path')?.[1]||''
  for(const dir of searchPath.split(path.delimiter).filter(Boolean))for(const ext of path.extname(command)?['']:process.platform==='win32'?['.exe','.cmd','.bat']:['']){
    const file=path.join(dir.replace(/^"|"$/g,''),command+ext)
    if(await exists(file))return fs.realpath(file)
  }
  throw new Error(`未找到 ${command}，请安装所需工具或选择已有程序；抱一不会自动安装依赖`)
}
export async function resolveProjectLauncher(command:string,args:string[],env:NodeJS.ProcessEnv=process.env):Promise<{command:string;args:string[];files:string[]}> {
  const file=await executable(command,env),extension=path.extname(file).toLowerCase()
  if(!['.cmd','.bat'].includes(extension))return {command:file,args,files:[file]}
  const name=path.basename(file,extension).toLowerCase(),base=path.dirname(file)
  const candidates:Record<string,string[]>={
    npm:['node_modules/npm/bin/npm-cli.js'],npx:['node_modules/npm/bin/npx-cli.js'],
    pnpm:['node_modules/pnpm/bin/pnpm.cjs','node_modules/corepack/dist/pnpm.js'],
    yarn:['node_modules/yarn/bin/yarn.js','node_modules/corepack/dist/yarn.js']
  }
  for(const relative of candidates[name]||[]){
    const entry=path.join(base,relative)
    if(!await exists(entry))continue
    const localNode=path.join(base,'node.exe'),node=await exists(localNode)?localNode:await executable('node',env)
    return {command:await fs.realpath(node),args:[entry,...args],files:[node,entry,file]}
  }
  throw new Error('此 CMD/BAT 启动器暂不能直接托管，请使用独立终端，或选择实际 EXE/Node 程序及脚本参数')
}
async function fingerprint(file:string):Promise<string> {
  const before=await fs.stat(file),hash=createHash('sha256')
  for await(const chunk of createReadStream(file))hash.update(chunk)
  const after=await fs.stat(file)
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino)throw new Error('启动文件正在变化，请稍后重新预览')
  return hash.digest('hex')
}
export async function previewProjectLaunch(db:SqlDb,projectId:string,id:string,env:NodeJS.ProcessEnv=process.env):Promise<ProjectLaunchPreview> {
  const profile=new ProjectLaunchProfiles(db).get(projectId,id),project=new ProjectLibrary(db).get(projectId)!
  if(!profile.enabled)throw new Error('此启动配置已停用')
  const item=await fs.stat(project.path),root=await fs.realpath(item.isDirectory()?project.path:path.dirname(project.path))
  const cwd=await fs.realpath(path.resolve(root,profile.cwd)),relative=path.relative(root,cwd)
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!(await fs.stat(cwd)).isDirectory())throw new Error('工作目录已移出项目或不再可用')
  let sourceText='',sourceHash=''
  if(profile.source==='entry'){
    const entry=project.entries.find(e=>e.id===profile.sourceRef);if(!entry)throw new Error('来源入口已移除，请重新选择')
    sourceText=JSON.stringify(entry,null,2);sourceHash=createHash('sha256').update(sourceText).digest('hex')
  }else if(profile.sourceRef){
    const file=await resolveProjectFile(root,profile.sourceRef)
    const stat=await fs.stat(file);if(stat.size>1024*1024)throw new Error('启动来源文件超过 1 MiB，请缩小为具体脚本文件')
    sourceText=await fs.readFile(file,'utf8');sourceHash=await fingerprint(file)
    if(createHash('sha256').update(Buffer.from(sourceText,'utf8')).digest('hex')!==sourceHash)throw new Error('来源文件不是 UTF-8 文本或正在变化，请重新选择')
  }
  const launch=profile.kind==='preview'?{command:'',args:[],files:[]}:await resolveProjectLauncher(profile.command,profile.args,env)
  const sources=await Promise.all(launch.files.map(async file=>({file,sha256:await fingerprint(file)})))
  // Manual Node/Python scripts referenced as arguments participate in trust too.
  for(const arg of profile.args){
    if(!/\.(?:[cm]?js|ts|py|ps1|sh)$/i.test(arg))continue
    const file=path.resolve(cwd,arg)
    if(await exists(file))sources.push({file:await fs.realpath(file),sha256:await fingerprint(file)})
  }
  const stamp=createHash('sha256').update(JSON.stringify({projectId,id,root,cwd,command:launch.command,args:launch.args,sources,sourceHash,source:profile.source,sourceRef:profile.sourceRef,revision:profile.revision,url:profile.url,port:profile.port})).digest('hex')
  return {profile,root,cwd,command:launch.command,args:launch.args,sourceText,stamp,trusted:profile.trusted&&profile.trustStamp===stamp}
}
