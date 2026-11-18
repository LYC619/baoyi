import {ipcMain,type BrowserWindow,type IpcMainInvokeEvent} from 'electron'
import { getDb } from '../services/database.ts'
import {audioFile,audioLyrics} from '../kinds/video/audio-playback.ts'
import {readContainerInfo} from '../kinds/video/mediainfo.ts'

export function registerAudioIpc(getWindow:()=>BrowserWindow|null):void {
  function assertMain(event:IpcMainInvokeEvent){const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('只允许主窗口读取音频资料')}
  ipcMain.handle('video:audio-lyrics',(event,id:string,episode='')=>{assertMain(event);return audioLyrics(getDb(),id,episode)})
  ipcMain.handle('video:audio-info',(event,id:string,episode='')=>{assertMain(event);return readContainerInfo(audioFile(getDb(),id,episode))})
}
