import { app,dialog, nativeImage, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getDb } from '../services/database.ts'
import { getSettings } from '../services/settings-store.ts'
import { assertLibraryIdle } from './library-backup.ts'
import { restoreWindowFocus } from '../services/window-focus.ts'
import { DocumentLibrary } from '../workspace/documents.ts'
import { DocumentCovers } from '../workspace/document-covers.ts'
import { WorkspaceLinks } from '../workspace/links.ts'
import { TimelineLibrary } from '../workspace/timeline.ts'
import { SkillProfiles } from '../workspace/skill-profiles.ts'
import { PersonalLibrary } from '../workspace/personal.ts'
import { workspaceOperation } from '../workspace/activity.ts'
import { collectEvidence } from '../workspace/evidence.ts'
import { generateTimeline } from '../workspace/assistant.ts'
import type { ProjectSession } from '../../src/types/project.ts'
import type { DocumentScan } from '../../src/types/workspace.ts'
import { strings, keys, text, name } from '../workspace/validation.ts'
import {DocumentFiles,type DocumentFilePlan} from '../workspace/document-files.ts'
import {DocumentRecycle,type RecycleRecord} from '../workspace/document-recycle.ts'
import {ModulePreferences} from '../workspace/preferences.ts'
import {actualDirectory} from '../workspace/document-files.ts'
import type {DocumentImportChoice} from '../../src/types/workspace.ts'

