import type { MoveRisk } from './software'

/** 整理执行时的进度。跨盘复制一个大目录要几十秒，不给反馈会被当成卡死 */
export interface OrganizeProgress {
  phase: 'running' | 'done'
  /** 正在处理的软件名 */
  current: string
  processed: number
  total: number
  failed: number
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

/** 整理目录里一条已整理的记录。见 organize:organized */
export interface OrganizedEntry {
  software_id: string
  name: string
  /** 当前所在目录（source_dir，退回 exe 所在目录） */
  dir: string
  exe_path: string
  /** 记录上的分类 */
  category: string
  /** 从路径第一段推出来的分类文件夹名；条目直接躺在整理根下时为空串 */
  folder_category: string
  /** 当前文件夹名 */
  folder: string
  is_link: boolean
  link_target: string
  /** 链接的真实目标还在不在；非链接恒为 true */
  target_ok: boolean
  /** 目录本身还在不在 */
  present: boolean
  /** 主程序是否还存在（卸载可能只移除 EXE，留下目录） */
  exe_present: boolean
  /** 分类文件夹和记录上的分类对不上 */
  category_mismatch: boolean
  is_portable: boolean | null
  move_risk: MoveRisk
  is_archived: boolean
}

export interface OrganizedList {
  root: string
  entries: OrganizedEntry[]
}

/** 整理目录里没有任何记录指向的 junction */
export interface OrphanLink {
  path: string
  name: string
  /** 指向的真实路径；读不到时为空串 */
  target: string
  /** 目标已经不在了 */
  broken: boolean
  /** 目标目录里带着抱一写的 .baoyi_link 标记：这条链接是整理时建的 */
  ours: boolean
}

/** 一次「同步整理目录」做了什么。见 organize:sync */
export interface OrganizeSyncReport {
  root: string
  /** 这次有没有真的跑（没设整理根、或整理根不在了就是 false） */
  ran: boolean
  categories_added: string[]
  software_added: Array<{ name: string; dir: string; category: string }>
  /** 在资源管理器里挪过位置、被认回来的 */
  healed: Array<{ name: string; from: string; to: string; why: string }>
  /** 分类跟着所在文件夹改了的 */
  recategorized: Array<{ name: string; from: string; to: string }>
  /** 记录还在、整理目录里的文件夹没了 */
  missing: Array<{ name: string; dir: string }>
  orphan_links: OrphanLink[]
  /** 有目录但没能入库：no-exe 找不到主程序；ambiguous 同名记录不止一条，不敢认 */
  skipped_dirs: Array<{ dir: string; reason: 'no-exe' | 'ambiguous' }>
  notes: string[]
}

export interface RelocateResult {
  ok: boolean
  message: string
}

export interface RelocatePreview extends RelocateResult {
  from: string
  to: string
  category: string
  folder: string
  is_link: boolean
  warning?: string
}

export interface RemoveSoftwareResult {
  ok: boolean
  message: string
  /** 顺手删掉了整理目录里的 junction */
  link_removed: boolean
}
