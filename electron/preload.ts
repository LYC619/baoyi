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
  VideoDownloadCatalog,
  VideoDownloadProgress,
  VideoDownloadRequest,
  VideoDownloadResult,
  VideoSeriesCatalog,
  VideoSeriesDownloadProgress,
  VideoSeriesDownloadRequest,
  VideoSeriesDownloadResult,
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
  videoAgentOrganize: {
    prepare: (ids, actions) => ipcRenderer.invoke('video-agent:prepare', plain(ids), plain(actions)),
    run: (id, groups) => ipcRenderer.invoke('video-agent:run', id, plain(groups)),
    cancel: () => ipcRenderer.invoke('video-agent:cancel'),
    onProgress: callback => subscribe('video-agent:progress', callback)
  },
  videoImport: {
    list: () => ipcRenderer.invoke('video-import:list'),
    get: id => ipcRenderer.invoke('video-import:get', id),
    prepare: roots => ipcRenderer.invoke('video-import:prepare', plain(roots)),
    refresh: id => ipcRenderer.invoke('video-import:refresh', id),
    update: (id, changes) => ipcRenderer.invoke('video-import:update', id, plain(changes)),
    review: (id, ids) => ipcRenderer.invoke('video-import:review', id, plain(ids)),
    confirm: (id, ids) => ipcRenderer.invoke('video-import:confirm', id, plain(ids)),
    discard: id => ipcRenderer.invoke('video-import:discard', id),
    cancel: id => ipcRenderer.invoke('video-import:cancel', id),
    onChanged: callback => subscribe('video-import:changed', callback)
  },
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
    readiness: (forAgent = false) => ipcRenderer.invoke('video:readiness', forAgent),
    episodes: (id: string) => ipcRenderer.invoke('video:episodes', id),
    searchSource: (query) => ipcRenderer.invoke('video:source-search', query),
    scrapeEpisode: (id, episodeId, source) => ipcRenderer.invoke('video:episode-scrape', id, episodeId || '', source || ''),
    pickEpisodeArtwork: (id, role) => ipcRenderer.invoke('video:episode-artwork', id, role),
    previewRemoval: (request) => ipcRenderer.invoke('video:removal-preview', plain(request)),
    applyRemoval: (preview) => ipcRenderer.invoke('video:removal-apply', plain(preview)),
    bulkUpdate: (ids, patch) => ipcRenderer.invoke('video:bulk-update', plain(ids), plain(patch)),
    importBundle: () => ipcRenderer.invoke('video:import-bundle'),
    library: (id: string) => ipcRenderer.invoke('video:library', id),
    syncFiles: (id: string) => ipcRenderer.invoke('video:sync-files', id),
    previewCollectionName: (id: string, title: string) => ipcRenderer.invoke('video:preview-collection-name', id, title),
    renameCollection: (id: string, title: string) => ipcRenderer.invoke('video:rename-collection', id, title),
    playAsset: (id: string) => ipcRenderer.invoke('video:play-asset', id),
    revealAsset: (id: string) => ipcRenderer.invoke('video:reveal-asset', id),
    relocateAsset: (id: string) => ipcRenderer.invoke('video:relocate-asset', id),
    setDefaultAsset: (episodeId: string, assetId: string) => ipcRenderer.invoke('video:default-asset', episodeId, assetId),
    prepareDownload: (input) => ipcRenderer.invoke('video-workflow:prepare', plain(input)),
    pickDownloadRoot: (draftId: string) => ipcRenderer.invoke('video-workflow:pick-root', draftId),
    enqueueDownload: (request) => ipcRenderer.invoke('video-workflow:enqueue', plain(request)),
    downloadJobs: () => ipcRenderer.invoke('video-workflow:list'),
    retryDownloadJob: (id, stage) => ipcRenderer.invoke('video-workflow:retry', id, stage),
    cancelDownloadJob: (id) => ipcRenderer.invoke('video-workflow:cancel', id),
    revealDownloadJob: (id) => ipcRenderer.invoke('video-workflow:reveal', id),
    onDownloadJob: (cb) => subscribe('video-workflow:changed', cb),
    onLibraryChanged: (cb) => subscribe('video:library-changed', cb),
    updateEpisode: (episodeId: string, patch: Partial<Episode>) =>
      ipcRenderer.invoke('video:update-episode', episodeId, plain(patch)),
    fetchPoster: (id: string) => ipcRenderer.invoke('video:fetch-poster', id),
    reidentify: (id: string, forceHentai: boolean = false) =>
      ipcRenderer.invoke('video:reidentify', id, forceHentai),
    pickPoster: (id: string) => ipcRenderer.invoke('video:pick-poster', id),
    clearPoster: (id: string) => ipcRenderer.invoke('video:clear-poster', id),
    downloadSources: (id: string): Promise<VideoDownloadCatalog> => ipcRenderer.invoke('video-download:sources', id),
    download: (request: VideoDownloadRequest): Promise<VideoDownloadResult> => ipcRenderer.invoke('video-download:run', plain(request)),
    downloadSeries: (id: string): Promise<VideoSeriesCatalog> => ipcRenderer.invoke('video-download:series', id),
    downloadSeriesRun: (request: VideoSeriesDownloadRequest): Promise<VideoSeriesDownloadResult> => ipcRenderer.invoke('video-download:run-series', plain(request)),
    cancelDownload: (requestId: string) => ipcRenderer.invoke('video-download:cancel', requestId),
    onDownloadProgress: (cb: (progress: VideoDownloadProgress | VideoSeriesDownloadProgress) => void) => subscribe('video-download:progress', cb),
    revealDownload: (requestId: string) => ipcRenderer.invoke('video-download:reveal', requestId)
  },
  videoOrganize: {
    preview: request => ipcRenderer.invoke('video-organize:preview', plain(request)),
    apply: request => ipcRenderer.invoke('video-organize:apply', plain(request)),
    retry: id => ipcRenderer.invoke('video-organize:retry', id),
    rollback: id => ipcRenderer.invoke('video-organize:rollback', id),
    list: resourceId => ipcRenderer.invoke('video-organize:list', resourceId),
    previewRelocate: request => ipcRenderer.invoke('video-organize:preview-relocate', plain(request)),
    relocate: request => ipcRenderer.invoke('video-organize:relocate', plain(request)),
    pickDirectory: () => ipcRenderer.invoke('video-organize:pick-directory')
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    save: (task: import('../src/types').TaskRecord) => ipcRenderer.invoke('tasks:save', plain(task)),
    clear: ids => ipcRenderer.invoke('tasks:clear', ids === undefined ? undefined : plain(ids))
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
    restoreJson: () => ipcRenderer.invoke('data:restore-json'),
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
