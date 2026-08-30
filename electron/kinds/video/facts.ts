/**
 * 本地事实汇总。把扫描结果、nfo 侧车、容器元数据凑成一份东西。
 *
 * 这是 Step 4 留下的那根线：`scanner.ts` 只把 nfo 路径收在 `sidecars.nfo` 里，
 * `nfo.ts` 和 `mediainfo.ts` 写好了但没人调。接线拖到这一步是有意的 ——
 * 只有到「要把事实塞进 prompt」的时候，才知道该凑成什么形状。
 *
 * ## 这个文件存在的全部理由
 *
 * v0.7 计划里那条压着一切的原则：
 *
 * > 能在本地读到的事实，不该让模型去猜。
 *
 * 落到代码上就是：agent 拿到任务时，标题、年份、季集、分辨率、编码、音轨、
 * 时长、TMDB id 这些**已经是确定值了**。它不需要为此调用任何工具，
 * 也就不会为此烧掉一轮往返。它剩下要判断的只有真需要判断力的事：
 * 这堆文件是不是同一部剧、认名字（尤其中文译名）、归哪个分类。
 *
 * v0.6 那次教训的具体形态是：苏丹的游戏，答案在 82 字节的 `app.info` 里，
 * 却烧掉六次探测。视频这边本地事实比游戏多得多，一条都不该浪费。
 *
 * ## 优先级：nfo > 容器 > 文件名
 *
 * 三个来源会给出冲突的值，顺序是想清楚的：
 *
 * - **nfo 最高**。它是别的媒体中心刮削或用户手工写下的**结论**，
 *   而且常常直接带 TMDB / IMDB id —— 有 id，刮削就是一次精确查询。
 * - **容器居中**。它是文件本身的物理事实，不会错，但它只知道「1920x1080」
 *   不知道「这是 1080p 蓝光原盘还是 1080p 网络流」。
 * - **文件名最低**，但覆盖面最广。它是唯一会写「片源」和「发布组」的地方。
 *
 * 唯一的例外是**分辨率 / 编码 / 时长**：容器压过文件名。文件名可能写错
 * （改名转发的片子上写着 1080p 实际是 720p 的重编码），容器不会。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import type { MediaTrack, VideoPart } from '../../../src/types'
import type { VideoCandidate, VideoFile } from './scanner.ts'
import { parseNfo, parseNfoEpisodes, type NfoData } from './nfo.ts'
import { readContainerInfo, type ContainerInfo } from './mediainfo.ts'

/* ============================== 输出形状 ============================== */

/** 一集的本地事实 */
export interface EpisodeFacts {
  season: number
  episode: number
  /** 标题。nfo 里有就用它，否则从文件名切出来的那个，都没有是空串 */
  title: string
  /** 主文件路径。分卷时是第一卷 */
  path: string
  file_size: number
  duration_sec: number
  /** 首播日期的 Unix 秒。0 = 不知道 */
  air_date: number
}

/**
 * 一条候选的全部本地事实。
 *
 * 所有字段都有零值，含义统一是「本地读不到」。这一条和 `NfoData`
 * `ContainerInfo` 的约定一致 —— 调用方永远拿到完整形状。
 */
export interface VideoFacts {
  video_type: 'movie' | 'series'
  /** resource.path 那个全局唯一键，原样从扫描结果来 */
  path: string
  /** 这条东西所在的目录。剧集就是 path 自己 */
  dir: string

  /** 标题候选，按可信度排好。第一个是最可能对的那个，交给 agent 定 */
  title_zh: string
  title_en: string
  /** nfo 里的原名。和 title_en 可能不同（日语原名之类） */
  original_title: string
  year: number

  /** 以下来自 nfo，是别家刮削过的结论 */
  tmdb_id: string
  imdb_id: string
  tvdb_id: string
  plot: string
  nfo_rating: number
  genres: string[]
  directors: string[]
  actors: string[]
  studios: string[]
  countries: string[]
  /** 剧集状态（`Ended` / `Continuing`），只有 tvshow nfo 会写 */
  status: string

  /** 以下来自容器元数据 + 文件名解析，是物理事实 */
  duration_sec: number
  resolution: string
  video_codec: string
  source: string
  release_group: string
  audio_tracks: MediaTrack[]
  subtitle_tracks: MediaTrack[]
  /** 电影的文件（含分卷）。剧集恒为空数组 */
  parts: VideoPart[]

  /** 剧集的集列表。电影是空数组 */
  episodes: EpisodeFacts[]
  /** 磁盘上真有文件的集数。和 episodes.length 相等，留着是为了 prompt 里说话方便 */
  episode_files: number
  /** 出现过的季号，排好去重 */
  seasons: number[]

