import {ipcMain,dialog,type BrowserWindow,type IpcMainInvokeEvent} from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getDb } from '../services/database.ts'
import {getGame,updateGame} from '../kinds/game/db.ts'
import {replaceCoverFile,validateCoverFile} from '../kinds/game/service.ts'
import {COVER_EXTS} from '../kinds/game/links.ts'
import {listGameNotes,saveGameNote,removeGameNote} from '../kinds/game/notes.ts'
import {patchGameLink,setDefaultGameEntry} from '../kinds/game/workspace.ts'
import {previewGameLink} from '../kinds/game/preview.ts'
import {assertLibraryIdle} from './library-backup.ts'
import type {GameNoteInput} from '../../src/types/game-workspace'
import type {LinkedFile} from '../../src/types'
export function registerGameWorkspaceIpc(getWindow:()=>BrowserWindow|null){
 function guard(e:IpcMainInvokeEvent,write=false){const w=getWindow();if(!w||w.isDestroyed()||e.sender!==w.webContents||e.senderFrame!==w.webContents.mainFrame)throw Error('只允许主窗口操作游戏资料');if(write)assertLibraryIdle()}
 ipcMain.handle('game:notes:list',(e,id:string)=>{guard(e);return listGameNotes(getDb(),id)})
 ipcMain.handle('game:notes:save',(e,id:string,input:GameNoteInput)=>{guard(e,true);return saveGameNote(getDb(),id,input)})
 ipcMain.handle('game:notes:remove',(e,id:string,note:string,stamp:number)=>{guard(e,true);removeGameNote(getDb(),id,note,stamp)})
 ipcMain.handle('game:notes:export',async(e,id:string,note:string)=>{guard(e);const value=listGameNotes(getDb(),id).find(n=>n.id===note);if(!value)throw Error('笔记不存在');const result=await dialog.showSaveDialog(getWindow()!,{title:'导出 Markdown 笔记',defaultPath:value.title.replace(/[<>:"/\\|?*]/g,'_')+'.md',filters:[{name:'Markdown',extensions:['md']}]});if(result.canceled||!result.filePath)return false;await fs.writeFile(result.filePath,value.body,'utf8');return true})
 ipcMain.handle('game:link:patch',(e,id:string,target:string,patch:Partial<LinkedFile>|null,expected:string)=>{guard(e,true);return patchGameLink(getDb(),id,target,patch,expected)})
 ipcMain.handle('game:link:preview',(e,id:string,target:string)=>{guard(e);const game=getGame(getDb(),id);if(!game)throw Error('游戏不存在');return previewGameLink(game.linked_files,target)})
 ipcMain.handle('game:default-entry',(e,id:string,target:string)=>{guard(e,true);return setDefaultGameEntry(getDb(),id,target)})
 ipcMain.handle('game:background:pick',async(e,id:string)=>{
  guard(e,true);if(!getGame(getDb(),id))throw Error('游戏不存在')
  const result=await dialog.showOpenDialog(getWindow()!,{title:'选择横版封面',properties:['openFile'],filters:[{name:'图片',extensions:COVER_EXTS.map(e=>e.slice(1))}]})
  if(result.canceled||!result.filePaths[0])return null
  guard(e,true);if(!getGame(getDb(),id))throw Error('游戏已被移除')
  const file=result.filePaths[0],valid=validateCoverFile(file);if(!valid.ok)throw Error(valid.message)
  const saved=replaceCoverFile(id+'-background',file,path.extname(file).toLowerCase(),target=>{updateGame(getDb(),id,{background_path:target})})
  if(!saved.ok)throw Error(saved.message)
  return getGame(getDb(),id)
 })
 ipcMain.handle('game:background:clear',(e,id:string)=>{guard(e,true);return updateGame(getDb(),id,{background_path:''})})
}
