import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  archive: {
    insights:{onChanged:callback=>subscribe('archive:insights-changed',callback),preview:(ids,range)=>ipcRenderer.invoke('archive:insight-preview',plain(ids),range&&plain(range)),cleanupPreview:()=>ipcRenderer.invoke('archive:insight-cleanup-preview'),cleanup:token=>ipcRenderer.invoke('archive:insight-cleanup',token),clearCache:()=>ipcRenderer.invoke('archive:insight-clear-cache'),start:(token,force)=>ipcRenderer.invoke('archive:insight-start',token,force),list:()=>ipcRenderer.invoke('archive:insight-list'),detail:id=>ipcRenderer.invoke('archive:insight-detail',id),cancel:id=>ipcRenderer.invoke('archive:insight-cancel',id),edit:(id,revision,content)=>ipcRenderer.invoke('archive:insight-edit',id,revision,plain(content)),activate:(id,versionId,revision)=>ipcRenderer.invoke('archive:insight-activate',id,versionId,revision),adopt:(id,revision)=>ipcRenderer.invoke('archive:insight-adopt',id,revision)},
    projectHandoffPreview:(id,includeRules)=>ipcRenderer.invoke('archive:project-handoff-preview',id,includeRules),projectHandoffGenerate:input=>ipcRenderer.invoke('archive:project-handoff-generate',plain(input)),projectHandoffCancel:id=>ipcRenderer.invoke('archive:project-handoff-cancel',id),projectHandoffAdopt:(id,revision,prompt)=>ipcRenderer.invoke('archive:project-handoff-adopt',id,revision,prompt),
    status:()=>ipcRenderer.invoke('archive:status'),sessions:query=>ipcRenderer.invoke('archive:sessions',query),session:id=>ipcRenderer.invoke('archive:session',id),
    send:input=>ipcRenderer.invoke('archive:send',plain(input)),cancel:()=>ipcRenderer.invoke('archive:cancel'),steer:text=>ipcRenderer.invoke('archive:steer',text),rename:(id,title)=>ipcRenderer.invoke('archive:rename',id,title),archive:id=>ipcRenderer.invoke('archive:archive',id),
    memory:()=>ipcRenderer.invoke('archive:memory'),editMemory:input=>ipcRenderer.invoke('archive:memory-edit',plain(input)),skills:()=>ipcRenderer.invoke('archive:skills'),
    actions:id=>ipcRenderer.invoke('archive:actions',id),undo:id=>ipcRenderer.invoke('archive:undo',id),source:id=>ipcRenderer.invoke('archive:source',id),onEvent:callback=>subscribe('archive:event',callback)
  },
  workspace: {
    preferences:{get:module=>ipcRenderer.invoke('workspace:preferences:get',module),save:(module,value)=>ipcRenderer.invoke('workspace:preferences:save',module,value),dataDirectory:()=>ipcRenderer.invoke('workspace:preferences:data-directory'),chooseDataDirectory:()=>ipcRenderer.invoke('workspace:preferences:choose-data-directory')},
    recycle:{previewBatch:(ids,withFiles)=>ipcRenderer.invoke('workspace:recycle:preview-batch',plain(ids),withFiles),confirmBatch:token=>ipcRenderer.invoke('workspace:recycle:confirm-batch',token),locations:id=>ipcRenderer.invoke('workspace:recycle:locations',id),preview:(id,paths)=>ipcRenderer.invoke('workspace:recycle:preview',id,paths),confirm:token=>ipcRenderer.invoke('workspace:recycle:confirm',token),list:()=>ipcRenderer.invoke('workspace:recycle:list'),restore:(id,alternate)=>ipcRenderer.invoke('workspace:recycle:restore',id,alternate),resume:id=>ipcRenderer.invoke('workspace:recycle:resume',id),cleanup:()=>ipcRenderer.invoke('workspace:recycle:cleanup')},
    files:{choose:id=>ipcRenderer.invoke('workspace:files:choose',id),preview:(token,mode,target,name)=>ipcRenderer.invoke('workspace:files:preview',token,mode,target,name),confirm:token=>ipcRenderer.invoke('workspace:files:confirm',token),operations:id=>ipcRenderer.invoke('workspace:files:operations',id),recover:id=>ipcRenderer.invoke('workspace:files:recover',id)},
    documents: {
      covers:{get:id=>ipcRenderer.invoke('workspace:documents:covers:get',id),source:(id,token)=>ipcRenderer.invoke('workspace:documents:covers:source',id,token),range:(id,token,offset,length)=>ipcRenderer.invoke('workspace:documents:covers:range',id,token,offset,length),put:(id,token,png)=>ipcRenderer.invoke('workspace:documents:covers:put',id,token,png)},
      categories:(submodule?: any)=>ipcRenderer.invoke('workspace:documents:categories',submodule),saveCategory:input=>ipcRenderer.invoke('workspace:documents:save-category',plain(input)),removeCategory:(id,target)=>ipcRenderer.invoke('workspace:documents:remove-category',id,target),
      analyzeImport:(token,path)=>ipcRenderer.invoke('workspace:documents:analyze-import',token,path),
      customGroups:(submodule?: any, categoryId?: any)=>ipcRenderer.invoke('workspace:documents:custom-groups',submodule, categoryId),saveCustomGroup:input=>ipcRenderer.invoke('workspace:documents:save-custom-group',plain(input)),removeCustomGroup:id=>ipcRenderer.invoke('workspace:documents:remove-custom-group',id),
      moveToSubmodule:(id: string, targetSubmodule: any, targetCategoryId?: string)=>ipcRenderer.invoke('workspace:documents:move-to-submodule',id,targetSubmodule,targetCategoryId),
      list:(options?: any)=>ipcRenderer.invoke('workspace:documents:list',plain(options)),get:id=>ipcRenderer.invoke('workspace:documents:get',id),
      update:(id,patch)=>ipcRenderer.invoke('workspace:documents:update',id,plain(patch)),remove:id=>ipcRenderer.invoke('workspace:documents:remove',id),
      prepareImport:(directory,categoryId,droppedPaths)=>ipcRenderer.invoke('workspace:documents:prepare-import',directory,categoryId,droppedPaths&&plain(droppedPaths)),confirmImport:(token,paths,categoryId,submodule,customGroupId,choices)=>ipcRenderer.invoke('workspace:documents:confirm-import',token,plain(paths),categoryId,submodule,customGroupId,choices && plain(choices)),
      relocate:id=>ipcRenderer.invoke('workspace:documents:relocate',id),open:id=>ipcRenderer.invoke('workspace:documents:open',id),reveal:id=>ipcRenderer.invoke('workspace:documents:reveal',id),
      content:(id,encoding)=>ipcRenderer.invoke('workspace:documents:content',id,encoding),
      textIndex:(id,encoding)=>ipcRenderer.invoke('workspace:documents:text:index',id,encoding),
      searchText:(id,query,page,start,encoding)=>ipcRenderer.invoke('workspace:documents:text:search',id,query,page,start,encoding),
      textSlice:(id,byteOffset,byteLength,encoding)=>ipcRenderer.invoke('workspace:documents:text:slice',id,byteOffset,byteLength,encoding),
      pdfRange:(id,offset,length)=>ipcRenderer.invoke('workspace:documents:pdf:range',id,offset,length),
      position:(id,loc,count)=>ipcRenderer.invoke('workspace:documents:position',id,plain(loc),count),
      annotations:id=>ipcRenderer.invoke('workspace:documents:annotations',id),annotate:(id,input)=>ipcRenderer.invoke('workspace:documents:annotate',id,plain(input)),
      removeAnnotation:(id,annotation)=>ipcRenderer.invoke('workspace:documents:remove-annotation',id,annotation),export:(id,ids,obsidian)=>ipcRenderer.invoke('workspace:documents:export',id,plain(ids),obsidian),markdown:(id,ids)=>ipcRenderer.invoke('workspace:documents:markdown',id,plain(ids)),
      pickDirectory:()=>ipcRenderer.invoke('workspace:documents:organize:pick-directory'),
      previewOrganize:options=>ipcRenderer.invoke('workspace:documents:organize:preview',plain(options)),
      executeOrganize:options=>ipcRenderer.invoke('workspace:documents:organize:execute',plain(options)),
      organizeHistory:()=>ipcRenderer.invoke('workspace:documents:organize:history'),
      undoOrganize:id=>ipcRenderer.invoke('workspace:documents:organize:undo',id)
    },
    links: {
      projectReferences:ids=>ipcRenderer.invoke('workspace:links:project-references',plain(ids)),
      list:(owner,id)=>ipcRenderer.invoke('workspace:links:list',owner,id),add:(owner,id,target,annotation)=>ipcRenderer.invoke('workspace:links:add',owner,id,target,annotation),
      remove:(owner,id,link)=>ipcRenderer.invoke('workspace:links:remove',owner,id,link),resources:()=>ipcRenderer.invoke('workspace:links:resources'),backlinks:id=>ipcRenderer.invoke('workspace:links:backlinks',id)
    },
    timeline: {
      context:id=>ipcRenderer.invoke('workspace:timeline:context',id),updateContext:(id,patch)=>ipcRenderer.invoke('workspace:timeline:update-context',id,plain(patch)),
      events:id=>ipcRenderer.invoke('workspace:timeline:events',id),save:(id,input)=>ipcRenderer.invoke('workspace:timeline:save',id,plain(input)),
      publish:(id,event)=>ipcRenderer.invoke('workspace:timeline:publish',id,event),dismiss:(id,event)=>ipcRenderer.invoke('workspace:timeline:dismiss',id,event),remove:(id,event)=>ipcRenderer.invoke('workspace:timeline:remove',id,event),
      check:id=>ipcRenderer.invoke('workspace:timeline:check',id),generate:(id,ai)=>ipcRenderer.invoke('workspace:timeline:generate',id,ai),cancel:id=>ipcRenderer.invoke('workspace:timeline:cancel',id),export:id=>ipcRenderer.invoke('workspace:timeline:export',id)
    },
    skills:{list:()=>ipcRenderer.invoke('workspace:skills:list'),proposals:()=>ipcRenderer.invoke('workspace:skills:proposals'),save:draft=>ipcRenderer.invoke('workspace:skills:save',plain(draft)),record:input=>ipcRenderer.invoke('workspace:skills:record',plain(input)),confirm:(id,draft)=>ipcRenderer.invoke('workspace:skills:confirm',id,plain(draft)),cancel:id=>ipcRenderer.invoke('workspace:skills:cancel',id),undoRecord:id=>ipcRenderer.invoke('workspace:skills:undo-record',id)},
    personal:{renew:(id,input)=>ipcRenderer.invoke('workspace:personal:renew',id,plain(input)),snooze:(id,until)=>ipcRenderer.invoke('workspace:personal:snooze',id,until),captureState:(name,unit,value,date,metricId,note)=>ipcRenderer.invoke('workspace:personal:capture-state',name,unit,value,date,metricId,note),chooseAvatar:()=>ipcRenderer.invoke('workspace:personal:choose-avatar'),list:kind=>ipcRenderer.invoke('workspace:personal:list',kind),save:input=>ipcRenderer.invoke('workspace:personal:save',plain(input)),remove:id=>ipcRenderer.invoke('workspace:personal:remove',id),overview:()=>ipcRenderer.invoke('workspace:personal:overview')},
    onChanged:callback=>subscribe('workspace:changed',callback)
  },
  project: {
    launch:{
      profiles:id=>ipcRenderer.invoke('project:launch:profiles',id),save:(id,input)=>ipcRenderer.invoke('project:launch:save',id,plain(input)),remove:(id,profile,revision)=>ipcRenderer.invoke('project:launch:remove',id,profile,revision),revoke:(id,profile)=>ipcRenderer.invoke('project:launch:revoke',id,profile),
      preview:(id,profile)=>ipcRenderer.invoke('project:launch:preview',id,profile),start:(id,profile,approval)=>ipcRenderer.invoke('project:launch:start',id,profile,plain(approval)),runs:id=>ipcRenderer.invoke('project:launch:runs',id),stop:id=>ipcRenderer.invoke('project:launch:stop',id),openPreview:(id,profile,run)=>ipcRenderer.invoke('project:launch:open-preview',id,profile,run),onRun:callback=>subscribe('project:run',callback)
    },
    applications:()=>ipcRenderer.invoke('project:applications'),selectApplication:id=>ipcRenderer.invoke('project:select-application',id),openApplication:(id,application)=>ipcRenderer.invoke('project:open-application',id,application),rules:id=>ipcRenderer.invoke('project:rules',id),
    overview:(id,options)=>ipcRenderer.invoke('project:overview',id,plain(options)),git:(id,options)=>ipcRenderer.invoke('project:git',id,plain(options)),preferences:value=>ipcRenderer.invoke('project:preferences',plain(value)),
    files:(id,relative,options)=>ipcRenderer.invoke('project:files',id,relative,plain(options)),readFile:(id,relative,cursor)=>ipcRenderer.invoke('project:read-file',id,relative,plain(cursor)),
    openFile:(id,relative)=>ipcRenderer.invoke('project:open-file',id,relative),scripts:(id,relative)=>ipcRenderer.invoke('project:scripts',id,relative),openTerminal:(id,relative)=>ipcRenderer.invoke('project:open-terminal',id,relative),
    saveEntry:(id,entry,expected)=>ipcRenderer.invoke('project:save-entry',id,plain(entry),plain(expected)),removeEntry:(id,entryId,expected)=>ipcRenderer.invoke('project:remove-entry',id,entryId,plain(expected)),
    sessions:id=>ipcRenderer.invoke('project:sessions',id),createSession:id=>ipcRenderer.invoke('project:create-session',id),session:id=>ipcRenderer.invoke('project:session',id),
    organize:id=>ipcRenderer.invoke('project:organize',id),resumeOrganize:id=>ipcRenderer.invoke('project:resume-organize',id),undoEvent:(id,event)=>ipcRenderer.invoke('project:undo-event',id,event),undoBatch:(id,session,apply)=>ipcRenderer.invoke('project:undo-batch',id,session,apply),
    selectRepository:(id,relative)=>ipcRenderer.invoke('project:select-repository',id,relative),
    summarize:(id,kind,key)=>ipcRenderer.invoke('project:summarize',id,kind,key),summaries:id=>ipcRenderer.invoke('project:summaries',id),editSummary:(id,summaryId,patch)=>ipcRenderer.invoke('project:edit-summary',id,summaryId,plain(patch)),undoSummary:(id,summaryId)=>ipcRenderer.invoke('project:undo-summary',id,summaryId),
    automation:(id,enabled)=>ipcRenderer.invoke('project:automation',id,enabled),
    sendMessage:(id,text)=>ipcRenderer.invoke('project:send-message',id,text),cancelMessage:id=>ipcRenderer.invoke('project:cancel-message',id),
    applyProposal:(id,message)=>ipcRenderer.invoke('project:apply-proposal',id,message),onSession:callback=>subscribe('project:session',callback),
    list:()=>ipcRenderer.invoke('project:list'),get:id=>ipcRenderer.invoke('project:get',id),
    update:(id,patch)=>ipcRenderer.invoke('project:update',id,plain(patch)),remove:id=>ipcRenderer.invoke('project:remove',id),
    prepareImport:(mode,droppedRoots)=>ipcRenderer.invoke('project:prepare-import',mode,droppedRoots&&plain(droppedRoots)),confirmImport:(token,items)=>ipcRenderer.invoke('project:confirm-import',token,plain(items)),
    rescan:id=>ipcRenderer.invoke('project:rescan',id),pickPath:directory=>ipcRenderer.invoke('project:pick-path',directory),
    addEntry:(id,directory)=>ipcRenderer.invoke('project:add-entry',id,directory),resources:()=>ipcRenderer.invoke('project:resources'),
    open:(id,entry)=>ipcRenderer.invoke('project:open',id,entry),reveal:id=>ipcRenderer.invoke('project:reveal',id),relocate:id=>ipcRenderer.invoke('project:relocate',id),
    prepareMove:id=>ipcRenderer.invoke('project:prepare-move',id),previewMove:(id,destination,keep)=>ipcRenderer.invoke('project:preview-move',id,destination,keep),
    move:token=>ipcRenderer.invoke('project:move',token),moveRecords:()=>ipcRenderer.invoke('project:move-records'),recoverMove:id=>ipcRenderer.invoke('project:recover-move',id),
    onChanged:callback=>subscribe('project:changed',callback)
  },
  comic: {
    defaults:()=>ipcRenderer.invoke('comic:defaults'),browse:(query,proxy)=>ipcRenderer.invoke('comic:browse',plain(query),plain(proxy)),cover:(id,proxy)=>ipcRenderer.invoke('comic:cover',id,plain(proxy)),cancelBrowse:()=>ipcRenderer.invoke('comic:cancel-browse'),
    logs:id=>ipcRenderer.invoke('comic:logs',id),
    preview:(input,proxy)=>ipcRenderer.invoke('comic:preview',input,plain(proxy)),
    cancelPreview:()=>ipcRenderer.invoke('comic:cancel-preview'),
    start:(token,chapters,directory,groupId,root)=>ipcRenderer.invoke('comic:start',token,plain(chapters),directory,groupId,root),
    jobs:()=>ipcRenderer.invoke('comic:jobs'),stop:(id,cancel)=>ipcRenderer.invoke('comic:stop',id,cancel),
    retry:(id,proxy)=>ipcRenderer.invoke('comic:retry',id,plain(proxy)),dismiss:id=>ipcRenderer.invoke('comic:dismiss',id),
    revalidate:(id,token,root)=>ipcRenderer.invoke('comic:revalidate',id,token,root),clean:id=>ipcRenderer.invoke('comic:clean',id)
  },
  image: {
    
    tagCounts: () => ipcRenderer.invoke('image:tag-counts'),
    renameTag: (from, to) => ipcRenderer.invoke('image:rename-tag', from, to),
    collections: () => ipcRenderer.invoke('image:collections'),
    saveCollection: (name,members,id) => ipcRenderer.invoke('image:save-collection',name,plain(members),id),
    removeCollection: id => ipcRenderer.invoke('image:remove-collection',id),
    move: (ids,byCategory,chooseTarget) => ipcRenderer.invoke('image:move',plain(ids),byCategory,chooseTarget),
    gallery: (ids,offset,limit,sort) => ipcRenderer.invoke('image:gallery',plain(ids),offset,limit,sort),
    readerPreferences: (id, value) => ipcRenderer.invoke('image:reader-preferences', id, value === undefined ? undefined : plain(value)),
    bookmarks: id => ipcRenderer.invoke('image:bookmarks', id), saveBookmark: (id, pageId, offset, label) => ipcRenderer.invoke('image:save-bookmark', id, pageId, offset, label),
    removeBookmark: (id, bookmarkId) => ipcRenderer.invoke('image:remove-bookmark', id, bookmarkId),
    pageInfo: id => ipcRenderer.invoke('image:page-info', id), audit: id => ipcRenderer.invoke('image:audit', id), repair: id => ipcRenderer.invoke('image:repair', id),
    checkUpdates: id => ipcRenderer.invoke('image:check-updates', id), downloadUpdates: (id, chapters) => ipcRenderer.invoke('image:download-updates', id, plain(chapters)),
    saveChapter: (id, chapterId, title, move) => ipcRenderer.invoke('image:save-chapter', id, chapterId, title, move),
    list: query => ipcRenderer.invoke('image:list', plain(query)), get: id => ipcRenderer.invoke('image:get', id),
    pages: (id, chapter) => ipcRenderer.invoke('image:pages', id, chapter), update: (id, patch) => ipcRenderer.invoke('image:update', id, plain(patch)),
    bulkUpdate: (ids, patch) => ipcRenderer.invoke('image:bulk-update', plain(ids), plain(patch)),
    remove: (id,deleteFiles) => ipcRenderer.invoke('image:remove', id,deleteFiles), groups: () => ipcRenderer.invoke('image:groups'),
    saveGroup: group => ipcRenderer.invoke('image:save-group', plain(group)), removeGroup: id => ipcRenderer.invoke('image:remove-group', id),
    prepareImport: (type, multiple, archive, droppedPaths) => ipcRenderer.invoke('image:prepare-import', type, multiple, archive, droppedPaths && plain(droppedPaths)),
    confirmImport: (token, selected, folderCategories) => ipcRenderer.invoke('image:confirm-import', token, plain(selected), folderCategories),
    rescan: id => ipcRenderer.invoke('image:rescan', id), relocate: id => ipcRenderer.invoke('image:relocate', id),
    reveal: id => ipcRenderer.invoke('image:reveal', id),
    saveProgress: (id, page, offset) => ipcRenderer.invoke('image:progress', id, page, offset), preferences: value => ipcRenderer.invoke('image:preferences', plain(value)),
    sourceStatus: () => ipcRenderer.invoke('image:source-status'), sourceLogin: (email, password) => ipcRenderer.invoke('image:source-login', email, password),
    sourceLogout: () => ipcRenderer.invoke('image:source-logout'), sourceSearch: (query,page) => ipcRenderer.invoke('image:source-search', query,page),
    sourceFavorites: (page,sort) => ipcRenderer.invoke('image:source-favorites',page,sort),
    sourceRanking: period => ipcRenderer.invoke('image:source-ranking',period), sourceCover: url => ipcRenderer.invoke('image:source-cover',url),
    downloadTarget:(provider,id,group)=>ipcRenderer.invoke('image:download-target',provider,id,group),chooseDownloadRoot:(provider,current)=>ipcRenderer.invoke('image:choose-download-root',provider,current),
    sourceDetail: id => ipcRenderer.invoke('image:source-detail', id), download: (work,chapters,group,root) => ipcRenderer.invoke('image:download', work,plain(chapters),group,root),
    sourceOwned: ids => ipcRenderer.invoke('image:source-owned', plain(ids)),
    downloadBatch: (ids,group,root) => ipcRenderer.invoke('image:download-batch',plain(ids),group,root),
    jobs: () => ipcRenderer.invoke('image:jobs'), jobLogs: id => ipcRenderer.invoke('image:job-logs',id), retryJob: id => ipcRenderer.invoke('image:retry-job',id), cancelJob: id => ipcRenderer.invoke('image:cancel-job',id),
    dismissJob: id => ipcRenderer.invoke('image:dismiss-job',id), onChanged: callback => subscribe('image:changed',callback),
    onJobsChanged: callback => subscribe('image:jobs-changed',callback),
    pauseJob: id => ipcRenderer.invoke('image:pause-job',id), resumeJob: id => ipcRenderer.invoke('image:resume-job',id),
    moveJob: (id,direction) => ipcRenderer.invoke('image:move-job',id,direction),
    downloadOptions: value => ipcRenderer.invoke('image:download-options',plain(value))
  },
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
    copyText: (text: string) => ipcRenderer.invoke('app:copy', String(text)),
    openUrl: (url: string) => ipcRenderer.invoke('app:open-url', url),
    pathForFile: (file: File) => {
      try {
        const p = webUtils?.getPathForFile(file)
        if (p) return p
      } catch {
        /* best-effort */
      }
      return (file as File & { path?: string })?.path ?? ''
    },
    statPaths: (paths: string[]) => ipcRenderer.invoke('app:stat-paths', plain(paths)),
    globalSearch: (query?: string, kinds?: string[], limit?: number) =>
      ipcRenderer.invoke('app:global-search', query, kinds && plain(kinds), limit)
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    onMaximizeChange: (cb) => subscribe('win:maximize-change', cb),
    onNavigate: (cb) => subscribe('win:navigate', cb)
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
    addManual: (files?: string[]) => ipcRenderer.invoke('software:add-manual', files && plain(files)),
    pickIcon: (id: string) => ipcRenderer.invoke('software:pick-icon', id),
    clearIcon: (id: string) => ipcRenderer.invoke('software:clear-icon', id),
    refreshIcons: () => ipcRenderer.invoke('software:refresh-icons'),
    relocate: (id: string, mode: 'directory' | 'file' = 'directory') =>
      ipcRenderer.invoke('software:relocate', id, mode),
    pickLauncher: (id: string) => ipcRenderer.invoke('software:pick-launcher', id)
  },
  game: {
    pickBackground:id=>ipcRenderer.invoke('game:background:pick',id),clearBackground:id=>ipcRenderer.invoke('game:background:clear',id),
    notes:{list:id=>ipcRenderer.invoke('game:notes:list',id),save:(id,input)=>ipcRenderer.invoke('game:notes:save',id,plain(input)),remove:(id,note,stamp)=>ipcRenderer.invoke('game:notes:remove',id,note,stamp),export:(id,note)=>ipcRenderer.invoke('game:notes:export',id,note)},
    patchLink:(id,target,patch,expected)=>ipcRenderer.invoke('game:link:patch',id,target,plain(patch),expected),
    previewLink:(id,target)=>ipcRenderer.invoke('game:link:preview',id,target),
    defaultEntry:(id,target)=>ipcRenderer.invoke('game:default-entry',id,target),
    previewProjects: () => ipcRenderer.invoke('game:preview-projects'),
    checkProjects: () => ipcRenderer.invoke('game:check-projects'),
    importProjects: (token, selected, artwork = {}) => ipcRenderer.invoke('game:import-projects', token, plain(selected), plain(artwork)),
    restoreProjectArtwork: () => ipcRenderer.invoke('game:restore-project-artwork'),
    linkStates: (id) => ipcRenderer.invoke('game:link-states', id),
    readLink: (id, target) => ipcRenderer.invoke('game:read-link', id, target),
    relocate: (id: string, mode: 'directory' | 'file' = 'directory') => ipcRenderer.invoke('game:relocate', id, mode),
    addManual: (filePath?: string) => ipcRenderer.invoke('game:add-manual', filePath),
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
    launch: (id,options) => ipcRenderer.invoke('game:launch', id,plain(options)),
    running: (id: string) => ipcRenderer.invoke('game:running', id),
    onSession: (cb) => subscribe('game:session', cb),
    previewBackup: (id:string,target:string)=>ipcRenderer.invoke('game:preview-backup',id,target),
    backupSave: (id: string, savePath: string, note?: string) =>
      ipcRenderer.invoke('game:backup-save', id, savePath, note),

    backups: (id: string) => ipcRenderer.invoke('game:backups', id),
    orphanBackups: () => ipcRenderer.invoke('game:orphan-backups'),
    rebindBackup: (backupId: string, gameId: string) => ipcRenderer.invoke('game:rebind-backup', backupId, gameId),
    previewRestore: (id: string, target?: string) => ipcRenderer.invoke('game:preview-restore',id,target),
    restoreBackup: (id: string, target?: string, expected?: string) => ipcRenderer.invoke('game:restore-backup',id,target,expected),
    deleteBackup: (backupId: string) => ipcRenderer.invoke('game:delete-backup', backupId),
    openBackup: (backupId: string) => ipcRenderer.invoke('game:open-backup', backupId),
    pickLinks: (id, kind, type) =>
      ipcRenderer.invoke('game:pick-links', id, kind, type),
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
  music: {search:(source,query,page)=>ipcRenderer.invoke('music:search',source,query,page),preview:key=>ipcRenderer.invoke('music:preview',key),directory:()=>ipcRenderer.invoke('music:directory'),pickDirectory:()=>ipcRenderer.invoke('music:pick-directory'),download:key=>ipcRenderer.invoke('music:download',key),jobs:()=>ipcRenderer.invoke('music:jobs'),cancel:id=>ipcRenderer.invoke('music:cancel',id),retry:id=>ipcRenderer.invoke('music:retry',id),onChanged:cb=>subscribe('music:changed',cb)},
  video: {
    preview:{frames:(token,retry)=>ipcRenderer.invoke('video-preview:frames',token,retry),releaseFrames:id=>ipcRenderer.invoke('video-preview:release-frames',id),onFrames:callback=>subscribe('video-preview:frames',callback),frameCache:()=>ipcRenderer.invoke('video-preview:frame-cache'),clearFrames:()=>ipcRenderer.invoke('video-preview:clear-frames'),onClosed:callback=>subscribe('video-preview:closed',callback),choices:(id,episodeId)=>ipcRenderer.invoke('video-preview:choices',id,episodeId),open:(id,key)=>ipcRenderer.invoke('video-preview:open',id,key),release:token=>ipcRenderer.invoke('video-preview:release',token),external:(token,custom)=>ipcRenderer.invoke('video-preview:external',token,custom),pickPlayer:()=>ipcRenderer.invoke('video-preview:pick-player'),copyPath:token=>ipcRenderer.invoke('video-preview:copy',token),reveal:token=>ipcRenderer.invoke('video-preview:reveal',token)},
    taxonomy: hentai => ipcRenderer.invoke('video:taxonomy', hentai),
    editTaxonomy: edit => ipcRenderer.invoke('video:edit-taxonomy', plain(edit)),
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
    useEpisodeArtwork: (id, episodeId, role) => ipcRenderer.invoke('video:use-episode-artwork', id, episodeId, role),
    renumberEpisodes: (id, changes) => ipcRenderer.invoke('video:renumber-episodes', id, plain(changes)),
    previewRemoval: (request) => ipcRenderer.invoke('video:removal-preview', plain(request)),
    applyRemoval: (preview) => ipcRenderer.invoke('video:removal-apply', plain(preview)),
    bulkUpdate: (ids, patch) => ipcRenderer.invoke('video:bulk-update', plain(ids), plain(patch)),
    importBundle: () => ipcRenderer.invoke('video:import-bundle'),
    library: (id: string) => ipcRenderer.invoke('video:library', id),
    audioLyrics: (id: string, episode?: string) => ipcRenderer.invoke('video:audio-lyrics', id, episode),
    audioInfo: (id: string, episode?: string) => ipcRenderer.invoke('video:audio-info', id, episode),
    syncFiles: (id: string) => ipcRenderer.invoke('video:sync-files', id),
    previewCollectionName: (id: string, title: string) => ipcRenderer.invoke('video:preview-collection-name', id, title),
    renameCollection: (id: string, title: string) => ipcRenderer.invoke('video:rename-collection', id, title),
    playAsset: (id: string) => ipcRenderer.invoke('video:play-asset', id),
    revealAsset: (id: string) => ipcRenderer.invoke('video:reveal-asset', id),
    relocateAsset: (id: string) => ipcRenderer.invoke('video:relocate-asset', id),
    setDefaultAsset: (episodeId: string, assetId: string) => ipcRenderer.invoke('video:default-asset', episodeId, assetId),
    discovery: {
      online: {
        networkStatus: url => ipcRenderer.invoke('video-discovery:online-network-status', url),
        probe: url => ipcRenderer.invoke('video-discovery:online-network-probe', url),
        connect: url => ipcRenderer.invoke('video-discovery:online-connect', url),
        refresh: id => ipcRenderer.invoke('video-discovery:online-refresh', id),
        next: id => ipcRenderer.invoke('video-discovery:online-next', id),
        detail: selection => ipcRenderer.invoke('video-discovery:online-detail', plain(selection))
      },
      web: {
        list: () => ipcRenderer.invoke('web-browser:list'),
        save: input => ipcRenderer.invoke('web-browser:save', plain(input)),
        remove: id => ipcRenderer.invoke('web-browser:remove', id),
        open: url => ipcRenderer.invoke('web-browser:open', url),
        onEdit: cb => subscribe('web-browser:edit-address', cb)
      },
      sources: () => ipcRenderer.invoke('video-discovery:sources'),
      entries: id => ipcRenderer.invoke('video-discovery:entries', id),
      artwork: selection => ipcRenderer.invoke('video-discovery:artwork', plain(selection)),
      importSource: () => ipcRenderer.invoke('video-discovery:import'),
      exportSource: id => ipcRenderer.invoke('video-discovery:export', id),
      removeSource: id => ipcRenderer.invoke('video-discovery:remove', id),
      mark: (selection, patch) => ipcRenderer.invoke('video-discovery:mark', plain(selection), plain(patch)),
      open: (sourceId, entryId, mode) => ipcRenderer.invoke('video-discovery:open', sourceId, entryId, mode),
      playExternal: (selection, siteId) => ipcRenderer.invoke('video-discovery:external-play', plain(selection), siteId),
      onDownload: cb => subscribe('video-discovery:download', cb)
    },
    prepareDownload: (input) => ipcRenderer.invoke('video-workflow:prepare', plain(input)),
    checkLibraryUpdates: (ids, startup) => ipcRenderer.invoke('video-updates:start', ids ? plain(ids) : undefined, startup),
    updateCheckStatus: () => ipcRenderer.invoke('video-updates:status'),
    cancelUpdateCheck: () => ipcRenderer.invoke('video-updates:cancel'),
    onUpdateCheck: cb => subscribe('video-updates:changed', cb),
    pickDownloadRoot: (draftId: string) => ipcRenderer.invoke('video-workflow:pick-root', draftId),
    enqueueDownload: (request) => ipcRenderer.invoke('video-workflow:enqueue', plain(request)),
    downloadJobs: () => ipcRenderer.invoke('video-workflow:list'),
    downloadCaches: () => ipcRenderer.invoke('video-workflow:caches'),
    clearDownloadCache: id => ipcRenderer.invoke('video-workflow:clear-cache', id),
    retryDownloadJob: (id, stage) => ipcRenderer.invoke('video-workflow:retry', id, stage),
    cancelDownloadJob: (id) => ipcRenderer.invoke('video-workflow:cancel', id),
    dismissDownloadJob: (id) => ipcRenderer.invoke('video-workflow:dismiss', id),
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
    pickDirectory: () => ipcRenderer.invoke('video-organize:pick-directory'),
    layoutPreview: ids => ipcRenderer.invoke('video-organize:layout-preview', plain(ids)),
    layoutApply: ids => ipcRenderer.invoke('video-organize:layout-apply', plain(ids))
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
    clearSkipped: () => ipcRenderer.invoke('pending:clear-skipped'),
    listSkipped: () => ipcRenderer.invoke('pending:skipped-list'),
    removeSkipped: (exePath: string) => ipcRenderer.invoke('pending:remove-skipped', exePath)
  },
  settings: {
    detectFfmpeg: () => ipcRenderer.invoke('settings:ffmpeg-detect'),
    pickFfmpeg: () => ipcRenderer.invoke('settings:ffmpeg-pick'),
    getAll: () => ipcRenderer.invoke('settings:get'),
    patch: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:patch', plain(patch)),
    proxyStatus: (url?: string) => ipcRenderer.invoke('settings:proxy-status', url),
    hanimeVerify: (url?: string) => ipcRenderer.invoke('settings:hanime-verify', url)
  },
  scan: {
    pickDirectory: () => ipcRenderer.invoke('scan:pick-dir'),
    run: (dirs: string[], directDirs?: boolean) => ipcRenderer.invoke('scan:run', plain(dirs), directDirs),
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
    snapshotInfo: () => ipcRenderer.invoke('data:snapshot-info'),
    createSnapshot: () => ipcRenderer.invoke('data:create-snapshot'),
    openSnapshotDir: () => ipcRenderer.invoke('data:open-snapshot-dir'),
    archiveSnapshots: () => ipcRenderer.invoke('data:archive-snapshots'),
    exportSnapshot: (id: string) => ipcRenderer.invoke('data:export-snapshot', id),
    storageUsage: () => ipcRenderer.invoke('data:storage-usage'),
    clearBrowserCache: () => ipcRenderer.invoke('data:clear-browser-cache'),
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
    unlink: (id: string) => ipcRenderer.invoke('organize:unlink', id),
    organized: (ids?: string[]) => ipcRenderer.invoke('organize:organized', plain(ids)),
    sync: () => ipcRenderer.invoke('organize:sync'),
    previewRelocate: (id, category, folder) => ipcRenderer.invoke('organize:preview-relocate', id, category, folder),
    relocate: (id: string, category: string, folder: string, expectedFrom?: string) =>
      ipcRenderer.invoke('organize:relocate', id, category, folder, expectedFrom),
    removeLinks: (paths: string[]) => ipcRenderer.invoke('organize:remove-links', plain(paths))
  }
}

contextBridge.exposeInMainWorld('baoyi', api)
