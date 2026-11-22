import { ipcMain as electronIpc, type BrowserWindow } from 'electron'
import { IpcActivity, mainWindowIpc } from './main-window.ts'
import { stopServices } from '../services/system/lifecycle.ts'
import { countIpcSend } from '../services/system/timing.ts'
import { cancelAi } from '../kinds/software/aiService'
import { cancelScan } from '../kinds/software/scanner'
import { cancelGameScan } from '../kinds/game/service'
import { cancelVideoScan } from '../kinds/video/service'
import { registerSoftwareIpc } from './software.ts'
import { registerGameIpc } from './game.ts'
import { registerGameWorkspaceIpc } from './game-workspace.ts'
import { registerGameProjectIpc } from './game-project.ts'
import { registerVideoCoreIpc } from './video-core.ts'
import { registerVideoDownloadIpc } from './video-download.ts'
import { registerVideoWorkflowIpc } from './video-workflow.ts'
import { registerVideoOrganizeIpc } from './video-organize.ts'
import { registerVideoImportIpc } from './video-import.ts'
import { registerVideoAgentOrganizeIpc } from './video-agent-organize.ts'
import { registerVideoPreviewIpc, closeVideoPreview } from './video-preview.ts'
import { registerAudioIpc } from './audio.ts'
import { registerMusicIpc } from './music.ts'
import { registerImageIpc } from './image.ts'
import { registerImageSourceIpc } from './image-source.ts'
import { registerComicIngestIpc, stopComicIngest } from './comic-ingest.ts'
import { registerProjectIpc } from './project.ts'
import { registerWorkspaceIpc } from './workspace.ts'
import { registerArchiveIpc, closeArchiveAssistant } from './archive.ts'
import { registerLibraryBackupIpc } from './library-backup.ts'
import { registerLibrarySnapshotIpc } from './library-snapshots.ts'
import { registerStorageIpc } from './storage.ts'
import { registerSystemIpc } from './system.ts'

export function registerIpcHandlers(getWindow: () => BrowserWindow | null, activity: IpcActivity) {
  const ipcMain = mainWindowIpc(activity.track(electronIpc), getWindow)
  const send = (channel: string, payload: unknown) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      countIpcSend(channel, payload)
      win.webContents.send(channel, payload)
    }
  }

  const videoWorkflow = registerVideoWorkflowIpc(getWindow, ipcMain)
  registerVideoPreviewIpc(getWindow, ipcMain)
  registerVideoOrganizeIpc(getWindow, ipcMain)
  registerVideoImportIpc(getWindow, ipcMain)
  registerVideoAgentOrganizeIpc(getWindow, ipcMain)
  const stopDownloads = registerVideoDownloadIpc(getWindow, ipcMain)
  registerVideoCoreIpc(getWindow, ipcMain, send)

  registerLibraryBackupIpc(getWindow, ipcMain)
  registerLibrarySnapshotIpc(getWindow, ipcMain)
  registerStorageIpc(getWindow, ipcMain)
  registerImageIpc(getWindow, ipcMain)
  const imageSource = registerImageSourceIpc(getWindow, ipcMain)
  const resetComic = registerComicIngestIpc(getWindow, ipcMain)

  const projectAgent = registerProjectIpc(getWindow, ipcMain)
  const stopWorkspace = registerWorkspaceIpc(getWindow, ipcMain, projectAgent)
  registerArchiveIpc(getWindow, ipcMain)
  const stopMusic = registerMusicIpc(getWindow, ipcMain)

  registerSoftwareIpc(getWindow, ipcMain, send)
  registerGameIpc(getWindow, ipcMain, send)
  registerGameProjectIpc(getWindow, ipcMain)
  registerGameWorkspaceIpc(getWindow, ipcMain)
  registerAudioIpc(getWindow, ipcMain)

  registerSystemIpc(getWindow, ipcMain, {
    activity,
    send,
    resetVideoHistory: () => videoWorkflow.resetHistory(),
    imageSource,
    resetComic
  })

  const stopBackground = () =>
    stopServices(
      projectAgent.stop,
      stopWorkspace,
      stopMusic,
      videoWorkflow.stop,
      stopComicIngest,
      imageSource.stop,
      closeVideoPreview,
      closeArchiveAssistant,
      stopDownloads,
      cancelAi,
      cancelScan,
      cancelGameScan,
      cancelVideoScan
    )

  return {
    confirmQuit: projectAgent.confirmQuit,
    projectBusy: projectAgent.busy,
    async stop() {
      const wasBusy = activity.busy
      const exclusive = activity.exclusive
      const pending = activity.stop()
      if (exclusive) await pending
      await stopServices(stopBackground, () => pending)
      if (wasBusy && !exclusive) await stopBackground()
    }
  }
}
