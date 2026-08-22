/**
 * 抱一 — 共享类型定义
 * 主进程与渲染进程共用，仅作类型标注（编译后不产生运行时代码）。
 */

export type MasteryLevel = 'proficient' | 'familiar' | 'learning' | 'new'

/** AI 补全状态：待识别 / 已完成 / 失败（可重试） */
export type AiStatus = 'pending' | 'done' | 'failed'

/**
 * 一个软件的启动端。
 * 同一软件的 32/64 位版本、GUI/命令行版本合并进同一条目，各自作为一个启动端。
 * kind = 'extra' 的是附属程序（加载器、配置工具等），默认折叠展示。
 */
export interface Launcher {
  path: string
  /** 展示名，如「64 位」「32 位」「命令行」 */
  label: string
  kind: 'main' | 'extra'
  is_default: boolean
}

export interface SoftwareItem {
  // 系统标识
  id: string
  created_at: number
  updated_at: number

  // 文件信息（自动扫描）
  /** 默认启动端的路径，同时用作条目唯一键 */
  exe_path: string
  icon_path: string
  file_name: string
  file_description: string
  company: string
  version: string
  file_size: number
  /** agent 识别时所属的目录，重扫时用它判断是否已处理过 */
  source_dir: string

  // AI 补全信息
  name_zh: string
  name_en: string
  summary: string
  description: string
  category: string
  tags: string[]
  official_url: string
  ai_status: AiStatus
  /** 全部启动端。为空表示只有 exe_path 一个 */
  launchers: Launcher[]

  // 用户个人信息
  why_choose: string
  use_cases: string
  notes: string
  alternatives: string[]
  mastery_level: MasteryLevel

  // 使用统计
  last_used_at: number
  use_count: number
  is_archived: boolean
}

/** 新增软件时的最小信息（扫描结果） */
export interface ScannedFile {
  exe_path: string
  file_name: string
  file_description: string
  company: string
  version: string
  file_size: number
}

/** agent 调用 register_software 时提交的内容 */
export interface RegisterPayload {
  name_zh: string
  name_en: string
  summary: string
  description: string
  category: string
  tags: string[]
  official_url: string
  launchers: Launcher[]
  source_dir: string
}

/** 一个待识别单元：交给 agent 自主探索的目录 */
export type ScanUnitStatus = 'pending' | 'done' | 'skipped' | 'failed'

export interface ScanUnit {
  dir: string
  /** 所属扫描根 */
  root: string
  exe_count: number
  /** true 表示只识别该目录下直属的 exe（扫描根里的散装程序） */
  loose_only: boolean
  status: ScanUnitStatus
  /** 跳过原因或失败原因 */
  note: string
  registered: number
  created_at: number
  updated_at: number
}

export interface Category {
  id: string
  name: string
  icon: string
  sort_order: number
}

export interface AIConfig {
  api_url: string
  api_key: string
  model: string
  enabled: boolean
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
  ai: AIConfig
  search: SearchConfig
  scan_dirs: string[]
  theme: 'dark' | 'light'
  view_mode: 'grid' | 'list'
  unused_days: number
  title_lang: TitleLang
  onboarded: boolean
}

/** 侧边栏虚拟分组标识 */
export type VirtualGroup = 'all' | 'archived' | 'unused' | 'pending'

export interface SoftwareQuery {
  keyword?: string
  category?: string
  tag?: string
  mastery?: MasteryLevel
  group?: VirtualGroup
  unused_days?: number
  sort?: 'recent' | 'name' | 'count' | 'added'
}

export interface SidebarCounts {
  all: number
  archived: number
  unused: number
  /** 待补全的软件条目数 —— 侧边栏「待识别」分组点进去看到的就是这些 */
  pending: number
  /** 还没跑过 agent 的目录数。它们还不是条目，所以单独计 */
  pending_units: number
  categories: Array<{ name: string; count: number }>
  tags: Array<{ name: string; count: number }>
}

export interface ScanProgress {
  phase: 'walking' | 'reading' | 'done'
  /** 当前扫描到的目录或文件 */
  current: string
  found: number
  processed: number
  total: number
}

export interface AIProgress {
  phase: 'running' | 'done'
  /** 当前正在识别的目录 */
  current: string
  processed: number
  total: number
  failed: number
  /** 已注册的软件数 */
  registered: number
  /** agent 最近一次动作的可读描述，用于让用户看到它在干什么 */
  log: string
}

export interface ScanResult {
  /** 发现的 exe 总数 */
  found: number
  /** 这次新发现的目录数 */
  added: number
  /** 扫描后仍待识别的目录总数（含之前就待识别、以及上次识别失败的） */
  pending: number
  /** 之前已识别或已跳过、这次不再处理的目录数 */
  settled: number
}

