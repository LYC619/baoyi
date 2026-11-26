import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {PersonalLibrary} from '../electron/workspace/personal.ts'
import {ArchiveLibrary} from '../electron/archive/library.ts'
import {ArchiveAssistant} from '../electron/archive/service.ts'
import {ImageLibrary} from '../electron/kinds/image/library.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {updateGame} from '../electron/kinds/game/db.ts'
import {updateVideo} from '../electron/kinds/video/db.ts'
import {buildLibraryBackup,restoreLibraryBackup} from '../electron/services/storage/library-backup.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'

async function fixture(t:any){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-archive-')),db=new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
  db.exec(VIDEO_JOBS_SQL)
  const docs=new DocumentLibrary(db),personal=new PersonalLibrary(db)
  const file=path.join(root,'工程说明.md');await fs.writeFile(file,'# 桥梁档案\n验收口令：青松白鹭。\n2026 年修订，长度为 42 米。')
  const doc=await docs.register(file,'paper')
  const todo=personal.save({kind:'todo',name:'核对桥梁归档',body:'保留不同版本',data:{}})
  const library=new ArchiveLibrary({db,hideHentai:()=>true,assets:path.resolve('dist/pdfjs')})
  t.after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true})})
  return {root,db,docs,personal,doc,todo,library}
}

test('search crosses archives and personal records, respects recycle and privacy, and returns usable source IDs',async t=>{
  const {library,db,doc,todo}=await fixture(t)
  assert.equal(library.search({query:'桥梁'}).items.some(x=>x.id===todo.id),true)
  assert.equal(library.search({query:'工程'}).items[0].id,doc.id)
  db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,name_zh,category) VALUES('hidden-video','video',1,1,'C:/fixture/hidden','hidden','工程秘密','里番')").run()
  assert.equal(library.search({query:'工程'}).items.some(x=>x.id==='hidden-video'),false)
  assert.throws(()=>library.get('hidden-video'),/不可用/)
  db.prepare("INSERT INTO document_recycle(id,resource_id,state,created_at,expires_at,payload) VALUES('recycle',?,'indexed',1,2,'{}')").run(doc.id)
  assert.equal(library.search({query:'工程'}).items.length,0)
  assert.throws(()=>library.get(doc.id),/不可用/)
})

test('explicit metadata change is persisted and undoable, retry is idempotent, later manual edits survive',async t=>{
  const {library,docs,doc}=await fixture(t),source=library.get(doc.id)
  const result=library.update('session',[{id:doc.id,version:source.version,patch:{notes:'已核对',tags:['桥梁']}}],'按用户要求整理')
  assert.equal(docs.get(doc.id)!.notes,'已核对')
  const next=library.get(doc.id)
  assert.equal(library.update('session',[{id:doc.id,version:next.version,patch:{notes:'已核对',tags:['桥梁']}}],'重试').changes.length,0)
  assert.equal(library.undo(result.changes[0].id).undone,true)
  assert.equal(docs.get(doc.id)!.notes,'')
  const changed=library.update('session',[{id:doc.id,version:library.get(doc.id).version,patch:{notes:'整理结果'}}],'整理')
  docs.update(doc.id,{notes:'用户后来手改'})
  assert.equal(library.undo(changed.changes[0].id).undone,false)
  assert.equal(docs.get(doc.id)!.notes,'用户后来手改')
})

test('stale metadata and invalid batch roll back without overwriting the live resource',async t=>{
  const {library,docs,doc,todo}=await fixture(t),old=library.get(doc.id)
  docs.update(doc.id,{notes:'新内容'})
  assert.throws(()=>library.update('session',[{id:doc.id,version:old.version,patch:{notes:'旧内容'}}],'整理'),/变化/)
  assert.throws(()=>library.update('session',[
    {id:doc.id,version:library.get(doc.id).version,patch:{notes:'不应保存'}},
    {id:todo.id,version:library.get(todo.id).version,patch:{path:'C:/wrong'}}
  ],'整理'),/字段|修改/)
  assert.equal(docs.get(doc.id)!.notes,'新内容');assert.equal(library.actions().length,0)
  assert.throws(()=>library.update('session',[{id:doc.id,version:library.get(doc.id).version,patch:{category:'book',groupId:'group'}}],'归类'),/document 不支持字段：category、groupId.*customGroupId/)
})

