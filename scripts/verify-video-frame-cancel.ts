import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {generateFrames} from '../electron/kinds/video/frame-generator.ts'
const ffmpeg=path.resolve(process.argv[2]),source=path.resolve(process.argv[3]),output=path.resolve(process.argv[4]||'output/p1-p2-video-2026-11-06/cancel')
await fs.mkdir(output,{recursive:true});const root=await fs.mkdtemp(path.join(output,'run-')),file=path.join(root,'synthetic.mp4'),directory=path.join(root,'frames')
await fs.copyFile(source,file)
const controller=new AbortController(),progress:number[]=[],started=Date.now()
let cancelledAt=0
await assert.rejects(generateFrames({file,directory,ffmpeg,duration:3600,signal:controller.signal,progress:value=>{
  progress.push(value)
  if(!controller.signal.aborted){cancelledAt=Date.now();controller.abort(new Error('隔离取消验收'))}
}}),/取消/)
assert.ok(cancelledAt,'实际抽帧至少完成一帧后再取消')
const settleMs=Date.now()-cancelledAt
assert.ok(settleMs<10000,'worker 应在取消宽限内结束')
await fs.rename(file,file+'.released');await fs.rename(file+'.released',file)
const after=await fs.readdir(directory),count=progress.length
await new Promise(resolve=>setTimeout(resolve,1200))
assert.deepEqual(await fs.readdir(directory),after,'取消结束后无迟到产物')
assert.equal(progress.length,count,'取消结束后无迟到回调')
assert.ok(!after.includes('index.json'),'取消后不发布完成缓存')
await fs.writeFile(path.join(root,'result.json'),JSON.stringify({status:'passed',checks:['真实双worker/FFmpeg取消并释放源文件','取消后无迟到进度或完成缓存'],settleMs,totalMs:Date.now()-started,progress},null,2))
console.log('PASS real frame cancellation; '+root)
