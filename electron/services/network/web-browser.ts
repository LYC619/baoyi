import { currentLocale, tr } from '../system/language.ts'
import { BrowserWindow, Menu, clipboard, session } from 'electron'
import { isWebNavigation, normalizeWebUrl } from './web-browser-url.ts'

import { ONLINE_BROWSER_PARTITION } from './online-network-rules.ts'
export const WEB_BROWSER_PARTITION = ONLINE_BROWSER_PARTITION
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

/** Plain user-addressed browser; remote pages never receive the app's preload. */
export function createWebBrowser(getMainWindow: () => BrowserWindow | null) {
  let window: BrowserWindow | null = null
  let home = '', target = '', failed = false
  let navigate: (url: string) => void = () => {}
  function open(raw: unknown): string {
    const url = normalizeWebUrl(raw), main = getMainWindow()
    if (!main || main.isDestroyed()) throw new Error('主窗口不可用')
    home = url
    if (window && !window.isDestroyed()) {
      navigate(url); if (window.isMinimized()) window.restore(); window.show(); window.focus(); return url
    }
    const browserSession = session.fromPartition(WEB_BROWSER_PARTITION)
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    const win = new BrowserWindow({ width: 1120, height: 820, minWidth: 720, minHeight: 500, title: tr('网页浏览 · 抱一'),
      autoHideMenuBar: false,
      webPreferences: { session: browserSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } })
    window = win
    const contents = win.webContents
    let popupUrl = '', popupCount = 0
    const currentAddress = () => isWebNavigation(contents.getURL()) ? contents.getURL() : target
    const returnToApp = (edit: boolean) => {
      const host = getMainWindow()
      if (!host || host.isDestroyed()) return
      if (host.isMinimized()) host.restore(); host.show(); host.focus()
      if (edit) host.webContents.send('web-browser:edit-address', currentAddress())
    }
    const updateMenu = () => {
      if (win.isDestroyed() || contents.isDestroyed()) return
      const address = currentAddress()
      win.setMenu(Menu.buildFromTemplate([
        { label: tr('主页'), click: () => navigate(home) },
        { label: tr('后退'), enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
        { label: tr('前进'), enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
        { label: tr('刷新'), accelerator: 'CmdOrCtrl+R', click: () => failed ? navigate(target) : contents.reload() },
        { label: tr('更换网址'), accelerator: 'CmdOrCtrl+L', click: () => returnToApp(true) },
        { label: tr('复制网址'), enabled: !!address, click: () => { const value = currentAddress(); if (isWebNavigation(value)) clipboard.writeText(value) } },
        { label: popupCount ? tr('已拦截弹窗 ({p0})', { p0: popupCount }) : tr('弹窗拦截已开启'), enabled: !!popupUrl, submenu: [
          { label: tr('在独立窗口打开最近弹窗'), click: () => { if (popupUrl) createWebBrowser(getMainWindow).open(popupUrl) } },
          { label: tr('复制弹窗网址'), click: () => { if (popupUrl) clipboard.writeText(popupUrl) } }
        ] },
        { label: tr('返回抱一'), click: () => returnToApp(false) }
      ]))
    }
    navigate = (value: string) => {
      if (win.isDestroyed() || !isWebNavigation(value)) return
      target = value; failed = false
      win.setTitle(tr('{p0} · 网页浏览 · 抱一', { p0: new URL(value).host }))
      void contents.loadURL(value).catch(() => { /* did-fail-load presents the error. */ })
    }
    const guard = (event: Electron.Event, value: string) => {
      if (!isWebNavigation(value)) { event.preventDefault(); win.setTitle(tr('此窗口只支持 HTTP(S) 网页 · 抱一')) }
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', (event, value, _inPlace, mainFrame) => { if (mainFrame) guard(event, value) })
    contents.setWindowOpenHandler(({ url: value }) => {
      if (isWebNavigation(value)) { popupUrl = value; popupCount++; updateMenu() }
      return { action: 'deny' }
    })
    contents.on('did-start-navigation', (_event, value, _inPlace, mainFrame) => {
      if (mainFrame && isWebNavigation(value)) { target = value; failed = false }
    })
    contents.on('page-title-updated', (event, title) => {
      event.preventDefault()
      win.setTitle(failed ? tr('网页加载失败 · 抱一') : tr('{p0} · 抱一', { p0: new URL(target).host + ' · ' + title.replace(/[\u0000-\u001f]/g, '').slice(0, 70) }))
    })
    contents.on('did-fail-load', (_event, code, description, validatedUrl, mainFrame) => {
      if (!mainFrame || code === -3 || !isWebNavigation(validatedUrl) || win.isDestroyed()) return
      target = validatedUrl; failed = true
      const html = `<!doctype html><html lang="${currentLocale.value}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(tr('网页加载失败'))}</title></head><body style="background:#1c1c2c;color:#ececf5;font-family:system-ui;padding:64px;line-height:1.8"><h1>${escapeHtml(tr('网页加载失败'))}</h1><p style="overflow-wrap:anywhere">${escapeHtml(validatedUrl)}</p><p>${escapeHtml(description)}</p><p>${escapeHtml(tr('可使用上方菜单“刷新”重试，或选择“更换网址”。'))}</p></body></html>`
      void contents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(cause => { console.error(cause); if (!win.isDestroyed()) win.setTitle(tr('网页加载失败 · 抱一')) })
    })
    contents.on('did-navigate', updateMenu); contents.on('did-navigate-in-page', updateMenu); contents.on('did-stop-loading', updateMenu)
    const blockDownload = (event: Electron.Event, _item: Electron.DownloadItem, sender: Electron.WebContents) => {
      if (sender === contents) { event.preventDefault(); win.setTitle(tr('此窗口暂不接入文件下载 · 抱一')) }
    }
    browserSession.on('will-download', blockDownload)
    const parentClosed = () => { if (!win.isDestroyed()) win.close() }
    main.once('closed', parentClosed)
    win.once('closed', () => {
      browserSession.removeListener('will-download', blockDownload); main.removeListener('closed', parentClosed)
      if (window === win) window = null
    })
    win.setMenuBarVisibility(true); updateMenu(); navigate(url)
    return url
  }
  return { open }
}
