import fs from 'node:fs/promises'
import path from 'node:path'
import {Readable} from 'node:stream'
import {createHash,randomUUID} from 'node:crypto'
import type {SqlDb} from '../../services/storage/schema.ts'
import {getVideo,listEpisodes} from './db.ts'
import type {VideoPreviewAsset,VideoPreviewSelection,VideoPreviewSession} from '../../../src/types/video-preview.ts'

interface Options {db:()=>SqlDb;hidden:()=>boolean;blocked:()=>boolean;now?:()=>number}
interface Asset extends VideoPreviewAsset {file:string}
interface Lease {resourceId:string;asset:Asset;db:SqlDb;hidden:boolean;expires:number;size:number;mtime:number;ino:number;streams:Set<Readable>}
const normalized=(file:string)=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file)
const media=/\.(?:mp4|m4v|mkv|webm|mov|avi|ts|mts|m2ts|mpg|mpeg|wmv|flv|ogv)$/i
const mime:Record<string,string>={mp4:'video/mp4',m4v:'video/mp4',webm:'video/webm',ogv:'video/ogg',mov:'video/quicktime',mkv:'video/x-matroska',avi:'video/x-msvideo',mpeg:'video/mpeg',mpg:'video/mpeg',ts:'video/mp2t'}
export function byteRange(value:string|null,size:number):{start:number;end:number}|null|false{
  if(value===null)return null
  const match=/^bytes=(\d*)-(\d*)$/.exec(value)
  if(!match||!size||(!match[1]&&!match[2]))return false
  const first=match[1]?Number(match[1]):0,last=match[2]?Number(match[2]):size-1
  if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last))return false
  if(!match[1])return last>0?{start:Math.max(0,size-last),end:size-1}:false
  if(first>=size||last<first)return false
  return {start:first,end:Math.min(last,size-1)}
}
async function statFile(file:string){
  const stat=await fs.lstat(file)
  if(!stat.isFile()||stat.isSymbolicLink()||normalized(await fs.realpath(file))!==normalized(file))throw new Error('文件是链接或不是可读取的视频文件')
  return stat
}
export class VideoPreviewService {
  private options:Options
  private leases=new Map<string,Lease>()
  constructor(options:Options){this.options=options}
  private now(){return this.options.now?.()??Date.now()}
  private item(id:string){
    if(this.options.blocked())throw new Error('资料库正在恢复，请稍后试看')
    const item=getVideo(this.options.db(),id)
    if(!item||item.media_kind!=='video'||this.options.hidden()&&item.category==='里番')throw new Error('此视频在当前范围不可用')
    return item
  }
  private assets(id:string):Asset[]{
    const item=this.item(id),db=this.options.db(),episodes=listEpisodes(db,id)
    const rows=db.prepare(`SELECT a.*,ea.episode_id FROM video_assets a LEFT JOIN video_episode_assets ea ON ea.asset_id=a.id WHERE a.resource_id=? AND a.role='video' ORDER BY a.created_at,a.id`).all(id) as any[]
    const result:Asset[]=[],seen=new Set<string>()
    const add=(file:string,episodeId='',quality='',key='')=>{
      if(!file||!media.test(file))return
      if(!key&&!episodeId&&result.some(asset=>normalized(asset.file)===normalized(file)))return
      const identity=normalized(file)+'|'+episodeId;if(seen.has(identity))return;seen.add(identity)
      const episode=episodes.find(episode=>episode.id===episodeId)
      if(episodeId&&!episode)return
      result.push({key:key||'legacy-'+createHash('sha256').update(identity).digest('hex').slice(0,24),file,name:path.basename(file),episodeId,label:episode?.title||episode?.display_label||(episode?`第 ${episode.episode} 集`:''),quality,duration:episode?.duration_sec||item.duration_sec||0,format:path.extname(file).slice(1).toLowerCase()})
    }
    for(const row of rows)add(row.path,row.episode_id||'',row.quality,row.id)
    for(const episode of episodes)add(episode.path,episode.id)
    if(item.video_type==='movie'){for(const part of item.parts)add(part.path);add(item.path)}
    return result
  }
  async choices(id:string,episodeId=''):Promise<VideoPreviewSelection>{
    const item=this.item(id),candidates=this.assets(id).filter(asset=>!episodeId||asset.episodeId===episodeId),assets:VideoPreviewAsset[]=[]
    for(const asset of candidates){try{await statFile(asset.file);const {file,...value}=asset;assets.push(value)}catch{/* Offline assets remain in the normal library; they cannot issue a preview lease. */}}
    this.item(id);return {resourceId:id,title:item.name_zh||item.name_en||item.file_name,assets}
  }
  async open(id:string,key:string):Promise<VideoPreviewSession>{
    for(const [token,lease]of this.leases)if(lease.expires<this.now())this.release(token)
    const item=this.item(id),db=this.options.db(),hidden=this.options.hidden(),asset=this.assets(id).find(asset=>asset.key===key)
    if(!asset)throw new Error('所选视频副本已变化，请重新选择')
    const stat=await statFile(asset.file);this.item(id)
    if(db!==this.options.db()||hidden!==this.options.hidden())throw new Error('资料库或隐私范围已变化')
    const token=randomUUID();this.leases.set(token,{resourceId:id,asset,db,hidden,expires:this.now()+15*60000,size:stat.size,mtime:stat.mtimeMs,ino:stat.ino,streams:new Set()})
    const {file,...value}=asset;return {token,url:'baoyi://video/'+token,title:item.name_zh||item.name_en||item.file_name,asset:value}
  }
  private lease(token:string){
    const lease=this.leases.get(token)
    if(!lease)throw new Error('试看已关闭，请重新打开')
    try{
      this.item(lease.resourceId)
      if(lease.db!==this.options.db()||lease.hidden!==this.options.hidden()||lease.expires<this.now()||!this.assets(lease.resourceId).some(asset=>asset.key===lease.asset.key&&normalized(asset.file)===normalized(lease.asset.file)))throw new Error('来源或范围已变化，请重新打开试看')
    }catch(error){this.release(token);throw error}
    lease.expires=this.now()+15*60000;return lease
  }
  async file(token:string){const lease=this.lease(token),stat=await statFile(lease.asset.file);this.lease(token);if(stat.size!==lease.size||stat.mtimeMs!==lease.mtime||stat.ino!==lease.ino){this.release(token);throw new Error('视频文件正在变化，请稍后重试')}return lease.asset.file}
  release(token:string){const lease=this.leases.get(token);if(!lease)return;this.leases.delete(token);for(const stream of lease.streams)stream.destroy();lease.streams.clear()}
  close(){for(const token of [...this.leases.keys()])this.release(token)}
  async response(request:Request):Promise<Response>{
    if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}})
    let handle:Awaited<ReturnType<typeof fs.open>>|undefined
    try{
      const url=new URL(request.url),token=url.pathname.slice(1),lease=this.lease(token)
      if(url.hostname!=='video'||url.search||token.includes('/'))return new Response(null,{status:404})
      const file=await this.file(token);request.signal.throwIfAborted();handle=await fs.open(file,'r')
      const stat=await handle.stat();this.lease(token)
      if(!stat.isFile()||stat.size!==lease.size||stat.mtimeMs!==lease.mtime||stat.ino!==lease.ino){this.release(token);throw new Error('文件已变化')}
      const size=stat.size,range=byteRange(request.headers.get('range'),size),headers:Record<string,string>={'Content-Type':mime[lease.asset.format]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
      if(range===false){await handle.close();handle=undefined;return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${size}`}})}
      const start=range?.start??0,end=range?.end??size-1;headers['Content-Length']=String(size?end-start+1:0)
      if(range)headers['Content-Range']=`bytes ${start}-${end}/${size}`
      if(request.method==='HEAD'||!size){await handle.close();handle=undefined;return new Response(null,{status:range?206:200,headers})}
      request.signal.throwIfAborted()
      const stream=handle.createReadStream({start,end,autoClose:true,highWaterMark:256*1024});handle=undefined;lease.streams.add(stream)
      const abort=()=>stream.destroy();request.signal.addEventListener('abort',abort,{once:true})
      stream.once('close',()=>{request.signal.removeEventListener('abort',abort);lease.streams.delete(stream)})
      return new Response(Readable.toWeb(stream) as ReadableStream,{status:range?206:200,headers})
    }catch(error){await handle?.close().catch(() => { /* best-effort */ });return new Response(null,{status:(error as NodeJS.ErrnoException).code==='EACCES'?403:404})}
  }
}
