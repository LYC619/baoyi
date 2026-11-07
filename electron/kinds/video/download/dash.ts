import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { httpUrl, transferVideo } from './transfer.ts'
import { readDownloadResource, retryableDownloadError } from './resource.ts'
import { withStreamOutput } from './stream-output.ts'
import { createFragmentCache, fragmentShape } from './fragment-cache.ts'
import { remuxToMp4 } from './ffmpeg.ts'
import type { HlsDownloadOptions } from './hls.ts'

interface DashSegment { url: string; range?: {start:number;end:number} }
export interface DashTrack { kind: 'video'|'audio'; segments: DashSegment[]; full?: boolean }
type Xml = Record<string,any>
const array = (value: any): Xml[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const duration = (value: string): number => {
  const m=/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value || '')
  return m ? Number(m[1]||0)*86400+Number(m[2]||0)*3600+Number(m[3]||0)*60+Number(m[4]||0) : 0
}
function integer(value: any, fallback: number): number {
  const n=value === undefined ? fallback : Number(value)
  if(!Number.isSafeInteger(n) || n<0) throw new Error('DASH 清单包含无效的时间或编号')
  return n
}
function byteRange(value: string | undefined) {
  if(value===undefined) return undefined
  const match=/^(\d+)-(\d+)$/.exec(value)
  if(!match) throw new Error('DASH 分片字节范围无效')
  const start=integer(match[1],0),end=integer(match[2],0)
  if(end<start) throw new Error('DASH 分片字节范围无效')
  return {start,end}
}
function baseUrl(node: Xml, base: string): string {
  const raw=array(node.BaseURL)[0] as any
  const value=typeof raw==='string' ? raw : raw?.['#text']
  return value ? httpUrl(String(value),base) : base
}
function templateUrl(template: string, rep: Xml, number: number, time: number): string {
  const value=template.replace(/\$\$/g,'\u0000').replace(/\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,(_all,key:string,width:string) => {
    const raw=key==='RepresentationID' ? rep.id : key==='Bandwidth' ? rep.bandwidth : key==='Number' ? number : time
    if(raw===undefined || width && Number(width)>12) throw new Error('DASH URL 模板字段无效')
    return String(raw).padStart(Number(width)||0,'0')
  })
  if(value.includes('$')) throw new Error('DASH URL 模板包含不支持的字段')
  return value.replace(/\u0000/g,'$')
}
/** Static single-period MPDs: SegmentTemplate/Timeline, SegmentList and complete BaseURL media.
 * Timing references: https://dashif.org/Guidelines-TimingModel/ */
