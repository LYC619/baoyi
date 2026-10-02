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
import { createDiscoveryCatalogue } from '../kinds/video/discovery/catalogue.ts'
import { createDiscoveryWorkflow } from '../kinds/video/discovery/workflow.ts'
import { resolveMissav } from '../kinds/video/discovery/missav.ts'
import { downloadHls } from '../kinds/video/download/hls.ts'
import { locateFfmpeg } from '../kinds/video/download/ffmpeg.ts'
import { registerDiscoveryIpc } from './video-discovery.ts'
import { DISCOVERY_PARTITION } from '../services/discovery-browser.ts'

/** 装成一个普通 Chrome。图床常带 Cloudflare 防盗链：缺 UA / Referer 直接 403。 */
const POSTER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
/** JAVDB 的图床只认 javdb 系 Referer；其他图床按调用方给的来源页 origin 兜。 */
function posterRequestHeaders(target: URL, referer?: string): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': POSTER_UA }
  if (/(^|\.)jdbstatic\.com$/i.test(target.hostname)) headers.Referer = 'https://javdb.com/'
  else if (referer) { try { headers.Referer = new URL(referer).origin + '/' } catch { /* 来源地址无效就不带 Referer */ } }
  return headers
}

export function registerVideoWorkflowIpc(getWindow: () => BrowserWindow | null, ipcMain: Pick<Electron.IpcMain, 'handle'>): { resetHistory: () => void } {
  const assertMain = (event: IpcMainInvokeEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口操作影视库')
  }
  const send = (channel: string, value: unknown) => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send(channel, value) }
  const visible = (job: VideoDownloadJob) => !getSettings().hide_hentai || job.category !== '里番'
  const workflowOptions: Parameters<typeof createVideoWorkflow>[0] = {
    artworkSize: file => nativeImage.createFromPath(file).getSize(),
    db: getDb(), downloadsDirectory: () => getSettings().video_scan_dirs[0] || app.getPath('videos'),
    libraryRoots: () => getSettings().video_scan_dirs,
    resolveWork: (code, options) => loadVideoWork(code, options), resolveSources: (code, options) => loadVideoSources(code, undefined, options),
    transfer: options => transferVideo({ ...options, fetch: createChromiumDownloadFetch(opts => net.request(opts), session.fromPartition('persist:hanime-network')) }),
    // 下载时作品目录已经定下来了，封面直接写进 <目录>/.baoyi/artwork（和清单同一套约定）；
    // 只有还没目录的极少情况才暂放缓存目录（A2）
    savePoster: async (url, directory, signal, referer) => {
      const target = new URL(url)
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('封面地址无效')
      const timeout = AbortSignal.timeout(20000)
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      const response = isHanimeHost(target.hostname) ? await fetchHanimeResource(url, { signal: requestSignal }) : await net.fetch(url, { signal: requestSignal, headers: posterRequestHeaders(target, referer) })
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
  }
  const workflow = createVideoWorkflow(workflowOptions)
  const catalogue = createDiscoveryCatalogue(getDb())
  const discoveryFetch: typeof globalThis.fetch = (url, init) => session.fromPartition(DISCOVERY_PARTITION).fetch(url instanceof URL ? url.href : url, init)
  const discovery = createDiscoveryWorkflow({ ...workflowOptions, catalogue,
    transfer: options => transferVideo({ ...options, fetch: discoveryFetch }),
    resolvePlayback: (code, signal) => resolveMissav(code, discoveryFetch, signal),
    hlsTransfer: ({ url, destination, headers, signal, onProgress }) => {
      const ffmpeg = locateFfmpeg()
      if (!ffmpeg) throw new Error('没有找到 FFmpeg，无法把 HLS 片源合成 MP4；请先安装 FFmpeg 并确保在 PATH 中')
      return downloadHls({ url, destination, headers, signal, fetch: discoveryFetch, ffmpeg, onProgress })
    } })
  registerDiscoveryIpc(getWindow, ipcMain, catalogue, getDb(), workflowOptions.savePoster!)
  const workerFor = (id: string) => typeof id === 'string' && id.startsWith('discovery-') ? discovery : workflow
  const allJobs = () => [...workflow.list(), ...discovery.list()].sort((a, b) => b.updatedAt - a.updatedAt)
  ipcMain.handle('video-workflow:prepare', (event, input) => { assertMain(event); return input?.discovery ? discovery.prepare(input.discovery) : workflow.prepare(input || {}) })
  ipcMain.handle('video-workflow:pick-root', async (event, id: string) => {
    assertMain(event)
    const result = await dialog.showOpenDialog(getWindow()!, { title: '选择影视库根目录', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || !result.filePaths[0] ? null : workerFor(id).setRoot(id, result.filePaths[0])
  })
  ipcMain.handle('video-workflow:enqueue', (event, request: VideoEnqueueRequest) => { assertMain(event); return workerFor(request?.draftId).enqueue(request) })
  ipcMain.handle('video-workflow:list', event => { assertMain(event); return allJobs().filter(visible) })
  ipcMain.handle('video-workflow:retry', (event, id: string, stage: VideoJobRetry) => { assertMain(event); return workerFor(id).retry(id, stage) })
  ipcMain.handle('video-workflow:cancel', (event, id: string) => { assertMain(event); return workerFor(id).cancel(id) })
  ipcMain.handle('video-workflow:dismiss', (event, id: string) => { assertMain(event); return workerFor(id).dismiss(id) })
  ipcMain.handle('video-workflow:reveal', async (event, id: string) => {
    assertMain(event); const job = allJobs().find(job => job.id === id)
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
  return { resetHistory: () => { workflow.clearHistory(); discovery.clearHistory() } }
}
