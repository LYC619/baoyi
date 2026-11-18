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
  project?: import('./game-project').GameProjectRecord
  catalog?: {retired?: boolean; key:string;source:string;fingerprint:string;fields:Partial<Pick<LinkedFile,'note'|'features'|'usage'|'fit_version'|'purpose'>>}
  purpose?: 'modifier' | 'backup' | 'inspection' | 'patch' | 'mixed'
  path: string
  label: string
  type: 'guide' | 'trainer' | 'mod' | 'emulator' | 'other'
  /** Optional project-catalog information; older links remain valid. */
  role?: 'launcher' | 'usage' | 'report' | 'source'
  note?: string
  features?: Array<{key:string;label:string}>
  usage?:string
  version?:string
  fit_version?:string
  launch_with_game?:boolean
  source?:string
  read_progress?:number
}

/** game_meta 那张表的形状。resource 的公共字段不在这里，见 GAME_VIEW_SQL */
export interface GameMeta {
  cover_focus?: string
  cover_path: string
  background_path: string
  /** 封面来源与当前状态，用于区分手动、本地缓存和联网候选失败 */
  cover_source: 'manual' | 'local' | 'steam' | 'search' | 'official' | ''
  cover_source_url: string
  cover_status: 'ready' | 'missing' | 'failed'
  cover_detail: string
  /** 识别出的官方身份。确认前不自动把同名游戏当成目标 */
  identity_name: string
  identity_query: string
  identity_confirmed: boolean
  play_status: PlayStatus
  total_playtime_sec: number
  last_played_at: number
  save_paths: SavePath[]
  linked_files: LinkedFile[]
}

/**
 * 一次存档备份的记录。
 *
 * backup_dir 指向磁盘上真实存在的一份拷贝，目录里是 `save/`（存档内容）
 * 和 `backup.json`（说明文件）。说明文件刻意在载荷之外 —— 在里面的话，
 * 还原时它会跟着被复制回用户的存档目录。
 */
export interface SaveBackup {
  id: string
  resource_id: string
  save_path: string
  backup_dir: string
  size_bytes: number
  file_count: number
  created_at: number
}

/** 备份一次的结果。失败时 backup 为 null，磁盘上不会留下半成品 */
export interface SaveBackupResult {
  ok: boolean
  message: string
  backup: SaveBackup | null
  /**
   * 备份完之后，这条存档路径下超出保留上限的那几份，最旧的在前。
   *
   * **主进程不会自动删它们** —— 这是一份「可以删」的名单，删不删由用户在弹窗里决定。
   * 保留上限是设置里的 `save_backup_keep`（默认 10，0 = 不限）。
   */
  over: SaveBackup[]
}

/**
 * 还原一次的结果。
 *
 * safety 是「还原前自动备份的那一份」。它可能在 ok=false 时也不为 null ——
 * 自动备份成功了、后面的复制或改名失败了。那份备份是真实存在的，得让用户知道。
 */
export interface SaveRestorePreview {
  target: string
  expected: string
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: number
  files: number
  bytes: number
}

export interface SaveRestoreResult {
  ok: boolean
  message: string
  safety: SaveBackup | null
}

/**
 * 一个候选存档目录的探测结果，给「选目录并当场验证」用。
 *
 * exists 和 files 分开报：存在但空的目录是一个有意义的中间状态 ——
 * 游戏还没存过档，路径本身可能是对的。界面据此问一句而不是直接拒绝。
 */
