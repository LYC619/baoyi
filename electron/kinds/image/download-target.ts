import fs from 'node:fs/promises'
import path from 'node:path'
import type {SqlDb} from '../../services/schema.ts'
import {ImageLibrary} from './library.ts'
import {writeComicJson} from './comic-files.ts'

export type ComicProvider='pica'|'jm'
export interface DownloadTarget {root:string;directory:string;groupId:string|null;locked:boolean}
export function comicProvider(value:unknown):ComicProvider{if(value!=='pica'&&value!=='jm')throw new Error('漫画来源无效');return value}
async function preferences(profile:string):Promise<Partial<Record<ComicProvider,string>>>{try{return JSON.parse(await fs.readFile(path.join(profile,'comic-download-targets.json'),'utf8'))}catch{return {}}}
let writing=Promise.resolve()
export function rememberDownloadRoot(profile:string,provider:ComicProvider,root:string){
  const operation=writing.catch(() => { /* 原始 Promise 的错误已交给调用方；这里只释放队列或监听。 */ }).then(async()=>{const saved=await preferences(profile);saved[provider]=root;await writeComicJson(path.join(profile,'comic-download-targets.json'),saved)})
  writing=operation;return operation
}
export async function validateDownloadRoot(value:unknown){
  if(typeof value!=='string'||!path.isAbsolute(value)||value.length>4096)throw new Error('请先选择漫画存放根目录')
  if(!(await fs.stat(value)).isDirectory())throw new Error('漫画存放位置不是目录')
  return path.resolve(value)
}
export async function downloadTarget(db:SqlDb,profile:string,provider:ComicProvider,workId='',groupId:string|null=null):Promise<DownloadTarget>{
  const library=new ImageLibrary(db)
  if(workId){
    if(typeof workId!=='string'||workId.length>100)throw new Error('作品编号无效')
    const row=db.prepare('SELECT resource_id AS id FROM image_meta WHERE source=? AND source_id=?').get(provider,workId) as {id:string}|undefined
    if(row){const item=library.get(row.id);if(!item)throw new Error('已有作品不可用，请核对分类');return {root:path.dirname(item.path),directory:path.basename(item.path),groupId:item.groupId,locked:true}}
  }
  const saved=await preferences(profile),group=library.groups().find(g=>g.id===groupId&&g.type==='comic'&&!g.hidden)
  let root=saved[provider]||group?.directory||''
  if(!root&&provider==='jm'){try{root=JSON.parse(await fs.readFile(path.join(profile,'comic-preferences.json'),'utf8')).root||''}catch{ /* 旧目录偏好不可读时继续使用当前下载目录默认值。 */ }}
  return {root,directory:'',groupId:group?.id||null,locked:false}
}
