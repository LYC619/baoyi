/**
 * 抱一 — 共享类型定义
 * 主进程与渲染进程共用，仅作类型标注（编译后不产生运行时代码）。
 */

export type MasteryLevel = 'proficient' | 'familiar' | 'learning' | 'new'

/** AI 补全状态：待识别 / 已完成 / 失败（可重试） */
export type AiStatus = 'pending' | 'done' | 'failed'

/**
 * 换个位置放它，会不会出事。
 *
 * safe    —— 只是一堆文件，挪走照样能跑
 * risky   —— 注册了服务 / 驱动 / COM，或者装在系统保护目录里，挪走会坏
 * unknown —— 没判断出来。和 risky 一样按「不敢动」处理，但要和「确认有风险」分开记，
 *            否则没法回答「是它真有依赖，还是当时没看出来」
 */
export type MoveRisk = 'safe' | 'risky' | 'unknown'

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

  /**
   * 是不是绿色软件（解压即用、无安装器）。
   * null 表示还没判断过 —— 和「判断为否」不是一回事，整理时前者不动、后者按安装版处理。
   */
  is_portable: boolean | null
  /** 挪位置的风险，见 MoveRisk */
  move_risk: MoveRisk
  /**
   * 整理成 junction 之后，链接真正指向哪里。空串表示这是个实体目录。
   * exe_path 始终是「用户和抱一看到的那个路径」，实际位置记在这里。
   */
  link_target: string

  // 用户个人信息
  why_choose: string
  use_cases: string
  notes: string
  alternatives: string[]
  mastery_level: MasteryLevel

  // 使用统计
  /** 用户通过抱一启动的时间。0 = 抱一没记到过 */
  last_used_at: number
  use_count: number
  is_archived: boolean
  /**
   * 外部活跃时间：软件目录里配置文件的最新 mtime（读不到配置时退回 exe 的 mtime）。
   * 用来回答「抱一之前你有没有在用它」，见 electron/services/activity.ts。
   */
  external_active_at: number
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
  /** null = agent 没给出判断 */
  is_portable: boolean | null
  move_risk: MoveRisk
}

/**
 * 一条等用户过目的识别结果。
 *
 * agent 不再直接往 software 表写 —— 它给出的名字、分类、标签都可能是错的，
 * 而错到库里以后没人会回头改。先落在这里，用户点过头才成为条目。
 */
export interface PendingItem {
  id: string
  created_at: number
  /** 来自哪个待识别目录 */
  scan_unit_id: string

  exe_path: string
  icon_path: string
  file_name: string
  file_description: string
  company: string
  version: string
  file_size: number
  external_active_at: number

  name_zh: string
  name_en: string
  summary: string
  description: string
  category: string
  tags: string[]
  official_url: string
  launchers: Launcher[]
  source_dir: string

  is_portable: boolean | null
  move_risk: MoveRisk

  /** AI 给的分类不在现有分类表里 —— 确认面板要标出来 */
  new_category: boolean
  /** tags 里哪几个是标签池里没有的新词 */
  new_tags: string[]
}

/** 确认写入的结果 */
export interface ConfirmResult {
  registered: number
  /** 新建的分类名 */
  categories: string[]
  /** 转正的标签名 */
  tags: string[]
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
  /** 一句话说明这个分类装什么，同时喂给识别 agent 当判据 */
  description: string
  icon: string
  sort_order: number
}

/**
 * 标签来源。
 * ai        —— agent 新造的，还没被用户认可
 * user      —— 用户手工建的
 * confirmed —— 用户在确认面板里认可过的 AI 标签
 *
 * 只有 user / confirmed 会作为「标签池」注入 prompt，ai 的不进池 ——
 * 否则 agent 造一个新词，下一轮就把它当既成事实继续用，标签只会越长越碎。
 */
export type TagSource = 'ai' | 'user' | 'confirmed'

export interface Tag {
  id: number
  name: string
  source: TagSource
  /** 实际有多少条目在用它。读的时候现算，不存计数列，见 database.ts */
  usage_count: number
  created_at: number
}

/* ------------------------------ 游戏品类 ------------------------------ */

