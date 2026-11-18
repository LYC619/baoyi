import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readVideoBundle, resolveBundlePath } from './bundle.ts'
import type { VideoDirectory } from '../../../src/types/video-library.ts'

const digest=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function withoutLinks(root:string,target:string):boolean {
  let current=path.resolve(target)
  while(current!==root){if(!current.startsWith(root+path.sep)||fs.lstatSync(current).isSymbolicLink())return false;current=path.dirname(current)}
  return !fs.lstatSync(root).isSymbolicLink()
}
/** Only a bound bundle can authorize generated companion files. Unknown files never enter the removal set. */
export function videoCompanionFiles(binding:VideoDirectory) {
  const files:Array<{path:string;preserveReason?:string}>=[]
  const root=path.resolve(binding.path)
  if(root===path.parse(root).root || root===path.resolve(binding.root))return files
  try {
    if(fs.lstatSync(root).isSymbolicLink())return files
    const manifest=path.join(root,'baoyi.json')
    if(fs.lstatSync(manifest).isSymbolicLink())return files
    const bundle=readVideoBundle(root)
    if(!bundle || bundle.bundle_id!==binding.bundleId)return files
    files.push({path:manifest})
    for(const name of ['baoyi.json.bak','.baoyi-owner.json']) {
      const file=resolveBundlePath(root,name)
      try {
        const stat=fs.lstatSync(file)
        if(!stat.isFile()||!withoutLinks(root,file)||stat.size>8*1024**2)continue
        const saved=JSON.parse(fs.readFileSync(file,'utf8'))
        if((name.endsWith('.bak')?saved.schema_version===1&&saved.bundle_id:saved.bundleId)===binding.bundleId)files.push({path:file})
      }catch{/* Unverified companions stay. */}
    }
    for(const [relative,expected] of Object.entries(bundle.managed_files||{})) {
      try {
        const file=resolveBundlePath(root,relative)
        const stat=fs.lstatSync(file)
        if(!stat.isFile()||!withoutLinks(root,file)||stat.size>64*1024**2)continue
        files.push({path:file,...(digest(file)===expected?{}:{preserveReason:'用户已修改，保留'})})
      }catch{/* Missing or unsafe paths stay outside the deletion set. */}
    }
  }catch{/* An unreadable bundle cannot authorize cleanup. */}
  return files
}

/** Never recurse-delete a directory: remove only empty ancestors of the reviewed files. */
export function pruneVideoDirectories(roots:string[],files:string[]):void {
  for(const directory of roots) {
    const root=path.resolve(directory),candidates=new Set<string>([root,path.join(root,'.baoyi'),path.join(root,'.baoyi','artwork')])
    for(const file of files) {
      let parent=path.dirname(path.resolve(file))
      while(parent!==root && parent.startsWith(root+path.sep)){candidates.add(parent);parent=path.dirname(parent)}
    }
    for(const folder of [...candidates].sort((a,b)=>b.length-a.length)) {
      try {if(withoutLinks(root,folder) && fs.readdirSync(folder).length===0)fs.rmdirSync(folder)}catch { // best-effort
/* Nonempty, missing or busy directories are retained. */}
    }
  }
}