test('full text search reads real text, reports stale file changes and missing sources',async t=>{
  const {library,doc}=await fixture(t)
  const found=await library.searchText({query:'青松白鹭'})
  assert.equal(found.matches[0].id,doc.id);assert.match(found.matches[0].text,/42/)
  await fs.writeFile(doc.path,'新的验收口令：苍山翠竹。')
  assert.equal((await library.searchText({query:'青松白鹭'})).matches.length,0)
  assert.equal((await library.searchText({query:'苍山翠竹'})).matches.length,1)
  await fs.unlink(doc.path)
  assert.equal((await library.searchText({query:'苍山翠竹'})).matches.length,0)
  assert.equal((await library.check([doc.id])).items[0].available,false)
})

test('personal edits and creation preserve types, retry once and back up undo records and interrupted runs',async t=>{
  const {library,db,todo,personal}=await fixture(t)
  const action=library.update('session',[{id:todo.id,version:library.get(todo.id).version,patch:{data:{done:true}}}],'完成待办').changes[0]
  assert.equal(personal.get(todo.id)!.data.done,true)
  assert.equal(library.undo(action.id).undone,true)
  const input={kind:'asset',name:'隔离工具订阅',body:'合成资料',data:{cost:12,currency:'CNY',cycle:'monthly'}}
  const created=library.createPersonal('session',input)
  assert.equal(created.created,true);assert.equal(library.createPersonal('session',input).created,false)
  db.prepare("INSERT INTO archive_runs VALUES('session','running','合成任务','',1,1,'public')").run()
  const backup=buildLibraryBackup(db)
  assert.equal(backup.tables.archive_actions.length,2)
  restoreLibraryBackup(db,backup)
  assert.equal((db.prepare('SELECT status FROM archive_runs').get() as any).status,'interrupted')
  assert.ok('action' in created)
  assert.equal(library.undo(created.action.id).undone,true)
  assert.equal(personal.get(created.source.id),null)
})

test('action history follows the conversation privacy scope and keeps undone creations',async t=>{
  const {library,db,todo}=await fixture(t)
  const unrestricted=new ArchiveLibrary({db,hideHentai:()=>false,assets:path.resolve('dist/pdfjs')})
  const hidden=unrestricted.update('all-session',[{id:todo.id,version:unrestricted.get(todo.id).version,patch:{body:'完整范围中的整理'}}],'完整范围的私人要求').changes[0]
  assert.equal(library.actions().length,0)
  assert.throws(()=>library.undo(hidden.id),/不可用|范围/)
  const created=library.createPersonal('public-session',{kind:'todo',name:'临时核对',data:{}})
  assert.ok('action' in created)
  library.undo(created.action.id)
  assert.equal(library.actions('public-session')[0].state,'undone')
})

test('document undo restores the original category and edit protections without locking unrelated fields',async t=>{
  const {library,db,doc}=await fixture(t)
  const protections=()=>db.prepare('SELECT type_locked,edited_fields FROM document_meta WHERE resource_id=?').get(doc.id)
  const before=protections(),initial=library.get(doc.id)
  const result=library.update('session',[{id:doc.id,version:initial.version,patch:{notes:'核验完成',type:'book'}}],'归档修改')
  assert.equal(library.undo(result.changes[0].id).undone,true)
  assert.deepEqual(protections(),before)
  assert.deepEqual(library.get(doc.id).metadata,initial.metadata)
})

test('catalog hides private categories and new taxonomy is reusable without duplicating groups',async t=>{
  const {library,docs}=await fixture(t)
  assert.ok(!library.catalog().categories.some((c:any)=>c.kind==='video'&&c.name==='里番'))
  const created=library.createTaxonomy({kind:'document_category',name:'工程验收',submodule:'archive',description:'竣工与验收记录'})
  assert.equal(created.created,true)
  const category=created.item
  assert.equal(library.createTaxonomy({kind:'document_category',name:'工程验收',submodule:'archive'}).item.id,category.id)
  const group=library.createTaxonomy({kind:'document_group',name:'青松桥',categoryId:category.id})
  assert.equal(library.createTaxonomy({kind:'document_group',name:'青松桥',categoryId:category.id}).created,false)
  assert.equal(docs.customGroups().find(x=>x.id===group.item.id)!.submodule,'archive')
  assert.throws(()=>library.createTaxonomy({kind:'document_group',name:'无效组',categoryId:'missing'}),/不存在/)
})

