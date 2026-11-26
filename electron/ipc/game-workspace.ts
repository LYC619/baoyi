import { tr } from '../services/system/language.ts'
import {dialog,type BrowserWindow,type IpcMainInvokeEvent} from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getDb } from '../services/storage/database.ts'
import {getGame,updateGame} from '../kinds/game/db.ts'
import {replaceCoverFile,validateCoverFile} from '../kinds/game/service.ts'
import {COVER_EXTS} from '../kinds/game/links.ts'
import {listGameNotes,saveGameNote,removeGameNote} from '../kinds/game/notes.ts'
import {patchGameLink,setDefaultGameEntry} from '../kinds/game/workspace.ts'
import {previewGameLink} from '../kinds/game/preview.ts'
import {assertLibraryIdle} from './library-backup.ts'
import type {GameNoteInput} from '../../src/types/game-workspace'
import type {LinkedFile} from '../../src/types'
import { reqId, reqNumber, reqRecord, reqString } from './validate.ts'
export function registerGameWorkspaceIpc(getWindow:()=>BrowserWindow|null,ipcMain:Pick<Electron.IpcMain,'handle'>){
 function guard(e:IpcMainInvokeEvent,write=false){const w=getWindow();if(!w||w.isDestroyed()||e.sender!==w.webContents||e.senderFrame!==w.webContents.mainFrame)throw Error('只允许主窗口操作游戏资料');if(write)assertLibraryIdle()}
 ipcMain.handle('game:notes:list',(e,id:string)=>{guard(e);return listGameNotes(getDb(),reqId(id))})
 ipcMain.handle('game:notes:save',(e,id:string,input:GameNoteInput)=>{guard(e,true);return saveGameNote(getDb(),reqId(id),reqRecord(input,'input') as unknown as GameNoteInput)})
 ipcMain.handle('game:notes:remove',(e,id:string,note:string,stamp:number)=>{guard(e,true);removeGameNote(getDb(),reqId(id),reqId(note,'note'),reqNumber(stamp,'stamp',{min:0}))})
 ipcMain.handle('game:notes:export',async(e,id:string,note:string)=>{guard(e);const value=listGameNotes(getDb(),reqId(id)).find(n=>n.id===reqId(note,'note'));if(!value)throw Error('笔记不存在');const result=await dialog.showSaveDialog(getWindow()!,{title:tr("导出 Markdown 笔记"),defaultPath:value.title.replace(/[<>:"/\\|?*]/g,'_')+'.md',filters:[{name:'Markdown',extensions:['md']}]});if(result.canceled||!result.filePath)return false;await fs.writeFile(result.filePath,value.body,'utf8');return true})
 ipcMain.handle('game:link:patch',(e,id:string,target:string,patch:Partial<LinkedFile>|null,expected:string)=>{guard(e,true);return patchGameLink(getDb(),reqId(id),reqString(target,'target',{max:4096}),patch===null?null:reqRecord(patch,'patch') as Partial<LinkedFile>,reqString(expected,'expected',{allowEmpty:true,max:512}))})
 ipcMain.handle('game:link:preview',(e,id:string,target:string)=>{guard(e);const game=getGame(getDb(),reqId(id));if(!game)throw Error('游戏不存在');return previewGameLink(game.linked_files,reqString(target,'target',{max:4096}),[path.dirname(game.path),game.source_dir].filter(Boolean))})
 ipcMain.handle('game:default-entry',(e,id:string,target:string)=>{guard(e,true);return setDefaultGameEntry(getDb(),reqId(id),reqString(target,'target',{max:4096}))})
 ipcMain.handle('game:background:pick',async(e,id:string)=>{
  guard(e,true);const gameId=reqId(id);if(!getGame(getDb(),gameId))throw Error('游戏不存在')
  const result=await dialog.showOpenDialog(getWindow()!,{title:tr("选择横版封面"),properties:['openFile'],filters:[{name:tr("图片"),extensions:COVER_EXTS.map(e=>e.slice(1))}]})
  if(result.canceled||!result.filePaths[0])return null
  guard(e,true);if(!getGame(getDb(),gameId))throw Error('游戏已被移除')
  const file=result.filePaths[0],valid=validateCoverFile(file);if(!valid.ok)throw Error(valid.message)
  const saved=replaceCoverFile(gameId+'-background',file,path.extname(file).toLowerCase(),target=>{updateGame(getDb(),gameId,{background_path:target})})
  if(!saved.ok)throw Error(saved.message)
  return getGame(getDb(),gameId)
 })
 ipcMain.handle('game:background:clear',(e,id:string)=>{guard(e,true);return updateGame(getDb(),reqId(id),{background_path:''})})
}
