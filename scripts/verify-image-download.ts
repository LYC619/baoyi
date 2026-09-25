import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { pngImage } from './helpers/test-images.ts'

assert.ok(fs.existsSync(new URL('../electron/kinds/image/source.ts',import.meta.url)), '必须提供哔咔来源适配器')
const { PicacomicSource }=await import('../electron/kinds/image/source.ts')
const { createImageDownloads }=await import('../electron/kinds/image/downloads.ts')
let calls=0, failPage=true, rateLimit=true
const work={_id:'work1',title:'合成漫画',author:'测试',description:'离线验证',tags:['测试'],epsCount:1,pagesCount:2,finished:true,allowDownload:true}
const request=async(url:string,init?:RequestInit)=>{
  if(url.includes('/static/')){calls++;if(url.endsWith('/2')&&failPage)throw new Error('synthetic interruption');return new Response(new Uint8Array(pngImage(12,18)),{headers:{'content-type':'image/png'}})}
  assert.ok((init?.headers as Record<string,string>).signature)
  if(url.endsWith('auth/sign-in'))return Response.json({code:200,data:{token:'test-token'}})
  if(url.includes('advanced-search')){if(rateLimit){rateLimit=false;return new Response('',{status:429,headers:{'retry-after':'0'}})}return Response.json({code:200,data:{comics:{docs:[work],pages:1}}})}
  if(url.endsWith('/eps?page=1'))return Response.json({code:200,data:{eps:{docs:[{_id:'chapter1',title:'第1话',order:1}],pages:1}}})
  if(url.includes('/order/1/pages'))return Response.json({code:200,data:{pages:{docs:[1,2].map(n=>({_id:`page${n}`,media:{fileServer:'https://images.picacomic.com',path:`test/${n}`}})),pages:1}}})
  return Response.json({code:200,data:{comic:work}})
}
const source=new PicacomicSource({fetch:request,token:()=> 'test-token',wait:async()=>{}})
assert.equal(await source.login('test@example.test','synthetic'),'test-token')
assert.equal((await source.search('test',1)).items.length,1)
const detail=await source.detail('work1')
assert.equal(detail.chapters.length,1)
const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-image-download-'))
const db=new DatabaseSync(path.join(root,'fixture.db'));db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
let queue=createImageDownloads({db,source,changed:()=>{}})
const job=await queue.enqueue(detail.work,detail.chapters,root,null)
await queue.idle()
assert.equal(queue.list()[0].status,'failed')
assert.equal(queue.list()[0].processed,1)
const firstCalls=calls
failPage=false
await queue.retry(job.id);await queue.idle()
assert.equal(queue.list()[0].status,'success')
assert.equal(calls-firstCalls,1,'重试只下载缺失的第二页')
assert.equal((db.prepare("SELECT COUNT(*) n FROM resource WHERE kind='image'").get() as {n:number}).n,1)
await queue.enqueue(detail.work,detail.chapters,root,null);await queue.idle()
assert.equal((db.prepare('SELECT COUNT(*) n FROM image_pages WHERE missing=0').get() as {n:number}).n,2)
assert.equal(calls-firstCalls,1,'重复下载不覆盖已有页')
db.prepare("UPDATE image_download_jobs SET status='running'").run()
queue=createImageDownloads({db,source,changed:()=>{}})
assert.ok(queue.list().every(j=>j.status==='interrupted'))
const expired=new PicacomicSource({fetch:async()=>new Response('private body',{status:401}),token:()=> 'private-token'})
await assert.rejects(expired.search('test',1),/登录/)
db.close()
console.log('PASS 哔咔签名请求、分页、429、认证过期、断点补页、原子入库、重复下载、重启中断')
