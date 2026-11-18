import type { LinkedFile } from './game'

/* ------------------------------ 视频品类 ------------------------------ */

/**
 * 一条视频记录是什么形态。
 *
 * 番剧不单列一种：它的**命名语法**和美剧不一样（见 kinds/video/parser），但
 * 「一部剧下面 N 集」这个形状完全相同。分成三种只会让每个查询都要判三次，
 * 而真正的差别在解析器里，不在数据结构里。
 */
export type VideoType = 'movie' | 'series'

export type VideoFilterType = VideoType | 'hentai' | 'other' | 'audio'

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
  media_kind?: 'video' | 'audio' | 'other'
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

export interface VideoCounts {
  audio?: number
  other?: number
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
