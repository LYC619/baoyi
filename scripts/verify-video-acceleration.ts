import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:http'
const impl:any=await import('../electron/kinds/video/download/ranges.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error})
assert.equal(typeof impl.transferAccelerated,'function','missing parallel Range transfer')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-acceleration-'))
const media=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(512*1024,31)])
let active=0,peak=0,mode='range',requests=0
const server=createServer((req,res)=>{
  requests++
  const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'')
  res.setHeader('Content-Type','video/mp4');res.setHeader('ETag','"stable"')
  if(mode==='stall'){res.writeHead(200);res.flushHeaders();return}
  if(range && mode!=='ignore'){
    const start=Number(range[1]),end=Math.min(Number(range[2]),media.length-1)
    res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${mode==='bad'&&start>0?end-1:end}/${media.length}`)
    res.setHeader('Content-Length',end-start+1)
    if(mode==='changed' && start>0)res.setHeader('ETag','"changed"')
    active++;peak=Math.max(peak,active)
    let closed=false;res.once('close',()=>{if(!closed){closed=true;active--}})
    setTimeout(()=>res.end(media.subarray(start,end+1)),10)
  }else{res.setHeader('Content-Length',media.length);res.end(media)}
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const address=server.address() as {port:number},url=`http://127.0.0.1:${address.port}/file.mp4`
const options=(name:string,extra={})=>({url,destination:path.join(root,name+'.mp4'),referer:'https://hanime1.me/watch?v=123',signal:new AbortController().signal,fetch,workers:4,...extra})
try{
  const success=await impl.transferAccelerated(options('success'))
  assert.deepEqual(await fs.readFile(success.destination),media);assert.equal(success.receivedBytes,media.length)
  assert.ok(peak>1 && peak<=4,'Range requests must overlap within worker limit')
  mode='ignore';const ignored=await impl.transferAccelerated(options('ignored'))
  assert.deepEqual(await fs.readFile(ignored.destination),media,'servers ignoring Range must fall back safely')
  for(const value of ['bad','changed']){mode=value;await assert.rejects(impl.transferAccelerated(options(value)),/范围|身份|变化|长度/);await assert.rejects(fs.stat(path.join(root,value+'.mp4')),/ENOENT/)}
  mode='range';await fs.writeFile(path.join(root,'existing.mp4'),'original');const before=requests
  await assert.rejects(impl.transferAccelerated(options('existing')),/存在/);assert.equal(requests,before)
  const control=new AbortController()
  await assert.rejects(impl.transferAccelerated(options('cancel',{signal:control.signal,onProgress:(p:any)=>{if(p.receivedBytes>1)control.abort(new Error('取消'))}})),/取消/)
  mode='stall';await assert.rejects(impl.transferAccelerated(options('stall',{idleTimeoutMs:30,retries:0})),/超时/)
  assert.ok(!(await fs.readdir(root)).some(name=>name.includes('baoyi-part')))
  const {createDownloadLimiter,createBudgetedFetch}=await import('../electron/kinds/video/download/limiter.ts')
  let cap=2;const limiter=createDownloadLimiter(()=>cap),controllers=Array.from({length:4},()=>new AbortController())
  const a=await limiter.acquire(controllers[0].signal),b=await limiter.acquire(controllers[1].signal)
  const cancelled=limiter.acquire(controllers[2].signal);controllers[2].abort(new Error('取消槽位'));await assert.rejects(cancelled,/取消/)
  let granted=false;const pending=limiter.acquire(controllers[3].signal).then(release=>{granted=true;return release})
  cap=1;a();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(granted,false);b();const release=await pending;release();assert.equal(limiter.active,0)
  const budget=createDownloadLimiter(()=>1),wrapped=createBudgetedFetch(async()=>new Response('test'),budget)
  const response=await wrapped(url,{signal:new AbortController().signal});assert.equal(budget.active,1);await response.body!.cancel();assert.equal(budget.active,0)
  console.log('PASS multi-connection integrity, fallback, validators, cancellation, stalls, live limits and body budget release')
}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true})}
