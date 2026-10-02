import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { saveImageCollection,removeImageCollection,imageCollections } from '../electron/kinds/image/collections.ts'
import { imageFileTarget,planImageMove,moveImageItems,removeImageFiles } from '../electron/kinds/image/management.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { readImagePage } from '../electron/kinds/image/files.ts'
import { pngImage } from './helpers/test-images.ts'
const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-image-management-')),db=new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
const library=new ImageLibrary(db)
try {
 const ids:string[]=[]
 for(const title of ['第一册','第二册']){const dir=path.join(root,'original',title);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'1.png'),pngImage(20,30));await fs.writeFile(path.join(dir,'附带说明.txt'),'all contents');ids.push(library.register((await scanImageImport(dir,'comic',false))[0]).id)}
 const collection=saveImageCollection(db,'上下册',ids)
 assert.equal(library.list()[0].collectionId,collection.id)
 assert.throws(()=>saveImageCollection(db,'另一合集',[ids[0]]),/其他合集/)
 saveImageCollection(db,'合集重命名',ids.slice().reverse(),collection.id)
 assert.deepEqual(imageCollections(db)[0].members,ids.slice().reverse())
 const page=library.pages(ids[0])[0];library.saveProgress(ids[0],page.id,0.2)
 const target=path.join(root,'new');await fs.mkdir(target)
 const plan=await planImageMove(db,ids,target)
 await fs.mkdir(plan[0].destination)
 await assert.rejects(planImageMove(db,ids,target),/同名/)
 await fs.rmdir(plan[0].destination)
 const result=await moveImageItems(db,plan,async()=>{throw new Error('same-volume should not trash')})
 assert.equal(result.moved,2);assert.equal(library.get(ids[0])!.progress!.pageId,page.id)
 assert.equal((await readImagePage(db,page.id)).mime,'image/png')
 assert.equal(await fs.readFile(path.join(library.get(ids[0])!.path,'附带说明.txt'),'utf8'),'all contents')
 await assert.rejects(imageFileTarget(db,ids[0],[library.get(ids[0])!.path]),/根目录/)
 removeImageCollection(db,collection.id)
 assert.ok(library.get(ids[0]));assert.equal(imageCollections(db).length,0)
 const trash=path.join(root,'trash');await fs.mkdir(trash)
 const crossTarget=path.join(root,'cross-volume');await fs.mkdir(crossTarget)
 const crossPlan=await planImageMove(db,[ids[1]],crossTarget),rename=fs.rename
 fs.rename=async(source,destination)=>{if(String(source)===crossPlan[0].source&&String(destination)===crossPlan[0].destination)throw Object.assign(new Error('synthetic different volume'),{code:'EXDEV'});return rename(source,destination)}
 try{const copied=await moveImageItems(db,crossPlan,file=>rename(file,path.join(trash,'cross-original')));assert.equal(copied.moved,1);assert.deepEqual(copied.warnings,[]);assert.equal(await fs.readFile(path.join(copied.paths[0],'附带说明.txt'),'utf8'),'all contents');assert.ok((await readImagePage(db,library.pages(ids[1])[0].id)).data.length)}finally{fs.rename=rename}
 await removeImageFiles(db,ids[0],file=>fs.rename(file,path.join(trash,'removed')))
 assert.equal(library.get(ids[0]),null)
 assert.equal(await fs.readFile(path.join(trash,'removed','附带说明.txt'),'utf8'),'all contents')
 assert.ok(library.get(ids[1]))
 const shared=path.join(library.get(ids[1])!.path,'nested');await fs.mkdir(shared);await fs.writeFile(path.join(shared,'1.png'),pngImage(20,30))
 library.register((await scanImageImport(shared,'comic',false))[0])
 await assert.rejects(imageFileTarget(db,ids[1]),/共享/)
 console.log('PASS collections, ordering, logical ungroup, whole-directory move/delete and reading progress')
}finally{db.close();await fs.rm(root,{recursive:true,force:true})}