export function registerWorkspaceIpc(getWindow: () => BrowserWindow | null, ipc: Pick<IpcMain, 'handle'>, projects?:{organize:(id:string)=>ProjectSession;cancelProject:(id:string)=>void}): void {
  const docs = () => new DocumentLibrary(getDb(), path.join(app.getPath('userData'), 'cache/novel-index/v1')), links = () => new WorkspaceLinks(getDb(), getSettings(getDb()).hide_hentai)
  const covers=new DocumentCovers(getDb,path.join(app.getPath('userData'),'cache/document-covers/v1'))
  const timeline = () => new TimelineLibrary(getDb()), personal = () => new PersonalLibrary(getDb())
  let preview: { token: string; at: number; scan: DocumentScan; categoryId:string; db: ReturnType<typeof getDb> } | null = null
  const changed = () => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('workspace:changed') }
  const preferences=()=>new ModulePreferences(getDb(),() => getSettings(getDb()))
  const handle = (name: string, action: (...args: any[]) => unknown) => ipc.handle('workspace:' + name, (event: IpcMainInvokeEvent, ...args: any[]) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('只允许主窗口操作资料与个人记录')
    return action(...args)
  })
  const write = (name: string, action: (...args: any[]) => unknown) => handle(name, (...args) => { assertLibraryIdle(); const result = action(...args); changed(); return result })
  const operation = <T>(action: () => Promise<T>) => { assertLibraryIdle(); return workspaceOperation(action) }
  const dataDirectory=()=>{const row=getDb().prepare("SELECT value FROM settings WHERE key='document_data_dir'").get() as {value:string}|undefined;return row?JSON.parse(row.value):''}
  const recycle=()=>new DocumentRecycle(getDb(),dataDirectory)
  const lastDirectory=()=>{const row=getDb().prepare("SELECT value FROM settings WHERE key='document_last_browse_dir'").get() as {value:string}|undefined;return row?JSON.parse(row.value):undefined}
  const rememberDirectory=(directory:string)=>getDb().prepare("INSERT INTO settings(key,value) VALUES('document_last_browse_dir',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(directory))
  handle('preferences:get',module=>preferences().get(module))
  write('preferences:save',(module,value)=>preferences().save(module,value))
  handle('preferences:data-directory',dataDirectory)
  handle('preferences:choose-data-directory',()=>operation(async()=>{
    const result=await dialog.showOpenDialog(getWindow()!,{title:'选择资料数据目录',defaultPath:dataDirectory()||lastDirectory(),properties:['openDirectory','createDirectory']});restoreWindowFocus(getWindow())
    if(result.canceled||!result.filePaths[0])return null
    const directory=result.filePaths[0];await actualDirectory(directory)
    getDb().prepare("INSERT INTO settings(key,value) VALUES('document_data_dir',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(directory));changed();return directory
  }))
  let recyclePreview:{token:string;plan:RecycleRecord;db:ReturnType<typeof getDb>}|null=null
  handle('recycle:locations',id=>{docs().require(id);return new DocumentFiles(getDb()).locations(id)})
  handle('recycle:preview',(id,paths)=>operation(async()=>{
    const plan=await recycle().plan(id,paths);recyclePreview={token:randomUUID(),plan,db:getDb()}
    return {token:recyclePreview.token,name:plan.name,references:links().backlinks(id).length,expiresAt:plan.expiresAt,files:plan.files.map(({source,stored})=>({source,stored}))}
  }))
  handle('recycle:confirm',token=>operation(async()=>{
    if(!recyclePreview||recyclePreview.token!==token||recyclePreview.db!==getDb())throw new Error('删除预览已失效')
    const plan=recyclePreview.plan;recyclePreview=null;try{await recycle().remove(plan)}finally{changed()}
  }))
  handle('recycle:list',()=>recycle().list().map(({snapshot,root,...item})=>item))
  let batchRecycle: {token:string;plans:RecycleRecord[];db:ReturnType<typeof getDb>} | null = null
  handle('recycle:preview-batch',(ids:string[],withFiles:boolean)=>operation(async()=>{
    const selected=[...new Set(strings(ids,2000))]
    if(!selected.length || typeof withFiles!=='boolean') throw new Error('请选择需要删除的资料')
    const plans:RecycleRecord[]=[]
    for(const id of selected) {
      const paths=withFiles?new DocumentFiles(getDb()).locations(id).filter(f=>f.available).map(f=>f.path):[]
      plans.push(await recycle().plan(id,paths))
    }
    batchRecycle={token:randomUUID(),plans,db:getDb()}
    return {token:batchRecycle.token,items:plans.map(p=>({id:p.documentId,name:p.name,expiresAt:p.expiresAt,files:p.files.map(({source,stored})=>({source,stored}))}))}
  }))
  handle('recycle:confirm-batch',(token:string)=>operation(async()=>{
    if(!batchRecycle||batchRecycle.token!==token||batchRecycle.db!==getDb())throw new Error('批量删除预览已失效')
    const batch=batchRecycle;batchRecycle=null
    const removed:string[]=[],errors:string[]=[]
    for(const plan of batch.plans) {try{await recycle().remove(plan);removed.push(plan.documentId)}catch(e){errors.push(plan.name+'：'+(e as Error).message)}}
    changed();return {removed,errors}
  }))
  handle('recycle:resume',id=>operation(async()=>{try{await recycle().resume(id)}finally{changed()}}))
  handle('recycle:restore',(id,alternate=false)=>operation(async()=>{
    const service=recycle(),record=service.get(id),targets:Record<string,string>={}
    if(alternate){for(const file of record.files.filter(f=>f.state==='stored'&&!f.restoredTo)){
      const result=await dialog.showSaveDialog(getWindow()!,{title:'恢复资料到新位置（不覆盖现有文件）',defaultPath:file.source});restoreWindowFocus(getWindow())
      if(result.canceled||!result.filePath)return
      targets[file.source]=result.filePath
    }}
    try{await service.restore(id,targets)}finally{changed()}
  }))
  const cleanup=()=>operation(async()=>{const result=await recycle().cleanup();changed();return result})
  handle('recycle:cleanup',cleanup)
  // Check on startup and once per local calendar day. Busy operations retry next minute.
  let cleanupDb:ReturnType<typeof getDb>|undefined,cleanupDay='',cleanupRunning=false
  const checkCleanup=async()=>{if(cleanupRunning)return;cleanupRunning=true;try{
    const db=getDb(),day=new Date().toLocaleDateString('sv-SE');if(cleanupDb===db&&cleanupDay===day)return
    await cleanup();cleanupDb=db;cleanupDay=day
  }catch(cause){console.error('[工作区定时清理]',cause)}finally{cleanupRunning=false}}
  if(app?.on){const timer=setInterval(()=>void checkCleanup(),60000);timer.unref?.();void checkCleanup();app.on('will-quit',()=>clearInterval(timer))}
  let fileChoice:{token:string;projectId:string;source:string;at:number;db:ReturnType<typeof getDb>}|null=null
  let filePreview:{token:string;plan:DocumentFilePlan;db:ReturnType<typeof getDb>}|null=null
  handle('files:choose',projectId=>operation(async()=>{
    links().owner('project',projectId)
    const result=await dialog.showOpenDialog(getWindow()!,{title:'选择要关联的电脑文件',properties:['openFile']})
    restoreWindowFocus(getWindow());fileChoice=null;filePreview=null
    if(result.canceled||!result.filePaths[0])return null
    fileChoice={token:randomUUID(),projectId,source:result.filePaths[0],at:Date.now(),db:getDb()}
    return {token:fileChoice.token,source:fileChoice.source}
  }))
  handle('files:preview',(token,mode,target,name)=>operation(async()=>{
    if(!fileChoice||token!==fileChoice.token||fileChoice.db!==getDb()||Date.now()-fileChoice.at>30*60_000)throw new Error('文件选择已失效，请重新选择')
    const choice=fileChoice
    if(!['project','library'].includes(target))throw new Error('目标位置无效')
    const project=getDb().prepare("SELECT path FROM resource WHERE id=? AND kind='project'").get(choice.projectId) as {path:string}|undefined
    if(!project)throw new Error('项目不存在')
    const setting=getDb().prepare("SELECT value FROM settings WHERE key='document_data_dir'").get() as {value:string}|undefined
    const directory=target==='project'?project.path:setting?JSON.parse(setting.value):''
    if(mode!=='link'&&!directory)throw new Error('请先在资料设置中选择资料数据目录')
    const filename=name||path.basename(choice.source)
    if(typeof filename!=='string'||path.basename(filename)!==filename||filename==='.'||filename==='..'||/[\\/]/.test(filename))throw new Error('目标文件名无效')
    const plan=await new DocumentFiles(getDb()).plan(choice.projectId,choice.source,mode,mode==='link'?'':path.join(directory,filename))
    filePreview={token:randomUUID(),plan,db:getDb()}
    return {token:filePreview.token,source:plan.source,destination:plan.destination,mode:plan.mode,size:plan.stamp.size}
  }))
  handle('files:confirm',token=>operation(async()=>{
    if(!filePreview||token!==filePreview.token||filePreview.db!==getDb())throw new Error('文件预览已失效，请重新预览')
    const plan=filePreview.plan;filePreview=null
    try{return await new DocumentFiles(getDb()).execute(plan)}finally{changed()}
  }))
  handle('files:operations',id=>{links().owner('project',id);return new DocumentFiles(getDb()).operations().filter(op=>op.projectId===id&&op.state!=='done')})
  handle('files:recover',id=>operation(async()=>{try{return await new DocumentFiles(getDb()).recover(id)}finally{changed()}}))
  const exportFile = async (name: string, content: string, obsidian = false) => {
    const result = await dialog.showSaveDialog(getWindow()!, { title: obsidian ? '导出到 Obsidian 库中的文件' : '导出 Markdown', defaultPath: name.replace(/[<>:"/\\|?*]/g, '_') + '.md', filters: [{name:'Markdown',extensions:['md']}] })
    restoreWindowFocus(getWindow())
    if (result.canceled || !result.filePath) return null
    if (getDb().prepare('SELECT id FROM resource WHERE path=? COLLATE NOCASE').get(path.resolve(result.filePath))) throw new Error('导出不能覆盖已登记的原文件，请另选文件名')
    await fs.writeFile(result.filePath, content, 'utf8')
    if (obsidian) await shell.openExternal('obsidian://open?path=' + encodeURIComponent(result.filePath))
    return result.filePath
  }
  handle('documents:list', (options?: { submodule?: any; uncategorized?: boolean; customGroupId?: string }) => docs().list(options)); handle('documents:get', id => docs().get(id))
  handle('documents:covers:get',id=>covers.get(id))
  handle('documents:covers:source',(id,token)=>covers.source(id,token))
  handle('documents:covers:range',(id,token,offset,length)=>covers.range(id,token,offset,length))
  handle('documents:covers:put',(id,token,png)=>covers.put(id,token,png))
  handle('documents:categories',(submodule?: any)=>docs().categories(submodule))
  write('documents:save-category',input=>docs().saveCategory(input));write('documents:remove-category',(id,target)=>docs().removeCategory(id,target))
  handle('documents:custom-groups',(submodule?: any, categoryId?: any)=>docs().customGroups(submodule, categoryId))
  write('documents:save-custom-group',input=>docs().saveCustomGroup(input))
  write('documents:remove-custom-group',id=>docs().removeCustomGroup(id))
  write('documents:move-to-submodule',(id: string, targetSubmodule: any, targetCategoryId?: string)=>docs().moveToSubmodule(id, targetSubmodule, targetCategoryId))
  write('documents:update', (id, patch) => docs().update(id, patch))
  handle('documents:remove',id=>operation(async()=>{await recycle().remove(await recycle().plan(id,[]));changed()}))
  handle('documents:prepare-import', (directory: boolean,categoryId='') => operation(async () => {
    if (typeof directory !== 'boolean') throw new Error('导入方式无效')
    categoryId=categoryId||preferences().get('document').defaultCategory
    if(categoryId&&!docs().categories().some(c=>c.id===categoryId))categoryId=''
    if(categoryId)docs().category(categoryId)
    const result = await dialog.showOpenDialog(getWindow()!, {title:'选择资料',defaultPath:lastDirectory(),properties:directory?['openDirectory']:['openFile','multiSelections']})
    restoreWindowFocus(getWindow()); if (result.canceled || !result.filePaths.length) return null
    rememberDirectory(directory?result.filePaths[0]:path.dirname(result.filePaths[0]))
    const scan = await docs().scan(result.filePaths)
    preview = {token:randomUUID(),at:Date.now(),scan,categoryId,db:getDb()}; return {...scan,token:preview.token,categoryId}
  }))
  handle('documents:analyze-import',(token:string,file:string)=>operation(async()=>{
    if(!preview||preview.token!==token||preview.db!==getDb()||Date.now()-preview.at>30*60_000)throw new Error('导入预览已失效')
    const candidate=preview.scan.items.find(i=>i.path===file&&!i.existing)
    if(!candidate)throw new Error('文件不在本次可导入预览中')
    const {identifyDocumentImport}=await import('../workspace/document-import-agent.ts')
    const saved=preview,result=await identifyDocumentImport(candidate,docs().categories(),preferences().config('document'),{assets:path.join(app.getAppPath(),'dist/pdfjs')})
    if(preview!==saved||saved.db!==getDb())throw new Error('导入预览已变化，请重新选择')
    preview.at=Date.now();return result
  }))
  handle('documents:confirm-import', (token: string, paths: string[], categoryId?: string, submodule?: any, customGroupId?: string, choices?: DocumentImportChoice[]) => operation(async () => {
    if (!preview || preview.token !== token || preview.db !== getDb() || Date.now() - preview.at > 30 * 60_000) throw new Error('导入预览已失效，请重新选择')
    const selected = strings(paths, 2000), allowed = new Set(preview.scan.items.filter(i => !i.existing).map(i => i.path))
    if (!selected.length || selected.some(p => !allowed.has(p))) throw new Error('所选文件不在本次可导入的预览中')
    const type = categoryId === undefined ? preview.categoryId : categoryId
    if (type) docs().category(type)
    const scanItemsMap = new Map(preview.scan.items.map(i => [i.path, i]))
    if (choices && (!Array.isArray(choices) || choices.length !== selected.length || new Set(choices.map(c => c.path)).size !== selected.length || choices.some(c => !selected.includes(c.path) || (c.categoryId !== null && !docs().categories().some(cat => cat.id === c.categoryId))))) throw new Error('请为所选资料确认有效分类')
    for(const choice of choices||[]){
      keys(choice,['path','categoryId','name','author','tags'])
      if(choice.name!==undefined)choice.name=name(choice.name)
      if(choice.author!==undefined)choice.author=text(choice.author,'作者',300)
      if(choice.tags!==undefined)choice.tags=strings(choice.tags).filter(tag=>!['未读','在读','已读'].includes(tag))
    }
    preview = null; let imported = 0; const errors: string[] = [],importedIds:string[]=[]
    for (const file of selected) {
      try {
        const candidate = scanItemsMap.get(file)
        const choice = choices?.find(c => c.path === file)
        const finalCategory = choice ? choice.categoryId || undefined : submodule === null ? undefined : type || candidate?.suggestedCategoryId || undefined
        const finalSubmodule = choice ? choice.categoryId ? docs().category(choice.categoryId).submodule : null : submodule === null ? null : submodule || (finalCategory ? docs().category(finalCategory).submodule : null)
        const item = await docs().register(file, finalCategory, false, finalSubmodule, customGroupId)
        const tags = preferences().get('document').defaultTags
        const patch={...(choice?.name!==undefined?{name:choice.name}:{}),...(choice?.author!==undefined?{author:choice.author}:{}),...((choice?.tags||tags.length)?{tags:[...new Set([...item.tags,...tags,...(choice?.tags||[])])]}:{})}
        if (Object.keys(patch).length) docs().update(item.id, patch)
        imported++
        importedIds.push(item.id)
      } catch (e) {
        errors.push(path.basename(file) + '：' + (e as Error).message)
      }
    }
    const insightStatus=importedIds.length
      ? '资料已导入；精读不会在后台自动启动，请在归档助理中主动加载“文档精读”方法。'
      : ''
    changed(); return { imported, errors,insightStatus }
  }))
  handle('documents:relocate', (id: string) => operation(async () => {
    const item = docs().require(id)
    if (item.available) throw new Error('原文件仍存在，请先在文件管理器中移动文件')
    const result = await dialog.showOpenDialog(getWindow()!,{title:'重新定位原资料',defaultPath:lastDirectory()||path.dirname(item.path),properties:['openFile'],filters:[{name:item.format,extensions:[item.format]}]})
    restoreWindowFocus(getWindow()); if (result.canceled || !result.filePaths[0]) return null
    rememberDirectory(path.dirname(result.filePaths[0]));
    const value = await docs().relocate(id,result.filePaths[0]); changed(); return value
  }))
  // content captures its metadata before awaiting file reads and never writes the DB.
  handle('documents:content', id => docs().content(id))
  handle('documents:text:index', (id: string, encoding?: string) => docs().textIndex(id, encoding))
  handle('documents:text:search', (id:string,query:string,page?:number,start?:number,encoding?:string)=>docs().searchText(id,query,page,start,encoding))
  handle('documents:text:slice', (id: string, byteOffset: number, byteLength: number, encoding?: string) => docs().textSlice(id, byteOffset, byteLength, encoding))
  handle('documents:pdf:range', (id: string, offset: number, length: number) => docs().pdfRange(id, offset, length))
  handle('documents:open', async id => { const item=docs().require(id); await docs().inspect(item.path,true); const error=await shell.openPath(item.path); if(error)throw new Error(error) })
  handle('documents:reveal', id => shell.showItemInFolder(docs().require(id).path))
  write('documents:position', (id,loc,count) => docs().savePosition(id,loc,count))
  handle('documents:annotations', id=>docs().annotations(id)); write('documents:annotate',(id,input)=>docs().annotate(id,input))
  write('documents:remove-annotation',(id,annotation)=>docs().removeAnnotation(id,annotation))
  handle('documents:export',(id,ids,obsidian)=>operation(()=>exportFile(docs().require(id).name+'-摘录',docs().export(id,ids),!!obsidian)))
  handle('documents:markdown',(id,ids)=>docs().export(id,ids))
  handle('documents:organize:pick-directory', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择整理目标根目录',
      defaultPath:lastDirectory(),
      properties: ['openDirectory', 'createDirectory']
    })
    restoreWindowFocus(win)
    if(!result.canceled && result.filePaths[0])rememberDirectory(result.filePaths[0])
    return result.canceled ? null : result.filePaths[0]
  })
  handle('documents:organize:preview', options => operation(() => new DocumentFiles(getDb()).previewOrganize(options)))
  handle('documents:organize:execute', options => operation(async () => {
    const result = await new DocumentFiles(getDb()).executeOrganize(options)
    changed()
    return result
  }))
  handle('documents:organize:history', () => new DocumentFiles(getDb()).operations())
  write('documents:organize:undo', id => operation(async () => {
    const result = await new DocumentFiles(getDb()).undo(id)
    changed()
    return result
  }))
  handle('links:list',(owner,id)=>links().list(owner,id)); handle('links:resources',()=>links().resources())
  handle('links:project-references',ids=>links().projectReferences(ids))
  handle('links:backlinks',id=>links().backlinks(id)); write('links:add',(owner,id,target,annotation)=>links().add(owner,id,target,annotation))
  write('links:remove',(owner,id,link)=>links().remove(owner,id,link))
  handle('timeline:context',id=>timeline().context(id)); write('timeline:update-context',(id,patch)=>{
    const result=timeline().updateContext(id,patch),win=getWindow()
    if(win&&!win.isDestroyed())win.webContents.send('project:changed')
    return result
  })
  handle('timeline:events',id=>timeline().events(id)); write('timeline:save',(id,input)=>timeline().save(id,input))
  write('timeline:publish',(id,event)=>timeline().publish(id,event)); write('timeline:dismiss',(id,event)=>timeline().dismiss(id,event))
  write('timeline:remove',(id,event)=>timeline().remove(id,event))
  handle('timeline:check',id=>operation(()=>collectEvidence(getDb(),id)))
  handle('timeline:generate',(id,ai)=>{if(ai){if(!projects)throw new Error('项目会话服务未就绪');return projects.organize(id)}return operation(async()=>{const event=await generateTimeline(getDb(),id);changed();return event})})
  handle('timeline:cancel',id=>projects?.cancelProject(id))
  handle('timeline:export',id=>operation(()=>exportFile((timeline().require(id).name_zh||'项目')+'-日志',timeline().export(id,links()))))
  const skills=()=>new SkillProfiles(getDb())
  handle('skills:list',()=>skills().list());handle('skills:proposals',()=>skills().proposals())
  write('skills:confirm',(id,draft)=>skills().confirm(id,draft));write('skills:cancel',id=>skills().cancel(id));write('skills:undo-record',id=>skills().undoRecord(id))
  handle('personal:choose-avatar',()=>operation(async()=>{
    const result=await dialog.showOpenDialog(getWindow()!,{title:'选择个人头像',properties:['openFile'],filters:[{name:'图片',extensions:['png','jpg','jpeg','webp']}]});restoreWindowFocus(getWindow())
    if(result.canceled||!result.filePaths[0])return null
    const file=result.filePaths[0];if((await fs.stat(file)).size>10*1024*1024)throw new Error('头像图片请小于 10 MB')
    const image=nativeImage.createFromBuffer(await fs.readFile(file));if(image.isEmpty())throw new Error('无法读取这张图片')
    const size=image.getSize();if(size.width*size.height>40000000)throw new Error('头像图片尺寸过大')
    const side=Math.min(size.width,size.height);return image.crop({x:Math.floor((size.width-side)/2),y:Math.floor((size.height-side)/2),width:side,height:side}).resize({width:256,height:256}).toDataURL()
  }))
  write('personal:capture-state',(name,unit,value,date,metricId)=>personal().captureState(name,unit,value,date,metricId))
  write('personal:renew',(id,input)=>personal().renew(id,input))
  write('personal:snooze',(id,until)=>personal().snooze(id,until))
  handle('personal:list',kind=>personal().list(kind)); write('personal:save',input=>{if(input.kind==='profile'&&input.data?.avatar){const image=nativeImage.createFromDataURL(input.data.avatar);if(image.isEmpty()||image.getSize().width>256||image.getSize().height>256)throw new Error('头像无效或尺寸过大')}return personal().save(input)}); write('personal:remove',id=>personal().remove(id))
  handle('personal:overview',()=>{
    return {counts:links().counts()}
  })
}
