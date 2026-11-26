import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/storage/schema.ts'
import { ImageLibrary } from './library.ts'
import type { ImageMoveResult } from '../../../src/types/image.ts'

type Move = {id:string;source:string;destination:string; groupId?:string; directory?:string}
const same = (a:string,b:string) => path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase()
const inside = (root:string,file:string) => {const rel=path.relative(root,file);return rel!== '..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)}
const safeName = (name:string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,80)||'未分类'
const locks = new Set<string>()
export function assertImageFilesIdle(id:string){if(locks.has(id))throw new Error('这部作品正在整理，请稍后重试')}
export function lockImageFiles(id:string){assertImageFilesIdle(id);locks.add(id);return ()=>locks.delete(id)}
function checkIdle(db:SqlDb,id:string){
  assertImageFilesIdle(id)
  const item=new ImageLibrary(db).get(id)
  if(!item)throw new Error('资源不可用')
  for(const row of db.prepare("SELECT payload FROM image_download_jobs WHERE status IN ('queued','running','paused','failed','interrupted')").all() as {payload:string}[]){
    try{const job=JSON.parse(row.payload);if(job.resourceId===id||(item.sourceId&&(job.work?.id===item.sourceId||job.provider===item.source&&job.workId===item.sourceId)))throw new Error('请先停止并移除这部作品的未完成下载任务，再整理文件')}catch(error){if(!(error instanceof SyntaxError))throw error}
  }
}
export async function imageFileTarget(db:SqlDb,id:string,protectedPaths:string[]=[]):Promise<string>{
  const item=new ImageLibrary(db).get(id)
  if(!item)throw new Error('资源不可用')
  if(locks.has(id))throw new Error('这部作品正在整理，请稍后重试')
  const source=path.resolve(item.path),stat=await fs.lstat(source)
  if(stat.isSymbolicLink()||!same(await fs.realpath(source),source))throw new Error('暂不移动或删除链接目录，请在资源管理器中处理')
  if(same(source,path.parse(source).root)||protectedPaths.filter(Boolean).some(root=>same(source,root)))throw new Error('不能移动或删除资料根目录，请选择单部作品目录')
  const others=db.prepare('SELECT id,path,source_dir FROM resource WHERE id<>?').all(id) as {id:string;path:string;source_dir:string}[]
  if(others.some(other=>other.path&&(inside(source,other.path)||inside(other.path,source))))throw new Error('此目录与其他已登记资源共享，不能整体移动或删除')
  if(others.some(other=>other.source_dir&&same(source,other.source_dir)))throw new Error('此目录被其他条目用作来源根目录')
  checkIdle(db,id)
  return source
}
export function rememberedImageDirectory(db:SqlDb,groupId:string|null):string {
  if (!groupId) return ''
  const library=new ImageLibrary(db),group=library.groups().find(g=>g.id===groupId)
  if (!group) return ''
  if (group.directory) return group.directory
  // Only infer a legacy category folder when all matching parent paths agree.
  const candidates=[...new Set(library.list({groupId,type:group.type}).map(item=>path.dirname(item.path)).filter(parent=>path.basename(parent)===safeName(group.name)))]
  return candidates.length===1 ? candidates[0] : ''
}
async function checkDestinationParent(parent:string) {
  let ancestor=parent
  while (!await fs.lstat(ancestor).catch(cause => { if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null; throw cause })) {
    const next=path.dirname(ancestor); if (next===ancestor) throw new Error('目标目录不可用')
    ancestor=next
  }
  if (!same(await fs.realpath(ancestor),ancestor) || !(await fs.stat(ancestor)).isDirectory()) throw new Error('目标目录包含链接或不是目录')
}
export async function planImageMove(db:SqlDb,ids:string[],root:string,byCategory=false,protectedPaths:string[]=[]):Promise<Move[]>{
  if(!Array.isArray(ids)||!ids.length||ids.length>5000)throw new Error('请选择需要整理的作品')
  const target=root?await fs.realpath(root):'', library=new ImageLibrary(db),groups=library.groups()
  if(target && !(await fs.stat(target)).isDirectory())throw new Error('目标必须是目录')
  const plan:Move[]=[]
  for(const id of new Set(ids)){
    const source=await imageFileTarget(db,id,protectedPaths),item=library.get(id)!
    const group=groups.find(g=>g.id===item.groupId)
    const parent=target?(byCategory?path.join(target,safeName(group?.name||'未分类')):target):(byCategory?rememberedImageDirectory(db,item.groupId):'')
    if(!parent)throw new Error('分类尚未设置存放目录，请选择目标目录')
    await checkDestinationParent(parent)
    if(same(source,parent))continue
    const destination=path.join(parent,path.basename(source))
    if(same(source,destination))continue
    if(inside(source,destination))throw new Error('不能把作品移动到自己的子目录')
    if(await fs.lstat(destination).catch(cause => { if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null; throw cause })||plan.some(row=>same(row.destination,destination)))throw new Error('目标存在同名文件或目录：'+destination)
    plan.push({id,source,destination,...(byCategory&&group?{groupId:group.id,directory:parent}:{})})
  }
  return plan
}
async function digest(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex')}
async function fingerprint(file:string):Promise<string[]>{
  const result:string[]=[]
  async function visit(current:string){const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw new Error('作品中含链接，跨盘移动前请先处理链接');const relative=path.relative(file,current);if(stat.isDirectory()){result.push(relative+'/');for(const name of (await fs.readdir(current)).sort())await visit(path.join(current,name))}else if(stat.isFile())result.push(relative+':'+stat.size+':'+await digest(current));else throw new Error('作品中存在不支持的文件类型')}
  await visit(file);return result
}
export async function moveImageItems(db:SqlDb,plan:Move[],trash:(file:string)=>Promise<void>,protectedPaths:string[]=[]):Promise<ImageMoveResult>{
  for(const row of plan){if(!same(await imageFileTarget(db,row.id,protectedPaths),row.source))throw new Error('作品位置已改变，请重新预览');if(await fs.lstat(row.destination).catch(cause => { if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null; throw cause }))throw new Error('目标已经存在，请重新预览')}
  for(const row of plan)checkIdle(db,row.id)
  for(const row of plan)locks.add(row.id)
  const completed:Array<Move&{copied:boolean}>=[],warnings:string[]=[]
  try{
    for(const row of plan){
      await checkDestinationParent(path.dirname(row.destination))
      if(await fs.lstat(row.destination).catch(cause => { if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null; throw cause }))throw new Error('目标已经存在，请重新预览')
      await fs.mkdir(path.dirname(row.destination),{recursive:true})
      let copied=false
      try{await fs.rename(row.source,row.destination)}catch(error){
        if((error as NodeJS.ErrnoException).code!=='EXDEV')throw error
        const before=await fingerprint(row.source),stage=row.destination+'.baoyi-moving-'+randomUUID()
        try{
          await fs.cp(row.source,stage,{recursive:true,errorOnExist:true,force:false})
          if(JSON.stringify(before)!==JSON.stringify(await fingerprint(stage))||JSON.stringify(before)!==JSON.stringify(await fingerprint(row.source)))throw new Error('跨盘复制校验失败或原文件发生变化，原目录已保留')
          await fs.rename(stage,row.destination);copied=true
        }catch(cause){await fs.rm(stage,{recursive:true,force:true});throw cause}
      }
      completed.push({...row,copied})
    }
    db.exec('SAVEPOINT image_move')
    try{
      for(const row of completed){
        const pages=db.prepare('SELECT id,file FROM image_pages WHERE resource_id=?').all(row.id) as {id:string;file:string}[]
        for(const page of pages){if(!inside(row.source,page.file))throw new Error('登记页面位于作品目录之外');db.prepare('UPDATE image_pages SET file=? WHERE id=?').run(path.join(row.destination,path.relative(row.source,page.file)),page.id)}
        db.prepare('UPDATE resource SET path=?,source_dir=?,file_name=?,updated_at=? WHERE id=?').run(row.destination,path.dirname(row.destination),path.basename(row.destination),Date.now(),row.id)
        if(row.groupId && row.directory)db.prepare('UPDATE image_groups SET directory=? WHERE id=?').run(row.directory,row.groupId)
      }
      db.exec('RELEASE image_move')
    }catch(error){db.exec('ROLLBACK TO image_move; RELEASE image_move');throw error}
  }catch(error){
    for(const row of completed.reverse()){try{if(row.copied)await fs.rm(row.destination,{recursive:true,force:true});else await fs.rename(row.destination,row.source)}catch(cause){warnings.push(`回退失败，文件保留在 ${row.destination}：${String(cause)}`)}}
    throw new Error(String((error as Error).message)+(warnings.length?'\n'+warnings.join('\n'):''))
  }finally{for(const row of plan)locks.delete(row.id)}
  for(const row of completed.filter(row=>row.copied)){try{await trash(row.source)}catch{warnings.push('新位置已生效；原目录未能送回收站，请手动清理：'+row.source)}}
  return {moved:completed.length,paths:completed.map(row=>row.destination),warnings}
}
export async function removeImageFiles(db:SqlDb,id:string,trash:(file:string)=>Promise<void>,protectedPaths:string[]=[]):Promise<void>{
  const target=await imageFileTarget(db,id,protectedPaths);checkIdle(db,id);locks.add(id)
  try{await trash(target);new ImageLibrary(db).remove(id)}finally{locks.delete(id)}
}
