import { app, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDb, exportAll } from '../services/database.ts'
import { previewLibraryBackup, restoreLibraryBackup } from '../services/library-backup.ts'
import { atomicWrite } from '../kinds/video/bundle.ts'
import { videoOrganizationBusy } from './video-organize.ts'
import { videoAgentOrganizationBusy } from './video-agent-organize.ts'
import { videoImportBusy } from './video-import.ts'
import { imageLibraryBusy } from '../kinds/image/activity.ts'
import { projectLibraryBusy } from '../kinds/project/activity.ts'
import { assertProjectRunsStopped } from '../kinds/project/activity.ts'
import { workspaceBusy } from '../workspace/activity.ts'
import { agentQueue } from '../services/agent/queue.ts'
import { recordMetadataExport } from '../services/library-snapshots.ts'
import {archiveAssistantBusy,closeArchiveAssistant} from './archive.ts'
import {closeVideoPreview} from './video-preview.ts'
import {exportAssistantState,stageAssistantState,installAssistantState,discardAssistantStage} from '../archive/backup.ts'

const MAX_BACKUP_BYTES = 256 * 1024 * 1024
let restoreCommit=false
export const libraryRestoreInProgress=()=>restoreCommit

/** Synchronous replacement cannot race an in-flight scan, download or copy. */
export function assertLibraryIdle(fromArchive=false,fromRestore=false): void {
  if(restoreCommit&&!fromRestore)throw new Error('资料库正在恢复，请等待重启')
  const db = getDb()
  if ((!fromArchive&&archiveAssistantBusy()) || agentQueue.busy() || workspaceBusy() || videoOrganizationBusy() || videoAgentOrganizationBusy() || videoImportBusy() || imageLibraryBusy() || projectLibraryBusy()
    || db.prepare("SELECT id FROM image_download_jobs WHERE status IN ('queued','running') LIMIT 1").get()
    || db.prepare("SELECT id FROM task_records WHERE status = 'running' LIMIT 1").get()
    || db.prepare("SELECT id FROM video_download_jobs WHERE status IN ('queued', 'running') LIMIT 1").get()) {
    throw new Error('请先结束正在运行的扫描、下载或整理任务，再操作资料库')
  }
}

export function registerLibraryBackupIpc(getWindow: () => BrowserWindow | null, ipcMain: Pick<Electron.IpcMain, 'handle'>): void {
  let restoring = false
  const assertMain = (event: IpcMainInvokeEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口操作资料库备份')
  }
  ipcMain.handle('data:export-json', async event => {
    assertMain(event)
    const result = await dialog.showSaveDialog(getWindow()!, {
      title: '备份全部资料', defaultPath: 'baoyi-library-backup.json', filters: [{ name: '资料库备份', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    assertLibraryIdle()
    const contents = JSON.stringify({...exportAll(),assistant:exportAssistantState()}, null, 2)
    if (Buffer.byteLength(contents, 'utf8') > MAX_BACKUP_BYTES) throw new Error('备份超过 256 MB，请先通过数据目录保存完整数据库副本')
    atomicWrite(result.filePath, contents)
    recordMetadataExport(getDb(), result.filePath)
    return result.filePath
  })
  ipcMain.handle('data:restore-json', async event => {
    assertMain(event)
    assertProjectRunsStopped()
    if (restoring) throw new Error('已有一个恢复操作正在进行')
    restoring = true
    let assistantStage:string|undefined
    try {
      assertLibraryIdle()
      const result = await dialog.showOpenDialog(getWindow()!, {
        title: '选择资料库备份', properties: ['openFile'], filters: [{ name: '资料库备份', extensions: ['json'] }]
      })
      const file = result.filePaths[0]
      if (result.canceled || !file) return null
      if (fs.statSync(file).size > MAX_BACKUP_BYTES) throw new Error('备份超过 256 MB，无法载入')
      const input: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      const summary = previewLibraryBackup(getDb(), input)
      const recoveryDirectory = path.join(app.getPath('userData'), 'recovery')
      const confirmation = await dialog.showMessageBox(getWindow()!, {
        type: 'warning', title: '确认恢复资料库', message: '使用这份备份替换当前资料库并重启？',
        detail: `备份：${path.basename(file)}\n导出时间：${new Date(summary.exported_at).toLocaleString()}\n` +
          `软件 ${summary.resources.software} 个，游戏 ${summary.resources.game} 个，影视 ${summary.resources.video} 个，图片 ${summary.resources.image} 项，资料 ${summary.resources.document} 份，项目 ${summary.resources.project} 个，个人记录 ${summary.table_counts.personal_records} 条；共 ${summary.total_rows} 条资料记录。\n\n` +
          '当前资料及历史记录将被替换。保留本机设置，不移动或删除图片、视频、软件、游戏和存档文件。备份中的未完成任务会标记为中断，供你手动重试。\n' +
          ((input as any).assistant?'归档助理的对话、记忆和方法将随备份恢复。':'此旧备份不含归档助理记录，恢复后助理从空白开始；当前助手记录会另存到恢复目录。')+'\n\n' +
          `恢复前会把当前完整数据库另存到：${recoveryDirectory}\n恢复完成后应用立即重启。`,
        buttons: ['取消', '恢复并重启'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) return null
      assertLibraryIdle()
      restoreCommit=true
      assistantStage=stageAssistantState((input as any).assistant)
      await closeArchiveAssistant()
      await closeVideoPreview(true)
      assertLibraryIdle(false,true)
      assertProjectRunsStopped()
      fs.mkdirSync(recoveryDirectory, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = path.join(recoveryDirectory, `baoyi-before-restore-${stamp}-${randomUUID().slice(0, 8)}.db`)
      const db = getDb()
      // SQLite includes committed WAL pages; a plain filesystem copy would not.
      // Keep these operations synchronous through exit so no old callback can
      // write its cached state into the restored database.
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
      const revertAssistant=installAssistantState(assistantStage,recoveryDirectory)
      try{restoreLibraryBackup(db, input)}catch(e){revertAssistant();throw e}
      try { app.relaunch() } finally { app.exit(0) }
      return { backupPath }
    } finally {discardAssistantStage(assistantStage);restoring = false;restoreCommit=false }
  })
}
