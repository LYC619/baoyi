import {Worker} from 'node:worker_threads'
import type {ExtractionRequest} from './document-extract-core.ts'
import type {DocumentExtraction} from '../../src/types/document-insight.ts'
import {ArchiveRunSlot} from '../archive/run-slot.ts'

const extractionSlot=new ArchiveRunSlot()
/** One parser at a time; termination also stops a stuck PDF.js page or cancelled parse. */
export function extractDocument(input:ExtractionRequest,options:{signal?:AbortSignal;progress?:(page:number,total:number)=>void;timeoutMs?:number}={}):Promise<DocumentExtraction>{
  return extractionSlot.run(()=>new Promise((resolve,reject)=>{
    const filename=import.meta.url.endsWith('.ts')?'./document-extract-worker.ts':'./document-worker.js'
    const worker=new Worker(new URL(filename,import.meta.url),{workerData:input,resourceLimits:{maxOldGenerationSizeMb:256}})
    let settled=false,timer:ReturnType<typeof setTimeout>
    const finish=(error?:Error,result?:DocumentExtraction)=>{
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(totalTimer);options.signal?.removeEventListener('abort',abort)
      void worker.terminate().then(()=>error?reject(error):resolve(result!),reject)
    }
    const watchdog=()=>{clearTimeout(timer);timer=setTimeout(()=>finish(new Error('PDF 页面提取超时，已停止；请尝试拆分资料')),15000)}
    const totalTimer=setTimeout(()=>finish(new Error('正文提取超时，已停止')),options.timeoutMs??120000)
    const abort=()=>finish(options.signal?.reason instanceof Error?options.signal.reason:new Error('提取已停止'))
    options.signal?.addEventListener('abort',abort,{once:true});watchdog()
    worker.on('message',message=>{
      if(message.type==='progress'){watchdog();options.progress?.(message.page,message.total)}
      else if(message.type==='result')finish(undefined,message.result)
      else if(message.type==='error')finish(new Error(message.error))
    })
    worker.on('error',error=>finish(error));worker.on('exit',code=>{if(!settled)finish(new Error(`正文提取进程退出（${code}），可重试`))})
    if(options.signal?.aborted)abort()
  }),{signal:options.signal})
}
