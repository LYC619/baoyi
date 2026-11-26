import { tr } from '../services/system/language.ts'
import {app,dialog,session,type BrowserWindow,type IpcMain} from 'electron'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {rememberDownloadRoot,validateDownloadRoot} from '../kinds/image/download-target.ts'
import fs from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import { getDb } from '../services/storage/database.ts'
import { getSettings } from '../services/storage/settings-store.ts'
import {libraryRestoreInProgress} from './library-backup.ts'
import {ComicRuntime} from '../kinds/image/comic-runtime.ts'
import {ComicCoverCache} from '../kinds/image/comic-cover-cache.ts'
import {ComicIngestService} from '../kinds/image/comic-ingest.ts'
import {createComicVerifier} from '../kinds/image/comic-verifier.ts'
import {comicProxyMap} from '../kinds/image/comic-proxy.ts'
import {ImageLibrary} from '../kinds/image/library.ts'
import {restoreWindowFocus} from '../services/system/window-focus.ts'
import type {ComicProxy} from '../../src/types/comic-ingest.ts'
import {comicProxy} from '../kinds/image/comic-source-rules.ts'
import {writeComicJson} from '../kinds/image/comic-files.ts'
import { optBool, optId, optRecord, optString, reqId, reqRecord, reqString, reqStringArray } from './validate.ts'

