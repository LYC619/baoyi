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


export interface SkippedItem {
  exe_path: string
  label: string
  source_dir: string
  created_at: number
}
