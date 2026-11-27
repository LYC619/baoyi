import { tr } from '../services/system/language.ts'
import { dialog, shell, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { mainWindowIpc } from './main-window.ts'
import { optEnum, optRecord, optString, optStringArray, reqId, reqRecord, reqString, reqStringArray } from './validate.ts'
import type { GameItem, GameQuery, LinkedFile } from '../../src/types'
import type { GameLaunchOptions } from '../../src/types/game-workspace'
import { relocateGame } from '../kinds/game/files'
import { getDb } from '../services/storage/database'
import { assertLibraryIdle } from './library-backup.ts'
import { COVER_EXTS } from '../kinds/game/links'
import {
  addGameLinks,
  backupSavePath,
  cancelGameScan,
  checkAllSavePaths,
  checkSavePath,
  clearGameCover,
  deleteSaveBackup,
  gameCountsOf,
  getGameItem,
  getSaveBackup,
  isGameRunning,
  launchGame,
  listGameItems,
  listOrphanSaveBackups,
  listSaveBackups,
  onGameSession,
  openGameLink,
  previewSaveBackup,
  previewSaveRestore,
  rebindSaveBackup,
  rebuildMissingGameCovers,
  registerManualGame,
  removeGame,
  restoreSaveBackup,
  reverifySavePath,
  scanGames,
  searchGameCovers,
  setGameCover,
  setGameCoverFromUrl,
  updateGameItem
} from '../kinds/game/service'

type MainIpc = ReturnType<typeof mainWindowIpc>

export function registerGameIpc(
  getWindow: () => BrowserWindow | null,
  ipcMain: MainIpc,
  send: (channel: string, payload: unknown) => void
): void {
  ipcMain.handle('game:relocate', async (_event, id: string, mode: 'directory' | 'file' = 'directory') => {
    mode = optEnum(mode, ['directory', 'file'] as const, 'mode') ?? 'directory'
    id = reqId(id)
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    const game = getGameItem(id)
    if (!game) throw new Error('游戏已不存在')
    const isAndroid = /\.apk$/i.test(game.path)
    const entryFilters = isAndroid
      ? [{ name: 'Android 安装包', extensions: ['apk'] }]
      : [{ name: '游戏入口', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
    const selected = await dialog.showOpenDialog(win, {
      title: mode === 'directory' ? tr("选择重命名或移动后的游戏文件夹") : isAndroid ? tr("选择安卓安装包") : tr("选择游戏主程序"),
      properties: [mode === 'directory' ? 'openDirectory' : 'openFile'],
      ...(mode === 'file' ? { filters: entryFilters } : {})
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    let file = selected.filePaths[0]
    let directory: string | undefined
    if (mode === 'directory') {
      directory = file
      const relative = path.relative(game.source_dir || path.dirname(game.path), game.path)
      file = path.join(directory, relative)
      if (
        relative.startsWith('..') ||
        !(
          await fs.stat(file).catch((cause) => {
            if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null
            throw cause
          })
        )?.isFile()
      ) {
        const picked = await dialog.showOpenDialog(win, {
          title: isAndroid ? tr("目录内未找到原安装包，请选择 .apk 文件") : tr("目录内未找到原入口，请选择主程序"),
          defaultPath: directory,
          properties: ['openFile'],
          filters: entryFilters
        })
        if (picked.canceled || !picked.filePaths[0]) return null
        file = picked.filePaths[0]
      }
    }
    return relocateGame(getDb(), id, file, directory, isAndroid ? 'Android' : 'Windows')
  })

  ipcMain.handle('game:list', (_e, query: GameQuery = {}) =>
    listGameItems((optRecord(query, 'query') ?? {}) as GameQuery)
  )
  ipcMain.handle('game:get', (_e, id: string) => getGameItem(reqId(id)))
  ipcMain.handle('game:update', (_e, id: string, patch: Partial<GameItem>) =>
    updateGameItem(reqId(id), reqRecord(patch, 'patch') as Partial<GameItem>)
  )
  ipcMain.handle('game:remove', (_e, id: string) => removeGame(reqId(id)))
  ipcMain.handle('game:counts', () => gameCountsOf())
  ipcMain.handle('game:scan', (_e, dirs: string[]) =>
    scanGames(reqStringArray(dirs, 'dirs', { min: 1, max: 500 }), (p) => send('game:progress', p))
  )
  ipcMain.on('game:cancel', () => cancelGameScan())

  ipcMain.handle('game:reveal', (_e, id: string) => {
    id = reqId(id)
    const game = getGameItem(id)
    if (!game?.path || !existsSync(game.path)) {
      throw new Error('未找到游戏启动文件，请先连接所在磁盘或重新定位目录')
    }
    shell.showItemInFolder(game.path)
  })

  ipcMain.handle('game:add-manual', async (_e, droppedFile?: string) => {
    const provided = optString(droppedFile, 'droppedFile', { max: 4096, trim: true })
    if (provided) {
      if (!path.isAbsolute(provided) || !existsSync(provided)) {
        throw new Error('未找到拖入的游戏启动文件')
      }
      if (!/\.(exe|lnk|bat|cmd)$/i.test(provided)) {
        throw new Error('手动登记仅支持 .exe、.lnk、.bat 或 .cmd 启动文件；也可直接拖入游戏文件夹扫描')
      }
      return registerManualGame(provided)
    }
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    const selected = await dialog.showOpenDialog(win, {
      title: tr("选择游戏启动文件"),
      properties: ['openFile'],
      filters: [{ name: tr("游戏启动文件"), extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    return registerManualGame(selected.filePaths[0])
  })

  ipcMain.handle('game:pick-dirs', async () => {
    const win = getWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      title: tr("选择游戏目录（可多选）"),
      properties: ['openDirectory', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('game:pick-save-dir', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: tr("选择这个游戏的存档目录"),
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return checkSavePath(result.filePaths[0])
  })

  ipcMain.handle('game:verify-save', (_e, id: string, target: string) =>
    reverifySavePath(reqId(id), reqString(target, 'target', { max: 4096 }))
  )
  ipcMain.handle('game:check-save-paths', () => checkAllSavePaths())

  ipcMain.handle('game:launch', (_e, id: string, options?: GameLaunchOptions) =>
    launchGame(reqId(id), optRecord(options, 'options') as any)
  )
  ipcMain.handle('game:running', (_e, id: string) => isGameRunning(reqId(id)))
  onGameSession((id, outcome) => send('game:session', { id, ...outcome }))

  ipcMain.handle('game:preview-backup', (_e, id: string, target: string) =>
    previewSaveBackup(reqId(id), reqString(target, 'target', { max: 4096 }))
  )
  ipcMain.handle('game:backup-save', (_e, id: string, savePath: string, note?: string) =>
    backupSavePath(reqId(id), reqString(savePath, 'savePath', { max: 4096 }), optString(note, 'note', { max: 200, trim: true }))
  )
  ipcMain.handle('game:backups', (_e, id: string) => listSaveBackups(reqId(id)))
  ipcMain.handle('game:orphan-backups', () => listOrphanSaveBackups())
  ipcMain.handle('game:rebind-backup', (_e, backupId: string, gameId: string) =>
    rebindSaveBackup(reqId(backupId, 'backupId'), reqId(gameId, 'gameId'))
  )
  ipcMain.handle('game:preview-restore', (_e, id: string, target?: string) =>
    previewSaveRestore(reqId(id), optString(target, 'target', { max: 4096 }))
  )
  ipcMain.handle('game:restore-backup', (_e, id: string, target?: string, expected?: string) =>
    restoreSaveBackup(
      reqId(id),
      optString(target, 'target', { max: 4096 }),
      optString(expected, 'expected', { max: 512 })
    )
  )
  ipcMain.handle('game:delete-backup', (_e, backupId: string) =>
    deleteSaveBackup(reqId(backupId, 'backupId'))
  )
  ipcMain.handle('game:open-backup', async (_e, backupId: string) => {
    const backup = getSaveBackup(reqId(backupId, 'backupId'))
    if (!backup?.backup_dir || !existsSync(backup.backup_dir)) {
      throw new Error('备份目录不存在或已被移动')
    }
    const err = await shell.openPath(backup.backup_dir)
    if (err) throw new Error('无法打开备份目录：' + err)
  })

  ipcMain.handle('game:pick-links', async (_e, id: string, kind: 'file' | 'dir' = 'file', type?: LinkedFile['type']) => {
    const safeId = reqId(id)
    const safeKind = optEnum(kind, ['file', 'dir'] as const, 'kind') ?? 'file'
    const safeType = optEnum(type, ['guide', 'trainer', 'mod', 'emulator', 'other'] as const, 'type')
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    const result = await dialog.showOpenDialog(win, {
      title: safeKind === 'dir' ? tr("选择要关联的文件夹（MOD、整合包…）") : tr("选择要关联的文件（攻略、修改器…）"),
      properties: safeKind === 'dir' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    assertLibraryIdle()
    return addGameLinks(safeId, result.filePaths, safeType)
  })

  ipcMain.handle('game:open-link', (_e, id: string, target: string) =>
    openGameLink(reqId(id), reqString(target, 'target', { max: 4096 }))
  )
  ipcMain.handle('game:reveal-link', (_e, id: string, target: string) =>
    openGameLink(reqId(id), reqString(target, 'target', { max: 4096 }), 'reveal')
  )

  ipcMain.handle('game:pick-cover', async (_e, id: string) => {
    const safeId = reqId(id)
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    const result = await dialog.showOpenDialog(win, {
      title: tr("选择封面图（竖版 2:3 效果最好）"),
      properties: ['openFile'],
      filters: [{ name: tr("图片"), extensions: COVER_EXTS.map((e) => e.slice(1)) }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const outcome = setGameCover(safeId, result.filePaths[0])
    return { ...outcome, item: outcome.ok ? getGameItem(safeId) : null }
  })

  ipcMain.handle('game:clear-cover', (_e, id: string) => clearGameCover(reqId(id)))
  ipcMain.handle('game:search-covers', (_e, id: string) => searchGameCovers(reqId(id)))
  ipcMain.handle('game:set-cover-url', async (_e, id: string, url: string) => {
    const safeId = reqId(id)
    const outcome = await setGameCoverFromUrl(safeId, reqString(url, 'url', { max: 4096 }))
    return { ...outcome, item: outcome.ok ? getGameItem(safeId) : null }
  })
  ipcMain.handle('game:rebuild-covers', (_e, ids: string[] = []) =>
    rebuildMissingGameCovers(optStringArray(ids, 'ids', { max: 5000 }) ?? [], (progress) =>
      send('game:cover-progress', progress)
    )
  )
}