export interface SavePathCheck {
  path: string
  exists: boolean
  files: number
  bytes: number
  /** 最新的 mtime，0 表示读不出来 */
  newest: number
  /** 抽几个文件名，存档文件的扩展名往往一眼能认 */
  sample: string[]
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
  use_count?: number
  path_state?: 'present' | 'missing' | 'offline'
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

/**
 * 存档状态。这三个值互斥且穷尽，判定只看**库里记的东西**：
 *
 * - `none` 没发现存档路径（save_paths 是空的）
 * - `unbacked` 发现了路径，但一份备份都没有
 * - `backed` 发现了路径，且至少备份过一次
 *
 * 「路径失效」不在这里 —— 那是一条正交的信息（有路径、可能也有备份，只是路径当下
 * 不存在了），塞进这个枚举会让三分变成含义重叠的四分。它走卡片上的角标。
 */
export type SaveStatus = 'none' | 'unbacked' | 'backed'

/**
 * 一条「这个游戏名下有存档路径当下不存在」的提醒。
 *
 * 开库时算出来的瞬时状态，**不入库** —— 外置硬盘没插上这种情况一分钟后就不成立了，
 * 把它写进记录等于留下一个会过期却不会自己消失的判断。
 */
export interface SavePathAlert {
  id: string
  /** 游戏显示名，提醒文案直接用，省得渲染进程再查一次 */
  name: string
  /** 这次没找到的那几条路径；恒非空，空的条目根本不会出现在结果里 */
  missing: string[]
}

export interface GameQuery {
  uncategorized?: boolean
  keyword?: string
  category?: string
  tag?: string
  status?: PlayStatus
  save?: SaveStatus
  /** 归档区和正常区互斥，和软件那边同一个约定 */
  group?: 'all' | 'archived'
  sort?: 'played' | 'name' | 'playtime' | 'added'
}

export interface GameCounts {
  uncategorized?: number
  all: number
  archived: number
  /** 四个游玩状态各有几个。闭集，缺的那个是 0 不是不存在 */
  status: Record<PlayStatus, number>
  /** 三个存档状态各有几个。同样是闭集 */
  save: Record<SaveStatus, number>
  categories: Array<{ name: string; count: number }>
  tags: Array<{ name: string; count: number }>
}

/**
 * 一段游玩结束时推给界面的东西。
 *
 * `counted` 为 false 时 `elapsed_sec` 照样是真实秒数 —— 太短没计入总时长，
 * 但发生过就是发生过，不把它改成 0。界面据此说一句实话而不是显示「玩了 0 分钟」。
 */
export interface GameSessionEvent {
  id: string
  elapsed_sec: number
  counted: boolean
  total_playtime_sec: number
  status_changed: boolean
  play_status: PlayStatus
  message: string
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

/**
 * 一个候选封面图。
 *
 * `source` 只影响界面上那行来源说明；`portrait` 决定排序 —— 封面墙的框是 2:3 的，
 * 横版图塞进去要裁掉两边，只能当兜底。
 */
export interface CoverCandidate {
  url: string
  /** 通过 baoyi:// 协议加载的本地预览，避免 CSP 阻断远程图片 */
  preview_url?: string
  label: string
  source: 'local' | 'steam' | 'search' | 'official'
  portrait: boolean
  rank: number
  title?: string
  width?: number
  height?: number
  bytes?: number
  status?: 'ready' | 'failed'
  stage?: 'network' | 'decode' | 'cache' | 'write'
  message?: string
  route?: string
}

export interface GameCoverDiagnostic {
  source: 'local' | 'steam' | 'search' | 'official'
  stage: 'identity' | 'lookup' | 'network' | 'decode' | 'cache' | 'write'
  status: 'ready' | 'failed' | 'skipped'
  message: string
  route?: string
  url?: string
}

/**
 * 封面搜索的结果。
 *
 * `message` 在 `ok=false` 时**必须**有内容，且要说清是哪一类失败（网络不通 /
 * 这个游戏查不到 / 服务商不支持图搜）—— 三类的下一步动作完全不同。
 * `ok=true` 时它可能仍有内容，用来带一句「这次只查了 Steam」这样的补充说明。
 */
export interface GameCoverSearchResult {
  ok: boolean
  message: string
  candidates: CoverCandidate[]
  /** 实际用来搜的那个名字，界面上要显示出来，用户才知道该怎么改 */
  query: string
  diagnostics?: GameCoverDiagnostic[]
}
