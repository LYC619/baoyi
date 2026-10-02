import { app, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../services/database.ts'
import { SCHEMA_VERSION } from '../services/schema.ts'
import { createLibrarySnapshot, librarySafetyInfo } from '../services/library-snapshots.ts'

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
}
