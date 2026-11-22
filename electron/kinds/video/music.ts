import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import type {MusicJob,MusicSource,MusicTrack} from '../../../src/types/music.ts'
import {safeDownloadError,createDownloadTimeout,abortable} from './download/transfer.ts'

const API='https://music-api.gdstudio.xyz/api.php'
const sources=new Set(['netease','tencent','kuwo','joox','bilibili'])
function text(value:unknown,max=300){return typeof value==='string'?value.slice(0,max):''}
export function musicUrl(raw:string){const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname.includes('.')||/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)||url.hostname.includes(':'))throw new Error('音乐来源返回无效地址');return url.href}
const name=(value:string)=>value.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,65).replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i,'_$1')||'未命名曲目'
export function audioExtension(head:Buffer){if(head.subarray(0,4).toString()==='fLaC')return 'flac';if(head.subarray(0,3).toString()==='ID3'||head.length>2&&head[0]===255&&(head[1]&224)===224)return 'mp3';if(head.subarray(0,4).toString()==='RIFF'&&head.subarray(8,12).toString()==='WAVE')return 'wav';if(head.subarray(4,8).toString()==='ftyp')return 'm4a';if(head.subarray(0,4).toString()==='OggS')return 'ogg';throw new Error('来源未返回可识别的音频文件')}
export function createMusicService(deps:{fetch:typeof fetch;stateFile:string;root:()=>string;ready:()=>boolean;register:(track:MusicTrack,file:string,cover:string,lyric:string)=>string;registered?:(id:string)=>boolean;changed:(jobs:MusicJob[])=>void}){
  const tracks=new Map<string,MusicTrack>(),controllers=new Map<string,AbortController>(),previews=new Map<string,{url:string;expires:number}>()
  let jobs:MusicJob[]=[]
  const running=new Set<Promise<void>>()
  try{const saved=JSON.parse(fs.readFileSync(deps.stateFile,'utf8'));if(Array.isArray(saved))jobs=saved.filter(j=>j?.id&&sources.has(j.track?.source)&&typeof j.directory==='string').slice(0,50).map(j=>({...j,status:j.status==='running'?'interrupted':j.status,message:j.status==='running'?'应用已中断，可重试':j.message}))}catch{ /* 任务文件缺失或无法解析时不恢复队列。 */ }
  const list=()=>{for(const job of jobs)if(job.status==='completed'&&(!job.file||!fs.existsSync(job.file)||deps.registered&&!deps.registered(job.resourceId||''))){job.status='interrupted';job.message='已下载的文件或入库记录已移除，可重新下载'}return structuredClone(jobs)}
  const emit=(save=false)=>{if(save){fs.mkdirSync(path.dirname(deps.stateFile),{recursive:true});fs.writeFileSync(deps.stateFile+'.tmp',JSON.stringify(jobs));fs.renameSync(deps.stateFile+'.tmp',deps.stateFile)}deps.changed(list())}
  async function request(params:Record<string,string>,signal?:AbortSignal){
    const response=await deps.fetch(API+'?'+new URLSearchParams(params),{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)})
    if(!response.ok){await response.body?.cancel().catch(() => { /* best-effort */ });throw new Error(response.status===400?'当前接口暂未开放此来源或参数，请换平台重试':response.status===429?'音乐来源访问频率受限，请稍后重试':'音乐接口暂不可用（'+response.status+'）')}
    const reader=response.body?.getReader();if(!reader)throw new Error('音乐接口返回为空');const chunks:Uint8Array[]=[];let size=0
    try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>2*1024*1024)throw new Error('音乐接口返回过大');chunks.push(item.value)}}finally{await reader.cancel().catch(() => { /* best-effort */ })}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new Error('音乐接口返回格式异常，请稍后重试')}
  }
  async function search(source:MusicSource,query:string,page=1){
    if(!sources.has(source)||typeof query!=='string'||!query.trim()||query.length>160||!Number.isInteger(page)||page<1||page>100)throw new Error('搜索条件无效')
    const raw=await request({types:'search',source,name:query.trim(),count:'20',pages:String(page)})
    if(!Array.isArray(raw))throw new Error('该平台暂时无法搜索，请换平台或稍后重试')
    const rows:MusicTrack[]=raw.slice(0,20).filter(r=>r&&r.id&&r.name).map(r=>({key:source+':'+String(r.id),source,id:String(r.id).slice(0,200),title:text(r.name),artists:Array.isArray(r.artist)?r.artist.map((v:unknown)=>text(v,100)).slice(0,20):[],album:text(r.album),picId:String(r.pic_id||r.id).slice(0,300),urlId:String(r.url_id||r.id).slice(0,300),lyricId:String(r.lyric_id||r.id).slice(0,300)}))
    for(const row of rows)tracks.set(row.key,row);while(tracks.size>400)tracks.delete(tracks.keys().next().value!)
    return rows
  }
  async function resolve(track:MusicTrack,signal?:AbortSignal){for(const br of ['999','740','320']){const value=await request({types:'url',source:track.source,id:track.urlId,br},signal);if(value?.url&&Number(value.br)!==-1&&Number(value.size)!==0)return {url:musicUrl(value.url),br:Number(value.br)||0}}throw new Error('该曲目暂时没有可用音频，请换来源或稍后重试')}
  const get=(key:string)=>{const track=tracks.get(key);if(!track)throw new Error('搜索结果已过期，请重新搜索');return track}
  async function preview(key:string){const track=get(key),value=await resolve(track),token=randomUUID();previews.set(token,{url:value.url,expires:Date.now()+3600000});while(previews.size>20)previews.delete(previews.keys().next().value!);return {key,title:track.title,artist:track.artists.join(' / '),album:track.album,url:'baoyi://online-music/'+token}}
  async function response(request:Request){const token=new URL(request.url).pathname.slice(1),item=previews.get(token);if(!item||item.expires<Date.now())return new Response('试听已过期，请重新点击试听',{status:404});const range=request.headers.get('range');if(range&&!/^bytes=\d*-\d*$/.test(range))return new Response(null,{status:416});try{const remote=await deps.fetch(item.url,{signal:request.signal,headers:{...(range?{Range:range}:{}),Referer:'https://music.gdstudio.xyz/'}});return new Response(remote.body,{status:remote.status,headers:remote.headers})}catch{return new Response('试听连接失败',{status:502})}}
  async function smallFile(url:string,file:string,signal:AbortSignal){const response=await deps.fetch(musicUrl(url),{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});if(!response.ok)throw new Error('封面获取失败');const reader=response.body?.getReader();if(!reader)throw new Error('封面为空');const chunks:Uint8Array[]=[];let size=0;try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>10*1024*1024)throw new Error('封面过大');chunks.push(item.value)}}finally{await reader.cancel().catch(() => { /* best-effort */ })}const buffer=Buffer.concat(chunks);if(!(buffer[0]===255&&buffer[1]===216)&&buffer.subarray(1,4).toString()!=='PNG'&&buffer.subarray(8,12).toString()!=='WEBP')throw new Error('封面内容无效');await fsp.writeFile(file,buffer,{flag:'wx'})}
  async function run(job:MusicJob,controller:AbortController){
    const signal=controller.signal,temp=path.join(job.directory,'audio.part');let file='',cover='',lyric=''
    try{
      await fsp.mkdir(job.directory,{recursive:true});const value=await resolve(job.track,signal)
      const watchdog=createDownloadTimeout(30000,'音频连接长时间无进展，请重试'),downloadSignal=AbortSignal.any([signal,watchdog.controller.signal]);let handle:Awaited<ReturnType<typeof fsp.open>>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined
      try{watchdog.tick();const response=await deps.fetch(value.url,{signal:downloadSignal,headers:{Referer:'https://music.gdstudio.xyz/'}});if(response.status!==200||!response.body)throw new Error('音频下载失败（'+response.status+'）');job.total=Number(response.headers.get('content-length'))||0;if(job.total>1024**3)throw new Error('音频超过 1 GiB');handle=await fsp.open(temp,'wx');reader=response.body.getReader();let last=0
        for(;;){const item=await abortable(reader.read(),downloadSignal);if(item.done)break;watchdog.tick();job.received+=item.value.length;if(job.received>1024**3)throw new Error('音频超过 1 GiB');let offset=0;while(offset<item.value.length){const written=await handle.write(item.value,offset,item.value.length-offset);if(!written.bytesWritten)throw new Error('音频写入失败');offset+=written.bytesWritten}if(Date.now()-last>250){last=Date.now();job.message='正在下载音频';emit()}}
        if(!job.received||job.total&&job.total!==job.received)throw new Error('音频长度不完整，请重试');await handle.sync()
      }finally{watchdog.close();await reader?.cancel().catch(() => { /* best-effort */ });await handle?.close()}
      signal.throwIfAborted();const head=Buffer.alloc(32),read=await fsp.open(temp,'r');try{await read.read(head,0,32,0)}finally{await read.close()}
      file=path.join(job.directory,name(job.track.title)+'.'+audioExtension(head));await fsp.link(temp,file);await fsp.unlink(temp)
      const warnings:string[]=[]
      try{const value=await request({types:'pic',source:job.track.source,id:job.track.picId,size:'500'},signal);if(value?.url){const target=path.join(job.directory,'cover.jpg');await smallFile(value.url,target,signal);cover=target}else warnings.push('来源未提供封面')}catch(error){warnings.push(safeDownloadError(error))}
      try{const value=await request({types:'lyric',source:job.track.source,id:job.track.lyricId},signal);if(value?.lyric){lyric=path.join(job.directory,name(job.track.title)+'.lrc');await fsp.writeFile(lyric,String(value.lyric),{flag:'wx'})}else warnings.push('来源未提供歌词')}catch(error){warnings.push(safeDownloadError(error))}
      signal.throwIfAborted();if(!deps.ready())throw new Error('资料库正在恢复，请稍后重试入库')
      job.file=file;job.resourceId=deps.register(job.track,file,cover,lyric);job.status='completed';job.message='已下载并加入我的音频'+(warnings.length?'；'+warnings.join('；'):'')
    }catch(error){job.status=signal.aborted?'cancelled':'failed';job.message=safeDownloadError(error);await fsp.rm(temp,{force:true}).catch(() => { /* best-effort */ });if(file)job.message+='；已下载文件保留在 '+job.directory}
    finally{controllers.delete(job.id);emit(true)}
  }
  function download(key:string){list();if(!deps.ready())throw new Error('资料库正在恢复');const track=get(key),existing=jobs.find(j=>j.track.key===key&&['running','completed'].includes(j.status));if(existing)return structuredClone(existing);if(controllers.size>=2)throw new Error('最多同时下载两首，请稍后再试');const root=deps.root();if(!path.isAbsolute(root))throw new Error('请先选择音频保存目录');const id=randomUUID(),job:MusicJob={id,track,status:'running',received:0,total:0,message:'正在获取高质量音源',directory:path.join(root,name(track.artists.join('、')+' - '+track.title)+'-'+id.slice(0,8))};jobs=[job,...jobs.filter(j=>j.status==='running').concat(jobs.filter(j=>j.status!=='running').slice(0,48))];const controller=new AbortController();controllers.set(id,controller);try{emit(true)}catch(error){controllers.delete(id);jobs=jobs.filter(j=>j.id!==id);throw error}
    const task=run(job,controller);running.add(task)
    void task.catch(error=>console.error('[音乐下载]',error)).finally(()=>running.delete(task))
    return structuredClone(job)
  }
  async function stop(){for(const controller of controllers.values())controller.abort(new Error('下载已停止'));await Promise.all(running)}
  return {search,preview,response,download,list,stop,busy:()=>controllers.size>0,cancel(id:string){controllers.get(id)?.abort(new Error('下载已停止'))},retry(id:string){const job=jobs.find(j=>j.id===id);if(!job)throw new Error('任务不存在');tracks.set(job.track.key,job.track);return download(job.track.key)}}
}
