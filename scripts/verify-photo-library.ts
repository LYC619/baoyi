import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { planImageMove, moveImageItems } from '../electron/kinds/image/management.ts'
import { pngImage } from './helpers/test-images.ts'
import { readImagePage } from '../electron/kinds/image/files.ts'
import { imageSchema } from '../electron/kinds/image/schema.ts'
import { buildLibraryBackup,restoreLibraryBackup } from '../electron/services/storage/library-backup.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-photo-library-'))
const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
const library = new ImageLibrary(db)
try {
  const folder = path.join(root, 'incoming', '相册'); await fs.mkdir(folder, { recursive:true })
  await fs.writeFile(path.join(folder, '1.png'), pngImage(80, 120))
  const item = library.register((await scanImageImport(folder, 'photo', false))[0])
  const group = library.saveGroup({ name:'旅行', type:'photo' } as any)
  library.update(item.id, { groupId:group.id })
  assert.equal(library.get(item.id)?.groupId, group.id)
  initSchema(db, KINDS)
  assert.equal(library.get(item.id)?.groupId, group.id, 'restart preserves photo category')
  const comicGroup = library.saveGroup({name:'旅行', type:'comic'} as any)
  assert.throws(() => library.update(item.id, {groupId:comicGroup.id}), /分类/)
  assert.throws(() => library.bulkUpdate([item.id], {groupId:comicGroup.id}), /分类/)
  const destination = path.join(root, '照片'); await fs.mkdir(destination)
  let plan = await planImageMove(db, [item.id], destination, true)
  await moveImageItems(db, plan, async()=>{throw Error('must not trash')})
  const page = library.pages(item.id)[0]
  const other = path.join(root, 'incoming', '第二册'); await fs.mkdir(other)
  await fs.writeFile(path.join(other, '2.png'), pngImage(120, 80))
  const next = library.register((await scanImageImport(other, 'photo', false))[0])
  library.update(next.id, {groupId:group.id})
  plan = await planImageMove(db, [next.id], '', true)
  assert.equal(path.dirname(plan[0].destination), path.join(destination,'旅行'))
  await moveImageItems(db, plan, async()=>{})
  assert.equal(library.pages(item.id)[0].id, page.id)
  assert.equal((await planImageMove(db,[next.id],'',true)).length,0)
  assert.throws(()=>library.register({...{path:'',type:'misc',name:'',sourceDir:'',chapters:[],warnings:[]},path:library.get(next.id)!.path} as any),/已经以另一图片类型/)
  const miscDir=path.join(root,'杂图');await fs.mkdir(miscDir);await fs.writeFile(path.join(miscDir,'3.png'),pngImage(60,40))
  const misc=library.register((await scanImageImport(miscDir,'misc',false))[0]),miscGroup=library.saveGroup({name:'旅行',type:'misc'})
  library.bulkUpdate([misc.id],{groupId:miscGroup.id})
  const gallery=library.gallery([next.id,item.id,misc.id],1,2)
  assert.equal(gallery.total,3);assert.deepEqual(gallery.pages.map(p=>p.resourceId),[item.id,misc.id])
  library.saveGroup({...miscGroup,hidden:true});assert.equal(library.gallery([misc.id],0,120).total,0)
  await assert.rejects(readImagePage(db,library.gallery([next.id],0,1).pages[0].id+'x'),/不可用/)
  library.saveGroup({...miscGroup,hidden:false})
  library.saveGroup({...group,name:'旅行改名'})
  const anotherGroup=library.saveGroup({name:'归档',type:'photo',directory:path.join(root,'已存在分类')})
  await fs.mkdir(anotherGroup.directory)
  library.bulkUpdate([item.id],{groupId:anotherGroup.id})
  const reclassified=await planImageMove(db,[item.id],'',true)
  assert.equal(path.dirname(reclassified[0].destination),anotherGroup.directory)
  await moveImageItems(db,reclassified,async()=>{})
  assert.ok((await readImagePage(db,page.id)).data.length)
  db.exec(VIDEO_JOBS_SQL)
  const target=new DatabaseSync(':memory:');initSchema(target,KINDS);target.exec(VIDEO_JOBS_SQL)
  const backup=buildLibraryBackup(db);restoreLibraryBackup(target,backup)
  assert.equal(new ImageLibrary(target).get(misc.id)?.type,'misc')
  assert.equal(new ImageLibrary(target).groups().find(g=>g.id===anotherGroup.id)?.directory,anotherGroup.directory)
  target.close()
  console.log('PASS photo/misc categories, restart, cross-type protection, remembered and reclassified moves, gallery paging, hidden groups and backup restore')
} finally { db.close(); await fs.rm(root,{recursive:true,force:true}) }

// Rebuild the pre-26 schema with a real indexed work, then run the actual migration twice.
const old=new DatabaseSync(':memory:');old.exec('PRAGMA foreign_keys=ON')
const oldTables=imageSchema.tables.replace(", authors TEXT NOT NULL DEFAULT '[]'",'').replace("name TEXT NOT NULL, sort_order", "name TEXT NOT NULL UNIQUE, sort_order").replace(/,\s*item_type TEXT NOT NULL DEFAULT 'comic' CHECK\(item_type IN \('photo','comic','misc'\)\),\s*directory TEXT NOT NULL DEFAULT '', UNIQUE\(item_type,name\)/,'').replace("CHECK(item_type IN ('photo','comic','misc'))","CHECK(item_type IN ('photo','comic'))")
initSchema(old,KINDS.map(k=>k.kind==='image'?{...k,schema:{tables:oldTables}}:k))
old.prepare("INSERT INTO image_groups(id,name) VALUES('old-group','旧分类')").run()
old.prepare("INSERT INTO resource(id,kind,path,file_name,created_at,updated_at) VALUES('old','image','D:/old','old',1,1)").run()
old.prepare("INSERT INTO image_meta(resource_id,item_type,group_id,cover_page_id) VALUES('old','comic','old-group','old-page')").run()
old.prepare("INSERT INTO image_pages(id,resource_id,file,ordinal,size) VALUES('old-page','old','D:/old/1.png',0,1)").run()
old.prepare("INSERT INTO image_progress(resource_id,page_id,scroll_offset,updated_at) VALUES('old','old-page',0.4,1)").run()
old.prepare("UPDATE settings SET value='25' WHERE key='_schema'").run()
initSchema(old,KINDS);initSchema(old,KINDS)
assert.equal(new ImageLibrary(old).get('old')?.progress?.pageId,'old-page')
assert.equal(new ImageLibrary(old).get('old')?.groupId,'old-group')
assert.equal(new ImageLibrary(old).groups().find(g=>g.id==='old-group')?.type,'comic')
assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(),[])
old.exec(VIDEO_JOBS_SQL)
const legacy=buildLibraryBackup(old);legacy.schema_version=25
for(const group of legacy.tables.image_groups){delete (group as any).item_type;delete (group as any).directory}
const restored=new DatabaseSync(':memory:');initSchema(restored,KINDS);restored.exec(VIDEO_JOBS_SQL);restoreLibraryBackup(restored,legacy)
assert.equal(new ImageLibrary(restored).get('old')?.groupId,'old-group')
restored.close();old.close()
console.log('PASS pre-26 schema migration, foreign keys, stable page/progress IDs and legacy metadata restore')
