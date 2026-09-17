import { app, dialog, nativeImage, net, shell, session, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getDb, getSettings, postersDir } from '../services/database.ts'
import { createVideoWorkflow } from '../kinds/video/download/workflow.ts'
import { loadVideoSources, loadVideoWork } from '../kinds/video/download/sources.ts'
import { createChromiumDownloadFetch } from '../kinds/video/download/chromium-fetch.ts'
import { transferVideo } from '../kinds/video/download/transfer.ts'
import { fetchHanimeResource } from '../kinds/video/hentai/hanime.ts'
import { isHanimeHost } from '../services/hanime-network-rules.ts'
import { atomicWrite } from '../kinds/video/bundle.ts'
import { getVideoWorkLibrary, relocateVideoAsset, setDefaultVideoAsset } from '../kinds/video/library.ts'
import { syncVideoWorkFiles } from '../kinds/video/local-sync.ts'
import { previewVideoCollectionName, renameVideoCollection } from '../kinds/video/collection-name.ts'
import { getVideoItem, getVideoLibrary, updateVideoEpisode, updateVideoItem } from '../kinds/video/service.ts'
import { getEpisode } from '../kinds/video/db.ts'
import type { VideoDownloadJob, VideoEnqueueRequest, VideoJobRetry } from '../../src/types/video-workflow.ts'

