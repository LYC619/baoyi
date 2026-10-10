import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProjectCandidate, ProjectEntry } from '../../../src/types/project.ts'

const excluded = new Set(['node_modules','.git','.venv','venv','__pycache__','.cache','.pnpm-store','.recover','.tmp-split','.next','.obsidian'])
const sensitive = /(?:^\.env|cookie|password|credential|secret|token|密钥|密码|验证码|私钥|\.pem$|\.key$)/i
const documents = /\.(md|docx?|pdf|pptx?|xlsx?|txt|html?)$/i
const scripts = /\.(bat|cmd|ps1|py|mjs|sh)$/i
const manifests = new Set(['package.json','pyproject.toml','Cargo.toml','go.mod','pom.xml','CMakeLists.txt'])
const clean = (s:string) => s.replace(/<[^>]*>/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[`*_#]/g,'').trim()
async function text(file:string):Promise<string> {
  try { const s=await fs.lstat(file); if(!s.isFile()||s.isSymbolicLink()||s.size>512_000)return '';return (await fs.readFile(file,'utf8')).slice(0,48_000) } catch{return ''}
}
export function projectEntry(file:string,label=path.basename(file),role='资料'):ProjectEntry {
  return {id:randomUUID(),label,type:'path',path:file,role,args:[],cwd:'',resourceId:''}
}
export async function inspectProject(input:string):Promise<ProjectCandidate> {
  const root=path.resolve(input),stat=await fs.lstat(root)
  if(stat.isSymbolicLink())throw new Error('请选择实际文件或目录，不要选择链接')
  if(!stat.isDirectory()&&!stat.isFile())throw new Error('不支持的文件类型')
  if(!stat.isDirectory())return {path:root,name:path.basename(root,path.extname(root)),summary:'单独文件，可关联到现有项目',category:scripts.test(root)?'资料处理':'其他',source:'unknown',version:'',entries:[projectEntry(root,'打开文件','主文件')],evidence:'由文件导入',suggested:false,warnings:[]}
  const children=(await fs.readdir(root,{withFileTypes:true})).filter(e=>!sensitive.test(e.name))
  const files=children.filter(e=>e.isFile()), names=new Set(files.map(e=>e.name))
  const guide=files.find(e=>/^项目目录说明\.md$/i.test(e.name))||files.find(e=>/^readme(?:\.md|\.txt)?$/i.test(e.name))
  const readme=guide?await text(path.join(root,guide.name)):''
  let pkg:Record<string,any>={};try{pkg=JSON.parse(await text(path.join(root,'package.json')))||{}}catch{}
  const software=files.some(e=>manifests.has(e.name))
  const report=/调研|要报|研究|报告|合同|招标|论文|工程实录/.test(path.basename(root))||names.has('项目目录说明.md')
  const scriptCount=files.filter(e=>scripts.test(e.name)).length
  const category=software?'软件项目':report?'调研写作':scriptCount>0?'资料处理':'其他'
  const heading=readme.split(/\r?\n/).find(l=>/^#\s+\S/.test(l))
  const summary=typeof pkg.description==='string'?pkg.description:readme.split(/\r?\n/).map(clean).find(l=>l.length>15&&!/^[-|>!]|^https?:|password|token|secret|密码|密钥/i.test(l))||''
  const entries=[projectEntry(root,'打开项目目录','主目录')]
  const priority=(name:string)=>/^README|^项目目录说明/i.test(name)?0:/^正文草稿\.(docx|md)$|定稿|项目工作台\.html/.test(name)?1:/\.exe$|启动.*\.(bat|cmd)$/i.test(name)?2:3
  for(const e of files.filter(e=>documents.test(e.name)||/\.(exe|bat|cmd|ps1)$/i.test(e.name)).sort((a,b)=>priority(a.name)-priority(b.name)).slice(0,18)) {
    entries.push(projectEntry(path.join(root,e.name),e.name,/\.exe$|\.(bat|cmd|ps1)$/i.test(e.name)?'工具':/^README|^项目目录说明/i.test(e.name)?'说明':/正文草稿|定稿/.test(e.name)?'主文件':'资料'))
  }
  for(const e of children.filter(e=>e.isDirectory()&&!excluded.has(e.name)&&!/^(dist|build|release|out|output|\.\w)/i.test(e.name)).slice(0,8))entries.push(projectEntry(path.join(root,e.name),e.name,'目录'))
  let budget=0
  async function programs(dir:string,depth:number):Promise<void>{
    if(depth>3||budget>350||entries.length>35)return
    for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
      if(++budget>350)return
      const file=path.join(dir,e.name)
      if(e.isFile()&&/\.exe$/i.test(e.name)&&!/unins|crashpad|elevate|setup/i.test(e.name))entries.push(projectEntry(file,'运行 '+e.name,'程序'))
      else if(e.isDirectory()&&!/^(resources|locales|node_modules|swiftshader)$/i.test(e.name))await programs(file,depth+1)
    }
  }
  for(const dir of ['dist','release','build','out'])if(children.some(e=>e.name===dir&&e.isDirectory()))await programs(path.join(root,dir),0)
  return {path:root,name:(heading?clean(heading):path.basename(root)).slice(0,160)||path.basename(root),summary:summary.slice(0,1500),category,source:'unknown',version:typeof pkg.version==='string'?pkg.version.slice(0,80):'',entries,evidence:[guide?.name,software?'项目配置':report?'文稿与目录名称':scriptCount?'处理脚本':'目录结构'].filter(Boolean).join(' · '),suggested:software||report||!!guide||scriptCount>0,warnings:[]}
}
export async function scanProjects(root:string,mode:'single'|'discover'):Promise<ProjectCandidate[]> {
  if(mode==='single')return [await inspectProject(root)]
  const results:ProjectCandidate[]=[]
  async function visit(dir:string,depth:number):Promise<void>{
    for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))){
      if(results.length>=200)return
      if(excluded.has(entry.name)||sensitive.test(entry.name)||entry.isSymbolicLink()||entry.name.startsWith('.'))continue
      const target=path.join(dir,entry.name)
      if(entry.isDirectory()){
        try{const candidate=await inspectProject(target);results.push(candidate);if(!candidate.suggested&&depth<2)await visit(target,depth+1)}catch{}
      }else if(entry.isFile()&&(documents.test(entry.name)||scripts.test(entry.name)||/\.exe$/i.test(entry.name)))results.push(await inspectProject(target))
    }
  }
  await visit(path.resolve(root),0);return results
}
