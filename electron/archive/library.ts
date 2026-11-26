import fs from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import type {SqlDb} from '../services/storage/schema.ts'
import {DocumentLibrary} from '../workspace/documents.ts'
import {PersonalLibrary,validatePersonal} from '../workspace/personal.ts'
import {ProjectLibrary} from '../kinds/project/library.ts'
import {ImageLibrary} from '../kinds/image/library.ts'
import {WorkspaceLinks} from '../workspace/links.ts'
import {DocumentFiles} from '../workspace/document-files.ts'
import {readDocumentText} from '../workspace/document-text.ts'
import {readProjectTextPage,listProjectFilesPage,searchProjectText} from '../kinds/project/workspace.ts'
import {HENTAI_CATEGORY} from '../kinds/video/taxonomy.ts'
import {zhSearchKey} from '../../src/utils/zh.ts'
import * as v from '../workspace/validation.ts'
import {ensureArchiveSchema} from './schema.ts'
import type {ArchiveSource,ArchiveAction} from '../../src/types/archive.ts'

type Row=Record<string,any>
interface Options {db:SqlDb;hideHentai:()=>boolean;assets:string;updateResource?:(kind:string,id:string,patch:Row)=>unknown}
const fields:Record<string,string[]>={
  document:['name','type','author','counterpart','issuedOn','expiresOn','notes','tags','readState','submodule','customGroupId','favorite'],
  project:['name','summary','category','source','state','group','tags','pinned','notes'],
  image:['name','description','tags','groupId','favorite','read','publication'],
  personal:['name','body','data'],
  software:['name','summary','description','category','tags','notes'],
  game:['name','summary','description','category','tags','notes'],
  video:['name','summary','description','category','tags','notes']
}
const fieldHints:Record<string,string>={
  document:'文库分类使用 type（documentCategories 的 ID），分组使用 customGroupId（documentGroups 的 ID，null 为移出分组）。',
  image:'图片分类使用 groupId（imageGroups 的 ID，null 为移出分类）。',
  personal:'data 必须是完整对象，保留未要求修改的现有字段。'
}
function validatePatch(kind:string,patch:Row){
  const invalid=Object.keys(v.object(patch)).filter(key=>!fields[kind].includes(key))
  if(invalid.length)throw new Error(`${kind} 不支持字段：${invalid.join('、')}。可修改字段：${fields[kind].join('、')}。${fieldHints[kind]||''}`)
}
const select=(row:Row,keys:string[])=>Object.fromEntries(keys.map(k=>[k,row[k]??null]))
const canonical=(value:unknown)=>JSON.stringify(value,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)
const stamp=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex')
const visibility=`NOT EXISTS(SELECT 1 FROM document_recycle x WHERE x.resource_id=r.id AND x.state!='restored')
 AND NOT EXISTS(SELECT 1 FROM image_meta m JOIN image_groups g ON g.id=m.group_id WHERE m.resource_id=r.id AND g.hidden=1)
 AND NOT(r.kind='video' AND COALESCE(r.category,'')=? AND ?=1)`

