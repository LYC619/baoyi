import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AIConfig,
  AppSettings,
  BaoyiApi,
  Category,
  IdentifyLogQuery,
  SearchConfig,
  SoftwareItem,
  SoftwareQuery,
  Unsubscribe
} from '../src/types'

/** 把 ipcRenderer.on 包成「返回取消订阅函数」的形式，组件卸载时好清理 */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

const api: BaoyiApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info')
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    onMaximizeChange: (cb) => subscribe('win:maximize-change', cb)
  },
  software: {
    list: (query: SoftwareQuery = {}) => ipcRenderer.invoke('software:list', query),
    get: (id: string) => ipcRenderer.invoke('software:get', id),
    update: (id: string, patch: Partial<SoftwareItem>) =>
      ipcRenderer.invoke('software:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('software:remove', id),
    counts: (unusedDays: number) => ipcRenderer.invoke('software:counts', unusedDays),
    launch: (id: string, launcherPath?: string) =>
      ipcRenderer.invoke('software:launch', id, launcherPath),
    revealInFolder: (id: string, launcherPath?: string) =>
      ipcRenderer.invoke('software:reveal', id, launcherPath),
    addManual: () => ipcRenderer.invoke('software:add-manual')
  },
  categories: {
    list: () => ipcRenderer.invoke('categories:list'),
    upsert: (category: Category) => ipcRenderer.invoke('categories:upsert', category),
    remove: (id: string) => ipcRenderer.invoke('categories:remove', id)
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:get'),
    patch: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:patch', patch)
  },
  scan: {
    pickDirectory: () => ipcRenderer.invoke('scan:pick-dir'),
    run: (dirs: string[]) => ipcRenderer.invoke('scan:run', dirs),
    cancel: () => ipcRenderer.send('scan:cancel'),
    onProgress: (cb) => subscribe('scan:progress', cb),
    units: () => ipcRenderer.invoke('scan:units'),
    reset: () => ipcRenderer.invoke('scan:reset'),
    retry: (dir: string) => ipcRenderer.invoke('scan:reset-one', dir)
  },
  ai: {
    complete: (ids?: string[]) => ipcRenderer.invoke('ai:complete', ids),
    cancel: () => ipcRenderer.send('ai:cancel'),
    test: (config: AIConfig) => ipcRenderer.invoke('ai:test', config),
    testSearch: (config: SearchConfig) => ipcRenderer.invoke('ai:test-search', config),
    onProgress: (cb) => subscribe('ai:progress', cb)
  },
  data: {
    exportJson: () => ipcRenderer.invoke('data:export-json'),
    exportMarkdown: () => ipcRenderer.invoke('data:export-markdown'),
    dir: () => ipcRenderer.invoke('data:dir'),
    openDir: () => ipcRenderer.invoke('data:open-dir'),
    stats: () => ipcRenderer.invoke('data:stats'),
    reset: (mode: 'library' | 'all') => ipcRenderer.invoke('data:reset', mode)
  },
  logs: {
    list: (query: IdentifyLogQuery = {}) => ipcRenderer.invoke('logs:list', query),
    clear: () => ipcRenderer.invoke('logs:clear')
  }
}

contextBridge.exposeInMainWorld('baoyi', api)
