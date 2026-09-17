import { BrowserWindow, app, net, protocol, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpcHandlers } from './ipc/handlers'
import { finalizeGameSessions } from './kinds/game/service'
import { closeDb, coversDir, getDb, getSettings, iconsDir, patchSettings, postersDir, interruptRunningTasks } from './services/database'
import { resolvePosterRequest } from './services/poster-protocol'
import { initPortable } from './services/portable'
import { initProxy, setHanimeHostsEnabled } from './services/proxy'
import { buildHanimeHostResolverRules, HANIME_HOSTS, pickStartupIp } from './services/hanime-network-rules'
import { startHeartbeat } from './services/timing.ts'

// **必须排在最前面，不能挪进 whenReady。** 绿色版要把 userData 指到 exe 旁边，
// 而下面的 requestSingleInstanceLock 会在 userData 里建锁文件、createWindow 会
// getSettings() 顺手开库 —— 晚一步，这两样就先落在旧位置了，表现是「绿色版旁边
// 有个空 data/，真数据还在 %APPDATA%」
initPortable()

// 必须在 app ready 前设置：Chromium 只会在网络栈初始化时读取这项，之后追加不认
// （scripts 里做过实验）。这让 Hanime 直连请求也能绕开受污染的系统 DNS；代理模式
// 仍由 session.setProxy 决定。用户关掉内置 Hosts 后走系统 DNS，改动要重启才到这一层。
// 这里读设置会提前把库打开 —— initPortable 已经排在前面，位置是对的；读不到就按开启处理。
// 启动地址用上次运行时回退通了的那个（记在设置里），没有就是地址池第一个：
// 第一个地址死了的话，验证窗口和下载都跟着死，只有换启动地址才救得回来。
const hanimeStartup = (() => {
  try {
    const s = getSettings()
    return { enabled: s.hanime_builtin_hosts !== false, ip: pickStartupIp(s.hanime_hosts_active_ip) }
  } catch { return { enabled: true, ip: pickStartupIp() } }
})()
if (hanimeStartup.enabled) app.commandLine.appendSwitch('host-resolver-rules', buildHanimeHostResolverRules(HANIME_HOSTS, hanimeStartup.ip))
setHanimeHostsEnabled(hanimeStartup.enabled, {
  startupIp: hanimeStartup.ip,
  remember: (ip) => { patchSettings({ hanime_hosts_active_ip: ip }) }
})

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
  cover: coversDir
}

/** 库里是不是记着这条路径。海报协议放行的第三类（片子旁边的 poster.jpg 这种用户文件）靠它 */
function posterReferenced(file: string): boolean {
  try {
    const slashed = file.split('\\').join('/')
    return !!getDb().prepare(
      `SELECT 1 FROM video_meta WHERE poster_path IN (?, ?) COLLATE NOCASE OR thumbnail_path IN (?, ?) COLLATE NOCASE
       UNION SELECT 1 FROM episode WHERE poster_path IN (?, ?) COLLATE NOCASE OR thumbnail_path IN (?, ?) COLLATE NOCASE LIMIT 1`
    ).get(file, slashed, file, slashed, file, slashed, file, slashed)
  } catch { return false }
}

function registerFileProtocol(): void {
  protocol.handle('baoyi', async (request) => {
    const url = new URL(request.url)
    // 海报按完整路径取（?p=），放行规则见 poster-protocol.ts；图标和封面仍按文件名在各自目录里找
    if (url.hostname === 'poster') {
      const file = resolvePosterRequest(request.url, { postersDir: postersDir(), isReferenced: posterReferenced })
      if (!file || !fs.existsSync(file)) return new Response('Not Found', { status: 404 })
      return net.fetch(pathToFileURL(file).toString())
    }
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
    // 默认是空操作，只有带 BAOYI_TIMING=1 起才真的跑
    startHeartbeat()

    registerFileProtocol()
    interruptRunningTasks()
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
