import { tr } from '../services/system/language.ts'
import { app, dialog, nativeImage, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { coversDir, getDb } from '../services/storage/database.ts'
import { getGame } from '../kinds/game/db.ts'
import { previewGameProjects, importGameProjects, checkGameProjects } from '../kinds/game/project-catalog.ts'
import { gameLinkStates, readGameLink } from '../kinds/game/link-reader.ts'
import { assertLibraryIdle } from './library-backup.ts'
import type { GameProjectPreview, GameArtworkChoices } from '../../src/types/game-project'
import { restoreProjectArtwork } from '../kinds/game/project-artwork.ts'
import { validateCoverFile, invalidateGameCoverRequests } from '../kinds/game/service.ts'
import { optRecord, reqId, reqString, reqStringArray } from './validate.ts'

export function registerGameProjectIpc(getWindow: () => BrowserWindow | null, ipcMain: Pick<Electron.IpcMain, 'handle'>): void {
  let preview: { value: GameProjectPreview; at: number } | null = null
  const artworkContext = () => ({coversDir: coversDir(), recoveryDir: path.join(app.getPath('userData'), 'project-artwork-recovery'), validate: validateCoverFile})
  const assertMain = (event: IpcMainInvokeEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('只允许主窗口操作游戏项目')
  }
  ipcMain.handle('game:preview-projects', async event => {
    assertMain(event)
    preview = null
    const result = await dialog.showOpenDialog(getWindow()!, { title:tr("选择游戏项目清单 library.json"), properties:['openFile'], filters:[{name:tr("游戏项目清单"),extensions:['json']}] })
    if (result.canceled || !result.filePaths[0]) return null
    const value = previewGameProjects(getDb(),result.filePaths[0])
    for (const candidate of value.candidates) for (const image of candidate.artwork || []) {
      for (const [file, property] of [[image.path, 'previewUrl'], [image.currentPath, 'currentPreviewUrl']] as const) {
        if (!file || property === 'previewUrl' && ['unavailable','protected'].includes(image.state)) continue
        const valid = validateCoverFile(file)
        if (valid.ok) image[property] = nativeImage.createFromPath(file).resize({width: image.role === 'portrait' ? 120 : 220}).toDataURL()
        else if (property === 'previewUrl') image.detail = valid.message + '；取消此图片勾选后仍可登记资料'
      }
    }
    preview = {value,at:Date.now()}
    return value
  })
  ipcMain.handle('game:import-projects', (event,token:string,selected:string[],artwork:GameArtworkChoices = {}) => {
    assertMain(event); assertLibraryIdle()
    token = reqString(token, 'token', { max: 256 }); selected = reqStringArray(selected, 'selected'); artwork = (optRecord(artwork, 'artwork') ?? {}) as GameArtworkChoices; if (!preview || token !== preview.value.token || Date.now()-preview.at > 30*60_000) throw new Error('导入预览已失效，请重新选择项目清单')
    const result = importGameProjects(getDb(),preview.value,selected,artwork,artworkContext())
    for (const item of result.items) if (artwork[item.key]?.length) invalidateGameCoverRequests(item.id)
    preview = null
    return result
  })
  ipcMain.handle('game:restore-project-artwork', async event => {
    assertMain(event); assertLibraryIdle()
    const context = artworkContext()
    const picked = await dialog.showOpenDialog(getWindow()!, {title:tr("选择图片登记撤销记录 artwork.json"), defaultPath:context.recoveryDir, properties:['openFile'], filters:[{name:tr("图片登记记录"),extensions:['json']}]})
    if (picked.canceled || !picked.filePaths[0]) return 0
    const names = restoreProjectArtwork(getDb(), picked.filePaths[0], context)
    const answer = await dialog.showMessageBox(getWindow()!, {type:'question', buttons:[tr("取消"),tr("撤销这些图片更新")], defaultId:0, cancelId:0, message:tr("恢复 {p0} 款游戏的登记前图片", {p0: (names.length)}), detail:names.join('\n')+tr("\n攻略、笔记和游玩记录保留。")})
    if (answer.response !== 1) return 0
    assertLibraryIdle()
    const count = restoreProjectArtwork(getDb(), picked.filePaths[0], context, true).length
    for (const row of getDb().prepare("SELECT id FROM resource WHERE kind='game'").all() as {id:string}[]) invalidateGameCoverRequests(row.id)
    preview = null
    return count
  })
  ipcMain.handle('game:check-projects',event=>{assertMain(event);return checkGameProjects(getDb())})
  ipcMain.handle('game:link-states', (event,id:string) => {
    assertMain(event)
    return gameLinkStates(getGame(getDb(),reqId(id))?.linked_files || [])
  })
  ipcMain.handle('game:read-link', (event,id:string,target:string) => {
    assertMain(event)
    const game = getGame(getDb(),reqId(id))
    if (!game) throw new Error('游戏不存在')
    return readGameLink(game.linked_files,reqString(target,'target',{max:4096}))
  })
}