  /** 外挂字幕的路径 */
  external_subtitles: string[]
  /** 侧车海报 / 背景图候选 */
  images: string[]
  /** 读到的 nfo 文件路径。空数组 = 一个都没有 */
  nfo_files: string[]
  /** 被判为花絮剔掉的文件 */
  extras: Array<{ path: string; kind: string }>

  /** 人类可读的判据，原样进 prompt */
  evidence: string[]
}

export function emptyFacts(): VideoFacts {
  return {
    video_type: 'movie',
    path: '',
    dir: '',
    title_zh: '', title_en: '', original_title: '', year: 0,
    tmdb_id: '', imdb_id: '', tvdb_id: '', plot: '', nfo_rating: 0,
    genres: [], directors: [], actors: [], studios: [], countries: [], status: '',
    duration_sec: 0, resolution: '', video_codec: '', source: '', release_group: '',
    audio_tracks: [], subtitle_tracks: [], parts: [],
    episodes: [], episode_files: 0, seasons: [],
    external_subtitles: [], images: [], nfo_files: [], extras: [],
    evidence: []
  }
}

/* ============================== nfo 挑选 ============================== */

/**
 * 一堆 nfo 里哪一个是这条东西的主 nfo。
 *
 * Kodi 的惯例是一部剧的目录里有 `tvshow.nfo`（整部剧）+ 每集一个同名 nfo。
 * 电影那边是 `movie.nfo` 或者与视频文件同名的 nfo。
 *
 * 挑错的代价是具体的：拿一集的 nfo 当整部剧的，简介会变成「第 3 集：……」，
 * 而 tmdb_id 会是那一集的 id —— 拿它去刮削会刮到一集而不是一部剧。
 * 所以这里按 kind 筛，不只看文件名。
 */
export function pickMainNfo(parsed: Array<{ file: string; data: NfoData }>, type: 'movie' | 'series'): { file: string; data: NfoData } | null {
  if (parsed.length === 0) return null
  const want = type === 'series' ? 'tvshow' : 'movie'

  // 第一优先：根标签就对得上
  const exact = parsed.find((p) => p.data.kind === want)
  if (exact) return exact

  // 第二优先：文件名叫 tvshow.nfo / movie.nfo（内容可能是坏的，但意图明确）
  const byName = parsed.find((p) => path.basename(p.file).toLowerCase() === `${want}.nfo`)
  if (byName) return byName

  // 剧集找不到 tvshow.nfo 时，**不拿单集 nfo 顶替**，只把它的 id 借出来 ——
  // 同一部剧的单集 nfo 里的 uniqueid 常常是剧的 id（Kodi 会写 tvshow 的），
  // 但简介和标题一定是那一集的。借 id 不借文本，在 buildFacts 里做
  if (type === 'series') return null

  // 电影：退回第一个不是 episode 的
  return parsed.find((p) => p.data.kind !== 'episode') ?? null
}

/* ============================== 合并 ============================== */

/** 非空的那个优先，都空给空串 */
function firstNonEmpty(...vals: Array<string | undefined>): string {
  for (const v of vals) {
    const s = String(v ?? '').trim()
    if (s) return s
  }
  return ''
}

