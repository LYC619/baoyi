import { app, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { getDb, getSettings } from '../services/database.ts'
import {
  applyVideoOrganize, listVideoOrganizeJournal, previewVideoOrganize,
  previewVideoRelocate, relocateVideoDirectory, retryVideoOrganize, rollbackVideoOrganize
} from '../kinds/video/organize.ts'
import path from 'node:path'
import { applyVideoLayout, previewVideoLayout } from '../kinds/video/layout.ts'
import type {
  VideoOrganizeApplyRequest, VideoOrganizeJournal, VideoOrganizeRequest,
  VideoRelocateApplyRequest, VideoRelocateRequest
} from '../../src/types/video-organize.ts'

let activeOperations = 0
export function videoOrganizationBusy(): boolean { return activeOperations > 0 }

export function registerVideoOrganizeIpc(getWindow: () => BrowserWindow | null, ipcMain: Pick<Electron.IpcMain, 'handle'>): void {
  const assertMain = (event: IpcMainInvokeEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口操作影视库')
  }
  const idsOf = (journal: VideoOrganizeJournal) => [...new Set([journal.survivorId, ...journal.sourceIds, ...journal.files.flatMap(file => file.resourceIds)])]
  const visible = (ids: string[]) => !getSettings().hide_hentai || ids.every(id => {
    const row = getDb().prepare("SELECT category FROM resource WHERE id = ? AND kind = 'video'").get(id) as { category: string } | undefined
    return row && row.category !== '里番'
  })
  const assertVisible = (ids: string[]) => {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('作品范围无效')
    if (!visible(ids)) throw new Error('所选作品包含隐藏内容，请先调整显示设置')
  }
  const journal = (id: string) => {
    const entry = listVideoOrganizeJournal(getDb()).find(value => value.id === id)
    if (!entry) throw new Error('整理记录不存在')
    assertVisible(idsOf(entry)); return entry
  }
  const mutate = async (ids: string[], operation: () => Promise<VideoOrganizeJournal>) => {
    assertVisible(ids)
    activeOperations++
    try { return await operation() }
    finally {
      activeOperations--
      const win = getWindow()
      if (win && !win.isDestroyed()) for (const id of new Set(ids)) win.webContents.send('video:library-changed', id)
    }
  }
  ipcMain.handle('video-organize:preview', (event, request: VideoOrganizeRequest) => {
    assertMain(event); assertVisible(request?.resourceIds || [])
    return previewVideoOrganize(getDb(), request)
  })
  ipcMain.handle('video-organize:apply', (event, request: VideoOrganizeApplyRequest) => {
    assertMain(event)
    return mutate(request?.preview?.request?.resourceIds || [], () => applyVideoOrganize(getDb(), request))
  })
  ipcMain.handle('video-organize:list', (event, resourceId?: string) => {
    assertMain(event)
    return listVideoOrganizeJournal(getDb(), resourceId).filter(entry => visible(idsOf(entry)))
  })
  ipcMain.handle('video-organize:retry', (event, id: string) => {
    assertMain(event); return mutate(idsOf(journal(id)), () => retryVideoOrganize(getDb(), id))
  })
  ipcMain.handle('video-organize:rollback', (event, id: string) => {
    assertMain(event); return mutate(idsOf(journal(id)), () => rollbackVideoOrganize(getDb(), id))
  })
  ipcMain.handle('video-organize:preview-relocate', (event, request: VideoRelocateRequest) => {
    assertMain(event); assertVisible([request?.resourceId])
    return previewVideoRelocate(getDb(), request)
  })
  ipcMain.handle('video-organize:relocate', (event, request: VideoRelocateApplyRequest) => {
    assertMain(event)
    return mutate([request?.preview?.resourceId], () => relocateVideoDirectory(getDb(), request))
  })
  const layoutRoot = () => {
    const root = getSettings().video_organize_root || ''
    if (!path.isAbsolute(root)) throw new Error('请先在设置 → 视频导入与文件整理里保存影视整理根目录')
    return root
  }
  ipcMain.handle('video-organize:layout-preview', (event, ids: string[]) => {
    assertMain(event); assertVisible(ids)
    return previewVideoLayout(getDb(), ids, layoutRoot())
  })
  ipcMain.handle('video-organize:layout-apply', async (event, ids: string[]) => {
    assertMain(event); assertVisible(ids)
    activeOperations++
    try { return await applyVideoLayout(getDb(), ids, layoutRoot(), path.join(app.getPath('userData'), 'library-layout')) }
    finally {
      activeOperations--
      const win = getWindow()
      if (win && !win.isDestroyed()) for (const id of new Set(ids)) win.webContents.send('video:library-changed', id)
    }
  })
  ipcMain.handle('video-organize:pick-directory', async event => {
    assertMain(event)
    const result = await dialog.showOpenDialog(getWindow()!, { title: '选择作品目录', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] || null
  })
}
