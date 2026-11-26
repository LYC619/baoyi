import { tr } from '../services/system/language.ts'
import { app, dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn,execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { getDb } from '../services/storage/database.ts'
import { getSettings } from '../services/storage/settings-store.ts'
import { assertLibraryIdle } from './library-backup.ts'
import { HENTAI_CATEGORY } from '../kinds/video/taxonomy.ts'
import { restoreWindowFocus } from '../services/system/window-focus.ts'
import { ProjectLibrary } from '../kinds/project/library.ts'
import { inspectProject, projectEntry, scanProjects } from '../kinds/project/scanner.ts'
import { assertProjectIdle, projectOperation,projectLibraryBusy,observeProjectRuns,assertProjectRunsStopped } from '../kinds/project/activity.ts'
import { ProjectLaunchProfiles,loopbackUrl } from '../kinds/project/launch-profiles.ts'
import { previewProjectLaunch } from '../kinds/project/launch-resolution.ts'
import {ProjectApplications} from '../kinds/project/applications.ts'
import {projectRuleStatus} from '../kinds/project/rule-status.ts'
import {TimelineLibrary} from '../workspace/timeline.ts'
import {projectGitCache} from '../kinds/project/git-status.ts'
import { ProjectRuns } from '../kinds/project/runs.ts'
import { workspaceBusy } from '../workspace/activity.ts'
import { ProjectAutomation } from '../workspace/project-automation.ts'
import { planProjectMove,executeProjectMove,projectMoveRecords,recoverProjectMove } from '../kinds/project/move.ts'
import { rebaseLibraryPaths } from '../kinds/project/paths.ts'
import { createProjectAgent,projectPreferences } from '../kinds/project/agent.ts'
import { projectOverview,listProjectFilesPage,readProjectTextPage,resolveProjectFile,discoverProjectScripts } from '../kinds/project/workspace.ts'
import {projectTerminalLaunch} from '../kinds/project/terminal.ts'
import {ModulePreferences} from '../workspace/preferences.ts'
import { ProjectSummaries } from '../workspace/project-summaries.ts'
import type { ProjectCandidate,ProjectMovePlan,ProjectSource } from '../../src/types/project.ts'
import { optBool, optId, optRecord, optString, optStringArray, reqId, reqNumber, reqRecord, reqString } from './validate.ts'

export function registerProjectIpc(getWindow:()=>BrowserWindow|null,ipc:Pick<IpcMain,'handle'>) {
  const library=()=>new ProjectLibrary(getDb()),journalDir=()=>path.join(app.getPath('userData'),'project-moves')
  const protectedPaths=()=>[app.getAppPath(),app.getPath('userData'),path.dirname(process.execPath)]
  let preview:{token:string;at:number;items:ProjectCandidate[]}|null=null, move:{token:string;plan:ProjectMovePlan}|null=null
  const changed=()=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('project:changed')}
  const pathsChanged=()=>{changed();const win=getWindow();if(win&&!win.isDestroyed()){win.webContents.send('image:changed');win.webContents.send('video:library-changed','')}}
  let agent:ReturnType<typeof createProjectAgent>|undefined,agentDb:ReturnType<typeof getDb>|undefined
  let automation:ProjectAutomation|undefined
  const assistant=()=>{
    if(!agent || agentDb!==getDb()){
      agent?.dispose();automation?.stop()
      agentDb=getDb();agent=createProjectAgent({db:agentDb,config:()=>new ModulePreferences(getDb(),() => getSettings(getDb())).config('project'),updated:()=>{changed();const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('workspace:changed')},execute:action=>projectOperation(action),
        completed:session=>{automation?.completed(session.projectId,session.workflow!.head);changed()},paused:session=>automation?.failed(session.projectId,session.error),
        changed:session=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('project:session',session)}})
      automation=new ProjectAutomation(agentDb,{busy:()=>!!agent?.busy()||projectLibraryBusy()||workspaceBusy()||!new ModulePreferences(getDb(),() => getSettings(getDb())).config('project').enabled,
        start:async(id,after)=>agent!.organize(id,after||undefined).id})
    }
    return agent
  }
  let checking:Promise<void>|undefined
  const monitor=setInterval(()=>{try{if(!checking){assistant();checking=automation?.tick().catch(cause=>console.error('[项目后台检查]',cause)).finally(()=>{checking=undefined})}}catch(cause){console.error('[项目后台检查]',cause)}},20000)
  monitor.unref?.()
  const handle=(name:string,action:(...args:any[])=>unknown)=>ipc.handle('project:'+name,(event:IpcMainInvokeEvent,...args:any[])=>{
    const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许主窗口操作项目库')
    return action(...args)
  })
  const runs=new ProjectRuns({db:getDb,directory:path.join(app.getPath('userData'),'project-runs'),python:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'hermes-runtime':'output/hermes-runtime','python/python.exe'),supervisor:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'project-runner':'resources/project-runner','supervisor.py'),changed:run=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('project:run',run)}})
  observeProjectRuns(id=>runs.running(id))
  const launchProfiles=()=>new ProjectLaunchProfiles(getDb())
  handle('launch:profiles',id=>launchProfiles().list(reqId(id)))
  handle('launch:save',(id,input)=>{assertLibraryIdle();const value=launchProfiles().save(reqId(id),reqRecord(input,'input') as any);changed();return value})
  handle('launch:remove',(id,profile,revision)=>{assertLibraryIdle();const safeId=reqId(id);assertProjectRunsStopped(safeId);launchProfiles().remove(safeId,reqId(profile,'profile'),reqNumber(revision,'revision',{min:0,integer:true}));changed()})
  handle('launch:revoke',(id,profile)=>{assertLibraryIdle();const value=launchProfiles().revoke(reqId(id),reqId(profile,'profile'));changed();return value})
  handle('launch:preview',(id,profile)=>previewProjectLaunch(getDb(),reqId(id),reqId(profile,'profile')))
  handle('launch:start',(id,profile,approval)=>{assertLibraryIdle();assertProjectIdle();return runs.start(reqId(id),reqId(profile,'profile'),optRecord(approval,'approval') as any)})
  handle('launch:runs',id=>runs.list(optId(id)))
  handle('launch:stop',id=>runs.stop(reqId(id)))
  handle('launch:open-preview',async(id,profileId,runId)=>{
    id=reqId(id);profileId=reqId(profileId,'profileId');runId=optId(runId,'runId');const profile=launchProfiles().get(id,profileId),run=runId?(await runs.list(id)).find(r=>r.id===runId&&r.profileId===profileId):null
    if(runId&&(!run||run.status!=='running'))throw new Error('此命令已停止，请先重跑')
    const value=run?.previewUrl||profile.url||(profile.port?`http://127.0.0.1:${profile.port}/`:'')
    if(!value)throw new Error('尚未检测到服务端口，可在配置中填写预览地址')
    const url=loopbackUrl(value)
    try{await fetch(url,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(1500)})}catch{throw new Error('预览服务还没有响应，请等待启动完成后再打开')}
    await shell.openExternal(url)
  })
  const confirmQuit=async()=>{
      if(!runs.busy)return true
      const options={type:'question' as const,title:tr("项目命令仍在运行"),message:tr("停止项目命令并退出抱一？"),detail:tr("独立终端不受影响。托管命令会先正常停止，五秒后结束仍未退出的关联程序。"),buttons:[tr("停止任务并退出"),tr("返回")],defaultId:1,cancelId:1,noLink:true}
      const win=getWindow(),result=win?await dialog.showMessageBox(win,options):await dialog.showMessageBox(options)
      return result.response===0
  }
  const pick=async(directory:boolean)=>{const result=await dialog.showOpenDialog(getWindow()!,{properties:directory?['openDirectory']:['openFile']});restoreWindowFocus(getWindow());return result.canceled?null:result.filePaths[0]||null}
  handle('pick-path',directory=>pick(!!directory))
  let gitDb=getDb()
  const cardGit=new Map<string,{root:string;git:import('../../src/types/project.ts').ProjectGitStatus}>()
  const checkGitDb=()=>{if(gitDb!==getDb()){gitDb=getDb();cardGit.clear();projectGitCache.clear()}}
  const gitOptions=(id:string,root:string,options:{repoPath?:string;refresh?:boolean}={})=>{
    checkGitDb()
    if(options.repoPath!==undefined&&typeof options.repoPath!=='string')throw new Error('仓库相对目录无效')
    let selected=''
    const repositoryJson=(getDb().prepare('SELECT value FROM settings WHERE key=?').get('project_repository:'+id) as {value:string})?.value||'null'
    try{const saved=JSON.parse(repositoryJson);if(saved?.root===root)selected=saved.repoPath||''}catch{ /* 无效仓库偏好使用项目根目录。 */ }
    return {...options,repoPath:options.repoPath??selected}
  }
  const rememberGit=(id:string,root:string,git:import('../../src/types/project.ts').ProjectGitStatus)=>{
    cardGit.set(id,{root,git})
    if(git.available)getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('project_repository:'+id,JSON.stringify({root,repoPath:git.repoPath}))
    changed();return git
  }
  handle('list',()=>{checkGitDb();return library().list().map(item=>({...item,git:cardGit.get(item.id)?.root===item.path?cardGit.get(item.id)!.git:undefined}))});handle('get',id=>library().get(reqId(id)))
  handle('overview',async(id,options={})=>{const safeId=reqId(id),root=projectRoot(safeId),result=await projectOverview(root,gitOptions(safeId,root,optRecord(options,'options')??{}));rememberGit(safeId,root,result.git);return result})
  handle('git',async(id,options={})=>{const safeId=reqId(id),root=projectRoot(safeId);return rememberGit(safeId,root,await projectGitCache.read(root,gitOptions(safeId,root,optRecord(options,'options')??{})))})
  const projectRoot=(id:string)=>{const item=library().get(id);if(!item)throw new Error('项目不存在');return item.path}
  handle('applications',()=>new ProjectApplications(getDb()).list())
  handle('select-application',async id=>{
    if(!['vscode','cursor'].includes(id))throw new Error('未知应用')
    const answer=await dialog.showOpenDialog(getWindow()!,{title:tr("选择已安装的 ")+(id==='vscode'?'VS Code':'Cursor'),properties:['openFile'],filters:[{name:tr("Windows 应用"),extensions:['exe']}]})
    restoreWindowFocus(getWindow());if(answer.canceled||!answer.filePaths[0])return false
    await new ProjectApplications(getDb()).select(id,answer.filePaths[0]);return true
  })
  handle('open-application',async(id,application)=>{assertProjectIdle();const safeId=reqId(id);await new ProjectApplications(getDb()).open(reqString(application,'application',{max:64}) as any,projectRoot(safeId));library().opened(safeId);changed()})
  handle('rules',id=>{const safeId=reqId(id),item=library().get(safeId);if(!item)throw new Error('项目不存在');return projectRuleStatus(item,new TimelineLibrary(getDb()).context(safeId).rules)})
  handle('files',(id,relative='',options={})=>listProjectFilesPage(projectRoot(reqId(id)),optString(relative,'relative',{max:2048})??'',optRecord(options,'options')??{}))
  handle('read-file',(id,relative,cursor)=>readProjectTextPage(projectRoot(reqId(id)),reqString(relative,'relative',{max:2048}),1,optRecord(cursor,'cursor') as any))
  handle('scripts',(id,relative='')=>discoverProjectScripts(projectRoot(reqId(id)),optString(relative,'relative',{max:2048})??''))
  const openFile=async(target:string)=>{
    if(/\.(bat|cmd|ps1|vbs|js|mjs|py|sh|lnk|exe|com|msi|scr)$/i.test(target)){
      const answer=await dialog.showMessageBox(getWindow()!,{type:'question',title:tr("打开项目文件"),message:tr("按系统关联打开此程序、脚本或快捷方式？"),detail:target,buttons:[tr("取消"),tr("打开")],defaultId:0,cancelId:0})
      restoreWindowFocus(getWindow());if(answer.response!==1)return false
    }
    const error=await shell.openPath(target);if(error)throw new Error(error);return true
  }
  handle('open-file',async(id,relative)=>{assertProjectIdle();const safeId=reqId(id),target=await resolveProjectFile(projectRoot(safeId),reqString(relative,'relative',{max:2048}));if(await openFile(target)){library().opened(safeId);changed()}})
  handle('open-terminal',async(id,relative='')=>{
    assertProjectIdle();if(process.platform!=='win32')throw new Error('当前仅支持 Windows PowerShell，请通过项目入口打开你的终端')
    const safeId=reqId(id),target=await resolveProjectFile(projectRoot(safeId),optString(relative,'relative',{max:2048})??''),cwd=(await fs.stat(target)).isDirectory()?target:path.dirname(target)
    const launch=projectTerminalLaunch(cwd,process.env.SystemRoot||'C:\\Windows')
    await new Promise<void>((resolve,reject)=>{execFile(launch.executable,launch.args,{cwd,windowsHide:true,timeout:10000,maxBuffer:32*1024},error=>error?reject(error):resolve())})
    library().opened(id);changed()
  })
  handle('preferences',value=>{if(value)assertProjectIdle();return projectPreferences(getDb(),optRecord(value,'value') as any)})
  handle('sessions',id=>assistant().list(reqId(id)));handle('session',id=>assistant().get(reqId(id)))
  handle('create-session',id=>assistant().create(reqId(id)))
  handle('organize',id=>assistant().organize(reqId(id)))
  handle('summarize',(id,kind,key)=>assistant().summarize(reqId(id),reqString(kind,'kind',{max:64}) as any,reqString(key,'key',{max:256})))
  handle('summaries',id=>new ProjectSummaries(getDb()).list(reqId(id)))
  handle('edit-summary',(id,summaryId,patch)=>{assertProjectIdle();const value=new ProjectSummaries(getDb()).edit(reqId(id),reqId(summaryId,'summaryId'),reqRecord(patch,'patch') as any);changed();getWindow()?.webContents.send('workspace:changed');return value})
  handle('undo-summary',(id,summaryId)=>{assertProjectIdle();const value=new ProjectSummaries(getDb()).undo(reqId(id),reqId(summaryId,'summaryId'));changed();getWindow()?.webContents.send('workspace:changed');return value})
  handle('resume-organize',id=>assistant().resumeOrganize(reqId(id)))
  handle('select-repository',(id,relative)=>assistant().selectRepository(reqId(id),reqString(relative,'relative',{allowEmpty:true,max:2048})))
  handle('undo-event',(id,eventId)=>{assertProjectIdle();return assistant().undoEvent(reqId(id),reqId(eventId,'eventId'))})
  handle('undo-batch',(id,sessionId,apply)=>{assertProjectIdle();return assistant().undoBatch(reqId(id),reqId(sessionId,'sessionId'),optBool(apply,'apply')??false)})
  handle('automation',(id,enabled)=>{assistant();return automation!.preferences(reqId(id),optBool(enabled,'enabled'))})
  handle('send-message',(id,text)=>assistant().send(reqId(id),reqString(text,'text',{max:40_000})))
  handle('cancel-message',id=>assistant().cancel(reqId(id)))
  handle('apply-proposal',(id,messageId)=>{assertProjectIdle();return assistant().apply(reqId(id),reqId(messageId,'messageId'))})
  handle('update',(id,patch)=>{assertProjectIdle();const value=library().update(reqId(id),reqRecord(patch,'patch') as any);changed();return value})
  handle('save-entry',(id,entry,expected)=>{assertProjectIdle();const value=library().saveEntry(reqId(id),reqRecord(entry,'entry') as any,optRecord(expected,'expected') as any);changed();return value})
  handle('remove-entry',(id,entryId,expected)=>{assertProjectIdle();const value=library().removeEntry(reqId(id),reqId(entryId,'entryId'),reqRecord(expected,'expected') as any);changed();return value})
  handle('remove',id=>{assertProjectIdle();const safeId=reqId(id);assertProjectRunsStopped(safeId);library().remove(safeId);changed()})
  const resourceSelect=`SELECT r.id,r.kind,r.path,COALESCE(NULLIF(r.name_zh,''),r.file_name) AS name FROM resource r
    WHERE r.kind!='project'
    AND NOT EXISTS(SELECT 1 FROM image_meta m JOIN image_groups g ON g.id=m.group_id WHERE m.resource_id=r.id AND g.hidden=1)
    AND NOT(r.kind='video' AND COALESCE(r.category,'')=? AND ?=1)`
  const availableResources=()=>getDb().prepare(resourceSelect+' ORDER BY r.name_zh LIMIT 5000').all(HENTAI_CATEGORY,Number(getSettings(getDb()).hide_hentai))
  handle('resources',availableResources)
  handle('prepare-import',async(mode,droppedRoots?:string[])=>{
    if(!['single','discover','file'].includes(mode))throw new Error('导入方式无效')
    assertProjectIdle()
    const provided=optStringArray(droppedRoots,'droppedRoots',{max:200})
    let roots:string[]
    if(provided&&provided.length>0){
      for(const p of provided){
        if(!path.isAbsolute(p))throw new Error('仅支持拖入本地项目文件或文件夹')
        await fs.lstat(p).catch(()=>{throw new Error('未找到拖入的项目路径')})
      }
      roots=provided
    }else{
      const picked=await pick(mode!=='file')
      if(!picked)return null
      roots=[picked]
    }
    return projectOperation(async()=>{
      const items=[]
      for(const r of roots){items.push(...(await scanProjects(r,mode==='discover'?'discover':'single')))}
      const rootLabel=roots.length===1?roots[0]:`${roots[0]} 等 ${roots.length} 个位置`
      preview={token:randomUUID(),at:Date.now(),items}
      return {token:preview.token,root:rootLabel,items}
    })
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
  handle('rescan',id=>projectOperation(async()=>{const item=library().get(reqId(id));if(!item)throw new Error('项目不存在');return inspectProject(item.path)}))
  handle('add-entry',async(id,directory)=>{assertProjectIdle();const safeId=reqId(id),file=await pick(!!directory);if(!file)return null;const item=library().get(safeId);if(!item)throw new Error('项目不存在');const updated=library().update(safeId,{entries:[...item.entries,projectEntry(file)]});changed();return updated})
  handle('open',async(id:string,entryId?:string)=>{
    assertProjectIdle();const item=library().get(id);if(!item)throw new Error('项目不存在')
    const entry=item.entries.find(e=>e.id===(entryId||item.defaultEntryId));if(!entry)throw new Error('请先设置打开入口')
    if(entry.resourceId){const linked=getDb().prepare(resourceSelect+' AND r.id=?').get(HENTAI_CATEGORY,Number(getSettings(getDb()).hide_hentai),entry.resourceId) as {path:string}|undefined;if(!linked)throw new Error('关联资源已移除或隐藏，请重新选择入口');entry.path=linked.path}
    if(entry.type==='url')await shell.openExternal(entry.path)
    else {
      await fs.access(entry.path)
      if(entry.type==='obsidian')await shell.openExternal('obsidian://open?path='+encodeURIComponent(entry.path))
      else if(entry.type==='command'){
        if(!/\.exe$/i.test(entry.path))throw new Error('外部工具请选择 EXE 程序；脚本可使用文件入口')
        const root=await fs.stat(item.path).catch(cause => { if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null; throw cause })
        await new Promise<void>((resolve,reject)=>{const child=spawn(entry.path,entry.args,{cwd:entry.cwd||(root?.isDirectory()?item.path:path.dirname(item.path)),shell:false,detached:true,stdio:'ignore',windowsHide:true});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve()})})
      }else{
        if(/\.(bat|cmd|ps1|vbs|js|mjs|py|sh|lnk)$/i.test(entry.path)){
          const result=await dialog.showMessageBox(getWindow()!,{type:'question',title:tr("打开项目脚本"),message:tr("按系统关联打开此脚本或快捷方式？"),detail:entry.path,buttons:[tr("取消"),tr("打开")],defaultId:0,cancelId:0});if(result.response!==1)return
        }
        const error=await shell.openPath(entry.path);if(error)throw new Error(error)
      }
    }
    library().opened(id);changed()
  })
  handle('reveal',async(id:string)=>{const item=library().get(reqId(id));if(!item)throw new Error('项目不存在');await fs.access(item.path).catch(()=>{throw new Error('未找到项目位置，请确认所在磁盘已连接或重新定位项目')});shell.showItemInFolder(item.path)})
  handle('relocate',async(id:string)=>{
    assertProjectRunsStopped(id);assertLibraryIdle();const item=library().get(id);if(!item)throw new Error('项目不存在')
    const oldExists=await fs.lstat(item.path).catch(cause => { if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null; throw cause });if(oldExists)throw new Error('原位置仍存在；需要改变位置请使用移动项目')
    const kind=await dialog.showMessageBox(getWindow()!,{type:'question',title:tr("重新定位项目"),message:tr("项目的新主位置是文件夹还是文件？"),detail:item.path,buttons:[tr("文件夹"),tr("文件"),tr("取消")],defaultId:0,cancelId:2,noLink:true})
    restoreWindowFocus(getWindow());if(kind.response===2)return null
    const target=await pick(kind.response===0);if(!target)return null
    return projectOperation(async()=>{
      const current=library().get(id);if(!current||current.path!==item.path||await fs.lstat(item.path).catch(cause => { if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null; throw cause }))throw new Error('项目位置已变化，请重新操作')
      const stat=await fs.lstat(target);if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))throw new Error('请选择实际项目文件或目录')
      getDb().exec('SAVEPOINT project_relocate')
      try{rebaseLibraryPaths(getDb(),item.path,target);getDb().prepare('UPDATE resource SET file_name=?,source_dir=?,updated_at=? WHERE id=?').run(path.basename(target),path.dirname(target),Date.now(),id);getDb().exec('RELEASE project_relocate')}
      catch(error){getDb().exec('ROLLBACK TO project_relocate; RELEASE project_relocate');throw error}
      pathsChanged();return library().get(id)
    })
  })
  handle('prepare-move',async(id:string)=>{const item=library().get(reqId(id));if(!item)throw new Error('项目不存在');const destinationParent=await pick(true);return destinationParent?{destinationParent,name:path.basename(item.path)}:null})
  handle('preview-move',async(id,destination,keepLink)=>{
    const safeId=reqId(id),safeDest=reqString(destination,'destination',{max:4096});assertProjectRunsStopped(safeId);assertLibraryIdle();return projectOperation(async()=>{const plan=await planProjectMove(getDb(),safeId,safeDest,{keepLink:optBool(keepLink,'keepLink')??false,protectedPaths:protectedPaths()});move={token:randomUUID(),plan};return move})
  })
  handle('move',async token=>{
    assertLibraryIdle();token=reqString(token,'token',{max:256});if(!move||move.token!==token)throw new Error('移动预览已失效');const current=move;assertProjectRunsStopped(current.plan.id);move=null
    return projectOperation(async()=>{try{const result=await executeProjectMove(getDb(),current.plan,{journalDir:journalDir(),protectedPaths:protectedPaths(),trash:file=>shell.trashItem(file)});return {item:library().get(current.plan.id),warnings:result.warnings}}finally{pathsChanged()}})
  })
  handle('move-records',()=>projectMoveRecords(journalDir()))
  handle('recover-move',id=>{assertProjectRunsStopped();assertLibraryIdle();return projectOperation(async()=>{const message=await recoverProjectMove(getDb(),journalDir(),reqId(id));pathsChanged();return message})})
  return {organize:(id:string)=>assistant().organize(id),cancelProject:(id:string)=>{for(const session of assistant().list(id))if(session.status==='running')assistant().cancel(session.id)},
    confirmQuit, busy:()=>runs.busy, stop:async()=>{clearInterval(monitor);automation?.stop();await Promise.all([checking,agent?.dispose(),runs.stopAll()])}}
}
