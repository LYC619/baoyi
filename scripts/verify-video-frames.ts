import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {VideoFrameCache} from '../electron/kinds/video/frame-cache.ts'
import {frameFingerprint,frameSampleTimes,generateFrames} from '../electron/kinds/video/frame-generator.ts'
import {videoFrameHover} from '../src/utils/video-frame-hover.ts'
import {openFrameIndex} from '../electron/kinds/video/frame-index.ts'
import type {VideoFrameState} from '../src/types/video-preview.ts'
async function until(check:()=>boolean){const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10))}throw new Error('等待帧缓存状态超时')}
async function fixture(t:test.TestContext,generate:typeof generateFrames,limit=1024**3){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-frames-')),cacheRoot=path.join(root,'cache'),db=new DatabaseSync(':memory:'),states=new Map<string,VideoFrameState>()
  const files:Record<string,string>={}
  for(const name of ['a','b','c']){files[name]=path.join(root,name+'.mp4');await fs.writeFile(files[name],'synthetic-video-'+name)}
  const cache=new VideoFrameCache({db,root:cacheRoot,file:async token=>{if(!files[token])throw new Error('token已失效');return files[token]},ffmpeg:()=>({file:'synthetic',roots:[]}),locate:async()=>'synthetic',generate,limit,changed:state=>states.set(state.id,state)})
  t.after(async()=>{await cache.close();db.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'baoyi-frames-')));await fs.rm(root,{recursive:true,force:true})})
  return {cache,root,cacheRoot,db,states,files}
}
const fake:typeof generateFrames=async input=>{await fs.mkdir(input.directory,{recursive:true});await fs.writeFile(path.join(input.directory,'sprite.jpg'),Buffer.alloc(200));return {times:[1,2,3],duration:4,bytes:200,partial:false,audioTracks:0,videoCodec:'fixture',message:''}}
test('250ms之前不发起后台操作，离开和重新进入重新计时',()=>{
  let time=0,id=0,calls=0;const pending=new Map<number,{at:number;action:()=>void}>()
  const timer=videoFrameHover(()=>calls++,{set:(action,ms)=>{pending.set(++id,{at:time+ms,action});return id},clear:id=>{pending.delete(id)}})
  const tick=(ms:number)=>{time+=ms;for(const [id,task]of [...pending])if(task.at<=time){pending.delete(id);task.action()}}
  timer.enter();tick(249);assert.equal(calls,0);timer.leave();tick(10);assert.equal(calls,0)
  timer.enter();tick(150);timer.enter();tick(249);assert.equal(calls,0);tick(1);assert.equal(calls,1)
})
test('代表帧数量限额、时间递增和源文件指纹变化',async t=>{
  for(const duration of [.001,4,300,7200]){const times=frameSampleTimes(duration);assert.ok(times.length<=24);assert.ok(times.every((value,index)=>value>=0&&value<=duration&&(!index||value>times[index-1])))}
  const f=await fixture(t,fake),before=await frameFingerprint(f.files.a);await fs.appendFile(f.files.a,'changed');assert.notEqual((await frameFingerprint(f.files.a)).hash,before.hash)
})
test('同源共享单任务，去掉最后订阅才停止；关闭时清除运行记录',async t=>{
  let calls=0,finish!:()=>void,aborted=false
  const f=await fixture(t,async input=>{calls++;await new Promise<void>(resolve=>{finish=resolve;input.signal.addEventListener('abort',()=>{aborted=true;resolve()},{once:true})});input.signal.throwIfAborted();return fake(input)})
  const a=await f.cache.subscribe('a'),b=await f.cache.subscribe('a');await until(()=>calls===1)
  f.cache.unsubscribe(a.id);assert.equal(aborted,false);finish();await until(()=>f.states.get(b.id)?.status==='ready')
  assert.ok(await f.cache.image(b.id));f.cache.unsubscribe(b.id);const c=await f.cache.subscribe('a');assert.equal(c.status,'ready');assert.equal(calls,1)
  await f.cache.subscribe('b');await until(()=>calls===2);await f.cache.close();assert.equal(aborted,true)
  assert.equal((f.db.prepare("SELECT count(*) n FROM video_frame_cache WHERE state IN ('running','queued')").get() as any).n,0)
})
test('LRU仅淘汰未使用项，实际字节限额；错误退避和手动重试',async t=>{
  let calls=0,fail=false;const f=await fixture(t,async input=>{calls++;if(fail)throw new Error('合成失败');return fake(input)},400)
  const a=await f.cache.subscribe('a');await until(()=>f.states.get(a.id)?.status==='ready');f.cache.unsubscribe(a.id)
  const b=await f.cache.subscribe('b');await until(()=>f.states.get(b.id)?.status==='ready');f.cache.unsubscribe(b.id)
  const c=await f.cache.subscribe('c');await until(()=>f.states.get(c.id)?.status==='ready');assert.equal(f.cache.stats().bytes,400);assert.equal(f.cache.stats().items,2)
  f.cache.unsubscribe(c.id);fail=true;const failed=await f.cache.subscribe('a');await until(()=>f.states.get(failed.id)?.status==='failed');const before=calls
  f.cache.unsubscribe(failed.id);assert.equal((await f.cache.subscribe('a')).status,'failed');assert.equal(calls,before)
  fail=false;const retry=await f.cache.subscribe('a',true);await until(()=>f.states.get(retry.id)?.status==='ready');assert.equal(calls,before+1)
})
test('生成中源文件变化不发布；失效token不可读取缓存；清理不动媒体',async t=>{
  const f=await fixture(t,async input=>{const result=await fake(input);await fs.appendFile(input.file,'changed');return result})
  const state=await f.cache.subscribe('a');await until(()=>f.states.get(state.id)?.status==='failed');assert.match(f.states.get(state.id)!.message,/变化/)
  await assert.rejects(f.cache.image(state.id),/尚未完成/);f.cache.unsubscribe(state.id);await f.cache.clear();assert.equal(f.cache.stats().items,0);assert.match(await fs.readFile(f.files.a,'utf8'),/changed$/)
})

