import {createHash,randomUUID} from 'node:crypto'
import type {SqlDb} from '../services/schema.ts'
import type {ProjectSummary,SummaryKind} from '../../src/types/workspace.ts'
import {summaryGroup} from '../../src/utils/project-summary.ts'
import {TimelineLibrary} from './timeline.ts'
import * as v from './validation.ts'
export class ProjectSummaries {
  db:SqlDb;timeline:TimelineLibrary
  constructor(db:SqlDb){this.db=db;this.timeline=new TimelineLibrary(db)}
  sources(projectId:string,kind:SummaryKind,key:string){
    if(!['day','week','version'].includes(kind))throw new Error('摘要分组无效')
    v.text(key,'摘要分组',80);if(kind!=='version'&&!v.date(key))throw new Error('摘要日期无效')
    const events=this.timeline.events(projectId).filter(e=>e.status==='published'&&summaryGroup(e,kind)===key)
    const stamp=createHash('sha256').update(JSON.stringify(events)).digest('hex')
    return {kind,key,stamp,events}
  }
  private item(row:any):ProjectSummary{return {id:row.id,projectId:row.resource_id,kind:row.kind,key:row.group_key,title:row.title,body:row.body,sources:JSON.parse(row.sources),stamp:row.source_stamp,sessionId:row.session_id,revised:!!row.revised,stale:this.sources(row.resource_id,row.kind,row.group_key).stamp!==row.source_stamp,createdAt:row.created_at,updatedAt:row.updated_at}}
  list(projectId:string):ProjectSummary[]{this.timeline.require(projectId);return this.db.prepare('SELECT * FROM project_summaries WHERE resource_id=? AND undone=0 ORDER BY updated_at DESC').all(projectId).map(r=>this.item(r))}
  get(projectId:string,id:string):ProjectSummary {const row=this.db.prepare('SELECT * FROM project_summaries WHERE resource_id=? AND id=?').get(projectId,id);if(!row)throw new Error('摘要不属于此项目');return this.item(row)}
  save(projectId:string,sessionId:string,input:{kind:SummaryKind;key:string;title:string;body:string;stamp:string}):ProjectSummary {
    const source=this.sources(projectId,input.kind,input.key)
    if(!source.events.length)throw new Error('此分组没有原始记录，不能生成摘要')
    if(source.stamp!==input.stamp)throw new Error('原始记录已变化，请重新读取后整理')
    const previous=this.db.prepare('SELECT * FROM project_summaries WHERE resource_id=? AND kind=? AND group_key=?').get(projectId,input.kind,input.key) as any
    if(previous?.revised)throw new Error('摘要已由用户人工修订，请保留原摘要，可在会话中给出新建议')
    const title=v.name(input.title),body=v.text(input.body,'摘要内容',50000),id=previous?.id||randomUUID(),now=Date.now()
    if(previous&&!previous.undone&&previous.source_stamp===source.stamp&&previous.title===title&&previous.body===body)return this.item(previous)
    this.db.prepare(`INSERT INTO project_summaries(id,resource_id,kind,group_key,title,body,sources,source_stamp,session_id,revised,undone,original,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,0,0,?,?,?)
      ON CONFLICT(resource_id,kind,group_key) DO UPDATE SET title=excluded.title,body=excluded.body,sources=excluded.sources,source_stamp=excluded.source_stamp,session_id=excluded.session_id,undone=0,original=excluded.original,updated_at=excluded.updated_at`).run(id,projectId,input.kind,input.key,title,body,JSON.stringify(source.events),source.stamp,v.text(sessionId,'会话编号',128),JSON.stringify({title,body}),previous?.created_at||now,now)
    return this.get(projectId,id)
  }
  edit(projectId:string,id:string,patch:{title:string;body:string}) {this.get(projectId,id);v.keys(patch,['title','body']);this.db.prepare('UPDATE project_summaries SET title=?,body=?,revised=1,updated_at=? WHERE id=?').run(v.name(patch.title),v.text(patch.body,'摘要内容',50000),Date.now(),id);return this.get(projectId,id)}
  undo(projectId:string,id:string){const item=this.get(projectId,id);if(item.revised)return {undone:false,reason:'摘要已人工修订，已保留'};this.db.prepare('UPDATE project_summaries SET undone=1,updated_at=? WHERE id=?').run(Date.now(),id);return {undone:true,reason:'已撤销摘要；原始记录和会话保留'}}
}
