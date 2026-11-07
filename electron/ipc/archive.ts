import {app,type BrowserWindow,type IpcMain} from 'electron'
import path from 'node:path'
import {getDb,getSettings,updateSoftware} from '../services/database.ts'
import {updateGameItem} from '../kinds/game/service.ts'
import {updateVideoItem} from '../kinds/video/service.ts'
import {ProjectHandoffs,HANDOFF_TOOLS,HANDOFF_SYSTEM,validateProjectPrompt,projectHandoffPage} from '../kinds/project/handoff.ts'
import {TimelineLibrary} from '../workspace/timeline.ts'
import {DocumentInsightService} from '../workspace/document-insight-service.ts'
import {DocumentInsights} from '../workspace/document-insights.ts'
import {DocumentLibrary} from '../workspace/documents.ts'
import {ModulePreferences} from '../workspace/preferences.ts'
import type {ProjectHandoffResult} from '../../src/types/project-handoff.ts'
import {ArchiveAssistant} from '../archive/service.ts'
import {workspaceOperation} from '../workspace/activity.ts'
import {assertLibraryIdle,libraryRestoreInProgress} from './library-backup.ts'

let activeAssistant:ArchiveAssistant|undefined
let insightService:DocumentInsightService|undefined,insightAssistant:ArchiveAssistant|undefined
let importInsights:(ids:string[],provider?:string)=>Promise<string>=async()=>''
export const startImportedInsights=(ids:string[],provider?:string)=>importInsights(ids,provider)
let closing=Promise.resolve()
export const archiveAssistantBusy=()=>!!activeAssistant?.running||!!insightService?.busy
export function closeArchiveAssistant(){const previous=activeAssistant,background=insightAssistant,service=insightService;activeAssistant=undefined;insightAssistant=undefined;insightService=undefined;closing=Promise.all([closing,previous?.dispose(),background?.dispose(),service?.close()]).then(()=>{});return closing}

