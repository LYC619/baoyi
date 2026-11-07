import fs from 'node:fs'
import path from 'node:path'
import type {SqlDb} from '../../services/schema.ts'

/** Only this disposable index is rebuilt; media and the library DB never enter this path. */
export function openFrameIndex<T extends SqlDb & {close:()=>void}>(root:string,open:(file:string)=>T):T{
  const file=path.join(root,'index.sqlite')
  let db:T|undefined
  try{
    db=open(file)
    const checks=db.prepare('PRAGMA quick_check').all() as Array<{quick_check:string}>
    if(checks.some(row=>row.quick_check!=='ok'))throw Object.assign(new Error('预览缓存索引损坏'),{code:'SQLITE_CORRUPT'})
    return db
  }catch(error){
    db?.close()
    const code=(error as {code?:string;errcode?:number}).code,numeric=(error as {errcode?:number}).errcode
    if(!['SQLITE_CORRUPT','SQLITE_NOTADB'].includes(code||'')&&numeric!==11&&numeric!==26)throw error
    for(const suffix of ['','-wal','-shm'])fs.rmSync(file+suffix,{force:true})
    return open(file)
  }
}