/**
 * 游玩状态。四态是闭集，库里有 CHECK 约束兜着（见 kinds/game/schema.ts）。
 * 只有「首次通过抱一启动」会自动从 unplayed 转成 playing，其余全靠手动 ——
 * 抱一不做后台监控，猜错状态比让用户点一下更烦人。
 */
export type PlayStatus = 'unplayed' | 'playing' | 'completed' | 'shelved'

/** 一条存档路径。verified_at 是最后一次确认它真实存在的时刻，0 表示还没验证过 */
export interface SavePath {
  path: string
  verified_at: number
}

/** 关联文件：攻略、修改器、MOD 目录、模拟器 exe 之类 */
export interface LinkedFile {
  path: string
  label: string
  type: 'guide' | 'trainer' | 'mod' | 'emulator' | 'other'
}

/** game_meta 那张表的形状。resource 的公共字段不在这里，见 GAME_VIEW_SQL */
export interface GameMeta {
  cover_path: string
  background_path: string
  play_status: PlayStatus
  total_playtime_sec: number
  last_played_at: number
  save_paths: SavePath[]
  linked_files: LinkedFile[]
}

/** 一次存档备份的记录。backup_dir 指向磁盘上真实存在的一份拷贝 */
export interface SaveBackup {
  id: string
  resource_id: string
  save_path: string
  backup_dir: string
  size_bytes: number
  file_count: number
  created_at: number
}

/**
 * 游戏视图（GAME_VIEW_SQL）的一行。
 *
 * 刻意不复用 SoftwareItem —— 两者在总表上共享一半字段，但差的那一半是彼此的
 * 噪音：软件那边的 launchers / is_portable / mastery_level 在游戏详情页上没有
 * 位置，游戏这边的 play_status / total_playtime_sec 在软件卡片上同理。
 * 合成一个「资源」类型的代价是每处都要判「这是哪一类」再决定字段有没有意义。
 */
export interface GameItem extends GameMeta {
  id: string
  created_at: number
  updated_at: number
  /** 主程序绝对路径，同时是全局唯一键 */
  path: string
  file_name: string
  file_size: number
  /** 游戏所在目录 */
  source_dir: string
  name_zh: string
  name_en: string
  summary: string
  description: string
  category: string
  tags: string[]
  official_url: string
  notes: string
  is_archived: boolean
}

export interface GameQuery {
  keyword?: string
  category?: string
  tag?: string
  status?: PlayStatus
  /** 归档区和正常区互斥，和软件那边同一个约定 */
  group?: 'all' | 'archived'
  sort?: 'played' | 'name' | 'playtime' | 'added'
}

export interface GameCounts {
  all: number
  archived: number
  /** 四个游玩状态各有几个。闭集，缺的那个是 0 不是不存在 */
  status: Record<PlayStatus, number>
  categories: Array<{ name: string; count: number }>
  tags: Array<{ name: string; count: number }>
}

/** 游戏扫描 + 识别是一条链路上的两截，进度也就用同一个形状报 */
export interface GameScanProgress {
  phase: 'scanning' | 'identifying' | 'done'
  /** 正在扫的目录 / 正在识别的游戏目录 */
  current: string
  /** identifying 阶段才有意义；scanning 阶段 total 未知，恒为 0 */
  processed: number
  total: number
  registered: number
  failed: number
  /** agent 最近一步动作的人话翻译 */
  log: string
}

export interface GameScanResult {
  /** 扫出来的候选目录数 */
  candidates: number
  registered: number
  skipped: number
  failed: number
  tokens: number
}

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
  /** 当前生效的那份配置。切换配置就是把某个 profile 铺到这里 */
  ai: AIConfig
  ai_profiles: AIProfile[]
  /** 当前选中的 profile。空串表示「临时配置」——改了还没存成一套 */
  ai_profile_id: string
  search: SearchConfig
  scan_dirs: string[]
  /**
   * 自动整理的目标根目录。和 scan_dirs 刻意分开 —— 扫描是「去哪里找」，
   * 这里是「归到哪里去」，把整理目标也加进扫描列表只会让下一轮重扫再发现一遍。
   */
  organize_root: string
  theme: 'dark' | 'light'
  view_mode: 'grid' | 'list'
  /**
   * 卡片墙按分类分区块展示。和 view_mode 是两个维度 —— 分组之后每个区块内部
   * 照样可以是网格或列表，所以不做成 view_mode 的第三个值。
   */
  group_by_category: boolean
  unused_days: number
  title_lang: TitleLang
  onboarded: boolean
}