let cancelDiscovery=()=>{}
let current:ComicIngestService|undefined
export async function stopComicIngest(){cancelDiscovery();await current?.stopAll()}
export function reopenComicIngest(){current?.reopen()}
export function registerComicIngestIpc(getWindow:()=>BrowserWindow|null,ipc:Pick<IpcMain,'handle'>){
  const send=(name:string)=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send(name)}
  let jobNotice:ReturnType<typeof setTimeout>|undefined
  const jobsChanged=()=>{if(!jobNotice)jobNotice=setTimeout(()=>{jobNotice=undefined;send('image:jobs-changed')},250)}
  let proxySequence=Promise.resolve<Record<string,string>>({})
  const defaultsFile=path.join(app.getPath('userData'),'comic-preferences.json')
  let defaults:{proxy:ComicProxy;root:string}={proxy:{mode:'system'},root:''}
  const loaded=fs.readFile(defaultsFile,'utf8').then(text=>{const value=JSON.parse(text);defaults={proxy:comicProxy(value.proxy),root:typeof value.root==='string'?value.root:''}}).catch(()=>{ /* 偏好文件不存在或无效时使用系统代理与默认目录。 */ })
  const remember=async(patch:Partial<typeof defaults>)=>{await loaded;defaults={...defaults,...patch};await writeComicJson(defaultsFile,defaults)}
  const runtime=(proxy:ComicProxy)=>new ComicRuntime({python:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'hermes-runtime':'output/hermes-runtime','python/python.exe'),
      runtime:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'comic-runtime':'output/comic-runtime'),
      bridge:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'comic/bridge.py':'resources/comic/bridge.py'),
      proxies:()=>{proxySequence=proxySequence.catch(()=>({})).then(()=>comicProxyMap(proxy,getSettings(getDb()).proxy,session.fromPartition('comic-ingest-network')));return proxySequence}
    })
  const makeQueue=()=>new ComicIngestService({db:getDb(),authorizationDirectory:path.join(app.getPath('userData'),'comic-authorizations'),
    allowed:()=>!getSettings(getDb()).hide_hentai,assertIdle:()=>{if(libraryRestoreInProgress())throw new Error('资料库正在恢复，请等待重启')},
    changed:()=>send('image:changed'),jobsChanged,
    verifier:()=>createComicVerifier(pathToFileURL(path.join(app.getAppPath(),'dist-electron/comic-verify-worker.js'))),
    runtime

  })
  let queue=current=makeQueue()
  function handle(name:string,action:(...args:any[])=>unknown){ipc.handle('comic:'+name,(event,...args)=>{const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许主窗口操作漫画下载');if(libraryRestoreInProgress())throw new Error('资料库正在恢复，请等待重启');return action(...args)})}
  handle('defaults',async()=>{await loaded;return {proxy:defaults.proxy}})
  let browseController:AbortController|undefined
  const covers=new Set<AbortController>()
  const makeCoverCache=()=>new ComicCoverCache(path.join(app.getPath('userData'),'cache','comic-covers','jmcomic-2.7.11-v1'))
  let coverCache=makeCoverCache()
  const cancelBrowse=()=>{browseController?.abort();for(const controller of covers)controller.abort();covers.clear()}
  handle('browse',async(query,proxy)=>{if(getSettings(getDb()).hide_hentai)throw new Error('请先开启隐私内容访问');browseController?.abort();const controller=browseController=new AbortController();return runtime(comicProxy(proxy)).browse(randomUUID(),reqRecord(query,'query') as any,controller.signal)})
  handle('cover',async(id,proxy)=>{if(getSettings(getDb()).hide_hentai)throw new Error('请先开启隐私内容访问');const safeId=reqId(id);const connection=comicProxy(proxy);if(covers.size>=3)return '';const controller=new AbortController();covers.add(controller);try{return await coverCache.get(safeId,controller.signal,()=>runtime(connection).cover(randomUUID(),safeId,controller.signal))}finally{covers.delete(controller)}})
  cancelDiscovery=cancelBrowse
  handle('cancel-browse',cancelBrowse)
  handle('logs',id=>queue.logs(reqId(id)))
  handle('preview',async(input,proxy)=>{const result=await queue.preview(reqString(input,'input',{max:4096}),proxy);await remember({proxy:comicProxy(proxy)});return result});handle('cancel-preview',()=>queue.cancelPreview());handle('jobs',()=>queue.list())
  handle('start',async(token:string,chapters:string[],directory:string,groupId:string|null,root?:string)=>{
    token=reqString(token,'token',{max:256});chapters=reqStringArray(chapters,'chapters',{min:1,max:5000});directory=reqString(directory,'directory',{allowEmpty:true,max:512});groupId=optId(groupId,'groupId')??null;root=optString(root,'root',{max:4096})
    if(getSettings(getDb()).hide_hentai)throw new Error('请先开启隐私内容访问')
    await loaded
    if(root!==undefined){const target=await validateDownloadRoot(root);const id=await queue.enqueue(token,chapters,target,directory,groupId);await rememberDownloadRoot(app.getPath('userData'),'jm',target);return id}
    const lib=new ImageLibrary(getDb()),group=lib.groups().find(g=>g.id===groupId)
    const selected=await dialog.showOpenDialog(getWindow()!,{title:tr("选择漫画存放根目录（补章请选择原根目录）"),defaultPath:group?.directory||defaults.root||undefined,properties:['openDirectory','createDirectory']})
    restoreWindowFocus(getWindow());if(selected.canceled||!selected.filePaths[0])return null
    const id=await queue.enqueue(token,chapters,selected.filePaths[0],directory,groupId)
    await remember({root:selected.filePaths[0]});return id
  })
  handle('stop',(id:string,cancel=false)=>queue.stop(reqId(id),(optBool(cancel,'cancel')??false)?'cancelled':'paused'))
  handle('retry',async(id:string,proxy?:ComicProxy)=>{await queue.retry(reqId(id),optRecord(proxy,'proxy') as ComicProxy|undefined);if(proxy)await remember({proxy:comicProxy(proxy)})});handle('dismiss',id=>queue.dismiss(reqId(id)))
  handle('revalidate',async(id:string,token:string,root?:string)=>{
    id=reqId(id);token=reqString(token,'token',{max:256});root=optString(root,'root',{max:4096})
    const job=queue.list().find(j=>j.id===id);if(!job)throw new Error('漫画任务不可用')
    if(root!==undefined){await queue.revalidate(id,token,await validateDownloadRoot(root));return true}
    const selected=await dialog.showOpenDialog(getWindow()!,{title:tr("重新选择并核验任务原根目录"),defaultPath:job.root,properties:['openDirectory']})
    restoreWindowFocus(getWindow());if(selected.canceled||!selected.filePaths[0])return false
    await queue.revalidate(id,token,selected.filePaths[0]);await remember({root:selected.filePaths[0]});return true
  })
  handle('clean',async(id:string)=>{
    id=reqId(id)
    const job=queue.list().find(j=>j.id===id);if(!job)throw new Error('漫画任务不可用')
    const choice=await dialog.showMessageBox(getWindow()!,{type:'question',title:tr("清理漫画暂存"),message:tr("停止并清理“")+job.name+tr("”的未入库页面？"),detail:tr("已入库章节会保留。清理后需重新下载剩余页面；未知文件不会删除。"),buttons:[tr("保留暂存"),tr("停止并清理")],defaultId:0,cancelId:0})
    restoreWindowFocus(getWindow());if(choice.response===1)await queue.clean(id)
  })
  return async(all:boolean)=>{
    await loaded
    if(all)defaults={proxy:{mode:'system'},root:''}
    coverCache=makeCoverCache();queue=current=makeQueue();jobsChanged()
  }
}
