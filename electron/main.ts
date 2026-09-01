import { BrowserWindow, app, net, protocol, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpcHandlers } from './ipc/handlers'
import { finalizeGameSessions } from './kinds/game/service'
import { closeDb, coversDir, getSettings, iconsDir, postersDir } from './services/database'
import { initPortable } from './services/portable'
import { initProxy } from './services/proxy'

// **必须排在最前面，不能挪进 whenReady。** 绿色版要把 userData 指到 exe 旁边，
// 而下面的 requestSingleInstanceLock 会在 userData 里建锁文件、createWindow 会
// getSettings() 顺手开库 —— 晚一步，这两样就先落在旧位置了，表现是「绿色版旁边
// 有个空 data/，真数据还在 %APPDATA%」
initPortable()

const APP_ROOT = path.join(__dirname, '..')
const RENDERER_DIST = path.join(APP_ROOT, 'dist')
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

let mainWindow: BrowserWindow | null = null
const getWindow = () => mainWindow

/** 图标走自定义协议，避免渲染进程直接触碰 file:// */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'baoyi',
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
])

/**
 * hostname → 去哪个目录里找文件。
 *
 * 白名单式的映射，不是「把 hostname 当路径拼进去」：后者等于让渲染进程指定
 * 读哪个目录。加一种资源就在这儿加一行，加不了别的。
 */
const PROTOCOL_DIRS: Record<string, () => string> = {
  icon: iconsDir,
  cover: coversDir,
  poster: postersDir
}

function registerFileProtocol(): void {
  protocol.handle('baoyi', async (request) => {
    const url = new URL(request.url)
    const resolveDir = PROTOCOL_DIRS[url.hostname]
    if (!resolveDir) return new Response('Not Found', { status: 404 })

    // basename 兜底，杜绝 ../ 穿越到那个目录之外。查询串（封面用它破缓存）
    // 不进 pathname，所以这里不必额外剥
    const name = path.basename(decodeURIComponent(url.pathname))
    const file = path.join(resolveDir(), name)
    if (!fs.existsSync(file)) return new Response('Not Found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

function createWindow(): void {
  const theme = (() => {
    try {
      return getSettings().theme
    } catch {
      return 'dark' as const
    }
  })()

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: theme === 'light' ? '#F8F9FC' : '#1E1E2E',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))
  mainWindow.on('maximize', () => mainWindow?.webContents.send('win:maximize-change', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win:maximize-change', false))

  // 外链一律交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    registerFileProtocol()
    registerIpcHandlers(getWindow)
    // 代理不 await：它只影响联网刮削，拦住建窗口不值得。里面自己吞异常 ——
    // 填错一个代理地址不该变成「应用打不开」
    void initProxy(() => getSettings().proxy)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    // 顺序是硬要求：结算要写库，得赶在库关掉之前。所以这两件事放在同一个处理器里
    // 按顺序写，而不是分成两个 app.on —— 那样就依赖注册顺序了。
    finalizeGameSessions()
    closeDb()
  })
}
