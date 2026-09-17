import { BrowserWindow, Menu, clipboard, type Session } from 'electron'
import { HANIME_BROWSER_UA, isHanimeHost } from './hanime-network-rules.ts'
import { toVideoCode } from '../kinds/video/hentai/selectors.ts'

const HOME = 'https://hanime1.me/'
function allowedPage(input: string): boolean {
  try { const url = new URL(input); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password && isHanimeHost(url.hostname) }
  catch { return false }
}

/** A persistent site window, isolated from the application's renderer and IPC. */
export function createHanimeBrowser(deps: { getSession: () => Session; getMainWindow: () => BrowserWindow | null; isHidden: () => boolean }) {
  let window: BrowserWindow | null = null
  function close(): void { if (window && !window.isDestroyed()) window.close() }
  function open(input?: string): boolean {
    if (deps.isHidden()) throw new Error('里番内容已隐藏，请先在设置中恢复显示')
    if (input !== undefined && !allowedPage(input)) throw new Error('只能在此窗口打开 Hanime 站点')
    if (window && !window.isDestroyed()) {
      if (input) void window.loadURL(input).catch(() => {})
      if (window.isMinimized()) window.restore()
      window.show(); window.focus(); return true
    }
    const main = deps.getMainWindow()
    if (!main || main.isDestroyed()) throw new Error('主窗口不可用')
    const session = deps.getSession()
    const win = new BrowserWindow({ width:1100,height:820,minWidth:760,minHeight:560,title:'Hanime · 抱一',autoHideMenuBar:false,
      webPreferences:{ session,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true } })
    window = win
    const contents = win.webContents
    const navigate = (url:string) => { if (!win.isDestroyed() && allowedPage(url)) void win.loadURL(url).catch(() => { if (!win.isDestroyed()) win.setTitle('加载失败，可刷新重试 · Hanime') }) }
    const download = () => {
      if (deps.isHidden()) { close(); return }
      const current = contents.getURL(), code = allowedPage(current) ? toVideoCode(current) : ''
      const target = deps.getMainWindow()
      if (!code || !target || target.isDestroyed()) return
      if (target.isMinimized()) target.restore()
      target.show(); target.focus()
      target.webContents.send('hanime-browser:download', 'https://hanime1.me/watch?v=' + code)
    }
    const updateMenu = () => {
      if (win.isDestroyed() || contents.isDestroyed()) return
      const url = contents.getURL(), valid = allowedPage(url)
      win.setMenu(Menu.buildFromTemplate([
        { label:'主页',click:()=>navigate(HOME) },
        { label:'后退',enabled:contents.navigationHistory.canGoBack(),click:()=>contents.navigationHistory.goBack() },
        { label:'前进',enabled:contents.navigationHistory.canGoForward(),click:()=>contents.navigationHistory.goForward() },
        { label:'刷新',accelerator:'CmdOrCtrl+R',click:()=>contents.reload() },
        { label:'下载当前视频',enabled:valid && !!toVideoCode(url),click:download },
        { label:'复制页面链接',enabled:valid,click:()=>{ const value=contents.getURL(); if (allowedPage(value)) clipboard.writeText(value) } }
      ]))
    }
    const blockForeign = (event: Electron.Event, url:string) => { if (!allowedPage(url)) event.preventDefault() }
    contents.on('will-navigate', blockForeign)
    contents.on('will-redirect', (event,url,_inPlace,mainFrame) => { if (mainFrame) blockForeign(event,url) })
    contents.setWindowOpenHandler(({url}) => { if (allowedPage(url)) navigate(url); return {action:'deny'} })
    contents.setUserAgent(HANIME_BROWSER_UA)
    contents.on('did-navigate',updateMenu)
    contents.on('did-navigate-in-page',updateMenu)
    contents.on('did-stop-loading',updateMenu)
    // Site downloads go through the app's explicit download workflow instead.
    const blockDirectDownload = (event: Electron.Event, _item: Electron.DownloadItem, sender: Electron.WebContents) => { if (sender === contents) event.preventDefault() }
    session.on('will-download',blockDirectDownload)
    const parentClosed = () => { if (!win.isDestroyed()) win.close() }
    main.once('closed',parentClosed)
    win.once('closed',()=>{ session.removeListener('will-download',blockDirectDownload); main.removeListener('closed',parentClosed); if(window===win)window=null })
    win.setMenuBarVisibility(true)
    updateMenu(); navigate(input || HOME)
    return true
  }
  return {open,close}
}
