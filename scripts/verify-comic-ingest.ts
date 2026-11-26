import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {ComicIngestService} from '../electron/kinds/image/comic-ingest.ts'
import {comicCatalog,JM_ADAPTER_VERSION} from '../electron/kinds/image/comic-source-rules.ts'
import {createComicVerifier} from '../electron/kinds/image/comic-verifier.ts'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {ImageLibrary} from '../electron/kinds/image/library.ts'
import {buildLibraryBackup,restoreLibraryBackup} from '../electron/services/storage/library-backup.ts'
import {pngImage} from './helpers/test-images.ts'
const base=path.resolve('output/p1-p2-comic-2026-11-06/service');await fs.mkdir(base,{recursive:true})
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(base,'run-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
  const catalog=comicCatalog({provider:'jm',workId:'123',name:'合成作品',authors:['合成作者'],description:'',tags:[],publication:'ongoing',adapterVersion:JM_ADAPTER_VERSION,catalogFingerprint:'',chapters:[{id:'123',title:'首章',order:1,pageIds:['p1','p2']},{id:'124',title:'第二章',order:2,pageIds:['p3']}]})
  let fail=false,downloads=0,seenSkips:string[]=[],allowed=true,failAfter=0,delay=0,notices=0
  const createQueue=()=>new ComicIngestService({db,authorizationDirectory:path.join(root,'grants'),allowed:()=>allowed,assertIdle:()=>{},changed:()=>{},jobsChanged:()=>{notices++},verifier:()=>createComicVerifier(pathToFileURL(path.resolve('electron/kinds/image/comic-verify-worker.ts'))),runtime:()=>({resolve:async()=>catalog,download:async(_job,_work,directory,chapters,signal,onPage)=>{
    downloads++
    for(const chapter of chapters){seenSkips.push(...chapter.skip);await fs.mkdir(path.join(directory,chapter.directory),{recursive:true})
      for(const [i,id] of chapter.pageIds.entries()){
        if(chapter.skip.includes(id))continue;signal.throwIfAborted()
        const bytes=pngImage(20,30),file=chapter.directory+'/'+String(i+1).padStart(5,'0')+'.png'
        await fs.writeFile(path.join(directory,file),bytes);onPage({chapterId:chapter.id,pageId:id,file,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),width:20,height:30})
        if(delay)await new Promise(r=>setTimeout(r,delay))
        if(fail||failAfter>0&&--failAfter===0)throw new Error('合成网络中断')
      }
    }
  }})})
  let queue=createQueue()
  t.after(async()=>{await queue.stopAll();db.close();await fs.rm(root,{recursive:true,force:true})})
  async function start(chapters:string[]){const preview=await queue.preview('JM123',{mode:'system'});return queue.enqueue(preview.token,chapters,root,preview.directory,null)}
  async function settled(id:string){for(let i=0;i<300;i++){const job=queue.list().find(j=>j.id===id);if(job&&!['running','queued'].includes(job.status))return job;await new Promise(r=>setTimeout(r,20))}throw new Error('任务未结束')}
  return {root,db,get queue(){return queue},restart:async()=>{await queue.stopAll();queue=createQueue()},start,settled,catalog,library:new ImageLibrary(db),setFail:(value:boolean)=>fail=value,setFailAfter:(n:number)=>failAfter=n,setDelay:(n:number)=>delay=n,downloads:()=>downloads,skips:()=>seenSkips,notices:()=>notices,hide:()=>{allowed=false}}
}

test('连续页面批量保存进度，避免每页全量落盘与任务刷新，最终页完整入库',async t=>{
  const f=await fixture(t);f.catalog.chapters[0].pageIds=Array.from({length:40},(_,i)=>'p'+(i+1));f.catalog.catalogFingerprint='';Object.assign(f.catalog,comicCatalog(f.catalog))
  const rename=fs.rename.bind(fs);let manifestWrites=0
  t.mock.method(fs,'rename',async(source:any,target:any)=>{if(path.basename(String(target))==='.baoyi-image.json')manifestWrites++;return rename(source,target)})
  const job=await f.settled(await f.start(['123']));assert.equal(job.status,'success',job.error);assert.equal(f.library.get(job.resourceId)!.pageCount,40)
  assert.ok(f.notices()<24,`40 页产生 ${f.notices()} 次任务通知`)
  assert.ok(manifestWrites<24,`40 页写入 ${manifestWrites} 次完整清单`)
})

