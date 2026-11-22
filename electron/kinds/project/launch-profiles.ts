import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SqlDb } from '../../services/storage/schema.ts'
import type { ProjectLaunchProfile,ProjectLaunchInput } from '../../../src/types/project-launch.ts'
import { keys } from '../../workspace/validation.ts'
import { ProjectLibrary } from './library.ts'

export const PROJECT_LAUNCH_SQL=`CREATE TABLE IF NOT EXISTS project_launch_profiles (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('script','application','preview')),
  command TEXT NOT NULL DEFAULT '',args_json TEXT NOT NULL DEFAULT '[]',cwd TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK(source IN ('discovered','entry','manual')),source_ref TEXT NOT NULL DEFAULT '',
  port INTEGER,url TEXT NOT NULL DEFAULT '',trusted INTEGER NOT NULL DEFAULT 0 CHECK(trusted IN (0,1)),
  trust_stamp TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
); CREATE INDEX IF NOT EXISTS idx_project_launch_profiles ON project_launch_profiles(resource_id,created_at);`
function text(value:unknown,label:string,max=4096):string {if(typeof value!=='string'||value.length>max||value.includes('\0'))throw new Error(label+'无效');return value}
export function projectRelative(value:unknown,label:string):string {
  const result=text(value,label,2048).trim().replace(/\\/g,'/')
  if(path.win32.isAbsolute(result)||path.posix.isAbsolute(result)||result.includes(':')||result.split('/').includes('..'))throw new Error(label+'需要项目内的相对路径')
  return result==='.'?'':result
}
export function loopbackUrl(value:string):string {
  const url=new URL(value)
  if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)throw new Error('预览只支持本机 localhost、127.0.0.1 或 [::1] 地址')
  return url.href
}
export function validateLaunchInput(input:ProjectLaunchInput):ProjectLaunchInput {
  keys(input,['id','revision','name','kind','command','args','cwd','source','sourceRef','port','url','enabled'])
  const name=text(input.name,'启动名称',160).trim(),command=text(input.command,'可执行程序').trim()
  if(!name||!['script','application','preview'].includes(input.kind)||!['discovered','entry','manual'].includes(input.source)||typeof input.enabled!=='boolean')throw new Error('启动配置无效')
  if(input.kind!=='preview'&&!command)throw new Error('请选择可执行程序')
  if(!Array.isArray(input.args)||input.args.length>60)throw new Error('启动参数最多 60 个')
  const args=input.args.map(arg=>text(arg,'启动参数'))
  const cwd=projectRelative(input.cwd,'工作目录'),sourceRef=input.source==='entry'?text(input.sourceRef,'来源入口',128):projectRelative(input.sourceRef,'来源文件')
  if(input.source!=='manual'&&!sourceRef)throw new Error('缺少命令来源')
  if(input.port!==null&&(!Number.isInteger(input.port)||input.port<1||input.port>65535))throw new Error('端口需要在 1 到 65535 之间')
  const rawUrl=text(input.url,'预览地址',2048).trim(),url=rawUrl?loopbackUrl(rawUrl):''
  if(input.kind==='preview'&&!url&&input.port===null)throw new Error('请填写预览地址或端口')
  if(input.id&&(!Number.isSafeInteger(input.revision)||input.revision!<0))throw new Error('启动配置版本无效')
  return {...(input.id?{id:text(input.id,'配置编号',128),revision:input.revision}:{}),name,kind:input.kind,command,args,cwd,source:input.source,sourceRef,port:input.port,url,enabled:input.enabled}
}
type Row=Record<string,any>
export function launchProfileFromRow(r:Row):ProjectLaunchProfile {return {id:r.id,projectId:r.resource_id,name:r.name,kind:r.kind,command:r.command,args:JSON.parse(r.args_json),cwd:r.cwd,source:r.source,sourceRef:r.source_ref,port:r.port,url:r.url,trusted:!!r.trusted,trustStamp:r.trust_stamp,revision:r.revision,enabled:!!r.enabled,createdAt:r.created_at,updatedAt:r.updated_at}}
export class ProjectLaunchProfiles {
  db:SqlDb
  constructor(db:SqlDb){this.db=db}
  private require(projectId:string){const project=new ProjectLibrary(this.db).get(projectId);if(!project)throw new Error('项目不存在');return project}
  list(projectId:string):ProjectLaunchProfile[]{this.require(projectId);return (this.db.prepare('SELECT * FROM project_launch_profiles WHERE resource_id=? ORDER BY created_at,id').all(projectId) as Row[]).map(launchProfileFromRow)}
  get(projectId:string,id:string):ProjectLaunchProfile {this.require(projectId);const row=this.db.prepare('SELECT * FROM project_launch_profiles WHERE id=? AND resource_id=?').get(id,projectId) as Row|undefined;if(!row)throw new Error('启动配置不属于此项目或已移除');return launchProfileFromRow(row)}
  save(projectId:string,input:ProjectLaunchInput):ProjectLaunchProfile {
    const project=this.require(projectId),next=validateLaunchInput(input)
    if(next.source==='entry'&&!project.entries.some(e=>e.id===next.sourceRef))throw new Error('来源入口不属于此项目')
    if(!next.id&&this.list(projectId).length>=100)throw new Error('每个项目最多保留 100 项启动配置')
    const id=next.id||randomUUID(),now=Date.now(),values=[next.name,next.kind,next.command,JSON.stringify(next.args),next.cwd,next.source,next.sourceRef,next.port,next.url,Number(next.enabled)]
    if(next.id){
      const result=this.db.prepare("UPDATE project_launch_profiles SET name=?,kind=?,command=?,args_json=?,cwd=?,source=?,source_ref=?,port=?,url=?,enabled=?,trusted=0,trust_stamp='',revision=revision+1,updated_at=? WHERE resource_id=? AND id=? AND revision=?").run(...values,now,projectId,id,next.revision)
      if(!result.changes)throw new Error('启动配置已变化；请重新载入，当前输入仍保留')
    }else this.db.prepare('INSERT INTO project_launch_profiles(name,kind,command,args_json,cwd,source,source_ref,port,url,enabled,id,resource_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values,id,projectId,now,now)
    return this.get(projectId,id)
  }
  remove(projectId:string,id:string,revision:number):void {this.require(projectId);if(!this.db.prepare('DELETE FROM project_launch_profiles WHERE resource_id=? AND id=? AND revision=?').run(projectId,id,revision).changes)throw new Error('启动配置已变化，请重新载入')}
  trust(projectId:string,id:string,revision:number,stamp:string):void {
    if(!/^[a-f0-9]{64}$/.test(stamp))throw new Error('启动摘要无效')
    this.require(projectId)
    if(!this.db.prepare('UPDATE project_launch_profiles SET trusted=1,trust_stamp=? WHERE resource_id=? AND id=? AND revision=?').run(stamp,projectId,id,revision).changes)throw new Error('启动配置已变化，请重新确认')
  }
  revoke(projectId:string,id:string):ProjectLaunchProfile {this.get(projectId,id);this.db.prepare("UPDATE project_launch_profiles SET trusted=0,trust_stamp='' WHERE resource_id=? AND id=?").run(projectId,id);return this.get(projectId,id)}
}
