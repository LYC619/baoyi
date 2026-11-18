import { transferAccelerated } from './ranges.ts'
import { downloadHls } from './hls.ts'
import { downloadDash } from './dash.ts'
import { createDownloadLimiter, createBudgetedFetch } from './limiter.ts'
import { videoTransferOptions, type VideoTransferSettings } from './options.ts'
import { DownloadHttpError, retryableDownloadError, downloadDelay } from './resource.ts'
import { DOWNLOAD_UA, safeDownloadError, type TransferOptions, type TransferResult } from './transfer.ts'

interface Dependencies { fetch:typeof fetch; settings:()=>VideoTransferSettings; ffmpeg:()=>string|null; recoverNetwork?:()=>Promise<unknown>; now?:()=>number }
export function createVideoMediaTransfer(deps:Dependencies) {
  const network=createDownloadLimiter(()=>16),videos=createDownloadLimiter(()=>videoTransferOptions(deps.settings()).concurrency)
  const fetcher=createBudgetedFetch(deps.fetch,network)
  const now=deps.now??Date.now
  let lastActivity=now(),idleRecovery:Promise<unknown>|null=null
  return async(options:Omit<TransferOptions,'fetch'>):Promise<TransferResult>=>{
    const release=await videos.acquire(options.signal)
    const fileFetch=createBudgetedFetch(fetcher,createDownloadLimiter(()=>videoTransferOptions(deps.settings()).connections))
    let url=options.url,format=options.format
    try{
      if(now()-lastActivity>=5*60_000 && network.active===0 && deps.recoverNetwork){
        if(!idleRecovery)idleRecovery=deps.recoverNetwork().catch(cause=>console.error('[下载网络恢复]',cause))
        try{await idleRecovery;lastActivity=now()}finally{idleRecovery=null}
      }
      for(let attempt=0;;attempt++){
        options.signal.throwIfAborted()
        try{
          const workers=videoTransferOptions(deps.settings()).connections
          if(format==='hls'||format==='dash'){
            const ffmpeg=deps.ffmpeg()
            if(!ffmpeg)throw new Error('没有找到 FFmpeg，请到设置 → 下载与缓存中检测或选择 ffmpeg.exe')
            const saved=await (format==='hls'?downloadHls:downloadDash)({url,destination:options.destination,headers:{'User-Agent':DOWNLOAD_UA,Referer:options.referer},signal:options.signal,fetch:fileFetch,ffmpeg,workers,idleTimeoutMs:options.idleTimeoutMs,onProgress:options.onProgress})
            return {...saved,phase:'finalizing'}
          }
          return await transferAccelerated({...options,url,fetch:fileFetch,workers})
        }catch(error){
          if(options.signal.aborted)throw options.signal.reason
          const detected=/收到 (HLS|DASH) 播放清单/.exec(error instanceof Error?error.message:String(error))
          if(detected && attempt<2){format=detected[1]==='HLS'?'hls':'dash';continue}
          const expired=error instanceof DownloadHttpError ? [403,410].includes(error.status) : /HTTP (403|410)\b/.test(error instanceof Error?error.message:String(error))
          const retry=retryableDownloadError(error)
          if(attempt>=2 || !retry && !(expired && options.refreshSource))throw new Error(safeDownloadError(error))
          if(retry && network.active===0){try{await deps.recoverNetwork?.()}catch(cause){console.error('[下载网络恢复]',cause)}}
          await downloadDelay(300*(attempt+1),options.signal)
          if(options.refreshSource){const refreshed=await options.refreshSource();url=refreshed.url;format=refreshed.format}
        }
      }
    }finally{lastActivity=now();release()}
  }
}
