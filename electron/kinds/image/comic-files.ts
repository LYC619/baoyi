import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {readImageManifest,readManifestPage,type ImageManifestV2} from './manifest.ts'
import {inspectImage} from './metadata.ts'
import {comicName} from './comic-source-rules.ts'
import type {ComicCatalog} from '../../../src/types/comic-ingest.ts'
import type {ComicPageVerifier} from './comic-verifier.ts'

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const normal=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value)
export const comicDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export interface ComicRoot {path:string;dev:number;ino:number}
export interface ComicIntent {
  version:1;jobId:string;operationId:string;workId:string;directory:string;root:ComicRoot;
  phase:'downloading'|'prepared'|'placed'|'done';manifestDigest:string;
  existingDigest:string;chapters:Array<{id:string;directory:string;placed:boolean}>;
  merge?:{before:string;after:string;manifest:ImageManifestV2};
}
export async function comicRoot(input:string):Promise<ComicRoot>{
  if(!path.isAbsolute(input))throw new Error('请选择漫画根目录')
  let current=path.resolve(input)
  while(true){const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink()||normal(await fs.realpath(current))!==normal(current))throw new Error('漫画根目录包含链接或不是实际目录');const parent=path.dirname(current);if(parent===current)break;current=parent}
  const stat=await fs.stat(input)
  return {path:path.resolve(input),dev:stat.dev,ino:stat.ino}
}
export async function assertComicRoot(root:ComicRoot){const current=await comicRoot(root.path);if(current.dev!==root.dev||current.ino!==root.ino)throw new Error('漫画根目录已变化，请重新选择')}
async function realChild(parent:string,name:string,create=false){
  if(create)await fs.mkdir(path.join(parent,name),{recursive:false}).catch(error=>{if(error.code!=='EEXIST')throw error})
  const child=path.join(parent,name),stat=await fs.lstat(child)
  if(!stat.isDirectory()||stat.isSymbolicLink()||normal(await fs.realpath(child))!==normal(child))throw new Error('漫画任务目录包含链接或已变化')
  return child
}
export async function writeComicJson(file:string,value:unknown){
  const temporary=file+'.'+randomUUID()+'.tmp'
  try{const handle=await fs.open(temporary,'wx');try{await handle.writeFile(JSON.stringify(value));await handle.sync()}finally{await handle.close()};await fs.rename(temporary,file)}
  finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})}
}
export function emptyComicManifest(catalog:ComicCatalog,selected:string[]):ImageManifestV2{
  return {version:2,source:'jm',sourceId:catalog.workId,name:catalog.name,authors:catalog.authors,description:catalog.description,tags:catalog.tags,publication:catalog.publication,adapterVersion:catalog.adapterVersion,catalogFingerprint:catalog.catalogFingerprint,selectionComplete:false,
    chapters:catalog.chapters.filter(c=>selected.includes(c.id)).map(c=>({...c,directory:String(c.order).padStart(4,'0')+' '+comicName(c.title,50)})),pages:{}}
}
export class ComicStage {
  readonly directory:string;readonly intent:ComicIntent
  private constructor(directory:string,intent:ComicIntent){this.directory=directory;this.intent=intent}
  get payload(){return path.join(this.directory,'payload')}
  get destination(){return path.join(this.intent.root.path,this.intent.directory)}
  async checkpoint(){await assertComicRoot(this.intent.root);await realChild(path.dirname(this.directory),path.basename(this.directory));await writeComicJson(path.join(this.directory,'intent.json'),this.intent)}
  static async create(root:ComicRoot,jobId:string,operationId:string,workId:string,directory:string){
    if(!uuid.test(jobId)||!uuid.test(operationId)||!/^\d{1,12}$/.test(workId)||comicName(directory,150)!==directory)throw new Error('漫画任务目录或身份无效')
    await assertComicRoot(root);const disk=await fs.statfs(root.path);if(disk.bavail*disk.bsize<128*1024**2)throw new Error('漫画目标磁盘可用空间不足')
    const reserved=await realChild(root.path,'.baoyi-ingest',true),stage=path.join(reserved,jobId)
    await fs.mkdir(stage);await fs.mkdir(path.join(stage,'payload'))
    const result=new ComicStage(stage,{version:1,jobId,operationId,workId,directory,root,phase:'downloading',manifestDigest:'',existingDigest:'',chapters:[]})
    await result.checkpoint();return result
  }
  static async recover(root:ComicRoot,jobId:string,operationId:string,workId:string){
    if(!uuid.test(jobId)||!uuid.test(operationId))throw new Error('漫画任务编号无效')
    await assertComicRoot(root);const reserved=await realChild(root.path,'.baoyi-ingest'),directory=await realChild(reserved,jobId),file=path.join(directory,'intent.json'),stat=await fs.lstat(file)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024**2)throw new Error('漫画提交记录不可用')
    const intent=JSON.parse(await fs.readFile(file,'utf8')) as ComicIntent
    if(intent.version!==1||intent.jobId!==jobId||intent.operationId!==operationId||intent.workId!==workId||intent.root.path!==root.path||intent.root.dev!==root.dev||intent.root.ino!==root.ino||typeof intent.directory!=='string'||comicName(intent.directory,150)!==intent.directory||!['downloading','prepared','placed','done'].includes(intent.phase)||!Array.isArray(intent.chapters))throw new Error('漫画提交记录与本机授权不一致')
    return new ComicStage(directory,intent)
  }
  // Called only after the native directory picker grants access again. A backup
  // alone cannot supply this authority or an operation token.
  static async reauthorize(root:ComicRoot,jobId:string,workId:string){
    if(!uuid.test(jobId))throw new Error('漫画任务编号无效')
    await assertComicRoot(root)
    const reserved=await realChild(root.path,'.baoyi-ingest'),directory=await realChild(reserved,jobId),file=path.join(directory,'intent.json'),stat=await fs.lstat(file)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024**2)throw new Error('漫画提交记录不可用')
    const intent=JSON.parse(await fs.readFile(file,'utf8')) as ComicIntent
    return ComicStage.recover(root,jobId,intent.operationId,workId)
  }
  async verified(directory=this.payload,verify?:ComicPageVerifier){
    await assertComicRoot(this.intent.root)
    await realChild(path.dirname(directory),path.basename(directory))
    const manifest=await readImageManifest(directory,this.intent.workId,'jm')
    if(!manifest?.selectionComplete)throw new Error('漫画页面尚未全部完成')
    for(const chapter of manifest.chapters)await realChild(directory,chapter.directory)
    for(const page of Object.values(manifest.pages)){
      if(verify){await verify(directory,page);continue}
      const data=await readManifestPage(directory,page.file),info=inspectImage(data)
      if(info.width*info.height>40_000_000||data.length!==page.size||createHash('sha256').update(data).digest('hex')!==page.sha256)throw new Error('漫画页面与校验清单不符')
    }
    return manifest
  }
  async place(verify?:ComicPageVerifier){
    await assertComicRoot(this.intent.root)
    if(this.intent.phase==='placed'||this.intent.phase==='done'){
      const manifest=await this.verified(this.destination,verify);if(comicDigest(manifest)!==this.intent.manifestDigest)throw new Error('已落盘漫画被修改，请核对后再入库');return manifest
    }
    if(this.intent.phase==='prepared'){
      const exists=await fs.lstat(this.destination).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
      const payload=await fs.lstat(this.payload).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
      if(exists&&!payload){
        const manifest=await this.verified(this.destination,verify);if(comicDigest(manifest)!==this.intent.manifestDigest)throw new Error('目标目录与提交记录不一致')
        this.intent.phase='placed';await this.checkpoint();return manifest
      }
    }
    const manifest=await this.verified(this.payload,verify),digest=comicDigest(manifest)
    if(this.intent.manifestDigest&&digest!==this.intent.manifestDigest)throw new Error('漫画暂存清单已变化')
    if(await fs.lstat(this.destination).catch(error=>{if(error.code!=='ENOENT')throw error;return null}))throw new Error('同名漫画目录已存在，未覆盖原目录')
    this.intent.manifestDigest=digest;this.intent.phase='prepared';await this.checkpoint()
    await realChild(this.directory,'payload');await assertComicRoot(this.intent.root)
    await fs.rename(this.payload,this.destination)
    this.intent.phase='placed';await this.checkpoint();return manifest
  }
  async finish(){this.intent.phase='done';await this.checkpoint()}
  async cleanFinished(){
    if(this.intent.phase!=='done')throw new Error('漫画任务尚未完成，保留暂存')
    await assertComicRoot(this.intent.root)
    await ComicStage.recover(this.intent.root,this.intent.jobId,this.intent.operationId,this.intent.workId)
    const entries=await fs.readdir(this.directory)
    if(entries.some(name=>!['intent.json','payload'].includes(name)))return false
    if(entries.includes('payload')){
      await realChild(this.directory,'payload');const files=await fs.readdir(this.payload)
      if(files.some(name=>name!=='.baoyi-image.json'))return false
      if(files.length){if(!await readImageManifest(this.payload,this.intent.workId,'jm'))return false;await fs.unlink(path.join(this.payload,'.baoyi-image.json'))}
      await fs.rmdir(this.payload)
    }
    await fs.unlink(path.join(this.directory,'intent.json'));await fs.rmdir(this.directory);return true
  }
  async cleanPending(verify:ComicPageVerifier){
    await ComicStage.recover(this.intent.root,this.intent.jobId,this.intent.operationId,this.intent.workId)
    if(this.intent.phase!=='downloading'||this.intent.merge)throw new Error('作品处于提交阶段，请先重试登记，再清理记录')
    const entries=await fs.readdir(this.directory)
    if(entries.some(name=>!['intent.json','payload'].includes(name)))throw new Error('暂存含有未知文件，请先人工核对；未清理任何文件')
    await realChild(this.directory,'payload')
    const manifest=await readImageManifest(this.payload,this.intent.workId,'jm')
    if(!manifest)throw new Error('暂存清单不可用，未清理')
    const allowed=new Set(['.baoyi-image.json',...manifest.chapters.map(c=>c.directory)])
    if((await fs.readdir(this.payload)).some(name=>!allowed.has(name)))throw new Error('暂存含有未知文件，请先人工核对；未清理任何文件')
    const files:string[]=[],directories:string[]=[]
    for(const chapter of manifest.chapters){
      const folder=path.join(this.payload,chapter.directory),stat=await fs.lstat(folder).catch(e=>{if(e.code!=='ENOENT')throw e;return null})
      if(!stat)continue
      await realChild(this.payload,chapter.directory)
      const names=new Set(chapter.pageIds.flatMap((_,i)=>{const name=String(i+1).padStart(5,'0');return [name+'.png',name+'.part',name+'.part.png']}))
      for(const name of await fs.readdir(folder)){
        if(!names.has(name))throw new Error('暂存含有未知文件，请先人工核对；未清理任何文件')
        const file=path.join(folder,name),info=await fs.lstat(file)
        if(!info.isFile()||info.isSymbolicLink())throw new Error('暂存文件已变化，未清理')
        const page=Object.values(manifest.pages).find(p=>p.file===chapter.directory+'/'+name)
        if(page)await verify(this.payload,page)
        files.push(file)
      }
      directories.push(folder)
    }
    // Validate the entire plan before deleting. Never recurse into a user path.
    await assertComicRoot(this.intent.root)
    for(const file of files)await fs.unlink(file)
    for(const directory of directories)await fs.rmdir(directory)
    await fs.unlink(path.join(this.payload,'.baoyi-image.json'));await fs.rmdir(this.payload)
    await fs.unlink(path.join(this.directory,'intent.json'));await fs.rmdir(this.directory)
  }
  async supplement(manifest:ImageManifestV2,verify:ComicPageVerifier,onChapter:()=>Promise<void>,recoverOnly=false,finalize=true){
    await assertComicRoot(this.intent.root);await realChild(this.intent.root.path,this.intent.directory)
    let current=await readImageManifest(this.destination,this.intent.workId,'jm')
    if(!current?.selectionComplete)throw new Error('原作品清单不可用，未改动原目录')
    if(!this.intent.existingDigest){this.intent.existingDigest=comicDigest(current);await this.checkpoint()}
    for(const chapter of manifest.chapters){
      if(this.intent.chapters.some(c=>c.id===chapter.id&&c.placed))continue
      let merge=this.intent.merge
      if(!merge){
        if(current.chapters.some(c=>c.id===chapter.id)){if(this.intent.chapters.some(c=>c.id===chapter.id&&c.placed))continue;throw new Error('章节已存在，请重新核对来源')}
        if(comicDigest(current)!==this.intent.existingDigest)throw new Error('原作品清单已变化，请核对后再补章')
        // Recheck old pages too: a modified original must never be silently adopted.
        await this.verified(this.destination,verify)
        const pages=Object.fromEntries(chapter.pageIds.map(id=>[chapter.id+':'+id,manifest.pages[chapter.id+':'+id]]))
        for(const page of Object.values(pages)){if(!page)throw new Error('补章页面尚未完成');await verify(this.payload,page)}
        if(current.chapters.some(c=>c.directory.toLowerCase()===chapter.directory.toLowerCase()))throw new Error('新章节目录与原目录重名，请核对')
        if(await fs.lstat(path.join(this.destination,chapter.directory)).catch(e=>{if(e.code!=='ENOENT')throw e;return null}))throw new Error('新章节目标已有文件，未覆盖')
        const next:ImageManifestV2={...current,chapters:[...current.chapters,chapter].sort((a,b)=>a.order-b.order),pages:{...current.pages,...pages},catalogFingerprint:manifest.catalogFingerprint}
        merge=this.intent.merge={before:comicDigest(current),after:comicDigest(next),manifest:next}
        this.intent.chapters.push({id:chapter.id,directory:chapter.directory,placed:false});await this.checkpoint()
      }
      const recorded=this.intent.chapters.find(c=>c.id===chapter.id)
      if(!recorded||!merge.manifest.chapters.some(c=>c.id===chapter.id))throw new Error('补章提交记录不一致')
      const digest=comicDigest(current)
      if(digest!==merge.before&&digest!==merge.after)throw new Error('补章期间原清单已变化，请核对')
      const source=path.join(this.payload,chapter.directory),target=path.join(this.destination,chapter.directory)
      const pending=await fs.lstat(source).catch(e=>{if(e.code!=='ENOENT')throw e;return null})
      if(pending){
        if(digest!==merge.before)throw new Error('补章记录与原清单不一致')
        await realChild(this.payload,chapter.directory)
        if(await fs.lstat(target).catch(e=>{if(e.code!=='ENOENT')throw e;return null}))throw new Error('新章节目标已有文件，未覆盖')
        await fs.rename(source,target)
      }
      await realChild(this.destination,chapter.directory)
      for(const id of chapter.pageIds)await verify(this.destination,merge.manifest.pages[chapter.id+':'+id])
      if(digest===merge.before)await writeComicJson(path.join(this.destination,'.baoyi-image.json'),merge.manifest)
      current=merge.manifest;recorded.placed=true;this.intent.existingDigest=merge.after;delete this.intent.merge;await this.checkpoint()
      await onChapter()
      if(recoverOnly)return current
    }
    this.intent.manifestDigest=comicDigest(current);if(finalize)this.intent.phase='placed';await this.checkpoint();return current
  }
}
