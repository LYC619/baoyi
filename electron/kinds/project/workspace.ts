import fs from 'node:fs/promises'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import type {ProjectOverview} from '../../../src/types/project.ts'

const exec=promisify(execFile)
const excluded=/^(?:\.git|node_modules|\.venv|venv|__pycache__|dist|build|release|\.next|\.cache)$/i
const sensitive=/(?:^\.env(?:\.|$)|credential|secret|password|cookie|token|密钥|密码|私钥|^id_(?:rsa|ed25519)|\.(?:pem|key|p12|pfx)$)/i
const textFile=/\.(?:md|txt|json|jsonc|ts|tsx|js|jsx|mjs|cjs|vue|css|scss|html|py|rs|go|java|cs|cpp|c|h|toml|yaml|yml|xml|ini|cfg|sh|ps1|bat|cmd|sql)$/i
async function scope(root:string,relative:string) {
  const stat=await fs.lstat(root),base=await fs.realpath(stat.isDirectory()?root:path.dirname(root))
  if(typeof relative!=='string'||relative.length>2048||path.isAbsolute(relative)||relative.includes('\0'))throw new Error('请使用项目内的相对路径')
  const target=path.resolve(base,relative|| (stat.isDirectory()?'.':path.basename(root)))
  const inside=(file:string)=>{const rel=path.relative(base,file);return rel!== '..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)}
  if(!inside(target))throw new Error('路径超出项目范围')
  if(relative.split(/[\\/]/).some(s=>sensitive.test(s)||excluded.test(s)))throw new Error('不能读取凭据、敏感文件或依赖目录')
  const real=await fs.realpath(target)
  if(!inside(real)||(!stat.isDirectory()&&real!==await fs.realpath(root)))throw new Error('路径超出项目范围')
  if(path.relative(base,real).split(path.sep).some(s=>sensitive.test(s)||excluded.test(s)))throw new Error('链接指向敏感或依赖目录')
  return {base,target:real}
}
export async function readProjectText(root:string,relative:string,start=1):Promise<string> {
  const {target}=await scope(root,relative),stat=await fs.stat(target)
  if(!stat.isFile()||stat.size>512_000||(!textFile.test(target)&&!/(?:README|LICENSE|Makefile|Dockerfile)$/i.test(target)))throw new Error('仅能读取 512 KB 内的项目文本文件')
  if(!Number.isInteger(start)||start<1)throw new Error('起始行无效')
  const content=await fs.readFile(target,'utf8')
  if(content.includes('\0'))throw new Error('不能作为文本读取')
  return content.split(/\r?\n/).slice(start-1,start+159).map((line,i)=>`${start+i}: ${line}`).join('\n').slice(0,16000)
}
export async function listProjectFiles(root:string,relative=''):Promise<Array<{path:string;directory:boolean}>> {
  const {base,target}=await scope(root,relative),stat=await fs.stat(target)
  if(stat.isFile())return [{path:path.basename(target),directory:false}]
  return (await fs.readdir(target,{withFileTypes:true})).filter(e=>!e.isSymbolicLink()&&!sensitive.test(e.name)&&!excluded.test(e.name))
    .sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name,'zh-CN',{numeric:true})).slice(0,160)
    .map(e=>({path:path.relative(base,path.join(target,e.name)),directory:e.isDirectory()}))
}
export async function projectOverview(root:string):Promise<ProjectOverview> {
  const files=await listProjectFiles(root),result:ProjectOverview={files,scripts:[],git:{available:false,branch:'',changed:0,status:'',message:''}}
  if(files.some(f=>f.path==='package.json'))try{
    const {target}=await scope(root,'package.json'),stat=await fs.stat(target)
    if(stat.size<512_000){const pkg=JSON.parse(await fs.readFile(target,'utf8'));result.scripts=Object.entries(pkg.scripts||{}).filter(([,v])=>typeof v==='string').slice(0,30).map(([name,command])=>({name,command:String(command).slice(0,2000)}))}
  }catch{}
  try {
    const stat=await fs.stat(root);if(!stat.isDirectory())return result
    const run=(args:string[])=>exec('git',['--no-optional-locks','-C',root,...args],{timeout:5000,maxBuffer:128*1024,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})
    const top=(await run(['rev-parse','--show-toplevel'])).stdout.trim()
    if(path.resolve(top).toLowerCase()!==path.resolve(root).toLowerCase()){result.git.message='此目录位于上级 Git 仓库中';return result}
    const status=(await run(['status','--short','--branch','--untracked-files=normal'])).stdout
    const lines=status.trimEnd().split(/\r?\n/)
    result.git={available:true,branch:lines[0]?.replace(/^## /,'')||'',changed:Math.max(0,lines.length-1),status:lines.slice(1).join('\n').slice(0,12000),message:''}
  }catch{result.git.message='未检测到独立 Git 仓库，或 Git 暂不可用'}
  return result
}
