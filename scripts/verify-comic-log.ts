import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {ComicLog,PicaLog} from '../electron/kinds/image/comic-log.ts'
import type {ComicIngestJob} from '../src/types/comic-ingest.ts'
import type {ImageDownloadJob} from '../src/types/image.ts'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {createImageDownloads} from '../electron/kinds/image/downloads.ts'
import {PicacomicSource} from '../electron/kinds/image/source.ts'
import {pngImage} from './helpers/test-images.ts'

test('哔咔日志只记录状态、阶段和重试；与 JM 分开保留且不写入私密错误',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-pica-log-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const log=new PicaLog(root),id=randomUUID(),job={id,status:'queued',processed:0,total:100,completedChapters:0,error:'',progress:{phase:'queued',retryAt:0}} as ImageDownloadJob
 const append=()=>log.append(job,()=>new Set([id]))
 append();job.status='running';job.progress!.phase='receiving';append()
 for(let i=0;i<100;i++){job.processed=i;job.progress!.receivedBytes=i*1024;append()}
 assert.equal((await log.read(id)).length,2)
 job.status='failed';job.error='https://secret?token=hidden';append();job.status='queued';job.error='';append();job.status='running';append();job.status='success';append()
 assert.deepEqual((await log.read(id)).map(e=>e.status),['queued','running','failed','queued','running','success'])
 assert.equal(JSON.stringify(await log.read(id)).includes('hidden'),false)
 const jmFile=randomUUID()+'.jsonl';await fs.writeFile(path.join(root,jmFile),'JM stays')
 const oversized=JSON.stringify({at:0,status:'running',phase:'receiving',processed:0,total:100,completedChapters:0,errorCode:''})+'\n'
 await fs.writeFile(path.join(root,'pica-'+id+'.jsonl'),oversized.repeat(Math.floor(5*1024**2/Buffer.byteLength(oversized))))
 job.progress!.phase='idle';append();await log.flush();assert.ok((await fs.stat(path.join(root,'pica-'+id+'.jsonl'))).size<=5*1024**2)
 for(let i=0;i<22;i++){log.append({...job,id:randomUUID()},()=>new Set([id]));await log.flush()}
 assert.equal((await fs.readdir(root)).filter(f=>f.startsWith('pica-')).length,21)
 assert.equal(await fs.readFile(path.join(root,jmFile),'utf8'),'JM stays')
})

test('真实哔咔队列失败后重试入库，日志经过 queued/running/failed/queued/running/success',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-pica-transitions-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const db=new DatabaseSync(':memory:');initSchema(db,KINDS);t.after(()=>db.close())
 let fail=true
 const source=new PicacomicSource({token:()=>'',fetch:async raw=>{
   if(new URL(raw).pathname.includes('/order/'))return Response.json({code:200,data:{pages:{pages:1,docs:[{_id:'p1',media:{fileServer:'https://images.picacomic.com',path:'fixture/1'}}]}}})
   if(fail)return new Response('',{status:404})
   return new Response(new Uint8Array(pngImage(20,30)))
 }})
 const queue=createImageDownloads({db,source,changed:()=>{},logDirectory:path.join(root,'logs')})
 const job=await queue.enqueue({id:'fixture',title:'合成任务',author:'',description:'',tags:[],chapters:1,pages:1,finished:true},[{id:'c1',title:'第一章',order:1}],root,null)
 await queue.idle();assert.equal(queue.list()[0].status,'failed')
 fail=false;await queue.retry(job.id);await queue.idle();assert.equal(queue.list()[0].status,'success',queue.list()[0].error)
 const entries=await queue.logs(job.id),statuses=entries.map(e=>e.status).filter((s,i,a)=>i===0||s!==a[i-1])
 assert.deepEqual(statuses,['queued','running','failed','queued','running','success'])
 assert.ok(entries.some(e=>e.phase==='catalog'));assert.ok(entries.some(e=>e.phase==='importing'))
})
test('过程记录只留安全字段，单项5MiB和最近20项结束日志有界',async t=>{
 const root=await fs.mkdtemp(path.resolve('output/p1-p2-comic-2026-11-06/log-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const log=new ComicLog(root),id=randomUUID(),entry={at:1,status:'running',phase:'downloading',processed:1,total:2,completedChapters:0,errorCode:''},line=JSON.stringify(entry)+'\n'
 await fs.writeFile(path.join(root,id+'.jsonl'),line.repeat(Math.floor(5*1024**2/Buffer.byteLength(line))))
 const job={id,status:'success',phase:'done',processed:2,total:2,completedChapters:1,errorCode:'',error:'https://secret?token=hidden'} as ComicIngestJob
 log.append(job,()=>new Set());await log.flush();assert.ok((await fs.stat(path.join(root,id+'.jsonl'))).size<=5*1024**2)
 const read=await log.read(id);assert.equal(read.at(-1)?.status,'success');assert.equal(JSON.stringify(read).includes('hidden'),false)
 for(let i=0;i<21;i++){log.append({...job,id:randomUUID()},()=>new Set());await log.flush()}
 assert.equal((await fs.readdir(root)).length,20)
})

test('log write failures reach flush and read callers',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-comic-log-failure-'))
 t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const blocked=path.join(root,'blocked');await fs.writeFile(blocked,'fixture')
 const log=new ComicLog(blocked),id=randomUUID()
 log.append({id,status:'running',phase:'downloading',processed:0,total:1,completedChapters:0,errorCode:''} as ComicIngestJob,()=>new Set([id]))
 await assert.rejects(log.flush(),{code:'EEXIST'})
 await assert.rejects(log.read(id),{code:'EEXIST'})
})