/** 侧边栏虚拟分组标识 */
export type VirtualGroup = 'all' | 'archived' | 'unused' | 'pending' | 'portable'

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
  /** 识别完、等用户确认的条目数 */
  pending_confirm: number
  /** 绿色软件条目数。整理功能主要作用在它们身上，值得单独一个入口 */
  portable: number
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

/** 整理执行时的进度。跨盘复制一个大目录要几十秒，不给反馈会被当成卡死 */
export interface OrganizeProgress {
  phase: 'running' | 'done'
  /** 正在处理的软件名 */
  current: string
  processed: number
  total: number
  failed: number
}

export interface ScanResult {
  /** 发现的 exe 总数 */
  found: number  /** 这次新发现的目录数 */
  added: number
  /** 扫描后仍待识别的目录总数（含之前就待识别、以及上次识别失败的） */
  pending: number
  /** 之前已识别或已跳过、这次不再处理的目录数 */
  settled: number
  /**
   * 散落在扫描根那一层的 exe 和压缩包（.rar / .zip / .7z）。
   * 它们不会被识别，只在摘要里提一句，让用户自己决定要不要归位。
   */
  loose_files: string[]
}

export interface AIResult {
  /** 处理过的目录数 + 补全过的遗留条目数 */
  processed: number
  /** 新注册的软件条目数。走确认流程时这里是「暂存待确认」的条数 */
  registered: number
  skipped: number
  failed: number
  /** 本次消耗的 token 总数，便于用户判断成本 */
  tokens: number
  /** 本轮汇总报告的 id。空串表示这轮没跑任何任务，没有报告可看 */
  report_id: string
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

/* ------------------------------ 目录整理 ------------------------------ */

/**
 * 一条软件该怎么归位。
 *
 * move     —— 把目录整体挪到目标分类下，并规范文件夹名（绿色软件、以及 move_risk=safe 的安装版）
 * junction —— 目标位置只放一个链接，实际文件留在原地（安装版，动不了）
 * skip     —— 这一条不处理
 */
export type OrganizeAction = 'move' | 'junction' | 'skip'

/** 预览面板里的一行。用户可以翻转 action、改分类、改文件夹名 */
export interface OrganizeEntry {
  software_id: string
  name: string
  /** 要搬的那个目录（软件的安装/解压根，不是 exe 本身） */
  from_dir: string
  exe_path: string
  is_portable: boolean | null
  move_risk: MoveRisk
  /** 已经是链接了：整理过一轮之后再进来会看到 */
  link_target: string

  action: OrganizeAction
  category: string
  /** 目标文件夹名，默认取软件英文正式名 */
  folder: string
  /** category + folder 拼出来的完整目标路径，只读预览 */
  to_dir: string