/** Archive vocabulary over existing libraries. File writes remain in their journalled services. */
export class ArchiveLibrary {
  readonly db:SqlDb
  private docs:DocumentLibrary
  private personal:PersonalLibrary
  private options:Options
  constructor(options:Options){this.options=options;this.db=options.db;this.docs=new DocumentLibrary(this.db);this.personal=new PersonalLibrary(this.db);ensureArchiveSchema(this.db)}
  get scope(){return this.options.hideHentai()?'public':'all'}
  private row(id:string):Row {
    id=v.text(id,'资源编号',128)
    const row=this.db.prepare(`SELECT r.* FROM resource r WHERE r.id=? AND ${visibility}`).get(id,HENTAI_CATEGORY,Number(this.options.hideHentai())) as Row|undefined
    if(row)return row
    const personal=this.personal.get(id)
    if(personal)return {...personal,kind:'personal',subtype:personal.kind,path:'',updated_at:personal.updatedAt}
    throw new Error('资源不可用，可能已删除或隐藏')
  }
  private source(row:Row):ArchiveSource {return {id:row.id,kind:row.kind,subtype:row.subtype,name:row.name||row.name_zh||row.name_en||row.file_name,path:row.path,summary:(row.summary||row.body||row.description||row.notes||'').slice(0,400),tags:(typeof row.tags==='string'?JSON.parse(row.tags):row.tags||[]).slice(0,12),updatedAt:row.updated_at||0}}
  sourceById(id:string){const row=this.row(id),source=this.source(row);return row.kind==='document'?{...source,path:this.docs.require(id).path}:source}
  private protection(id:string,kind:string):Row|null {
    const table=kind==='document'?'document_meta':kind==='software'?'software_meta':kind==='video'?'video_meta':''
    if(!table)return null
    const columns=kind==='document'?'type_locked,edited_fields':kind==='software'?'category_locked':'user_edited'
    return this.db.prepare(`SELECT ${columns} FROM ${table} WHERE resource_id=?`).get(id) as Row||null
  }
  private snapshot(id:string,detail=this.get(id)):Row{return {...detail.metadata,_protection:this.protection(id,detail.kind)}}
  private restoreProtection(id:string,kind:string,value:Row|null){
    if(!value)return
    if(kind==='document')this.db.prepare('UPDATE document_meta SET type_locked=?,edited_fields=? WHERE resource_id=?').run(value.type_locked,value.edited_fields,id)
    if(kind==='software')this.db.prepare('UPDATE software_meta SET category_locked=? WHERE resource_id=?').run(value.category_locked,id)
    if(kind==='video')this.db.prepare('UPDATE video_meta SET user_edited=? WHERE resource_id=?').run(value.user_edited,id)
  }
  search(options:{query?:string;kinds?:string[];offset?:number;limit?:number}={}){
    const query=v.text(options.query||'','搜索内容',300),offset=v.number(options.offset??0,'起点',0,1e7),limit=v.number(options.limit??30,'数量',1,100)
    const tokens=zhSearchKey(query).split(/\s+/).filter(Boolean),kinds=options.kinds||[]
    const raw=this.db.prepare(`SELECT r.*,d.author,d.counterpart,(SELECT group_concat(a.quote||' '||a.note,' ') FROM document_annotations a WHERE a.resource_id=r.id) AS annotationText FROM resource r LEFT JOIN document_meta d ON d.resource_id=r.id WHERE ${visibility} ORDER BY r.updated_at DESC,r.id`).all(HENTAI_CATEGORY,Number(this.options.hideHentai())) as Row[]
    const personal:Row[]=this.personal.list().map(p=>({...p,kind:'personal',subtype:p.kind,path:'',updated_at:p.updatedAt}))
    const items=[...raw,...personal].filter(r=>!kinds.length||kinds.includes(r.kind)).filter(r=>{const value=zhSearchKey([r.name,r.name_zh,r.name_en,r.file_name,r.path,r.summary,r.description,r.notes,r.tags,r.body,r.author,r.counterpart,r.annotationText,JSON.stringify(r.data||{})].join(' '));return tokens.every(t=>value.includes(t))}).sort((a,b)=>b.updated_at-a.updated_at||a.id.localeCompare(b.id))
    return {items:items.slice(offset,offset+limit).map(r=>this.source(r)),preview:true,total:items.length,next:offset+limit<items.length?offset+limit:null}
  }
  get(id:string){
    const row=this.row(id),kind=row.kind
    const item:Row=kind==='document'?this.docs.require(id):kind==='personal'?this.personal.get(id)!:kind==='project'?new ProjectLibrary(this.db).get(id)!:kind==='image'?new ImageLibrary(this.db).get(id)!:{...row,name:row.name_zh,tags:JSON.parse(row.tags||'[]')}
    const metadata=select(item,fields[kind]),links=new WorkspaceLinks(this.db,this.options.hideHentai())
    const related=kind==='personal'?(['asset','skill','experience'].includes(row.subtype)?links.list(row.subtype,id):[]):links.backlinks(id)
    const protection=this.protection(id,kind),protectedFields=kind==='document'?[...new Set([...(item.editedFields||[]),...(item.typeLocked?['type']:[])])]:kind==='software'&&protection?.category_locked?['category']:kind==='video'?JSON.parse(protection?.user_edited||'[]'):[]
    return {...this.source(row),path:item.path??row.path,registeredPath:row.path,metadata,writableFields:fields[kind],fieldHints:fieldHints[kind]||'category 使用当前模块的分类名称。',protectedFields,version:stamp({metadata,protection}),related,...(kind==='document'?{annotations:this.docs.annotations(id),locations:new DocumentFiles(this.db).locations(id)}:{}),...(kind==='personal'?{recordKind:row.subtype}:{})}
  }
  catalog(){return {counts:this.search({limit:1}).total,documentCategories:this.docs.categories(),documentGroups:this.docs.customGroups(),imageGroups:new ImageLibrary(this.db).groups().filter(x=>!x.hidden),categories:this.db.prepare('SELECT kind,name FROM categories WHERE NOT(kind=\'video\' AND name=? AND ?=1) ORDER BY kind,sort_order').all(HENTAI_CATEGORY,Number(this.options.hideHentai()))}}
  createTaxonomy(input:{kind:string;name:string;submodule?:'archive'|'reading';description?:string;behavior?:'reading'|'contract'|'certificate'|'other';categoryId?:string;imageType?:'comic'|'photo'|'misc'}){
    const name=v.name(input.name)
    if(input.kind==='document_category'){
      const submodule=input.submodule||'archive',existing=this.docs.categories(submodule).find(x=>x.name===name)
      return existing?{item:existing,created:false}:{item:this.docs.saveCategory({name,submodule,description:input.description||'',behavior:input.behavior||(submodule==='reading'?'reading':'other'),order:this.docs.categories(submodule).length}),created:true}
    }
    if(input.kind==='document_group'){
      const category=this.docs.category(v.text(input.categoryId,'分类编号',128)),existing=this.docs.customGroups(category.submodule,category.id).find(x=>x.name===name)
      return existing?{item:existing,created:false}:{item:this.docs.saveCustomGroup({name,submodule:category.submodule,categoryId:category.id}),created:true}
    }
    if(input.kind==='image_group'){
      const images=new ImageLibrary(this.db),type=input.imageType||'comic',existing=images.groups().find(x=>x.name===name&&x.type===type)
      if(existing?.hidden)throw new Error('同名图片分类已隐藏，请在分类设置中处理')
      return existing?{item:existing,created:false}:{item:images.saveGroup({name,type}),created:true}
    }
    throw new Error('请选择文库分类、文库分组或图片分类')
  }
  async read(id:string,options:Row={}){
    const row=this.row(id)
    if(row.kind==='document')return {...await readDocumentText(this.db,id,options,this.options.assets),resource:this.source(row)}
    if(row.kind==='project')return {...await readProjectTextPage(row.path,options.path||'README.md',options.line||1,options.cursor),resource:this.source(row),relative:options.path||'README.md'}
    return this.get(id)
  }
  async projectFiles(id:string,options:Row={}){const row=this.row(id);if(row.kind!=='project')throw new Error('请选择项目资源');return listProjectFilesPage(row.path,options.path||'',options)}
  async projectSearch(id:string,relative:string,query:string,cursor?:any){const row=this.row(id);if(row.kind!=='project')throw new Error('请选择项目资源');return searchProjectText(row.path,relative,query,cursor)}
  async searchText(options:{query:string;ids?:string[];offset?:number;limit?:number},signal?:AbortSignal){
    const query=v.text(options.query,'正文关键词',200).trim().toLocaleLowerCase();if(!query)throw new Error('请输入正文关键词')
    const offset=options.offset??0,limit=Math.min(options.limit||12,30),all=options.ids?options.ids.map(id=>this.sourceById(id)).filter(x=>x.kind==='document'):this.search({kinds:['document'],limit:100,offset}).items
    const candidates=options.ids?all.slice(offset,offset+limit):all.slice(0,limit)
    const matches:Array<ArchiveSource&{text:string}>=[],unread:Array<{id:string;name:string;reason:string}>=[]
    for(const source of candidates){
      signal?.throwIfAborted()
      try{
        const pages=await this.documentPages(source.id,signal)
        for(const page of pages){const index=page.text.toLocaleLowerCase().indexOf(query);if(index>=0)matches.push({...source,page:page.page,line:page.line,text:page.text.slice(Math.max(0,index-100),index+query.length+300)})}
      }catch(e){if(signal?.aborted)throw e;unread.push({id:source.id,name:source.name,reason:(e as Error).message})}
    }
    const total=options.ids?all.length:this.search({kinds:['document'],limit:1}).total
    return {matches,unread,scanned:candidates.length,total,next:offset+candidates.length<total?offset+candidates.length:null}
  }
  private async documentPages(id:string,signal?:AbortSignal):Promise<Array<{text:string;page?:number;line?:number}>>{
    const doc=this.docs.require(id),stat=await this.docs.inspect(doc.path)
    if(['md','markdown','txt'].includes(doc.format)){
      if(stat.size>32*1024*1024)throw new Error('文件超过 32 MB，请使用逐段读取检索，未扫描此文件')
      const pages:Array<{text:string;line:number}>=[];let cursor:any
      do{signal?.throwIfAborted();const page=await readDocumentText(this.db,id,{cursor},this.options.assets);pages.push({text:page.text,line:page.source.startLine||1});cursor=page.next}while(cursor)
      // Search across chunk boundaries while retaining the starting line of the evidence.
      return pages.map((p,i)=>({...p,text:p.text+(pages[i+1]?.text.slice(0,300)||'')}))
    }
    if(doc.format!=='pdf')throw new Error('此格式暂不支持提取正文；标题、标签与摘录仍可正常检索')
    if(stat.size>128*1024*1024)throw new Error('PDF 超过 128 MB，未提取正文')
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),worker=await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    ;(globalThis as any).pdfjsWorker||={WorkerMessageHandler:worker.WorkerMessageHandler}
    const root=this.options.assets.replaceAll('\\','/').replace(/\/$/,'')+'/'
    const task=pdfjs.getDocument({data:new Uint8Array(await fs.readFile(doc.path)),useSystemFonts:true,disableFontFace:true,useWorkerFetch:false,cMapUrl:root+'cmaps/',cMapPacked:true,standardFontDataUrl:root+'standard_fonts/',verbosity:0})
    try{const pdf=await task.promise,pages:Array<{page:number;text:string}>=[];for(let page=1;page<=pdf.numPages;page++){signal?.throwIfAborted();const text=await(await pdf.getPage(page)).getTextContent();pages.push({page,text:text.items.map(x=>'str'in x?x.str+(x.hasEOL?'\n':' '):'').join('')})}if(!pages.some(x=>x.text.trim()))throw new Error('PDF 没有文字层，需要 OCR 后才能检索正文');return pages}finally{await task.destroy()}
  }
  private write(id:string,patch:Row){
    const row=this.row(id);validatePatch(row.kind,patch)
    if(patch.name!==undefined)patch.name=['software','game','video'].includes(row.kind)?v.text(patch.name,'名称',300):v.name(patch.name)
    if(patch.tags!==undefined)patch.tags=v.strings(patch.tags,50)
    for(const field of ['summary','description','category','notes'])if(patch[field]!==undefined)patch[field]=v.text(patch[field],field,field==='category'?80:field==='description'?50000:20000)
    for(const field of ['favorite','read','pinned'])if(patch[field]!==undefined&&typeof patch[field]!=='boolean')throw new Error('状态开关格式不正确')
    if(patch.publication!==undefined&&!['unknown','ongoing','completed'].includes(patch.publication))throw new Error('连载状态无效')
    if(row.kind==='document')this.docs.update(id,patch)
    else if(row.kind==='personal'){const old=this.personal.get(id)!;this.personal.save({id,kind:old.kind,name:patch.name??old.name,body:patch.body??old.body,data:patch.data||old.data})}
    else if(row.kind==='project')new ProjectLibrary(this.db).update(id,patch)
    else if(row.kind==='image')new ImageLibrary(this.db).update(id,patch)
    else{if(!this.options.updateResource)throw new Error('此资源修改服务尚未连接');this.options.updateResource(row.kind,id,{...patch,...(patch.name!==undefined?{name_zh:patch.name}:{})})}
  }
  update(sessionId:string,changes:Array<{id:string;version:string;patch:Row}>,reason:string){
    if(!Array.isArray(changes)||!changes.length||changes.length>100)throw new Error('每批修改需要 1–100 项')
    const ids=new Set<string>(),recorded:ArchiveAction[]=[]
    return v.transaction(this.db,()=>{for(const change of changes){
      if(ids.has(change.id))throw new Error('同一批不能重复修改同一资源');ids.add(change.id)
      const before=this.get(change.id);validatePatch(before.kind,change.patch)
      if(Object.entries(change.patch).every(([k,x])=>canonical(before.metadata[k])===canonical(x)))continue
      if(before.version!==change.version)throw new Error(`${before.name} 已发生变化，请重新读取再整理`)
      const original=this.snapshot(change.id,before)
      this.write(change.id,{...change.patch})
      const after=this.get(change.id),id=randomUUID()
      if(canonical(before.metadata)===canonical(after.metadata))throw new Error(`${before.name} 未产生有效修改，请核对字段和值`)
      this.db.prepare("INSERT INTO archive_actions VALUES(?,?,?,?,?,?,?,?,'applied',?,?)").run(id,sessionId,change.id,before.name,before.kind,v.text(reason,'整理原因',2000),JSON.stringify(original),JSON.stringify(this.snapshot(change.id,after)),Date.now(),this.scope)
      recorded.push(this.action(id))
    }return {changes:recorded,changed:recorded.length}})
  }
  createPersonal(sessionId:string,input:any){
    if(!['asset','experience','todo','metric','measurement'].includes(input.kind))throw new Error('请选择支持的个人记录类型')
    const value=validatePersonal({kind:input.kind,name:input.name,body:input.body||'',data:input.data||{}})
    const previous=this.personal.list(value.kind).find(x=>canonical(select(x,['kind','name','body','data']))===canonical(value))
    if(previous)return {source:this.get(previous.id),created:false}
    return v.transaction(this.db,()=>{const item=this.personal.save(value),source=this.get(item.id),id=randomUUID();this.db.prepare("INSERT INTO archive_actions VALUES(?,?,?,?,?,?,?,?,'applied',?,?)").run(id,sessionId,item.id,item.name,'personal','按用户要求新增个人记录','null',JSON.stringify(this.snapshot(item.id,source)),Date.now(),this.scope);return {source,created:true,action:this.action(id)}})
  }
  private action(id:string):ArchiveAction{const r=this.db.prepare('SELECT * FROM archive_actions WHERE id=? AND scope=?').get(id,this.scope) as Row;if(!r)throw new Error('操作记录在当前范围不可用');return {id:r.id,sessionId:r.session_id,targetId:r.target_id,name:r.name,kind:r.kind,reason:r.reason,before:JSON.parse(r.before_json),after:JSON.parse(r.after_json),state:r.state,createdAt:r.created_at}}
  actions(sessionId?:string):ArchiveAction[]{return (this.db.prepare('SELECT id FROM archive_actions WHERE scope=?'+(sessionId?' AND session_id=?':'')+' ORDER BY created_at DESC,rowid DESC LIMIT 200').all(this.scope,...(sessionId?[sessionId]:[])) as Row[]).map(r=>this.action(r.id)).filter(action=>{try{this.row(action.targetId);return true}catch{return action.kind==='personal'&&action.state==='undone'&&!action.before}})}
  undo(id:string){
    const action=this.action(id);if(action.state==='undone')return {undone:false,reason:'已经撤销'}
    const current=this.get(action.targetId),hasProtection=Object.hasOwn(action.after,'_protection')
    if(canonical(hasProtection?this.snapshot(action.targetId,current):current.metadata)!==canonical(action.after))return {undone:false,reason:'记录已有后续修改，已保留现状'}
    if(!action.before&&this.db.prepare('SELECT 1 FROM resource_links WHERE owner_personal_id=? LIMIT 1').get(action.targetId))return {undone:false,reason:'记录已添加关联，已保留'}
    return v.transaction(this.db,()=>{
      if(action.before){
        const patch=Object.fromEntries(Object.entries(action.before).filter(([key,value])=>key!=='_protection'&&canonical(value)!==canonical(action.after[key])))
        this.write(action.targetId,patch)
        if(hasProtection)this.restoreProtection(action.targetId,current.kind,action.before._protection as Row|null)
      }else this.personal.remove(action.targetId)
      this.db.prepare("UPDATE archive_actions SET state='undone' WHERE id=?").run(id);return {undone:true,reason:'已恢复修改前内容'}
    })
  }
  async check(ids:string[]){const items=[];for(const id of v.strings(ids,200)){const source=this.sourceById(id);if(source.kind==='personal'){items.push({...source,available:true});continue}try{const stat=await fs.stat(source.path);items.push({...source,available:true,size:stat.size,directory:stat.isDirectory(),...(source.kind==='document'?{locations:new DocumentFiles(this.db).locations(id)}:{})})}catch(e){items.push({...source,available:false,reason:(e as NodeJS.ErrnoException).code==='ENOENT'?'文件已移动或磁盘暂时不可用':(e as Error).message})}}return {items}}
}
