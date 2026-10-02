/**
 * 抱一 — 共享类型定义
 * 主进程与渲染进程共用，仅作类型标注（编译后不产生运行时代码）。
 */

import type {
  VideoDownloadCatalog,
  VideoDownloadProgress,
  VideoDownloadRequest,
  VideoDownloadResult,
  VideoSeriesCatalog,
  VideoSeriesDownloadProgress,
  VideoSeriesDownloadRequest,
  VideoSeriesDownloadResult
} from './video-download'

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

/** 卡片标题用哪个名字打头，另一个降为副标题 */
export type TitleLang = 'zh' | 'en'

export interface AppSettings {
  ffmpeg_path?: string
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

/** 运行期全局任务的类别。任务中心只保存当前进程内的状态，不落库。 */
export type TaskKind =
  | 'software-scan'
  | 'game-scan'
  | 'video-scan'
  | 'ai-identify'
  | 'organize'
  | 'hanime-verify'
  | 'video-download'
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
  /**
   * 这次是不是绿色版（数据在 exe 旁边的 `data\` 里，不在 AppData）。
   * 开发时恒为 false —— 判据要求 `app.isPackaged`
   */
  portable: boolean
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
  /** 资源类型：software / game / video。0.9 加入，区分各模块的识别日志 */
  resource_kind: 'software' | 'game' | 'video'
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
  /** 按资源类型过滤：software / game / video */
  resource_kind?: string
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
  resource_kind: 'software' | 'game' | 'video'
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

/* ------------------------------ 视频品类 ------------------------------ */

/**
 * 一条视频记录是什么形态。
 *
 * 番剧不单列一种：它的**命名语法**和美剧不一样（见 kinds/video/parser），但
 * 「一部剧下面 N 集」这个形状完全相同。分成三种只会让每个查询都要判三次，
 * 而真正的差别在解析器里，不在数据结构里。
 */
export type VideoType = 'movie' | 'series'
export type VideoFilterType = VideoType | 'hentai'

/**
 * 观看状态。四态闭集，库里有 CHECK 约束兜着（见 kinds/video/schema.ts）。
 *
 * 和游戏的 PlayStatus 同构，理由也一样 —— 但对视频更硬：「掌握」一部电影
 * 基本就等于「看完了」，所以这一列承担了游戏那边 mastery_level 的角色。
 * dropped（弃）留着不是为了对称：一部 60 集的剧看到第 8 集放弃，和「在看」
 * 是两件事，混在一起会让「在看」那个格子永远清不空。
 */
export type WatchStatus = 'unwatched' | 'watching' | 'watched' | 'dropped'

/**
 * 一部电影的一个文件。
 *
 * 存在的理由是分卷：`Movie.CD1.avi` / `Movie.CD2.avi` 是一部电影，
 * 拆成两条记录会让海报墙出现两张同样的海报。多版本（1080p 和 4K、
 * 导演剪辑版和上映版）复用同一个形状 —— v0.7 不为它单独建模。
 *
 * 剧集不用这个：单集进 episode 表，那里有季集号可以排序。
 */
export interface VideoPart {
  path: string
  /** 展示名，如「CD1」「4K 版」。空串时界面上退回文件名 */
  label: string
  file_size: number
  duration_sec: number
}

/** 一条音轨或字幕轨。内嵌轨道来自容器元数据，外挂字幕来自同目录的 .srt / .ass */
export interface MediaTrack {
  /** 容器里的轨道序号。外挂字幕恒为 -1 —— 它不在容器里 */
  index: number
  /** 'zh' / 'en' / ''，读不出来就是空串 */
  language: string
  /** 界面上显示的那行字，如「简中」「杜比全景声」 */
  label: string
  codec: string
  /** 外挂字幕的文件路径；内嵌轨道为空串 */
  path: string
}

/**
 * 剧集的一集。
 *
 * 独立成表而不是塞进 JSON 列：一部剧可以有几百集，而「这一集看到哪儿了」
 * 「这一集文件在不在」都是要按集查询和更新的。JSON 列每次改一集都要
 * 读出整个数组、改一个元素、写回去 —— 两个窗口同时播两集就会互相覆盖。
 *
 * path 允许为空串：那表示**库里知道有这一集，但磁盘上没有文件**。
 * 这不是脏数据，是详情页那一列「在 / 缺」的来源 —— TMDB 说这季 16 集，
 * 用户手上只有 8 个文件，缺的那 8 集该露面，否则用户不知道自己缺什么。
 */
export interface Episode {
  /** 站点发布日期，日期按 UTC 保存；与原作发行/首播日期分开。 */
  published_at?: number
  /** 来源列出的厂牌或作者。 */
  studio?: string
  tags?: string[]
  poster_source?: string
  thumbnail_path?: string
  thumbnail_source?: string
  id: string
  resource_id: string
  season: number
  episode: number
  title: string
  /** 用户或来源提供的非季播标签，例如「上卷」「番外」 */
  display_label?: string
  original_title?: string
  description?: string
  original_description?: string
  poster_path?: string
  source_url?: string
  notes?: string
  /** 空串 = 缺文件 */
  path: string
  file_size: number
  duration_sec: number
  watch_status: WatchStatus
  /** 上次播到第几秒。下次打开跳回这里 */
  position_sec: number
  /** 最后一次看它的时刻，0 表示没看过 */
  watched_at: number
  /** 原作发行/首播日期，0 表示不知道 */
  air_date: number
}

/** video_meta 那张表的形状。resource 的公共字段不在这里，见 VIDEO_VIEW_SQL */
export interface VideoMeta {
  thumbnail_path?: string
  thumbnail_source?: string
  video_type: VideoType
  /**
   * 竖版 2:3 海报。空串 = 还没有，界面退回首字占位。
   *
   * 两个阶段两种值：刮削时先落 TMDB 的相对路径（`/abc.jpg`），Step 6 下载完
   * 覆盖成本地绝对路径。以 `/` 开头且不是本机路径的就是前者 —— 界面要么
   * 拼上图片域名，要么当占位处理，不能直接塞进 `<img src>` 就完事。
   */
  poster_path: string
  poster_source?: string
  collection_name?: string
  fanart_path: string
  /** 电影是一个点，剧集是区间的起点。0 表示不知道 */
  year: number
  /** 剧集的完结年份。0 = 电影，或者还在播 */
  end_year: number
  /** 十分制。0 表示还没刮到评分，不是「评分为零」 */
  rating: number
  watch_status: WatchStatus
  /**
   * 电影播到第几秒。剧集的进度记在 episode 行上 ——
   * 一部剧没有「整部剧播到哪一秒」这种东西。
   */
  position_sec: number
  duration_sec: number
  last_watched_at: number

