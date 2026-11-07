import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DestinationExistsError, checkContainer, safeDownloadError } from './transfer.ts'

export function assertStreamDestination(destination: string): void {
  if(!path.isAbsolute(destination)) throw new Error('下载保存位置必须是绝对路径')
  try { fs.lstatSync(destination); throw new DestinationExistsError('目标文件已存在，未覆盖') }
  catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error }
}
/** Own the workspace lock and output; keep verified fragments after interruption. */
export async function withStreamOutput<T extends {warnings:string[];receivedBytes:number;totalBytes:number}>(destination: string, kind: string, signal: AbortSignal,
  run: (workspace: string, temporary: string) => Promise<T>): Promise<T> {
  signal.throwIfAborted(); assertStreamDestination(destination)
  const workspace=path.join(path.dirname(destination),'.'+path.basename(destination)+'.baoyi-'+kind)
  try { if(fs.lstatSync(workspace).isSymbolicLink()) throw new Error('分片临时目录不能是链接') } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error }
  const lockFile=workspace+'.lock'
  try {
    const previous=JSON.parse(fs.readFileSync(lockFile,'utf8'))
    if(Number.isSafeInteger(previous.pid) && previous.pid>0){
      try{process.kill(previous.pid,0)}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')fs.unlinkSync(lockFile)}
    }
  }catch{ /* An unreadable or live lock is never removed. */ }
  let lock: number
  try { lock=fs.openSync(lockFile,'wx',0o600) } catch(error) { if((error as NodeJS.ErrnoException).code==='EEXIST') throw new Error('同一视频正在下载或有残留下载锁，请确认其他任务已停止'); throw error }
  const temporary=path.join(path.dirname(destination),'.'+path.basename(destination)+'.'+randomUUID()+'.baoyi-part.mp4')
  const warnings:string[]=[]
  let result:T|undefined,failure:unknown,published=false
  try {
    fs.writeSync(lock,JSON.stringify({pid:process.pid}))
    result=await run(workspace,temporary)
    signal.throwIfAborted()
    const file=fs.openSync(temporary,'r+')
    try {
      const head=Buffer.alloc(32); const count=fs.readSync(file,head,0,32,0); checkContainer(head.subarray(0,count)); fs.fsyncSync(file)
      // Remuxing changes the container size; library metadata must describe the published file.
      result.receivedBytes=fs.fstatSync(file).size;result.totalBytes=result.receivedBytes
    } finally { fs.closeSync(file) }
    try { fs.linkSync(temporary,destination) } catch(error) { if((error as NodeJS.ErrnoException).code==='EEXIST') throw new DestinationExistsError('目标文件在下载期间已存在，未覆盖'); throw error }
    published=true
    // Publication is the commit point; a late cancel does not undo the saved file.
    try { fs.rmSync(workspace,{recursive:true,force:true}) } catch(error) { warnings.push('分片临时目录待清理：'+safeDownloadError(error)) }
  } catch(error) { failure=error }
  finally {
    for(const cleanup of [()=>fs.rmSync(temporary,{force:true}),()=>fs.closeSync(lock),()=>fs.unlinkSync(lockFile)]){
      try{cleanup()}catch(error){warnings.push('下载临时文件待清理：'+safeDownloadError(error))}
    }
  }
  if(!published){
    let cachedBytes=0
    const size=(dir:string)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())size(file);else if(entry.isFile())cachedBytes+=fs.statSync(file).size}}
    try{size(workspace)}catch{/* Missing cache is not an additional failure. */}
    const cache=cachedBytes>0?'；保留 '+(cachedBytes/1048576).toFixed(1)+' MB 下载缓存，重试前会校验，成功后自动清理':''
    if(failure instanceof Error && !warnings.length){failure.message=safeDownloadError(failure)+cache;throw failure}
    throw new Error([safeDownloadError(failure),...warnings].join('；')+cache)
  }
  result!.warnings.push(...warnings)
  return result!
}
