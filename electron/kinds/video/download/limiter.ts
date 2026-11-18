import { abortable, DOWNLOAD_QUEUE, type DownloadRequestInit } from './transfer.ts'

export function createDownloadLimiter(limit: () => number) {
  let active=0
  const queue:Array<{signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(error:unknown)=>void;abort:()=>void}>=[]
  const pump=()=>{
    while(queue.length && active<Math.max(1,Math.floor(limit())||1)) {
      const next=queue.shift()!;next.signal.removeEventListener('abort',next.abort)
      if(next.signal.aborted){next.reject(next.signal.reason);continue}
      active++;let released=false
      next.resolve(()=>{if(!released){released=true;active--;pump()}})
    }
  }
  return {
    get active(){return active},notify:pump,
    acquire:(signal:AbortSignal)=>new Promise<()=>void>((resolve,reject)=>{
      if(signal.aborted){reject(signal.reason);return}
      const next={signal,resolve,reject,abort:()=>{const index=queue.indexOf(next);if(index>=0)queue.splice(index,1);signal.removeEventListener('abort',next.abort);reject(signal.reason)}}
      queue.push(next);signal.addEventListener('abort',next.abort,{once:true});pump()
    })
  }
}
export type DownloadLimiter=ReturnType<typeof createDownloadLimiter>
/** A network slot belongs to the response body until consumed, cancelled or aborted. */
export function createBudgetedFetch(fetcher:typeof fetch,limiter:DownloadLimiter):typeof fetch {
  return async(input,init)=>{
    const signal=init?.signal??new AbortController().signal
    const queue = (init as DownloadRequestInit | undefined)?.[DOWNLOAD_QUEUE]
    let release: () => void
    queue?.(true)
    try { release = await limiter.acquire(signal) } finally { queue?.(false) }
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,stream:ReadableStreamDefaultController<Uint8Array>|undefined
    let finished=false
    const finish=()=>{if(!finished){finished=true;signal.removeEventListener('abort',abort);release()}}
    const abort=()=>{void reader?.cancel(signal.reason).catch(() => { /* best-effort */ });try{stream?.error(signal.reason)}catch{ /* best-effort */ }finish()}
    signal.addEventListener('abort',abort,{once:true})
    try{
      signal.throwIfAborted()
      const pending=fetcher(input,init)
      void pending.then(res=>{if(signal.aborted)void res.body?.cancel().catch(() => { /* best-effort */ })},()=>{})
      const response=await abortable(pending,signal)
      if(!response.body){finish();return response}
      reader=response.body.getReader()
      const body=new ReadableStream<Uint8Array>({
        start(controller){stream=controller},
        async pull(controller){try{const chunk=await reader!.read();if(chunk.done){controller.close();finish()}else controller.enqueue(chunk.value)}catch(error){try{controller.error(error)}catch{ /* best-effort */ }finish()}},
        async cancel(reason){try{await reader!.cancel(reason)}finally{finish()}}
      },{highWaterMark:0})
      const result=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers})
      Object.defineProperty(result,'url',{value:response.url})
      return result
    }catch(error){finish();throw error}
  }
}