export function parseDash(text: string, source: string): DashTrack[] {
  if(/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text)!==true) throw new Error('来源返回的不是有效 DASH MPD')
  const root=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'',removeNSPrefix:true,parseTagValue:false,parseAttributeValue:false}).parse(text).MPD as Xml
  if(!root || root.type==='dynamic') throw new Error('动态 DASH 直播暂不支持下载')
  if(/<(?:\w+:)?ContentProtection\b/i.test(text)) throw new Error('DASH 内容受到保护，不支持 DRM')
  const periods=array(root.Period)
  if(periods.length!==1) throw new Error('DASH 多时段清单暂不支持下载')
  const period=periods[0], seconds=duration(period.duration)||duration(root.mediaPresentationDuration)
  const base=baseUrl(period,baseUrl(root,httpUrl(source)))
  const choices: Array<{track:DashTrack;height:number;bandwidth:number}>=[]
  for(const adaptation of array(period.AdaptationSet)) for(const rep of array(adaptation.Representation)) {
    const mime=String(rep.mimeType||adaptation.mimeType||''),kind=String(rep.contentType||adaptation.contentType||mime.split('/')[0])
    if(kind!=='video' && kind!=='audio') continue
    const repBase=baseUrl(rep,baseUrl(adaptation,base)),segments:DashSegment[]=[]
    const ancestors=[root,period,adaptation,rep]
    const tpl=Object.assign({},...ancestors.map(node=>node.SegmentTemplate||{})) as Xml
    const list=Object.assign({},...ancestors.map(node=>node.SegmentList||{})) as Xml
    let full=false
    if(tpl.media) {
      const scale=integer(tpl.timescale,1),offset=integer(tpl.presentationTimeOffset,0),start=integer(tpl.startNumber,1)
      if(!scale) throw new Error('DASH timescale 必须为正数')
      if(tpl.initialization) segments.push({url:httpUrl(templateUrl(tpl.initialization,rep,start,0),repBase)})
      const timeline=array(tpl.SegmentTimeline?.S)
      let time=0,index=0
      const add=(t:number) => {
        if(index>=50_000) throw new Error('DASH 分片数量超过上限')
        segments.push({url:httpUrl(templateUrl(tpl.media,rep,start+index++,t),repBase)})
      }
      if(timeline.length) for(let i=0;i<timeline.length;i++) {
        const entry=timeline[i],d=integer(entry.d,0); if(!d) throw new Error('DASH 分片时长无效')
        time=integer(entry.t,time)
        let repeat=entry.r===undefined ? 0 : Number(entry.r)
        if(repeat===-1) {
          const end=timeline[i+1]?.t===undefined ? seconds*scale+offset : integer(timeline[i+1].t,0)
          if(end<=time) throw new Error('DASH 无限重复缺少有效终点')
          repeat=Math.ceil((end-time)/d)-1
        }
        if(!Number.isSafeInteger(repeat)||repeat<0||repeat>50_000) throw new Error('DASH 分片重复次数无效')
        for(let r=0;r<=repeat;r++) { add(time);time+=d }
      } else {
        const d=integer(tpl.duration,0)
        if(!d||!seconds) throw new Error('DASH 模板缺少完整时长')
        const count=Math.ceil(seconds*scale/d)
        if(count>50_000) throw new Error('DASH 分片数量超过上限')
        for(let i=0;i<count;i++) add(offset+i*d)
      }
    } else if(list.SegmentURL) {
      if(list.Initialization) segments.push({url:httpUrl(list.Initialization.sourceURL||repBase,repBase),range:byteRange(list.Initialization.range)})
      for(const seg of array(list.SegmentURL)) segments.push({url:httpUrl(seg.media||repBase,repBase),range:byteRange(seg.mediaRange)})
    } else if(rep.BaseURL || adaptation.BaseURL) { segments.push({url:repBase});full=true }
    else throw new Error('DASH 没有可用的媒体分片')
    if(!segments.length||segments.length>50_001) throw new Error('DASH 分片列表无效')
    choices.push({track:{kind,segments,full},height:Number(rep.height||adaptation.height)||0,bandwidth:Number(rep.bandwidth)||0})
  }
  const tracks:DashTrack[]=[]
  for(const kind of ['video','audio'] as const) {
    const candidates=choices.filter(value=>value.track.kind===kind).sort((a,b)=>b.height-a.height||b.bandwidth-a.bandwidth)
    if(candidates[0]) tracks.push(candidates[0].track)
  }
  if(!tracks.length) throw new Error('DASH 清单没有音视频轨道')
  return tracks
}