export function registerArchiveIpc(getWindow:()=>BrowserWindow|null,ipc:Pick<IpcMain,'handle'>){
  let instanceDb:ReturnType<typeof getDb>|undefined,privacy:boolean|undefined
  const changed=()=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('workspace:changed')}
  async function assistant():Promise<ArchiveAssistant>{
    await closing
    if(libraryRestoreInProgress())throw new Error('资料库正在恢复，请等待重启')
    const db=getDb(),hidden=getSettings().hide_hentai
    if(activeAssistant&&(db!==instanceDb||privacy!==hidden)){await closeArchiveAssistant();return assistant()}
    if(!activeAssistant){
      instanceDb=db;privacy=hidden
      const home=path.join(app.getPath('userData'),'archive-assistant',hidden?'public':'all')
      const instance:ArchiveAssistant=new ArchiveAssistant({db,home,assets:path.join(app.getAppPath(),'dist/pdfjs'),
        runtime:app.isPackaged?path.join(process.resourcesPath,'hermes-runtime'):path.join(app.getAppPath(),'output/hermes-runtime'),
        bridge:app.isPackaged?path.join(process.resourcesPath,'hermes/bridge.py'):path.join(app.getAppPath(),'resources/hermes/bridge.py'),
        hideHentai:()=>hidden,current:()=>activeAssistant===instance&&db===getDb()&&hidden===getSettings().hide_hentai,
        config:id=>{const settings=getSettings();if(!id)return settings.ai;const profile=settings.ai_profiles.find(x=>x.id===id);if(!profile)throw new Error('模型配置已不存在，请重新选择');return profile},
        searchConfig:()=>getSettings().search,
        operation:action=>{assertLibraryIdle(true);return workspaceOperation(action)},
        updateResource:(kind,id,patch)=>{const {name,...value}=patch;return kind==='software'?updateSoftware(id,value):kind==='game'?updateGameItem(id,value):updateVideoItem(id,value)},
        changed,event:event=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('archive:event',event)}
      })
      activeAssistant=instance
    }
    return activeAssistant
  }
  const handle=(name:string,action:(assistant:ArchiveAssistant,...args:any[])=>unknown)=>ipc.handle('archive:'+name,async(event,...args)=>{const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许主窗口使用归档助理');return action(await assistant(),...args)})
  const handoffs=new WeakMap<ArchiveAssistant,ProjectHandoffs>(),generating=new WeakMap<ArchiveAssistant,string>()
  const handoff=(a:ArchiveAssistant)=>{let value=handoffs.get(a);if(!value){value=new ProjectHandoffs(getDb());handoffs.set(a,value)}return value}
  const projectConfig=()=>new ModulePreferences(getDb(),getSettings).config('project')
  const insightChanged=()=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('archive:insights-changed');if(!insightService?.busy)changed()}
  const insights=()=>{
    if(!insightService){
      const db=getDb(),hidden=getSettings().hide_hentai,home=path.join(app.getPath('userData'),'archive-assistant',hidden?'public':'all')
      const background:ArchiveAssistant=new ArchiveAssistant({db,home,assets:path.join(app.getAppPath(),'dist/pdfjs'),recoverRuns:false,
        runtime:app.isPackaged?path.join(process.resourcesPath,'hermes-runtime'):path.join(app.getAppPath(),'output/hermes-runtime'),
        bridge:app.isPackaged?path.join(process.resourcesPath,'hermes/bridge.py'):path.join(app.getAppPath(),'resources/hermes/bridge.py'),
        hideHentai:()=>hidden,current:()=>insightAssistant===background&&db===getDb()&&hidden===getSettings().hide_hentai,
        config:()=>new ModulePreferences(db,getSettings).config('document'),operation:action=>workspaceOperation(action),
        updateResource:()=>{throw new Error('精读工作流不允许直接修改资料')},changed,event:()=>{}})
      insightAssistant=background
      insightService=new DocumentInsightService({db,assets:path.join(app.getAppPath(),'dist/pdfjs'),scope:hidden?'public':'all',
        current:()=>insightAssistant===background&&db===getDb()&&hidden===getSettings().hide_hentai&&!libraryRestoreInProgress(),
        config:()=>new ModulePreferences(db,getSettings).config('document'),run:input=>background.runWorkflow(input),budget:(config,text)=>background.runtime.request('insight_budget',{config,text}),changed:insightChanged})
    }
    return insightService
  }
  handle('insight-preview',(_a,ids,range)=>insights().preview(ids,range))
  handle('insight-cleanup-preview',()=>insights().cleanupPreview())
  handle('insight-cleanup',(_a,token)=>{assertLibraryIdle();return insights().cleanup(token)})
  handle('insight-clear-cache',()=>insights().clearCache())
  handle('insight-policy',()=>insights().policy())
  handle('insight-save-policy',(_a,value)=>insights().savePolicy(value))
  importInsights=async(ids,provider)=>{try{await assistant();return insights().afterImport(ids,provider)}catch(error){return '资料已导入，但精读未开始：'+(error as Error).message}}
  handle('insight-start',(_a,token,force)=>{if(libraryRestoreInProgress())throw new Error('资料库正在恢复');return insights().start(token,force===true)})
  handle('insight-list',()=>insights().list())
  handle('insight-detail',(_a,id)=>insights().detail(id))
  handle('insight-cancel',(_a,id)=>insights().cancel(id))
  handle('insight-edit',(_a,id,revision,content)=>{if(libraryRestoreInProgress())throw new Error('资料库正在恢复');const result=new DocumentInsights(getDb()).edit(id,revision,content);changed();return result})
  handle('insight-activate',(_a,id,versionId,revision)=>{if(libraryRestoreInProgress())throw new Error('资料库正在恢复');const result=new DocumentInsights(getDb()).activate(id,versionId,revision);changed();return result})
  handle('insight-adopt',(a,id,revision)=>{
    assertLibraryIdle();const note=new DocumentInsights(getDb()).active(id),item=new DocumentLibrary(getDb()).require(id)
    if(!note||note.revision!==revision)throw new Error('精读版本已变化，请重新查看建议')
    const detail=a.library.get(id),patch={tags:[...new Set([...item.tags,...note.suggestedTags])],...(note.suggestedCategoryId&&note.suggestedCategoryId!==item.type?{type:note.suggestedCategoryId,customGroupId:null}:{})}
    const result=a.library.update('insight-'+note.id,[{id,patch,version:detail.version}],'用户采用精读分类和标签建议')
    changed();return {actionId:result.changes[0]?.id||''}
  })
  handle('project-handoff-preview',(a,id,includeRules)=>{
    if(a.library.sourceById(id).kind!=='project')throw new Error('请选择项目')
    if(includeRules!==undefined&&typeof includeRules!=='boolean')throw new Error('读取范围无效')
    return handoff(a).preview(id,projectConfig(),includeRules)
  })
  handle('project-handoff-generate',async(a,input)=>{
    assertLibraryIdle();if(a.running)throw new Error('归档助理正在处理任务，请等待完成或先停止')
    const config=projectConfig(),snapshot=await handoff(a).consume(input.token,input.stamp,config,input.remember===true)
    a.library.sourceById(snapshot.projectId)
    let submitted:ReturnType<typeof validateProjectPrompt>|undefined
    generating.set(a,snapshot.projectId)
    try{
      const result=await a.runWorkflow({kind:'project_prompt',text:'为项目“'+snapshot.name+'”生成下一步交接 Prompt。',config,tools:HANDOFF_TOOLS,system:HANDOFF_SYSTEM,execute:async(name,args)=>{
        if(name==='archive_project_workbench')return projectHandoffPage({...snapshot,rules:snapshot.rules.map(({content,...rule})=>({...rule,characters:content.length}))},args.offset??0)
        if(name==='archive_project_rule'){const rule=snapshot.rules.find(value=>value.path===args.path);if(!rule)throw new Error('此规则正文不在本次发送范围');return rule}
        if(name==='submit_project_prompt'){submitted=validateProjectPrompt(args);return {submitted:true,projectId:snapshot.projectId,contextRevision:snapshot.context.revision,value:submitted}}
        throw new Error('此工作流不允许该工具')
      }})
      if(!submitted)throw new Error('模型没有提交完整 Prompt，请重试或使用本地模板；会话记录已保留')
      return {...submitted,sessionId:result.sessionId,projectId:snapshot.projectId,contextRevision:snapshot.context.revision} satisfies ProjectHandoffResult
    }finally{generating.delete(a)}
  })
  handle('project-handoff-cancel',(a,id)=>{if(generating.get(a)===id)return a.cancel()})
  handle('project-handoff-adopt',(a,id,revision,prompt)=>{
    assertLibraryIdle();a.library.sourceById(id)
    const timeline=new TimelineLibrary(getDb()),current=timeline.context(id)
    if(current.revision!==revision)throw new Error('便签已更新。请复制结果后手动合并，避免覆盖新内容')
    const result=timeline.updateContext(id,{...current,prompt});changed();const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('project:changed');return result
  })
  handle('status',a=>{const s=getSettings();return {engine:'Hermes v0.22.7',configured:!!(s.ai.enabled&&s.ai.model&&s.ai.api_url&&s.ai.api_key),model:s.ai.model,active:a.running,profiles:s.ai_profiles.map(p=>({id:p.id,name:p.name,model:p.model}))}})
  handle('sessions',(a,query)=>a.sessions(query));handle('session',(a,id)=>a.session(id))
  handle('send',(a,input)=>{assertLibraryIdle(true);return a.send(input)})
  handle('cancel',a=>a.cancel())
  handle('steer',(a,text)=>a.runtime.request('steer',{text}))
  handle('rename',(a,id,title)=>a.rename(id,title))
  handle('archive',(a,id)=>a.archive(id))
  handle('memory',a=>a.runtime.request('memory'))
  handle('memory-edit',(a,input)=>a.runtime.request('memory_edit',input))
  handle('skills',a=>a.runtime.request('skills'))
  handle('actions',(a,id)=>a.library.actions(id))
  handle('undo',(a,id)=>{assertLibraryIdle();const result=a.library.undo(id);changed();return result})
  handle('source',(a,id)=>a.library.sourceById(id))
  app.on('will-quit',closeArchiveAssistant)
}
