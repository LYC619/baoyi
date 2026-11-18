import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {transferAccelerated} from '../electron/kinds/video/download/ranges.ts'
import {transferVideo} from '../electron/kinds/video/download/transfer.ts'
const media=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(512*1024,17)])
const modified='Wed, 04 Nov 2026 12:00:00 GMT',date='Wed, 04 Nov 2026 12:02:00 GMT'
test('Range accepts a strong Last-Modified, rejects changed identity and avoids reusing weak dates/ETags',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-validator-'))
  try{for(const mode of ['date','changed','recent','weak','none']){
    const calls:Array<{range:string|null;ifRange:string|null}>=[]
    const fetcher:typeof fetch=async(_url,init)=>{
      const h=new Headers(init?.headers),range=h.get('range');calls.push({range,ifRange:h.get('if-range')})
      const match=/^bytes=(\d+)-(\d+)$/.exec(range||''),start=Number(match?.[1]||0),end=Number(match?.[2]||media.length-1)
      const headers=new Headers({'Content-Type':'video/mp4','Content-Length':String(end-start+1)})
      if(mode!=='none'){
        headers.set('Last-Modified',mode==='changed'&&end>0?'Wed, 04 Nov 2026 11:00:00 GMT':modified)
        headers.set('Date',mode==='recent'?'Wed, 04 Nov 2026 12:00:30 GMT':date)
      }
      if(mode==='weak')headers.set('ETag','W/"weak"')
      if(range)headers.set('Content-Range',`bytes ${start}-${end}/${media.length}`)
      return new Response(media.subarray(start,end+1),{status:range?206:200,headers})
    }
    const destination=path.join(root,mode+'.mp4'),options={destination,url:'https://cdn.test/video',referer:'https://source.test/',signal:new AbortController().signal,fetch:fetcher}
    if(mode==='changed'){await assert.rejects(transferAccelerated(options),/身份/);assert.equal(await fs.stat(destination).catch(()=>null),null);continue}
    await transferAccelerated(options);assert.deepEqual(await fs.readFile(destination),media)
    if(mode==='date'){assert.ok(calls.length>4);assert.ok(calls.slice(1).every(call=>call.ifRange===modified))}
    else {assert.ok(calls.length>4);assert.ok(calls.slice(1).every(call=>call.range&&call.ifRange===null))}
  }}finally{await fs.rm(root,{recursive:true,force:true})}
})
test('single stream coalesces tiny chunks and preserves the exact tail and length',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-buffer-'))
  try{
    let writes=0
    const io={...fs,open:async(...args:Parameters<typeof fs.open>)=>{const handle=await fs.open(...args),write=handle.writeFile.bind(handle);handle.writeFile=async(...args:any[])=>{writes++;return write(...args as Parameters<typeof write>)};return handle}} as typeof fs
    const fetcher:typeof fetch=async()=>new Response(new ReadableStream({start(c){for(let n=0;n<media.length;n+=1024)c.enqueue(media.subarray(n,n+1024));c.close()}}),{headers:{'Content-Type':'video/mp4','Content-Length':String(media.length)}})
    const result=await transferVideo({destination:path.join(root,'video.mp4'),url:'https://cdn.test/video',referer:'https://source.test/',signal:new AbortController().signal,fetch:fetcher,io})
    assert.deepEqual(await fs.readFile(result.destination),media);assert.equal(writes,Math.ceil(media.length/131072))
  }finally{await fs.rm(root,{recursive:true,force:true})}
})
