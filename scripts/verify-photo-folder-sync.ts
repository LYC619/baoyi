import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { PhotoFolderSync } from '../electron/kinds/image/folder-sync.ts'
import { pngImage } from './helpers/test-images.ts'
const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-photo-sync-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
const library=new ImageLibrary(db);let events=0
const sync=new PhotoFolderSync(()=>db,()=>events++)
try {
  const folder=path.join(root,'浏览保存');await fs.mkdir(folder)
  const first=path.join(folder,'1.png');await fs.writeFile(first,pngImage(80,120))
  const item=library.register((await scanImageImport(folder,'photo',false))[0])
  const group=library.saveGroup({name:'浏览保存',type:'photo',directory:folder});library.update(item.id,{groupId:group.id})
  const pid=library.pages(item.id)[0].id;library.saveProgress(item.id,pid,0)
  await sync.sync();await sync.sync();const baseline=events,stamp=library.get(item.id)!.updatedAt
  await sync.sync();assert.equal(events,baseline);assert.equal(library.get(item.id)!.updatedAt,stamp)
  const second=path.join(folder,'2.png');await fs.writeFile(second,pngImage(120,80))
  await sync.sync();assert.equal(library.pages(item.id).length,1,'wait for stable copy')
  await sync.sync();assert.equal(library.pages(item.id).length,2);assert.equal(library.get(item.id)!.groupId,group.id);assert.equal(library.get(item.id)!.progress!.pageId,pid)
  await fs.unlink(second);await sync.sync();await sync.sync();assert.equal(library.pages(item.id).length,1)
  await fs.rename(folder,folder+'-offline');await sync.sync();assert.equal(library.pages(item.id).length,1,'offline root preserves index')
  await fs.rename(folder+'-offline',folder);await fs.unlink(first);await sync.sync();await sync.sync();assert.equal(library.pages(item.id).length,0,'empty accessible folder clears gallery only')
  await fs.writeFile(first,pngImage(80,120));await sync.sync();await sync.sync();assert.equal(library.pages(item.id)[0].id,pid)
  library.remove(item.id);await sync.sync();assert.equal(library.list().length,0,'removed albums stay removed')
  console.log('PASS stable add/remove/restore, identity/progress, idle no-op, offline root and index removal')
}finally{sync.stop();db.close();assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true})}
