import {app,dialog,type BrowserWindow,type IpcMain} from 'electron'
import path from 'node:path'
import { getDb } from '../services/database.ts'
import { getSettings, patchSettings } from '../services/settings-store.ts'
import {onlineFetch} from '../services/online-network.ts'
import {createMusicService} from '../kinds/video/music.ts'
import {registerVideoContent} from '../kinds/video/registration.ts'
import {libraryRestoreInProgress} from './library-backup.ts'
let service:ReturnType<typeof createMusicService>|undefined
export const musicBusy=()=>service?.busy()||false
export const musicResponse=(request:Request)=>service?.response(request)||Promise.resolve(new Response(null,{status:404}))
export function registerMusicIpc(getWindow:()=>BrowserWindow|null,ipc:Pick<IpcMain,'handle'>){
  const root=()=>getSettings(getDb()).music_download_root||path.join(app.getPath('music'),'抱一音乐')
  const send=()=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('video:library-changed')}
  service=createMusicService({fetch:onlineFetch,stateFile:path.join(app.getPath('userData'),'music-downloads.json'),root,ready:()=>!libraryRestoreInProgress(),
    registered:id=>!!getDb().prepare("SELECT id FROM resource WHERE id=? AND kind='video'").get(id),
    changed:jobs=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('music:changed',jobs)},
    register:(track,file,cover,lyric)=>{const result=registerVideoContent(getDb(),{mediaKind:'audio',videoType:'movie',title:track.title,category:'音频',description:[track.artists.join(' / '),track.album].filter(Boolean).join(' · '),tags:[...track.artists,...(track.album?[track.album]:[])],posterPath:cover,sources:[{provider:'gd-'+track.source,externalId:track.id,scope:'work',pageUrl:'https://music.gdstudio.xyz/',evidence:'confirmed'}],items:[{title:track.title,order:1,description:track.album,files:[{path:file}],posterPath:cover,attachments:lyric?[{path:lyric,role:'attachment'}]:[]}]});send();return result.resourceId}})
  function handle(name:string,fn:(...args:any[])=>unknown){ipc.handle('music:'+name,(event,...args)=>{const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==event.sender.mainFrame)throw new Error('只能从主窗口使用音乐库');return fn(...args)})}
  handle('search',(source,query,page)=>service!.search(source,query,page))
  handle('preview',key=>service!.preview(key));handle('download',key=>service!.download(key))
  handle('jobs',()=>service!.list());handle('cancel',id=>service!.cancel(id));handle('retry',id=>service!.retry(id))
  handle('directory',root);handle('pick-directory',async()=>{const result=await dialog.showOpenDialog(getWindow()!,{title:'选择音乐保存目录',defaultPath:root(),properties:['openDirectory','createDirectory']});if(result.canceled||!result.filePaths[0])return null;patchSettings(getDb(), {music_download_root:result.filePaths[0]});return result.filePaths[0]})
  app.on('before-quit',()=>{for(const job of service!.list())if(job.status==='running')service!.cancel(job.id)})
}
