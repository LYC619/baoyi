/** Protocol constants and endpoint shapes verified against lanyeeee/picacomic-downloader (MIT).
 * See docs/third-party/picacomic-downloader.txt. Passwords and tokens never enter error messages.
 */
import { createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ImageSourceChapter, ImageSourcePage, ImageSourceWork } from '../../../src/types/image.ts'
import { MAX_IMAGE_BYTES } from './archive.ts'
import { imageMime } from './files.ts'

const HOST='https://picaapi.picacomic.com/'
const API_KEY='C69BAF41DA5ABD1FFEDC6D2FEA56B'
const NONCE='ptxdhmjzqtnrtwndhbxcpkjamb33w837'
const DIGEST_KEY='~d}$Q7$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn'
type Dependencies={fetch:(url:string,init?:RequestInit)=>Promise<Response>;token:()=>string;wait?:(ms:number,signal?:AbortSignal)=>Promise<void>}
type Row=Record<string,any>
const id=(value:unknown)=>{if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(value))throw new Error('来源返回了无效标识');return value}
function work(row:Row):ImageSourceWork {
  if(!row||typeof row.title!=='string')throw new Error('来源作品资料格式已变化')
  return {id:id(row._id),title:row.title.slice(0,300),author:String(row.author||'').slice(0,300),description:String(row.description||'').slice(0,50000),
    tags:[...(Array.isArray(row.tags)?row.tags:[]),...(Array.isArray(row.categories)?row.categories:[])].filter(t=>typeof t==='string').slice(0,50),
    chapters:Number(row.epsCount)||0,pages:Number(row.pagesCount)||0,finished:row.finished===true}
}
export async function boundedBody(response:Response,max:number):Promise<Buffer>{
  if(Number(response.headers.get('content-length'))>max)throw new Error('来源响应超过大小限制')
  const reader=response.body?.getReader();if(!reader)throw new Error('来源响应为空')
  const chunks:Uint8Array[]=[];let total=0
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max)throw new Error('来源响应超过大小限制');chunks.push(value)}return Buffer.concat(chunks)}finally{await reader.cancel().catch(()=>{})}
}
export class PicacomicSource {
  private deps:Dependencies
  constructor(deps:Dependencies){this.deps=deps}
  private async request(endpoint:string,payload?:unknown,signal?:AbortSignal):Promise<Row>{
    const method=payload===undefined?'GET':'POST'
    for(let attempt=0;attempt<3;attempt++){
      const time=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',DIGEST_KEY).update((endpoint+time+NONCE+method+API_KEY).toLowerCase()).digest('hex')
      let response:Response
      try{response=await this.deps.fetch(HOST+endpoint,{method,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),
        headers:{'api-key':API_KEY,accept:'application/vnd.picacomic.com.v1+json','app-channel':'2',time,nonce:NONCE,'app-version':'2.2.1.2.3.3','app-uuid':'defaultUuid','app-platform':'android','app-build-version':'44','Content-Type':'application/json; charset=UTF-8','User-Agent':'okhttp/3.8.1',authorization:this.deps.token(),'image-quality':'original',signature},...(payload===undefined?{}:{body:JSON.stringify(payload)})})}
      catch{if(signal?.aborted)throw new Error('下载已取消');throw new Error('连接哔咔失败，请检查网络或系统代理后重试')}
      if(response.status===401||response.status===403)throw new Error('登录已过期或无权访问，请重新登录')
      if(response.status===429&&attempt<2){await response.body?.cancel();const ms=Math.max(500,Math.min(10000,(Number(response.headers.get('retry-after'))||1)*1000));if(this.deps.wait)await this.deps.wait(ms,signal);else await delay(ms,undefined,{signal});continue}
      if(!response.ok)throw new Error(response.status===400&&endpoint==='auth/sign-in'?'账号或密码错误':`哔咔请求失败（HTTP ${response.status}）`)
      let parsed:Row
      try{parsed=JSON.parse((await boundedBody(response,4*1024**2)).toString('utf8'))}catch{throw new Error('哔咔响应格式异常，请稍后重试')}
      if(parsed.code!==200||!parsed.data)throw new Error(parsed.code===401?'登录已过期，请重新登录':'哔咔返回了无法处理的响应')
      return parsed.data
    }
    throw new Error('哔咔请求过于频繁，请稍后重试')
  }
  async login(email:string,password:string):Promise<string>{
    if(!email.trim()||!password)throw new Error('请输入邮箱和密码')
    const data=await this.request('auth/sign-in',{email:email.trim(),password})
    if(typeof data.token!=='string'||!data.token||data.token.length>10000)throw new Error('登录响应无效')
    return data.token
  }
  async search(query:string,page=1):Promise<{items:ImageSourceWork[];pages:number}>{
    if(!query.trim())return {items:[],pages:0}
    if(!Number.isInteger(page)||page<1||page>1000)throw new Error('搜索页码无效')
    const data=await this.request(`comics/advanced-search?page=${page}`,{keyword:query.trim().slice(0,300),sort:'dd',categories:[]})
    if(!Array.isArray(data.comics?.docs))throw new Error('搜索响应格式已变化')
    return {items:data.comics.docs.map(work),pages:Math.min(1000,Number(data.comics.pages)||1)}
  }
  private async paginate(endpoint:(page:number)=>string,key:string,signal?:AbortSignal):Promise<Row[]>{
    const results:Row[]=[];let total=1
    for(let page=1;page<=total;page++){
      const data=(await this.request(endpoint(page),undefined,signal))[key]
      if(!data||!Array.isArray(data.docs)||!Number.isInteger(Number(data.pages))||Number(data.pages)<0)throw new Error('来源分页格式已变化')
      total=Number(data.pages)
      if(total>1000||results.length+data.docs.length>50000)throw new Error('来源数据量超过单次处理限制')
      results.push(...data.docs)
    }
    return results
  }
  async detail(workId:string):Promise<{work:ImageSourceWork;chapters:ImageSourceChapter[]}>{
    const key=id(workId),data=await this.request('comics/'+key)
    const result=work(data.comic)
    if(data.comic.allowDownload===false)throw new Error('该作品的来源未开放下载')
    const rows=await this.paginate(page=>`comics/${key}/eps?page=${page}`,'eps')
    const chapters=rows.map(c=>{if(!Number.isSafeInteger(c.order)||c.order<0)throw new Error('来源章节顺序无效');return {id:id(c._id),title:String(c.title).slice(0,300),order:c.order}}).sort((a,b)=>a.order-b.order)
    return {work:result,chapters}
  }
  async pages(workId:string,chapter:ImageSourceChapter,signal?:AbortSignal):Promise<ImageSourcePage[]>{
    const rows=await this.paginate(page=>`comics/${id(workId)}/order/${chapter.order}/pages?page=${page}`,'pages',signal)
    return rows.map(p=>{
      if(!p.media||typeof p.media.fileServer!=='string'||typeof p.media.path!=='string')throw new Error('来源图片地址无效')
      const server=new URL(p.media.fileServer)
      if(server.protocol!=='https:'||server.username||server.password||!server.hostname.includes('.')||/^[\d.]+$/.test(server.hostname)||server.hostname.endsWith('.local')||server.hostname==='localhost')throw new Error('来源图片服务器不受支持')
      const segments=p.media.path.split('/')
      if(segments.some((s:string)=>!s||s==='..'||s==='.'||s.includes('\\')))throw new Error('来源图片路径无效')
      const url=new URL('/static/'+segments.map(encodeURIComponent).join('/'),server).href
      return {id:id(p._id),url}
    })
  }
  async image(url:string,signal?:AbortSignal):Promise<{data:Buffer;extension:string}>{
    let response:Response
    try{response=await this.deps.fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000),redirect:'error'})}
    catch{throw new Error(signal?.aborted?'下载已取消':'图片下载中断，请重试缺失页')}
    if(!response.ok)throw new Error(`图片下载失败（HTTP ${response.status}）`)
    const data=await boundedBody(response,MAX_IMAGE_BYTES),mime=imageMime(data)
    return {data,extension:({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif','image/bmp':'.bmp','image/avif':'.avif'} as Record<string,string>)[mime]}
  }
}