/** 大于零的那个优先 */
function firstPositive(...vals: Array<number | undefined>): number {
  for (const v of vals) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

/** 合并去重，保持先来的顺序 */
function mergeList(...lists: Array<string[] | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const l of lists) {
    for (const v of l ?? []) {
      const s = String(v ?? '').trim()
      if (!s || seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/**
 * 把三个来源合成一条事实。**纯函数**，不读文件 —— 自检拿固定输入验每条优先级规则。
 *
 * 这一层是 Step 5 里最值得测的东西：读文件读得到读不到是运行环境的事，
 * 而「nfo 的年份该压过文件名的年份」「容器的分辨率该压过文件名的」
 * 这些规则错了不报错，只让界面上显示一个错的值。
 */
export function mergeFacts(
  candidate: VideoCandidate,
  nfo: NfoData | null,
  episodeNfos: Map<string, NfoData>,
  containers: Map<string, ContainerInfo>,
  extraIds: { tmdb?: string; imdb?: string; tvdb?: string } = {}
): VideoFacts {
  const f = emptyFacts()
  f.video_type = candidate.video_type
  f.path = candidate.path
  f.dir = candidate.video_type === 'series' ? candidate.path : path.dirname(candidate.path)
  f.evidence = [...candidate.evidence]

  /* -------- 标题与年份：nfo 压过扫描结果 -------- */
  // nfo 的 title 可能是中文也可能是英文，判不出来的就两边都不填 ——
  // 让 agent 去认，那正是它该干的活
  const nfoTitle = nfo ? firstNonEmpty(nfo.title, nfo.show_title) : ''
  const nfoIsCjk = /[一-鿿぀-ヿ]/.test(nfoTitle)
  f.title_zh = firstNonEmpty(nfoIsCjk ? nfoTitle : '', candidate.title_zh)
  f.title_en = firstNonEmpty(nfoIsCjk ? '' : nfoTitle, candidate.title_en)
  f.original_title = nfo?.original_title ?? ''
  f.year = firstPositive(nfo?.year, candidate.year)

  /* -------- id：nfo 直给，或者从单集 nfo 借 -------- */
  f.tmdb_id = firstNonEmpty(nfo?.tmdb_id, extraIds.tmdb)
  f.imdb_id = firstNonEmpty(nfo?.imdb_id, extraIds.imdb)
  f.tvdb_id = firstNonEmpty(nfo?.tvdb_id, extraIds.tvdb)

  /* -------- nfo 独有的那些 -------- */
  if (nfo) {
    f.plot = firstNonEmpty(nfo.plot, nfo.outline)
    f.nfo_rating = nfo.rating
    f.genres = mergeList(nfo.genres)
    f.directors = mergeList(nfo.directors)
    f.actors = nfo.actors.map((a) => a.name).filter(Boolean).slice(0, 12)
    f.studios = mergeList(nfo.studios)
    f.countries = mergeList(nfo.countries)
    f.status = nfo.status
  }

  /* -------- 技术事实 -------- */
  // 电影：本体文件（含分卷）。剧集：拿第一集当代表 —— 一部剧的分辨率和编码
  // 逐集可能不同（前半季 720p 后半季 1080p），但详情页上要显示一个值，
  // 取第一集比取「混合」有意义，也比留空有意义
  const repFiles: VideoFile[] =
    candidate.video_type === 'movie'
      ? candidate.files
      : (candidate.episodes[0]?.files ?? [])

  const rep = repFiles[0]
  const repContainer = rep ? containers.get(rep.path) : undefined

  if (rep) {
    // 容器压过文件名：文件名可能写错（改名转发的片子），容器不会
    f.resolution = firstNonEmpty(repContainer?.resolution, rep.parsed.resolution)
    f.video_codec = firstNonEmpty(repContainer?.video_codec, rep.parsed.video_codec)
    f.audio_tracks = repContainer?.audio_tracks ?? []
    f.subtitle_tracks = [...(repContainer?.subtitle_tracks ?? [])]
    // 片源和发布组只有文件名知道，容器里没有这个概念
    f.source = rep.parsed.source
    f.release_group = rep.parsed.release_group
  }

  /* -------- 时长 -------- */
  if (candidate.video_type === 'movie') {
    // 分卷电影的时长是各卷之和 —— 一部被切成两半的片子，总时长才是它的片长
    const sum = candidate.files.reduce((acc, file) => acc + (containers.get(file.path)?.duration_sec ?? 0), 0)
    // nfo 的 runtime 是分钟，且是别人写的结论，只在容器读不出来时用
    f.duration_sec = firstPositive(sum, (nfo?.runtime_min ?? 0) * 60)
    f.parts = candidate.files.map((file) => ({
      path: file.path,
      label: file.part !== null ? `CD${file.part}` : '',
      file_size: file.size,
      duration_sec: containers.get(file.path)?.duration_sec ?? 0
    }))
  } else {
    // 剧集：video_meta.duration_sec 是**单集时长**，不是整部剧的总长。
    // 整部剧的总长对用户没有意义（没人问「这部剧一共多少秒」），
    // 而单集时长决定详情页上每一集显示多长
    f.duration_sec = firstPositive(repContainer?.duration_sec, (nfo?.runtime_min ?? 0) * 60)
  }

  /* -------- 集列表 -------- */
  for (const ep of candidate.episodes) {
    const head = ep.files[0]
    if (!head) continue
    const epNfo = episodeNfos.get(head.path)
    const container = containers.get(head.path)
    f.episodes.push({
      season: ep.season,
      episode: ep.episode,
      title: firstNonEmpty(epNfo?.title, ep.title),
      path: head.path,
      // 分卷的一集，大小是各卷之和
      file_size: ep.files.reduce((acc, x) => acc + x.size, 0),
      duration_sec: firstPositive(container?.duration_sec, (epNfo?.runtime_min ?? 0) * 60),
      air_date: epNfo?.premiered_ts ?? 0
    })
  }
  f.episode_files = f.episodes.length
  f.seasons = [...new Set(f.episodes.map((e) => e.season))].sort((a, b) => a - b)

  /* -------- 侧车 -------- */
  f.external_subtitles = [...candidate.sidecars.subtitles]
  f.images = [...candidate.sidecars.images]
  f.nfo_files = [...candidate.sidecars.nfo]
  f.extras = [...candidate.extras]

  // 外挂字幕并进字幕轨列表。index 恒为 -1 —— 它不在容器里，这一条是
  // MediaTrack 那个类型上写明的约定
  for (const sub of f.external_subtitles) {
    f.subtitle_tracks.push({
      index: -1,
      language: guessSubtitleLanguage(path.basename(sub)),
      label: path.basename(sub),
      codec: path.extname(sub).replace('.', '').toUpperCase(),
      path: sub
    })
  }

  return f
}

/**
 * 从字幕文件名猜语言。
 *
 * 只认明确写出来的标记，认不出来给空串 —— 和 `filename.ts` 里
 * `literalResolution` 同一条原则：宁可留空，不编一个。猜错的代价是
 * 用户点开「中文字幕」得到一轨英文，比没有标记更烦。
 */
export function guessSubtitleLanguage(name: string): string {
  const s = String(name ?? '').toLowerCase()
  if (/简体|简中|chs|\bgb\b|zh-?cn|sc(?=[._-]|$)/.test(s)) return 'zh'
  if (/繁体|繁中|cht|\bbig5\b|zh-?tw|zh-?hk|tc(?=[._-]|$)/.test(s)) return 'zh'
  if (/中文|chinese|\bchi\b|\bzho\b|\bzh\b/.test(s)) return 'zh'
  if (/英文|english|\beng\b|\ben\b/.test(s)) return 'en'
  if (/日文|日语|japanese|\bjpn\b|\bja\b/.test(s)) return 'ja'
  if (/韩文|韩语|korean|\bkor\b|\bko\b/.test(s)) return 'ko'
  return ''
}

/* ============================== 读 ============================== */

/** 单个 nfo 最多读多少字节。带完整演员表和多语言简介的 nfo 能到几百 KB */
const NFO_MAX_BYTES = 512 * 1024

/**
 * 读一个 nfo。读不出来或解不出来返回 null，**不抛**。
 *
 * 和 `readContainerInfo` 同一个约定：一个坏文件不该停下整次扫描。
 */
async function readNfo(file: string): Promise<NfoData | null> {
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size === 0) return null
    const buf = Buffer.alloc(Math.min(stat.size, NFO_MAX_BYTES))
    const handle = await fsp.open(file, 'r')
    try {
      await handle.read(buf, 0, buf.length, 0)
    } finally {
      await handle.close()
    }
    // nfo 规范上是 UTF-8，但老库里有 GBK 的。这里只做 BOM 剥离 + UTF-8 解码：
    // parseNfo 对解成乱码的内容会走 urlOnlyNfo 兜底，至少还能捞到 id。
    // 引 files.ts 的 decodeText 会让这个文件依赖 agent 那一层，不值得
    return parseNfo(buf.toString('utf8'))
  } catch {
    return null
  }
}

/** 一个 nfo 里的所有 episodedetails。同样不抛 */
async function readNfoEpisodes(file: string): Promise<NfoData[]> {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return parseNfoEpisodes(raw)
  } catch {
    return []
  }
}

/** 一次最多读几个 nfo。一部 60 集的剧配 60 个 nfo，全读一遍不划算也没必要 */
const MAX_NFO_READS = 24
/**
 * 一次最多读几个视频文件的容器元数据。
 *
 * 一部剧不需要每集都读：详情页要的单集时长取第一集就够，而每读一集
 * 都是一次 WASM 解析 + 磁盘随机读。剧集只读前几集，电影读全部分卷。
 */
const MAX_CONTAINER_READS = 6

/**
 * 把一条扫描候选补成完整的本地事实。这一层碰 fs。
 *
 * 读的量刻意有上限：一部 60 集的剧全读 nfo 加全读容器是 120 次磁盘往返，
 * 而它们给出的增量信息几乎为零（第 7 集的分辨率和第 1 集一样）。
 * 上限之外的集只保留文件名解析出来的部分 —— 集号、标题、大小都还在。
 */
export async function buildFacts(candidate: VideoCandidate): Promise<VideoFacts> {
  /* -------- nfo -------- */
  const parsed: Array<{ file: string; data: NfoData }> = []
  for (const file of candidate.sidecars.nfo.slice(0, MAX_NFO_READS)) {
    const data = await readNfo(file)
    if (data) parsed.push({ file, data })
  }

  const main = pickMainNfo(parsed, candidate.video_type)

  /* -------- 单集 nfo：按视频文件路径索引 -------- */
  // Kodi 的惯例是集 nfo 与视频文件同名（`S01E01.mkv` 配 `S01E01.nfo`），
  // 所以按去掉扩展名的路径对齐。对不上的不硬凑 —— 挂错一集的标题
  // 比不挂标题糟，而用户在集列表上一眼看得见
  const episodeNfos = new Map<string, NfoData>()
  const stemOf = (p: string): string =>
    path.join(path.dirname(p), path.basename(p, path.extname(p))).toLowerCase()
  const nfoByStem = new Map<string, NfoData>()
  for (const p of parsed) {
    if (p.data.kind === 'episode') nfoByStem.set(stemOf(p.file), p.data)
  }
  for (const ep of candidate.episodes) {
    for (const file of ep.files) {
      const hit = nfoByStem.get(stemOf(file.path))
      if (hit) episodeNfos.set(file.path, hit)
    }
  }

  /* -------- 借 id：剧集没有 tvshow.nfo 时，从单集 nfo 里借 -------- */
  // 只借 id 不借文本，理由见 pickMainNfo
  const extraIds: { tmdb?: string; imdb?: string; tvdb?: string } = {}
  if (!main) {
    const anyEp = parsed.find((p) => p.data.tmdb_id || p.data.imdb_id || p.data.tvdb_id)
    if (anyEp) {
      extraIds.tmdb = anyEp.data.tmdb_id
      extraIds.imdb = anyEp.data.imdb_id
      extraIds.tvdb = anyEp.data.tvdb_id
    }
  }

  /* -------- 多集合并的 nfo：一个文件里两段 episodedetails -------- */
  // `S01E01E02.mkv` 配的 nfo 里有两段。扫描器那边这种文件也确实拆成两集，
  // 两边对得上 —— 但主 nfo 那条路只取了第一段，所以这里单独补一次
  for (const p of parsed) {
    if (p.data.kind !== 'episode') continue
    const all = await readNfoEpisodes(p.file)
    if (all.length <= 1) continue
    const stem = stemOf(p.file)
    for (const ep of candidate.episodes) {
      for (const file of ep.files) {
        if (stemOf(file.path) !== stem) continue
        const match = all.find((e) => e.episode === ep.episode && (e.season === ep.season || e.season < 0))
        if (match) episodeNfos.set(file.path, match)
      }
    }
  }

  /* -------- 容器元数据 -------- */
  const targets: string[] =
    candidate.video_type === 'movie'
      ? candidate.files.map((f) => f.path).slice(0, MAX_CONTAINER_READS)
      : candidate.episodes.slice(0, MAX_CONTAINER_READS).flatMap((e) => (e.files[0] ? [e.files[0].path] : []))

  const containers = new Map<string, ContainerInfo>()
  for (const target of targets) {
    const info = await readContainerInfo(target)
    if (info) containers.set(target, info)
  }

  const facts = mergeFacts(candidate, main?.data ?? null, episodeNfos, containers, extraIds)

  /* -------- 把「读到了什么」记进 evidence -------- */
  // 这几行会原样进 prompt。写清楚「id 是从 nfo 读到的」比让模型自己发现要省一轮
  if (main) {
    facts.evidence.push(`读到 ${path.basename(main.file)}（${main.data.kind}）`)
  } else if (parsed.length > 0) {
    facts.evidence.push(`有 ${parsed.length} 个 nfo，但没有整部剧/整部电影级别的那个`)
  }
  if (facts.tmdb_id) facts.evidence.push(`nfo 里带 TMDB id：${facts.tmdb_id}`)
  if (facts.imdb_id) facts.evidence.push(`nfo 里带 IMDB id：${facts.imdb_id}`)
  if (containers.size > 0) {
    facts.evidence.push(`读了 ${containers.size} 个文件的容器元数据`)
  } else if (targets.length > 0) {
    // 读不出来是有信息量的：可能是外置硬盘没插、可能是文件损坏，
    // 也可能 WASM 没加载起来。让它露面而不是静默留空
    facts.evidence.push('容器元数据一个都没读出来（文件可能不可访问或已损坏）')
  }

  return facts
}
