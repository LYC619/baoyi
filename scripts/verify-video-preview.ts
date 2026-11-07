import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
import {byteRange,VideoPreviewService} from '../electron/kinds/video/preview.ts'
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-video-preview-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const file=path.join(root,'video.mp4'),alternate=path.join(root,'other.webm');await fs.writeFile(file,Buffer.from('0123456789'));await fs.writeFile(alternate,'abcdefghij')
  const registration=registerVideoContent(db,{title:'合成视频',category:'其他',videoType:'movie',items:[{title:'内容一',order:1,files:[{path:file},{path:alternate}]}]})
  let hidden=false,blocked=false,now=Date.now()
  const service=new VideoPreviewService({db:()=>db,hidden:()=>hidden,blocked:()=>blocked,now:()=>now})
  t.after(async()=>{service.close();db.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'baoyi-video-preview-')));await fs.rm(root,{recursive:true,force:true})})
  return {root,file,alternate,db,service,id:registration.resourceId,hide:()=>hidden=true,block:()=>blocked=true,expire:()=>now+=16*60000}
}
test('Range整数、后缀、开放区间、空文件及非法范围',()=>{
  assert.deepEqual(byteRange('bytes=2-5',10),{start:2,end:5});assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9});assert.deepEqual(byteRange('bytes=5-',10),{start:5,end:9})
  for(const range of ['bytes=10-','bytes=7-4','bytes=0-1,3-4','bytes=-0','bytes=9007199254740992-','bytes=-','items=0-5'])assert.equal(byteRange(range,10),false,range)
  assert.equal(byteRange('bytes=0-',0),false);assert.equal(byteRange(null,0),null)
})
test('精确副本签发与真实文件Range/HEAD，不接受其他文件或任意路径',async t=>{
  const {service,id}=await fixture(t),choices=await service.choices(id)
  assert.equal(choices.assets.length,2);const chosen=choices.assets.find(asset=>asset.name==='other.webm')!,session=await service.open(id,chosen.key)
  const request=(headers:Record<string,string>={},method='GET')=>service.response(new Request(session.url,{headers,method}))
  let response=await request({range:'bytes=2-5'});assert.equal(response.status,206);assert.equal(response.headers.get('Content-Range'),'bytes 2-5/10');assert.equal(await response.text(),'cdef')
  response=await request({range:'bytes=-2'});assert.equal(await response.text(),'ij')
  response=await request({},'HEAD');assert.equal(response.headers.get('Content-Length'),'10');assert.equal(await response.text(),'')
  response=await request({range:'bytes=10-'});assert.equal(response.status,416);assert.equal(response.headers.get('Content-Range'),'bytes */10')
  assert.equal((await service.response(new Request('baoyi://video/C:/test.mp4'))).status,404)
  service.release(session.token);assert.equal((await request()).status,404)
})
test('源变化、过期、隐私、恢复全部撤销访问，删除后没有迟到流',async t=>{
  const {service,id,file,hide,expire,block}=await fixture(t),choices=await service.choices(id),chosen=choices.assets.find(asset=>asset.name==='video.mp4')!
  let session=await service.open(id,chosen.key);await fs.appendFile(file,'changed');assert.equal((await service.response(new Request(session.url))).status,404)
  session=await service.open(id,chosen.key);expire();assert.equal((await service.response(new Request(session.url))).status,404)
  session=await service.open(id,chosen.key);hide();assert.equal((await service.response(new Request(session.url))).status,404)
  session=await service.open(id,chosen.key);block();assert.equal((await service.response(new Request(session.url))).status,404)
})
