import assert from 'node:assert/strict'
import { PicacomicSource } from '../electron/kinds/image/source.ts'
import { pngImage } from './helpers/test-images.ts'

const origin='https://storage-b.picacomic.com/static/test/page.jpg'
const destination='https://img.picacomic.com/test/page.jpg'
const bytes=new Uint8Array(pngImage(12,18))
const row={_id:'work1',title:'测试作品',thumb:{fileServer:'https://storage-b.picacomic.com',path:'test/page.jpg'}}
const image=()=>new Response(bytes)
const redirect=(location:string,status=301)=>new Response(null,{status,headers:{location}})

for(const status of [301,302,303,307,308]){
  const requests:Array<{url:string;init?:RequestInit}>=[]
  const source=new PicacomicSource({token:()=> 'private-token',fetch:async(url,init)=>{
    if(url.includes('/leaderboard'))return Response.json({code:200,data:{comics:[row]}})
    requests.push({url,init})
    return url===origin?redirect(destination,status):image()
  }})
  const listing=await source.ranking()
  assert.match(await source.cover(listing.items[0].coverUrl!),/^data:image\/png;base64,/)
  assert.deepEqual((await source.image(origin)).data,Buffer.from(bytes))
  assert.deepEqual(requests.map(r=>r.url),[origin,destination,origin,destination])
  for(const request of requests){
    assert.equal(request.init?.redirect,'manual')
    assert.equal(request.init?.headers,undefined,'图片跳转不得携带 API 凭据')
    assert.equal(request.init?.credentials,'omit')
  }
}

const relative=new PicacomicSource({token:()=>'',fetch:async url=>url===origin?redirect('/moved.jpg'):image()})
assert.equal((await relative.image(origin)).extension,'.png')
for(const location of ['http://img.picacomic.com/page','https://127.0.0.1/page','https://[::1]/page','https://test.local/page','https://test.localhost/page','https://localhost./page','https://user:password@img.picacomic.com/page','file:///C:/Windows/win.ini']){
  let calls=0
  const source=new PicacomicSource({token:()=>'',fetch:async()=>{calls++;return redirect(location)},wait:async()=>{}})
  await assert.rejects(source.image(origin),/图片.*地址|图片.*服务器/)
  assert.equal(calls,1,'禁止请求不受支持的跳转地址')
}
let loopCalls=0
const loop=new PicacomicSource({token:()=>'',fetch:async()=>{loopCalls++;return redirect(origin)},wait:async()=>{}})
await assert.rejects(loop.image(origin),/跳转/)
assert.ok(loopCalls<=6)
let hopCalls=0
const tooMany=new PicacomicSource({token:()=>'',fetch:async()=>redirect('/hop/'+(++hopCalls)),wait:async()=>{}})
await assert.rejects(tooMany.image(origin),/跳转/)
assert.ok(hopCalls<=6)
const missing=new PicacomicSource({token:()=>'',fetch:async()=>new Response(null,{status:302}),wait:async()=>{}})
await assert.rejects(missing.image(origin),/跳转/)

for(const failure of ['network',408,429,500,502,503,504]){
  let calls=0,waits=0
  const source=new PicacomicSource({token:()=>'',fetch:async()=>{
    if(++calls===1){if(failure==='network')throw new Error('net::ERR_CONNECTION_RESET');return new Response(null,{status:failure as number})}
    return image()
  },wait:async()=>{waits++}})
  assert.equal((await source.image(origin)).extension,'.png')
  assert.equal(calls,2)
  assert.equal(waits,1)
}
let persistentCalls=0
const persistent=new PicacomicSource({token:()=>'',fetch:async()=>{persistentCalls++;throw new Error('net::ERR_NAME_NOT_RESOLVED')},wait:async()=>{}})
await assert.rejects(persistent.image(origin),/ERR_NAME_NOT_RESOLVED/)
assert.equal(persistentCalls,4,'与参考项目一致，最多重试三次')
let permanentCalls=0
const permanent=new PicacomicSource({token:()=>'',fetch:async()=>{permanentCalls++;return new Response(null,{status:404})},wait:async()=>{}})
await assert.rejects(permanent.image(origin),/HTTP 404/)
assert.equal(permanentCalls,1)
const controller=new AbortController()
const cancelled=new PicacomicSource({token:()=>'',fetch:async()=>{controller.abort();throw new Error('aborted')},wait:async()=>assert.fail('取消后不得继续重试')})
await assert.rejects(cancelled.image(origin,controller.signal),/取消/)
console.log('PASS 图片跳转、相对地址、凭据隔离、跳转边界、瞬时重试、永久错误与取消')
