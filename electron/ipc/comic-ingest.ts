import {app,dialog,session,type BrowserWindow,type IpcMain} from 'electron'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {rememberDownloadRoot,validateDownloadRoot} from '../kinds/image/download-target.ts'
import fs from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {getDb,getSettings} from '../services/database.ts'
import {libraryRestoreInProgress} from './library-backup.ts'
import {ComicRuntime} from '../kinds/image/comic-runtime.ts'
import {ComicIngestService} from '../kinds/image/comic-ingest.ts'
import {createComicVerifier} from '../kinds/image/comic-verifier.ts'
import {comicProxyMap} from '../kinds/image/comic-proxy.ts'
import {ImageLibrary} from '../kinds/image/library.ts'
import {restoreWindowFocus} from '../services/window-focus.ts'
import type {ComicProxy} from '../../src/types/comic-ingest.ts'
import {comicProxy} from '../kinds/image/comic-source-rules.ts'
import {writeComicJson} from '../kinds/image/comic-files.ts'

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
  const loaded=fs.readFile(defaultsFile,'utf8').then(text=>{const value=JSON.parse(text);defaults={proxy:comicProxy(value.proxy),root:typeof value.root==='string'?value.root:''}}).catch(()=>{})
  const remember=async(patch:Partial<typeof defaults>)=>{await loaded;defaults={...defaults,...patch};await writeComicJson(defaultsFile,defaults)}
  const runtime=(proxy:ComicProxy)=>new ComicRuntime({python:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'hermes-runtime':'output/hermes-runtime','python/python.exe'),
      runtime:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'comic-runtime':'output/comic-runtime'),
      bridge:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'comic/bridge.py':'resources/comic/bridge.py'),
      proxies:()=>{proxySequence=proxySequence.catch(()=>({})).then(()=>comicProxyMap(proxy,getSettings().proxy,session.fromPartition('comic-ingest-network')));return proxySequence}
    })
  const queue=current=new ComicIngestService({db:getDb(),authorizationDirectory:path.join(app.getPath('userData'),'comic-authorizations'),
    allowed:()=>!getSettings().hide_hentai,assertIdle:()=>{if(libraryRestoreInProgress())throw new Error('资料库正在恢复，请等待重启')},
    changed:()=>send('image:changed'),jobsChanged,
    verifier:()=>createComicVerifier(pathToFileURL(path.join(app.getAppPath(),'dist-electron/comic-verify-worker.js'))),
    runtime

  })
  function handle(name:string,action:(...args:any[])=>unknown){ipc.handle('comic:'+name,(event,...args)=>{const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许主窗口操作漫画摄入');if(libraryRestoreInProgress())throw new Error('资料库正在恢复，请等待重启');return action(...args)})}
  handle('defaults',async()=>{await loaded;return {proxy:defaults.proxy}})
  let browseController:AbortController|undefined
  const covers=new Set<AbortController>()
  const cancelBrowse=()=>{browseController?.abort();for(const controller of covers)controller.abort();covers.clear()}
  handle('browse',async(query,proxy)=>{if(getSettings().hide_hentai)throw new Error('请先开启隐私内容访问');browseController?.abort();const controller=browseController=new AbortController();return runtime(comicProxy(proxy)).browse(randomUUID(),query,controller.signal)})
  handle('cover',async(id,proxy)=>{if(getSettings().hide_hentai)throw new Error('请先开启隐私内容访问');if(covers.size>=3)return '';const controller=new AbortController();covers.add(controller);try{return await runtime(comicProxy(proxy)).cover(randomUUID(),id,controller.signal)}finally{covers.delete(controller)}})
  cancelDiscovery=cancelBrowse
  handle('cancel-browse',cancelBrowse)
  app.on('before-quit',cancelBrowse)
  handle('logs',id=>queue.logs(id))
  handle('preview',async(input,proxy)=>{const result=await queue.preview(input,proxy);await remember({proxy:comicProxy(proxy)});return result});handle('cancel-preview',()=>queue.cancelPreview());handle('jobs',()=>queue.list())
  handle('start',async(token:string,chapters:string[],directory:string,groupId:string|null,root?:string)=>{
    if(getSettings().hide_hentai)throw new Error('请先开启隐私内容访问')
    await loaded
    if(root!==undefined){const target=await validateDownloadRoot(root);const id=await queue.enqueue(token,chapters,target,directory,groupId);void rememberDownloadRoot(app.getPath('userData'),'jm',target).catch(()=>{});return id}
    const lib=new ImageLibrary(getDb()),group=lib.groups().find(g=>g.id===groupId)
    const selected=await dialog.showOpenDialog(getWindow()!,{title:'选择漫画存放根目录（补章请选择原根目录）',defaultPath:group?.directory||defaults.root||undefined,properties:['openDirectory','createDirectory']})
    restoreWindowFocus(getWindow());if(selected.canceled||!selected.filePaths[0])return null
    const id=await queue.enqueue(token,chapters,selected.filePaths[0],directory,groupId)
    await remember({root:selected.filePaths[0]});return id
  })
  handle('stop',(id:string,cancel=false)=>queue.stop(id,cancel?'cancelled':'paused'))
  handle('retry',async(id:string,proxy?:ComicProxy)=>{await queue.retry(id,proxy);if(proxy)await remember({proxy:comicProxy(proxy)})});handle('dismiss',id=>queue.dismiss(id))
  handle('revalidate',async(id:string,token:string,root?:string)=>{
    const job=queue.list().find(j=>j.id===id);if(!job)throw new Error('漫画任务不可用')
    if(root!==undefined){await queue.revalidate(id,token,await validateDownloadRoot(root));return true}
    const selected=await dialog.showOpenDialog(getWindow()!,{title:'重新选择并核验任务原根目录',defaultPath:job.root,properties:['openDirectory']})
    restoreWindowFocus(getWindow());if(selected.canceled||!selected.filePaths[0])return false
    await queue.revalidate(id,token,selected.filePaths[0]);await remember({root:selected.filePaths[0]});return true
  })
  handle('clean',async(id:string)=>{
    const job=queue.list().find(j=>j.id===id);if(!job)throw new Error('漫画任务不可用')
    const choice=await dialog.showMessageBox(getWindow()!,{type:'question',title:'清理漫画暂存',message:'停止并清理“'+job.name+'”的未入库页面？',detail:'已入库章节会保留。清理后需重新下载剩余页面；未知文件不会删除。',buttons:['保留暂存','停止并清理'],defaultId:0,cancelId:0})
    restoreWindowFocus(getWindow());if(choice.response===1)await queue.clean(id)
  })
  let quitting=false
  app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;void queue.stopAll().finally(()=>app.quit())})
}
