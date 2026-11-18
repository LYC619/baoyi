import fs from 'node:fs/promises'
import sync from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { transferVideo, httpUrl, abortable, safeDownloadError, DestinationExistsError, createDownloadTimeout, DOWNLOAD_QUEUE, type DownloadRequestInit, type TransferOptions, type TransferResult } from './transfer.ts'
import { openDownloadResponse, DownloadHttpError, retryableDownloadError, downloadDelay } from './resource.ts'
import { withStreamOutput } from './stream-output.ts'

interface Options extends TransferOptions { workers?:number; retries?:number }
class RangeIgnoredError extends Error {}
type Part = { index:number; start:number; end:number; written:number; file:string }
type Journal = { version:1; identity:string; files:Record<string,{size:number;hash:string}> }
const hash = (bytes:Buffer|string) => createHash('sha256').update(bytes).digest('hex')

type Validator={header:'etag'|'last-modified';value:string}
function validator(headers:Headers):Validator|undefined {
  const etag=headers.get('etag')||''
  if(/^"[^\r\n]+"$/.test(etag))return {header:'etag',value:etag}
  // RFC 9110: Last-Modified is strong only when at least 60 s before Date.
  // If an ETag exists but is weak/malformed, do not substitute a date for it.
  if(etag)return
  const modified=headers.get('last-modified')||'',date=headers.get('date')||''
  const format=/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/
  if(format.test(modified)&&format.test(date)&&Date.parse(date)-Date.parse(modified)>=60000)return {header:'last-modified',value:modified}
}
/** Exact ranges permit concurrent transfer; only strong validators permit cross-run reuse. */
export async function transferAccelerated(options:Options):Promise<TransferResult> {
  options.signal.throwIfAborted()
  if(!path.isAbsolute(options.destination))throw new Error('下载保存位置必须是绝对路径')
  try{await fs.lstat(options.destination);throw new DestinationExistsError('目标文件已存在，未覆盖')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  if(options.io)return transferVideo(options)
  const workers=Math.min(8,Math.max(1,Math.floor(options.workers??4)))
  const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',Referer:httpUrl(options.referer),Accept:'*/*','Accept-Encoding':'identity'}
  let meta:{url:string;total:number;validator?:Validator;etag:string;modified:string}|undefined
  const probe=createDownloadTimeout(options.idleTimeoutMs??30_000,'下载连接或读取长时间无进展，已超时'),probeSignal=AbortSignal.any([options.signal,probe.controller.signal])
  let response:Response|undefined
  try {
    probe.tick()
    const opened=await openDownloadResponse(options.fetch,options.url,{headers:{...headers,Range:'bytes=0-0'},[DOWNLOAD_QUEUE]:probe.queue} as DownloadRequestInit,probeSignal)
    response=opened.response
    if(!response.ok)throw new DownloadHttpError(response.status)
    const m=/^bytes 0-0\/(\d+)$/.exec(response.headers.get('content-range')||''),total=Number(m?.[1]),identity=validator(response.headers),encoding=response.headers.get('content-encoding')
    if(response.status===206 && m && Number.isSafeInteger(total) && total>=256*1024 && (!encoding || encoding==='identity'))meta={url:opened.url,total,validator:identity,etag:response.headers.get('etag')||'',modified:response.headers.get('last-modified')||''}
  } finally {probe.close();void response?.body?.cancel().catch(() => { /* best-effort */ })}
  const single=async()=>{
    const result=await transferVideo({...options,onProgress:p=>options.onProgress?.({...p,message:'单连接下载；此来源不支持可靠续传，中断后需从头下载'})})
    result.warnings.push('此来源不支持可靠续传；中断的直链临时文件会清理')
    return result
  }
  if(!meta)return single()
  const entity=meta,chunkSize=Math.min(4*1024*1024,Math.ceil(meta.total/8))
  const identity=hash(JSON.stringify({validator:entity.validator||{run:randomUUID()},total:entity.total,content:options.resumeKey || entity.url,chunkSize}))
  const workspacePath=path.join(path.dirname(options.destination),'.'+path.basename(options.destination)+'.baoyi-ranges')
  try {
    return await withStreamOutput(options.destination,'ranges',options.signal,async(workspace,temporary)=>{
      const stopped=new AbortController(),signal=AbortSignal.any([options.signal,stopped.signal]),journalFile=path.join(workspace,'manifest.json')
      let journal:Journal={version:1,identity,files:{}}
      try {
        const existing=JSON.parse(await fs.readFile(journalFile,'utf8'))
        if(existing.version!==1 || typeof existing.identity!=='string' || !existing.files || typeof existing.files!=='object')throw new Error('续传记录格式无效，未清理该目录')
        if(existing.identity===identity)journal=existing
        else {await fs.rm(workspace,{recursive:true,force:true});options.onProgress?.({phase:'downloading',receivedBytes:0,totalBytes:entity.total,bytesPerSecond:0,message:'来源文件身份已变化，不能混用旧数据，重新下载'})}
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      await fs.mkdir(workspace,{recursive:true})
      const save=()=>{sync.writeFileSync(journalFile+'.tmp',JSON.stringify(journal));sync.renameSync(journalFile+'.tmp',journalFile)}
      save()
      const parts:Part[]=Array.from({length:Math.ceil(entity.total/chunkSize)},(_,index)=>({index,start:index*chunkSize,end:Math.min((index+1)*chunkSize-1,entity.total-1),written:0,file:path.join(workspace,index+'.segment')}))
      let receivedBytes=0,lastTick=0,lastBytes=0,lastTime=Date.now(),bytesPerSecond=0,message=entity.validator?'正在多连接下载':'正在多连接下载；本次支持分段重试，重新开始任务时不复用旧分片'
      const warnings:string[]=[]
      for(const part of parts){
        try {
          const stat=await fs.lstat(part.file)
          if(stat.isSymbolicLink() || !stat.isFile())throw new Error('续传分片不能是链接或目录')
          const record=journal.files[part.index]
          if(record && Number.isSafeInteger(record.size) && record.size>0 && record.size<=part.end-part.start+1 && stat.size>=record.size){
            const bytes=(await fs.readFile(part.file)).subarray(0,record.size)
            if(hash(bytes)===record.hash){part.written=record.size;if(stat.size!==record.size)await fs.truncate(part.file,record.size)}
          }
          if(!part.written)await fs.truncate(part.file,0)
          receivedBytes+=part.written
        }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      }
      if(receivedBytes)message='从已校验的下载缓存继续，不重复下载已接收数据'
      lastBytes=receivedBytes
      const emit=(phase:'downloading'|'finalizing',force=false)=>{
        const now=Date.now();if(!force && now-lastTick<250)return;lastTick=now
        bytesPerSecond=Math.max(0,Math.round((receivedBytes-lastBytes)*1000/Math.max(1,now-lastTime)));lastBytes=receivedBytes;lastTime=now
        try{options.onProgress?.({phase,receivedBytes,totalBytes:entity.total,bytesPerSecond,message})}catch(cause){console.error('[下载进度通知]',cause)}
      }
      const range=async(part:Part)=>{
        if(part.written===part.end-part.start+1)return
        const handle=await fs.open(part.file,part.written?'r+':'w+',0o600)
        let checkpointAt=Date.now()
        const checkpoint=async()=>{await handle.sync();const bytes=await fs.readFile(part.file);journal.files[part.index]={size:part.written,hash:hash(bytes.subarray(0,part.written))};save();checkpointAt=Date.now()}
        try {
          for(let attempt=0;;attempt++){
            let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined
            const watchdog=createDownloadTimeout(options.idleTimeoutMs??30_000,'下载分段读取长时间无进展，已超时'),partSignal=AbortSignal.any([signal,watchdog.controller.signal]),requestStart=part.start+part.written
            try {
              partSignal.throwIfAborted();watchdog.tick()
              const opened=await openDownloadResponse(options.fetch,entity.url,{headers:{...headers,Range:`bytes=${requestStart}-${part.end}`,...(entity.validator?{'If-Range':entity.validator.value}:{})},[DOWNLOAD_QUEUE]:watchdog.queue} as DownloadRequestInit,partSignal,watchdog.tick)
              response=opened.response
              if(response.status===200)throw new RangeIgnoredError('服务器忽略分段请求，改用单连接')
              if(!response.ok)throw new DownloadHttpError(response.status)
              const currentValidator=validator(response.headers)
              if(entity.validator?(!currentValidator||currentValidator.header!==entity.validator.header||currentValidator.value!==entity.validator.value):((response.headers.get('etag')||'')!==entity.etag||(response.headers.get('last-modified')||'')!==entity.modified))throw new Error('视频身份发生变化，停止合并')
              if(response.status!==206 || response.headers.get('content-range')!==`bytes ${requestStart}-${part.end}/${entity.total}`)throw new Error('视频分段范围不匹配')
              if(response.headers.get('content-encoding') && response.headers.get('content-encoding')!=='identity')throw new Error('视频分段编码发生变化')
              if(!response.body)throw new Error('视频分段为空')
              reader=response.body.getReader()
              for(;;){
                const item=await abortable(reader.read(),partSignal);if(item.done)break;watchdog.tick()
                const data=Buffer.from(item.value)
                if(part.written+data.length>part.end-part.start+1)throw new Error('视频分段长度超过声明范围')
                let offset=0
                while(offset<data.length){const result=await handle.write(data,offset,data.length-offset,part.written+offset);if(!result.bytesWritten)throw new Error('视频分段写入失败');offset+=result.bytesWritten}
                part.written+=data.length;receivedBytes+=data.length;emit('downloading',receivedBytes===data.length)
                if(Date.now()-checkpointAt>1000)await checkpoint()
              }
              if(part.written!==part.end-part.start+1)throw new Error('视频分段长度不符，连接中断')
              return
            }catch(error){
              if(signal.aborted)throw signal.reason
              if(attempt>=Math.min(options.retries??2,4) || !retryableDownloadError(error))throw error
              if(part.written===part.end-part.start+1)return
              message='连接中断，保留已接收数据并重试剩余部分';emit('downloading',true)
            }finally{watchdog.close();if(reader){void reader.cancel().catch(() => { /* best-effort */ });reader.releaseLock()}else void response?.body?.cancel().catch(() => { /* best-effort */ })}
            await downloadDelay(300*(attempt+1),signal)
          }
        }finally{try{await checkpoint()}finally{await handle.close()}}
      }
      emit('downloading',true)
      let cursor=0,failure:unknown
      const deferred:Part[]=[]
      await Promise.allSettled(Array.from({length:Math.min(workers,parts.length)},async()=>{
        for(;;){
          const part=parts[cursor++];if(!part || signal.aborted)return
          try{await range(part)}catch(error){
            if(!signal.aborted && retryableDownloadError(error)){deferred.push(part);message='一条连接暂时失败，其他连接继续下载';emit('downloading',true)}
            else if(!stopped.signal.aborted){failure=error;stopped.abort(error);return}
          }
        }
      }))
      if(failure)throw failure;signal.throwIfAborted()
      for(const part of deferred){message='已降为单连接，补齐未完成部分';emit('downloading',true);await range(part)}
      if(receivedBytes!==entity.total || parts.some(part=>part.written!==part.end-part.start+1))throw new Error('视频总长度校验失败')
      message='正在合并已校验分段并安全保存';emit('finalizing',true)
      const output=await fs.open(temporary,'wx',0o600)
      try{for(const part of parts){signal.throwIfAborted();const bytes=await fs.readFile(part.file);let offset=0;while(offset<bytes.length){const result=await output.write(bytes,offset,bytes.length-offset);if(!result.bytesWritten)throw new Error('合并分段写入失败');offset+=result.bytesWritten}}await output.sync()}finally{await output.close()}
      return {phase:'finalizing' as const,destination:options.destination,receivedBytes,totalBytes:entity.total,bytesPerSecond,warnings}
    })
  }catch(error){
    if(error instanceof RangeIgnoredError && !options.signal.aborted){
      const result=await single()
      try{await fs.rm(workspacePath,{recursive:true,force:true})}catch(cleanup){result.warnings.push('旧分段缓存待清理：'+safeDownloadError(cleanup))}
      return result
    }
    throw error
  }
}
