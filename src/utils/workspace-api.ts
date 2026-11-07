import type { ResourceLink } from '@/types/workspace'
import type { Router } from 'vue-router'
export const workspace = window.baoyi.workspace
export const plain = <T>(value:T):T=>JSON.parse(JSON.stringify(value))
export const localDate = (value = new Date()) => `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`
export const kindLabels:Record<string,string>={software:'软件',game:'游戏',video:'影视',image:'图片',document:'资料',project:'项目'}
export const returnPath = (value:unknown, fallback:string) => typeof value==='string' && value.startsWith('/') && !value.startsWith('//') ? value : fallback
export async function openResource(router:Router,link:ResourceLink,from:string){
  if(!link.resourceId)throw new Error('原索引已移除；来源与摘录仍保留在此处')
  const base=link.kind==='software'?'/detail':`/${link.kind}`
  await router.push({path:`${base}/${encodeURIComponent(link.resourceId)}`,query:{from,...(link.kind==='document'&&link.location?{page:String(link.location.page),offset:String(link.location.offset),...(link.annotationId?{annotation:link.annotationId}:{})}:{})}})
}
