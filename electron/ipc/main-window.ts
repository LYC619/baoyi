import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { assertSafeIpcArgs, IpcError } from './validate.ts'

type Sender = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>
type WindowSource = () => BrowserWindow | null
type AppIpc = Pick<IpcMain, 'handle' | 'on'>

/** Freeze admission before draining, so a late IPC cannot reopen the database. */
export class IpcActivity {
  private pending = new Set<Promise<unknown>>()
  private stopped = false
  private resetting = false
  get unavailable() { return this.stopped || this.resetting }
  get exclusive() { return this.resetting }
  get busy() { return this.pending.size > 0 }
  async run<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.unavailable) throw new IpcError('UNAVAILABLE', '正在退出或重置资料库，请稍候')
    // Invoke synchronously: an exclusive reset must see earlier work, not itself.
    const task = Promise.resolve(action())
    this.pending.add(task)
    try { return await task } finally { this.pending.delete(task) }
  }
  track(ipc: AppIpc): AppIpc {
    return {
      handle: (channel, action) => ipc.handle(channel, (event, ...args) => this.run(() => action(event, ...args))),
      on: (channel, action) => ipc.on(channel, (event, ...args) => {
        if (!this.stopped && !this.resetting) action(event, ...args)
      })
    }
  }
  stop() { this.stopped = true; return Promise.allSettled(this.pending) }
  async reset<T>(action: () => Promise<T>): Promise<T> {
    if (this.pending.size || this.resetting) throw new IpcError('CONFLICT', '还有操作正在进行，请稍后再重置资料库')
    this.resetting = true
    try { return await action() } finally { this.resetting = false }
  }
}

function isMainWindowSender(event: Sender, getWindow: WindowSource): boolean {
  const win = getWindow()
  return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
}

export function assertMainWindowSender(event: Sender, getWindow: WindowSource): void {
  if (!isMainWindowSender(event, getWindow)) throw new IpcError('FORBIDDEN', '只允许主窗口操作')
}

export function mainWindowIpc(ipc: Pick<IpcMain, 'handle' | 'on'>, getWindow: WindowSource) {
  return {
    handle(channel: string, action: Parameters<IpcMain['handle']>[1]) {
      ipc.handle(channel, (event, ...args) => {
        assertMainWindowSender(event, getWindow)
        assertSafeIpcArgs(channel, args)
        return action(event, ...args)
      })
    },
    on(channel: string, action: Parameters<IpcMain['on']>[1]) {
      ipc.on(channel, (event, ...args) => {
        // One-way messages have no caller to receive exceptions in the main process.
        if (!isMainWindowSender(event, getWindow)) return
        try { assertSafeIpcArgs(channel, args) } catch { return }
        action(event, ...args)
      })
    }
  }
}