test('retry after startup failure retains the original request before the new turn',async t=>{
  const {db,root}=await fixture(t)
  db.prepare("INSERT INTO archive_runs VALUES('retry','failed','请查找青松桥原始验收材料','启动失败',1,1,'public')").run()
  const events:any[]=[],calls:any[]=[]
  const assistant=new ArchiveAssistant({db,home:root,runtime:root,bridge:root,assets:root,hideHentai:()=>true,current:()=>true,
    config:()=>({enabled:true,api_url:'http://fixture',api_key:'fixture',model:'fixture'}) as any,
    event:e=>events.push(e),changed:()=>{},operation:async action=>action(),updateResource:()=>{}})
  assistant.runtime.start=async()=>{}
  assistant.runtime.request=async(method:string,args:any={})=>{calls.push({method,args});return (method==='run'?{sessionId:'retry',completed:true}:null) as any}
  assistant.send({sessionId:'retry',text:'继续上次任务'})
  for(let n=0;n<100&&assistant.running;n++)await new Promise(r=>setTimeout(r,5))
  assert.equal(events.at(-1).event,'finished')
  const previous=calls.find(x=>x.method==='ensure_session')
  assert.ok(previous,'原请求必须写入 Hermes 历史后再继续')
  assert.equal(previous.args.text,'请查找青松桥原始验收材料')
  assert.ok(calls.indexOf(previous)<calls.findIndex(x=>x.method==='run'))
  await assistant.dispose()
})

test('archive adapters save and undo actual game, video, image and project metadata',async t=>{
  const {db,root}=await fixture(t),images=new ImageLibrary(db),projects=new ProjectLibrary(db)
  const image=images.register({path:path.join(root,'images'),name:'合成图片',sourceDir:root,type:'photo',chapters:[],warnings:[]})
  const project=projects.register({path:path.join(root,'project'),name:'合成项目',summary:'',category:'其他',source:'unknown',version:'',entries:[],evidence:''} as any)
  for(const kind of ['game','video']){
    db.prepare('INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,name_zh,name_en,category) VALUES(?,?,1,1,?,?,?,?,?)').run(kind,kind,path.join(root,kind),kind,'','Fixture '+kind,'其他')
    db.prepare(`INSERT INTO ${kind}_meta(resource_id) VALUES(?)`).run(kind)
  }
  const library=new ArchiveLibrary({db,hideHentai:()=>true,assets:root,updateResource:(kind,id,patch)=>kind==='game'?updateGame(db,id,patch):updateVideo(db,id,patch)})
  const cases=[
    {id:image.id,patch:{description:'已核验',favorite:true,read:true,publication:'completed'}},
    {id:project.id,patch:{summary:'已核验',pinned:true,group:'工程'}},
    {id:'game',patch:{name:'合成游戏',notes:'已核验',tags:['测试']}},
    {id:'video',patch:{name:'合成影视',notes:'已核验',tags:['测试']}}
  ]
  for(const {id,patch} of cases){
    const original=library.get(id),action=library.update('session',[{id,version:original.version,patch}],'类型读写验证').changes[0]
    const saved=library.get(id)
    for(const [key,value] of Object.entries(patch))assert.deepEqual(saved.metadata[key],value)
    assert.equal(library.undo(action.id).undone,true)
    assert.deepEqual(library.get(id).metadata,original.metadata)
    assert.equal(library.get(id).version,original.version)
  }
})

test('finds annotation-only clues and exposes manual edit protections to the assistant',async t=>{
  const {library,docs,doc}=await fixture(t)
  docs.annotate(doc.id,{kind:'bookmark',quote:'',note:'紫藤风铃是这份资料的特殊线索',location:{page:1,offset:0}})
  assert.equal(library.search({query:'紫藤风铃'}).items[0]?.id,doc.id)
  docs.update(doc.id,{author:'手动登记作者'})
  const detail=library.get(doc.id)
  assert.ok(detail.protectedFields.includes('author'))
  assert.ok(detail.protectedFields.includes('type'))
})

