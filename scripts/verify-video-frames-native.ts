import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {imageSize} from 'image-size'
import {frameFfmpeg,generateFrames} from '../electron/kinds/video/frame-generator.ts'
const exec=promisify(execFile),ffmpeg=process.argv[2]
assert.ok(ffmpeg,'显式提供本机FFmpeg路径')
const root=path.resolve('output/p1-p2-video-2026-11-06/native-frames');await fs.mkdir(root,{recursive:true});const run=await fs.mkdtemp(path.join(root,'run-'))
assert.equal(await frameFfmpeg(ffmpeg),ffmpeg)
const file=path.join(run,'synthetic.mp4')
await exec(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-t','8','-c:v','libx264','-threads','2','-pix_fmt','yuv420p',file],{windowsHide:true,timeout:30000,maxBuffer:131072})
let beats=0;const lags:number[]=[];let previous=performance.now();const ticker=setInterval(()=>{const now=performance.now();lags.push(now-previous-10);previous=now;beats++},10)
let result
try{result=await generateFrames({file,directory:path.join(run,'frames'),ffmpeg,duration:8,signal:new AbortController().signal})}finally{clearInterval(ticker)}
const dimensions=imageSize(await fs.readFile(path.join(run,'frames','sprite.jpg')))
assert.equal(dimensions.width,1920);assert.equal(dimensions.height,720);assert.equal(result.times.length,8);assert.equal(result.audioTracks,0);assert.equal(result.partial,false);assert.ok(result.bytes<4*1024**2);assert.ok(beats>5)
lags.sort((a,b)=>a-b)
await fs.writeFile(path.join(run,'result.json'),JSON.stringify({passed:true,file,ffmpeg,result,dimensions,mainLoop:{ticks:beats,p95DelayMs:lags[Math.floor(lags.length*.95)],maxDelayMs:lags.at(-1)}},null,2))
console.log(JSON.stringify({passed:true,frames:result.times.length,bytes:result.bytes,dimensions,p95DelayMs:lags[Math.floor(lags.length*.95)],maxDelayMs:lags.at(-1),run}))
