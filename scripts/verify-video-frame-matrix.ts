import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {imageSize} from 'image-size'
import {frameFfmpeg,generateFrames,frameFingerprint} from '../electron/kinds/video/frame-generator.ts'
const exec=promisify(execFile),ffmpeg=process.argv[2];assert.ok(ffmpeg)
const output=path.resolve('output/p1-p2-video-2026-11-06/matrix');await fs.mkdir(output,{recursive:true});const root=await fs.mkdtemp(path.join(output,'run-'))
const results:any[]=[]
const cases=[
  {name:'one-hour-long-gop',extension:'mp4',input:'color=c=blue:size=640x360:rate=1',seconds:'3600',codec:['-c:v','libx264','-preset','ultrafast','-g','3600','-keyint_min','3600','-sc_threshold','0','-pix_fmt','yuv420p']},
  {name:'4k-motion',extension:'mp4',input:'testsrc2=size=3840x2160:rate=12',seconds:'3',codec:['-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p']},
  {name:'8k',extension:'mp4',input:'color=c=green:size=7680x4320:rate=1',seconds:'2',codec:['-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p']},
  {name:'vp9-opus',extension:'webm',input:'testsrc2=size=640x360:rate=12',seconds:'3',codec:['-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-c:a','libopus'],audio:true},
  {name:'vp8-vorbis',extension:'webm',input:'testsrc2=size=640x360:rate=12',seconds:'3',codec:['-c:v','libvpx','-deadline','realtime','-cpu-used','8','-c:a','libvorbis'],audio:true},
]
try{
 for(const sample of cases){
  const file=path.join(root,sample.name+'.'+sample.extension),directory=path.join(root,sample.name)
  await exec(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i',sample.input,...(sample.audio?['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']:[]),'-t',sample.seconds,...sample.codec,'-threads','2',file],{windowsHide:true,timeout:90000,maxBuffer:65536})
  const before=await frameFingerprint(file),lags:number[]=[],began=performance.now(),previews:any[]=[];let previous=performance.now()
  const ticker=setInterval(()=>{const now=performance.now();lags.push(now-previous-10);previous=now},10)
  let generated
  try{generated=await generateFrames({file,directory,ffmpeg,duration:0,signal:new AbortController().signal,preview:async value=>{assert.equal(value.times.length,8);assert.ok(imageSize(await fs.readFile(path.join(directory,'preview.jpg'))).width);previews.push({elapsedMs:performance.now()-began,frames:value.times.length})}})}finally{clearInterval(ticker)}
  assert.equal((await frameFingerprint(file)).hash,before.hash);assert.ok(generated.times.length>0&&generated.times.length<=24)
  if(generated.times.length<8){assert.equal(sample.name,'8k');assert.equal(generated.partial,true);assert.ok(generated.message)}
  if(sample.name==='one-hour-long-gop'){assert.equal(generated.times.length,24);assert.equal(previews.length,1)}
  if(sample.audio)assert.equal(generated.audioTracks,1)
  lags.sort((a,b)=>a-b);results.push({name:sample.name,file,generated,previews,elapsedMs:performance.now()-began,mainLoop:{p95DelayMs:lags[Math.floor(lags.length*.95)],maxDelayMs:lags.at(-1)}})
  console.log('PASS '+sample.name+' '+generated.times.length+' frames')
 }
 const broken=path.join(root,'broken.mp4');await fs.writeFile(broken,'not a video')
 await assert.rejects(generateFrames({file:broken,directory:path.join(root,'broken'),ffmpeg,duration:0,signal:new AbortController().signal}))
 assert.equal(await frameFfmpeg(path.join(root,'missing-ffmpeg.exe')),null)
 await fs.writeFile(path.join(root,'result.json'),JSON.stringify({passed:cases.length+2,results,checks:['损坏视频明确失败','显式不存在的FFmpeg不静默改用其他程序'],limits:'一小时样本为合成1fps长GOP；不是真实高码率电影基准'},null,2))
 console.log('PASS matrix; '+root)
}catch(error){await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({error:String(error),results},null,2));throw error}
