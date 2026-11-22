import { dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { SqlDb } from '../services/storage/schema.ts'
import type { DiscoveryCatalogue } from '../kinds/video/discovery/catalogue.ts'
import type { DiscoverySelection, DiscoveryMark } from '../../src/types/video-discovery.ts'
import { createDiscoveryBrowser } from '../services/network/discovery-browser.ts'
import { createWebBrowser } from '../services/network/web-browser.ts'
import { createWebBrowserSources } from '../services/network/web-browser-sources.ts'
import type { WebBrowserSourceInput } from '../../src/types/web-browser.ts'
import { onlineFetch, ensureOnlineNetwork, onlineNetworkStatus, probeOnlineNetwork } from '../services/network/online-network.ts'
import { createOnlineSource } from '../kinds/video/discovery/online.ts'
import { DEFAULT_PLAYBACK_SITE, playbackUrl } from '../kinds/video/discovery/playback-sites.ts'
import { optId, optString, reqId, reqRecord, reqString } from './validate.ts'

export function registerDiscoveryIpc(getWindow: () => BrowserWindow | null, ipcMain: Pick<Electron.IpcMain, 'handle'>, catalogue: DiscoveryCatalogue,
  db: SqlDb, savePoster: (url: string, directory: string, signal?: AbortSignal, referer?: string) => Promise<string>) {
  const browser = createDiscoveryBrowser(getWindow)
  const webBrowser = createWebBrowser(getWindow), webSources = createWebBrowserSources(db)
  const online = createOnlineSource(catalogue, onlineFetch)
  const assertMain = (event: IpcMainInvokeEvent) => {
    const main = getWindow()
    if (!main || main.isDestroyed() || event.sender !== main.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口操作来源目录')
  }
  const reqSel = (selection: unknown): DiscoverySelection => { const r = reqRecord(selection, 'selection'); return { sourceId: reqId(r.sourceId, 'selection.sourceId'), entryId: reqId(r.entryId, 'selection.entryId') } }
  ipcMain.handle('video-discovery:online-network-status', (event, url: string) => { assertMain(event); return onlineNetworkStatus(reqString(url, 'url', { max: 8192 })) })
  ipcMain.handle('video-discovery:online-network-probe', (event, url: string) => { assertMain(event); return probeOnlineNetwork(reqString(url, 'url', { max: 8192 })) })
  ipcMain.handle('video-discovery:online-connect', (event, url: string) => { assertMain(event); return online.connect(reqString(url, 'url', { max: 8192 })) })
  ipcMain.handle('video-discovery:online-refresh', (event, id: string) => { assertMain(event); return online.refresh(reqId(id)) })
  ipcMain.handle('video-discovery:online-next', (event, id: string) => { assertMain(event); return online.next(reqId(id)) })
  ipcMain.handle('video-discovery:online-detail', (event, selection: DiscoverySelection) => { assertMain(event); return online.detail(reqSel(selection)) })
  ipcMain.handle('web-browser:open', async (event, url: string) => { assertMain(event); const safeUrl = reqString(url, 'url', { max: 8192 }); await ensureOnlineNetwork(); return webBrowser.open(safeUrl) })
  ipcMain.handle('web-browser:list', event => { assertMain(event); return webSources.list() })
  ipcMain.handle('web-browser:save', (event, input: WebBrowserSourceInput) => { assertMain(event); return webSources.save(reqRecord(input, 'input') as unknown as WebBrowserSourceInput) })
  ipcMain.handle('web-browser:remove', (event, id: string) => { assertMain(event); webSources.remove(reqId(id)) })
  ipcMain.handle('video-discovery:sources', event => { assertMain(event); return catalogue.sources() })
  ipcMain.handle('video-discovery:entries', (event, sourceId: string) => { assertMain(event); return catalogue.entries(reqId(sourceId, 'sourceId')) })
  const pending = new Map<string, Promise<string>>()
  let artworkQueue = Promise.resolve('')
  ipcMain.handle('video-discovery:artwork', (event, selection: DiscoverySelection) => {
    assertMain(event)
    selection = reqSel(selection); const entry = catalogue.entry(selection.sourceId, selection.entryId).entry
    const url = entry.coverUrl
    if (!url) return ''
    const key = createHash('sha256').update(url).digest('hex')
    // Give the renderer a catalogue identity. The protocol rechecks it on each read.
    const poster = 'baoyi://poster/?' + new URLSearchParams({source: selection.sourceId, entry: selection.entryId})
    const cached = db.prepare('SELECT path FROM video_discovery_artwork WHERE url_hash=?').get(key) as { path: string } | undefined
    if (cached && existsSync(cached.path)) return poster
    if (pending.has(key)) return pending.get(key)!.then(file => file ? poster : '')
    const request = artworkQueue.then(async () => {
      const file = await savePoster(url, '', undefined, entry.pageUrl)
      db.prepare('INSERT OR REPLACE INTO video_discovery_artwork(url_hash,path) VALUES (?,?)').run(key, file)
      return file
    }).catch(() => '')
    artworkQueue = request; pending.set(key, request)
    void request.then(() => { const timer = setTimeout(() => pending.delete(key), 60000); timer.unref() })
    return request.then(file => file ? poster : '')
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
    assertMain(event); const value = catalogue.get(reqId(sourceId, 'sourceId'))
    const picked = await dialog.showSaveDialog(getWindow()!, { title: '导出来源目录', defaultPath: value.id + '.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (picked.canceled || !picked.filePath) return false
    await fs.writeFile(picked.filePath, JSON.stringify(value, null, 2), 'utf8'); return true
  })
  ipcMain.handle('video-discovery:remove', (event, sourceId: string) => { assertMain(event); catalogue.remove(reqId(sourceId, 'sourceId')) })
  ipcMain.handle('video-discovery:mark', (event, selection: DiscoverySelection, patch: Partial<DiscoveryMark>) => { assertMain(event); const sel = reqSel(selection); return catalogue.mark(sel.sourceId, sel.entryId, reqRecord(patch, 'patch') as Partial<DiscoveryMark>) })
  ipcMain.handle('video-discovery:open', async (event, sourceId: string, entryId?: string, mode?: 'page' | 'play') => {
    assertMain(event)
    if (mode && !['page', 'play'].includes(mode)) throw new Error('打开方式无效')
    await ensureOnlineNetwork()
    browser.open(catalogue.get(reqId(sourceId, 'sourceId')), optId(entryId, 'entryId'), mode)
  })
  // 资料站没有可内播文件时，按番号去播放站搜索页，用通用浏览窗口打开。
  ipcMain.handle('video-discovery:external-play', async (event, selection: DiscoverySelection, siteId?: string) => {
    assertMain(event)
    selection = reqSel(selection); const entry = catalogue.entry(selection.sourceId, selection.entryId).entry
    const url = playbackUrl(optString(siteId, 'siteId', { max: 64 }) || DEFAULT_PLAYBACK_SITE, entry.code)
    if (!url) throw new Error('这部作品没有番号，无法定位在线播放来源')
    await ensureOnlineNetwork()
    return webBrowser.open(url)
  })
}
