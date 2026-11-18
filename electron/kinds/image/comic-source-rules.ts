import {createHash} from 'node:crypto'
import type {ComicCatalog,ComicProxy} from '../../../src/types/comic-ingest.ts'
import {parseProxyInput,serializeProxyInput} from '../../services/proxy-rules.ts'

// Pinned to jmcomic 2.7.11. Changes to upstream domains need an adapter update.
export const JM_API_HOSTS=['www.cdnhjk.net','www.cdngwc.cc','www.cdngwc.net','www.cdngwc.club']
export const JM_IMAGE_HOSTS=['cdn-msp.jmapiproxy1.cc','cdn-msp.jmapiproxy2.cc','cdn-msp2.jmapiproxy2.cc','cdn-msp3.jmapiproxy2.cc','cdn-msp.jmapinodeudzn.net','cdn-msp3.jmapinodeudzn.net']
export const JM_WEB_HOSTS=['18comic.vip','18comic.org','18comic.com','jmcomic.me','jmcomic1.me','jmcomic2.me']
export const JM_ADAPTER_VERSION='jmcomic-2.7.11/baoyi-1'
export function comicWorkId(input:unknown){
  if(typeof input!=='string'||input.length>1000)throw new Error('请输入作品数字 ID、JM 编号或支持的作品链接')
  const value=input.trim(),direct=/^(?:JM)?([1-9]\d{0,11})$/i.exec(value)
  if(direct)return direct[1]
  try{
    const url=new URL(value),host=url.hostname.replace(/^www\./,'')
    if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&JM_WEB_HOSTS.includes(host)){
      const match=/^\/album\/([1-9]\d{0,11})\/?$/.exec(url.pathname);if(match)return match[1]
    }
  }catch{ /* 无法解析的链接交给后续输入校验报错。 */ }
  throw new Error('无法识别作品链接；可直接粘贴数字 ID 或 JM 编号')
}
export function comicName(value:string,max=70){
  let name=value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').trim()
  name=Array.from(name).slice(0,max).join('').replace(/[. ]+$/g,'')||'未命名'
  if(/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))name='_'+name
  return name
}
export function comicDirectory(catalog:Pick<ComicCatalog,'name'|'authors'>){return '['+comicName(catalog.authors[0]||'未知作者',25)+(catalog.authors.length>1?' 等':'')+'] '+comicName(catalog.name)}
export function comicCatalog(input:unknown):ComicCatalog{
  if(!input||typeof input!=='object')throw new Error('作品资料无效')
  const c=input as ComicCatalog
  const strings=(value:unknown,max:number,length:number):value is string[]=>Array.isArray(value)&&value.length<=max&&value.every(v=>typeof v==='string'&&v.trim()&&v.length<=length)&&new Set(value).size===value.length
  if(c.provider!=='jm'||comicWorkId(c.workId)!==c.workId||typeof c.name!=='string'||!c.name.trim()||c.name.length>300||!strings(c.authors,50,300)||typeof c.description!=='string'||c.description.length>50000||!strings(c.tags,50,80)||!['ongoing','completed'].includes(c.publication)||c.adapterVersion!==JM_ADAPTER_VERSION||!Array.isArray(c.chapters)||!c.chapters.length||c.chapters.length>1000)throw new Error('作品来源资料不完整')
  const ids=new Set<string>(),orders=new Set<number>();let total=0
  for(const chapter of c.chapters){
    if(!chapter||!/^[1-9]\d{0,11}$/.test(chapter.id)||ids.has(chapter.id)||!Number.isSafeInteger(chapter.order)||chapter.order<1||orders.has(chapter.order)||typeof chapter.title!=='string'||chapter.title.length>300||!strings(chapter.pageIds,20000,200)||!chapter.pageIds.length||chapter.pageIds.some(id=>!/^[a-zA-Z0-9_.-]+$/.test(id)))throw new Error('章节或页面清单无效')
    ids.add(chapter.id);orders.add(chapter.order);total+=chapter.pageIds.length
  }
  if(total>50000)throw new Error('单部作品超过 50000 页，请分卷处理')
  const chapters=[...c.chapters].sort((a,b)=>a.order-b.order).map(({id,title,order,pageIds})=>({id,title,order,pageIds:[...pageIds]}))
  const catalogFingerprint=createHash('sha256').update(JSON.stringify(chapters.map(({id,pageIds})=>[id,pageIds]))).digest('hex')
  if(c.catalogFingerprint&&c.catalogFingerprint!==catalogFingerprint)throw new Error('来源目录指纹不一致，请重新解析')
  const cover=typeof c.cover==='string'&&c.cover.length<=54000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(c.cover)?c.cover:undefined
  return {provider:'jm',workId:c.workId,name:c.name,authors:[...c.authors],description:c.description,tags:[...c.tags],publication:c.publication,adapterVersion:c.adapterVersion,catalogFingerprint,chapters,...(cover?{cover}:{})}
}
export function comicProxy(input:unknown):ComicProxy{
  if(!input||typeof input!=='object')throw new Error('请选择代理方式')
  const value=input as ComicProxy
  if(value.mode==='system'||value.mode==='builtin')return {mode:value.mode}
  if(value.mode!=='custom'||typeof value.url!=='string')throw new Error('代理配置无效')
  const proxy=parseProxyInput(value.url)
  if(proxy.mode!=='http'&&proxy.mode!=='socks5')throw new Error('请填写单个代理地址，例如 127.0.0.1:7890')
  return {mode:'custom',url:serializeProxyInput(proxy)}
}