test('读取图片期间关闭或失去来源授权时不返回迟到字节；清理使现有订阅失效',async t=>{
  const f=await fixture(t,fake),state=await f.cache.subscribe('a');await until(()=>f.states.get(state.id)?.status==='ready')
  let release!:()=>void,started!:()=>void
  const reading=new Promise<void>(resolve=>{started=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  const result=f.cache.readImage(state.id,async file=>{started();await gate;return fs.readFile(file)})
  await reading;f.cache.unsubscribe(state.id);release();await assert.rejects(result,/关闭/)
  const lost=await f.cache.subscribe('a');await assert.rejects(f.cache.readImage(lost.id,async file=>{delete f.files.a;return fs.readFile(file)}),/失效/)
  f.files.a=path.join(f.root,'a.mp4')
  const next=await f.cache.subscribe('a');await f.cache.clear();assert.equal(f.states.get(next.id)?.status,'failed');assert.match(f.states.get(next.id)!.message,/清理/)
})

test('损坏的独立索引可重建；正常索引保留，访问错误不当作损坏删除',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-frame-index-')),file=path.join(root,'index.sqlite')
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  await fs.writeFile(file,'broken sqlite header')
  let db=openFrameIndex(root,file=>new DatabaseSync(file));db.exec('CREATE TABLE retained(value TEXT)');db.close()
  db=openFrameIndex(root,file=>new DatabaseSync(file));assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='retained'").get());db.close()
  const before=await fs.readFile(file)
  assert.throws(()=>openFrameIndex(root,()=>{throw Object.assign(new Error('denied'),{code:'EACCES'})}),/denied/)
  assert.deepEqual(await fs.readFile(file),before)
})

test('首批代表帧在补齐前可读，最终替换预览地址；关闭立即撤销临时帧',async t=>{
  let finish!:()=>void
  const f=await fixture(t,async input=>{
    await fs.mkdir(input.directory,{recursive:true});await fs.writeFile(path.join(input.directory,'preview.jpg'),Buffer.alloc(100,7))
    await input.preview?.({times:[1,4],duration:8,bytes:100,partial:true,audioTracks:0,videoCodec:'fixture',message:'正在补齐代表帧'})
    await new Promise<void>(resolve=>{finish=resolve;input.signal.addEventListener('abort',()=>resolve(),{once:true})})
    input.signal.throwIfAborted();return fake(input)
  })
  const first=await f.cache.subscribe('a');await until(()=>!!finish)
  const partial=f.states.get(first.id)!;assert.equal(partial.status,'running');assert.equal(partial.partial,true);assert.ok(partial.url)
  assert.deepEqual([...await f.cache.readImage(first.id)],Array(100).fill(7))
  finish();await until(()=>f.states.get(first.id)?.status==='ready');assert.notEqual(f.states.get(first.id)!.url,partial.url)
  assert.equal((await f.cache.readImage(first.id)).length,200)
  finish=undefined!;const cancelled=await f.cache.subscribe('b');await until(()=>!!finish);f.cache.unsubscribe(cancelled.id)
  await assert.rejects(f.cache.readImage(cancelled.id),/关闭/)
})