test('旧任务补齐稳定创建时间，重试和重新打开不会改变任务排序依据',async t=>{
  const f=await fixture(t);f.setFail(true);const id=await f.start(['123']);await f.settled(id)
  const before=f.queue.list().find(job=>job.id===id)!;assert.ok(before.createdAt&&before.createdAt<=before.updatedAt)
  await f.queue.retry(id);await f.settled(id);await f.restart();assert.equal(f.queue.list().find(job=>job.id===id)!.createdAt,before.createdAt)
  const row=f.db.prepare('SELECT payload FROM image_download_jobs WHERE id=?').get(id) as {payload:string};const legacy=JSON.parse(row.payload);delete legacy.createdAt;legacy.updatedAt=123456
  f.db.prepare('UPDATE image_download_jobs SET payload=? WHERE id=?').run(JSON.stringify(legacy),id);await f.restart()
  assert.equal(f.queue.list().find(job=>job.id===id)!.createdAt,123456)
  await f.queue.retry(id);await f.settled(id);assert.equal(f.queue.list().find(job=>job.id===id)!.createdAt,123456)
})

test('不足五页也按定时器保存，暂停落盘后重试不重下已有页',async t=>{
  const f=await fixture(t);f.setDelay(1800)
  const id=await f.start(['123'])
  const manifest=path.join(f.root,'.baoyi-ingest',id,'payload','.baoyi-image.json')
  let checkpoint=false
  for(let i=0;i<100;i++){
    const value=await fs.readFile(manifest,'utf8').then(JSON.parse).catch(()=>null)
    if(value?.pages['123:p1']){checkpoint=true;break}
    await new Promise(resolve=>setTimeout(resolve,25))
  }
  assert.ok(checkpoint,'首张图片应在下一页到达前保存');await f.queue.stop(id)
  f.setDelay(0);await f.queue.retry(id);assert.equal((await f.settled(id)).status,'success');assert.ok(f.skips().includes('p1'))
})
test('完整所选集入库，补章保留原页、阅读记录和人工标题',async t=>{
  const f=await fixture(t),id=await f.start(['123']),job=await f.settled(id);assert.equal(job.status,'success',job.error)
  for(let i=0;i<50;i++){if(!await fs.stat(path.join(f.root,'.baoyi-ingest',id)).catch(()=>null))break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(await fs.stat(path.join(f.root,'.baoyi-ingest',id)).catch(()=>null),null)
  const item=f.library.get(job.resourceId)!,page=f.library.pages(item.id)[0];f.library.saveProgress(item.id,page.id,.5);f.library.saveChapter(item.id,item.chapters[0].id,'人工章名',0);f.library.update(item.id,{coverPageId:page.id})
  const second=await f.settled(await f.start(['124']));assert.equal(second.status,'success',second.error)
  const updated=f.library.get(item.id)!;assert.equal(updated.pageCount,3);assert.equal(updated.progress?.pageId,page.id);assert.equal(updated.coverPageId,page.id);assert.equal(updated.chapters[0].title,'人工章名');assert.equal(f.library.list().length,1)
  const logs=await f.queue.logs(id);assert.equal(logs.at(-1)?.status,'success');assert.ok(logs.some(entry=>entry.phase==='indexing'));assert.ok(logs.every(entry=>!JSON.stringify(entry).includes('http')))
})
test('网络中断不登记半本，重试复用已核验页；备份不授予本机运行权限',async t=>{
  const f=await fixture(t);f.setFail(true);const id=await f.start(['123']),first=await f.settled(id);assert.equal(first.status,'failed');assert.equal(f.library.list().length,0)
  const exported=buildLibraryBackup(f.db),saved=JSON.parse(String(exported.tables.image_download_jobs[0].payload));assert.equal(saved.operationId,'');assert.equal(saved.requiresRevalidation,true)
  f.setFail(false);await f.queue.retry(id);const result=await f.settled(id);assert.equal(result.status,'success',result.error);assert.deepEqual(f.skips(),['p1']);assert.equal(f.downloads(),2)
  restoreLibraryBackup(f.db,exported);const restored=JSON.parse(String((f.db.prepare('SELECT payload FROM image_download_jobs').get() as any).payload));assert.equal(restored.requiresRevalidation,true);assert.equal(restored.operationId,'')
})
test('已落盘但登记失败重试只登记；隐私关闭不返回任务标题',async t=>{
  const f=await fixture(t);f.db.exec("CREATE TRIGGER fail_comic BEFORE INSERT ON resource BEGIN SELECT RAISE(ABORT,'fixture DB busy'); END")
  const id=await f.start(['123']),first=await f.settled(id);assert.equal(first.status,'failed');assert.equal(f.downloads(),1)
  f.db.exec('DROP TRIGGER fail_comic');await f.queue.retry(id);const second=await f.settled(id);assert.equal(second.status,'success',second.error);assert.equal(f.downloads(),1)
  f.hide();assert.equal(f.queue.list().length,0)
})
test('补章按完整章节提交，后章断网仍能读已完成章；继续下载不改旧页',async t=>{
  const f=await fixture(t);const initial=await f.settled(await f.start(['124']));assert.equal(initial.status,'success',initial.error)
  // Add a later chapter to the source before the next preview.
  f.catalog.chapters.push({id:'125',title:'第三章',order:3,pageIds:['p4','p5']});f.catalog.catalogFingerprint=''
  Object.assign(f.catalog,comicCatalog(f.catalog));f.setFailAfter(3)
  const id=await f.start(['123','125']),failed=await f.settled(id);assert.equal(failed.status,'failed')
  assert.equal(f.library.get(initial.resourceId)!.pageCount,3,'原章及完整首章已入库，第三章半页不入库')
  await f.queue.retry(id);const done=await f.settled(id);assert.equal(done.status,'success',done.error);assert.equal(f.library.get(initial.resourceId)!.pageCount,5)
})
test('暂停等待当前页保存后返回，继续复用；改动暂存页不会静默覆盖',async t=>{
  const f=await fixture(t);f.setDelay(150);const id=await f.start(['123']);await new Promise(r=>setTimeout(r,80));await f.queue.stop(id)
  assert.equal(f.queue.list()[0].status,'paused');assert.equal(f.library.list().length,0)
  const row=JSON.parse(String((f.db.prepare('SELECT payload FROM image_download_jobs WHERE id=?').get(id) as any).payload))
  const manifestFile=path.join(f.root,'.baoyi-ingest',id,'payload','.baoyi-image.json'),manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'))
  const page=Object.values(manifest.pages)[0] as {file:string}|undefined
  assert.ok(page,'暂停后保存当前完整页')
  await fs.writeFile(path.join(path.dirname(manifestFile),page.file),pngImage(20,30,[50,30,10]))
  await f.queue.retry(id);const failed=await f.settled(id);assert.equal(failed.status,'failed');assert.match(failed.error,/校验/);assert.equal(f.downloads(),1)
  assert.ok(row.operationId)
})

test('恢复任务不自动联网，重新选择原根目录并核验来源后复用已保存页面',async t=>{
  const f=await fixture(t);f.setFail(true);const id=await f.start(['123']);await f.settled(id)
  const exported=buildLibraryBackup(f.db);await f.queue.stopAll();restoreLibraryBackup(f.db,exported);await f.restart()
  assert.equal(f.downloads(),1);await assert.rejects(f.queue.retry(id),/重新/)
  const preview=await f.queue.preview('123',{mode:'custom',url:'127.0.0.1:7890'})
  f.setFail(false);await f.queue.revalidate(id,preview.token,f.root)
  const done=await f.settled(id);assert.equal(done.status,'success',done.error);assert.deepEqual(f.skips(),['p1']);assert.equal(f.library.list().length,1)
})

test('重新核验拒绝错根目录、变化的来源页和已被改动的暂存图片',async t=>{
  const f=await fixture(t);f.setFail(true);const id=await f.start(['123']);await f.settled(id)
  const exported=buildLibraryBackup(f.db);await f.queue.stopAll();restoreLibraryBackup(f.db,exported);await f.restart()
  const preview=await f.queue.preview('123',{mode:'system'})
  await assert.rejects(f.queue.revalidate(id,preview.token,path.join(f.root,'grants')),/原根目录/)
  const manifestPath=path.join(f.root,'.baoyi-ingest',id,'payload','.baoyi-image.json'),manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'))
  await fs.writeFile(path.join(path.dirname(manifestPath),manifest.pages['123:p1'].file),pngImage(20,30,[1,3,5]))
  await assert.rejects(f.queue.revalidate(id,preview.token,f.root),/校验/)
  assert.equal(f.queue.list()[0].requiresRevalidation,true);assert.equal(f.downloads(),1)
  f.catalog.chapters[0].pageIds=['changed'];f.catalog.catalogFingerprint='';Object.assign(f.catalog,comicCatalog(f.catalog))
  const changed=await f.queue.preview('123',{mode:'system'});await assert.rejects(f.queue.revalidate(id,changed.token,f.root),/来源章节已变化/)
})

test('清理仅删除核验过的暂存，保留用户文件与已入库章节；恢复任务没有清理授权',async t=>{
  const f=await fixture(t);const initial=await f.settled(await f.start(['124']));assert.equal(initial.status,'success')
  f.setFail(true);const id=await f.start(['123']);await f.settled(id)
  const stage=path.join(f.root,'.baoyi-ingest',id),unknown=path.join(stage,'用户记录.txt');await fs.writeFile(unknown,'保留')
  await assert.rejects(f.queue.clean(id),/未知文件/);assert.equal(await fs.readFile(unknown,'utf8'),'保留')
  await fs.unlink(unknown);await f.queue.clean(id);assert.equal(await fs.stat(stage).catch(()=>null),null)
  assert.equal(f.library.get(initial.resourceId)!.pageCount,1);assert.equal(f.queue.list().find(j=>j.id===id),undefined)
  const restored=buildLibraryBackup(f.db);await f.queue.stopAll();restoreLibraryBackup(f.db,restored);await f.restart()
  await assert.rejects(f.queue.clean(initial.id),/重新|已完成/)
})

for(const boundary of ['chapter-rename','manifest-rename'] as const)test('补章在 '+boundary+' 后中断，重启保留旧进度并恢复提交',async t=>{
  const f=await fixture(t),initial=await f.settled(await f.start(['124']));assert.equal(initial.status,'success')
  const resource=f.library.get(initial.resourceId)!,page=f.library.pages(resource.id)[0];f.library.saveProgress(resource.id,page.id,.5)
  const rename=fs.rename.bind(fs);let injected=false
  const mock=t.mock.method(fs,'rename',async(source:any,target:any)=>{
    await rename(source,target)
    const relative=path.relative(resource.path,String(target))
    if(!injected&&!relative.startsWith('..')&&(boundary==='chapter-rename'?relative==='0001 首章':relative==='.baoyi-image.json')){injected=true;throw new Error('synthetic crash after '+boundary)}
  })
  const id=await f.start(['123']),failed=await f.settled(id);assert.equal(injected,true);assert.equal(failed.status,'failed');mock.mock.restore()
  const downloaded=f.downloads();await f.restart();assert.equal(f.downloads(),downloaded)
  await f.queue.retry(id);const done=await f.settled(id);assert.equal(done.status,'success',done.error)
  assert.equal(f.downloads(),downloaded,'完整章已经落盘，恢复不重新下载');assert.equal(f.library.get(resource.id)!.pageCount,3);assert.equal(f.library.get(resource.id)!.progress?.pageId,page.id)
})

test('同一预览并发提交只创建一项任务；根目录离线后保留暂存待重试',async t=>{
  const f=await fixture(t);f.setFail(true);const preview=await f.queue.preview('123',{mode:'system'})
  const results=await Promise.allSettled([f.queue.enqueue(preview.token,['123'],f.root,preview.directory,null),f.queue.enqueue(preview.token,['123'],f.root,preview.directory,null)])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  const id=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;await f.settled(id)
  const original=fs.lstat.bind(fs),mock=t.mock.method(fs,'lstat',async(file:any,...args:any[])=>{if(path.resolve(String(file))===f.root)throw Object.assign(new Error('synthetic offline'),{code:'ENOENT'});return original(file,...args as [])})
  await assert.rejects(f.queue.retry(id),/offline/);mock.mock.restore()
  assert.ok(await fs.stat(path.join(f.root,'.baoyi-ingest',id,'payload')));assert.equal(f.downloads(),1)
})
