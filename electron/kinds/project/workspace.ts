import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {projectGitCache} from './git-status.ts'
import type {ProjectOverview,ProjectScript} from '../../../src/types/project.ts'
import {inspectTextFile,readTextFilePage,type TextCursor} from '../../services/system/text-file.ts'

const excluded=/^(?:\.git|node_modules|\.venv|venv|__pycache__|dist|build|release|\.next|\.cache)$/i
const sensitive=/(?:^\.env(?:\.|$)|credential|secret|password|cookie|token|密钥|密码|私钥|^id_(?:rsa|ed25519)|\.(?:pem|key|p12|pfx)$)/i
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
  const page = await readProjectTextPage(root, relative, start)
  const body = page.text.split(/\r?\n/).map((line, i) => `${page.startLine + i}: ${line}`).join('\n')
  return body + (page.next ? `\n下一次读取：start=${page.next.line}，cursor=${JSON.stringify(page.next)}` : '\n（文件结束）')
}

export type ProjectTextCursor=TextCursor
async function textSource(root: string, relative: string, cursor?: ProjectTextCursor) {
  return inspectTextFile((await scope(root,relative)).target,cursor)
}
export async function readProjectTextPage(root: string, relative: string, start = 1, cursor?: ProjectTextCursor) {
  return readTextFilePage((await scope(root,relative)).target,start,cursor)
}
/** Literal, case-sensitive search with bounded I/O and byte-accurate UTF-8 continuation. */
export async function searchProjectText(root: string, relative: string, query: string, cursor?: ProjectTextCursor) {
  if (typeof query !== 'string' || !query || query.length > 200 || query.includes('\0')) throw new Error('搜索文字需要 1 至 200 字')
  const { target, stat, version } = await textSource(root, relative, cursor)
  let offset = cursor?.offset || 0, line = cursor?.line || 1, scanned = 0, buffer = ''
  const matches: Array<{line:number;offset:number;text:string}> = []
  const stream = createReadStream(target, { encoding:'utf8', start:offset, highWaterMark:16384 })
  try {
    for await (const chunk of stream) for (const char of chunk as string) {
      if (char === '\0') throw new Error('文件含二进制内容，不能作为文本搜索')
      offset += Buffer.byteLength(char); scanned += Buffer.byteLength(char)
      buffer = (buffer + char).slice(-400)
      if (char === '\n') line++
      if (buffer.endsWith(query)) matches.push({line:line - (query.match(/\n/g)?.length || 0), offset:offset - Buffer.byteLength(query), text:buffer.slice(-240)})
      if (matches.length >= 40 || scanned >= 8 * 1024 * 1024) {
        // Retain a possible partial match across the next search page, but never repeat the completed match.
        const chars = Array.from(buffer), tail = chars.slice(-Math.max(0, Array.from(query).length - 1)).join('')
        const overlap = Array.from(query).length > 1 ? tail : ''
        return {matches, next:{offset:offset - Buffer.byteLength(overlap), line:line - (overlap.match(/\n/g)?.length || 0), version}, size:stat.size}
      }
    }
    return {matches, next:null, size:stat.size}
  } finally { stream.destroy() }
}
export interface ProjectDirectoryCursor { offset:number; version:string }
export async function listProjectFilesPage(root:string, relative='', options:{limit?:number;query?:string;cursor?:ProjectDirectoryCursor}={}) {
  const {base,target}=await scope(root,relative),stat=await fs.stat(target)
  const limit=options.limit ?? 100,query=options.query || ''
  if(!Number.isInteger(limit)||limit<1||limit>160||typeof query!=='string'||query.length>200)throw new Error('目录查询参数无效')
  const entries=stat.isFile()?[{path:path.basename(target),directory:false}]:(await fs.readdir(target,{withFileTypes:true}))
    .filter(e=>!e.isSymbolicLink()&&!sensitive.test(e.name)&&!excluded.test(e.name))
    .sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name,'zh-CN',{numeric:true}))
    .map(e=>({path:path.relative(base,path.join(target,e.name)),directory:e.isDirectory()}))
  const filtered=entries.filter(e=>e.path.toLowerCase().includes(query.toLowerCase()))
  const version=createHash('sha256').update(JSON.stringify([target,query,entries])).digest('hex'),offset=options.cursor?.offset||0
  if(options.cursor&&(options.cursor.version!==version||!Number.isSafeInteger(offset)||offset<0||offset>filtered.length))throw new Error('目录已变化，分页位置失效，请重新列出')
  const files=filtered.slice(offset,offset+limit)
  return {files,total:filtered.length,next:offset+files.length<filtered.length?{offset:offset+files.length,version}:null}
}
export async function listProjectFiles(root:string,relative=''):Promise<Array<{path:string;directory:boolean}>> {
  return (await listProjectFilesPage(root,relative,{limit:160})).files
}
export async function resolveProjectFile(root:string,relative='') {return (await scope(root,relative)).target}

