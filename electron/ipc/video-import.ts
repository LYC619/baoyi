import path from 'node:path'
import { dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { getDb } from '../services/storage/database.ts'
import { getSettings } from '../services/storage/settings-store.ts'
import { createVideoImportManager } from '../kinds/video/import-preview.ts'
import { scanVideos, reviewVideoImportCandidate, fetchVideoPoster } from '../kinds/video/service.ts'
import type { VideoImportBatch, VideoImportEdits } from '../../src/types/video-import.ts'
import { cloneVideoDatabase } from '../kinds/video/snapshot.ts'
import { reqId, reqRecord, reqStringArray } from './validate.ts'
let running: (() => boolean) | undefined
export const videoImportBusy = () => running?.() || false

export function registerVideoImportIpc(getWindow: () => BrowserWindow | null, ipcMain: Pick<Electron.IpcMain, 'handle'>) {
  let manager: ReturnType<typeof createVideoImportManager> | undefined
  let database: ReturnType<typeof getDb> | undefined
  function current() {
    const db = getDb()
    if (!manager || database !== db) {
      database = db
      manager = createVideoImportManager({ db, scan: scanVideos, review: reviewVideoImportCandidate,
        cloneDb: () => { const scratch = cloneVideoDatabase(db); return { db: scratch, close: () => scratch.close() } },
        artwork: async resourceId => {
          try { await fetchVideoPoster(resourceId) }
          finally { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('video:library-changed', resourceId) }
        },
        changed: batch => {
          const win = getWindow()
          if (win && !win.isDestroyed() && !getSettings(getDb()).hide_hentai) win.webContents.send('video-import:changed', batch)
        } })
      running = manager.busy
    }
    return manager
  }
  const assertMain = (event: IpcMainInvokeEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口操作导入确认')
  }
  const visible = (batch: VideoImportBatch | null) => !batch || !getSettings(getDb()).hide_hentai || batch.entries.every(entry => entry.category !== '里番')
  const assertBatch = (id: string) => { if (!visible(current().get(id))) throw new Error('此批次包含隐藏内容，请先调整显示设置') }
  ipcMain.handle('video-import:list', event => { assertMain(event); return current().list().filter(batch => visible(current().get(batch.id))) })
  ipcMain.handle('video-import:get', (event, id: string) => { assertMain(event); const safeId = reqId(id); assertBatch(safeId); return current().get(safeId) })
  ipcMain.handle('video-import:prepare', async (event, roots?: string[]) => {
    assertMain(event)
    if (!roots) {
      const picked = await dialog.showOpenDialog(getWindow()!, { title: '选择视频目录，识别后统一确认入库', properties: ['openDirectory', 'multiSelections'] })
      if (picked.canceled || !picked.filePaths.length) return null
      roots = picked.filePaths
    } else {
      roots = reqStringArray(roots, 'roots', { min: 1, max: 500 })
      if (roots.some(r => !path.isAbsolute(r))) throw new Error('仅支持导入本地绝对路径')
    }
    const batch = await current().prepare(roots)
    return visible(batch) ? batch : null
  })
  ipcMain.handle('video-import:refresh', async (event, id: string) => { assertMain(event); const safeId = reqId(id); assertBatch(safeId); const batch = await current().refresh(safeId); return visible(batch) ? batch : null })
  ipcMain.handle('video-import:update', (event, id: string, changes: { selectedIds?: string[]; entry?: { id: string; edits: VideoImportEdits } }) => { assertMain(event); const safeId = reqId(id); assertBatch(safeId); return current().update(safeId, reqRecord(changes, 'changes') as any) })
  ipcMain.handle('video-import:review', async (event, id: string, ids: string[]) => { assertMain(event); const safeId = reqId(id); assertBatch(safeId); return current().review(safeId, reqStringArray(ids, 'ids', { min: 1, max: 5000 })) })
  ipcMain.handle('video-import:confirm', async (event, id: string, ids: string[]) => {
    assertMain(event); const safeId = reqId(id); assertBatch(safeId)
    return current().confirmWithArtwork(safeId, reqStringArray(ids, 'ids', { min: 1, max: 5000 }))
  })
  ipcMain.handle('video-import:discard', (event, id: string) => { assertMain(event); const safeId = reqId(id); assertBatch(safeId); return current().discard(safeId) })
  ipcMain.handle('video-import:cancel', (event, id: string) => { assertMain(event); return current().cancel(reqId(id)) })
}