export interface AIResult {
  /** 处理过的目录数 + 补全过的遗留条目数 */
  processed: number
  /** 新注册的软件条目数 */
  registered: number
  skipped: number
  failed: number
  /** 本次消耗的 token 总数，便于用户判断成本 */
  tokens: number
}

/** 清空数据后回报清掉了些什么 */
export interface ResetSummary {
  software: number
  units: number
  icons: number
  settingsCleared: boolean
}

/** 设置页「数据管理」上展示的用量 */
export interface DataStats {
  software: number
  units: number
  logs: number
  /** 数据库占用字节数，含还没落盘的 WAL */
  dbBytes: number
  icons: number
  iconBytes: number
}

/** 「关于」页展示的版本与构建信息 */
export interface AppInfo {
  /** 来自 package.json，打包后取自安装包元数据 */
  version: string
  electron: string
  chrome: string
  node: string
}

/* ------------------------------ 识别日志 ------------------------------ */

/**
 * agent 循环里发生的一件事。日志页直接按这个序列回放识别过程，
 * 所以它同时是主进程的事件类型和落库的记录格式。
 */
export type AgentEvent =
  | { type: 'turn'; index: number }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; text: string; isError: boolean }

export type AgentStopReason = 'done' | 'max_turns' | 'aborted' | 'error'

/** 日志状态。success 表示至少注册了一个条目 */
export type IdentifyLogStatus = 'success' | 'skipped' | 'failed'

export interface IdentifyLog {
  id: string
  /** 被识别的目录（单条补全时是 exe 所在目录） */
  dir: string
  /** 列表上展示的标题：目录名或文件名 */
  label: string
  /** unit = 整个目录，item = 单条补全 */
  kind: 'unit' | 'item'
  status: IdentifyLogStatus
  /** 一行结论，例如「注册 2 项」或跳过原因 */
  summary: string
  registered: number
  rounds: number
  duration_ms: number
  tokens: number
  stop_reason: AgentStopReason | ''
  /** 完整过程。按 turn 事件分组即可还原每一轮 */
  events: AgentEvent[]
  created_at: number
}

export interface IdentifyLogQuery {
  status?: IdentifyLogStatus
  keyword?: string
  limit?: number
}

export type Unsubscribe = () => void

/** preload 暴露给渲染进程的完整 API */
export interface BaoyiApi {
  app: {
    /** 版本与构建信息，「关于」页用 */
    info(): Promise<AppInfo>
  }
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximizeChange(cb: (maximized: boolean) => void): Unsubscribe
  }
  software: {
    list(query?: SoftwareQuery): Promise<SoftwareItem[]>
    get(id: string): Promise<SoftwareItem | null>
    update(id: string, patch: Partial<SoftwareItem>): Promise<SoftwareItem | null>
    remove(id: string): Promise<void>
    counts(unusedDays: number): Promise<SidebarCounts>
    /** launcherPath 为空时启动默认启动端 */
    launch(id: string, launcherPath?: string): Promise<boolean>
    revealInFolder(id: string, launcherPath?: string): Promise<void>
    addManual(): Promise<SoftwareItem[]>
  }
  categories: {
    list(): Promise<Category[]>
    upsert(category: Category): Promise<Category[]>
    remove(id: string): Promise<Category[]>
  }
  settings: {
    getAll(): Promise<AppSettings>
    patch(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  scan: {
    pickDirectory(): Promise<string | null>
    run(dirs: string[]): Promise<ScanResult>
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
    testSearch(config: SearchConfig): Promise<{ ok: boolean; message: string }>
    onProgress(cb: (p: AIProgress) => void): Unsubscribe
  }
  data: {
    exportJson(): Promise<string | null>
    /** 导出为人能直接读的 Markdown 清单 */
    exportMarkdown(): Promise<string | null>
    /** 数据库和图标所在的目录 */
    dir(): Promise<string>
    openDir(): Promise<string>
    stats(): Promise<DataStats>
    /**
     * library：清软件条目 + 待识别目录 + 图标缓存，保留设置与自定义分类。
     * all：连设置和分类一起清，等于恢复出厂。
     * 两者都不会碰磁盘上的实际软件文件。
     */
    reset(mode: 'library' | 'all'): Promise<{ summary: ResetSummary; settings: AppSettings }>
  }
  logs: {
    list(query?: IdentifyLogQuery): Promise<IdentifyLog[]>
    clear(): Promise<number>
  }
}
