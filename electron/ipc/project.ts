import { app, dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { getDb, getSettings } from '../services/database.ts'
import { assertLibraryIdle } from './library-backup.ts'
import { HENTAI_CATEGORY } from '../kinds/video/taxonomy.ts'
import { restoreWindowFocus } from '../services/window-focus.ts'
import { ProjectLibrary } from '../kinds/project/library.ts'
import { inspectProject, projectEntry, scanProjects } from '../kinds/project/scanner.ts'
import { assertProjectIdle, projectOperation } from '../kinds/project/activity.ts'
import { planProjectMove,executeProjectMove,projectMoveRecords,recoverProjectMove } from '../kinds/project/move.ts'
import { rebaseLibraryPaths } from '../kinds/project/paths.ts'
import { createProjectAgent,projectPreferences } from '../kinds/project/agent.ts'
import { projectOverview } from '../kinds/project/workspace.ts'
import type { ProjectCandidate,ProjectMovePlan,ProjectSource } from '../../src/types/project.ts'

export function registerProjectIpc(getWindow:()=>BrowserWindow|null,ipc:Pick<IpcMain,'handle'>):void {
  const library=()=>new ProjectLibrary(getDb()),journalDir=()=>path.join(app.getPath('userData'),'project-moves')
  const protectedPaths=()=>[app.getAppPath(),app.getPath('userData'),path.dirname(process.execPath)]
  let preview:{token:string;at:number;items:ProjectCandidate[]}|null=null, move:{token:string;plan:ProjectMovePlan}|null=null
  const changed=()=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('project:changed')}
  const pathsChanged=()=>{changed();const win=getWindow();if(win&&!win.isDestroyed()){win.webContents.send('image:changed');win.webContents.send('video:library-changed','')}}
  let agent:ReturnType<typeof createProjectAgent>|undefined,agentDb:ReturnType<typeof getDb>|undefined
  const assistant=()=>{
    if(!agent || agentDb!==getDb()){
      agentDb=getDb();agent=createProjectAgent({db:agentDb,config:()=>getSettings().ai,updated:changed,
        changed:session=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('project:session',session)}})
    }
    return agent
  }
  const handle=(name:string,action:(...args:any[])=>unknown)=>ipc.handle('project:'+name,(event:IpcMainInvokeEvent,...args:any[])=>{
    const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许主窗口操作项目库')
    return action(...args)
  })
  const pick=async(directory:boolean)=>{const result=await dialog.showOpenDialog(getWindow()!,{properties:directory?['openDirectory']:['openFile']});restoreWindowFocus(getWindow());return result.canceled?null:result.filePaths[0]||null}
  handle('pick-path',directory=>pick(!!directory))
  handle('list',()=>library().list());handle('get',id=>library().get(id))
  handle('overview',id=>{const item=library().get(id);if(!item)throw new Error('项目不存在');return projectOverview(item.path)})
  handle('preferences',value=>{if(value)assertProjectIdle();return projectPreferences(getDb(),value)})
  handle('sessions',id=>assistant().list(id));handle('session',id=>assistant().get(id))
  handle('create-session',id=>assistant().create(id))
  handle('send-message',(id,text)=>projectOperation(()=>assistant().send(id,text)))
  handle('cancel-message',id=>assistant().cancel(id))
  handle('apply-proposal',(id,messageId)=>{assertProjectIdle();return assistant().apply(id,messageId)})
  handle('update',(id,patch)=>{assertProjectIdle();const value=library().update(id,patch);changed();return value})
  handle('remove',id=>{assertProjectIdle();library().remove(id);changed()})
  const resourceSelect=`SELECT r.id,r.kind,r.path,COALESCE(NULLIF(r.name_zh,''),r.file_name) AS name FROM resource r
    WHERE r.kind!='project'
    AND NOT EXISTS(SELECT 1 FROM image_meta m JOIN image_groups g ON g.id=m.group_id WHERE m.resource_id=r.id AND g.hidden=1)
    AND NOT(r.kind='video' AND COALESCE(r.category,'')=? AND ?=1)`
  const availableResources=()=>getDb().prepare(resourceSelect+' ORDER BY r.name_zh LIMIT 5000').all(HENTAI_CATEGORY,Number(getSettings().hide_hentai))
  handle('resources',availableResources)
  handle('prepare-import',async mode=>{
    if(!['single','discover','file'].includes(mode))throw new Error('导入方式无效')
    assertProjectIdle();const root=await pick(mode!=='file');if(!root)return null
    return projectOperation(async()=>{const items=await scanProjects(root,mode==='discover'?'discover':'single');preview={token:randomUUID(),at:Date.now(),items};return {token:preview.token,root,items}})
  })
  handle('confirm-import',async(token:string,selected:Array<{index:number;name:string;category:string;source:ProjectSource;mergeInto?:number;existingId?:string}>)=>{
    assertProjectIdle();if(!preview||preview.token!==token||Date.now()-preview.at>30*60_000)throw new Error('导入预览已失效，请重新扫描')
    if(!Array.isArray(selected)||!selected.length||selected.length>200||selected.some(s=>!s||typeof s!=='object')||new Set(selected.map(s=>s.index)).size!==selected.length||selected.some(s=>!Number.isInteger(s.index)||!preview!.items[s.index]))throw new Error('选择的项目无效')
    if(selected.some(s=>typeof s.name!=='string'||typeof s.category!=='string'||(s.existingId!==undefined&&typeof s.existingId!=='string')||(s.mergeInto!==undefined&&(!Number.isInteger(s.mergeInto)||s.mergeInto===s.index||!selected.some(target=>target.index===s.mergeInto&&target.mergeInto===undefined)))))throw new Error('候选名称或合并目标无效，请重新选择')
    return projectOperation(async()=>{
    const current=preview!;preview=null;let imported=0;const errors:string[]=[],warnings:string[]=[]
    for(const item of selected.filter(s=>s.mergeInto===undefined)){
      try{
        const scan={...current.items[item.index],name:item.name,category:item.category,source:item.source}
        const associated=selected.filter(s=>s.mergeInto===item.index)
        scan.entries=[...scan.entries,...associated.flatMap(s=>current.items[s.index].entries)].filter((e,i,a)=>a.findIndex(x=>x.path===e.path&&x.type===e.type)===i)
        if(item.existingId){
          const existing=library().get(item.existingId);if(!existing)throw new Error('关联目标项目不存在')
          const entries=[...existing.entries,...scan.entries].filter((e,i,a)=>a.findIndex(x=>x.path.toLowerCase()===e.path.toLowerCase()&&x.type===e.type)===i)
          library().update(existing.id,{entries})
        }else {
          const existing=library().list().some(p=>p.path.toLowerCase()===scan.path.toLowerCase())
          const registered=library().register(scan,projectPreferences(getDb()).defaultState)
          if (!existing) assistant().recordImport(registered.id)
        }
        imported++
      }catch(error){errors.push(`${item.name}：${(error as Error).message}`)}
    }
    for(const item of selected.filter(s=>s.mergeInto!==undefined))if(!selected.some(s=>s.index===item.mergeInto&&s.mergeInto===undefined))errors.push(`${item.name}：合并目标未选中`)
    changed();return {imported,errors,warnings}
    })
  })
  handle('rescan',id=>projectOperation(async()=>{const item=library().get(id);if(!item)throw new Error('项目不存在');return inspectProject(item.path)}))
  handle('add-entry',async(id,directory)=>{assertProjectIdle();const file=await pick(!!directory);if(!file)return null;const item=library().get(id);if(!item)throw new Error('项目不存在');const updated=library().update(id,{entries:[...item.entries,projectEntry(file)]});changed();return updated})
  handle('open',async(id:string,entryId?:string)=>{
    assertProjectIdle();const item=library().get(id);if(!item)throw new Error('项目不存在')
    const entry=item.entries.find(e=>e.id===(entryId||item.defaultEntryId));if(!entry)throw new Error('请先设置打开入口')
    if(entry.resourceId){const linked=getDb().prepare(resourceSelect+' AND r.id=?').get(HENTAI_CATEGORY,Number(getSettings().hide_hentai),entry.resourceId) as {path:string}|undefined;if(!linked)throw new Error('关联资源已移除或隐藏，请重新选择入口');entry.path=linked.path}
    if(entry.type==='url')await shell.openExternal(entry.path)
    else {
      await fs.access(entry.path)
      if(entry.type==='obsidian')await shell.openExternal('obsidian://open?path='+encodeURIComponent(entry.path))
      else if(entry.type==='command'){
        if(!/\.exe$/i.test(entry.path))throw new Error('外部工具请选择 EXE 程序；脚本可使用文件入口')
        const root=await fs.stat(item.path).catch(()=>null)
        await new Promise<void>((resolve,reject)=>{const child=spawn(entry.path,entry.args,{cwd:entry.cwd||(root?.isDirectory()?item.path:path.dirname(item.path)),shell:false,detached:true,stdio:'ignore',windowsHide:true});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve()})})
      }else{
        if(/\.(bat|cmd|ps1|vbs|js|mjs|py|sh|lnk)$/i.test(entry.path)){
          const result=await dialog.showMessageBox(getWindow()!,{type:'question',title:'打开项目脚本',message:'按系统关联打开此脚本或快捷方式？',detail:entry.path,buttons:['取消','打开'],defaultId:0,cancelId:0});if(result.response!==1)return
        }
        const error=await shell.openPath(entry.path);if(error)throw new Error(error)
      }
    }
    library().opened(id);changed()
  })
  handle('reveal',(id:string)=>{const item=library().get(id);if(item)shell.showItemInFolder(item.path)})
  handle('relocate',async(id:string)=>{
    assertLibraryIdle();const item=library().get(id);if(!item)throw new Error('项目不存在')
    const oldExists=await fs.lstat(item.path).catch(()=>null);if(oldExists)throw new Error('原位置仍存在；需要改变位置请使用移动项目')
    const kind=await dialog.showMessageBox(getWindow()!,{type:'question',title:'重新定位项目',message:'项目的新主位置是文件夹还是文件？',detail:item.path,buttons:['文件夹','文件','取消'],defaultId:0,cancelId:2,noLink:true})
    restoreWindowFocus(getWindow());if(kind.response===2)return null
    const target=await pick(kind.response===0);if(!target)return null
    return projectOperation(async()=>{
      const current=library().get(id);if(!current||current.path!==item.path||await fs.lstat(item.path).catch(()=>null))throw new Error('项目位置已变化，请重新操作')
      const stat=await fs.lstat(target);if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))throw new Error('请选择实际项目文件或目录')
      getDb().exec('SAVEPOINT project_relocate')
      try{rebaseLibraryPaths(getDb(),item.path,target);getDb().prepare('UPDATE resource SET file_name=?,source_dir=?,updated_at=? WHERE id=?').run(path.basename(target),path.dirname(target),Date.now(),id);getDb().exec('RELEASE project_relocate')}
      catch(error){getDb().exec('ROLLBACK TO project_relocate; RELEASE project_relocate');throw error}
      pathsChanged();return library().get(id)
    })
  })
  handle('prepare-move',async(id:string)=>{const item=library().get(id);if(!item)throw new Error('项目不存在');const destinationParent=await pick(true);return destinationParent?{destinationParent,name:path.basename(item.path)}:null})
  handle('preview-move',async(id,destination,keepLink)=>{
    assertLibraryIdle();return projectOperation(async()=>{const plan=await planProjectMove(getDb(),id,destination,{keepLink:!!keepLink,protectedPaths:protectedPaths()});move={token:randomUUID(),plan};return move})
  })
  handle('move',async token=>{
    assertLibraryIdle();if(!move||move.token!==token)throw new Error('移动预览已失效');const current=move;move=null
    return projectOperation(async()=>{try{const result=await executeProjectMove(getDb(),current.plan,{journalDir:journalDir(),protectedPaths:protectedPaths(),trash:file=>shell.trashItem(file)});return {item:library().get(current.plan.id),warnings:result.warnings}}finally{pathsChanged()}})
  })
  handle('move-records',()=>projectMoveRecords(journalDir()))
  handle('recover-move',id=>{assertLibraryIdle();return projectOperation(async()=>{const message=await recoverProjectMove(getDb(),journalDir(),id);pathsChanged();return message})})
}
