import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AIConfig,
  AppSettings,
  BaoyiApi,
  Category,
  GameItem,
  GameQuery,
  IdentifyLogQuery,
  OrganizeCommand,
  PendingItem,
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

/**
 * 抹掉 undefined 的键：patch 里没写的字段不该被主进程当成「清空」。
 * updateSoftware 走的是 Object.entries(patch)，`{name_zh: undefined}` 会真的写进 NULL。
 *
 * 注意这里**管不了** Vue 的 reactive 代理。代理过不了 contextBridge 的结构化克隆，
 * 而且是在 contextBridge 那一层就同步抛「An object could not be cloned.」——
 * 根本走不到这个函数体。拍平只能在渲染进程侧做，见 src/utils 的 plain()。
 */
function plain<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

const api: BaoyiApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    copyText: (text: string) => ipcRenderer.invoke('app:copy', String(text))
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    onMaximizeChange: (cb) => subscribe('win:maximize-change', cb)
  },
  software: {
    list: (query: SoftwareQuery = {}) => ipcRenderer.invoke('software:list', plain(query)),
    get: (id: string) => ipcRenderer.invoke('software:get', id),
    update: (id: string, patch: Partial<SoftwareItem>) =>
      ipcRenderer.invoke('software:update', id, plain(patch)),
    remove: (id: string) => ipcRenderer.invoke('software:remove', id),
    counts: (unusedDays: number) => ipcRenderer.invoke('software:counts', unusedDays),
    launch: (id: string, launcherPath?: string) =>
      ipcRenderer.invoke('software:launch', id, launcherPath),
    revealInFolder: (id: string, launcherPath?: string) =>
      ipcRenderer.invoke('software:reveal', id, launcherPath),
    addManual: () => ipcRenderer.invoke('software:add-manual')
  },
  game: {
    list: (query: GameQuery = {}) => ipcRenderer.invoke('game:list', plain(query)),
    get: (id: string) => ipcRenderer.invoke('game:get', id),
    update: (id: string, patch: Partial<GameItem>) =>
      ipcRenderer.invoke('game:update', id, plain(patch)),
    remove: (id: string) => ipcRenderer.invoke('game:remove', id),
    counts: () => ipcRenderer.invoke('game:counts'),
    revealInFolder: (id: string) => ipcRenderer.invoke('game:reveal', id),
    pickDirectories: () => ipcRenderer.invoke('game:pick-dirs'),
    scan: (dirs: string[]) => ipcRenderer.invoke('game:scan', plain(dirs)),
    cancel: () => ipcRenderer.send('game:cancel'),
    onProgress: (cb) => subscribe('game:progress', cb),
    pickSavePath: () => ipcRenderer.invoke('game:pick-save-dir'),
    verifySavePath: (id: string, path: string) => ipcRenderer.invoke('game:verify-save', id, path),
    backupSave: (id: string, savePath: string) =>
      ipcRenderer.invoke('game:backup-save', id, savePath),
    backups: (id: string) => ipcRenderer.invoke('game:backups', id),
    restoreBackup: (backupId: string) => ipcRenderer.invoke('game:restore-backup', backupId),
    deleteBackup: (backupId: string) => ipcRenderer.invoke('game:delete-backup', backupId),
    openBackup: (backupId: string) => ipcRenderer.invoke('game:open-backup', backupId)
  },
  categories: {
    list: () => ipcRenderer.invoke('categories:list'),
    upsert: (category: Category) => ipcRenderer.invoke('categories:upsert', plain(category)),
    remove: (id: string) => ipcRenderer.invoke('categories:remove', id),
    move: (id: string, delta: number) => ipcRenderer.invoke('categories:move', id, delta)
  },
  tags: {
    list: () => ipcRenderer.invoke('tags:list'),
    create: (name: string) => ipcRenderer.invoke('tags:create', name),
    rename: (id: number, name: string) => ipcRenderer.invoke('tags:rename', id, name),
    merge: (fromIds: number[], intoId: number) =>
      ipcRenderer.invoke('tags:merge', plain(fromIds), intoId),
    remove: (id: number) => ipcRenderer.invoke('tags:remove', id)
  },
  pending: {
    list: () => ipcRenderer.invoke('pending:list'),
    count: () => ipcRenderer.invoke('pending:count'),
    update: (id: string, patch: Partial<PendingItem>) =>
      ipcRenderer.invoke('pending:update', id, plain(patch)),
    confirm: (ids: string[]) => ipcRenderer.invoke('pending:confirm', plain(ids)),
    skip: (ids: string[]) => ipcRenderer.invoke('pending:skip', plain(ids)),
    skippedCount: () => ipcRenderer.invoke('pending:skipped-count'),
    clearSkipped: () => ipcRenderer.invoke('pending:clear-skipped')
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:get'),
    patch: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:patch', plain(patch))
  },
  scan: {
    pickDirectory: () => ipcRenderer.invoke('scan:pick-dir'),
    run: (dirs: string[]) => ipcRenderer.invoke('scan:run', plain(dirs)),
    cancel: () => ipcRenderer.send('scan:cancel'),
    onProgress: (cb) => subscribe('scan:progress', cb),
    units: () => ipcRenderer.invoke('scan:units'),
    reset: () => ipcRenderer.invoke('scan:reset'),
    retry: (dir: string) => ipcRenderer.invoke('scan:reset-one', dir)
  },
  ai: {
    complete: (ids?: string[]) => ipcRenderer.invoke('ai:complete', plain(ids)),
    cancel: () => ipcRenderer.send('ai:cancel'),
    test: (config: AIConfig) => ipcRenderer.invoke('ai:test', plain(config)),
    models: (config: AIConfig) => ipcRenderer.invoke('ai:models', plain(config)),
    testSearch: (config: SearchConfig) => ipcRenderer.invoke('ai:test-search', plain(config)),
    onProgress: (cb) => subscribe('ai:progress', cb)
  },
  data: {
    exportJson: () => ipcRenderer.invoke('data:export-json'),
    exportMarkdown: () => ipcRenderer.invoke('data:export-markdown'),
    dir: () => ipcRenderer.invoke('data:dir'),
    openDir: () => ipcRenderer.invoke('data:open-dir'),
    stats: () => ipcRenderer.invoke('data:stats'),
    saveBackupRoot: () => ipcRenderer.invoke('data:save-backup-root'),
    pickSaveBackupRoot: () => ipcRenderer.invoke('data:pick-save-backup-root'),
    openSaveBackupRoot: () => ipcRenderer.invoke('data:open-save-backup-root'),
    reset: (mode: 'library' | 'all') => ipcRenderer.invoke('data:reset', mode)
  },
  logs: {
    list: (query: IdentifyLogQuery = {}) => ipcRenderer.invoke('logs:list', plain(query)),
    clear: () => ipcRenderer.invoke('logs:clear'),
    reports: () => ipcRenderer.invoke('logs:reports')
  },
  organize: {
    pickRoot: () => ipcRenderer.invoke('organize:pick-root'),
    preview: (ids?: string[]) => ipcRenderer.invoke('organize:preview', plain(ids)),
    run: (commands: OrganizeCommand[]) => ipcRenderer.invoke('organize:run', plain(commands)),
    onProgress: (cb) => subscribe('organize:progress', cb),
    plans: () => ipcRenderer.invoke('organize:plans'),
    undo: (planId: string) => ipcRenderer.invoke('organize:undo', planId),
    materialize: (id: string) => ipcRenderer.invoke('organize:materialize', id),
    unlink: (id: string) => ipcRenderer.invoke('organize:unlink', id)
  }
}

contextBridge.exposeInMainWorld('baoyi', api)
