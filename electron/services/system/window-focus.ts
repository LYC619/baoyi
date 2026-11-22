import type { BrowserWindow } from 'electron'

/**
 * Windows 上，原生对话框（选目录 / 确认框）关掉之后，或者把前台交给了资源管理器
 * （shell.openPath / showItemInFolder）之后，主窗口偶尔只剩「指针焦点」：
 * 界面点得动、输入框点得进去，但键盘打不了字，切出去再回来才恢复。
 * 渲染进程没有权限把焦点抢回来，只能在主进程补一次。
 *
 * 凡是在主进程里弹过原生对话框、或把前台让出去过，之后都该调用它。
 */
export function restoreWindowFocus(win: BrowserWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return
  win.focus()
  if (!win.webContents.isDestroyed()) win.webContents.focus()
}