  /** 以下几项来自文件名解析和容器元数据，是**本地事实**，不是模型猜的 */
  resolution: string
  video_codec: string
  source: string
  release_group: string
  audio_tracks: MediaTrack[]
  subtitle_tracks: MediaTrack[]

  /** 电影的文件。剧集恒为空数组 —— 它的文件在 episode 表里 */
  parts: VideoPart[]
  /** 外挂字幕、NFO、海报原图之类。复用游戏那边的形状 */
  linked_files: LinkedFile[]

  tmdb_id: string
  imdb_id: string
  /**
   * 豆瓣条目 id（`movie.douban.com/subject/<id>/` 里那串数字）。
   * 空串 = 没匹配上。条目页地址能从它拼出来，所以不单独存 URL。
   */
  douban_id: string
  /**
   * 豆瓣评分，十分制。0 = 没拿到，**不是零分**。
   *
   * 和上面的 rating 分开：rating 来自 TMDB 或 nfo，是第一手数据；这个来自
   * 搜索服务商的摘要，可能是几个月前的快照。合成一个数之后，界面就没法
   * 诚实地说这个分是哪儿来的了。
   */
  douban_rating: number
  /**
   * hanime 的 videoCode（`hanime1.me/watch?v=<它>` 里那串数字）。
   * 空串 = 没刮到，或这条不是里番。地位同 `tmdb_id`：有它就能精确重刮。
   */
  hanime_id: string
  /** Hanime 页面原始简介；中文译文仍在 description。 */
  original_description: string
  /** Hanime 页面全部站方标签，不受普通 tags 的数量限制。 */
  hanime_tags: string[]
}

/**
 * 视频视图（VIDEO_VIEW_SQL）的一行。
 *
 * 和 GameItem 一样刻意不复用 SoftwareItem，理由见那边的注释。
 * 三个 episode_* 计数在视图里现算 —— 它们要出现在海报墙的每张卡片上
 * （「3/12 集」），存成列就要在每次改一集观看状态时同步更新两张表，
 * 而视频库是百级规模，子查询的代价可以忽略。
 */
export interface VideoItem extends VideoMeta {
  needs_review?: boolean
  published_start?: number
  published_end?: number
  available_files?: number
  missing_files?: number
  pending_reasons?: string[]
  matched_content?: string
  id: string
  created_at: number
  updated_at: number
  /**
   * 电影：默认那个文件的路径。剧集：整部剧的目录。
   * 同时是 resource.path 那个全局唯一键
   */
  path: string
  file_name: string
  file_size: number
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

