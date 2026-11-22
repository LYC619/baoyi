import { dialog, type BrowserWindow } from 'electron'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { mainWindowIpc } from './main-window.ts'
import { optBool, optEnum, optRecord, optString, optStringArray, reqArray, reqId, reqNumber, reqRecord, reqString, reqStringArray } from './validate.ts'
import type { OrganizeCommand, PendingItem, SoftwareItem, SoftwareQuery } from '../../src/types'
import {
  clearSkipped,
  confirmPending,
  countPending,
  countSkipped,
  counts,
  getSoftware,
  listPending,
  listSoftware,
  listSkipped,
  removeSkipped,
  skipPending,
  updatePending,
  updateSoftware
} from '../kinds/software/db.ts'
import { listOrganizePlans } from '../services/storage/organize-plans.ts'
import { listScanUnits, resetScanUnit, resetScanUnits } from '../services/storage/scan-units.ts'
import { getDb } from '../services/storage/database'
import { launchSoftware, revealInFolder } from '../kinds/software/launcher'
import {
  deleteSoftwareRecord,
  listOrganized,
  materialize,
  previewOrganize,
  previewRelocateOrganized,
  relocateOrganized,
  runOrganize,
  undoOrganize,
  unlink
} from '../kinds/software/organize'
import { removeOrphanLinks, syncOrganizeRoot } from '../kinds/software/organize/sync'
import { withOrganizeMutation } from '../kinds/software/organize/mutation'
import { addSingleExe, cancelScan, scanDirectories } from '../kinds/software/scanner'
import { SOFTWARE_EXTENSIONS } from '../../src/utils/software-package'
import { ICON_EXTS } from '../kinds/software/icons'
import { appendSoftwareLauncher, clearSoftwareIcon, refreshSoftwareIcons, relocateSoftware, setSoftwareIcon } from '../kinds/software/service'

type MainIpc = ReturnType<typeof mainWindowIpc>

