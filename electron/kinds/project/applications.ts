import fs from 'node:fs/promises'
import path from 'node:path'
import {spawn} from 'node:child_process'
import type {SqlDb} from '../../services/storage/schema.ts'
import {projectChildEnvironment} from './launch-resolution.ts'
export type ProjectEditor='vscode'|'cursor'
export interface ProjectApplication {id:ProjectEditor;name:string;path:string;available:boolean}
const editors={vscode:{name:'VS Code',folder:'Microsoft VS Code',exe:'Code.exe'},cursor:{name:'Cursor',folder:'cursor',exe:'Cursor.exe'}}
function definition(id:ProjectEditor){const value=editors[id];if(!value)throw new Error('请选择 VS Code 或 Cursor');return value}
async function executable(file:string){try{return path.extname(file).toLowerCase()==='.exe'&&(await fs.stat(file)).isFile()}catch{return false}}
export class ProjectApplications {
  private db:SqlDb;private env:NodeJS.ProcessEnv
  constructor(db:SqlDb,env:NodeJS.ProcessEnv=process.env){this.db=db;this.env=env}
  async list():Promise<ProjectApplication[]>{
    const results:ProjectApplication[]=[]
    for(const id of ['vscode','cursor'] as const){
      const d=definition(id),saved=(this.db.prepare('SELECT value FROM settings WHERE key=?').get('project_editor:'+id) as {value:string})?.value
      const paths=[saved,...[this.env.LOCALAPPDATA&&path.join(this.env.LOCALAPPDATA,'Programs'),this.env.ProgramFiles,this.env['ProgramFiles(x86)']].filter(Boolean).map(base=>path.join(base!,d.folder,d.exe))]
      const search=Object.entries(this.env).find(([key])=>key.toLowerCase()==='path')?.[1]||''
      for(const entry of search.split(path.delimiter).filter(Boolean)){const dir=entry.replace(/^"|"$/g,'');paths.push(path.join(dir,d.exe),path.join(dir,'..',d.exe))}
      let found='';for(const candidate of paths)if(candidate&&await executable(candidate)){found=await fs.realpath(candidate);break}
      results.push({id,name:d.name,path:found,available:!!found})
    }
    return results
  }
  async select(id:ProjectEditor,file:string){
    definition(id);if(!path.isAbsolute(file)||!await executable(file))throw new Error('请选择有效的 Windows EXE 应用')
    const actual=await fs.realpath(file)
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('project_editor:'+id,actual)
  }
  async open(id:ProjectEditor,root:string){
    definition(id)
    const entry=(await this.list()).find(value=>value.id===id)!
    if(!entry.available)throw new Error(`${entry.name} 未找到，请选择已安装的应用`)
    const target=await fs.realpath(root),stat=await fs.stat(target),cwd=stat.isDirectory()?target:path.dirname(target)
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(entry.path,[target],{cwd,windowsHide:true,detached:true,stdio:'ignore',env:projectChildEnvironment(this.env)})
      child.once('error',reject);child.once('spawn',()=>{child.unref();resolve()})
    })
  }
}
