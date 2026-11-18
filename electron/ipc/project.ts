import { app, dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn,execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { getDb } from '../services/database.ts'
import { getSettings } from '../services/settings-store.ts'
import { assertLibraryIdle } from './library-backup.ts'
import { HENTAI_CATEGORY } from '../kinds/video/taxonomy.ts'
import { restoreWindowFocus } from '../services/window-focus.ts'
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
  const monitor=setInterval(()=>{try{assistant();void automation?.tick().catch(cause=>console.error('[项目后台检查]',cause))}catch(cause){console.error('[项目后台检查]',cause)}},20000)
  monitor.unref?.()
  app.on('will-quit',()=>{clearInterval(monitor);automation?.stop();agent?.dispose()})
  const handle=(name:string,action:(...args:any[])=>unknown)=>ipc.handle('project:'+name,(event:IpcMainInvokeEvent,...args:any[])=>{
    const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许主窗口操作项目库')
    return action(...args)
  })
  const runs=new ProjectRuns({db:getDb,directory:path.join(app.getPath('userData'),'project-runs'),python:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'hermes-runtime':'output/hermes-runtime','python/python.exe'),supervisor:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'project-runner':'resources/project-runner','supervisor.py'),changed:run=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('project:run',run)}})
  observeProjectRuns(id=>runs.running(id))
  const launchProfiles=()=>new ProjectLaunchProfiles(getDb())
  handle('launch:profiles',id=>launchProfiles().list(id))
  handle('launch:save',(id,input)=>{assertLibraryIdle();const value=launchProfiles().save(id,input);changed();return value})
  handle('launch:remove',(id,profile,revision)=>{assertLibraryIdle();assertProjectRunsStopped(id);launchProfiles().remove(id,profile,revision);changed()})
  handle('launch:revoke',(id,profile)=>{assertLibraryIdle();const value=launchProfiles().revoke(id,profile);changed();return value})
  handle('launch:preview',(id,profile)=>previewProjectLaunch(getDb(),id,profile))
  handle('launch:start',(id,profile,approval)=>{assertLibraryIdle();assertProjectIdle();return runs.start(id,profile,approval)})
  handle('launch:runs',id=>runs.list(id))
  handle('launch:stop',id=>runs.stop(id))
  handle('launch:open-preview',async(id,profileId,runId)=>{
    const profile=launchProfiles().get(id,profileId),run=runId?(await runs.list(id)).find(r=>r.id===runId&&r.profileId===profileId):null
    if(runId&&(!run||run.status!=='running'))throw new Error('此命令已停止，请先重跑')
    const value=run?.previewUrl||profile.url||(profile.port?`http://127.0.0.1:${profile.port}/`:'')
    if(!value)throw new Error('尚未检测到服务端口，可在配置中填写预览地址')
    const url=loopbackUrl(value)
    try{await fetch(url,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(1500)})}catch{throw new Error('预览服务还没有响应，请等待启动完成后再打开')}
    await shell.openExternal(url)
  })
  let quitApproved=false,quitPrompt=false
  const requestQuit=async()=>{
    if(quitPrompt)return;quitPrompt=true
    try{
      const options={type:'question' as const,title:'项目命令仍在运行',message:'停止项目命令并退出抱一？',detail:'独立终端不受影响。托管命令会先正常停止，五秒后结束仍未退出的子进程。',buttons:['停止任务并退出','返回'],defaultId:1,cancelId:1,noLink:true}
      const win=getWindow(),result=win?await dialog.showMessageBox(win,options):await dialog.showMessageBox(options)
      if(result.response===0){await runs.stopAll();quitApproved=true;app.quit()}
    }finally{quitPrompt=false}
  }
  app.on('browser-window-created',(_event,window)=>window.on('close',event=>{if(runs.busy&&!quitApproved){event.preventDefault();void requestQuit()}}))
  app.on('before-quit',event=>{if(runs.busy&&!quitApproved){event.preventDefault();void requestQuit()}})
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
  handle('list',()=>{checkGitDb();return library().list().map(item=>({...item,git:cardGit.get(item.id)?.root===item.path?cardGit.get(item.id)!.git:undefined}))});handle('get',id=>library().get(id))
  handle('overview',async(id,options={})=>{const root=projectRoot(id),result=await projectOverview(root,gitOptions(id,root,options));rememberGit(id,root,result.git);return result})
  handle('git',async(id,options={})=>{const root=projectRoot(id);return rememberGit(id,root,await projectGitCache.read(root,gitOptions(id,root,options)))})
  const projectRoot=(id:string)=>{const item=library().get(id);if(!item)throw new Error('项目不存在');return item.path}
  handle('applications',()=>new ProjectApplications(getDb()).list())
  handle('select-application',async id=>{
    if(!['vscode','cursor'].includes(id))throw new Error('未知应用')
    const answer=await dialog.showOpenDialog(getWindow()!,{title:'选择已安装的 '+(id==='vscode'?'VS Code':'Cursor'),properties:['openFile'],filters:[{name:'Windows 应用',extensions:['exe']}]})
    restoreWindowFocus(getWindow());if(answer.canceled||!answer.filePaths[0])return false
    await new ProjectApplications(getDb()).select(id,answer.filePaths[0]);return true
  })
  handle('open-application',async(id,application)=>{assertProjectIdle();await new ProjectApplications(getDb()).open(application,projectRoot(id));library().opened(id);changed()})
  handle('rules',id=>{const item=library().get(id);if(!item)throw new Error('项目不存在');return projectRuleStatus(item,new TimelineLibrary(getDb()).context(id).rules)})
  handle('files',(id,relative='',options={})=>listProjectFilesPage(projectRoot(id),relative,options))
  handle('read-file',(id,relative,cursor)=>readProjectTextPage(projectRoot(id),relative,1,cursor))
  handle('scripts',(id,relative='')=>discoverProjectScripts(projectRoot(id),relative))
  const openFile=async(target:string)=>{
    if(/\.(bat|cmd|ps1|vbs|js|mjs|py|sh|lnk|exe|com|msi|scr)$/i.test(target)){
      const answer=await dialog.showMessageBox(getWindow()!,{type:'question',title:'打开项目文件',message:'按系统关联打开此程序、脚本或快捷方式？',detail:target,buttons:['取消','打开'],defaultId:0,cancelId:0})
      restoreWindowFocus(getWindow());if(answer.response!==1)return false
    }
    const error=await shell.openPath(target);if(error)throw new Error(error);return true
  }
  handle('open-file',async(id,relative)=>{assertProjectIdle();const target=await resolveProjectFile(projectRoot(id),relative);if(await openFile(target)){library().opened(id);changed()}})
  handle('open-terminal',async(id,relative='')=>{
    assertProjectIdle();if(process.platform!=='win32')throw new Error('当前仅支持 Windows PowerShell，请通过项目入口打开你的终端')
    const target=await resolveProjectFile(projectRoot(id),relative),cwd=(await fs.stat(target)).isDirectory()?target:path.dirname(target)
    const launch=projectTerminalLaunch(cwd,process.env.SystemRoot||'C:\\Windows')
    await new Promise<void>((resolve,reject)=>{execFile(launch.executable,launch.args,{cwd,windowsHide:true,timeout:10000,maxBuffer:32*1024},error=>error?reject(error):resolve())})
    library().opened(id);changed()
  })
  handle('preferences',value=>{if(value)assertProjectIdle();return projectPreferences(getDb(),value)})
  handle('sessions',id=>assistant().list(id));handle('session',id=>assistant().get(id))
  handle('create-session',id=>assistant().create(id))
  handle('organize',id=>assistant().organize(id))
  handle('summarize',(id,kind,key)=>assistant().summarize(id,kind,key))
  handle('summaries',id=>new ProjectSummaries(getDb()).list(id))
  handle('edit-summary',(id,summaryId,patch)=>{assertProjectIdle();const value=new ProjectSummaries(getDb()).edit(id,summaryId,patch);changed();getWindow()?.webContents.send('workspace:changed');return value})
  handle('undo-summary',(id,summaryId)=>{assertProjectIdle();const value=new ProjectSummaries(getDb()).undo(id,summaryId);changed();getWindow()?.webContents.send('workspace:changed');return value})
  handle('resume-organize',id=>assistant().resumeOrganize(id))
  handle('select-repository',(id,relative)=>assistant().selectRepository(id,relative))
  handle('undo-event',(id,eventId)=>{assertProjectIdle();return assistant().undoEvent(id,eventId)})
  handle('undo-batch',(id,sessionId,apply)=>{assertProjectIdle();return assistant().undoBatch(id,sessionId,!!apply)})
  handle('automation',(id,enabled)=>{assistant();return automation!.preferences(id,enabled)})
  handle('send-message',(id,text)=>assistant().send(id,text))
  handle('cancel-message',id=>assistant().cancel(id))
  handle('apply-proposal',(id,messageId)=>{assertProjectIdle();return assistant().apply(id,messageId)})
  handle('update',(id,patch)=>{assertProjectIdle();const value=library().update(id,patch);changed();return value})
  handle('save-entry',(id,entry,expected)=>{assertProjectIdle();const value=library().saveEntry(id,entry,expected);changed();return value})
  handle('remove-entry',(id,entryId,expected)=>{assertProjectIdle();const value=library().removeEntry(id,entryId,expected);changed();return value})
  handle('remove',id=>{assertProjectIdle();assertProjectRunsStopped(id);library().remove(id);changed()})
  const resourceSelect=`SELECT r.id,r.kind,r.path,COALESCE(NULLIF(r.name_zh,''),r.file_name) AS name FROM resource r
    WHERE r.kind!='project'
    AND NOT EXISTS(SELECT 1 FROM image_meta m JOIN image_groups g ON g.id=m.group_id WHERE m.resource_id=r.id AND g.hidden=1)
    AND NOT(r.kind='video' AND COALESCE(r.category,'')=? AND ?=1)`
  const availableResources=()=>getDb().prepare(resourceSelect+' ORDER BY r.name_zh LIMIT 5000').all(HENTAI_CATEGORY,Number(getSettings(getDb()).hide_hentai))
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
          const result=await dialog.showMessageBox(getWindow()!,{type:'question',title:'打开项目脚本',message:'按系统关联打开此脚本或快捷方式？',detail:entry.path,buttons:['取消','打开'],defaultId:0,cancelId:0});if(result.response!==1)return
        }
        const error=await shell.openPath(entry.path);if(error)throw new Error(error)
      }
    }
    library().opened(id);changed()
  })
  handle('reveal',(id:string)=>{const item=library().get(id);if(item)shell.showItemInFolder(item.path)})
  handle('relocate',async(id:string)=>{
    assertProjectRunsStopped(id);assertLibraryIdle();const item=library().get(id);if(!item)throw new Error('项目不存在')
    const oldExists=await fs.lstat(item.path).catch(cause => { if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null; throw cause });if(oldExists)throw new Error('原位置仍存在；需要改变位置请使用移动项目')
    const kind=await dialog.showMessageBox(getWindow()!,{type:'question',title:'重新定位项目',message:'项目的新主位置是文件夹还是文件？',detail:item.path,buttons:['文件夹','文件','取消'],defaultId:0,cancelId:2,noLink:true})
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
  handle('prepare-move',async(id:string)=>{const item=library().get(id);if(!item)throw new Error('项目不存在');const destinationParent=await pick(true);return destinationParent?{destinationParent,name:path.basename(item.path)}:null})
  handle('preview-move',async(id,destination,keepLink)=>{
    assertProjectRunsStopped(id);assertLibraryIdle();return projectOperation(async()=>{const plan=await planProjectMove(getDb(),id,destination,{keepLink:!!keepLink,protectedPaths:protectedPaths()});move={token:randomUUID(),plan};return move})
  })
  handle('move',async token=>{
    assertLibraryIdle();if(!move||move.token!==token)throw new Error('移动预览已失效');const current=move;assertProjectRunsStopped(current.plan.id);move=null
    return projectOperation(async()=>{try{const result=await executeProjectMove(getDb(),current.plan,{journalDir:journalDir(),protectedPaths:protectedPaths(),trash:file=>shell.trashItem(file)});return {item:library().get(current.plan.id),warnings:result.warnings}}finally{pathsChanged()}})
  })
  handle('move-records',()=>projectMoveRecords(journalDir()))
  handle('recover-move',id=>{assertProjectRunsStopped();assertLibraryIdle();return projectOperation(async()=>{const message=await recoverProjectMove(getDb(),journalDir(),id);pathsChanged();return message})})
  return {organize:(id:string)=>assistant().organize(id),cancelProject:(id:string)=>{for(const session of assistant().list(id))if(session.status==='running')assistant().cancel(session.id)}}
}
