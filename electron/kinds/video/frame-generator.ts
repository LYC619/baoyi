import fs from 'node:fs/promises'
import path from 'node:path'
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {Worker} from 'node:worker_threads'
import {createHash} from 'node:crypto'
import type {ContainerInfo} from './mediainfo.ts'
const exec=promisify(execFile)
let capability:{key:string;at:number;value:Promise<string|null>}|undefined
export function frameFfmpeg(configured:string,roots:string[]=[]){
  const key=JSON.stringify([configured,roots]);if(capability?.key===key&&Date.now()-capability.at<60000)return capability.value
  const value=(async()=>{
    const candidates:string[]=[]
    if(configured.trim())candidates.push(configured.trim())
    else{
      try{const {stdout}=await exec(process.platform==='win32'?'where.exe':'which',['ffmpeg'],{windowsHide:true,timeout:3000,maxBuffer:65536});candidates.push(...stdout.trim().split(/\r?\n/))}catch{ /* PATH 中未找到 FFmpeg 时继续检查已有候选位置。 */ }
      const dirs=[process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'ffmpeg','bin'):'','C:/ffmpeg/bin','C:/Program Files/ffmpeg/bin',process.env.USERPROFILE?path.join(process.env.USERPROFILE,'scoop/apps/ffmpeg/current/bin'):'','/usr/bin','/usr/local/bin']
      for(const dir of dirs.filter(Boolean))candidates.push(path.join(dir,process.platform==='win32'?'ffmpeg.exe':'ffmpeg'))
    }
    const check=async(file:string)=>{try{if(!(await fs.stat(file)).isFile())return false;return /^ffmpeg version /m.test((await exec(file,['-version'],{windowsHide:true,timeout:4000,maxBuffer:131072})).stdout)}catch{return false}}
    for(const file of candidates)if(await check(file))return file
    if(configured)return null
    const queue=roots.map(file=>({file,depth:0}));let visited=0
    while(queue.length&&visited++<1200){const current=queue.shift()!;try{for(const entry of await fs.readdir(current.file,{withFileTypes:true})){const file=path.join(current.file,entry.name);if(entry.isFile()&&/^ffmpeg(?:\.exe)?$/i.test(entry.name)&&await check(file))return file;if(entry.isDirectory()&&current.depth<4&&!/^(node_modules|\.git|cache|data)$/i.test(entry.name))queue.push({file,depth:current.depth+1})}}catch{ /* 无法读取的候选目录不提供 FFmpeg 路径。 */ }}
    return null
  })();capability={key,at:Date.now(),value};return value
}
export async function frameFingerprint(file:string){
  const handle=await fs.open(file,'r')
  try{
    const stat=await handle.stat();if(!stat.isFile()||!stat.size)throw new Error('视频为空或不是实际文件')
    const digest=createHash('sha256').update(JSON.stringify([path.resolve(file),stat.dev,stat.ino,stat.size,stat.mtimeMs,'frames-v1']))
    for(const offset of [0,Math.max(0,stat.size-65536)]){const buffer=Buffer.alloc(Math.min(65536,stat.size));const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);digest.update(buffer.subarray(0,bytesRead))}
    const after=await handle.stat();if(stat.size!==after.size||stat.mtimeMs!==after.mtimeMs)throw new Error('文件正在变化，暂不生成预览')
    return {hash:digest.digest('hex'),size:stat.size,mtime:stat.mtimeMs,ino:stat.ino}
  }finally{await handle.close()}
}
function worker<T>(data:unknown,signal:AbortSignal,timeout=15000):Promise<T>{
  signal.throwIfAborted()
  return new Promise((resolve,reject)=>{
    const filename=import.meta.url.endsWith('.ts')?'./frame-worker.ts':'./video-frame-worker.js'
    const task=new Worker(new URL(filename,import.meta.url),{workerData:data,resourceLimits:{maxOldGenerationSizeMb:128}})
    let finished=false
    const finish=(error?:Error,value?:T)=>{if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);void task.terminate().then(()=>error?reject(error):resolve(value!),reject)}
    const cancel=()=>finish(signal.reason instanceof Error?signal.reason:new Error('预览已取消'))
    const timer=setTimeout(()=>finish(new Error('预览信息或图片处理超时')),timeout)
    signal.addEventListener('abort',cancel,{once:true});task.on('message',message=>finish(message.error?new Error(message.error):undefined,message.value));task.on('error',error=>finish(error));task.on('exit',code=>{if(!finished)finish(new Error(`预览处理进程退出（${code}）`))})
    if(signal.aborted)cancel()
  })
}
export function frameSampleTimes(duration:number){const count=Math.max(8,Math.min(24,Math.ceil(duration/30)));return [...new Set(Array.from({length:count},(_,index)=>Math.round((index+.5)*duration/count*1000)/1000))]}
function capture(ffmpeg:string,file:string,seconds:number,output:string,signal:AbortSignal){
  signal.throwIfAborted()
  return new Promise<void>((resolve,reject)=>{
    const child=spawn(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-ss',String(seconds),'-threads','2','-protocol_whitelist','file,crypto,data','-i',file,'-frames:v','1','-an','-sn','-dn','-filter_threads','2','-vf','scale=320:180:force_original_aspect_ratio=decrease:force_divisible_by=2','-pix_fmt','yuvj420p','-threads','2','-q:v','4',output],{windowsHide:true,stdio:['ignore','ignore','pipe']})
    let error='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill()},8000),abort=()=>child.kill()
    child.stderr?.on('data',chunk=>error=(error+String(chunk)).slice(-1800));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort)}
    child.on('error',error=>{cleanup();reject(error)});child.on('close',code=>{cleanup();signal.aborted?reject(signal.reason):timedOut?reject(new Error('单帧解码超过 8 秒')):code===0?resolve():reject(new Error('无法提取当前视频画面：'+error.trim()))})
  })
}
export interface FrameGenerated {times:number[];duration:number;bytes:number;partial:boolean;audioTracks:number|null;videoCodec:string;message:string}
export interface FrameInput {file:string;directory:string;ffmpeg:string;duration:number;signal:AbortSignal;progress?:(value:number)=>void;preview?:(value:FrameGenerated)=>Promise<void>}
export function generateFrames(input:FrameInput):Promise<FrameGenerated>{
  input.signal.throwIfAborted()
  return new Promise((resolve,reject)=>{
    const filename=import.meta.url.endsWith('.ts')?'./frame-generation-worker.ts':'./video-frame-generation-worker.js'
    const task=new Worker(new URL(filename,import.meta.url),{workerData:{file:input.file,directory:input.directory,ffmpeg:input.ffmpeg,duration:input.duration},resourceLimits:{maxOldGenerationSizeMb:128}})
    let finished=false,grace:ReturnType<typeof setTimeout>|undefined
    const finish=(error?:Error,value?:FrameGenerated)=>{if(finished)return;finished=true;clearTimeout(grace);clearTimeout(timeout);input.signal.removeEventListener('abort',cancel);void task.terminate().then(()=>error?reject(error):resolve(value!),reject)}
    // Windows CreateProcess can block its calling thread. Keep the entire
    // FFmpeg loop off Electron's main thread, including process startup.
    const cancel=()=>{task.postMessage({event:'cancel'});grace??=setTimeout(()=>finish(new Error('预览已取消')),10000)}
    const timeout=setTimeout(cancel,100000)
    input.signal.addEventListener('abort',cancel,{once:true})
    task.on('message',message=>{
      if(message.event==='progress')input.progress?.(message.value)
      else if(message.event==='preview')void Promise.resolve().then(()=>input.preview?.(message.value)).then(()=>{if(!finished)task.postMessage({event:'previewAck'})},error=>{if(!finished)task.postMessage({event:'previewAck',error:(error as Error).message})})
      else finish(message.error?new Error(message.error):input.signal.aborted?new Error('预览已取消'):undefined,message.value)
    })
    task.on('error',error=>finish(error));task.on('exit',code=>{if(!finished)finish(new Error('预览处理退出（'+code+'）'))})
    if(input.signal.aborted)cancel()
  })
}
export async function generateFramesInline(input:FrameInput):Promise<FrameGenerated>{
  const began=Date.now(),deadline=new AbortController(),timeout=setTimeout(()=>deadline.abort(new Error('预览达到 90 秒处理预算')),90000),signal=AbortSignal.any([input.signal,deadline.signal])
  let info:ContainerInfo|null=null
  const frames:Array<{time:number;file:string}>=[]
  try{
    await fs.mkdir(input.directory,{recursive:true})
    info=await worker<ContainerInfo|null>({kind:'info',file:input.file},signal)
    const duration=info?.duration_sec||input.duration;if(!Number.isFinite(duration)||duration<=0)throw new Error('无法确定视频时长，仍可使用试看或系统播放器')
    const times=frameSampleTimes(duration),first=[...new Set(Array.from({length:Math.min(8,times.length)},(_,i)=>Math.round(i*(times.length-1)/7)))],order=[...first,...times.map((_,i)=>i).filter(i=>!first.includes(i))]
    let message=''
    for(const index of order){
      if(Date.now()-began>78000){message='已达到本次处理预算';break}
      const output=path.join(input.directory,`frame-${index}.jpg`)
      try{await capture(input.ffmpeg,input.file,times[index],output,signal);const stat=await fs.stat(output).catch(error=>{if(error.code!=='ENOENT')throw error;return null});if(!stat?.size)throw new Error('此时间点没有可用画面，已保留前面生成的代表帧');frames.push({time:times[index],file:output});input.progress?.(frames.length)
        if(frames.length===8&&times.length>8&&input.preview){
          const ordered=[...frames].sort((a,b)=>a.time-b.time)
          const preview=await worker<{bytes:number}>({kind:'sprite',frames:ordered.map(frame=>frame.file),output:path.join(input.directory,'preview.jpg')},signal)
          await input.preview({times:ordered.map(frame=>frame.time),duration,bytes:preview.bytes,partial:true,audioTracks:info?info.audio_tracks.length:null,videoCodec:info?.video_codec||'',message:'正在补齐代表帧'})
        }
      }
      catch(error){input.signal.throwIfAborted();message=(error as Error).message;break}
    }
    if(!frames.length)throw new Error(message||'没有可用预览帧')
    frames.sort((a,b)=>a.time-b.time)
    const image=await worker<{bytes:number}>({kind:'sprite',frames:frames.map(frame=>frame.file),output:path.join(input.directory,'sprite.jpg')},signal,Math.max(1,90000-(Date.now()-began)))
    await Promise.all(frames.map(frame=>fs.unlink(frame.file)))
    const result={times:frames.map(frame=>frame.time),duration,bytes:image.bytes,partial:frames.length<times.length,audioTracks:info?info.audio_tracks.length:null,videoCodec:info?.video_codec||'',message}
    await fs.writeFile(path.join(input.directory,'index.json'),JSON.stringify(result));return result
  }finally{clearTimeout(timeout)}
}
