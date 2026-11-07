import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const impl:any=await import('../electron/kinds/video/download/media.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error})
assert.equal(typeof impl.createVideoMediaTransfer,'function','missing unified Hanime media transfer')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-media-')),bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(128)])
let count=0,refreshed=0,recovered=0
const transfer=impl.createVideoMediaTransfer({settings:()=>({video_download_connections:1}),ffmpeg:()=>null,recoverNetwork:async()=>{recovered++},
  fetch:async(input:string)=>{count++;return input.includes('expired')?new Response(null,{status:403}):new Response(bytes,{headers:{'content-type':'video/mp4'}})}})
const request=(name:string)=>({url:'https://cdn.test/expired.mp4?secret=hidden',referer:'https://hanime1.me/watch?v=1',destination:path.join(root,name+'.mp4'),signal:new AbortController().signal})
try{
  const result=await transfer({...request('renew'),refreshSource:async()=>{refreshed++;return {url:'https://cdn.test/new.mp4'}}})
  // Even one-connection transfers probe Range support to enable disk resume.
  assert.equal(refreshed,1);assert.equal(count,3);assert.deepEqual(await fs.readFile(result.destination),bytes)
  const before=count;await assert.rejects(transfer({...request('hls'),format:'hls'}),/FFmpeg/);assert.equal(count,before,'missing FFmpeg must fail before transfer')
  let attempts=0
  const retry=impl.createVideoMediaTransfer({settings:()=>({video_download_connections:1}),ffmpeg:()=>null,recoverNetwork:async()=>{recovered++},fetch:async()=>{if(!attempts++)throw new Error('ERR_CONNECTION_RESET');return new Response(bytes,{headers:{'content-type':'video/mp4'}})}})
  await retry({...request('retry'),url:'https://cdn.test/video.mp4'});assert.equal(attempts,3);assert.equal(recovered,1)
  const cancelled=new AbortController();cancelled.abort(new Error('取消'))
  await assert.rejects(transfer({...request('cancelled'),signal:cancelled.signal}),/取消/)
  await assert.rejects(transfer(request('unrenewable')),/HTTP 403/)
  const hiddenHls=impl.createVideoMediaTransfer({settings:()=>({video_download_connections:1}),ffmpeg:()=>null,
    fetch:async()=>new Response('#EXTM3U\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST',{headers:{'content-type':'application/vnd.apple.mpegurl'}})})
  await assert.rejects(hiddenHls({...request('hidden-hls'),url:'https://cdn.test/player.mp4'}),/FFmpeg/,'manifest MIME behind a direct URL must use the stream downloader')
  let clock=0,idleRefreshes=0
  const idle=impl.createVideoMediaTransfer({settings:()=>({video_download_connections:1}),ffmpeg:()=>null,now:()=>clock,
    recoverNetwork:async()=>{idleRefreshes++},fetch:async()=>new Response(bytes,{headers:{'content-type':'video/mp4'}})})
  await idle({...request('before-idle'),url:'https://cdn.test/a.mp4'});assert.equal(idleRefreshes,0)
  clock=600_000
  await idle({...request('after-idle'),url:'https://cdn.test/a.mp4'});assert.equal(idleRefreshes,1,'stale idle sessions should refresh before reuse')
  assert.ok(!(await fs.readdir(root)).some(name=>name.includes('baoyi-part')))
  console.log('PASS unified media dispatch, FFmpeg preflight, signed source renewal, bounded network recovery and cancellation')
}finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true})}
