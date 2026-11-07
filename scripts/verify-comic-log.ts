import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {ComicLog} from '../electron/kinds/image/comic-log.ts'
import type {ComicIngestJob} from '../src/types/comic-ingest.ts'
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
