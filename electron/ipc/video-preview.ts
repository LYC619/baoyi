import {app,clipboard,dialog,shell,type BrowserWindow,type IpcMain} from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import {spawn} from 'node:child_process'
import Database from 'better-sqlite3'
import { getDb } from '../services/storage/database.ts'
import { getSettings } from '../services/storage/settings-store.ts'
import {libraryRestoreInProgress} from './library-backup.ts'
import {VideoPreviewService} from '../kinds/video/preview.ts'
import {VideoFrameCache} from '../kinds/video/frame-cache.ts'
import {openFrameIndex} from '../kinds/video/frame-index.ts'
import {removeProfileEntry} from '../services/storage/reset-files.ts'
import { optBool, optId, optString, reqId, reqString } from './validate.ts'

let service:VideoPreviewService|undefined
let frames:VideoFrameCache|undefined,frameDb:Database.Database|undefined,closing=Promise.resolve()
let frameGeneration=0
let closed:()=>void=()=>{}
export function closeVideoPreview(discard=false){
  frameGeneration++;service?.close();closed()
  const previous=frames,db=frameDb;frames=undefined;frameDb=undefined
  const cleanup=async()=>{
    try{await previous?.close()}finally{db?.close()}
    if(discard)await removeProfileEntry(app.getPath('userData'),'cache/video-frames')
  }
  // The caller receives the error; a later close can retry even after a failed removal.
  closing=closing.then(cleanup,cleanup);return closing
}
export const videoPreviewResponse=(request:Request)=>service?.response(request)??Promise.resolve(new Response(null,{status:404}))
export async function videoFrameResponse(request:Request){
  try{if(request.method!=='GET')return new Response(null,{status:405});const bytes=await frames?.readImage(new URL(request.url).pathname.slice(1));if(!bytes)return new Response(null,{status:404});return new Response(bytes,{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store'}})}catch{return new Response(null,{status:404})}
}
export function registerVideoPreviewIpc(getWindow:()=>BrowserWindow|null,ipc:Pick<IpcMain,'handle'>){
  closed=()=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('video-preview:closed')}
  service=new VideoPreviewService({db:getDb,hidden:()=>getSettings(getDb()).hide_hentai,blocked:libraryRestoreInProgress})
  const frameService=async()=>{
    const generation=frameGeneration
    await closing;if(libraryRestoreInProgress())throw new Error('资料库正在恢复')
    if(generation!==frameGeneration)throw new Error('预览范围已变化，请重新打开')
    if(!frames){
      const root=path.join(app.getPath('userData'),'cache','video-frames');await fs.mkdir(root,{recursive:true})
      if(generation!==frameGeneration||libraryRestoreInProgress())throw new Error('预览范围已变化，请重新打开')
      // Another request may have initialized the cache while mkdir yielded.
      if(frames)return frames
      const db=openFrameIndex(root,file=>new Database(file));frameDb=db
      frames=new VideoFrameCache({db,root,file:token=>service!.file(token),ffmpeg:()=>({file:getSettings(getDb()).ffmpeg_path||'',roots:getSettings(getDb()).software_scan_dirs}),changed:state=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('video-preview:frames',state)}})
    }
    return frames
  }
  const handle=(name:string,action:(...args:any[])=>unknown)=>ipc.handle('video-preview:'+name,(event,...args)=>{
    const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许主窗口使用视频试看')
    return action(...args)
  })
  handle('choices',(id,episodeId)=>service!.choices(reqId(id),optId(episodeId,'episodeId')))
  handle('open',(id,key)=>service!.open(reqId(id),optString(key,'key',{max:512})??''))
  handle('release',token=>service!.release(reqString(token,'token',{max:256})))
  handle('frames',async(token,retry)=>(await frameService()).subscribe(reqString(token,'token',{max:256}),optBool(retry,'retry')===true))
  handle('release-frames',id=>frames?.unsubscribe(reqId(id)))
  handle('frame-cache',async()=>(await frameService()).stats())
  handle('clear-frames',async()=>{await (await frameService()).clear()})
  handle('copy',async token=>clipboard.writeText(await service!.file(reqString(token,'token',{max:256}))))
  handle('reveal',async token=>shell.showItemInFolder(await service!.file(reqString(token,'token',{max:256}))))
  handle('pick-player',async()=>{
    const result=await dialog.showOpenDialog(getWindow()!,{title:'选择 PotPlayer 或 VLC',properties:['openFile'],filters:[{name:'播放器',extensions:['exe']}]})
    if(result.canceled||!result.filePaths[0])return null
    const file=result.filePaths[0]
    if(!/^(?:vlc|potplayer(?:mini)?(?:64)?)\.exe$/i.test(path.basename(file))||!(await fs.stat(file)).isFile())throw new Error('请选择 VLC 或 PotPlayer 的播放器程序')
    getDb().prepare("INSERT INTO settings(key,value) VALUES('_video_preview_player',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(file));return path.basename(file)
  })
  handle('external',async(token,custom)=>{
    const file=await service!.file(reqString(token,'token',{max:256})),saved=getDb().prepare("SELECT value FROM settings WHERE key='_video_preview_player'").get() as {value:string}|undefined; custom=optBool(custom,'custom')
    if(custom&&saved){
      const executable=JSON.parse(saved.value)
      try{
        if(!(await fs.stat(executable)).isFile())throw new Error('播放器不存在')
        await new Promise<void>((resolve,reject)=>{const child=spawn(executable,[file],{shell:false,windowsHide:true,detached:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve()})});return
      }catch{/* A moved player falls back to the current system association. */}
    }
    const error=await shell.openPath(file);if(error)throw new Error('播放器打开失败；可使用“在文件夹中显示”定位文件')
  })
}