test('an available document copy remains readable when the primary file is offline',async t=>{
  const {library,db,doc,root}=await fixture(t),copy=path.join(root,'可用副本.md')
  await fs.copyFile(doc.path,copy)
  db.prepare('INSERT INTO document_files(id,resource_id,path,created_at) VALUES(?,?,?,1)').run('copy',doc.id,copy)
  await fs.unlink(doc.path)
  const checked=(await library.check([doc.id])).items[0]
  assert.equal(checked.available,true)
  assert.equal(checked.path,copy)
  assert.equal(library.get(doc.id).path,copy)
  const read=await library.read(doc.id)
  assert.ok('text' in read)
  assert.match(read.text,/青松白鹭/)
})

test('assistant file tools preview, move, undo and relocate real isolated files',async t=>{
  const {db,root,doc,docs}=await fixture(t),target=path.join(root,'organized');await fs.mkdir(target)
  const assistant=new ArchiveAssistant({db,home:root,runtime:root,bridge:root,assets:root,hideHentai:()=>true,current:()=>true,config:()=>({}) as any,event:()=>{},changed:()=>{},operation:async action=>action(),updateResource:()=>{}})
  t.after(()=>assistant.dispose())
  const tool=async(name:string,args:any)=>JSON.parse(await(assistant as any).execute('files',name,args))
  const original=await fs.readFile(doc.path)
  const preview=await tool('archive_organize',{action:'preview',ids:[doc.id],rootDir:target,mode:'move'})
  assert.equal(preview.items.length,1);assert.equal(preview.items[0].status,'ready')
  assert.deepEqual(await fs.readFile(doc.path),original)
  const moved=await tool('archive_organize',{action:'execute',token:preview.token})
  assert.equal(moved.succeeded,1,JSON.stringify(moved));assert.equal(moved.failed,0)
  assert.deepEqual(await fs.readFile(moved.items[0].destination),original)
  assert.equal(await fs.stat(doc.path).catch(()=>null),null)
  assert.equal(docs.require(doc.id).path,moved.items[0].destination)
  assert.equal((await tool('archive_organize',{action:'undo',operationId:moved.items[0].operationId})).undone,true)
  assert.deepEqual(await fs.readFile(doc.path),original)
  const relocated=path.join(root,'found');await fs.mkdir(relocated);const file=path.join(relocated,path.basename(doc.path));await fs.rename(doc.path,file)
  assert.equal((await tool('archive_locate',{id:doc.id,directory:relocated})).matches[0].file,file)
  await tool('archive_relocate',{id:doc.id,file})
  assert.equal(docs.require(doc.id).path,file)
  assert.deepEqual(await fs.readFile(file),original)
})

test('light chat stays light; task follow-ups and attached resources retain full capabilities',async t=>{
  const {db,root,doc}=await fixture(t),calls:any[]=[]
  const assistant=new ArchiveAssistant({db,home:root,runtime:root,bridge:root,assets:root,hideHentai:()=>true,current:()=>true,config:()=>({enabled:true,api_url:'http://fixture',api_key:'fixture',model:'fixture'}),event:()=>{},changed:()=>{},operation:async action=>action(),updateResource:()=>{}})
  t.after(()=>assistant.dispose());assistant.runtime.start=async()=>{}
  assistant.runtime.run=async(args:any)=>{calls.push(args);return {completed:true,sessionId:args.sessionId} as any}
  async function send(input:any){const run=assistant.send(input);while(assistant.running)await new Promise(r=>setImmediate(r));return run.sessionId}
  const id=await send({text:'你好'});await send({sessionId:id,text:'解释彩虹'});assert.deepEqual(calls.map(c=>c.mode),['chat','chat']);assert.ok(calls.every(c=>c.tools.length===0))
  await send({sessionId:id,text:'读取这个资料'});await send({sessionId:id,text:'好的'});assert.ok(calls.slice(2).every(c=>c.mode==='archive'&&c.tools.length>20))
  await send({text:'你好',contextIds:[doc.id]});assert.equal(calls.at(-1).mode,'archive')
})