export function registerSoftwareIpc(
  getWindow: () => BrowserWindow | null,
  ipcMain: MainIpc,
  send: (channel: string, payload: unknown) => void
): void {
  ipcMain.handle('software:list', (_e, query: SoftwareQuery = {}) =>
    listSoftware(getDb(), (optRecord(query, 'query') ?? {}) as SoftwareQuery)
  )
  ipcMain.handle('software:get', (_e, id: string) => getSoftware(getDb(), reqId(id)))
  ipcMain.handle('software:update', (_e, id: string, patch: Partial<SoftwareItem>) =>
    updateSoftware(getDb(), reqId(id), reqRecord(patch, 'patch') as Partial<SoftwareItem>)
  )
  ipcMain.handle('software:remove', (_e, id: string) =>
    withOrganizeMutation(() => deleteSoftwareRecord(reqId(id)))
  )
  ipcMain.handle('software:counts', (_e, unusedDays: number) =>
    counts(getDb(), reqNumber(unusedDays, 'unusedDays', { min: 0, max: 36500, integer: true }))
  )
  ipcMain.handle('software:launch', (_e, id: string, launcherPath?: string) =>
    launchSoftware(reqId(id), optString(launcherPath, 'launcherPath', { max: 4096 }))
  )
  ipcMain.handle('software:reveal', (_e, id: string, launcherPath?: string) =>
    revealInFolder(reqId(id), optString(launcherPath, 'launcherPath', { max: 4096 }))
  )

  ipcMain.handle('software:pick-icon', async (_e, id: string) => {
    const safeId = reqId(id)
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择图标图片（正方形效果更好）',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ICON_EXTS.map((e) => e.slice(1)) }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const outcome = setSoftwareIcon(safeId, result.filePaths[0])
    return { ...outcome, item: outcome.ok ? getSoftware(getDb(), safeId) : null }
  })
  ipcMain.handle('software:clear-icon', (_e, id: string) => clearSoftwareIcon(reqId(id)))
  ipcMain.handle('software:refresh-icons', () => refreshSoftwareIcons())
  ipcMain.handle('software:relocate', async (_e, id: string, mode: 'directory' | 'file' = 'directory') => {
    const safeId = reqId(id)
    const safeMode = optEnum(mode, ['directory', 'file'] as const, 'mode') ?? 'directory'
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    const current = getSoftware(getDb(), safeId)
    if (!current) throw new Error('软件条目已不存在')
    const selected = await dialog.showOpenDialog(win, {
      title: safeMode === 'directory' ? '选择移动或改名后的软件文件夹' : '选择软件主程序或安装包',
      properties: [safeMode === 'directory' ? 'openDirectory' : 'openFile'],
      ...(safeMode === 'file' ? { filters: [{ name: '程序与安装包', extensions: SOFTWARE_EXTENSIONS }] } : {})
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    let file = selected.filePaths[0]
    let directory: string | undefined
    if (safeMode === 'directory') {
      directory = file
      const rel = path.relative(current.source_dir || path.dirname(current.exe_path), current.exe_path)
      file = path.join(directory, rel)
      if (rel.startsWith('..') || !existsSync(file) || !statSync(file).isFile()) {
        const picked = await dialog.showOpenDialog(win, {
          title: '文件夹内未找到原程序，请选择主程序',
          defaultPath: directory,
          properties: ['openFile'],
          filters: [{ name: '程序与安装包', extensions: SOFTWARE_EXTENSIONS }]
        })
        if (picked.canceled || !picked.filePaths[0]) return null
        file = picked.filePaths[0]
      }
    }
    return relocateSoftware(safeId, file, directory)
  })
  ipcMain.handle('software:pick-launcher', async (_e, id: string) => {
    const safeId = reqId(id)
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    if (!getSoftware(getDb(), safeId)) throw new Error('软件条目已不存在')
    const selected = await dialog.showOpenDialog(win, {
      title: '选择附属或备用启动程序',
      properties: ['openFile'],
      filters: [{ name: '启动文件', extensions: ['exe', 'bat', 'cmd', 'lnk'] }]
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    return appendSoftwareLauncher(safeId, selected.filePaths[0])
  })

  ipcMain.handle('software:add-manual', async (_e, droppedFiles?: string[]) => {
    const provided = optStringArray(droppedFiles, 'droppedFiles', { max: 500 })
    let filePaths: string[]
    if (provided && provided.length > 0) {
      const allowed = new Set(SOFTWARE_EXTENSIONS.map((ext) => ext.toLowerCase()))
      filePaths = provided.map((raw) => {
        if (!path.isAbsolute(raw) || !existsSync(raw) || !statSync(raw).isFile()) {
          throw new Error('未找到拖入的程序文件，请确认文件存在')
        }
        const ext = path.extname(raw).slice(1).toLowerCase()
        if (!allowed.has(ext)) {
          throw new Error(`暂不支持直接添加 .${ext || '未知'} 文件，可拖入整个软件文件夹进行扫描`)
        }
        return raw
      })
    } else {
      const win = getWindow()
      if (!win) return []
      const result = await dialog.showOpenDialog(win, {
        title: '选择要添加的程序',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '程序与手机 APP 安装包', extensions: SOFTWARE_EXTENSIONS }]
      })
      if (result.canceled) return []
      filePaths = result.filePaths
    }

    const added: SoftwareItem[] = []
    for (const file of filePaths) {
      added.push(...(await addSingleExe(file)))
    }
    return added
  })

  ipcMain.handle('pending:list', () => listPending(getDb()))
  ipcMain.handle('pending:count', () => countPending(getDb()))
  ipcMain.handle('pending:update', (_e, id: string, patch: Partial<PendingItem>) =>
    updatePending(getDb(), reqId(id), reqRecord(patch, 'patch') as Partial<PendingItem>)
  )
  ipcMain.handle('pending:confirm', (_e, ids: string[]) =>
    confirmPending(getDb(), reqStringArray(ids, 'ids', { min: 1, max: 5000 }))
  )
  ipcMain.handle('pending:skip', (_e, ids: string[]) =>
    skipPending(getDb(), reqStringArray(ids, 'ids', { min: 1, max: 5000 }))
  )
  ipcMain.handle('pending:skipped-count', () => countSkipped(getDb()))
  ipcMain.handle('pending:clear-skipped', () => clearSkipped(getDb()))
  ipcMain.handle('pending:skipped-list', () => listSkipped(getDb()))
  ipcMain.handle('pending:remove-skipped', (_e, exePath: string) =>
    removeSkipped(getDb(), reqString(exePath, 'exePath', { max: 4096 }))
  )

  ipcMain.handle('scan:pick-dir', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择要扫描的目录',
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('scan:run', async (_e, dirs: string[], directDirs?: boolean) =>
    scanDirectories(
      reqStringArray(dirs, 'dirs', { min: 1, max: 500 }),
      (p) => send('scan:progress', p),
      optBool(directDirs, 'directDirs') === true
    )
  )
  ipcMain.on('scan:cancel', () => cancelScan())
  ipcMain.handle('scan:units', () => listScanUnits(getDb()))
  ipcMain.handle('scan:reset', () => resetScanUnits(getDb()))
  ipcMain.handle('scan:reset-one', (_e, dir: string) =>
    resetScanUnit(getDb(), reqString(dir, 'dir', { max: 4096 }))
  )

  ipcMain.handle('organize:pick-root', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择整理目标根目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('organize:preview', (_e, ids?: string[]) =>
    previewOrganize(optStringArray(ids, 'ids', { max: 5000 }))
  )
  ipcMain.handle('organize:run', (_e, commands: OrganizeCommand[]) =>
    withOrganizeMutation(() =>
      runOrganize(reqArray(commands, 'commands', { min: 1, max: 5000 }), (p) => send('organize:progress', p))
    )
  )
  ipcMain.handle('organize:plans', () => listOrganizePlans(getDb()))
  ipcMain.handle('organize:undo', (_e, planId: string) =>
    withOrganizeMutation(() => undoOrganize(reqId(planId, 'planId')))
  )
  ipcMain.handle('organize:materialize', (_e, id: string) =>
    withOrganizeMutation(() => materialize(reqId(id)))
  )
  ipcMain.handle('organize:unlink', (_e, id: string) =>
    withOrganizeMutation(() => unlink(reqId(id)))
  )
  ipcMain.handle('organize:organized', (_e, ids?: string[]) =>
    listOrganized(optStringArray(ids, 'ids', { max: 5000 }))
  )
  ipcMain.handle('organize:sync', () => withOrganizeMutation(() => syncOrganizeRoot()))
  ipcMain.handle('organize:preview-relocate', (_e, id: string, category: string, folder: string) =>
    previewRelocateOrganized(
      reqId(id),
      reqString(category, 'category', { allowEmpty: true, max: 200 }),
      reqString(folder, 'folder', { max: 512 })
    )
  )
  ipcMain.handle('organize:relocate', (_e, id: string, category: string, folder: string, expectedFrom?: string) =>
    withOrganizeMutation(() =>
      relocateOrganized(
        reqId(id),
        reqString(category, 'category', { allowEmpty: true, max: 200 }),
        reqString(folder, 'folder', { max: 512 }),
        optString(expectedFrom, 'expectedFrom', { max: 4096 })
      )
    )
  )
  ipcMain.handle('organize:remove-links', (_e, paths: string[]) =>
    withOrganizeMutation(() => removeOrphanLinks(reqStringArray(paths, 'paths', { max: 5000 })))
  )
}
