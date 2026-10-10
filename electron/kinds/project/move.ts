import fs from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { ProjectMovePlan, ProjectMoveRecord } from '../../../src/types/project.ts'
import { ProjectLibrary } from './library.ts'
import { rebaseLibraryPaths, samePath, within } from './paths.ts'

type MoveOptions={keepLink?:boolean;protectedPaths?:string[]}
type ExecuteOptions={journalDir:string;protectedPaths?:string[];trash?:(file:string)=>Promise<void>;rename?:typeof fs.rename;beforeCommit?:()=>void}
const info=(file:string)=>fs.lstat(file).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error})
const identity=(s:NonNullable<Awaited<ReturnType<typeof info>>>)=>`${s.dev}:${s.ino}:${s.birthtimeMs}`
async function guardTree(root:string):Promise<void>{
  let visited=0
  async function visit(dir:string):Promise<void>{
    if(++visited>50_000)throw new Error('目录过多，请先缩小项目范围')
    for(const e of await fs.readdir(dir,{withFileTypes:true})){
      if(e.name==='.git'){
        if(!e.isDirectory())throw new Error('Git 外部工作树请使用 Git 的 worktree move 命令迁移')
        const git=path.join(dir,e.name)
        if(await info(path.join(git,'worktrees')))throw new Error('项目仍关联 Git 工作树，请先在 Git 中处理工作树')
        const config=await fs.readFile(path.join(git,'config'),'utf8').catch(()=> '')
        if(/^\s*worktree\s*=/mi.test(config))throw new Error('Git 工作树使用了外部路径，请先处理')
      }else if(e.isDirectory()&&!e.isSymbolicLink()&&!['node_modules','.venv','venv','.git','.cache'].includes(e.name))await visit(path.join(dir,e.name))
    }
  }
  await visit(root)
}
export async function planProjectMove(db:SqlDb,id:string,destination:string,options:MoveOptions={}):Promise<ProjectMovePlan>{
  const item=new ProjectLibrary(db).get(id);if(!item)throw new Error('项目不存在')
  if(typeof destination!=='string'||!path.isAbsolute(destination)||destination.includes('\0'))throw new Error('目标必须是完整路径')
  const source=path.resolve(item.path),target=path.resolve(destination),stat=await info(source)
  if(!stat)throw new Error('项目位置失效，请先重新定位')
  if(stat.isSymbolicLink()||!samePath(await fs.realpath(source),source))throw new Error('请定位到项目实际目录后再移动')
  if(samePath(source,path.parse(source).root))throw new Error('不能移动磁盘根目录')
  if(within(source,target))throw new Error('不能移动到自身或自己的子目录')
  if(within(target,source))throw new Error('目标不能是项目的上级目录')
  if(await info(target))throw new Error('目标已经存在，请选择新的文件夹名称')
  const parent=path.dirname(target),parentStat=await info(parent)
  if(!parentStat?.isDirectory()||parentStat.isSymbolicLink()||!samePath(await fs.realpath(parent),parent))throw new Error('目标父目录必须是已存在的实际目录')
  const name=path.basename(target)
  if(/[<>:"|?*\x00-\x1f]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw new Error('目标名称不能用于 Windows 文件夹')
  for(const protectedPath of options.protectedPaths||[])if(protectedPath&&(within(source,path.resolve(protectedPath))||within(protectedPath,source)||samePath(target,protectedPath)||within(protectedPath,target)))throw new Error('项目涉及正在使用的程序、资料库或受保护目录，请从其他位置运行抱一后重试')
  if(stat.isDirectory())await guardTree(source)
  const related=db.prepare('SELECT id,path FROM resource').all() as {id:string;path:string}[]
  const externalEntries=item.entries.filter(e=>e.type!=='url'&&!within(source,e.path)).length
  const keepLink=stat.isDirectory()&&(options.keepLink??true)
  return {id,source,destination:target,keepLink,directory:stat.isDirectory(),createdAt:Date.now(),sourceIdentity:identity(stat),affected:related.filter(r=>within(source,r.path)).length,externalEntries,warnings:[
    '请先关闭正在编辑、运行或同步此项目的外部程序。系统占用或文件变化可能导致移动失败。',
    keepLink?'旧位置保留目录入口，已有绝对路径可继续经旧入口访问。':'旧位置将失效；项目脚本、快捷方式和外部笔记中的绝对路径需要自行调整。',
    ...(externalEntries?[`${externalEntries} 个外部参考入口保持原位置。`]:[])
  ]}
}
async function digest(file:string):Promise<string>{const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex')}
async function manifest(root:string):Promise<string>{
  const h=createHash('sha256')
  async function walk(file:string):Promise<void>{
    const s=await fs.lstat(file),rel=path.relative(root,file)
    if(s.isSymbolicLink())h.update(JSON.stringify([rel,'link',await fs.readlink(file)]))
    else if(s.isDirectory()){h.update(JSON.stringify([rel,'dir']));for(const name of (await fs.readdir(file)).sort())await walk(path.join(file,name))}
    else if(s.isFile())h.update(JSON.stringify([rel,s.size,await digest(file)]))
    else throw new Error('项目包含不支持的特殊文件')
  }
  await walk(root);return h.digest('hex')
}
async function copyProject(source:string,target:string):Promise<void>{
  const s=await fs.lstat(source)
  if(s.isSymbolicLink()){
    const link=await fs.readlink(source),directory=(await fs.stat(source)).isDirectory()
    // Windows cp recreates junctions as privileged symlinks. Preserve directory junction semantics.
    await fs.symlink(directory?path.resolve(path.dirname(source),link):link,target,directory?'junction':'file')
  }else if(s.isDirectory()){
    await fs.mkdir(target)
    for(const name of await fs.readdir(source))await copyProject(path.join(source,name),path.join(target,name))
  }else if(s.isFile()){await fs.copyFile(source,target,constants.COPYFILE_EXCL);await fs.utimes(target,s.atime,s.mtime)}
  else throw new Error('项目包含不支持的特殊文件')
}
async function saveRecord(dir:string,record:ProjectMoveRecord):Promise<void>{
  await fs.mkdir(dir,{recursive:true});record.updatedAt=Date.now()
  const target=path.join(dir,record.id+'.json'),temp=target+'.tmp'
  const file=await fs.open(temp,'w');try{await file.writeFile(JSON.stringify(record,null,2),'utf8');await file.sync()}finally{await file.close()}
  await fs.rename(temp,target)
}
function commitPaths(db:SqlDb,source:string,target:string,id:string):void{
  db.exec('SAVEPOINT project_move')
  try{rebaseLibraryPaths(db,source,target);db.prepare('UPDATE resource SET file_name=?,source_dir=?,updated_at=? WHERE id=?').run(path.basename(target),path.dirname(target),Date.now(),id);db.exec('RELEASE project_move')}
  catch(error){db.exec('ROLLBACK TO project_move; RELEASE project_move');throw error}
}
export async function executeProjectMove(db:SqlDb,plan:ProjectMovePlan,options:ExecuteOptions):Promise<{warnings:string[]}>{
  if(Date.now()-plan.createdAt>10*60_000)throw new Error('移动预览已过期，请重新预览')
  const fresh=await planProjectMove(db,plan.id,plan.destination,{keepLink:plan.keepLink,protectedPaths:options.protectedPaths})
  if(!samePath(fresh.source,plan.source)||fresh.sourceIdentity!==plan.sourceIdentity)throw new Error('项目位置已变化，请重新预览')
  if(within(plan.source,path.resolve(options.journalDir)))throw new Error('恢复记录必须保存在项目之外')
  const record:ProjectMoveRecord={id:randomUUID(),projectId:plan.id,source:plan.source,destination:plan.destination,stage:plan.destination+'.baoyi-moving-'+randomUUID(),keepLink:plan.keepLink,phase:'prepared',copied:false,createdAt:Date.now(),updatedAt:Date.now(),error:'',sourceIdentity:plan.sourceIdentity,fingerprint:'',destinationIdentity:''}
  const warnings:string[]=[],rename=options.rename||fs.rename
  await saveRecord(options.journalDir,record)
  let placed=false,committed=false
  try{
    try{
      if(!plan.directory)throw Object.assign(new Error('文件使用排他复制提交，避免覆盖竞争目标'),{code:'EXDEV'})
      await rename(record.source,record.destination);placed=true
    }
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EXDEV')throw error
      record.copied=true;await saveRecord(options.journalDir,record)
      const before=await manifest(record.source);record.fingerprint=before;await saveRecord(options.journalDir,record)
      await copyProject(record.source,record.stage)
      if(before!==await manifest(record.stage)||before!==await manifest(record.source))throw new Error('复制核验失败或源文件发生变化，原项目和暂存文件已保留')
      record.phase='copied';await saveRecord(options.journalDir,record)
      if(await info(record.destination))throw new Error('目标在复制期间被占用，原项目和暂存文件已保留')
      if(plan.directory)await fs.rename(record.stage,record.destination)
      else {await fs.copyFile(record.stage,record.destination,constants.COPYFILE_EXCL);await fs.unlink(record.stage)}
      placed=true
    }
    record.destinationIdentity=identity((await info(record.destination))!);record.phase='placed';await saveRecord(options.journalDir,record)
    options.beforeCommit?.()
    commitPaths(db,record.source,record.destination,record.projectId);committed=true
    record.phase='committed';await saveRecord(options.journalDir,record)
    if(record.copied){
      if(options.trash){try{
        if(await manifest(record.source)!==record.fingerprint)warnings.push('复制后原项目又有修改，旧副本已保留，请核对两处内容：'+record.source)
        else await options.trash(record.source)
      }catch{warnings.push('新位置已生效，旧副本未能核验或放入回收站：'+record.source)}}
      else warnings.push('新位置已生效，旧副本保留在：'+record.source)
    }
    if(record.keepLink&&!(await info(record.source))){try{await fs.symlink(record.destination,record.source,'junction')}catch{warnings.push('项目已移动，但旧位置入口建立失败；请修正外部链接')}}
    record.phase='done';record.error=warnings.join('\n');await saveRecord(options.journalDir,record)
    return {warnings}
  }catch(error){
    record.error=(error as Error).message
    if(!committed&&placed&&!record.copied){
      try{if(await info(record.source))throw new Error('原位置已被占用');await fs.rename(record.destination,record.source);record.phase='rolled-back'}
      catch(rollback){record.phase='attention';record.error+='；回退失败：'+(rollback as Error).message}
    }else record.phase=committed||placed||record.copied?'attention':'rolled-back'
    await saveRecord(options.journalDir,record).catch(()=>{})
    throw new Error(record.error+(record.phase==='attention'?'。文件已保留，请在移动记录中恢复；新位置：'+record.destination:''))
  }
}
export async function projectMoveRecords(dir:string):Promise<ProjectMoveRecord[]>{
  const result:ProjectMoveRecord[]=[]
  for(const name of await fs.readdir(dir).catch(()=>[]))if(/^[a-f0-9-]+\.json$/.test(name)){
    try{const r=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));if(r.id+'.json'===name&&path.isAbsolute(r.source)&&path.isAbsolute(r.destination))result.push(r)}catch{}
  }
  return result.sort((a,b)=>b.createdAt-a.createdAt)
}
/** Reconcile persisted file locations; never delete either copy during recovery. */
export async function recoverProjectMove(db:SqlDb,dir:string,id:string):Promise<string>{
  const record=(await projectMoveRecords(dir)).find(r=>r.id===id);if(!record)throw new Error('找不到恢复记录')
  if(['done','rolled-back'].includes(record.phase))return '此记录已完成'
  const item=new ProjectLibrary(db).get(record.projectId);if(!item)throw new Error('项目已从资料库移除，请先核对磁盘位置')
  const source=await info(record.source),target=await info(record.destination)
  if(target&&(target.isSymbolicLink()||(!record.copied&&identity(target)!==record.sourceIdentity)||(record.destinationIdentity&&identity(target)!==record.destinationIdentity)))throw new Error('新位置内容身份已改变，未自动恢复，请手动核对')
  if(source&&!source.isSymbolicLink()&&identity(source)!==record.sourceIdentity)throw new Error('旧位置已被其他内容占用，未自动恢复')
  if(source?.isSymbolicLink()&&(!target||!samePath(await fs.realpath(record.source),await fs.realpath(record.destination))))throw new Error('旧位置链接指向其他内容，未自动恢复')
  // A copied destination has a new filesystem identity. Verify its content before adopting it.
  if(target&&record.copied&&samePath(item.path,record.source)&&(!record.fingerprint||await manifest(record.destination)!==record.fingerprint))throw new Error('新位置内容核验不一致，未自动恢复，请手动核对')
  if(target&&samePath(item.path,record.destination)){record.phase='done';record.error=source&&!source.isSymbolicLink()?'原副本仍保留，请核对后自行清理：'+record.source:''}
  else if(source&&!source.isSymbolicLink()&&!target&&samePath(item.path,record.source)){record.phase='rolled-back';record.error='原项目保留。若有暂存副本，请核对后清理：'+record.stage}
  else if(target&&!source&&samePath(item.path,record.source)){commitPaths(db,record.source,record.destination,record.projectId);record.phase='done';record.error=''}
  else if(target&&source&&!source.isSymbolicLink()&&record.copied&&samePath(item.path,record.source)){record.phase='rolled-back';record.error='复制后未提交，资料库仍使用原项目。新副本保留供核对：'+record.destination}
  else throw new Error('位置与记录不一致，请手动核对；为保留资料未作更改')
  if(record.phase==='done'&&record.keepLink&&!source&&target?.isDirectory())await fs.symlink(record.destination,record.source,'junction').catch(()=>{record.error='旧位置入口未建立'})
  await saveRecord(dir,record);return record.error||'恢复核对完成'
}
