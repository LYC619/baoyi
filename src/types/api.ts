import type { TmdbConfig, VideoQuery, VideoItem, VideoCounts, VideoPlayOutcome, VideoScanResult, VideoScanProgress, Episode } from './video'
import type { SoftwareQuery, SoftwareItem, SidebarCounts, Category, Tag, PendingItem, SkippedItem, ConfirmResult, ScanResult, ScanProgress, ScanUnit } from './software'
import type { RemoveSoftwareResult, OrganizePreview, OrganizeCommand, OrganizeResult, OrganizeProgress, OrganizePlan, UndoResult, OrganizedList, OrganizeSyncReport, RelocatePreview, RelocateResult } from './organize'
import type { GameItem, LinkedFile, GameQuery, GameCounts, GameScanResult, GameScanProgress, SavePathCheck, SavePathAlert, GameSessionEvent, SaveBackupResult, SaveBackup, SaveRestoreResult, SaveRestorePreview, GameCoverSearchResult } from './game'
import type { VideoDownloadCatalog, VideoDownloadRequest, VideoDownloadResult, VideoSeriesCatalog, VideoSeriesDownloadRequest, VideoSeriesDownloadResult, VideoDownloadProgress, VideoSeriesDownloadProgress } from './video-download'
import type { AIResult, AIProgress, IdentifyLogQuery, IdentifyLog, IdentifyReport } from './identify'

export interface AIConfig {
  api_url: string
  api_key: string
  model: string
  enabled: boolean
}

/**
 * 一套存起来的接口配置。
 *
 * 刻意让它「是」一份 AIConfig 而不是包一层 config 字段：切换就是把它铺回
 * settings.ai，主进程那边（aiService、agent/loop）读的还是 settings.ai，
 * 一行都不用改。enabled 跟着一起存 —— 关掉 AI 是针对当前这套配置的意思。
 */
export interface AIProfile extends AIConfig {
  id: string
  name: string
}

export type SearchProvider =
  | 'model_builtin'
  | 'exa'
  | 'tavily'
  | 'firecrawl'
  | 'bing'
  | 'searxng'

export interface SearchConfig {
  provider: SearchProvider
  api_key: string
  /** SearXNG 自建实例地址；其余服务商留空 */
  endpoint: string
  enabled: boolean
}

/** 卡片标题用哪个名字打头，另一个降为副标题 */
export type TitleLang = 'zh' | 'en'

