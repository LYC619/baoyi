import { app, dialog, net, session, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { getVideoItem } from '../kinds/video/service.ts'
import { loadVideoSeries, loadVideoSources } from '../kinds/video/download/sources.ts'
import { createVideoDownloadService } from '../kinds/video/download/service.ts'
import { transferVideo } from '../kinds/video/download/transfer.ts'
import { createChromiumDownloadFetch } from '../kinds/video/download/chromium-fetch.ts'
import type {
  VideoDownloadProgress,
  VideoDownloadRequest,
  VideoSeriesDownloadProgress,
  VideoSeriesDownloadRequest
} from '../../src/types/video-download.ts'
import { writeBundleFiles } from '../kinds/video/bundle.ts'
import { registerVideoContent } from '../kinds/video/registration.ts'
import { getDb, getSettings } from '../services/database.ts'

function isMainFrame(event: IpcMainInvokeEvent, getWindow: () => BrowserWindow | null): boolean {
  const win = getWindow()
  return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === event.sender.mainFrame
}

function assertMainFrame(event: IpcMainInvokeEvent, getWindow: () => BrowserWindow | null): void {
  if (!isMainFrame(event, getWindow)) throw new Error('只允许主窗口主 frame 发起视频下载操作')
}

export function registerVideoDownloadIpc(
  getWindow: () => BrowserWindow | null,
  ipcMain: Pick<Electron.IpcMain, 'handle'>
): void {
  const service = createVideoDownloadService({
    getItem: id => getVideoItem(id),
    resolveSources: (videoCode, options) => loadVideoSources(videoCode, undefined, options),
    resolveSeries: (videoCode, options) => loadVideoSeries(videoCode, undefined, options),
    downloadsDirectory: () => getSettings().video_scan_dirs[0] || app.getPath('videos'),
    chooseFile: async ({ defaultPath, extension }) => {
      const parent = getWindow()
      if (!parent || parent.isDestroyed()) return null
      const result = await dialog.showSaveDialog(parent, {
        defaultPath,
        filters: [{ name: '视频文件', extensions: [extension] }],
        properties: ['showOverwriteConfirmation']
      })
      return result.canceled ? null : result.filePath
    },
    chooseDirectory: async () => {
      const parent = getWindow()
      if (!parent || parent.isDestroyed()) return null
      const result = await dialog.showOpenDialog(parent, {
        title: '选择系列视频保存目录',
        properties: ['openDirectory', 'createDirectory']
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    transfer: options => transferVideo({
      ...options,
      fetch: createChromiumDownloadFetch((requestOptions) => net.request(requestOptions), session.fromPartition('persist:hanime-network'))
    }),
    log: message => console.info(message)
    ,registerDownloaded: async input => {
      const directory = path.resolve(input.directory)
      const item = getVideoItem(input.resourceId)
      const workTitle = input.workTitle || item?.name_zh || input.episodeTitle
      const workDirectory = directory
      const result = registerVideoContent(getDb(), {
        resourceId: input.resourceId, directory: workDirectory, root: path.dirname(workDirectory), title: workTitle,
        description: item?.summary || '', originalDescription: item?.original_description || '', posterPath: item?.poster_path || '',
        sources: [{ provider: 'hanime', externalId: input.videoCode, scope: 'episode', pageUrl: 'https://hanime1.me/watch?v=' + input.videoCode, evidence: 'playlist' }],
        items: [{ ...input.facts, title: input.episodeTitle || workTitle, order: input.episode ?? 1, number: input.episode ?? 1, sources: [{ provider: 'hanime', externalId: input.videoCode, scope: 'episode', pageUrl: 'https://hanime1.me/watch?v=' + input.videoCode, evidence: 'playlist' }], files: [{ path: input.path, quality: input.label }] }]
      })
      const files = [{ ...input.facts, path: input.path, title: input.episodeTitle || workTitle, order: input.episode ?? 1, quality: input.label, sourceId: input.videoCode }]
      const bundle = writeBundleFiles({ directory: workDirectory, bundleId: result.bundleId, title: workTitle, description: item?.summary || '', source: input.videoCode, files })
      return { warnings: [...bundle.warnings], resourceId: result.resourceId }
    }
  })

  const sendProgress = (event: IpcMainInvokeEvent, progress: VideoDownloadProgress | VideoSeriesDownloadProgress): void => {
    try {
      if (!event.sender.isDestroyed()) event.sender.send('video-download:progress', progress)
    } catch (error) {
      console.warn('[视频下载] 进度通知失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  ipcMain.handle('video-download:sources', (event, resourceId: string) => {
    assertMainFrame(event, getWindow)
    return service.sources(resourceId)
  })
  ipcMain.handle('video-download:series', (event, resourceId: string) => {
    assertMainFrame(event, getWindow)
    return service.series(resourceId)
  })
  ipcMain.handle('video-download:run', (event, request: VideoDownloadRequest) => {
    assertMainFrame(event, getWindow)
    return service.run(request, progress => sendProgress(event, progress))
  })
  ipcMain.handle('video-download:run-series', (event, request: VideoSeriesDownloadRequest) => {
    assertMainFrame(event, getWindow)
    return service.runSeries(request, progress => sendProgress(event, progress))
  })
  ipcMain.handle('video-download:cancel', (event, requestId: string) => {
    assertMainFrame(event, getWindow)
    return service.cancel(requestId)
  })
  ipcMain.handle('video-download:reveal', async (event, requestId: string) => {
    assertMainFrame(event, getWindow)
    const path = service.completedPath(requestId)
    if (!path) return false
    if (service.completedIsDirectory(requestId)) return !(await shell.openPath(path))
    shell.showItemInFolder(path)
    return true
  })
}
