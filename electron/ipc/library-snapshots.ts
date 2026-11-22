import { app, dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../services/storage/database.ts'
import { SCHEMA_VERSION } from '../services/storage/schema.ts'
import { createLibrarySnapshot, librarySafetyInfo } from '../services/storage/library-snapshots.ts'
import { archiveLibrarySnapshots, exportLibrarySnapshot } from '../services/storage/snapshot-archive.ts'
import { IpcError, reqString } from './validate.ts'

export function registerLibrarySnapshotIpc(getWindow: () => BrowserWindow | null, ipc: Pick<IpcMain, 'handle'>): void {
  const guard = (event: IpcMainInvokeEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('只允许主窗口操作资料库快照')
  }
  ipc.handle('data:snapshot-info', event => { guard(event); return librarySafetyInfo(getDb(), app.getPath('userData'), app.getVersion()) })
  ipc.handle('data:create-snapshot', event => {
    guard(event)
    return createLibrarySnapshot(getDb(), { directory: app.getPath('userData'), version: app.getVersion(), targetSchema: SCHEMA_VERSION, reason: 'manual', open: (file, readonly) => new Database(file, { readonly, fileMustExist: true }) })
  })
  ipc.handle('data:open-snapshot-dir', async event => {
    guard(event)
    const directory = path.join(app.getPath('userData'), 'library-snapshots')
    fs.mkdirSync(directory, { recursive: true })
    const error = await shell.openPath(directory)
    if (error) throw new Error(error)
  })
  ipc.handle('data:archive-snapshots', event => { guard(event); return archiveLibrarySnapshots(app.getPath('userData')) })
  ipc.handle('data:export-snapshot', async (event, id: unknown) => {
    guard(event)
    const safeId = reqString(id, 'id', { max: 64, trim: true })
    if (!/^\d{13}-[0-9a-f-]{36}$/.test(safeId)) throw new IpcError('INVALID_ARGUMENT', '参数 id 无效：快照编号无效', 'id')
    const selection = await dialog.showSaveDialog(getWindow()!, {
      title: '导出可还原的数据库快照', defaultPath: path.join(app.getPath('documents'), 'baoyi-snapshot-' + safeId + '.db'),
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }], buttonLabel: '导出数据库'
    })
    if (selection.canceled || !selection.filePath) return null
    guard(event)
    return exportLibrarySnapshot(app.getPath('userData'), safeId, selection.filePath)
  })
}