export interface AppSettings {
  music_download_root?: string
  video_updates_weekly?: boolean
  video_updates_last_checked?: number
  ffmpeg_path?: string
  video_player_path?: string
  video_download_concurrency?: number
  video_download_connections?: number
  /** 当前生效的那份配置。切换配置就是把某个 profile 铺到这里 */
  ai: AIConfig
  ai_profiles: AIProfile[]
  /** 当前选中的 profile。空串表示「临时配置」——改了还没存成一套 */
  ai_profile_id: string
  search: SearchConfig
  /**
   * 影视刮削配置。和 search 分开而不是复用它 —— TMDB 是一个结构化的
   * 影视数据库，不是搜索引擎：它回的是带 id 的条目和季集表，
   * 而搜索引擎回的是网页。两者在识别链路上做的是不同的事。
   */
  tmdb: TmdbConfig
  /**
   * 软件模块的扫描目录。0.8 从 scan_dirs 拆分出来，各模块独立管理。
   */
  software_scan_dirs: string[]
  /**
   * 游戏模块的扫描目录。
   */
  game_scan_dirs: string[]
  /**
   * 影视模块的扫描目录。
   */
  video_scan_dirs: string[]
  video_download_root: string
  video_download_quality: string
  video_download_strict_quality: boolean
  video_download_register: boolean
  /**
   * 自动整理的目标根目录。和扫描目录刻意分开 —— 扫描是「去哪里找」，
   * 这里是「归到哪里去」，把整理目标也加进扫描列表只会让下一轮重扫再发现一遍。
   */
  organize_root: string
  /**
   * 存档备份放哪儿。空串表示还没设过，主进程退回 `<用户数据>\save-backups`。
   *
   * 不直接把默认值写死在这里：默认值要拼 app.getPath('userData')，那是主进程
   * 才有的东西，而这个类型渲染进程也在用。空串 = 「用默认」是两边都读得懂的约定。
   * 之所以还留一个设置项 —— RPG Maker 带截图的存档、模拟器的即时存档都能到几个 GB，
   * 而用户数据目录在 C 盘。
   */
  save_backup_root: string
  /**
   * 每条存档路径最多留几份备份。0 = 不限。
   *
   * 超出上限时**不自动删**，只在备份完之后告诉用户「有 N 份超出了，要删吗」。
   * 自动删等于替用户决定扔掉哪几份存档，而这个模块存在的全部理由就是别让存档丢。
   * 上限按 (游戏, 存档路径) 一组算，不按游戏整体算 —— 否则备份得勤的那条路径
   * 会把另一条挤掉。
   */
  save_backup_keep: number
  /**
   * 出站代理。空串 = 直连。
   *
   * 空串为直连，`system://` 使用系统代理；形如 `socks5://127.0.0.1:10808` 或
   * `http://127.0.0.1:8080` 时使用内置代理。不写协议时按 Chromium 的规矩当 HTTP
   * 代理。它喂给 `session.setProxy` 的 `proxyRules`，
   * 所以 Chromium 那套写法（`socks5://h:p`、多规则用分号隔开）都认。
   *
   * **只有走 Chromium 网络栈的请求受它管。** 主进程里 `globalThis.fetch` 是
   * Node 的 undici，不看 session 的代理设置，也不看 `--proxy-server` ——
   * Hanime 取页统一走专用 Chromium session.fetch（见 `hentai/hanime.ts` 的注入点），
   * 这样直连时也能吃启动阶段的内置 Hosts 规则；代理不会影响 TMDB、豆瓣等其他来源。
   * 这一条是坑：配了代理却没生效，看起来像代理设置没保存。
   *
   * 目前只有 hanime 那条链路用它。TMDB / 豆瓣走的还是 undici，
   * 它们本来也不在需要代理的名单上（真要加，照 hanime 那个注入点做）。
   */
  proxy: string
  /** 找视频独立代理；旧配置缺省时沿用系统代理。 */
  video_online_proxy?: string
  /**
   * Hanime 内置 Hosts：把几个镜像域名固定到 Cloudflare 地址池，绕开被污染的系统 DNS。
   * 关掉后走系统 DNS。Chromium 那层的规则在启动前注入，改动要重启才生效；
   * 取页层的换 IP 回退即时生效。地址池见 `electron/services/hanime-network-rules.ts`。
   */
  hanime_builtin_hosts: boolean
  /**
   * 运行时回退最近一次通了的 Cloudflare 地址。空串 = 还没回退过，启动用地址池第一个。
   * 由主进程在回退成功时写入，下次启动的 Chromium 解析规则直接用它；不在地址池里就忽略。
   */
  hanime_hosts_active_ip: string
  /**
   * 隐藏里番：侧栏不出现那一格，海报墙不铺那些条目。
   *
   * 纯设置项，**不动库版本号** —— 它不改任何一行数据，只是查询时多一个
   * `category != '里番'`。关掉开关，东西原样都在。
   *
   * **它藏的是「浏览时看不见」，不是「访问不到」。** 明确说清楚边界，
   * 免得当成加密或权限用：
   *
   * - 藏住的：侧栏那一格、海报墙（含关键词搜索，同一条查询路径）、
   *   侧栏的观看状态 / 类型 / 标签 / 归档四处计数。
   * - **没藏住的**：设置页里「影视条目」那个总数、已经存在的详情页地址
   *   （手上有 id 直接开还是打得开）、磁盘上的文件和海报。
   *
   * 后一组要不要一起藏是另一个决定（会牵动统计面板和 `getVideo`），
   * 这一版按用户要求只做侧栏和墙。
   */
  hide_hentai: boolean
  video_import_agent?: boolean
  video_organize_root?: string
  theme: 'dark' | 'light'
  /** Interface language; independent from resource title preference. */
  language: 'system' | 'zh-CN' | 'en'
  view_mode: 'grid' | 'list'
  /** 影视海报墙一格的最小宽度（像素）。缺省 150，和游戏封面墙同尺寸；用户在影视库工具栏拖滑块改 */
  video_card_size?: number
  /**
   * 卡片墙按分类分区块展示。和 view_mode 是两个维度 —— 分组之后每个区块内部
   * 照样可以是网格或列表，所以不做成 view_mode 的第三个值。
   */
  group_by_category: boolean
  unused_days: number
  title_lang: TitleLang
  onboarded: boolean
}

/** 运行期全局任务的类别。任务中心只保存当前进程内的状态，不落库。 */
export type TaskKind =
  | 'software-scan'
  | 'game-scan'
  | 'video-scan'
  | 'ai-identify'
  | 'organize'
  | 'hanime-verify'
  | 'video-download'
  | 'audio-download'
  | 'video-series-download'

export type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted'

export type TaskEventLevel = 'info' | 'success' | 'warn' | 'error'

export interface TaskEvent {
  at: number
  level: TaskEventLevel
  message: string
}

export interface TaskRecord {
  id: string
  kind: TaskKind
  title: string
  status: TaskStatus
  startedAt: number
  finishedAt?: number
  processed: number
  total: number
  percent: number
  current: string
  message: string
  error?: string
  events: TaskEvent[]
}

