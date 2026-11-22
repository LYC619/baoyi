import { app, dialog, nativeImage, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getDb, postersDir } from '../services/storage/database.ts'
import { getSettings, patchSettings } from '../services/storage/settings-store.ts'
import { createVideoWorkflow } from '../kinds/video/download/workflow.ts'
import { loadVideoSources, loadVideoWork } from '../kinds/video/download/sources.ts'
import { transferHanimeMedia } from '../services/hanime/hanime-download.ts'
import { videoTransferOptions } from '../kinds/video/download/options.ts'
import { transferVideo } from '../kinds/video/download/transfer.ts'
import { fetchHanimeResource } from '../kinds/video/hentai/hanime.ts'
import { isHanimeHost } from '../services/hanime/hanime-network-rules.ts'
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
import { locateFfmpeg, validateFfmpeg } from '../kinds/video/download/ffmpeg.ts'
import { registerDiscoveryIpc } from './video-discovery.ts'
import { onlineFetch } from '../services/network/online-network.ts'
import { inspectDownloadCaches, clearDownloadCaches } from '../kinds/video/download/cache-management.ts'
import {createVideoUpdateCheck} from '../kinds/video/update-check.ts'
import {libraryRestoreInProgress} from './library-backup.ts'
import { optBool, optRecord, optStringArray, reqId, reqRecord, reqString } from './validate.ts'

/** 装成一个普通 Chrome。图床常带 Cloudflare 防盗链：缺 UA / Referer 直接 403。 */
const POSTER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
/** JAVDB 的图床只认 javdb 系 Referer；其他图床按调用方给的来源页 origin 兜。 */
function posterRequestHeaders(target: URL, referer?: string): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': POSTER_UA }
  if (/(^|\.)jdbstatic\.com$/i.test(target.hostname)) headers.Referer = 'https://javdb.com/'
  else if (referer) { try { headers.Referer = new URL(referer).origin + '/' } catch { /* 来源地址无效就不带 Referer */ } }
  return headers
}

