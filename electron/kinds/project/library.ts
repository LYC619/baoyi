import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {ensureResourceCategory} from '../../services/resource-taxonomy.ts'
import type { SqlDb } from '../../services/schema.ts'
import { PROJECT_SOURCES, PROJECT_STATES, type ProjectCandidate,type ProjectEntry,type ProjectItem,type ProjectPatch } from '../../../src/types/project.ts'

type Row=Record<string,any>
const str=(v:unknown,max:number,name:string):string=>{if(typeof v!=='string'||v.length>max||v.includes('\0'))throw new Error(name+'无效');return v.trim()}
export function validateProjectEntries(value:unknown):ProjectEntry[]{
  if(!Array.isArray(value)||value.length>100)throw new Error('最多添加 100 个入口')
  const ids=new Set<string>()
  return value.map(e=>{
    if(!e||typeof e!=='object')throw new Error('入口无效')
    const id=str(e.id,128,'入口编号'),label=str(e.label,160,'入口名称'),target=str(e.path,4096,'入口路径')
    if(!id||ids.has(id)||!label||!target)throw new Error('入口编号重复或内容为空');ids.add(id)
    if(!['path','url','command','obsidian'].includes(e.type))throw new Error('入口类型无效')
    if(e.type==='url'){const url=new URL(target);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('仅支持 HTTP/HTTPS 网址')}
    else if(!path.isAbsolute(target))throw new Error('入口必须使用完整路径')
    if(!Array.isArray(e.args)||e.args.length>30||e.args.some((x:unknown)=>typeof x!=='string'||x.length>4096||x.includes('\0')))throw new Error('启动参数无效')
    const cwd=str(e.cwd,4096,'工作目录');if(cwd&&!path.isAbsolute(cwd))throw new Error('工作目录必须使用完整路径')
    return {id,label,type:e.type,path:target,role:str(e.role,60,'用途'),args:e.args,cwd,resourceId:str(e.resourceId,128,'关联资源')}
  })
}
export class ProjectLibrary {
  db:SqlDb
  constructor(db:SqlDb){this.db=db}
  private item(r:Row):ProjectItem{return {id:r.id,path:r.path,name:r.name_zh,summary:r.summary||'',category:r.category,source:r.origin,state:r.status,group:r.group_name,tags:JSON.parse(r.tags||'[]'),pinned:!!r.pinned,notes:r.notes||'',version:r.version,entries:validateProjectEntries(JSON.parse(r.entries)),defaultEntryId:r.default_entry,evidence:r.evidence,createdAt:r.created_at,updatedAt:r.updated_at,lastOpenedAt:r.last_used_at||0,available:existsSync(r.path)}}
  list():ProjectItem[]{return (this.db.prepare("SELECT r.*,p.* FROM resource r JOIN project_meta p ON p.resource_id=r.id WHERE r.kind='project' ORDER BY p.pinned DESC,r.last_used_at DESC,r.updated_at DESC").all() as Row[]).map(r=>this.item(r))}
  get(id:string):ProjectItem|null{const r=this.db.prepare("SELECT r.*,p.* FROM resource r JOIN project_meta p ON p.resource_id=r.id WHERE r.id=? AND r.kind='project'").get(id) as Row|undefined;return r?this.item(r):null}
  register(scan:ProjectCandidate,defaultState:ProjectItem['state']='active'):ProjectItem{
    if(!path.isAbsolute(scan.path))throw new Error('项目路径无效')
    const existing=this.db.prepare('SELECT id,kind FROM resource WHERE path=? COLLATE NOCASE').get(scan.path) as Row|undefined
    if(existing){if(existing.kind!=='project')throw new Error('这个位置已登记在其他品类，可通过入口关联');return this.get(existing.id)!}
    if(!PROJECT_STATES.includes(defaultState))throw new Error('默认项目状态无效')
    const entries=validateProjectEntries(scan.entries),id=randomUUID(),now=Date.now()
    this.db.exec('SAVEPOINT project_register')
    try{
      ensureResourceCategory(this.db,'project',str(scan.category,80,'分类'))
      this.db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,source_dir,name_zh,summary,category,ai_status) VALUES(?,'project',?,?,?,?,?,?,?,?,'done')").run(id,now,now,path.resolve(scan.path),path.basename(scan.path),path.dirname(scan.path),str(scan.name,160,'名称')||path.basename(scan.path),str(scan.summary,4000,'简介'),str(scan.category,80,'分类'))
      this.db.prepare('INSERT INTO project_meta(resource_id,origin,status,version,entries,default_entry,evidence) VALUES(?,?,?,?,?,?,?)').run(id,PROJECT_SOURCES.includes(scan.source)?scan.source:'unknown',defaultState,str(scan.version,80,'版本'),JSON.stringify(entries),entries[0]?.id||'',str(scan.evidence,2000,'识别依据'))
      this.db.exec('RELEASE project_register');return this.get(id)!
    }catch(error){this.db.exec('ROLLBACK TO project_register; RELEASE project_register');throw error}
  }
  update(id:string,patch:ProjectPatch):ProjectItem{
    const current=this.get(id);if(!current)throw new Error('项目不存在')
    if(!patch||typeof patch!=='object'||Object.keys(patch).some(k=>!['name','summary','category','source','state','group','tags','pinned','notes','entries','defaultEntryId'].includes(k)))throw new Error('项目修改内容无效')
    const next={...current,...patch}
    next.name=str(next.name,160,'名称');if(!next.name)throw new Error('名称不能为空')
    next.summary=str(next.summary,4000,'简介');next.category=str(next.category,80,'分类');next.group=str(next.group,100,'分组');next.notes=str(next.notes,20000,'备注')
    if(!PROJECT_SOURCES.includes(next.source)||!PROJECT_STATES.includes(next.state)||typeof next.pinned!=='boolean')throw new Error('来源、状态或置顶值无效')
    if(!Array.isArray(next.tags)||next.tags.length>50)throw new Error('标签无效')
    next.tags=[...new Set(next.tags.map(t=>str(t,80,'标签')).filter(Boolean))]
    next.entries=validateProjectEntries(next.entries)
    if(next.defaultEntryId&&!next.entries.some(e=>e.id===next.defaultEntryId))throw new Error('默认入口不存在')
    this.db.exec('SAVEPOINT project_update')
    try{
      ensureResourceCategory(this.db,'project',next.category)
      for(const tag of next.tags)this.db.prepare("INSERT OR IGNORE INTO tags(kind,name,source,created_at) VALUES('project',?,'user',?)").run(tag,Date.now())
      this.db.prepare('UPDATE resource SET name_zh=?,summary=?,category=?,tags=?,notes=?,updated_at=? WHERE id=?').run(next.name,next.summary,next.category,JSON.stringify(next.tags),next.notes,Date.now(),id)
      this.db.prepare('UPDATE project_meta SET origin=?,status=?,group_name=?,pinned=?,entries=?,default_entry=? WHERE resource_id=?').run(next.source,next.state,next.group,Number(next.pinned),JSON.stringify(next.entries),next.defaultEntryId,id)
      this.db.exec('RELEASE project_update');return this.get(id)!
    }catch(error){this.db.exec('ROLLBACK TO project_update; RELEASE project_update');throw error}
  }
  opened(id:string):void{this.db.prepare("UPDATE resource SET last_used_at=?,use_count=COALESCE(use_count,0)+1 WHERE id=? AND kind='project'").run(Date.now(),id)}
  remove(id:string):void{this.db.prepare("DELETE FROM resource WHERE id=? AND kind='project'").run(id)}
}
