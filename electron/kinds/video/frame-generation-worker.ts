import {parentPort,workerData} from 'node:worker_threads'
import {generateFramesInline,type FrameGenerated} from './frame-generator.ts'
const controller=new AbortController()
let acknowledge:((error?:string)=>void)|undefined
parentPort!.on('message',message=>{
  if(message.event==='cancel'){controller.abort(new Error('预览已取消'));acknowledge?.('预览已取消')}
  if(message.event==='previewAck')acknowledge?.(message.error)
})
generateFramesInline({...workerData,signal:controller.signal,
  progress:(value:number)=>parentPort!.postMessage({event:'progress',value}),
  preview:(value:FrameGenerated)=>new Promise<void>((resolve,reject)=>{
    acknowledge=error=>{acknowledge=undefined;error?reject(new Error(error)):resolve()}
    parentPort!.postMessage({event:'preview',value})
  })
}).then(value=>parentPort!.postMessage({value}),error=>parentPort!.postMessage({error:(error as Error).message})).finally(()=>parentPort!.close())