export function registerVideoWorkflowIpc(getWindow: () => BrowserWindow | null, ipcMain: Pick<Electron.IpcMain, 'handle'>) {
  const assertMain = (event: IpcMainInvokeEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口操作影视库')
  }
  const send = (channel: string, value: unknown) => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send(channel, value) }
  ipcMain.handle('settings:ffmpeg-detect', event => {
    assertMain(event)
    const settings = getSettings(getDb())
    return locateFfmpeg('', settings.software_scan_dirs)
  })
  ipcMain.handle('settings:ffmpeg-pick', async event => {
    assertMain(event)
    const result = await dialog.showOpenDialog(getWindow()!, { title: '选择 ffmpeg.exe', properties: ['openFile'], filters: [{ name: 'FFmpeg', extensions: ['exe'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const file = result.filePaths[0]
    if (!validateFfmpeg(file)) throw new Error('该程序不是可运行的 FFmpeg，请选择 ffmpeg.exe')
    patchSettings(getDb(), { ffmpeg_path: file })
    return file
  })
  const visible = (job: VideoDownloadJob) => !getSettings(getDb()).hide_hentai || job.category !== '里番'
  const workflowOptions: Parameters<typeof createVideoWorkflow>[0] = {
    artworkSize: file => nativeImage.createFromPath(file).getSize(),
    db: getDb(), downloadsDirectory: () => getSettings(getDb()).video_scan_dirs[0] || app.getPath('videos'),
    libraryRoots: () => getSettings(getDb()).video_scan_dirs,
    resolveWork: (code, options) => loadVideoWork(code, options), resolveSources: (code, options) => loadVideoSources(code, undefined, options),
    transfer: transferHanimeMedia,
    concurrency:()=>videoTransferOptions(getSettings(getDb())).concurrency,
    // 下载时作品目录已经定下来了，封面直接写进 <目录>/.baoyi/artwork（和清单同一套约定）；
    // 只有还没目录的极少情况才暂放缓存目录（A2）
    savePoster: async (url, directory, signal, referer) => {
      const target = new URL(url)
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('封面地址无效')
      const timeout = AbortSignal.timeout(20000)
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      const response = isHanimeHost(target.hostname) ? await fetchHanimeResource(url, { signal: requestSignal }) : await onlineFetch(url, { signal: requestSignal, headers: posterRequestHeaders(target, referer) })
      if (!response.ok || !response.body) throw new Error('封面请求失败：HTTP ' + response.status)
      const chunks: Uint8Array[] = []; let size = 0
      const reader = response.body.getReader()
      try {
        for (;;) { const value = await reader.read(); if (value.done) break; size += value.value.length; if (size > 15 * 1024 * 1024) throw new Error('封面超过 15 MB'); chunks.push(value.value) }
      } finally { await reader.cancel().catch(() => { /* best-effort */ }); reader.releaseLock() }
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
  const discoveryFetch = onlineFetch
  const discovery = createDiscoveryWorkflow({ ...workflowOptions, catalogue,
    transfer: options => transferVideo({ ...options, fetch: discoveryFetch }),
    resolvePlayback: (code, signal) => resolveMissav(code, discoveryFetch, signal),
    hlsTransfer: ({ url, destination, headers, signal, onProgress }) => {
      const ffmpeg = locateFfmpeg(getSettings(getDb()).ffmpeg_path, getSettings(getDb()).software_scan_dirs)
      if (!ffmpeg) throw new Error('没有找到 FFmpeg。请到设置 → 下载与缓存重新检测或选择 ffmpeg.exe。PotPlayer 可播放 m3u8，但下载为 MP4 仍需要 FFmpeg。')
      return downloadHls({ url, destination, headers, signal, fetch: discoveryFetch, ffmpeg, onProgress })
    } })
  registerDiscoveryIpc(getWindow, ipcMain, catalogue, getDb(), workflowOptions.savePoster!)
  const workerFor = (id: string) => typeof id === 'string' && id.startsWith('discovery-') ? discovery : workflow
  const allJobs = () => [...workflow.list(), ...discovery.list()].sort((a, b) => b.updatedAt - a.updatedAt)
  const updates=createVideoUpdateCheck({db:getDb(),hidden:()=>getSettings(getDb()).hide_hentai,ready:()=>!libraryRestoreInProgress(),
    resolve:(code,signal)=>loadVideoWork(code,{signal}),jobs:allJobs,
    weekly:()=>({enabled:getSettings(getDb()).video_updates_weekly===true,last:getSettings(getDb()).video_updates_last_checked||0}),
    completed:time=>{patchSettings(getDb(), {video_updates_last_checked:time})},changed:()=>send('video-updates:changed',null)})
  ipcMain.handle('video-updates:start',(event,ids,startup)=>{assertMain(event);return updates.start(optStringArray(ids,'ids',{max:5000}),optBool(startup,'startup')===true)})
  ipcMain.handle('video-updates:status',event=>{assertMain(event);return updates.status()})
  ipcMain.handle('video-updates:cancel',event=>{assertMain(event);return updates.cancel()})
  ipcMain.handle('video-workflow:prepare', (event, input) => { assertMain(event); const safe = optRecord(input, 'input') as any; return safe?.discovery ? discovery.prepare(safe.discovery) : workflow.prepare(safe || {}) })
  ipcMain.handle('video-workflow:pick-root', async (event, id: string) => {
    assertMain(event); id = reqId(id)
    const result = await dialog.showOpenDialog(getWindow()!, { title: '选择影视库根目录', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || !result.filePaths[0] ? null : workerFor(id).setRoot(id, result.filePaths[0])
  })
  ipcMain.handle('video-workflow:enqueue', (event, request: VideoEnqueueRequest) => { assertMain(event); const safe = reqRecord(request, 'request') as unknown as VideoEnqueueRequest; return workerFor(reqId(safe.draftId, 'request.draftId')).enqueue(safe) })
  ipcMain.handle('video-workflow:list', event => { assertMain(event); return allJobs().filter(visible) })
  ipcMain.handle('video-workflow:caches', event => {
    assertMain(event)
    const jobs = allJobs(), visibleIds = new Set(jobs.filter(visible).map(job => job.id))
    return inspectDownloadCaches(jobs).filter(cache => visibleIds.has(cache.jobId))
  })
  ipcMain.handle('video-workflow:clear-cache', async (event, id: string) => {
    assertMain(event)
    const job = allJobs().find(job => job.id === reqId(id) && visible(job))
    if (!job) throw new Error('下载任务不存在或当前不可见')
    const before = inspectDownloadCaches(allJobs()).find(cache => cache.jobId === id)
    if (!before?.canClear) throw new Error(before?.reason || '没有可清理的缓存')
    const choice = await dialog.showMessageBox(getWindow()!, { type: 'warning', title: '清理下载缓存',
      message: `清理「${job.title}」的 ${(before.bytes / 1048576).toFixed(1)} MB 下载缓存？`,
      detail: '完整视频和资料库条目会保留。清理后，未完成的内容需要重新下载。\n\n' + before.directories.join('\n'),
      buttons: ['保留缓存', '清理缓存'], defaultId: 0, cancelId: 0, noLink: true })
    if (choice.response !== 1) return { cleared: false, bytes: 0 }
    assertMain(event)
    const jobs = allJobs(), current = jobs.find(job => job.id === id && visible(job))
    if (!current) throw new Error('下载任务状态已变化，请刷新后重试')
    const after = inspectDownloadCaches(jobs).find(cache => cache.jobId === id)
    if (!after?.canClear || JSON.stringify(after.directories) !== JSON.stringify(before.directories) || after.bytes !== before.bytes) throw new Error('缓存状态已变化，请刷新后重新确认')
    return { cleared: true, bytes: clearDownloadCaches(current, jobs) }
  })
  ipcMain.handle('video-workflow:retry', (event, id: string, stage: VideoJobRetry) => { assertMain(event); const safeId = reqId(id); return workerFor(safeId).retry(safeId, reqString(stage, 'stage', { max: 64 }) as VideoJobRetry) })
  ipcMain.handle('video-workflow:cancel', (event, id: string) => { assertMain(event); const safeId = reqId(id); return workerFor(safeId).cancel(safeId) })
  ipcMain.handle('video-workflow:dismiss', (event, id: string) => { assertMain(event); const safeId = reqId(id); return workerFor(safeId).dismiss(safeId) })
  ipcMain.handle('video-workflow:reveal', async (event, id: string) => {
    assertMain(event); const job = allJobs().find(job => job.id === reqId(id))
    if (!job || !job.directory || !fs.existsSync(job.directory)) return false
    return !(await shell.openPath(job.directory))
  })
  ipcMain.handle('video:library', (event, id: string) => { assertMain(event); return getVideoLibrary(reqId(id)) })
  ipcMain.handle('video:sync-files', (event, id: string) => {
    assertMain(event)
    const result = syncVideoWorkFiles(getDb(), reqId(id), { roots: getSettings(getDb()).video_scan_dirs })
    return { ...result, library: getVideoLibrary(result.library.resourceId) }
  })
  ipcMain.handle('video:preview-collection-name', (event, id: string, title: string) => {
    assertMain(event); return previewVideoCollectionName(getDb(), reqId(id), reqString(title, 'title', { max: 300 }), getSettings(getDb()).video_scan_dirs)
  })
  ipcMain.handle('video:rename-collection', (event, id: string, title: string) => {
    assertMain(event)
    const result = renameVideoCollection(getDb(), reqId(id), reqString(title, 'title', { max: 300 }), getSettings(getDb()).video_scan_dirs)
    send('video:library-changed', id)
    return result
  })
  ipcMain.handle('video:default-asset', (event, episodeId: string, assetId: string) => { assertMain(event); return setDefaultVideoAsset(getDb(), reqId(episodeId, 'episodeId'), reqId(assetId, 'assetId')) })
  ipcMain.handle('video:reveal-asset', (event, assetId: string) => {
    assertMain(event); const asset = getDb().prepare('SELECT path FROM video_assets WHERE id = ?').get(reqId(assetId, 'assetId')) as { path: string } | undefined
    if (!asset || !fs.existsSync(asset.path)) return false
    shell.showItemInFolder(asset.path); return true
  })
  ipcMain.handle('video:relocate-asset', async (event, assetId: string) => {
    assertMain(event)
    const asset = getDb().prepare('SELECT resource_id FROM video_assets WHERE id = ?').get(reqId(assetId, 'assetId')) as { resource_id: string } | undefined
    if (!asset) return false
    const result = await dialog.showOpenDialog(getWindow()!, { title: '重新定位视频文件', properties: ['openFile'], filters: [{ name: '视频', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'ts', 'wmv', 'mpg', 'mpeg'] }] })
    if (result.canceled || !result.filePaths[0]) return false
    const changed = relocateVideoAsset(getDb(), assetId, result.filePaths[0]); send('video:library-changed', asset.resource_id); return changed
  })
  ipcMain.handle('video:play-asset', async (event, assetId: string) => {
    assertMain(event)
    const asset = getDb().prepare("SELECT * FROM video_assets WHERE id = ? AND role = 'video'").get(reqId(assetId, 'assetId')) as { path: string; resource_id: string } | undefined
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
  return { resetHistory: () => { workflow.clearHistory(); discovery.clearHistory() }, stop: async () => {
    for (const job of allJobs()) if (job.status === 'running' || job.status === 'queued') workerFor(job.id).cancel(job.id)
    await Promise.all([updates.stop(), workflow.idle(), discovery.idle()])
  } }
}
