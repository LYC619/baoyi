
import { tr } from "../i18n/index.ts"
import type { ResourceLink } from '@/types/workspace'
import type { Router } from 'vue-router'
export const workspace = (typeof window !== 'undefined' ? window.baoyi?.workspace : undefined) as Window['baoyi']['workspace']
export const plain = <T>(value:T):T=>JSON.parse(JSON.stringify(value))
export const localDate = (value = new Date()) => `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`
export const kindLabels:Record<string,string>={get software() { return tr('软件') },get game() { return tr('游戏') },get video() { return tr('影视') },get image() { return tr('图片') },get document() { return tr('资料') },get project() { return tr('项目') }}
export const returnPath = (value:unknown, fallback:string) => typeof value==='string' && value.startsWith('/') && !value.startsWith('//') ? value : fallback
export async function openResource(router:Router,link:ResourceLink,from:string){
  if(!link.resourceId)throw new Error(tr('原索引已移除；来源与摘录仍保留在此处'))
  const base=link.kind==='software'?'/detail':`/${link.kind}`
  await router.push({path:`${base}/${encodeURIComponent(link.resourceId)}`,query:{from,...(link.kind==='document'&&link.location?{page:String(link.location.page),offset:String(link.location.offset),...(link.annotationId?{annotation:link.annotationId}:{})}:{})}})
}
