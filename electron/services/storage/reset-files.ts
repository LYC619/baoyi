import fs from 'node:fs/promises'
import path from 'node:path'

/** These are app-owned entries, never target paths read from jobs or settings. */
export async function removeProfileEntry(profile:string, entry:string){
  const root=path.resolve(profile),target=path.resolve(root,entry)
  const relative=path.relative(root,target)
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('重置路径不在资料目录内')
  let parent=root
  for(const part of relative.split(path.sep).slice(0,-1)){
    parent=path.join(parent,part)
    let stat
    try{stat=await fs.lstat(parent)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    if(stat.isSymbolicLink())throw new Error('缓存父目录是链接，未清理：'+parent)
  }
  await fs.rm(target,{recursive:true,force:true})
}