  /**
   * 用户在界面上改过、因而不再被重扫覆盖的字段名。
   *
   * 只可能包含刮削猜出来的那些字段（片名 / 简介 / 分类 / 标签 / 年份 / 类型 /
   * 几个刮削 id）。分辨率、编码、时长这类从文件上读出来的事实不进这个名单 ——
   * 换了片源就该跟着变，锁住反而是错的。名单在
   * `electron/kinds/video/db.ts` 的 `PROTECTED_FIELDS`。
   */
  user_edited: string[]

  /** 这部剧一共几集（含缺文件的）。电影恒为 0 */
  episode_total: number
  /** 看完了几集 */
  episode_watched: number
  /** 磁盘上真有文件的几集。和 total 的差就是「缺」的数量 */
  episode_present: number
}

export interface VideoLibraryFilters {
  publishedFrom: string
  publishedTo: string
  status: WatchStatus | ''
  local: 'available' | 'missing' | 'none' | ''
}
export interface VideoQuery {
  publishedFrom?: string
  publishedTo?: string
  local?: 'available' | 'missing' | 'none'
  issue?: 'any' | 'poster' | 'files' | 'metadata' | 'metadata:description' | 'metadata:poster' | 'metadata:review'
  keyword?: string
  type?: VideoFilterType
  collection?: string
  category?: string
  tag?: string
  status?: WatchStatus
  /** 归档区和正常区互斥，和另两个品类同一个约定 */
  group?: 'all' | 'archived'
  sort?: 'name' | 'year' | 'added' | 'rating' | 'updated' | 'published' | 'published-asc'
}

export type { VideoAsset, VideoAssetState, VideoBundle, VideoContentInput, VideoDirectory, VideoOwnership, VideoRegistration, VideoRegistrationResult, VideoSourceRef } from './video-library'

export interface VideoCounts {
  all: number
  archived: number
  /** 电影 / 剧集各有几部。闭集 */
  type: Record<VideoType, number>
  hentai?: number
  hentai_archived?: number
  hentai_visible?: boolean
  collections?: Array<{ name: string; count: number }>
  hentai_collections?: Array<{ name: string; count: number }>
  /** 四个观看状态各有几个。闭集，缺的那个是 0 不是不存在 */
  status: Record<WatchStatus, number>
  categories: Array<{ name: string; count: number }>
  tags: Array<{ name: string; count: number }>
  /** 仅供进入“里番”分类后的标签栏使用。 */
  hanime_tags: Array<{ name: string; count: number }>
}

/**
 * TMDB 刮削配置。
 *
 * 和 AIConfig / SearchConfig 同一个约定：**用户带自己的 key**。TMDB 的个人
 * key 是免费的，注册就有 —— 不内置一个共享 key，那既违反它的服务条款，
 * 也会在额度被打爆的那天让所有用户一起失效。
 *
 * `api_domain` 存在的理由很实际：`api.themoviedb.org` 在国内多数网络下连不上，
 * 而这是个中文用户为主的工具。留一个域名覆盖，用户可以填自己的反代 ——
 * 没有它，刮削这一整步对一大半用户直接是不可用的。
 * `image_domain` 同理（`image.tmdb.org` 是另一个域名，单独被墙）。
 */
export interface TmdbConfig {
  api_key: string
  /** 留空用官方 `api.themoviedb.org`。只填域名，不带协议和路径 */
  api_domain: string
  /** 留空用官方 `image.tmdb.org` */
  image_domain: string
  enabled: boolean
}

/** 视频扫描 + 识别是一条链路上的两截，进度用同一个形状报，同 GameScanProgress */
export interface VideoScanProgress {
  phase: 'scanning' | 'identifying' | 'done'
  /** 正在扫的根目录 / 正在识别的条目路径 */
  current: string
  /** identifying 阶段才有意义；scanning 阶段 total 未知，恒为 0 */
  processed: number
  total: number
  registered: number
  failed: number
  /** agent 最近一步动作的人话翻译 */
  log: string
}

export interface VideoScanResult {
  entries?: Array<{ path: string; resourceId?: string; status: 'new' | 'updated' | 'skipped' | 'review' | 'failed'; message: string }>
  /** 扫出来的候选条目数（电影 + 剧集） */
  candidates: number
  registered: number
  skipped: number
  failed: number
  tokens: number
  /** 这次一共新建了几集。剧集库的「这次扫描有没有用」全靠它 */
  episodes: number
  /**
   * 这次真的走了几趟用户的搜索服务商（豆瓣查询 + web_search）。
   *
   * 按次计费的服务商靠它对账。**进程内缓存命中不计** —— 请求没发出去，
   * 服务商那边也没扣。报一个比账单大的数只会制造疑惑。
   */
  searches: number
}

/**
 * 点一次播放的结果。
 *
 * 为什么带回 `item` 和 `episode`：打开文件这一下会把观看状态从「未看」
 * 抬到「在看」（用户确实打开了它，这是事实），侧栏计数和详情页那个
 * 「3/12 集」都得跟着动。让界面改完再查一趟的话，中间那一瞬两个数字对不上。
 */
export interface VideoPlayOutcome {
  ok: boolean
  /** 失败原因。`ok` 为 false 时一定非空，界面必须显示它 */
  message: string
  item: VideoItem | null
  /** 剧集：实际开的那一集。电影恒为 null */
  episode: Episode | null
}

export type Unsubscribe = () => void

/** preload 暴露给渲染进程的完整 API */
export interface BaoyiApi {
  image: import('./image').ImageApi
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
  }
  game: {
    relocate(id: string, mode?: 'directory' | 'file'): Promise<GameItem | null>
    addManual(): Promise<{ ok: boolean; message: string; item?: GameItem } | null>
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
    launch(id: string): Promise<{ ok: boolean; message: string }>
    /** 这个游戏此刻是不是正被抱一跟着。跟不到的（shell 兜底启动的）一律返回 false */
    running(id: string): Promise<boolean>
    /**
     * 一段游玩结束时的通知。退出时刻由游戏进程决定，界面等不出来，只能推。
     * 条目在游玩过程中被删掉时不会有这条通知。
     */
    onSession(cb: (e: GameSessionEvent) => void): Unsubscribe

    /** 备份一条存档路径。失败时磁盘上不留半成品，也不写记录 */
    backupSave(id: string, savePath: string): Promise<SaveBackupResult>
    /** 一个游戏的备份，新的在前 */
    backups(id: string): Promise<SaveBackup[]>
    /** 还原一份备份。会先把当前存档自动备份一份 */
    restoreBackup(backupId: string): Promise<SaveRestoreResult>
    /** 删一份备份：磁盘上的拷贝和库里的记录一起删 */
    deleteBackup(backupId: string): Promise<{ ok: boolean; message: string }>
    /** 在资源管理器里打开一份备份 */
    openBackup(backupId: string): Promise<void>

    /**
     * 选文件（或目录）挂成关联文件，选完直接落库，返回更新后的条目。
     * 取消返回 null。已经加过的那些会被跳过，不报错。
     */
    pickLinks(id: string, kind: 'file' | 'dir'): Promise<GameItem | null>
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
    revealInFolder(id: string): Promise<void>
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
    bulkUpdate(ids: string[], patch: import('./video-management').VideoBulkPatch): Promise<number>
    importBundle(): Promise<(import('./video-library').VideoRegistrationResult & { scanResult?: VideoScanResult }) | null>
    library(id: string): Promise<import('./video-workflow').VideoWorkLibrary>
    syncFiles(id: string): Promise<import('./video-workflow').VideoLibrarySyncResult>
    previewCollectionName(id: string, title: string): Promise<{ title: string; from: string; to: string }>
    renameCollection(id: string, title: string): Promise<{ title: string; from: string; to: string; warnings: string[] }>
    playAsset(id: string): Promise<VideoPlayOutcome>
    revealAsset(id: string): Promise<boolean>
    relocateAsset(id: string): Promise<boolean>
    setDefaultAsset(episodeId: string, assetId: string): Promise<boolean>
    discovery: import('./video-discovery').DiscoveryApi
    prepareDownload(input: { url?: string; resourceId?: string; discovery?: import('./video-discovery').DiscoverySelection }): Promise<import('./video-workflow').VideoDownloadDraft>
    pickDownloadRoot(draftId: string): Promise<import('./video-workflow').VideoDownloadDraft | null>
    enqueueDownload(request: import('./video-workflow').VideoEnqueueRequest): Promise<import('./video-workflow').VideoDownloadJob>
    downloadJobs(): Promise<import('./video-workflow').VideoDownloadJob[]>
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
    /** 试一次 TMDB：拿配置发一次真实搜索，成了就说搜到了什么 */
    testTmdb(config: TmdbConfig): Promise<{ ok: boolean; message: string }>
    onProgress(cb: (p: AIProgress) => void): Unsubscribe
  }
  data: {
    snapshotInfo(): Promise<import('./library-snapshot').LibrarySafetyInfo>
    createSnapshot(): Promise<import('./library-snapshot').LibrarySnapshotEntry>
    openSnapshotDir(): Promise<void>
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
  }
}

export type {
  VideoDownloadCatalog,
  VideoDownloadProgress,
  VideoDownloadRequest,
  VideoDownloadResult,
  VideoDownloadSource,
  VideoSeriesCatalog,
  VideoSeriesDownloadPhase,
  VideoSeriesDownloadProgress,
  VideoSeriesDownloadRequest,
  VideoSeriesDownloadResult,
  VideoSeriesEpisode,
  VideoSeriesEpisodeResult
} from './video-download'
