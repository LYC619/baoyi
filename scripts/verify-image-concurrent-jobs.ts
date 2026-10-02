import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createImageDownloads } from '../electron/kinds/image/downloads.ts'
import { PicacomicSource } from '../electron/kinds/image/source.ts'
import { pngImage } from './helpers/test-images.ts'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-image-jobs-')),db=new DatabaseSync(':memory:')
initSchema(db,KINDS)
let active=0,peak=0,release!:()=>void
const gate=new Promise<void>(resolve=>{release=resolve}), image=pngImage(14,20)
const source=new PicacomicSource({token:()=>'',fetch:async raw=>{
 const url=new URL(raw)
 if(url.pathname.includes('/order/'))return Response.json({code:200,data:{pages:{pages:1,docs:[{_id:'p',media:{fileServer:'https://images.picacomic.com',path:url.pathname.split('/')[2]}}]}}})
 active++;peak=Math.max(peak,active);await gate;active--;return new Response(new Uint8Array(image))
}})
const queue=createImageDownloads({db,source,changed:()=>{}})
try {
 queue.options({concurrency:1,jobConcurrency:2} as any)
 for(const id of ['one','two','three'])await queue.enqueue({id,title:id,author:'',description:'',tags:[],chapters:1,pages:1,finished:true},[{id:'ch',title:'chapter',order:1}],root,null)
 await new Promise(resolve=>setTimeout(resolve,150))
 assert.equal(peak,2,'two works should download concurrently while the third waits')
 assert.equal(queue.list().filter(job=>job.status==='queued').length,1)
 release();await queue.idle()
 assert.equal(queue.list().filter(job=>job.status==='success').length,3)
 assert.equal(queue.options().jobConcurrency,2)
 console.log('PASS bounded comic work concurrency, queue and settlement')
} finally {release();await queue.idle();db.close();fs.rmSync(root,{recursive:true,force:true})}