export async function discoverProjectScripts(root:string,relative=''):Promise<{scripts:ProjectScript[];warnings:string[]}> {
  const {base,target}=await scope(root,relative),scripts:ProjectScript[]=[],warnings:string[]=[]
  if(!(await fs.stat(target)).isDirectory())return {scripts,warnings}
  const cwd=path.relative(base,target)||'.'
  const read=async(name:string)=>{
    const candidate=path.relative(base,path.join(target,name))
    try{const file=(await scope(root,candidate)).target;if((await fs.stat(file)).size>512_000){warnings.push(`${candidate} 超过 500 KB，未读取`);return null}return await fs.readFile(file,'utf8')}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')warnings.push(`${candidate} 无法读取：${(error as Error).message}`);return null}
  }
  const text=await read('package.json')
  if(text!==null)try{
    const pkg=JSON.parse(text),declared=typeof pkg.packageManager==='string'?pkg.packageManager.match(/^(npm|pnpm|yarn|bun)@/)?.[1]:undefined
    const locks=[] as string[]
    for(const [name,manager] of [['pnpm-lock.yaml','pnpm'],['yarn.lock','yarn'],['bun.lock','bun'],['bun.lockb','bun'],['package-lock.json','npm'],['npm-shrinkwrap.json','npm']]){
      try{await scope(root,path.relative(base,path.join(target,name)));locks.push(manager)}catch{/* A missing/unsafe lockfile is not a usable manager hint. */}
    }
    const distinct=[...new Set(locks)],manager=declared||(distinct.length===1?distinct[0]:distinct.length===0?'npm':'')
    if(!manager)warnings.push('发现多种包管理器锁文件，请确认使用哪一种；未生成运行命令')
    if(pkg.scripts&&typeof pkg.scripts==='object'&&!Array.isArray(pkg.scripts)){
      const entries=Object.entries(pkg.scripts).filter(([,command])=>typeof command==='string')
      if(entries.length>60)warnings.push('package.json 脚本较多，仅列出前 60 项')
      for(const [name,command] of entries.slice(0,60))scripts.push({name,command:String(command).slice(0,2000),runCommand:manager&&/^[a-zA-Z0-9][\w:./-]*$/.test(name)?`${manager} run ${name}`:null,source:path.relative(base,path.join(target,'package.json')),cwd})
    }
  }catch{warnings.push('package.json 格式无效，修正后可重新发现命令')}
  const makefile=await read('Makefile')
  if(makefile!==null){
    const targets=new Set<string>()
    for(const line of makefile.split(/\r?\n/)){
      if(/^\s|^#/.test(line))continue
      const match=line.match(/^([^:=]+):(?!=)(.*)$/);if(!match)continue
      const names=(match[1].trim()==='.PHONY'?match[2].split('#')[0]:match[1]).trim().split(/\s+/)
      for(const name of names)if(/^[a-zA-Z0-9][\w.-]*$/.test(name))targets.add(name)
    }
    if(targets.size>60)warnings.push('Makefile 目标较多，仅列出前 60 项')
    for(const name of [...targets].slice(0,60))scripts.push({name,command:`make ${name}`,runCommand:`make ${name}`,source:path.relative(base,path.join(target,'Makefile')),cwd})
  }
  return {scripts,warnings}
}
export async function projectOverview(root:string,options:{refresh?:boolean;repoPath?:string;signal?:AbortSignal}={}):Promise<ProjectOverview> {
  const page=await listProjectFilesPage(root,'',{limit:100}),commands=await discoverProjectScripts(root)
  return {files:page.files,totalFiles:page.total,directory:(await fs.stat(root)).isDirectory(),...commands,git:await projectGitCache.read(root,options)}
}
