/** Protocol constants and endpoint shapes verified against lanyeeee/picacomic-downloader (MIT).
 * See docs/third-party/picacomic-downloader.txt. Passwords and tokens never enter error messages.
 */
import { createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ImageSourceChapter, ImageSourcePage, ImageSourceWork, ImageSourceRank, ImageSourceSort, ImageTransferEvent } from '../../../src/types/image.ts'
import { MAX_IMAGE_BYTES } from './archive.ts'
import { imageMime } from './files.ts'
import type { ImageRequestGate } from './request-gate.ts'

const HOST='https://picaapi.picacomic.com/'
const API_KEY='C69BAF41DA5ABD1FFEDC6D2FEA56B'
const NONCE='ptxdhmjzqtnrtwndhbxcpkjamb33w837'
const DIGEST_KEY='~d}$Q7$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn'
type Dependencies={fetch:(url:string,init?:RequestInit)=>Promise<Response>;token:()=>string;wait?:(ms:number,signal?:AbortSignal)=>Promise<void>}
type Row=Record<string,any>
type Observer=(event:ImageTransferEvent)=>void
const id=(value:unknown)=>{if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(value))throw new Error('来源返回了无效标识');return value}
function imageAddress(value:string):URL {
  let url:URL
  try{url=new URL(value)}catch{throw new Error('来源图片地址无效')}
  const host=url.hostname.toLowerCase().replace(/\.$/,'')
  if(url.protocol!=='https:'||url.username||url.password||!host.includes('.')||/^[\d.]+$/.test(host)||host.includes(':')||host.endsWith('.local')||host.endsWith('.localhost'))throw new Error('来源图片服务器不受支持')
  return url
}
class ImageNetworkError extends Error {
  retryAfter:number
  limited:boolean
  constructor(message:string,retryAfter=500,limited=false){super(message);this.retryAfter=retryAfter;this.limited=limited}
}
function retryAfterMs(response:Response,fallback=500):number {
  const value=response.headers.get('retry-after')?.trim()
  const parsed=!value?NaN:/^\d+(\.\d+)?$/.test(value)?Number(value)*1000:Date.parse(value)-Date.now()
  const ms=Number.isFinite(parsed)?Math.max(500,parsed):fallback
  if(ms>2147483647)throw new Error('服务器要求等待时间过长，请稍后重试')
  return Math.ceil(ms)
}
const retryDelay=(minimum:number,attempt:number)=>Math.max(minimum,Math.min(10000,minimum*2**attempt))
function work(row:Row):ImageSourceWork {
  if(!row||typeof row.title!=='string')throw new Error('来源作品资料格式已变化')
  return {id:id(row._id),title:row.title.slice(0,300),author:String(row.author||'').slice(0,300),description:String(row.description||'').slice(0,50000),
    tags:[...(Array.isArray(row.tags)?row.tags:[]),...(Array.isArray(row.categories)?row.categories:[])].filter(t=>typeof t==='string').slice(0,50),
    chapters:Number(row.epsCount)||0,pages:Number(row.pagesCount)||0,finished:row.finished===true,coverUrl:coverUrl(row.thumb)}
}
function coverUrl(media:Row|undefined):string {
  try{
    if(!media||typeof media.fileServer!=='string'||typeof media.path!=='string')return ''
    const server=imageAddress(media.fileServer),segments=media.path.split('/')
    if(segments.some(s=>!s||s==='.'||s==='..'||s.includes('\\')))return ''
    return new URL('/static/'+segments.map(encodeURIComponent).join('/'),server).href
  }catch{return ''}
}
export async function boundedBody(response:Response,max:number,onBytes?:(bytes:number)=>void):Promise<Buffer>{
  if(Number(response.headers.get('content-length'))>max)throw new Error('来源响应超过大小限制')
  const reader=response.body?.getReader();if(!reader)throw new Error('来源响应为空')
  const chunks:Uint8Array[]=[];let total=0
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;onBytes?.(value.length);if(total>max)throw new Error('来源响应超过大小限制');chunks.push(value)}return Buffer.concat(chunks)}finally{await reader.cancel().catch(()=>{})}
}
export class PicacomicSource {
  private deps:Dependencies
  private covers=new Set<string>()
  constructor(deps:Dependencies){this.deps=deps}
  private mapWork=(row:Row):ImageSourceWork=>{
    const result=work(row)
    if(result.coverUrl){this.covers.add(result.coverUrl);if(this.covers.size>2000)this.covers.delete(this.covers.values().next().value!)}
    return result
  }
  private listing(data:Row):{items:ImageSourceWork[];pages:number}{
    if(!Array.isArray(data.comics?.docs)||!Number.isInteger(Number(data.comics.pages))||Number(data.comics.pages)<0)throw new Error('来源分页格式已变化')
    return {items:data.comics.docs.map(this.mapWork),pages:Math.min(1000,Number(data.comics.pages))}
  }
  async favorites(page=1,sort:ImageSourceSort='dd'):Promise<{items:ImageSourceWork[];pages:number}>{
    if(!Number.isInteger(page)||page<1||page>1000)throw new Error('收藏页码无效')
    if(!['dd','da'].includes(sort))throw new Error('收藏排序无效')
    return this.listing(await this.request(`users/favourite?s=${sort}&page=${page}`))
  }
  async ranking(period:ImageSourceRank='H24'):Promise<{items:ImageSourceWork[];pages:number}>{
    if(!['H24','D7','D30'].includes(period))throw new Error('排行榜周期无效')
    const data=await this.request(`comics/leaderboard?tt=${period}&ct=VC`)
    if(!Array.isArray(data.comics))throw new Error('排行榜响应格式已变化')
    return {items:data.comics.map(this.mapWork),pages:data.comics.length?1:0}
  }
  async cover(url:string):Promise<string>{
    if(!this.covers.has(url))throw new Error('封面地址未由来源确认，请刷新列表')
    const data=await this.imageData(url,5*1024**2,15000)
    return `data:${imageMime(data)};base64,${data.toString('base64')}`
  }
  private async imageData(url:string,max:number,timeout:number,signal?:AbortSignal,observe?:Observer,gate?:ImageRequestGate):Promise<Buffer>{
    for(let attempt=0;attempt<4;attempt++){
      if(signal?.aborted)throw new Error('下载已取消')
      const request=async()=>{
        const timed=AbortSignal.timeout(timeout),requestSignal=signal?AbortSignal.any([signal,timed]):timed
        try{return await this.followImage(url,max,requestSignal,observe)}
        catch(cause){
          // Set shared backoff before the permit is released to another waiting attempt.
          if(cause instanceof ImageNetworkError&&cause.limited)gate?.defer(retryDelay(cause.retryAfter,attempt))
          throw cause
        }
      }
      try{return await (gate?gate.run(request,signal):request())}
      catch(cause){
        if(signal?.aborted)throw new Error('下载已取消')
        if(!(cause instanceof ImageNetworkError)||attempt===3)throw cause
        const ms=retryDelay(cause.retryAfter,attempt)
        observe?.({phase:cause.limited?'rate-limited':'retrying',waitMs:ms})
        try{if(this.deps.wait)await this.deps.wait(ms,signal);else await delay(ms,undefined,{signal})}
        catch{if(signal?.aborted)throw new Error('下载已取消');throw cause}
      }
    }
    throw new Error('图片下载失败，请重试缺失页')
  }
  private async followImage(url:string,max:number,signal:AbortSignal,observe?:Observer):Promise<Buffer>{
    let current=imageAddress(url).href
    const visited=new Set([current])
    for(let hop=0;hop<=5;hop++){
      let response:Response
      observe?.({phase:'connecting'})
      try{response=await this.deps.fetch(current,{redirect:'manual',credentials:'omit',signal})}
      catch(cause){
        const code=String((cause as Error)?.message).match(/\bnet::(ERR_[A-Z0-9_]+)\b/)?.[1]
        throw new ImageNetworkError(signal.aborted?'图片请求超时，请检查网络或系统代理':`图片连接失败${code?'（'+code+'）':''}，请检查网络或系统代理`)
      }
      // Pica storage redirects to its image CDN; validate every hop before requesting it.
      if([301,302,303,307,308].includes(response.status)){
        await response.body?.cancel().catch(()=>{})
        const location=response.headers.get('location')
        if(!location||hop===5)throw new Error('图片跳转异常或次数过多')
        let next:string
        try{next=new URL(location,current).href}catch{throw new Error('来源图片跳转地址无效')}
        current=imageAddress(next).href
        if(visited.has(current))throw new Error('图片跳转出现循环')
        visited.add(current)
        continue
      }
      if(!response.ok){
        await response.body?.cancel().catch(()=>{})
        const message=`图片下载失败（HTTP ${response.status}）`
        if([408,429,500,502,503,504].includes(response.status))throw new ImageNetworkError(message,retryAfterMs(response),response.status===429)
        throw new Error(message)
      }
      observe?.({phase:'receiving'})
      try{return await boundedBody(response,max,bytes=>observe?.({phase:'receiving',bytes}))}
      catch(cause){if(signal.aborted||cause instanceof TypeError)throw new ImageNetworkError('图片接收中断，请重试缺失页');throw cause}
    }
    throw new Error('图片跳转次数过多')
  }
  private async request(endpoint:string,payload?:unknown,signal?:AbortSignal,observe?:Observer):Promise<Row>{
    const method=payload===undefined?'GET':'POST'
    for(let attempt=0;attempt<3;attempt++){
      const time=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',DIGEST_KEY).update((endpoint+time+NONCE+method+API_KEY).toLowerCase()).digest('hex')
      let response:Response
      observe?.({phase:'connecting'})
      try{response=await this.deps.fetch(HOST+endpoint,{method,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),
        headers:{'api-key':API_KEY,accept:'application/vnd.picacomic.com.v1+json','app-channel':'2',time,nonce:NONCE,'app-version':'2.2.1.2.3.3','app-uuid':'defaultUuid','app-platform':'android','app-build-version':'44','Content-Type':'application/json; charset=UTF-8','User-Agent':'okhttp/3.8.1',authorization:this.deps.token(),'image-quality':'original',signature},...(payload===undefined?{}:{body:JSON.stringify(payload)})})}
      catch{if(signal?.aborted)throw new Error('下载已取消');throw new Error('连接哔咔失败，请检查网络或系统代理后重试')}
      if(response.status===401||response.status===403)throw new Error('登录已过期或无权访问，请重新登录')
      if(response.status===429&&attempt<2){await response.body?.cancel();const ms=retryAfterMs(response,1000);observe?.({phase:'rate-limited',waitMs:ms});if(this.deps.wait)await this.deps.wait(ms,signal);else await delay(ms,undefined,{signal});continue}
      if(!response.ok)throw new Error(response.status===400&&endpoint==='auth/sign-in'?'账号或密码错误':`哔咔请求失败（HTTP ${response.status}）`)
      let parsed:Row
      try{parsed=JSON.parse((await boundedBody(response,4*1024**2)).toString('utf8'))}catch{throw new Error('哔咔响应格式异常，请稍后重试')}
      if(parsed.code!==200||!parsed.data)throw new Error(parsed.code===401?'登录已过期，请重新登录':'哔咔返回了无法处理的响应')
      return parsed.data
    }
    throw new Error('哔咔请求过于频繁，请稍后重试')
  }
  async login(account:string,password:string):Promise<string>{
    if(!account.trim()||!password)throw new Error('请输入用户名和密码')
    // The Pica API names this field "email", even when the user signs in with a username.
    const data=await this.request('auth/sign-in',{email:account.trim(),password})
    if(typeof data.token!=='string'||!data.token||data.token.length>10000)throw new Error('登录响应无效')
    return data.token
  }
  async search(query:string,page=1):Promise<{items:ImageSourceWork[];pages:number}>{
    if(!query.trim())return {items:[],pages:0}
    if(!Number.isInteger(page)||page<1||page>1000)throw new Error('搜索页码无效')
    const data=await this.request(`comics/advanced-search?page=${page}`,{keyword:query.trim().slice(0,300),sort:'dd',categories:[]})
    return this.listing(data)
  }
  private async paginate(endpoint:(page:number)=>string,key:string,signal?:AbortSignal,observe?:Observer):Promise<Row[]>{
    const results:Row[]=[];let total=1
    for(let page=1;page<=total;page++){
      const data=(await this.request(endpoint(page),undefined,signal,observe))[key]
      if(!data||!Array.isArray(data.docs)||!Number.isInteger(Number(data.pages))||Number(data.pages)<0)throw new Error('来源分页格式已变化')
      total=Number(data.pages)
      if(total>1000||results.length+data.docs.length>50000)throw new Error('来源数据量超过单次处理限制')
      results.push(...data.docs)
    }
    return results
  }
  async detail(workId:string):Promise<{work:ImageSourceWork;chapters:ImageSourceChapter[]}>{
    const key=id(workId),data=await this.request('comics/'+key)
    const result=this.mapWork(data.comic)
    if(data.comic.allowDownload===false)throw new Error('该作品的来源未开放下载')
    const rows=await this.paginate(page=>`comics/${key}/eps?page=${page}`,'eps')
    const chapters=rows.map(c=>{if(!Number.isSafeInteger(c.order)||c.order<0)throw new Error('来源章节顺序无效');return {id:id(c._id),title:String(c.title).slice(0,300),order:c.order}}).sort((a,b)=>a.order-b.order)
    return {work:result,chapters}
  }
  async pages(workId:string,chapter:ImageSourceChapter,signal?:AbortSignal,observe?:Observer):Promise<ImageSourcePage[]>{
    const rows=await this.paginate(page=>`comics/${id(workId)}/order/${chapter.order}/pages?page=${page}`,'pages',signal,observe)
    return rows.map(p=>{
      if(!p.media||typeof p.media.fileServer!=='string'||typeof p.media.path!=='string')throw new Error('来源图片地址无效')
      const server=imageAddress(p.media.fileServer)
      const segments=p.media.path.split('/')
      if(segments.some((s:string)=>!s||s==='..'||s==='.'||s.includes('\\')))throw new Error('来源图片路径无效')
      const url=new URL('/static/'+segments.map(encodeURIComponent).join('/'),server).href
      return {id:id(p._id),url}
    })
  }
  async image(url:string,signal?:AbortSignal,observe?:Observer,gate?:ImageRequestGate):Promise<{data:Buffer;extension:string}>{
    const data=await this.imageData(url,MAX_IMAGE_BYTES,60000,signal,observe,gate),mime=imageMime(data)
    return {data,extension:({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif','image/bmp':'.bmp','image/avif':'.avif'} as Record<string,string>)[mime]}
  }
}