export interface TaskStartOptions {
  processed?: number
  total?: number
  current?: string
  message?: string
}

export interface TaskUpdate {
  processed?: number
  total?: number
  percent?: number
  current?: string
  message?: string
}

/** 清空数据后回报清掉了些什么 */
export interface ResetSummary {
  projects: number
  software: number
  games: number
  videos: number
  /** 跟着影视条目一起清掉的集数。一部剧只是一行，但用户感觉上没的是几十集 */
  episodes: number
  units: number
  icons: number
  covers: number
  posters: number
  /**
   * 保留下来的存档备份记录数 —— 这一项是「没清掉多少」而不是「清掉多少」。
   * 磁盘上那些备份文件一个都没动，记录留着才找得到它们。
   */
  saveBackupsKept: number
  settingsCleared: boolean
}

/** 设置页「数据管理」上展示的用量 */
export interface DataStats {
  software: number
  games: number
  videos: number
  /** 季集表的总行数，含缺文件的那些。它比影视条目数更能说明库有多大 */
  episodes: number
  units: number
  logs: number
  /** 数据库占用字节数，含还没落盘的 WAL */
  dbBytes: number
  icons: number
  iconBytes: number
  /** 封面和图标分开报：存留策略不同，但都占磁盘 */
  covers: number
  coverBytes: number
  /** 影视海报又是一栏。多数是刮削来的，占的空间比封面容易涨 */
  posters: number
  posterBytes: number
}

/** 「关于」页展示的版本与构建信息 */
export interface AppInfo {
  /** 来自 package.json，打包后取自安装包元数据 */
  version: string
  electron: string
  chrome: string
  node: string
  /** Actual profile, including portable and explicit test profiles. */
  dataDirectory?: string
  /**
   * 这次是不是绿色版（数据在 exe 旁边的 `data\` 里，不在 AppData）。
   * 开发时恒为 false —— 判据要求 `app.isPackaged`
   */
  portable: boolean
}

export type Unsubscribe = () => void