test('stopping a turn waits for its already accepted file operation before marking it idle',async t=>{
  const {db,root,doc,docs}=await fixture(t),target=path.join(root,'stopped-copy');await fs.mkdir(target)
  let commit!:()=>void,entered!:()=>void,finish!:(value:any)=>void,completed!:()=>void
  const gate=new Promise<void>(resolve=>{commit=resolve}),started=new Promise<void>(resolve=>{entered=resolve}),ended=new Promise<void>(resolve=>{completed=resolve})
  let accepted:Promise<string>|undefined
  const assistant=new ArchiveAssistant({db,home:root,runtime:root,bridge:root,assets:root,hideHentai:()=>true,current:()=>true,
    config:()=>({enabled:true,api_url:'http://fixture',api_key:'fixture',model:'fixture'}) as any,
    event:e=>{if(e.event==='finished')completed()},changed:()=>{},operation:async action=>{entered();await gate;return action()},updateResource:()=>{}})
  t.after(()=>assistant.dispose())
  assistant.runtime.start=async()=>{}
  assistant.runtime.request=async(method:string,args:any={})=>{
    if(method==='run'){
      const preview=JSON.parse(await(assistant as any).execute(args.sessionId,'archive_organize',{action:'preview',ids:[doc.id],rootDir:target,mode:'copy'}))
      accepted=(assistant as any).execute(args.sessionId,'archive_organize',{action:'execute',token:preview.token})
      return new Promise(resolve=>{finish=resolve}) as any
    }
    return true as any
  }
  assistant.send({text:'复制这份资料到已指定目录'})
  await started;await assistant.cancel();finish({interrupted:true})
  await new Promise(resolve=>setImmediate(resolve))
  assert.ok(assistant.running,'已开始的文件操作未完成时，不能显示空闲或启动下一任务')
  commit();await accepted;await ended
  assert.equal(assistant.running,null)
  const saved=docs.require(doc.id)
  assert.deepEqual(await fs.readFile(saved.path),await fs.readFile(doc.path))
  const copies=db.prepare('SELECT path FROM document_files WHERE resource_id=?').all(doc.id) as Array<{path:string}>
  assert.ok(copies.some(x=>x.path.startsWith(target)))
})

test('large archive tool results remain complete JSON and can be resumed without repeating writes',async t=>{
  const {db,root,doc,docs}=await fixture(t)
  docs.update(doc.id,{notes:'长备注 "\n😀'.repeat(2400)})
  const assistant=new ArchiveAssistant({db,home:root,runtime:root,bridge:root,assets:root,hideHentai:()=>true,current:()=>true,config:()=>({}) as any,event:()=>{},changed:()=>{},operation:async action=>action(),updateResource:()=>{}})
  t.after(()=>assistant.dispose())
  const read=async(name:string,args:any)=>{
    let raw=await(assistant as any).execute('long',name,args),text='',pages=0
    assert.ok(raw.length<=18000,'Hermes 不能截断仍含 version、来源和续读位置的 JSON')
    let result=JSON.parse(raw)
    while(result.format==='json-fragment'){
      text+=result.text;pages++
      if(!result.next)break
      raw=await(assistant as any).execute('long','archive_result',{cursor:result.next})
      assert.ok(raw.length<=18000);result=JSON.parse(raw)
    }
    return {value:text?JSON.parse(text):result,pages}
  }
  const detail=await read('archive_get',{id:doc.id})
  assert.ok(detail.pages>1);assert.deepEqual(detail.value,JSON.parse(JSON.stringify(assistant.library.get(doc.id))))
  const update=await read('archive_update',{changes:[{id:doc.id,version:detail.value.version,patch:{notes:detail.value.metadata.notes+'保留全部内容'}}],reason:'长备注补充'})
  assert.equal(update.value.changed,1);assert.equal(assistant.library.actions().length,1)
  assert.equal(docs.require(doc.id).notes,detail.value.metadata.notes+'保留全部内容')
})