  /**
   * 这一行需要用户注意的事：注册表/AppData 里发现了硬引用、目标已存在同名目录等。
   * 有值就在行内亮一个黄色图标。
   */
  warning: string
  /** true 表示目标路径已被占用，执行时会跳过而不是覆盖 */
  conflict: boolean
}

export interface OrganizePreview {
  /** 整理目标根目录。没配置时为空串，面板要提示先去设置 */
  root: string
  entries: OrganizeEntry[]
}

/** 用户在面板上改完、真正提交执行的那份指令。故意不回传 to_dir —— 主进程自己拼，不信渲染进程 */
export interface OrganizeCommand {
  software_id: string
  action: OrganizeAction
  category: string
  folder: string
}

/** 落盘的一步操作。撤销就是把它逆着做一遍 */
export interface OrganizeStep {
  type: OrganizeAction
  software_id: string
  name: string
  from: string
  to: string
  /** 原来的 exe_path，撤销时要还原回去 */
  from_exe: string
  /** 整理后的 exe_path */
  to_exe: string
  ok: boolean
  /** 失败或跳过的原因 */
  note: string
}

/** 一次整理的完整记录。既是执行结果，也是撤销依据 */
export interface OrganizePlan {
  id: string
  created_at: number
  root: string
  /** 已撤销的不再提供撤销按钮 */
  undone_at: number
  steps: OrganizeStep[]
}

export interface OrganizeResult {
  plan_id: string
  moved: number
  linked: number
  skipped: number
  failed: number
  steps: OrganizeStep[]
}

export interface UndoResult {
  restored: number
  failed: number
  notes: string[]
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
  | {
      type: 'tool_result'
      name: string
      text: string
      isError: boolean
      /** 这次工具执行花了多久。0.4 之前的日志没有这个字段，读出来是 undefined */
      ms?: number
    }

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

/* ------------------------------ 汇总报告 ------------------------------ */

/** 汇总报告里的一行：一个目录的结果摘要 */
export interface IdentifyReportEntry {
  dir: string
  label: string
  status: IdentifyLogStatus
  rounds: number
  tokens: number
  /** 这一条识别过程中调用了几次 web_search */
  searches: number
  /** 结论或失败 / 跳过原因 */
  note: string
}

/**
 * 一轮批量识别的汇总。
 *
 * 逐条日志回答「这个目录为什么这样判断」，这份回答「这一轮整体怎么样」——
 * 哪些没成、共花了多少、搜索额度用掉多少。它是对已有数据的汇总，不额外消耗任何 token。
 */
export interface IdentifyReport {
  id: string
  created_at: number
  processed: number
  registered: number
  skipped: number
  failed: number
  duration_ms: number
  tokens: number
  searches: number
  entries: IdentifyReportEntry[]
}

/**
 * 搜索服务的一次调用记录。
 *
 * 不新建表 —— 从 identify_logs 的 web_search 事件里现取。代价是时间只精确到
 * 「所属那次识别」这一级（日志本身只有一个时间戳），够用来回答「今天搜了几次、通不通」。
 */
export interface SearchCallRecord {
  /** 所属识别日志的时间。同一次识别里的多次搜索共用它 */
  at: number
  query: string
  status: 'ok' | 'empty' | 'timeout' | 'failed'
  /** 耗时毫秒。0 表示这条日志是 0.4 之前记的，当时没有计时 */
  ms: number
  /** 哪个目录触发的 */
  label: string
}

export type Unsubscribe = () => void

/** preload 暴露给渲染进程的完整 API */
export interface BaoyiApi {
  app: {
    /** 版本与构建信息，「关于」页用 */
    info(): Promise<AppInfo>
    /**
     * 写剪贴板。走主进程的 clipboard 而不是 navigator.clipboard ——
     * 后者在打包后的 file:// 页面里要看权限处理器的脸色，而这个一定成。
     */
    copyText(text: string): Promise<void>
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
  game: {
    list(query?: GameQuery): Promise<GameItem[]>
    get(id: string): Promise<GameItem | null>
    update(id: string, patch: Partial<GameItem>): Promise<GameItem | null>
    /** 只从库里移除，不动磁盘上的游戏文件，也不删已有的存档备份 */
    remove(id: string): Promise<void>
    counts(): Promise<GameCounts>
    /** 在资源管理器里选中主程序 */
    revealInFolder(id: string): Promise<void>
    /** 选游戏目录，可多选。取消返回空数组 */
    pickDirectories(): Promise<string[]>
    /** 扫描 + 识别一条龙，结果直接落库（游戏不走确认面板） */
    scan(dirs: string[]): Promise<GameScanResult>
    cancel(): void
    onProgress(cb: (p: GameScanProgress) => void): Unsubscribe
  }
  categories: {
    list(): Promise<Category[]>
    upsert(category: Category): Promise<Category[]>
    remove(id: string): Promise<Category[]>
    /** 上下挪一格。拖拽排序留给以后，这个能到达同样的顺序 */
    move(id: string, delta: number): Promise<Category[]>
  }
  tags: {
    list(): Promise<Tag[]>
    /** 用户手工建标签，直接进池 */
    create(name: string): Promise<Tag[]>
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
    /** 拉服务商的模型列表（GET /models）。失败时返回 message，不抛 */
    models(config: AIConfig): Promise<{ ok: boolean; message: string; models: string[] }>
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
    /** 历史汇总报告，新的在前 */
    reports(): Promise<IdentifyReport[]>
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
  }
}
