import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {comicRoot,ComicStage,writeComicJson,emptyComicManifest,comicDigest} from '../electron/kinds/image/comic-files.ts'
import {comicCatalog,JM_ADAPTER_VERSION} from '../electron/kinds/image/comic-source-rules.ts'
import {pngImage} from './helpers/test-images.ts'
import {scanImageImport} from '../electron/kinds/image/scanner.ts'
const base=path.resolve('output/p1-p2-comic-2026-11-06/commit');await fs.mkdir(base,{recursive:true})
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(base,'run-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const authority=await comicRoot(root),jobId=randomUUID(),operationId=randomUUID(),stage=await ComicStage.create(authority,jobId,operationId,'123','[作者] 作品')
  const catalog=comicCatalog({provider:'jm',workId:'123',name:'作品',authors:['作者'],description:'',tags:[],publication:'ongoing',adapterVersion:JM_ADAPTER_VERSION,catalogFingerprint:'',chapters:[{id:'123',title:'第一章',order:1,pageIds:['p1']}]})
  const manifest=emptyComicManifest(catalog,['123']),chapter=manifest.chapters[0],image=pngImage(20,30),relative=chapter.directory+'/00001.png'
  await fs.mkdir(path.join(stage.payload,chapter.directory));await fs.writeFile(path.join(stage.payload,relative),image)
  manifest.pages['123:p1']={file:relative,sha256:createHash('sha256').update(image).digest('hex'),size:image.length};manifest.selectionComplete=true
  await writeComicJson(path.join(stage.payload,'.baoyi-image.json'),manifest)
  return {root,authority,jobId,operationId,stage,manifest,image,relative}
}
test('新漫画完整校验后同卷放置，成品扫描可用，重复恢复不重复下载',async t=>{
  const f=await fixture(t),manifest=await f.stage.place();assert.equal(manifest.sourceId,'123');assert.equal(f.stage.intent.phase,'placed')
  const [scan]=await scanImageImport(f.stage.destination,'comic',false);assert.equal(scan.chapters[0].pages.length,1)
  const recovered=await ComicStage.recover(f.authority,f.jobId,f.operationId,'123');await recovered.place();await recovered.finish();assert.equal(recovered.intent.phase,'done')
  assert.deepEqual(await fs.readFile(path.join(recovered.destination,f.relative)),f.image)
})
test('rename 后 journal 未更新时只核对成品；篡改、碰撞与伪造授权拒绝',async t=>{
  const f=await fixture(t);f.stage.intent.phase='prepared';f.stage.intent.manifestDigest=comicDigest(f.manifest);await f.stage.checkpoint();await fs.rename(f.stage.payload,f.stage.destination)
  const recovered=await ComicStage.recover(f.authority,f.jobId,f.operationId,'123');await recovered.place();assert.equal(recovered.intent.phase,'placed')
  await assert.rejects(ComicStage.recover(f.authority,f.jobId,randomUUID(),'123'),/授权/)
  await fs.writeFile(path.join(recovered.destination,f.relative),pngImage(20,30,[1,2,3]));await assert.rejects(recovered.place(),/校验/)
  const other=await fixture(t);await fs.mkdir(other.stage.destination);await fs.writeFile(path.join(other.stage.destination,'keep.txt'),'用户文件');await assert.rejects(other.stage.place(),/已存在/);assert.equal(await fs.readFile(path.join(other.stage.destination,'keep.txt'),'utf8'),'用户文件')
})

test('磁盘不足与链接根目录拒绝，保留原文件',async t=>{
  const f=await fixture(t),mock=t.mock.method(fs,'statfs',async()=>({bavail:1,bsize:4096}) as any)
  await assert.rejects(ComicStage.create(f.authority,randomUUID(),randomUUID(),'456','其他作品'),/空间不足/);mock.mock.restore()
  const link=path.join(f.root,'link');await fs.symlink(f.stage.payload,link,'junction')
  await assert.rejects(comicRoot(link),/链接/);assert.deepEqual(await fs.readFile(path.join(f.stage.payload,f.relative)),f.image)
})
