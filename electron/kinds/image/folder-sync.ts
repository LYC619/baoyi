import fs, { type FSWatcher } from 'node:fs'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { ImageLibrary } from './library.ts'
import { scanImageImport } from './scanner.ts'
import { imageLibraryBusy } from './activity.ts'
import type { SqlDb } from '../../services/schema.ts'
import type { ImageType } from '../../../src/types/image.ts'

type Target={id:string;path:string;type:ImageType;updated_at:number}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Track registered photo folders only. Removing an index must not silently import it again. */
export class PhotoFolderSync {
  private getDb:()=>SqlDb
  private changed:()=>void
  private watchers=new Map<string,FSWatcher>()
  private snapshots=new Map<string,string>()
  private candidates=new Map<string,string>()
  private timer:ReturnType<typeof setTimeout>|undefined
  private interval:ReturnType<typeof setInterval>|undefined
  private stopped=false
  private running=false
  constructor(getDb:()=>SqlDb,changed:()=>void){this.getDb=getDb;this.changed=changed}
  start(){this.request();this.interval=setInterval(()=>this.request(),15000);this.interval.unref()}
  request(){if(this.stopped)return;if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=undefined;void this.sync().catch(()=>{/* Retry at the next interval. */})},1200);this.timer.unref()}
  stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);if(this.interval)clearInterval(this.interval);for(const watcher of this.watchers.values())watcher.close();this.watchers.clear()}
  async sync():Promise<number> {
    if(this.stopped||this.running||imageLibraryBusy())return 0
    this.running=true
    let updated=0
    try {
      const db=this.getDb(),library=new ImageLibrary(db)
      const targets=db.prepare(`SELECT r.id,r.path,r.updated_at,m.item_type AS type FROM resource r JOIN image_meta m ON m.resource_id=r.id WHERE m.item_type IN ('photo','misc') AND (m.group_id IS NULL OR NOT EXISTS(SELECT 1 FROM image_groups g WHERE g.id=m.group_id AND g.hidden=1))`).all() as Target[]
      const active=new Set(targets.map(t=>t.path))
      for(const [folder,watcher] of this.watchers)if(!active.has(folder)){watcher.close();this.watchers.delete(folder)}
      for(const id of this.snapshots.keys())if(!targets.some(t=>t.id===id)){this.snapshots.delete(id);this.candidates.delete(id)}
      for(const target of targets) {
        if(this.stopped||imageLibraryBusy())break
        try {
          const stat=await fsp.lstat(target.path)
          if(this.stopped)break
          if(!stat.isDirectory()||stat.isSymbolicLink())continue
          if(!this.watchers.has(target.path))try {
            const watcher=fs.watch(target.path,{recursive:true},()=>this.request())
            watcher.on('error',()=>{watcher.close();this.watchers.delete(target.path)})
            watcher.unref();this.watchers.set(target.path,watcher)
          }catch{/* Timed scans also cover unsupported or temporarily offline watchers. */}
          const scan=(await scanImageImport(target.path,target.type,false))[0]
          // Never interpret an incomplete or unreadable traversal as deleted pictures.
          if(scan.warnings.some(w=>w!=='没有找到可导入的图片'))continue
          const pages=scan.chapters.flatMap(c=>c.pages)
          const stats=new Map<string,fs.Stats>()
          for(const page of pages)if(!stats.has(page.file))stats.set(page.file,await fsp.stat(page.file))
          const fingerprint=hash([target.path,pages.map(p=>[p.file,p.entry,p.size,stats.get(p.file)!.mtimeMs])])
          if(this.stopped||imageLibraryBusy())break
          if(this.snapshots.get(target.id)===fingerprint){this.candidates.delete(target.id);continue}
          const current=library.get(target.id)
          if(!current || current.path!==target.path || current.updatedAt!==target.updated_at)continue
          if(!this.snapshots.has(target.id)) {
            const old=library.pages(target.id).map(p=>[p.file,p.entry,p.size])
            const newest=Math.max(0,...[...stats.values()].map(s=>s.mtimeMs))
            if(hash(old)===hash(pages.map(p=>[p.file,p.entry,p.size]))&&newest<=target.updated_at){this.snapshots.set(target.id,fingerprint);continue}
          }
          // Two matching observations keep in-progress copies out of the index.
          if(this.candidates.get(target.id)!==fingerprint){this.candidates.set(target.id,fingerprint);this.request();continue}
          library.register(scan)
          this.snapshots.set(target.id,fingerprint);this.candidates.delete(target.id);updated++
        }catch{/* Keep the current index on offline roots, locked files and failed scans. */}
      }
      if(updated&&!this.stopped)this.changed()
      return updated
    }finally{this.running=false}
  }
}
