import { app, session, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { clearBrowserCacheSessions, readStorageUsage } from '../services/storage-usage.ts'
import { ONLINE_SOURCE_PARTITION, ONLINE_BROWSER_PARTITION } from '../services/online-network-rules.ts'
import type { BrowserCacheClearResult, StorageUsage } from '../../src/types/storage.ts'

export function registerStorageIpc(getWindow: () => BrowserWindow | null, ipc: Pick<IpcMain, 'handle'>): void {
  let reading: Promise<StorageUsage> | null = null, clearing: Promise<BrowserCacheClearResult> | null = null
  const guard = (event: IpcMainInvokeEvent) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('只允许主窗口管理数据占用')
  }
  const read = () => reading ||= readStorageUsage(app.getPath('userData')).finally(() => { reading = null })
  ipc.handle('data:storage-usage', event => { guard(event); return read() })
  ipc.handle('data:clear-browser-cache', event => {
    guard(event)
    return clearing ||= (async () => {
      const before = await read()
      const warnings = await clearBrowserCacheSessions([
        { name: '应用窗口', session: session.defaultSession },
        ...[ONLINE_SOURCE_PARTITION, ONLINE_BROWSER_PARTITION, 'persist:hanime-network'].map(partition => ({ name: partition.replace('persist:', ''), session: session.fromPartition(partition) }))
      ])
      // Do not return a coalesced measurement started before cache clearing.
      if (reading) await reading
      const usage = await readStorageUsage(app.getPath('userData'))
      const cacheBytes = (value: StorageUsage) => value.items.find(item => item.category === 'browser-cache')?.bytes || 0
      return { reclaimedBytes: Math.max(0, cacheBytes(before) - cacheBytes(usage)), warnings, usage }
    })().finally(() => { clearing = null })
  })
}
