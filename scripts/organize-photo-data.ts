/** Explicit, one-shot migration. Requires a closed profile; never uses the app startup path. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'

const [profileArg,rootArg,outputArg,mode]=process.argv.slice(2)
assert.ok(profileArg&&rootArg&&outputArg&&['--plan','--apply','--fixture'].includes(mode),'Pass profile, image root, NEW output folder, --plan/--apply/--fixture')
const profile=fs.realpathSync(profileArg),root=fs.realpathSync(rootArg),output=path.resolve(outputArg)
const same=(a:string,b:string)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase()
const inside=(base:string,file:string)=>{const rel=path.relative(base,file);return rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)}
assert.ok(!inside(root,output)&&!inside(profile,output),'Evidence must stay outside source trees')
if(mode!=='--plan'&&mode!=='--fixture'){
 const running=spawnSync('powershell.exe',['-NoProfile','-Command',"Get-Process 抱一,electron -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"],{encoding:'utf8',windowsHide:true})
 assert.equal(running.stdout.trim(),'','Close BaoYi/Electron before real data maintenance')
}
fs.mkdirSync(output,{recursive:true})
const db=new DatabaseSync(path.join(profile,'baoyi.db'),{readOnly:mode==='--plan'});db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
type Row=Record<string,any>
const rows=db.prepare('SELECT r.id,r.path,m.item_type,m.group_id FROM resource r JOIN image_meta m ON m.resource_id=r.id').all() as Row[]
const groups=db.prepare('SELECT id,name FROM image_groups').all() as {id:string;name:string}[]
assert.equal((db.prepare("SELECT COUNT(*) n FROM image_download_jobs WHERE status IN ('queued','running','paused','failed','interrupted')").get() as Row).n,0,'Finish or clear outstanding image jobs first')
const manga=path.join(root,'漫画'),misc=path.join(root,'杂图'),photos=path.join(root,'照片')
const moves:Array<{source:string;destination:string}>=[]
for(const item of rows.filter(r=>r.item_type==='comic')){
 assert.ok(inside(root,item.path),'Comic is outside selected image root')
 if(inside(manga,item.path))continue
 const parts=path.relative(root,item.path).split(path.sep)
 const source=path.join(root,parts[0]);let destination=path.join(manga,parts[0])
 if(parts.length===1){const group=groups.find(g=>g.id===item.group_id);destination=path.join(manga,group?.name||'未分类',parts[0])}
 if(!moves.some(m=>same(m.source,source)))moves.push({source,destination})
}
const ai=path.join(root,'AI生图');if(fs.existsSync(ai))moves.push({source:ai,destination:misc})
for(const move of moves){
 assert.ok(inside(root,move.source)&&inside(root,move.destination)&&!same(root,move.source)&&!inside(move.source,move.destination))
 assert.equal(fs.realpathSync(move.source).toLowerCase(),path.resolve(move.source).toLowerCase(),'Source links are not supported')
 assert.ok(!fs.existsSync(move.destination),'Destination already exists: '+move.destination)
 let parent=path.dirname(move.destination);while(!fs.existsSync(parent))parent=path.dirname(parent)
 assert.equal(fs.realpathSync(parent).toLowerCase(),path.resolve(parent).toLowerCase(),'Destination links are not supported')
}
const translate=(value:string)=>{
 if(!value||!path.isAbsolute(value))return value
 const move=moves.find(m=>inside(m.source,value));return move?path.join(move.destination,path.relative(move.source,value)):value
}
const write=(name:string,value:unknown)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2),'utf8')
write('plan.json',{root,profile,moves,photoRoot:photos,comicCount:rows.filter(r=>r.item_type==='comic').length,oldImageIds:rows.map(r=>r.id)})
if(mode==='--plan'){console.log(JSON.stringify({moves:moves.length,comicCount:rows.filter(r=>r.item_type==='comic').length,plan:path.join(output,'plan.json')}));db.close();process.exit(0)}
const backup=path.join(output,'before.db');assert.ok(!fs.existsSync(backup),'Refusing to overwrite backup')
db.prepare('VACUUM INTO ?').run(backup)
const hash=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
type Entry={file:string;size:number;sha256:string}
function inventory(base:string):Entry[]{
 const result:Entry[]=[]
 function visit(dir:string){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);assert.ok(!fs.lstatSync(file).isSymbolicLink(),'Links must be handled separately');if(e.isDirectory())visit(file);else if(e.isFile()){result.push({file,size:fs.statSync(file).size,sha256:hash(file)});if(result.length%5000===0)console.log('Hashed '+result.length+' files')}}}
 visit(base);return result
}
const before=inventory(root);write('files-before.json',before)
const preservedTables=['image_progress','image_bookmarks','image_reader_state','image_chapters','image_collections','image_collection_members']
const preserved=Object.fromEntries(preservedTables.map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]))
const oldPages=db.prepare('SELECT id,resource_id,file,entry,ordinal,size,missing FROM image_pages ORDER BY id').all() as Row[]
const nonImages=db.prepare("SELECT * FROM resource WHERE kind<>'image' ORDER BY id").all()
const completed:typeof moves=[]
let transaction=false,committed=false
try{
 initSchema(db,KINDS)
 fs.mkdirSync(manga,{recursive:true})
 db.exec('BEGIN IMMEDIATE');transaction=true
 for(const move of moves){
  assert.ok(!fs.existsSync(move.destination),'Destination changed after preview')
  fs.mkdirSync(path.dirname(move.destination),{recursive:true})
  fs.renameSync(move.source,move.destination);completed.push(move);write('journal.json',{state:'moving',backup,completed})
 }
 for(const item of rows){
  const dest=translate(item.path)
  if(dest!==item.path){
   db.prepare('UPDATE resource SET path=?,source_dir=?,file_name=? WHERE id=?').run(dest,path.dirname(dest),path.basename(dest),item.id)
   for(const p of db.prepare('SELECT id,file FROM image_pages WHERE resource_id=?').all(item.id) as Row[])db.prepare('UPDATE image_pages SET file=? WHERE id=?').run(translate(p.file),p.id)
  }
  if(inside(misc,dest))db.prepare("UPDATE image_meta SET item_type='misc',group_id=NULL WHERE resource_id=?").run(item.id)
  if(inside(misc,dest))db.prepare("UPDATE resource SET category='杂图' WHERE id=?").run(item.id)
 }
 const lib=new ImageLibrary(db)
 for(const group of lib.groups()){
  const translated=translate(group.directory)
  if(translated!==group.directory)lib.saveGroup({...group,directory:translated})
 }
 for(const row of db.prepare('SELECT id,path FROM resource_links WHERE path<>\'\'').all() as Row[]){const translated=translate(row.path);if(translated!==row.path)db.prepare('UPDATE resource_links SET path=? WHERE id=?').run(translated,row.id)}
 // Download history stores roots as well as resource IDs; retain history while
 // pointing a completed work at its new parent for any future continuation.
 for(const row of db.prepare('SELECT id,payload FROM image_download_jobs').all() as Row[]){
  const job=JSON.parse(row.payload),item=rows.find(r=>r.id===job.resourceId)
  if(item)job.root=path.dirname(translate(item.path));else if(job.root)job.root=translate(job.root)
  db.prepare('UPDATE image_download_jobs SET payload=? WHERE id=?').run(JSON.stringify(job),row.id)
 }
 const imports:Row[]=[],skipped:Row[]=[]
 for(const [base,type]of [[photos,'photo'],[misc,'misc']] as const){
  if(!fs.existsSync(base))fs.mkdirSync(base,{recursive:true})
  for(const dir of fs.readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory())){
   const full=path.join(base,dir.name),existing=lib.list({type}).find(i=>same(i.path,full))
   const name=dir.name.slice(0,80),group=lib.groups().find(g=>g.type===type&&g.name===name)||lib.saveGroup({name,type,directory:full})
   if(existing){lib.update(existing.id,{groupId:group.id});continue}
   const scan=(await scanImageImport(full,type,false))[0]
   if(!scan.chapters.some(c=>c.pages.length)){skipped.push({path:full,warnings:scan.warnings});continue}
   assert.equal(scan.warnings.length,0,'Review scanner warnings before committing: '+scan.warnings.join('; '))
   const item=lib.register(scan);lib.update(item.id,{groupId:group.id});imports.push({id:item.id,type,path:item.path,pages:item.pageCount})
  }
 }
 for(const t of preservedTables)assert.deepEqual(db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all(),preserved[t],t+' must be preserved')
 for(const p of oldPages){const after=db.prepare('SELECT id,resource_id,file,entry,ordinal,size,missing FROM image_pages WHERE id=?').get(p.id) as Row;assert.deepEqual({...after},{...p,file:translate(p.file)})}
 assert.deepEqual(db.prepare("SELECT * FROM resource WHERE kind<>'image' ORDER BY id").all(),nonImages)
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
 // Check every original file at its final path, including videos and sidecars.
 let verified=0
 for(const file of before){const dest=translate(file.file);assert.equal(fs.statSync(dest).size,file.size);assert.equal(hash(dest),file.sha256);if(++verified%5000===0)console.log('Verified '+verified+' files')}
 for(const p of db.prepare('SELECT file FROM image_pages WHERE missing=0').all() as Row[])assert.ok(fs.existsSync(p.file),'Missing indexed file')
 db.exec('COMMIT');transaction=false;committed=true
 write('journal.json',{state:'committed',backup,completed})
 write('result.json',{status:'passed',profile,root,moves:completed,originalFiles:before.length,originalBytes:before.reduce((n,f)=>n+f.size,0),imports,skipped,counts:db.prepare('SELECT item_type,count(*) items,(SELECT count(*) FROM image_pages p JOIN image_meta im ON im.resource_id=p.resource_id WHERE im.item_type=m.item_type AND p.missing=0) pages FROM image_meta m GROUP BY item_type').all(),preservedTables,originalIndexedPages:oldPages.length,backup})
 console.log(JSON.stringify({status:'passed',moves:completed.length,filesVerified:before.length,registered:imports.length,skippedFolders:skipped.length,report:path.join(output,'result.json')}))
}catch(error){
 if(transaction)db.exec('ROLLBACK')
 if(!committed){for(const move of [...completed].reverse())fs.renameSync(move.destination,move.source);write('journal.json',{state:'rolled-back',backup,error:String(error)})}
 throw error
}finally{db.close()}
