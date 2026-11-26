import type {BrowserWindow,IpcMainInvokeEvent} from 'electron'
import { getDb } from '../services/storage/database.ts'
import {audioFile,audioLyrics} from '../kinds/video/audio-playback.ts'
import {readContainerInfo} from '../kinds/video/mediainfo.ts'
import { optString, reqId } from './validate.ts'

export function registerAudioIpc(getWindow:()=>BrowserWindow|null,ipcMain:Pick<Electron.IpcMain,'handle'>):void {
  function assertMain(event:IpcMainInvokeEvent){const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('只允许主窗口读取音频资料')}
  ipcMain.handle('video:audio-lyrics',(event,id:string,episode='')=>{assertMain(event);return audioLyrics(getDb(),reqId(id),optString(episode,'episode',{max:256})??'')})
  ipcMain.handle('video:audio-info',(event,id:string,episode='')=>{assertMain(event);return readContainerInfo(audioFile(getDb(),reqId(id),optString(episode,'episode',{max:256})??''))})
}
