import { BrowserWindow, Menu, session } from 'electron'
import type { DiscoverySource, DiscoverySelection } from '../../src/types/video-discovery.ts'

export const DISCOVERY_PARTITION = 'persist:video-discovery'
/** Remote content has no preload, IPC bridge, Node access or native download access. */
export function createDiscoveryBrowser(getMainWindow: () => BrowserWindow | null) {
  let window: BrowserWindow | null = null
  let source: DiscoverySource | null = null
  const pageKey = (raw: string) => { try { const url = new URL(raw); url.hash = ''; return url.href } catch { return '' } }
  const allowed = (raw: string) => {
    try {
      const url = new URL(raw)
      if (!source || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
      const urls = [source.homeUrl, ...source.entries.flatMap(entry => [entry.pageUrl, entry.playUrl, ...entry.downloads.map(option => option.url)])].filter(Boolean)
      return urls.some(value => new URL(value).origin === url.origin)
    } catch { return false }
  }
  function open(value: DiscoverySource, entryId?: string, mode: 'page' | 'play' = 'page'): void {
    const main = getMainWindow()
    if (!main || main.isDestroyed()) throw new Error('主窗口不可用')
    const entry = entryId ? value.entries.find(item => item.id === entryId) : null
    if (entryId && !entry) throw new Error('作品已不在来源目录中')
    const target = entry ? mode === 'play' ? entry.playUrl || entry.pageUrl : entry.pageUrl || entry.playUrl : value.homeUrl
    if (!target) throw new Error('此来源没有提供对应页面地址')
    source = structuredClone(value)
    if (window && !window.isDestroyed()) { window.setTitle(value.name + ' · 抱一'); void window.loadURL(target).catch(() => window?.setTitle('页面加载失败，可刷新重试 · 抱一')); window.show(); return }
    const browserSession = session.fromPartition(DISCOVERY_PARTITION)
    const win = new BrowserWindow({ width: 1120, height: 820, minWidth: 720, minHeight: 500, title: value.name + ' · 抱一',
      webPreferences: { session: browserSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } })
    window = win
    const navigate = (url: string) => { if (allowed(url)) void win.loadURL(url).catch(() => win.setTitle('页面加载失败，可刷新重试 · 抱一')) }
    const updateMenu = () => {
      if (win.isDestroyed()) return
      const url = pageKey(win.webContents.getURL())
      const current = source?.entries.find(item => [item.pageUrl, item.playUrl, ...item.downloads.map(option => option.url)].filter(Boolean).some(link => pageKey(link) === url))
      win.setMenu(Menu.buildFromTemplate([
        { label: '来源主页', enabled: !!source?.homeUrl, click: () => { if (source) navigate(source.homeUrl) } },
        { label: '后退', enabled: win.webContents.navigationHistory.canGoBack(), click: () => win.webContents.navigationHistory.goBack() },
        { label: '前进', enabled: win.webContents.navigationHistory.canGoForward(), click: () => win.webContents.navigationHistory.goForward() },
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => win.webContents.reload() },
        { label: '保存此视频', enabled: !!current?.downloads.length, click: () => {
          const host = getMainWindow()
          if (source && current && host && !host.isDestroyed()) {
            const selection: DiscoverySelection = { sourceId: source.id, entryId: current.id }
            if (host.isMinimized()) host.restore(); host.show(); host.focus(); host.webContents.send('video-discovery:download', selection)
          }
        } }
      ]))
    }
    const guard = (event: Electron.Event, url: string) => { if (!allowed(url)) { event.preventDefault(); win.setTitle('此跳转不在来源目录中 · 抱一') } }
    win.webContents.on('will-navigate', guard)
    win.webContents.on('will-redirect', (event, url, _inPlace, mainFrame) => { if (mainFrame) guard(event, url) })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('did-navigate', updateMenu); win.webContents.on('did-navigate-in-page', updateMenu)
    const blockDownload = (event: Electron.Event, _item: Electron.DownloadItem, sender: Electron.WebContents) => { if (sender === win.webContents) event.preventDefault() }
    browserSession.on('will-download', blockDownload)
    const parentClosed = () => { if (!win.isDestroyed()) win.close() }
    main.once('closed', parentClosed)
    win.once('closed', () => { browserSession.removeListener('will-download', blockDownload); main.removeListener('closed', parentClosed); window = null })
    updateMenu(); navigate(target)
  }
  return { open }
}
