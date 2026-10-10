import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'
import { LIBRARY_BACKUP_COLUMNS } from '../../../src/types/library-backup.ts'

export const samePath=(a:string,b:string)=>path.resolve(a).toLocaleLowerCase()===path.resolve(b).toLocaleLowerCase()
export function within(root:string,file:string):boolean {
  if(!path.isAbsolute(file))return false
  const rel=path.relative(path.resolve(root).toLowerCase(),path.resolve(file).toLowerCase())
  return rel!== '..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)
}
export function rebasePath(file:string,source:string,target:string):string {
  return file&&within(source,file)?path.join(target,path.relative(source,file)):file
}
function rebaseJson(value:unknown,source:string,target:string,key=''):unknown {
  if(typeof value==='string')return /^(path|file|dir|root|cwd|args|from|to|target|destination|output|.*_path|.*Path|.*Dir|.*Directory)$/.test(key)?rebasePath(value,source,target):value
  if(Array.isArray(value))return value.map(v=>rebaseJson(v,source,target,key))
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rebaseJson(v,source,target,k)]))
  return value
}
const jsonColumns=new Set(['entries','launchers','save_paths','linked_files','parts','payload','audio_tracks','subtitle_tracks'])
/** Only registered path fields and structured references change; user prose and scripts never do. */
export function rebaseLibraryPaths(db:SqlDb,source:string,target:string):number {
  let affected=0
  for(const [table,shape] of Object.entries(LIBRARY_BACKUP_COLUMNS)){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue
    const columns=Object.keys(shape).filter(c=>/(?:^path$|_path$|^source_dir$|^dir$|^root$|^directory_path$|^file$|^backup_dir$|^link_target$|^scan_unit_id$)/.test(c)||jsonColumns.has(c))
    if(!columns.length)continue
    for(const row of db.prepare(`SELECT rowid AS __rowid,${columns.map(c=>'"'+c+'"').join(',')} FROM "${table}"`).all() as Record<string,any>[]){
      const values:unknown[]=[],changed:string[]=[]
      for(const column of columns){
        const old=row[column];if(typeof old!=='string'||!old)continue
        let next=old
        if(jsonColumns.has(column)){try{next=JSON.stringify(rebaseJson(JSON.parse(old),source,target))}catch{continue}}
        else next=rebasePath(old,source,target)
        if(old!==next){changed.push('"'+column+'"=?');values.push(next)}
      }
      if(changed.length){db.prepare(`UPDATE "${table}" SET ${changed.join(',')} WHERE rowid=?`).run(...values,row.__rowid);affected++}
    }
  }
  return affected
}
