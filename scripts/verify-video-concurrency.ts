import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createVideoWorkflow } from '../electron/kinds/video/download/workflow.ts'
import { downloadDelay } from '../electron/kinds/video/download/resource.ts'
import { createVideoDownloadService } from '../electron/kinds/video/download/service.ts'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-video-concurrency-')),db=new DatabaseSync(':memory:')
initSchema(db,KINDS)
let active=0,peak=0,cap=2,refreshes=0
const work=(code:string)=>({videoCode:code,title:'Work '+code,description:'Description',posterUrl:'',tags:[],episodes:code==='100'?['100','101','102'].map(videoCode=>({videoCode,title:'Episode '+videoCode})):[{videoCode:code,title:'Episode '+code}],warnings:[]})
const options:any={db,downloadsDirectory:()=>root,concurrency:()=>cap,
  resolveWork:async(code:string)=>work(code),
  resolveSources:async(code:string)=>({videoCode:code,title:'Episode '+code,candidates:[{url:'https://media.test/'+code+'.m3u8',label:'720p',extension:'mp4',format:'hls'}],warnings:[]}),
  transfer:async(input:any)=>{
    assert.equal(input.format,'hls');assert.equal(typeof input.refreshSource,'function')
    assert.match(input.resumeKey,/^hanime:\d+:720p$/)
    input.onProgress?.({phase:'downloading',receivedBytes:2048,totalBytes:0,bytesPerSecond:1024,message:'已下载 2/12 个 HLS 分片，正在接收'})
    assert.ok(svc.list().some(job=>job.items.some(item=>item.transferMessage==='已下载 2/12 个 HLS 分片，正在接收')),'workflow must preserve the real transfer message')
    const renewed=await input.refreshSource();assert.equal(renewed.format,'hls');refreshes++
    active++;peak=Math.max(peak,active)
    try{await downloadDelay(35,input.signal);fs.writeFileSync(input.destination,'synthetic media');return {destination:input.destination,receivedBytes:15,totalBytes:15,bytesPerSecond:1,warnings:[]}}finally{active--}
  }}
const svc=createVideoWorkflow(options)
const request=(draft:any,codes:string[])=>({draftId:draft.id,videoCodes:codes,sourceLabel:'',strictQuality:false,register:true})
try{
  const series=await svc.prepare({url:'https://hanime1.me/watch?v=100'})
  const job=svc.enqueue(request(series,['100','101','102']));await svc.idle()
  const done=svc.list().find(value=>value.id===job.id)!
  assert.equal(done.items.filter(item=>item.transfer==='complete').length,3)
  assert.equal(done.items.filter(item=>item.registration==='complete').length,3)
  assert.ok(peak===2,'series downloads must overlap and obey limit')
  assert.equal(JSON.parse(fs.readFileSync(path.join(done.directory,'baoyi.json'),'utf8')).items.filter((item:any)=>item.files.length>0).length,3,'serial publication must retain all episodes')
  peak=0
  const a=await svc.prepare({url:'https://hanime1.me/watch?v=200'}),b=await svc.prepare({url:'https://hanime1.me/watch?v=300'})
  const one=svc.enqueue(request(a,['200'])),two=svc.enqueue(request(b,['300']))
  await downloadDelay(10,new AbortController().signal);assert.equal(svc.list().find(value=>value.id===two.id)!.status,'running')
  svc.cancel(one.id);await svc.idle()
  assert.equal(svc.list().find(value=>value.id===one.id)!.status,'cancelled');assert.equal(svc.list().find(value=>value.id===two.id)!.items[0].transfer,'complete')
  assert.equal(active,0);assert.equal(peak,2)
  cap=1;peak=0
  const c=await svc.prepare({url:'https://hanime1.me/watch?v=400'}),d=await svc.prepare({url:'https://hanime1.me/watch?v=500'})
  svc.enqueue(request(c,['400']));svc.enqueue(request(d,['500']));await svc.idle();assert.equal(peak,1)
  assert.ok(refreshes>=6)
  let legacyActive=0,legacyPeak=0
  const legacy=createVideoDownloadService({
    concurrency:()=>2,getItem:id=>({id,hanime_id:id}),downloadsDirectory:()=>root,
    resolveSources:async code=>({videoCode:code,title:'Legacy '+code,candidates:[{url:'https://media.test/'+code+'.mp4',label:'720p',extension:'mp4'}],warnings:[]}),
    chooseFile:async input=>input.defaultPath,log:()=>{},
    transfer:async input=>{legacyActive++;legacyPeak=Math.max(legacyPeak,legacyActive);try{await downloadDelay(15,input.signal);return {phase:'finalizing',destination:input.destination,receivedBytes:1,totalBytes:1,bytesPerSecond:0,warnings:[]}}finally{legacyActive--}}
  })
  const oldA=await legacy.sources('901'),oldB=await legacy.sources('902')
  const oldResults=await Promise.all([legacy.run({requestId:'a',resourceId:'901',sourceId:oldA.sources[0].id},()=>{}),legacy.run({requestId:'b',resourceId:'902',sourceId:oldB.sources[0].id},()=>{})])
  assert.ok(oldResults.every(result=>result.status==='success'));assert.equal(legacyPeak,2,'legacy entry must also allow independent downloads')
  console.log('PASS series/job concurrency, serialized archives, format/renewal propagation, cancellation isolation and changed limit')
}finally{db.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true})}