export function registerVideoWorkflowIpc(getWindow: () => BrowserWindow | null, ipcMain: Pick<Electron.IpcMain, 'handle'>): { resetHistory: () => void } {
  const assertMain = (event: IpcMainInvokeEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口操作影视库')
  }
  const send = (channel: string, value: unknown) => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send(channel, value) }
  const visible = (job: VideoDownloadJob) => !getSettings().hide_hentai || job.category !== '里番'
  const workflow = createVideoWorkflow({
    artworkSize: file => nativeImage.createFromPath(file).getSize(),
    db: getDb(), downloadsDirectory: () => getSettings().video_scan_dirs[0] || app.getPath('videos'),
    libraryRoots: () => getSettings().video_scan_dirs,
    resolveWork: (code, options) => loadVideoWork(code, options), resolveSources: (code, options) => loadVideoSources(code, undefined, options),
    transfer: options => transferVideo({ ...options, fetch: createChromiumDownloadFetch(opts => net.request(opts), session.fromPartition('persist:hanime-network')) }),
    // 下载时作品目录已经定下来了，封面直接写进 <目录>/.baoyi/artwork（和清单同一套约定）；
    // 只有还没目录的极少情况才暂放缓存目录（A2）
    savePoster: async (url, directory, signal) => {
      const target = new URL(url)
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('封面地址无效')
      const timeout = AbortSignal.timeout(20000)
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      const response = isHanimeHost(target.hostname) ? await fetchHanimeResource(url, { signal: requestSignal }) : await net.fetch(url, { signal: requestSignal })
      if (!response.ok || !response.body) throw new Error('封面请求失败：HTTP ' + response.status)
      const chunks: Uint8Array[] = []; let size = 0
      const reader = response.body.getReader()
      try {
        for (;;) { const value = await reader.read(); if (value.done) break; size += value.value.length; if (size > 15 * 1024 * 1024) throw new Error('封面超过 15 MB'); chunks.push(value.value) }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const bytes = Buffer.concat(chunks)
      const decoded = nativeImage.createFromBuffer(bytes)
      if (decoded.isEmpty() || decoded.getSize().width < 64 || decoded.getSize().height < 64) throw new Error('封面无法解码或尺寸过小')
      const artworkDir = directory && fs.existsSync(directory) ? path.join(directory, '.baoyi', 'artwork') : postersDir()
      fs.mkdirSync(artworkDir, { recursive: true })
      const file = path.join(artworkDir, createHash('sha256').update(bytes).digest('hex').slice(0, 24) + '.png')
      if (!fs.existsSync(file)) atomicWrite(file, decoded.toPNG())
      return file
    },
    onChange: job => { if (visible(job)) send('video-workflow:changed', job) },
    onLibraryChange: id => send('video:library-changed', id)
  })
  ipcMain.handle('video-workflow:prepare', (event, input) => { assertMain(event); return workflow.prepare(input || {}) })
  ipcMain.handle('video-workflow:pick-root', async (event, id: string) => {
    assertMain(event)
    const result = await dialog.showOpenDialog(getWindow()!, { title: '选择影视库根目录', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || !result.filePaths[0] ? null : workflow.setRoot(id, result.filePaths[0])
  })
  ipcMain.handle('video-workflow:enqueue', (event, request: VideoEnqueueRequest) => { assertMain(event); return workflow.enqueue(request) })
  ipcMain.handle('video-workflow:list', event => { assertMain(event); return workflow.list().filter(visible) })
  ipcMain.handle('video-workflow:retry', (event, id: string, stage: VideoJobRetry) => { assertMain(event); return workflow.retry(id, stage) })
  ipcMain.handle('video-workflow:cancel', (event, id: string) => { assertMain(event); return workflow.cancel(id) })
  ipcMain.handle('video-workflow:reveal', async (event, id: string) => {
    assertMain(event); const job = workflow.list().find(job => job.id === id)
    if (!job || !job.directory || !fs.existsSync(job.directory)) return false
    return !(await shell.openPath(job.directory))
  })
  ipcMain.handle('video:library', (event, id: string) => { assertMain(event); return getVideoLibrary(id) })
  ipcMain.handle('video:sync-files', (event, id: string) => {
    assertMain(event)
    const result = syncVideoWorkFiles(getDb(), id, { roots: getSettings().video_scan_dirs })
    return { ...result, library: getVideoLibrary(result.library.resourceId) }
  })
  ipcMain.handle('video:preview-collection-name', (event, id: string, title: string) => {
    assertMain(event); return previewVideoCollectionName(getDb(), id, title, getSettings().video_scan_dirs)
  })
  ipcMain.handle('video:rename-collection', (event, id: string, title: string) => {
    assertMain(event)
    const result = renameVideoCollection(getDb(), id, title, getSettings().video_scan_dirs)
    send('video:library-changed', id)
    return result
  })
  ipcMain.handle('video:default-asset', (event, episodeId: string, assetId: string) => { assertMain(event); return setDefaultVideoAsset(getDb(), episodeId, assetId) })
  ipcMain.handle('video:reveal-asset', (event, assetId: string) => {
    assertMain(event); const asset = getDb().prepare('SELECT path FROM video_assets WHERE id = ?').get(assetId) as { path: string } | undefined
    if (!asset || !fs.existsSync(asset.path)) return false
    shell.showItemInFolder(asset.path); return true
  })
  ipcMain.handle('video:relocate-asset', async (event, assetId: string) => {
    assertMain(event)
    const asset = getDb().prepare('SELECT resource_id FROM video_assets WHERE id = ?').get(assetId) as { resource_id: string } | undefined
    if (!asset) return false
    const result = await dialog.showOpenDialog(getWindow()!, { title: '重新定位视频文件', properties: ['openFile'], filters: [{ name: '视频', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'ts', 'wmv', 'mpg', 'mpeg'] }] })
    if (result.canceled || !result.filePaths[0]) return false
    const changed = relocateVideoAsset(getDb(), assetId, result.filePaths[0]); send('video:library-changed', asset.resource_id); return changed
  })
  ipcMain.handle('video:play-asset', async (event, assetId: string) => {
    assertMain(event)
    const asset = getDb().prepare("SELECT * FROM video_assets WHERE id = ? AND role = 'video'").get(assetId) as { path: string; resource_id: string } | undefined
    if (!asset) return { ok: false, message: '视频文件记录不存在', item: null, episode: null }
    const item = getVideoItem(asset.resource_id)
    let exists = false; try { exists = fs.statSync(asset.path).isFile() } catch { /* Show missing state. */ }
    if (!exists) { getVideoWorkLibrary(getDb(), asset.resource_id); return { ok: false, message: '视频文件无法访问，请连接磁盘或重新定位', item, episode: null } }
    const error = await shell.openPath(asset.path)
    if (error) return { ok: false, message: '无法打开播放器：' + error, item, episode: null }
    const link = getDb().prepare('SELECT episode_id FROM video_episode_assets WHERE asset_id = ? LIMIT 1').get(assetId) as { episode_id: string } | undefined
    const episode = link ? getEpisode(getDb(), link.episode_id) : null
    if (episode) updateVideoEpisode(episode.id, { watched_at: Date.now(), ...(episode.watch_status === 'unwatched' ? { watch_status: 'watching' } : {}) })
    else if (item) updateVideoItem(item.id, { last_watched_at: Date.now(), ...(item.watch_status === 'unwatched' ? { watch_status: 'watching' } : {}) })
    send('video:library-changed', asset.resource_id)
    return { ok: true, message: '', item: getVideoItem(asset.resource_id), episode: link ? getEpisode(getDb(), link.episode_id) : null }
  })
  return { resetHistory: workflow.clearHistory }
}
