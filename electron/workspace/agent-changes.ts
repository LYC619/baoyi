import {randomUUID} from 'node:crypto'
import type {SqlDb} from '../services/schema.ts'
import type {PersonalInput,DocumentPatch,LinkOwner,WorkspaceChange} from '../../src/types/workspace.ts'
import {PersonalLibrary,validatePersonal} from './personal.ts'
import {DocumentLibrary} from './documents.ts'
import {WorkspaceLinks} from './links.ts'
import * as v from './validation.ts'

type Snapshot=Record<string,any>
const documentFields=['name','type','author','counterpart','issuedOn','expiresOn','notes','tags','readState','customGroupId'] as const
const select=(value:Snapshot,fields:readonly string[])=>Object.fromEntries(fields.map(k=>[k,value[k]]))
// Match JSON persistence for undefined fields without parsing undefined as JSON.
const canonical=(value:any)=>JSON.stringify(value,(_key,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)?Object.fromEntries(Object.keys(entry).sort().map(key=>[key,entry[key]])):entry)
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b)
const documentSnapshot=(value:Snapshot):Snapshot=>({...value,customGroupId:value.customGroupId||null})

/** Before/after records are authoritative; replay never silently overwrites subsequent edits. */
export class WorkspaceChanges {
  db:SqlDb;personal:PersonalLibrary;documents:DocumentLibrary;links:WorkspaceLinks
  constructor(db:SqlDb,hideHentai=false){this.db=db;this.personal=new PersonalLibrary(db);this.documents=new DocumentLibrary(db);this.links=new WorkspaceLinks(db,hideHentai)}
  private item(row:any):WorkspaceChange {
    let before=JSON.parse(row.before_json),after=JSON.parse(row.after_json)
    // Older audit JSON omitted the ungrouped key; normalize on read, without rewriting history.
    if(row.entity==='document'){if(before)before=documentSnapshot(before);after=documentSnapshot(after)}
    return {id:row.id,sessionId:row.session_id,entity:row.entity,targetId:row.target_id,before,after,state:row.state,createdAt:row.created_at}
  }
  list(sessionId:string):WorkspaceChange[]{return this.db.prepare('SELECT * FROM workspace_changes WHERE session_id=? ORDER BY created_at,rowid').all(sessionId).map(r=>this.item(r))}
  get(id:string):WorkspaceChange {const row=this.db.prepare('SELECT * FROM workspace_changes WHERE id=?').get(v.text(id,'修改编号',128));if(!row)throw new Error('修改记录不存在');return this.item(row)}
  private snapshot(entity:WorkspaceChange['entity'],id:string):Snapshot|null {
    if(entity==='personal'){const item=this.personal.get(id);return item?select(item,['id','kind','name','body','data']):null}
    if(entity==='document'){const item=this.documents.get(id);return item?documentSnapshot(select(item,['id',...documentFields,'typeLocked','editedFields'])):null}
    const row=this.db.prepare('SELECT * FROM resource_links WHERE id=?').get(id) as any
    return row?{id:row.id,ownerType:row.owner_type,ownerId:row.owner_id,resourceId:row.resource_id,annotationId:row.annotation_id}:null
  }
  private latest(entity:WorkspaceChange['entity'],target:string):WorkspaceChange|null {const row=this.db.prepare("SELECT * FROM workspace_changes WHERE entity=? AND target_id=? AND state='applied' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(entity,target);return row?this.item(row):null}
  private record(sessionId:string,entity:WorkspaceChange['entity'],target:string,before:Snapshot|null,after:Snapshot,state:WorkspaceChange['state']) {
    const id=randomUUID();this.db.prepare('INSERT INTO workspace_changes(id,session_id,entity,target_id,before_json,after_json,state,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,sessionId,entity,target,JSON.stringify(before),JSON.stringify(after),state,Date.now());return this.get(id)
  }
  private proposeOrWrite(sessionId:string,entity:'personal'|'document',before:Snapshot,after:Snapshot,canWrite:boolean):WorkspaceChange {
    const existing=this.latest(entity,before.id)
    if(existing&&same(before,after)&&same(existing.after,after))return existing
    if(entity==='document'&&!canWrite){
      const pending=this.db.prepare("SELECT * FROM workspace_changes WHERE session_id=? AND entity=? AND target_id=? AND state='proposed' ORDER BY created_at DESC,rowid DESC").all(sessionId,entity,before.id).map(row=>this.item(row)).find(change=>same(change.before,before)&&same(change.after,after))
      if(pending)return pending
    }
    return v.transaction(this.db,()=>{if(canWrite)this.write(entity,before.id,after);return this.record(sessionId,entity,before.id,before,canWrite?this.snapshot(entity,before.id)!:after,canWrite?'applied':'proposed')})
  }
  savePersonal(sessionId:string,input:PersonalInput):WorkspaceChange {
    const old=input.id?this.personal.get(input.id):input.kind==='profile'?this.personal.get('self'):null
    if(input.id&&!old)throw new Error('个人记录不存在')
    const validated=validatePersonal({...input,data:{...old?.data,...input.data}})
    if(old){if(old.kind!==validated.kind)throw new Error('不能改变个人记录类型');const before=this.snapshot('personal',old.id)!,after={...validated,id:old.id},latest=this.latest('personal',old.id);return this.proposeOrWrite(sessionId,'personal',before,after,!!latest&&!same(latest.before,latest.after)&&same(latest.after,before))}
    // Idempotent tool retries return the original audit card, without creating a second record.
    const duplicate=this.personal.list(input.kind).find(r=>same(select(r,['kind','name','body','data']),select(validated,['kind','name','body','data'])))
    if(duplicate){const existing=this.latest('personal',duplicate.id);if(existing)return existing;return this.record(sessionId,'personal',duplicate.id,this.snapshot('personal',duplicate.id),this.snapshot('personal',duplicate.id)!,'applied')}
    return v.transaction(this.db,()=>{const item=this.personal.save(validated);return this.record(sessionId,'personal',item.id,null,this.snapshot('personal',item.id)!,'applied')})
  }
  updateDocument(sessionId:string,id:string,patch:DocumentPatch):WorkspaceChange {
    v.keys(patch,[...documentFields]);const item=this.documents.require(id),before=this.snapshot('document',item.id)!
    if(patch.type!==undefined){this.documents.category(patch.type);if(item.typeLocked&&patch.type!==item.type)throw new Error('用户已明确选择分类，请先由用户修改分类')}
    const after:Snapshot={...before,...patch}
    after.name=v.name(after.name);after.author=v.text(after.author,'作者',300);after.counterpart=v.text(after.counterpart,'相关方',300);after.issuedOn=v.date(after.issuedOn);after.expiresOn=v.date(after.expiresOn);after.notes=v.text(after.notes,'备注',20000);after.tags=v.strings(after.tags)
    after.customGroupId=after.customGroupId==null?null:v.text(after.customGroupId,'分组编号',128)||null
    if(!['unread','reading','read'].includes(after.readState))throw new Error('阅读状态无效')
    const automatic=Object.keys(patch).every(key=>same(before[key],after[key])||!item.editedFields.includes(key))
    return this.proposeOrWrite(sessionId,'document',before,after,automatic)
  }
  addLink(sessionId:string,owner:LinkOwner,ownerId:string,resourceId:string,annotationId=''):WorkspaceChange {
    const previous=this.links.list(owner,ownerId).find(r=>r.resourceId===resourceId&&r.annotationId===(annotationId||null))
    if(previous){const latest=this.latest('link',previous.id);if(latest)return latest;return this.record(sessionId,'link',previous.id,this.snapshot('link',previous.id),this.snapshot('link',previous.id)!,'applied')}
    return v.transaction(this.db,()=>{const linked=this.links.add(owner,ownerId,resourceId,annotationId);return this.record(sessionId,'link',linked.id,null,this.snapshot('link',linked.id)!,'applied')})
  }
  private write(entity:'personal'|'document',id:string,value:Snapshot) {
    if(entity==='personal')this.personal.save({...select(value,['kind','name','body','data']),id} as PersonalInput)
    else {this.documents.update(id,select(value,documentFields));this.db.prepare('UPDATE document_meta SET type_locked=?,edited_fields=? WHERE resource_id=?').run(Number(!!value.typeLocked),JSON.stringify(value.editedFields||[]),id)}
  }
  apply(id:string):WorkspaceChange {
    const change=this.get(id);if(change.state!=='proposed')return change
    if(!same(this.snapshot(change.entity,change.targetId),change.before))throw new Error('记录已变化，此建议已过期，请重新整理')
    return v.transaction(this.db,()=>{if(change.entity==='link')throw new Error('不支持的修改');this.write(change.entity,change.targetId,change.after);this.db.prepare("UPDATE workspace_changes SET state='applied',after_json=? WHERE id=?").run(JSON.stringify(this.snapshot(change.entity,change.targetId)),id);return this.get(id)})
  }
  undo(id:string):{undone:boolean;reason:string} {
    const change=this.get(id)
    if(change.state==='undone')return {undone:false,reason:'已经撤销'}
    if(change.state==='proposed'){this.db.prepare("UPDATE workspace_changes SET state='undone' WHERE id=?").run(id);return {undone:true,reason:'已取消待确认建议，原记录未改动'}}
    if(!same(this.snapshot(change.entity,change.targetId),change.after))return {undone:false,reason:'记录已有后续修改，已保留；请先撤销较新的修改或手动编辑'}
    if(change.entity==='personal'&&!change.before&&this.db.prepare('SELECT 1 FROM resource_links WHERE owner_personal_id=? LIMIT 1').get(change.targetId))return {undone:false,reason:'记录已添加关联，已保留；可先撤销关联'}
    v.transaction(this.db,()=>{
      if(change.before){if(change.entity!=='link')this.write(change.entity,change.targetId,change.before)}
      else if(change.entity==='personal')this.personal.remove(change.targetId)
      else if(change.entity==='link')this.links.remove(change.after.ownerType,change.after.ownerId,change.targetId)
      else throw new Error('不能通过此操作移除资料')
      this.db.prepare("UPDATE workspace_changes SET state='undone' WHERE id=?").run(id)
    })
    return {undone:true,reason:'已撤销，恢复到修改前的内容'}
  }
}
