import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {readImageManifest} from '../electron/kinds/image/manifest.ts'
import {scanImageImport} from '../electron/kinds/image/scanner.ts'
import {ImageLibrary} from '../electron/kinds/image/library.ts'
import {auditImage} from '../electron/kinds/image/integrity.ts'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {buildLibraryBackup,previewLibraryBackup,restoreLibraryBackup} from '../electron/services/storage/library-backup.ts'
import {pngImage} from './helpers/test-images.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'

async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-comic-v2-')),folder=path.join(root,'comic'),bytes=pngImage(20,30)
  await fs.mkdir(path.join(folder,'0001 first'),{recursive:true});await fs.writeFile(path.join(folder,'0001 first','00001.png'),bytes)
  const manifest={version:2,source:'jm',sourceId:'123',name:'合成漫画',authors:['作者甲','作者乙'],description:'合成夹具',tags:['示例'],publication:'ongoing',adapterVersion:'jmcomic-2.7.11/baoyi-1',catalogFingerprint:'a'.repeat(64),selectionComplete:true,
    chapters:[{id:'123',directory:'0001 first',title:'第一章',order:1,pageIds:['p1']}],pages:{'123:p1':{file:'0001 first/00001.png',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length}}}
  const write=()=>fs.writeFile(path.join(folder,'.baoyi-image.json'),JSON.stringify(manifest));await write()
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
  t.after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true})})
  return {root,folder,bytes,manifest,write,db,library:new ImageLibrary(db)}
}
test('v2 清单驱动扫描、作者/章节/顺序与只读完整性核验；继续兼容 v1',async t=>{
  const f=await fixture(t),saved=await readImageManifest(f.folder)
  assert.equal(saved?.version,2)
  const [scan]=await scanImageImport(f.folder,'comic',false);assert.equal(scan.source,'jm');assert.deepEqual(scan.authors,['作者甲','作者乙']);assert.equal(scan.chapters[0].key,'123')
  const item=f.library.register(scan);assert.deepEqual(item.authors,scan.authors);assert.equal((await auditImage(f.db,item.id)).ok,1)
  const legacy={...f.manifest,version:1,source:'pica'};await fs.writeFile(path.join(f.folder,'.baoyi-image.json'),JSON.stringify(legacy))
  assert.equal((await readImageManifest(f.folder,'123'))?.version,1);assert.equal((await scanImageImport(f.folder,'comic',false))[0].source,'pica')
})
test('缺页/额外页面/重复顺序/来源不符拒绝入库；摄入暂存不能直接扫描',async t=>{
  const f=await fixture(t)
  f.manifest.chapters[0].pageIds.push('p2');await f.write();await assert.rejects(scanImageImport(f.folder,'comic',false),/清单|页面/)
  f.manifest.chapters[0].pageIds.pop();f.manifest.selectionComplete=false;await f.write();await assert.rejects(scanImageImport(f.folder,'comic',false),/完成/)
  f.manifest.selectionComplete=true;await f.write();await assert.rejects(readImageManifest(f.folder,'999','jm'),/作品|来源/)
  await fs.writeFile(path.join(f.folder,'0001 first','extra.png'),f.bytes);await assert.rejects(scanImageImport(f.folder,'comic',false),/清单/)
  await fs.unlink(path.join(f.folder,'0001 first','extra.png'))
  f.manifest.chapters.push({...f.manifest.chapters[0],id:'124',directory:'0002 second',pageIds:[]});await f.write();await assert.rejects(readImageManifest(f.folder),/章节|顺序/)
  const staging=path.join(f.root,'.baoyi-ingest','job','comic');await fs.mkdir(staging,{recursive:true});await fs.writeFile(path.join(staging,'page.png'),f.bytes)
  await assert.rejects(scanImageImport(staging,'comic',false),/暂存/)
})
test('补章登记保留旧页 ID、进度、封面与人工章名；作者进入备份且旧 JSON 补缺省',async t=>{
  const f=await fixture(t),item=f.library.register((await scanImageImport(f.folder,'comic',false))[0]),page=f.library.pages(item.id)[0]
  f.library.saveProgress(item.id,page.id,.4);f.library.update(item.id,{coverPageId:page.id});f.library.saveChapter(item.id,item.chapters[0].id,'人工章节名',0)
  await fs.mkdir(path.join(f.folder,'0002 second'));await fs.writeFile(path.join(f.folder,'0002 second','00001.png'),f.bytes)
  f.manifest.chapters.push({id:'124',directory:'0002 second',title:'第二章',order:2,pageIds:['p2']})
  ;(f.manifest.pages as any)['124:p2']={...f.manifest.pages['123:p1'],file:'0002 second/00001.png'};await f.write()
  const updated=f.library.register((await scanImageImport(f.folder,'comic',false))[0]);assert.equal(updated.id,item.id);assert.equal(updated.coverPageId,page.id);assert.equal(updated.progress?.pageId,page.id);assert.equal(updated.chapters[0].title,'人工章节名');assert.equal(updated.pageCount,2)
  const backup=buildLibraryBackup(f.db),copy=new DatabaseSync(':memory:');t.after(()=>copy.close());initSchema(copy,KINDS);copy.exec(VIDEO_JOBS_SQL);restoreLibraryBackup(copy,backup)
  assert.deepEqual(new ImageLibrary(copy).get(item.id)?.authors,['作者甲','作者乙'])
  const old=structuredClone(backup);old.schema_version=29;for(const row of old.tables.image_meta)delete (row as any).authors
  restoreLibraryBackup(copy,old);assert.deepEqual(new ImageLibrary(copy).get(item.id)?.authors,[])
  assert.throws(()=>previewLibraryBackup(copy,{...old,schema_version:30}),/missing an expected field/)
})
