import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { ImageDownloadJob, ImageSourceChapter, ImageSourceWork } from '../../../src/types/image.ts'
import { ImageLibrary } from './library.ts'
import { PicacomicSource } from './source.ts'
import { scanImageImport } from './scanner.ts'
import { imageMime } from './files.ts'

const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
const safeName=(s:string)=>s.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,60)||'漫画'
type Manifest={version:1;source:'pica';sourceId:string;name:string;description:string;tags:string[];publication:'completed'|'ongoing';chapters:Array<{directory:string;id:string;title:string;order:number}>;pages:Record<string,{file:string;sha256:string}>}
type Dependencies={db:SqlDb;source:PicacomicSource;changed:()=>void}
async function writeJson(file:string,value:unknown){const temporary=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(value,null,2),{flag:'wx'});try{await fs.rename(temporary,file)}catch(cause){await fs.unlink(temporary).catch(()=>{});throw cause}}
async function realDirectory(directory:string,root:string){await fs.mkdir(directory,{recursive:true});const actual=await fs.realpath(directory),relative=path.relative(root,actual);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('下载目录指向目标根目录之外');return actual}
export function createImageDownloads(deps:Dependencies){
  const {db,source}=deps,library=new ImageLibrary(db),jobs=new Map<string,ImageDownloadJob>(),controllers=new Map<string,AbortController>()
  let pumping:Promise<void>|null=null
  const save=(job:ImageDownloadJob)=>{job.updatedAt=Date.now();db.prepare('INSERT INTO image_download_jobs(id,status,updated_at,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload=excluded.payload').run(job.id,job.status,job.updatedAt,JSON.stringify(job));deps.changed()}
  for(const row of db.prepare('SELECT * FROM image_download_jobs ORDER BY updated_at').all() as Array<{id:string;status:string;payload:string}>){
    try{const job=JSON.parse(row.payload) as ImageDownloadJob;if(job.id!==row.id||!job.work?.id||!Array.isArray(job.chapters)||!path.isAbsolute(job.root))continue;if(['running','queued'].includes(row.status)){job.status='interrupted';job.error='应用中断，请重试剩余页';save(job)}jobs.set(job.id,job)}catch{/* Keep malformed historical rows on disk; they cannot start filesystem work. */}
  }
  const visible=(job:ImageDownloadJob)=>!library.groups().some(g=>g.id===job.groupId&&g.hidden)&&(!job.resourceId||!!library.get(job.resourceId))
  async function run(job:ImageDownloadJob){
    const controller=new AbortController();controllers.set(job.id,controller);job.status='running';job.error='';job.processed=0;job.total=0;job.completedChapters=0;save(job)
    try{
      const root=await fs.realpath(job.root)
      const existing=library.list().find(i=>i.source==='pica'&&i.sourceId===job.work.id)
      if(existing&&path.dirname(existing.path).toLowerCase()!==root.toLowerCase())throw new Error('作品已在另一目录中，请使用原下载根目录补齐章节')
      const directory=await realDirectory(existing?.path||path.join(root,safeName(job.work.title)+' ['+hash(job.work.id).slice(0,8)+']'),root)
      const manifestFile=path.join(directory,'.baoyi-image.json')
      let manifest:Manifest={version:1,source:'pica',sourceId:job.work.id,name:job.work.title,description:job.work.description,tags:job.work.tags,publication:job.work.finished?'completed':'ongoing',chapters:[],pages:{}}
      try{const stat=await fs.lstat(manifestFile);if(stat.isSymbolicLink()||stat.size>8*1024**2)throw new Error('下载清单不安全或过大');const saved=JSON.parse(await fs.readFile(manifestFile,'utf8'));if(saved.version!==1||saved.sourceId!==job.work.id||!Array.isArray(saved.chapters)||!saved.pages)throw new Error('目录已有其他作品的清单');manifest=saved}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw cause}
      for(const chapter of job.chapters){
        controller.signal.throwIfAborted()
        const relative=String(chapter.order).padStart(5,'0')+'-'+hash(chapter.id).slice(0,12),chapterDir=await realDirectory(path.join(directory,relative),root)
        const pages=await source.pages(job.work.id,chapter,controller.signal);if(!pages.length)throw new Error('来源章节没有可下载的页面')
        job.total+=pages.length;job.current=chapter.title;save(job)
        if(!manifest.chapters.some(c=>c.id===chapter.id))manifest.chapters.push({directory:relative,id:chapter.id,title:chapter.title,order:chapter.order})
        for(const [ordinal,page]of pages.entries()){
          controller.signal.throwIfAborted()
          const pageKey=chapter.id+':'+page.id,entry=manifest.pages[pageKey]
          let valid=false
          if(entry){const file=path.resolve(directory,entry.file),inside=path.relative(chapterDir,file);if(inside.includes(path.sep)||inside.startsWith('..')||path.isAbsolute(inside))throw new Error('下载清单中的页面路径无效');try{const stat=await fs.lstat(file);if(stat.isSymbolicLink()||stat.size>64*1024**2)throw new Error('已存在的页面不可安全读取');const bytes=await fs.readFile(file);imageMime(bytes);valid=hash(bytes)===entry.sha256}catch{valid=false}}
          if(!valid){
            const {data,extension}=await source.image(page.url,controller.signal);controller.signal.throwIfAborted()
            const filename=String(ordinal+1).padStart(5,'0')+'-'+hash(page.id).slice(0,12)+extension,file=path.join(chapterDir,filename),temporary=file+'.'+randomUUID()+'.part'
            await fs.writeFile(temporary,data,{flag:'wx'})
            try{try{const present=await fs.lstat(file);if(present.isSymbolicLink())throw new Error('目标页面是链接');await fs.rename(file,file+'.damaged-'+Date.now())}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw cause}await fs.rename(temporary,file)}catch(cause){await fs.unlink(temporary).catch(()=>{});throw cause}
            manifest.pages[pageKey]={file:path.relative(directory,file).replaceAll('\\','/'),sha256:hash(data)}
            await writeJson(manifestFile,manifest)
          }
          job.processed++;save(job)
        }
        job.completedChapters++;await writeJson(manifestFile,manifest)
        const scanned=(await scanImageImport(directory,'comic',false))[0],item=library.register(scanned)
        job.resourceId=item.id
        if(job.groupId)library.update(item.id,{groupId:job.groupId})
        save(job)
      }
      job.status='success';job.current='下载并入库完成';save(job)
    }catch(cause){job.status=controller.signal.aborted?'cancelled':'failed';job.error=controller.signal.aborted?'已停止，可重试剩余页':(cause as Error).message;save(job)}finally{controllers.delete(job.id)}
  }
  function pump(){if(pumping)return;pumping=(async()=>{let next:ImageDownloadJob|undefined;while((next=[...jobs.values()].find(j=>j.status==='queued')))await run(next)})().finally(()=>{pumping=null})}
  async function enqueue(work:ImageSourceWork,chapters:ImageSourceChapter[],root:string,groupId:string|null){
    if(!chapters.length)throw new Error('请先选择章节')
    if([...jobs.values()].some(j=>j.work.id===work.id&&['queued','running'].includes(j.status)))throw new Error('这部作品已有下载任务')
    if(groupId&&!library.groups().some(g=>g.id===groupId&&!g.hidden))throw new Error('下载类型不可用')
    const job:ImageDownloadJob={id:randomUUID(),work,chapters:chapters.slice().sort((a,b)=>a.order-b.order),root:await fs.realpath(root),groupId,status:'queued',processed:0,total:0,completedChapters:0,current:'等待下载',error:'',updatedAt:Date.now(),resourceId:''}
    jobs.set(job.id,job);save(job);pump();return structuredClone(job)
  }
  async function retry(id:string){const job=jobs.get(id);if(!job||!visible(job))throw new Error('任务不可用');if(['queued','running'].includes(job.status))return;job.status='queued';save(job);pump()}
  function cancel(id:string){const job=jobs.get(id);if(!job||!visible(job))return;if(job.status==='queued'){job.status='cancelled';save(job)}else controllers.get(id)?.abort()}
  function dismiss(id:string){const job=jobs.get(id);if(!job||!visible(job)||['queued','running'].includes(job.status))return;jobs.delete(id);db.prepare('DELETE FROM image_download_jobs WHERE id=?').run(id);deps.changed()}
  return {enqueue,retry,cancel,dismiss,list:()=>[...jobs.values()].filter(visible).sort((a,b)=>b.updatedAt-a.updatedAt).map(j=>structuredClone(j)),idle:async()=>{while(pumping)await pumping}}
}
