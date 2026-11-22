import { app, dialog, safeStorage, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../services/storage/database.ts'
import { PicacomicSource } from '../kinds/image/source.ts'
import { createImageSourceFetch } from '../kinds/image/network.ts'
import { createImageDownloads } from '../kinds/image/downloads.ts'
import { imageOperation } from '../kinds/image/activity.ts'
import { createImageUpdates } from '../kinds/image/updates.ts'
import { restoreWindowFocus } from '../services/system/window-focus.ts'
import {comicProvider,downloadTarget,rememberDownloadRoot,validateDownloadRoot} from '../kinds/image/download-target.ts'
import { optId, optNumber, optRecord, optString, reqEnum, reqId, reqString, reqStringArray } from './validate.ts'

export function registerImageSourceIpc(getWindow:()=>BrowserWindow|null,ipc:Pick<IpcMain,'handle'>){
  const credentialFile=path.join(app.getPath('userData'),'pica-auth.bin')
  let token=''
  try{if(safeStorage.isEncryptionAvailable()&&fs.existsSync(credentialFile))token=safeStorage.decryptString(fs.readFileSync(credentialFile))}catch{/* A moved profile requires a new login on this machine. */}
  const source=new PicacomicSource({fetch:createImageSourceFetch(),token:()=>token})
  const changed=()=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('image:changed')}
  const jobsChanged=()=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('image:jobs-changed')}
  const makeQueue=()=>createImageDownloads({db:getDb(),source,changed,jobsChanged,logDirectory:path.join(app.getPath('userData'),'comic-logs')})
  let queue=makeQueue(),updates=createImageUpdates({db:getDb(),source,queue})
  function handle(name:string,fn:(...args:any[])=>unknown){ipc.handle('image:'+name,(event:IpcMainInvokeEvent,...args)=>{const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许主窗口操作图片来源');return fn(...args)})}
  handle('source-status',()=>!!token)
  handle('download-target',(provider,id,group)=>downloadTarget(getDb(),app.getPath('userData'),comicProvider(provider),id,group))
  handle('choose-download-root',async(provider,current)=>{
    provider=comicProvider(provider)
    const selected=await dialog.showOpenDialog(getWindow()!,{title:'选择漫画存放根目录',defaultPath:typeof current==='string'?current:undefined,properties:['openDirectory','createDirectory']})
    restoreWindowFocus(getWindow());if(selected.canceled||!selected.filePaths[0])return null
    const root=await validateDownloadRoot(selected.filePaths[0]);await rememberDownloadRoot(app.getPath('userData'),provider,root);return root
  })
  handle('source-owned',(workIds:string[])=>{
    if(!Array.isArray(workIds)||!workIds.length||workIds.length>200||workIds.some(id=>typeof id!=='string'||!id||id.length>100))throw new Error('来源作品标识无效')
    const ids=[...new Set(workIds)],marks=ids.map(()=>'?').join(',')
    const owned=(getDb().prepare("SELECT source_id FROM image_meta WHERE source='pica' AND source_id IN ("+marks+")").all(...ids) as Array<{source_id:string}>).map(row=>row.source_id)
    const chapters:Record<string,string[]>=Object.create(null)
    const rows=getDb().prepare("SELECT m.source_id AS work_id,c.source_id AS chapter_id FROM image_chapters c JOIN image_meta m ON m.resource_id=c.resource_id WHERE m.source='pica' AND c.source_id!='' AND m.source_id IN ("+marks+")").all(...ids) as Array<{work_id:string;chapter_id:string}>
    for(const row of rows)(chapters[row.work_id]||=[]).push(row.chapter_id)
    const queued=[...new Set(queue.list().filter(job=>['queued','running','paused'].includes(job.status)&&ids.includes(job.work.id)).map(job=>job.work.id))]
    return {owned,queued,chapters}
  })
  handle('repair',(id:string)=>{if(!token)throw new Error('请先登录哔咔');return imageOperation(()=>queue.repair(reqId(id)))})
  handle('check-updates',(id:string)=>{if(!token)throw new Error('请先登录哔咔');return imageOperation(()=>updates.check(reqId(id)))})
  handle('download-updates',(id:string,chapters:string[])=>{if(!token)throw new Error('请先登录哔咔');return imageOperation(()=>updates.download(reqId(id),reqStringArray(chapters,'chapters',{min:1,max:5000})))})
  handle('source-login',async(account:string,password:string)=>{
    account=reqString(account,'account',{max:256});password=reqString(password,'password',{max:256})
    if(!safeStorage.isEncryptionAvailable())throw new Error('系统加密服务不可用，无法安全保存登录状态')
    const next=await source.login(account,password),encrypted=safeStorage.encryptString(next),temporary=credentialFile+'.tmp'
    fs.writeFileSync(temporary,encrypted);fs.renameSync(temporary,credentialFile);token=next
  })
  handle('source-logout',()=>{token='';if(fs.existsSync(credentialFile))fs.unlinkSync(credentialFile)})
  handle('source-search',(query:string,page:number)=>{if(!token)throw new Error('请先登录哔咔');return source.search(reqString(query,'query',{max:512}),optNumber(page,'page',{min:1,max:1000,integer:true})??1)})
  handle('source-favorites',(page,sort)=>{if(!token)throw new Error('请先登录哔咔');return source.favorites(optNumber(page,'page',{min:1,max:1000,integer:true})??1,optString(sort,'sort',{max:64}) as any)})
  handle('source-ranking',period=>{if(!token)throw new Error('请先登录哔咔');return source.ranking(reqString(period,'period',{max:64}) as any)})
  handle('source-cover',url=>{if(!token)throw new Error('请先登录哔咔');return source.cover(reqString(url,'url',{max:4096}))})
  handle('source-detail',(id:string)=>{if(!token)throw new Error('请先登录哔咔');return source.detail(reqId(id))})
  handle('download',async(workId:string,selected:string[],groupId:string|null,root?:string)=>{
    workId=reqId(workId,'workId');selected=reqStringArray(selected,'selected',{min:1,max:5000});groupId=optId(groupId,'groupId')??null;root=optString(root,'root',{max:4096})
    if(!token)throw new Error('请先登录哔咔')
    const {work,chapters}=await source.detail(workId),chosen=chapters.filter(c=>selected.includes(c.id))
    if(!chosen.length)throw new Error('请选择有效章节')
    if(root!==undefined){const target=await downloadTarget(getDb(),app.getPath('userData'),'pica',workId,groupId);return queue.enqueue(work,chosen,await validateDownloadRoot(target.locked?target.root:root),target.locked?target.groupId:groupId)}
    const result=await dialog.showOpenDialog(getWindow()!,{title:'选择漫画下载根目录（补章请选择原根目录）',properties:['openDirectory','createDirectory']})
    restoreWindowFocus(getWindow())
    if(result.canceled||!result.filePaths[0])return null
    return queue.enqueue(work,chosen,result.filePaths[0],groupId)
  })
  handle('download-batch',async(workIds:string[],groupId:string|null,root?:string)=>{
    if(!token)throw new Error('请先登录哔咔')
    if(!Array.isArray(workIds)||workIds.length<1||workIds.length>200)throw new Error('一次请选择 1 到 200 部漫画')
    if(root!==undefined)return queue.enqueueBatch(workIds,await validateDownloadRoot(root),groupId)
    const result=await dialog.showOpenDialog(getWindow()!,{title:`选择 ${workIds.length} 部漫画的下载根目录`,properties:['openDirectory','createDirectory']})
    restoreWindowFocus(getWindow())
    if(result.canceled||!result.filePaths[0])return null
    return queue.enqueueBatch(workIds,result.filePaths[0],groupId)
  })
  handle('jobs',()=>queue.list());handle('retry-job',(id:string)=>{if(!token)throw new Error('请先登录哔咔');return queue.retry(reqId(id))});handle('cancel-job',(id:string)=>queue.cancel(reqId(id)));handle('dismiss-job',(id:string)=>queue.dismiss(reqId(id)))
  handle('pause-job',(id:string)=>queue.pause(reqId(id)))
  handle('job-logs',(id:string)=>queue.logs(reqId(id)))
  handle('resume-job',(id:string)=>{if(!token)throw new Error('请先登录哔咔');return queue.resume(reqId(id))})
  handle('move-job',(id:string,direction:'up'|'down')=>queue.move(reqId(id),reqEnum(direction,['up','down'] as const,'direction')))
  handle('download-options',value=>queue.options(optRecord(value,'value') as any))
  return {stop:()=>queue.stop(), reset(all:boolean){
    if(all){token='';fs.rmSync(credentialFile,{force:true});fs.rmSync(credentialFile+'.tmp',{force:true})}
    queue=makeQueue();updates=createImageUpdates({db:getDb(),source,queue});jobsChanged()
  }}
}
