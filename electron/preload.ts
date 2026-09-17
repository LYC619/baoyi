import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AIConfig,
  AppSettings,
  BaoyiApi,
  Category,
  Episode,
  GameItem,
  GameQuery,
  IdentifyLogQuery,
  OrganizeCommand,
  PendingItem,
  SearchConfig,
  SoftwareItem,
  SoftwareQuery,
  TmdbConfig,
  Unsubscribe,
  VideoItem,
  VideoQuery
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
  hanimeBrowser: {
    open: (url?: string) => ipcRenderer.invoke('hanime-browser:open', url),
    onDownload: cb => subscribe('hanime-browser:download', cb)
  },
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
    addManual: () => ipcRenderer.invoke('software:add-manual'),
    pickIcon: (id: string) => ipcRenderer.invoke('software:pick-icon', id),
    clearIcon: (id: string) => ipcRenderer.invoke('software:clear-icon', id),
    refreshIcons: () => ipcRenderer.invoke('software:refresh-icons')
  },
  game: {
    addManual: () => ipcRenderer.invoke('game:add-manual'),
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
    checkSavePaths: () => ipcRenderer.invoke('game:check-save-paths'),
    launch: (id: string) => ipcRenderer.invoke('game:launch', id),
    running: (id: string) => ipcRenderer.invoke('game:running', id),
    onSession: (cb) => subscribe('game:session', cb),
    backupSave: (id: string, savePath: string) =>
      ipcRenderer.invoke('game:backup-save', id, savePath),
    backups: (id: string) => ipcRenderer.invoke('game:backups', id),
    restoreBackup: (backupId: string) => ipcRenderer.invoke('game:restore-backup', backupId),
    deleteBackup: (backupId: string) => ipcRenderer.invoke('game:delete-backup', backupId),
    openBackup: (backupId: string) => ipcRenderer.invoke('game:open-backup', backupId),
    pickLinks: (id: string, kind: 'file' | 'dir') =>
      ipcRenderer.invoke('game:pick-links', id, kind),
    openLink: (id: string, target: string) => ipcRenderer.invoke('game:open-link', id, target),
    revealLink: (id: string, target: string) => ipcRenderer.invoke('game:reveal-link', id, target),
    pickCover: (id: string) => ipcRenderer.invoke('game:pick-cover', id),
    clearCover: (id: string) => ipcRenderer.invoke('game:clear-cover', id),
    searchCovers: (id: string) => ipcRenderer.invoke('game:search-covers', id),
    setCoverFromUrl: (id: string, url: string) =>
      ipcRenderer.invoke('game:set-cover-url', id, url)
    ,rebuildCovers: (ids: string[] = []) => ipcRenderer.invoke('game:rebuild-covers', plain(ids))
    ,onCoverProgress: (cb) => subscribe('game:cover-progress', cb)
  },
  video: {
    list: (query: VideoQuery = {}) => ipcRenderer.invoke('video:list', plain(query)),
    get: (id: string) => ipcRenderer.invoke('video:get', id),
    update: (id: string, patch: Partial<VideoItem>) =>
      ipcRenderer.invoke('video:update', id, plain(patch)),
    restoreScraped: (id: string, fields: string[] = []) =>
      ipcRenderer.invoke('video:restore-scraped', id, plain(fields)),
    remove: (id: string) => ipcRenderer.invoke('video:remove', id),
    counts: () => ipcRenderer.invoke('video:counts'),
    revealInFolder: (id: string) => ipcRenderer.invoke('video:reveal', id),
    revealSubtitle: (id: string, target: string) =>
      ipcRenderer.invoke('video:reveal-subtitle', id, target),
    play: (id: string) => ipcRenderer.invoke('video:play', id),
    playEpisode: (episodeId: string) => ipcRenderer.invoke('video:play-episode', episodeId),
    pickDirectories: () => ipcRenderer.invoke('video:pick-dirs'),
    scan: (dirs: string[]) => ipcRenderer.invoke('video:scan', plain(dirs)),
    cancel: () => ipcRenderer.send('video:cancel'),
    onProgress: (cb) => subscribe('video:progress', cb),
    readiness: () => ipcRenderer.invoke('video:readiness'),
    episodes: (id: string) => ipcRenderer.invoke('video:episodes', id),
    updateEpisode: (episodeId: string, patch: Partial<Episode>) =>
      ipcRenderer.invoke('video:update-episode', episodeId, plain(patch)),
    fetchPoster: (id: string) => ipcRenderer.invoke('video:fetch-poster', id),
    reidentify: (id: string, forceHentai: boolean = false) =>
      ipcRenderer.invoke('video:reidentify', id, forceHentai),
    pickPoster: (id: string) => ipcRenderer.invoke('video:pick-poster', id),
    clearPoster: (id: string) => ipcRenderer.invoke('video:clear-poster', id)
  },
  categories: {
    list: (kind?: string) => ipcRenderer.invoke('categories:list', kind),
    upsert: (category: Category, kind?: string) => ipcRenderer.invoke('categories:upsert', plain(category), kind),
    remove: (id: string) => ipcRenderer.invoke('categories:remove', id),
    move: (id: string, delta: number) => ipcRenderer.invoke('categories:move', id, delta)
  },
  tags: {
    list: (kind?: string) => ipcRenderer.invoke('tags:list', kind),
    create: (name: string, kind?: string) => ipcRenderer.invoke('tags:create', name, kind),
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
    patch: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:patch', plain(patch)),
    proxyStatus: (url?: string) => ipcRenderer.invoke('settings:proxy-status', url),
    hanimeVerify: (url?: string) => ipcRenderer.invoke('settings:hanime-verify', url)
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
    testTmdb: (config: TmdbConfig) => ipcRenderer.invoke('ai:test-tmdb', plain(config)),
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
    clear: (resourceKind?: string) => ipcRenderer.invoke('logs:clear', resourceKind),
    reports: (resourceKind?: string) => ipcRenderer.invoke('logs:reports', resourceKind)
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