/** preload 暴露给渲染进程的完整 API */
export interface BaoyiApi {
  music: import('./music').MusicApi
  project: import('./project').ProjectApi
  workspace: import('./workspace').WorkspaceApi
  archive: import('./archive').ArchiveApi
  image: import('./image').ImageApi
  comic: import('./comic-ingest').ComicIngestApi
  hanimeBrowser: {
    open(url?: string): Promise<boolean>
    onDownload(cb: (url: string) => void): Unsubscribe
  }
  app: {
    /** 版本与构建信息，「关于」页用 */
    info(): Promise<AppInfo>
    /**
     * 写剪贴板。走主进程的 clipboard 而不是 navigator.clipboard ——
     * 后者在打包后的 file:// 页面里要看权限处理器的脸色，而这个一定成。
     */
    copyText(text: string): Promise<void>
    openUrl(url: string): Promise<void>
    pathForFile(file: File): string
    statPaths(paths: string[]): Promise<Array<{ path: string; kind: 'file' | 'directory' | 'symlink' | 'missing' }>>
    globalSearch(query?: string, kinds?: string[], limit?: number): Promise<import('./archive').ArchiveSource[]>
  }
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximizeChange(cb: (maximized: boolean) => void): Unsubscribe
    onNavigate(cb: (direction: 'back' | 'forward') => void): Unsubscribe
  }
  software: {
    list(query?: SoftwareQuery): Promise<SoftwareItem[]>
    get(id: string): Promise<SoftwareItem | null>
    update(id: string, patch: Partial<SoftwareItem>): Promise<SoftwareItem | null>
    /** 删记录。条目是整理目录里的链接时，链接一并删掉；真实文件不动 */
    remove(id: string): Promise<RemoveSoftwareResult>
    counts(unusedDays: number): Promise<SidebarCounts>
    /** launcherPath 为空时启动默认启动端 */
    launch(id: string, launcherPath?: string): Promise<boolean>
    revealInFolder(id: string, launcherPath?: string): Promise<void>
    addManual(files?: string[]): Promise<SoftwareItem[]>
    /** 用户取消对话框时返回 null，和 game.pickCover 一个约定 */
    pickIcon(
      id: string
    ): Promise<{ ok: boolean; message: string; item: SoftwareItem | null } | null>
    /** 撤掉手动图标，退回自动提取的那张（提不到才落到首字占位） */
    clearIcon(id: string): Promise<SoftwareItem | null>
    /**
     * 把全库的自动图标重提一遍。手改过的（`isManualIcon`）一律不动。
     *
     * 存在的理由是「修好提取逻辑对已入库的条目没效果」：`extractIcon` 只在识别时
     * 被调，老条目不会自己重来，于是修好的版本装上去看起来和没修一样。
     */
    refreshIcons(): Promise<{ total: number; changed: number; manual: number; failed: number }>
    relocate(id: string, mode?: 'directory' | 'file'): Promise<SoftwareItem | null>
    pickLauncher(id: string): Promise<SoftwareItem | null>
  }
  game: {
    pickBackground(id:string):Promise<GameItem|null>
    clearBackground(id:string):Promise<GameItem|null>
    notes:{list(id:string):Promise<import('./game-workspace').GameNote[]>;save(id:string,input:import('./game-workspace').GameNoteInput):Promise<import('./game-workspace').GameNote>;remove(id:string,note:string,expected:number):Promise<void>;export(id:string,note:string):Promise<boolean>}
    patchLink(id:string,target:string,patch:Partial<LinkedFile>|null,expected:string):Promise<GameItem|null>
    previewLink(id:string,target:string):Promise<import('./game-workspace').GamePreview>
    defaultEntry(id:string,target:string):Promise<GameItem|null>
    checkProjects(): Promise<import('./game-project').GameProjectCheck[]>
    previewProjects(): Promise<import('./game-project').GameProjectPreview | null>
    importProjects(token: string, selected: string[], artwork?: import('./game-project').GameArtworkChoices): Promise<import('./game-project').GameProjectImportResult>
    restoreProjectArtwork(): Promise<number>
    linkStates(id: string): Promise<import('./game-project').GameLinkState[]>
    readLink(id: string, target: string): Promise<import('./game-project').GameLinkText>
    relocate(id: string, mode?: 'directory' | 'file'): Promise<GameItem | null>
    addManual(filePath?: string): Promise<{ ok: boolean; message: string; item?: GameItem } | null>
    list(query?: GameQuery): Promise<GameItem[]>
    get(id: string): Promise<GameItem | null>
    update(id: string, patch: Partial<GameItem>): Promise<GameItem | null>
    /** 只从库里移除，不动磁盘上的游戏文件，也不删已有的存档备份 */
    remove(id: string): Promise<void>
    counts(): Promise<GameCounts>
    /** 在资源管理器里选中主程序 */
    revealInFolder(id: string): Promise<boolean | void>
    /** 选游戏目录，可多选。取消返回空数组 */
    pickDirectories(): Promise<string[]>
    /** 扫描 + 识别一条龙，结果直接落库（游戏不走确认面板） */
    scan(dirs: string[]): Promise<GameScanResult>
    cancel(): void
    onProgress(cb: (p: GameScanProgress) => void): Unsubscribe

    /**
     * 选一个存档目录并当场探测。取消返回 null。
     *
     * 只探测、不写库 —— 目录是空的时候界面要先问一句，问完了再走 update() 存。
     */
    pickSavePath(): Promise<SavePathCheck | null>
    /**
     * 重新验一条已记下的存档路径。验过了就把这条路径的 verified_at 往前推，
     * 所以要带上游戏 id。空目录不算验过 —— 备份那一层也拒绝空目录。
     */
    verifySavePath(id: string, path: string): Promise<SavePathCheck>
    /**
     * 扫一遍所有已记下的存档路径，返回当下找不到的那些。开库时调一次。
     *
     * 只读，不写库：外置硬盘没插上是一时的，不该被固化成一条永久记录。
     * 返回空数组表示每条路径都在。
     */
    checkSavePaths(): Promise<SavePathAlert[]>

    /**
     * 启动游戏，并从这一刻开始算时长。
     *
     * ok 只说明「起来了」，不说明时长跟得到 —— 走系统 shell 兜底的那条路跟不到，
     * message 里会说清楚。
     */
    launch(id: string,options?:import('./game-workspace').GameLaunchOptions): Promise<{ ok: boolean; message: string }>
    /** 这个游戏此刻是不是正被抱一跟着。跟不到的（shell 兜底启动的）一律返回 false */
    running(id: string): Promise<boolean>
    /**
     * 一段游玩结束时的通知。退出时刻由游戏进程决定，界面等不出来，只能推。
     * 条目在游玩过程中被删掉时不会有这条通知。
     */
    onSession(cb: (e: GameSessionEvent) => void): Unsubscribe

    /** 备份一条存档路径。失败时磁盘上不留半成品，也不写记录 */
    previewBackup(id:string,target:string):Promise<{path:string;files:number;bytes:number}>
    backupSave(id: string, savePath: string, note?: string): Promise<SaveBackupResult>
    /** 一个游戏的备份，新的在前 */
    backups(id: string): Promise<SaveBackup[]>
    /** 还原一份备份。会先把当前存档自动备份一份 */
    previewRestore(backupId: string,target?: string): Promise<SaveRestorePreview>
    restoreBackup(backupId: string,target?: string,expected?: string): Promise<SaveRestoreResult>
    /** 删一份备份：磁盘上的拷贝和库里的记录一起删 */
    deleteBackup(backupId: string): Promise<{ ok: boolean; message: string }>
    /** 在资源管理器里打开一份备份 */
    openBackup(backupId: string): Promise<void>

    /**
     * 选文件（或目录）挂成关联文件，选完直接落库，返回更新后的条目。
     * 取消返回 null。已经加过的那些会被跳过，不报错。
     */
    pickLinks(id: string, kind: 'file' | 'dir', type?: LinkedFile['type']): Promise<GameItem | null>
    /**
     * 打开一条关联文件 / 在资源管理器里选中它。
     *
     * 路径必须已经在这个游戏的关联名单里，否则拒绝 —— 这两个口子能打开任意
     * 本地文件，来路是必须核对的。
     */
    openLink(id: string, target: string): Promise<{ ok: boolean; message: string }>
    revealLink(id: string, target: string): Promise<{ ok: boolean; message: string }>

    /**
     * 选一张图当封面。图会被拷进用户数据目录，之后原图挪走或删掉都不影响显示。
     * 取消返回 null；格式不认或拷贝失败时 ok 为 false。
     */
    pickCover(id: string): Promise<{ ok: boolean; message: string; item: GameItem | null } | null>
    /** 撤掉封面，退回首字占位。磁盘上那份拷贝一起删 */
    clearCover(id: string): Promise<GameItem | null>
    /**
     * 联网搜候选封面（英文名优先）。主源是 Steam（不要 key），配了 Bing/SearXNG
     * 图搜的话再补一轮。搜不到时 ok 为 false 且 message 说清原因，不静默返回空。
     */
    searchCovers(id: string): Promise<GameCoverSearchResult>
    /** 下载某个候选封面并设成封面。走的是和手动选图同一套存储逻辑 */
    setCoverFromUrl(
      id: string,
      url: string
    ): Promise<{ ok: boolean; message: string; item: GameItem | null }>
    rebuildCovers(ids?: string[]): Promise<{ processed: number; updated: number; failed: number }>
    onCoverProgress(cb: (progress: { processed: number; total: number; current: string; message: string }) => void): () => void
  }
  video: {
    preview:import('./video-preview').VideoPreviewApi
    list(query?: VideoQuery): Promise<VideoItem[]>
    get(id: string): Promise<VideoItem | null>
    update(id: string, patch: Partial<VideoItem>): Promise<VideoItem | null>
    /**
     * 撤掉几个字段的「用户改过」标记，让它们下次重扫时重新跟着刮削走。
     * 传空数组或不传 = 全撤。
     *
     * **不改现在的值** —— 刮削原来那个值没存第二份。所以界面文案要说
     * 「以后听刮削的」，不能说「恢复成刮削值」：后者会让用户以为点完就变，
     * 而实际要等下一次重扫。
     */
    restoreScraped(id: string, fields?: string[]): Promise<VideoItem | null>
    /** 只从库里移除，不动磁盘上的视频文件 */
    remove(id: string): Promise<void>
    counts(): Promise<VideoCounts>
    /** 剧集选中目录，电影选中文件 */
    revealInFolder(id: string): Promise<boolean | void>
    /**
     * 在资源管理器里选中一个外挂字幕文件。
     *
     * 只认这个条目名下的字幕路径，别的路径一律返回 false —— 这个通道从
     * 渲染进程过来，而底下那个 `showItemInFolder` 能打开任何位置。
     */
    revealSubtitle(id: string, target: string): Promise<boolean>
    /**
     * 交给系统默认播放器。电影开本体，剧集开「该接着看的那一集」。
     *
     * `ok` 为 false 时 `message` 一定有内容，**必须显示出来** ——
     * 播放失败最容易被用户当成「点了没反应」。成功时 `item` / `episode`
     * 带着新状态回来（未看 → 在看），界面不用再查一趟。
     *
     * 拿不到播放进度：外部播放器不回报任何东西。这是 v0.7 明确的取舍，
     * 见 `v0.7-进度.md`，不是没做完。
     */
    play(id: string): Promise<VideoPlayOutcome>
    /** 同上，指定某一集 */
    playEpisode(episodeId: string): Promise<VideoPlayOutcome>
    /** 选影视目录，可多选。取消返回空数组 */
    pickDirectories(): Promise<string[]>
    /**
     * 扫描 + 识别一条龙，结果直接落库。
     *
     * 调之前该先问一次 `readiness()`：没配 AI 是硬拦，没配 TMDB 只是降级，
     * 两种情况界面要说的话不一样。
     */
    scan(dirs: string[]): Promise<VideoScanResult>
    cancel(): void
    onProgress(cb: (p: VideoScanProgress) => void): Unsubscribe
    /** 扫描前的可用性检查。ok 为 false 是硬拦；ok 为 true 而 message 非空是降级提醒 */
    readiness(forAgent?: boolean): Promise<{ ok: boolean; message: string }>

    /** 一部剧的所有集，按季集号排。电影返回空数组 */
    episodes(id: string): Promise<Episode[]>
    searchSource(query: string): Promise<Array<{ videoCode: string; title: string; coverUrl: string }>>
    scrapeEpisode(id: string, episodeId?: string, source?: string): Promise<{ episode: Episode | null; item: VideoItem | null; warnings: string[] }>
    pickEpisodeArtwork(id: string, role: 'poster' | 'thumbnail'): Promise<Episode | null>
    /** 把某一集的封面 / 预览图用作整部作品的封面 */
    useEpisodeArtwork(id: string, episodeId: string, role: 'poster' | 'thumbnail'): Promise<{ ok: boolean; message: string; item: VideoItem | null }>
    /** 合集内改集号 / 分部，一次提交一组；有冲突整组不改 */
    renumberEpisodes(id: string, changes: Array<{ episodeId: string; season: number; number: number }>): Promise<{ ok: boolean; message: string; item: VideoItem | null }>
    previewRemoval(request: import('./video-management').VideoRemovalRequest): Promise<import('./video-management').VideoRemovalPreview>
    applyRemoval(preview: import('./video-management').VideoRemovalPreview): Promise<{ detachedId: string; warnings: string[] }>
    taxonomy(hentai: boolean): Promise<import('./video-taxonomy').VideoTaxonomy>
    editTaxonomy(edit: import('./video-taxonomy').VideoTaxonomyEdit): Promise<number>
    bulkUpdate(ids: string[], patch: import('./video-management').VideoBulkPatch): Promise<number>
    importBundle(): Promise<(import('./video-library').VideoRegistrationResult & { scanResult?: VideoScanResult }) | null>
    library(id: string): Promise<import('./video-workflow').VideoWorkLibrary>
    audioLyrics(id: string, episode?: string): Promise<import('../utils/lyrics').AudioLyrics>
    audioInfo(id: string, episode?: string): Promise<{music?: import('../utils/audio').AudioMetadata; duration_sec: number; container: string}>
    syncFiles(id: string): Promise<import('./video-workflow').VideoLibrarySyncResult>
    previewCollectionName(id: string, title: string): Promise<{ title: string; from: string; to: string }>
    renameCollection(id: string, title: string): Promise<{ title: string; from: string; to: string; warnings: string[] }>
    playAsset(id: string): Promise<VideoPlayOutcome>
    revealAsset(id: string): Promise<boolean>
    relocateAsset(id: string): Promise<boolean>
    setDefaultAsset(episodeId: string, assetId: string): Promise<boolean>
    discovery: import('./video-discovery').DiscoveryApi
    prepareDownload(input: { url?: string; resourceId?: string; discovery?: import('./video-discovery').DiscoverySelection }): Promise<import('./video-workflow').VideoDownloadDraft>
    checkLibraryUpdates(ids?: string[], startup?: boolean): Promise<import('./video-updates').VideoUpdateState>
    updateCheckStatus(): Promise<import('./video-updates').VideoUpdateState>
    cancelUpdateCheck(): Promise<import('./video-updates').VideoUpdateState>
    onUpdateCheck(cb: () => void): Unsubscribe
    pickDownloadRoot(draftId: string): Promise<import('./video-workflow').VideoDownloadDraft | null>
    enqueueDownload(request: import('./video-workflow').VideoEnqueueRequest): Promise<import('./video-workflow').VideoDownloadJob>
    downloadJobs(): Promise<import('./video-workflow').VideoDownloadJob[]>
    downloadCaches(): Promise<import('./video-workflow').VideoDownloadCache[]>
    clearDownloadCache(id: string): Promise<{ cleared: boolean; bytes: number }>
    retryDownloadJob(id: string, stage: import('./video-workflow').VideoJobRetry): Promise<import('./video-workflow').VideoDownloadJob>
    cancelDownloadJob(id: string): Promise<boolean>
    /** 把已结束的下载记录从列表和角标里拿掉；文件和作品不动。运行中 / 排队中的返回 false */
    dismissDownloadJob(id: string): Promise<boolean>
    revealDownloadJob(id: string): Promise<boolean>
    onDownloadJob(cb: (job: import('./video-workflow').VideoDownloadJob) => void): Unsubscribe
    onLibraryChanged(cb: (resourceId: string) => void): Unsubscribe
    /**
     * 改一集。改完整部剧的观看状态会跟着刷一遍，所以要把条目也拿回来 ——
     * 界面上那个「3/12 集」和侧栏计数都得跟着动。
     */
    updateEpisode(
      episodeId: string,
      patch: Partial<Episode>
    ): Promise<{ episode: Episode | null; item: VideoItem | null }>

    /**
     * 定海报。三条来路按顺序试：同目录的海报图 → 刮削时记下的 TMDB 相对路径
     * → 都没有就返回 ok:false 让用户自己选一张。
     *
     * 单独一个口子而不是在扫描里顺手下完：下载是网络活，而扫描已经够慢了；
     * 更要紧的是用户重扫一次不该把自己手动选的海报冲掉。
     */
    fetchPoster(id: string): Promise<{ ok: boolean; message: string; item: VideoItem | null }>
    reidentify(id: string, forceHentai?: boolean): Promise<VideoItem | null>
    /** 选一张本地图当海报。取消返回 null */
    pickPoster(id: string): Promise<{ ok: boolean; message: string; item: VideoItem | null } | null>
    /** 撤掉海报，退回首字占位。磁盘上那份拷贝一起删 */
    clearPoster(id: string): Promise<VideoItem | null>
    /** 解析播放器直链；返回短期源令牌，不返回签名 URL。 */
    downloadSources(id: string): Promise<VideoDownloadCatalog>
    download(request: VideoDownloadRequest): Promise<VideoDownloadResult>
    /** 解析 Hanime 播放清单中的实际系列集数，不返回签名 URL。 */
    downloadSeries(id: string): Promise<VideoSeriesCatalog>
    downloadSeriesRun(request: VideoSeriesDownloadRequest): Promise<VideoSeriesDownloadResult>
    cancelDownload(requestId: string): Promise<{ ok: boolean; message?: string }>
    onDownloadProgress(cb: (progress: VideoDownloadProgress | VideoSeriesDownloadProgress) => void): Unsubscribe
    revealDownload(requestId: string): Promise<boolean>
  }
  videoOrganize: import('./video-organize').VideoOrganizeApi
  videoImport: import('./video-import').VideoImportApi
  videoAgentOrganize: import('./video-agent-organize').VideoAgentOrganizeApi
  tasks: {
    list(): Promise<TaskRecord[]>
    save(task: TaskRecord): Promise<boolean>
    clear(ids?: string[]): Promise<boolean>
  }
  categories: {
    list(kind?: string): Promise<Category[]>
    upsert(category: Category, kind?: string): Promise<Category[]>
    remove(id: string): Promise<Category[]>
    /** 上下挪一格。拖拽排序留给以后，这个能到达同样的顺序 */
    move(id: string, delta: number): Promise<Category[]>
  }
  tags: {
    list(kind?: string): Promise<Tag[]>
    /** 用户手工建标签，直接进池 */
    create(name: string, kind?: string): Promise<Tag[]>
    rename(id: number, name: string): Promise<Tag[]>
    /** 把若干标签并进一个，所有条目上的引用一并替换 */
    merge(fromIds: number[], intoId: number): Promise<Tag[]>
    remove(id: number): Promise<Tag[]>
  }
  pending: {
    /** 等确认的识别结果 */
    list(): Promise<PendingItem[]>
    count(): Promise<number>
    update(id: string, patch: Partial<PendingItem>): Promise<PendingItem | null>
    /** 写进 software；顺带建新分类、把 AI 标签转正 */
    confirm(ids: string[]): Promise<ConfirmResult>
    /** 不注册，并记进忽略名单，下次扫描不再冒出来 */
    skip(ids: string[]): Promise<number>
    /** 忽略名单条数 */
    skippedCount(): Promise<number>
    /** 清空忽略名单，被否决过的程序下次识别会重新出现 */
    clearSkipped(): Promise<number>
    listSkipped(): Promise<SkippedItem[]>
    removeSkipped(exePath: string): Promise<number>
  }
  settings: {
    detectFfmpeg(): Promise<string | null>
    pickFfmpeg(): Promise<string | null>
    getAll(): Promise<AppSettings>
    patch(patch: Partial<AppSettings>): Promise<AppSettings>
    /** 问 Chromium 某个地址实际会走哪条代理。诊断「配了没生效」用 */
    proxyStatus(url?: string): Promise<{
      rules: string
      resolved: string
      enabled: boolean
      hosts: readonly string[]
      ips: readonly string[]
      /** 写进 Chromium 启动规则的那个地址；内置 Hosts 关闭时为空串 */
      startupIp: string
      /** 运行时回退最近一次通了的地址；空串 = 还没回退过 */
      activeIp: string
      resolverRules: string
      proxyRules: string
      url: string
    }>
    hanimeVerify(url?: string): Promise<boolean>
  }
  scan: {
    pickDirectory(): Promise<string | null>
    run(dirs: string[], directDirs?: boolean): Promise<ScanResult>
    cancel(): void
    onProgress(cb: (p: ScanProgress) => void): Unsubscribe
    /** 待识别单元列表，设置页用来展示进度 */
    units(): Promise<ScanUnit[]>
    /** 把已识别 / 已跳过的目录退回待识别，用于全量重跑 */
    reset(): Promise<number>
    /** 把单个目录退回待识别。返回 false 表示这个目录已经不在表里了 */
    retry(dir: string): Promise<boolean>
  }
  ai: {
    /** 传 ids 只补全指定条目；不传则跑完所有待识别目录与待补全条目 */
    complete(ids?: string[]): Promise<AIResult>
    cancel(): void
    test(config: AIConfig): Promise<{ ok: boolean; message: string }>
    /** 拉服务商的模型列表（GET /models）。失败时返回 message，不抛 */
    models(config: AIConfig): Promise<{ ok: boolean; message: string; models: string[] }>
    testSearch(config: SearchConfig): Promise<{ ok: boolean; message: string }>
    /** 试一次 TMDB：拿配置发一次真实搜索，成了就说搜到了什么 */
    testTmdb(config: TmdbConfig): Promise<{ ok: boolean; message: string }>
    onProgress(cb: (p: AIProgress) => void): Unsubscribe
  }
  data: {
    snapshotInfo(): Promise<import('./library-snapshot').LibrarySafetyInfo>
    createSnapshot(): Promise<import('./library-snapshot').LibrarySnapshotEntry>
    openSnapshotDir(): Promise<void>
    archiveSnapshots(): Promise<import('./library-snapshot').SnapshotArchiveResult>
    exportSnapshot(id: string): Promise<{ file: string; size: number; sha256: string } | null>
    storageUsage(): Promise<import('./storage').StorageUsage>
    clearBrowserCache(): Promise<import('./storage').BrowserCacheClearResult>
    exportJson(): Promise<string | null>
    /** Validate and preview a full metadata backup, confirm, snapshot and restart. */
    restoreJson(): Promise<{ backupPath: string } | null>
    /** 导出为人能直接读的 Markdown 清单 */
    exportMarkdown(): Promise<string | null>
    /** 数据库和图标所在的目录 */
    dir(): Promise<string>
    openDir(): Promise<string>
    stats(): Promise<DataStats>
    /** 存档备份根目录当前实际生效的位置（设置为空时是默认那个） */
    saveBackupRoot(): Promise<string>
    /** 选存档备份根目录。取消返回 null */
    pickSaveBackupRoot(): Promise<string | null>
    openSaveBackupRoot(): Promise<string>
    /**
     * library：清软件条目 + 待识别目录 + 图标缓存，保留设置与自定义分类。
     * all：连设置和分类一起清，等于恢复出厂。
     * 两者都不会碰磁盘上的实际软件文件。
     */
    reset(mode: 'library' | 'all'): Promise<{ summary: ResetSummary; settings: AppSettings }>
  }
  logs: {
    list(query?: IdentifyLogQuery): Promise<IdentifyLog[]>
    clear(resourceKind?: string): Promise<number>
    /** 历史汇总报告，新的在前 */
    reports(resourceKind?: string): Promise<IdentifyReport[]>
  }
  organize: {
    /** 选整理目标根目录 */
    pickRoot(): Promise<string | null>
    /**
     * 算出「每条软件该怎么归位」交给用户过目。不动任何文件。
     * ids 为空表示对全部非归档条目出方案。
     */
    preview(ids?: string[]): Promise<OrganizePreview>
    /** 按用户改过的指令真的动文件。每完成一条推一次进度 */
    run(commands: OrganizeCommand[]): Promise<OrganizeResult>
    onProgress(cb: (p: OrganizeProgress) => void): Unsubscribe
    /** 历史整理记录，新的在前 */
    plans(): Promise<OrganizePlan[]>
    /** 按 plan 逆向执行：移回原位、删掉链接，并还原库里的路径字段 */
    undo(planId: string): Promise<UndoResult>
    /** 把 junction 换成真实文件的剪切副本 */
    materialize(id: string): Promise<{ ok: boolean; message: string }>
    /** 只删链接，不动源文件；条目路径退回实际位置 */
    unlink(id: string): Promise<{ ok: boolean; message: string }>
    /** 已整理的条目：当前位置已经在整理根下面的那些，带链接状态 */
    organized(ids?: string[]): Promise<OrganizedList>
    /** 扫一遍整理目录：子文件夹当分类、认领新软件、修复挪过位置的记录、找孤立链接 */
    sync(): Promise<OrganizeSyncReport>
    /** 改已整理条目的分类 / 文件夹名。链接和实体目录都支持 */
    previewRelocate(id: string, category: string, folder: string): Promise<RelocatePreview>
    relocate(id: string, category: string, folder: string, expectedFrom?: string): Promise<RelocateResult>
    /** 删掉整理目录里的孤立链接。只删链接本身 */
    removeLinks(paths: string[]): Promise<{ removed: number; removed_paths: string[]; failed: number; notes: string[] }>
  }
}
