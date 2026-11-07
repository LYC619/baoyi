import fs from 'node:fs/promises'
import {constants,existsSync} from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import type {SqlDb} from '../services/schema.ts'
import {DocumentLibrary} from './documents.ts'
import {DocumentFiles,actualDirectory,inspectActualFile,type FileStamp} from './document-files.ts'
import {samePath} from '../kinds/project/paths.ts'
import {transaction} from './validation.ts'
import type {DocumentItem} from '../../src/types/workspace.ts'

export interface RecycleFile {source:string;stored:string;stamp:FileStamp;storedIdentity:string;state:'pending'|'stored'|'restored'|'purged';restoredTo:string}
export interface RecycleRecord {id:string;documentId:string;name:string;root:string;createdAt:number;expiresAt:number;state:'indexed'|'recycled'|'attention'|'restored'|'purged';files:RecycleFile[];snapshot:DocumentItem;error:string;restoring?:boolean}
export function addCalendarMonth(value:number){
  const date=new Date(value),day=date.getDate();date.setDate(1);date.setMonth(date.getMonth()+1)
  const last=new Date(date.getFullYear(),date.getMonth()+1,0).getDate();date.setDate(Math.min(day,last));return date.getTime()
}
const sameStamp=(a:FileStamp,b:FileStamp)=>a.identity===b.identity&&a.digest===b.digest&&a.size===b.size
const sameContent=(a:FileStamp,b:FileStamp)=>a.digest===b.digest&&a.size===b.size
export class DocumentRecycle {
  readonly db:SqlDb;private dataRoot:()=>string;private now:()=>number
  constructor(db:SqlDb,dataRoot:()=>string,now:()=>number=Date.now){this.db=db;this.dataRoot=dataRoot;this.now=now}
  list():RecycleRecord[]{return (this.db.prepare("SELECT payload FROM document_recycle WHERE state!='restored' ORDER BY created_at DESC").all() as {payload:string}[]).map(r=>JSON.parse(r.payload))}
  get(id:string):RecycleRecord{const row=this.db.prepare('SELECT payload FROM document_recycle WHERE id=?').get(id) as {payload:string}|undefined;if(!row)throw new Error('回收记录不存在');return JSON.parse(row.payload)}
  private save(record:RecycleRecord){this.db.prepare('INSERT INTO document_recycle(id,resource_id,state,created_at,expires_at,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload').run(record.id,record.documentId,record.state,record.createdAt,record.expiresAt,JSON.stringify(record));return record}
  private async directory(record:RecycleRecord,create=false){
    const configured=this.dataRoot();if(!configured||!samePath(record.root,path.join(configured,'回收站')))throw new Error('请在资料设置中选择此记录原来的资料数据目录')
    await actualDirectory(configured)
    if(create&&!existsSync(record.root))await fs.mkdir(record.root)
    await actualDirectory(record.root)
    for(const [i,file] of record.files.entries()){
      const expected=path.join(record.root,record.id+'-'+i+path.extname(file.source))
      if(!samePath(file.stored,expected)||!samePath(path.dirname(file.stored),record.root)||samePath(file.source,file.stored))throw new Error('回收文件路径核验失败')
    }
  }
  async plan(id:string,paths:string[]):Promise<RecycleRecord>{
    const docs=new DocumentLibrary(this.db),snapshot=docs.require(id),createdAt=this.now(),recordId=randomUUID()
    if(!Array.isArray(paths)||paths.some(p=>typeof p!=='string')||paths.length>100)throw new Error('回收文件选择无效')
    const available=new DocumentFiles(this.db).locations(id).filter(f=>f.available)
    const selected=[...new Set(paths)];if(selected.some(p=>!available.some(f=>samePath(f.path,p))))throw new Error('所选文件不是此资料的登记位置')
    const data=this.dataRoot();if(selected.length&&!data)throw new Error('请先在资料设置中选择资料数据目录')
    const root=data?path.join(data,'回收站'):''
    const files:RecycleFile[]=[]
    for(const [i,source] of selected.entries()){
      if(root&&samePath(path.dirname(source),root))throw new Error('文件已在回收站内')
      files.push({source,stored:path.join(root,recordId+'-'+i+path.extname(source)),stamp:await inspectActualFile(source),storedIdentity:'',state:'pending',restoredTo:''})
    }
    const record:RecycleRecord={id:recordId,documentId:id,name:snapshot.name,root,createdAt,expiresAt:files.length?addCalendarMonth(createdAt):0,state:files.length?'attention':'indexed',files,snapshot,error:''}
    if(files.length)await this.directory(record,true)
    return record
  }
  async remove(plan:RecycleRecord){
    if(this.now()-plan.createdAt>30*60_000)throw new Error('删除预览已失效')
    new DocumentLibrary(this.db).require(plan.documentId)
    for(const file of plan.files)if(!sameStamp(await inspectActualFile(file.source),file.stamp))throw new Error('源文件在预览后发生变化')
    this.save(plan);return this.resume(plan.id)
  }
  async resume(id:string){
    const record=this.get(id);if(['indexed','recycled','restored','purged'].includes(record.state))return record
    if(record.restoring)throw new Error('此记录正在恢复，请继续恢复资料')
    try{
      await this.directory(record,true)
      for(const file of record.files){
        if(file.state==='pending'){
          if(!sameStamp(await inspectActualFile(file.source),file.stamp))throw new Error('源文件已变化，未删除')
          await fs.copyFile(file.source,file.stored,constants.COPYFILE_EXCL)
          const stamp=await inspectActualFile(file.stored);file.storedIdentity=stamp.identity
          if(!sameContent(stamp,file.stamp))throw new Error('回收副本校验失败，原文件已保留')
          file.state='stored';this.save(record)
        }
        if(file.state==='stored'&&existsSync(file.source)){
          await this.stored(record,file)
          if(!sameStamp(await inspectActualFile(file.source),file.stamp))throw new Error('源文件已变化，未删除')
          await fs.unlink(file.source)
        }
      }
      record.state=record.files.length?'recycled':'indexed';record.error='';return this.save(record)
    }catch(e){record.error=(e as Error).message;record.state='attention';this.save(record);throw e}
  }
  private async stored(record:RecycleRecord,file:RecycleFile){
    await this.directory(record)
    const stamp=await inspectActualFile(file.stored)
    if(stamp.identity!==file.storedIdentity||!sameContent(stamp,file.stamp))throw new Error('回收文件已变化，已保留文件，请人工检查')
  }
  async restore(id:string,targets:Record<string,string>={}){
    const record=this.get(id);if(record.state==='restored')return record
    record.restoring=true;record.state='attention';this.save(record)
    try{
      for(const file of record.files){
        if(file.state==='purged')continue
        if(file.state==='pending'){if(!sameStamp(await inspectActualFile(file.source),file.stamp))throw new Error('原路径文件已变化，请检查未完成回收记录');continue}
        const destination=file.restoredTo||targets[file.source]||file.source
        if(!path.isAbsolute(destination)||samePath(destination,file.stored))throw new Error('恢复目标无效')
        await actualDirectory(path.dirname(destination))
        const owner=this.db.prepare('SELECT id FROM resource WHERE path=? COLLATE NOCASE UNION ALL SELECT resource_id AS id FROM document_files WHERE path=? COLLATE NOCASE').all(destination,destination) as {id:string}[]
        if(owner.some(r=>r.id!==record.documentId))throw new Error('恢复目标已被其他资料占用')
        if(existsSync(destination)){
          const actual=await inspectActualFile(destination)
          if(!(file.restoredTo&&sameContent(actual,file.stamp))&&!(samePath(destination,file.source)&&sameStamp(actual,file.stamp)))throw new Error('原路径被占用，请选择新的恢复位置')
        }else{
          await this.stored(record,file);await fs.copyFile(file.stored,destination,constants.COPYFILE_EXCL)
          if(!sameContent(await inspectActualFile(destination),file.stamp))throw new Error('恢复副本校验失败')
        }
        file.restoredTo=destination;this.save(record)
        if(existsSync(file.stored)){await this.stored(record,file);await fs.unlink(file.stored)}
        file.state='restored';this.save(record)
      }
      transaction(this.db,()=>{
        for(const file of record.files.filter(f=>f.restoredTo)){
          this.db.prepare('UPDATE resource SET path=?,file_name=?,source_dir=? WHERE id=? AND path=? COLLATE NOCASE').run(file.restoredTo,path.basename(file.restoredTo),path.dirname(file.restoredTo),record.documentId,file.source)
          this.db.prepare('UPDATE document_files SET path=? WHERE resource_id=? AND path=? COLLATE NOCASE').run(file.restoredTo,record.documentId,file.source)
        }
        record.state='restored';record.error='';this.save(record)
      });return record
    }catch(e){record.error=(e as Error).message;this.save(record);throw e}
  }
  async cleanup(){
    const results:RecycleRecord[]=[]
    for(const record of this.list().filter(r=>r.state==='recycled'&&!r.restoring&&r.expiresAt>0&&r.expiresAt<=this.now())){
      try{
        for(const file of record.files.filter(f=>f.state==='stored')){
          await this.directory(record)
          if(existsSync(file.stored)){await this.stored(record,file);await fs.unlink(file.stored)}
          file.state='purged';this.save(record)
        }
        record.state='purged';record.error=''
      }catch(e){record.error=(e as Error).message}
      results.push(this.save(record))
    }
    return results
  }
}
