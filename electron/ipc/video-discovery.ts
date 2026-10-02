import { dialog, session, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { SqlDb } from '../services/schema.ts'
import type { DiscoveryCatalogue } from '../kinds/video/discovery/catalogue.ts'
import type { DiscoverySelection, DiscoveryMark } from '../../src/types/video-discovery.ts'
import { createDiscoveryBrowser } from '../services/discovery-browser.ts'
import { createWebBrowser } from '../services/web-browser.ts'
import { createWebBrowserSources } from '../services/web-browser-sources.ts'
import type { WebBrowserSourceInput } from '../../src/types/web-browser.ts'
import { createOnlineSource } from '../kinds/video/discovery/online.ts'
import { DEFAULT_PLAYBACK_SITE, playbackUrl } from '../kinds/video/discovery/playback-sites.ts'

export function registerDiscoveryIpc(getWindow: () => BrowserWindow | null, ipcMain: Pick<Electron.IpcMain, 'handle'>, catalogue: DiscoveryCatalogue,
  db: SqlDb, savePoster: (url: string, directory: string, signal?: AbortSignal, referer?: string) => Promise<string>) {
  const browser = createDiscoveryBrowser(getWindow)
  const webBrowser = createWebBrowser(getWindow), webSources = createWebBrowserSources(db)
  const onlineSession = session.fromPartition('online-source', { cache: false })
  const online = createOnlineSource(catalogue, (input, init) => onlineSession.fetch(String(input), init))
  const assertMain = (event: IpcMainInvokeEvent) => {
    const main = getWindow()
    if (!main || main.isDestroyed() || event.sender !== main.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口操作来源目录')
  }
  ipcMain.handle('video-discovery:online-connect', (event, url: string) => { assertMain(event); return online.connect(url) })
  ipcMain.handle('video-discovery:online-refresh', (event, id: string) => { assertMain(event); return online.refresh(id) })
  ipcMain.handle('video-discovery:online-next', (event, id: string) => { assertMain(event); return online.next(id) })
  ipcMain.handle('video-discovery:online-detail', (event, selection: DiscoverySelection) => { assertMain(event); return online.detail(selection) })
  ipcMain.handle('web-browser:open', (event, url: string) => { assertMain(event); return webBrowser.open(url) })
  ipcMain.handle('web-browser:list', event => { assertMain(event); return webSources.list() })
  ipcMain.handle('web-browser:save', (event, input: WebBrowserSourceInput) => { assertMain(event); return webSources.save(input) })
  ipcMain.handle('web-browser:remove', (event, id: string) => { assertMain(event); webSources.remove(id) })
  ipcMain.handle('video-discovery:sources', event => { assertMain(event); return catalogue.sources() })
  ipcMain.handle('video-discovery:entries', (event, sourceId: string) => { assertMain(event); return catalogue.entries(sourceId) })
  db.exec('CREATE TABLE IF NOT EXISTS video_discovery_artwork (url_hash TEXT PRIMARY KEY, path TEXT NOT NULL)')
  const pending = new Map<string, Promise<string>>()
  let artworkQueue = Promise.resolve('')
  ipcMain.handle('video-discovery:artwork', (event, selection: DiscoverySelection) => {
    assertMain(event)
    const entry = catalogue.entry(selection.sourceId, selection.entryId).entry
    const url = entry.coverUrl
    if (!url) return ''
    const key = createHash('sha256').update(url).digest('hex')
    const cached = db.prepare('SELECT path FROM video_discovery_artwork WHERE url_hash=?').get(key) as { path: string } | undefined
    if (cached && existsSync(cached.path)) return cached.path
    if (pending.has(key)) return pending.get(key)
    const request = artworkQueue.then(async () => {
      const file = await savePoster(url, '', undefined, entry.pageUrl)
      db.prepare('INSERT OR REPLACE INTO video_discovery_artwork(url_hash,path) VALUES (?,?)').run(key, file)
      return file
    }).catch(() => '')
    artworkQueue = request; pending.set(key, request)
    void request.then(() => { const timer = setTimeout(() => pending.delete(key), 60000); timer.unref() })
    return request
  })
  ipcMain.handle('video-discovery:import', async event => {
    assertMain(event)
    const picked = await dialog.showOpenDialog(getWindow()!, { title: '导入视频来源目录', properties: ['openFile'], filters: [{ name: '视频来源目录', extensions: ['json'] }] })
    if (picked.canceled || !picked.filePaths[0]) return null
    const stat = await fs.stat(picked.filePaths[0])
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('来源目录必须是 5 MB 以内的 JSON 文件')
    return catalogue.importSource(await fs.readFile(picked.filePaths[0], 'utf8'))
  })
  ipcMain.handle('video-discovery:export', async (event, sourceId: string) => {
    assertMain(event); const value = catalogue.get(sourceId)
    const picked = await dialog.showSaveDialog(getWindow()!, { title: '导出来源目录', defaultPath: value.id + '.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (picked.canceled || !picked.filePath) return false
    await fs.writeFile(picked.filePath, JSON.stringify(value, null, 2), 'utf8'); return true
  })
  ipcMain.handle('video-discovery:remove', (event, sourceId: string) => { assertMain(event); catalogue.remove(sourceId) })
  ipcMain.handle('video-discovery:mark', (event, selection: DiscoverySelection, patch: Partial<DiscoveryMark>) => { assertMain(event); return catalogue.mark(selection.sourceId, selection.entryId, patch) })
  ipcMain.handle('video-discovery:open', (event, sourceId: string, entryId?: string, mode?: 'page' | 'play') => {
    assertMain(event)
    if (mode && !['page', 'play'].includes(mode)) throw new Error('打开方式无效')
    browser.open(catalogue.get(sourceId), entryId, mode)
  })
  // 资料站没有可内播文件时，按番号去播放站搜索页，用通用浏览窗口打开。
  ipcMain.handle('video-discovery:external-play', (event, selection: DiscoverySelection, siteId?: string) => {
    assertMain(event)
    const entry = catalogue.entry(selection.sourceId, selection.entryId).entry
    const url = playbackUrl(siteId || DEFAULT_PLAYBACK_SITE, entry.code)
    if (!url) throw new Error('这部作品没有番号，无法定位在线播放来源')
    return webBrowser.open(url)
  })
}