export async function downloadDash(options: HlsDownloadOptions) {
  return withStreamOutput(options.destination,'dash',options.signal,async (workspace,temporary) => {
    const stopped=new AbortController(),signal=AbortSignal.any([options.signal,stopped.signal]),started=Date.now()
    let receivedBytes=0,lastTick=0,completed=0,totalSegments=0,cachedBytes=0,checkingCache=true,message='正在请求 DASH 播放清单并校验缓存，上次进度暂时保留'
    const receiving=new Map<string,number>()
    const emit=(phase:'downloading'|'finalizing',force=false)=>{
      if(!force && Date.now()-lastTick<300)return;lastTick=Date.now()
      const bytes=receivedBytes+[...receiving.values()].reduce((sum,n)=>sum+n,0)
      try { options.onProgress?.({phase,checkingCache,receivedBytes:bytes,totalBytes:phase==='finalizing'?bytes:0,bytesPerSecond:checkingCache ? 0 : Math.round(Math.max(0,bytes-cachedBytes)*1000/Math.max(1,Date.now()-started)),message}) } catch { /* Observers do not own files. */ }
    }
    emit('downloading',true)
    const manifest=await readDownloadResource({...options,onProgress:undefined,maxBytes:4*1024*1024,onRetry:()=>{message='DASH 清单连接暂时失败，正在重试';emit('downloading',true)}})
    const tracks=parseDash(manifest.data.toString('utf8'),manifest.url)
    fs.mkdirSync(workspace,{recursive:true})
    const identity=createHash('sha256').update(JSON.stringify(tracks)).digest('hex')
    const cache=createFragmentCache(workspace,identity,fragmentShape(tracks))
    const tasks=tracks.flatMap((track,t)=>track.segments.map((segment,s)=>({track,segment,key:t+'-'+s,file:path.join(workspace,t+'-'+s+'.segment')})))
    totalSegments=tasks.length
    const saved=new Set<string>()
    if(cache.message){message=cache.message;emit('downloading',true)}
    for(const task of tasks){
      signal.throwIfAborted()
      let data=cache.exact(task.key,task.file)
      const conditional=!task.track.full && cache.conditional(task.key,task.file,task.segment.url)
      if(!data && conditional){
        const response=await readDownloadResource({...options,url:task.segment.url,range:task.segment.range,signal,onProgress:undefined,conditional})
        data=response.data;cache.save(task.key,task.file,data,response,task.segment.url)
      }
      if(data){saved.add(task.key);receivedBytes+=data.length;completed++}
    }
    cachedBytes=receivedBytes;checkingCache=false;message=`已下载 ${completed}/${totalSegments} 个 DASH 分片`;emit('downloading',true)
    const deferred:typeof tasks=[]
    const processTask=async(task:typeof tasks[number])=>{
      const progress=(bytes:number)=>{const previous=receiving.get(task.key)||0;receiving.set(task.key,bytes);message=`已下载 ${completed}/${totalSegments} 个 DASH 分片，正在接收`;emit('downloading',bytes>0 && previous===0)}
      try {
        if(saved.has(task.key))return
        if(task.track.full){
          fs.rmSync(task.file,{force:true})
          const result=await transferVideo({url:task.segment.url,destination:task.file,referer:options.headers.Referer||options.url,signal,fetch:options.fetch,idleTimeoutMs:options.idleTimeoutMs,onProgress:p=>progress(p.receivedBytes)})
          receivedBytes+=result.receivedBytes
          const data=fs.readFileSync(task.file);cache.save(task.key,task.file,data)
        }else{
          const result=await readDownloadResource({...options,url:task.segment.url,range:task.segment.range,signal,onProgress:progress,onRetry:()=>{message='分片连接中断，正在重试；已完成分片保留';emit('downloading',true)}})
          signal.throwIfAborted();cache.save(task.key,task.file,result.data,result,task.segment.url);receivedBytes+=result.data.length
        }
        completed++
      }finally{receiving.delete(task.key)}
      message=`已下载 ${completed}/${totalSegments} 个 DASH 分片`;emit('downloading')
    }
    let cursor=0,failure:unknown
    await Promise.allSettled(Array.from({length:Math.min(Math.max(1,options.workers??4),8)},async()=>{
      try {
        for(;;) {
          const task=tasks[cursor++];if(!task)return;signal.throwIfAborted()
          try{await processTask(task)}catch(error){if(signal.aborted || !retryableDownloadError(error))throw error;deferred.push(task);message='一条 DASH 连接暂时失败，其他分片继续下载';emit('downloading',true)}
        }
      } catch(error) { if(!stopped.signal.aborted){failure=error;stopped.abort(error)} }
    }))
    if(failure)throw failure;signal.throwIfAborted()
    for(const task of deferred){message=`单连接补齐 DASH 分片；已下载 ${completed}/${totalSegments}`;emit('downloading',true);await processTask(task)}
    message='FFmpeg 正在合并 DASH 音视频，下载字节已接收完毕';emit('finalizing',true)
    const inputs=tracks.map((_track,t)=>{
      const file=path.join(workspace,'track-'+t+'.mp4'),output=fs.openSync(file,'w')
      try { for(const task of tasks.filter(item=>item.key.startsWith(t+'-'))){signal.throwIfAborted();fs.writeSync(output,fs.readFileSync(task.file))} } finally {fs.closeSync(output)}
      return file
    })
    await remuxToMp4(options.ffmpeg,inputs,temporary,signal)
    return {destination:options.destination,receivedBytes,totalBytes:receivedBytes,bytesPerSecond:Math.round(receivedBytes*1000/Math.max(1,Date.now()-started)),warnings:[] as string[]}
  })
}
