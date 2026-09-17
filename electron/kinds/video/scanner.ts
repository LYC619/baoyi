/**
 * 视频目录扫描：把一棵文件树分成「一条一条能入库的东西」。
 *
 * 和 game/scanner.ts 一样只读文件系统，不碰数据库、不碰 Electron，
 * 所以 npm run selfcheck 能拿真实的临时目录树把它整个跑一遍。
 *
 * 但要回答的问题比游戏那边难一档。游戏是「一个目录 = 一个游戏」，
 * 简单到不需要讨论；视频这边（见 v0.7 计划「什么算一条记录」）：
 *
 * - 一部电影可能是一个文件，也可能是一个文件夹（本体 + 字幕 + 海报 + 花絮）
 * - 一部剧是一个文件夹里 N 集跨 M 季
 * - 一部电影可能被切成 CD1/CD2 两个文件
 *
 * 决定是 `resource` 一条 = 一部电影 / 一整部剧，单集进 `episode` 表。
 * 所以这里的输出单位是「候选条目」，剧集候选带一串 episode。
 *
 * 规格来源：jellyfin 的 `Emby.Naming/`（GPL，**只当规格读，没抄代码**）——
 * 季目录的关键词表、FileStackRule 的分卷正则形状、ExtraRule 那三类花絮规则
 * （目录名 / 文件名 / 后缀）。文件名本身的解析全部走 ./filename.ts，
 * 这里只做「文件之间怎么归堆」这一件事。
 */

import fs from 'node:fs'
import path from 'node:path'
import { detectExtra, parseVideoName, splitTitle, titleRegion } from './filename.ts'
import type { ParsedVideoName } from './filename.ts'

/* ============================== 常量表 ============================== */

/**
 * 视频扩展名。取 Emby.Naming 那张表里实际会出现在个人片库里的部分。
 *
 * 刻意**不收** `.iso` / `.img` / `.bin` / `.001`：它们是光盘镜像和分卷压缩包，
 * 播放器打不开，mediainfo 也读不出东西，收进来只会在海报墙上摆一个永远
 * 点不动的格子。用户真有镜像库的话那是另一个功能，不是这一步的事。
 */
const VIDEO_EXTS = new Set([
  '.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.flv', '.webm', '.rmvb', '.rm',
  '.mpg', '.mpeg', '.m2ts', '.ts', '.mts', '.m2v', '.vob', '.ogm', '.ogv',
  '.divx', '.mk3d', '.3gp', '.asf', '.mxf', '.f4v'
])

/** 外挂字幕。同 Emby.Naming 的 SubtitleFileExtensions */
const SUBTITLE_EXTS = new Set(['.srt', '.ass', '.ssa', '.sub', '.idx', '.sup', '.vtt', '.smi', '.sami', '.mks'])

/** 图片侧车。按 Kodi / Jellyfin 惯例 */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tbn'])

/**
 * 遍历护栏。和游戏那边不同，这里 `extras` / `specials` 这类**不放进来** ——
 * 它们要走花絮规则被识别成花絮或第 0 季，跳过就丢了信息。
 */
const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', '.git', 'node_modules',
  '@eadir', '.@__thumb', 'lost+found', '.trash', '.trashes'
])

/**
 * 花絮目录。命中的目录里所有视频都是附属内容，不该成为条目。
 *
 * `specials` 和 `extras` **不在这张表里**：Kodi / Jellyfin 的惯例是
 * `Specials/` 就是第 0 季（SP、OVA 放这儿），是正片的一部分，
 * 用户会想看也会想标记看过。把它当花絮剔掉是实打实的丢数据。
 */
const EXTRA_DIRS = new Set([
  'trailers', 'trailer', 'sample', 'samples', 'backdrops', 'theme-music',
  'behind the scenes', 'behindthescenes', 'deleted scenes', 'deletedscenes',
  'interviews', 'scenes', 'featurettes', 'extrafanart',
  '花絮', '预告', '预告片', '幕后', '删减片段', '访谈', '特典'
])

/** 第 0 季的目录名。这两个名字底下的东西是正片，不是花絮 */
const SPECIAL_DIRS = new Set(['specials', 'special', 'sp', '特别篇', '番外', '剧场版之外'])

/**
 * 季目录的关键词。取 Emby.Naming 的 SeasonKeywordPattern，
 * 砍掉本项目用不到的小语种，补上中文。
 */
const SEASON_WORDS = 'season|saison|staffel|series|stagione|temporada|sezon|시즌|シーズン|сезон'

/**
 * 分卷规则。形状照 Emby.Naming 的 VideoFileStackingRules，
 * 但**只认数字卷号，不认字母卷号**（原版有 `cd[a-d]` 那条）。
 *
 * 理由和 filename.ts 里不认 `Part N` 是同一条：分卷宁可漏认，不能错认。
 * 漏认的代价是用户手动合并一次；错认的代价是两部片子消失成一部，
 * 而用户在海报墙上看不出少了什么。字母卷号在中文片库里基本不存在，
 * 但 `Movie.CDa.mkv` 这种形状离 `Movie.CD.mkv` 只差一个字母，不值当冒险。
 */
const STACK_RE = /^(?<stem>.*?)(?:(?<=[\])}])|[ _.-]+)[([]?(?:cd|dvd|dis[ck])[ _.-]*(?<num>\d{1,2})[)\]]?$/i

/* ============================== 输出形状 ============================== */

/** 一个视频文件，以及从它文件名里解析出来的一切 */
export interface VideoFile {
  /** 绝对路径 */
  path: string
  /** 文件名（带扩展名） */
  name: string
  size: number
  parsed: ParsedVideoName
  /**
   * 分卷号。来自文件名（`Movie.CD1.mkv`）。null = 不是分卷。
   * 注意和 `parsed.part` 是同一件事，这里重新取一遍是因为归堆要用。
   */
  part: number | null
}

/** 剧集候选下面的一集 */
export interface EpisodeEntry {
  season: number
  episode: number
  /** 同一集的所有文件。分卷时会有多个，按卷号排好 */
  files: VideoFile[]
  /** 这一集自己的标题，从文件名里能切出来就填，切不出来是空串 */
  title: string
}

/** 一条候选条目 = 未来的一条 resource */
export interface VideoCandidate {
  /** 'movie' | 'series' */
  video_type: 'movie' | 'series'
  /**
   * 这条东西的路径。文件夹形态时是文件夹，散装单文件时是文件本身。
   * 这个值会落进 resource.path，是全局唯一键，所以必须是真实路径的原样大小写。
   */
  path: string
  title_zh: string
  title_en: string
  year: number
  /** 实际内容目录；共享目录的条目 path 可以是代表文件。 */
  directory?: string
  shared_directory?: boolean
  /** 同目录作品，仅作为 agent 判断命名分组的上下文。 */
  sibling_titles?: string[]
  /** 电影：本体文件（分卷时多个）。剧集：空数组，内容在 episodes 里 */
  files: VideoFile[]
  /** 剧集的集列表，按季、集排好。电影是空数组 */
  episodes: EpisodeEntry[]
  /** 侧车文件的绝对路径，按类分好。给 Step 4 读 nfo 和 Step 6 找海报用 */
  sidecars: { nfo: string[]; images: string[]; subtitles: string[] }
  /**
   * 被判为花絮而剔除掉的文件。**不是丢掉，是记下来。**
   *
   * v0.6 那条教训的同构物：能在本地读到的事实不该丢。用户如果发现某部片
   * 少了一个文件，答案得能查到，而不是让人怀疑扫描器吃了东西。
   */
  extras: Array<{ path: string; kind: string }>
  /** 人类可读的判据，原样进 prompt。空数组是有意义的：认出来了但说不出凭什么 */
  evidence: string[]
}

/* ============================== 目录名解析 ============================== */

/**
 * 季目录名 -> 季号。不是季目录返回 null。
 *
 * 认这几种：`S01` / `Season 1` / `第一季` / `1` / `Specials`。
 *
 * 和 Emby.Naming 的 SeasonPathParser 有一处**故意的不同**：原版有个
 * `supportNumericSeasonFolders` 开关，允许纯数字目录名当季号。这里默认关掉，
 * 只有当同级还有别的目录也是纯数字、或者兄弟里有明确的季目录时才认 ——
 * 因为纯数字目录名在中文片库里更常见的含义是年份（`2019/`）或画质（`1080/`）。
 * 这个上下文判断在 groupSeries 里做，这个函数只回答字面能不能读出季号。
 */
export function parseSeasonFolder(name: string): { season: number; kind: 'marked' | 'numeric' } | null {
  const raw = String(name ?? '').trim()
  if (!raw) return null
  const lower = raw.toLowerCase()

  if (SPECIAL_DIRS.has(lower)) return { season: 0, kind: 'marked' }

  // S01 / S1 —— 后面不能跟 E，那是单集文件不是季目录
  const sxx = /^s(\d{1,3})(?![\de])/i.exec(raw)
  if (sxx) return { season: Number(sxx[1]), kind: 'marked' }

  // Season 1 / 第一季 / 1st Season
  const post = new RegExp(`^\\s*(?:${SEASON_WORDS})[ ._-]*(\\d{1,3})\\b`, 'i').exec(raw)
  if (post) return { season: Number(post[1]), kind: 'marked' }
  const pre = new RegExp(`^\\s*(\\d{1,3})(?:st|nd|rd|th|\\.)*[ ._-]*(?:${SEASON_WORDS})\\b`, 'i').exec(raw)
  if (pre) return { season: Number(pre[1]), kind: 'marked' }

  const cn = /^第\s*([0-9一二三四五六七八九十百零]+)\s*季$/.exec(raw)
  if (cn) {
    const n = cnFolderNumber(cn[1])
    if (n > 0) return { season: n, kind: 'marked' }
  }

  // 纯数字。标成 numeric，由调用方结合上下文决定认不认
  if (/^\d{1,3}$/.test(raw)) {
    const n = Number(raw)
    // 1900-2099 排除掉：那是年份目录，不是第 1998 季
    if (n >= 1900) return null
    return { season: n, kind: 'numeric' }
  }

  return null
}

/** 目录名里的中文数字。只处理 1-99，够用了（没有第一百季的剧） */
function cnFolderNumber(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw)
  const D: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9
  }
  const s = String(raw)
  if (s === '十') return 10
  const m = /^(.*?)十(.*)$/.exec(s)
  if (m) {
    const tens = m[1] === '' ? 1 : (D[m[1]] ?? 0)
    const ones = m[2] === '' ? 0 : (D[m[2]] ?? 0)
    return tens * 10 + ones
  }
  return D[s] ?? 0
}

/** 花絮目录？ */
export function isExtraDir(name: string): boolean {
  return EXTRA_DIRS.has(String(name ?? '').trim().toLowerCase())
}

/* ============================== 分卷 ============================== */

/**
 * 拆出分卷的「同一部片」键和卷号。不是分卷返回 null。
 *
 * 传进来的是**去掉扩展名**的文件名。
 */
export function stackParts(baseName: string): { stem: string; part: number } | null {
  const m = STACK_RE.exec(String(baseName ?? ''))
  if (!m?.groups) return null
  const stem = m.groups.stem.replace(/[ _.-]+$/, '')
  // stem 空掉说明整个文件名就是个 `CD1`，那不是分卷标记而是文件名本身
  if (!stem) return null
  return { stem, part: Number(m.groups.num) }
}

/* ============================== 遍历 ============================== */

interface RawFile {
  path: string
  name: string
  base: string
  ext: string
  size: number
  /** 相对 root 的目录段，root 直下是空数组 */
  segs: string[]
}

/** 一层一层走下去，把文件按扩展名分类收好。深度护栏 8 层 —— 再深就不是片库了 */
function collect(root: string, maxDepth = 8): RawFile[] {
  const out: RawFile[] = []
  const walk = (dir: string, segs: string[]): void => {
    if (segs.length > maxDepth) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      // 权限不足 / 目录正被删。跳过这一枝，不要让整次扫描炸掉
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue
        walk(full, [...segs, e.name])
        continue
      }
      if (!e.isFile()) continue
      const ext = path.extname(e.name).toLowerCase()
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        // 读不到大小不影响归堆，留 0
      }
      out.push({ path: full, name: e.name, base: e.name.slice(0, e.name.length - ext.length), ext, size, segs })
    }
  }
  walk(root, [])
  return out
}

/* ============================== 主流程 ============================== */

/**
 * 扫一个根目录，返回候选条目。
 *
 * 归堆的顺序是**从确定性最高的信号开始**，一层一层往下退：
 *
 *   1. 有季目录（`Season 1/`、`S01/`）—— 剧，且季号是目录给的，最硬
 *   2. 文件名里有季集标记（`S01E02`）—— 剧，季号从文件名来
 *   3. 一个目录里 ≥3 个文件共享同一个标题词干 —— 剧，用 hintSeries 补解析
 *   4. 剩下的按目录/文件当电影
 *
 * 这个顺序不能反过来。反过来的话一部叫《第二季》的电影会把整个目录带偏，
 * 而按目录结构先判的话，目录结构本身就是用户整理时的意图表达，比文件名可信。
 */
export function scanVideoRoot(root: string): VideoCandidate[] {
  const raws = collect(root)
  const videos = raws.filter((r) => VIDEO_EXTS.has(r.ext))
  if (videos.length === 0) return []

  // 侧车按所在目录索引好，归堆完再按目录发下去
  const sidecarsByDir = new Map<string, { nfo: string[]; images: string[]; subtitles: string[] }>()
  for (const r of raws) {
    if (VIDEO_EXTS.has(r.ext)) continue
    const bucket = sidecarsByDir.get(path.dirname(r.path)) ?? { nfo: [], images: [], subtitles: [] }
    if (r.ext === '.nfo') bucket.nfo.push(r.path)
    else if (IMAGE_EXTS.has(r.ext)) bucket.images.push(r.path)
    else if (SUBTITLE_EXTS.has(r.ext)) bucket.subtitles.push(r.path)
    else continue
    sidecarsByDir.set(path.dirname(r.path), bucket)
  }

  // 先分出花絮。目录规则优先于文件名规则 —— `Featurettes/正片名.mkv` 是花絮，
  // 哪怕文件名看起来像正片
  const extras: Array<{ path: string; kind: string; segs: string[] }> = []
  const keep: RawFile[] = []
  for (const v of videos) {
    const dirHit = v.segs.find((s) => isExtraDir(s))
    if (dirHit) {
      extras.push({ path: v.path, kind: dirHit.toLowerCase(), segs: v.segs })
      continue
    }
    const nameHit = detectExtra(v.name)
    if (nameHit.is_extra) {
      extras.push({ path: v.path, kind: nameHit.kind, segs: v.segs })
      continue
    }
    keep.push(v)
  }

  // 每个留下的文件解析文件名。hintSeries 这一轮先不给，等下面判出形态再补解析
  const parsed = keep.map((r) => ({ raw: r, p: parseVideoName(r.name) }))

  // 按「条目根目录」分组。条目根 = 从 root 往下走，遇到第一个不是季目录的那一层
  const groups = new Map<string, typeof parsed>()
  for (const item of parsed) {
    const key = entryRoot(root, item.raw.segs)
    const arr = groups.get(key)
    if (arr) arr.push(item)
    else groups.set(key, [item])
  }

  const out: VideoCandidate[] = []
  for (const [dir, items] of groups) {
    const { series, movies } = partitionWorks(dir, items)
    const shared = series.size + movies.length > 1
    const candidates: VideoCandidate[] = []
    for (const episodes of series.values()) {
      candidates.push(buildSeries(root, dir, episodes, ['按文件标题与季集标记归并'], extras, sidecarsByDir, shared))
    }
    candidates.push(...buildMovies(dir, movies, extras, sidecarsByDir, series.size > 0))
    const titles = [...new Set(candidates.map(c => c.title_zh || c.title_en).filter(Boolean))]
    for (const candidate of candidates) {
      candidate.sibling_titles = titles
      out.push(candidate)
    }
  }
  return out
}

/**
 * 一个文件的条目根目录。
 *
 * 从 root 往下逐层看，季目录和它下面的一切都归到季目录的**上一层**。
 * `剧名/Season 1/S01E01.mkv` -> `剧名`，这样两季会归成同一条。
 */
function entryRoot(root: string, segs: string[]): string {
  const kept: string[] = []
  for (const s of segs) {
    if (parseSeasonFolder(s)?.kind === 'marked') break
    kept.push(s)
  }
  return path.join(root, ...kept)
}

type ParsedFile = { raw: RawFile; p: ParsedVideoName }

/** 文件名里只有占位词或集号时，才借目录名识别作品。 */
function fileTitle(item: ParsedFile, dir: string): { zh: string; en: string } {
  let region = titleRegion(item.raw.name)
  if (item.p.absolute_episode !== null) {
    region = region.replace(new RegExp(`(?:[ ._\\-\\[]|^)+(?:e(?:p)?[ ._-]*)?0*${item.p.absolute_episode}\\]?$`, 'i'), '')
  }
  const generic = !region.trim() || /^(?:movie|film|video|main|正片|视频|录像|s\d+(?:e\d+)?|e(?:p)?\d+|\d+)$/i.test(region.trim())
  return splitTitle(generic ? titleRegion(path.basename(dir)) : region)
}

/** 集号只影响所属作品，不能把同目录的其他作品一起吞进来。 */
function partitionWorks(dir: string, originals: ParsedFile[]): { series: Map<string, ParsedFile[]>; movies: ParsedFile[] } {
  const items = originals.map(item => ({ ...item, p: { ...item.p } }))
  const numbered = new Map<string, Array<{ item: ParsedFile; parsed: ParsedVideoName }>>()
  for (const item of items) {
    if (item.p.episodes.length || item.p.absolute_episode !== null) continue
    const inSeason = item.raw.segs.some(s => parseSeasonFolder(s)?.kind === 'marked')
    if (inSeason && /^\d{1,3}$/.test(item.raw.base) && Number(item.raw.base) > 0) {
      item.p.absolute_episode = Number(item.raw.base)
      continue
    }
    // 裸数字只有一致的补零序列才尝试归并，避免把电影续作 1/2/3 当剧集。
    if (!/(?:^|[ ._-])(?:0\d{1,2}|\d{3})(?:$|[ ._-])/.test(item.raw.base)) continue
    const parsed = parseVideoName(item.raw.name, true)
    if (parsed.absolute_episode === null) continue
    const title = fileTitle({ raw: item.raw, p: parsed }, dir)
    const key = normStem(title.zh || title.en)
    const bucket = numbered.get(key) ?? []
    bucket.push({ item, parsed })
    numbered.set(key, bucket)
  }
  for (const bucket of numbered.values()) {
    if (new Set(bucket.map(x => x.parsed.absolute_episode)).size < 3) continue
    for (const { item, parsed } of bucket) item.p = parsed
  }
  const series = new Map<string, ParsedFile[]>()
  const movies: ParsedFile[] = []
  for (const item of items) {
    if (!item.p.episodes.length && item.p.absolute_episode === null) { movies.push(item); continue }
    const title = fileTitle(item, dir)
    const key = normStem(title.zh || title.en)
    const bucket = series.get(key) ?? []
    bucket.push(item)
    series.set(key, bucket)
  }
  return { series, movies }
}

function normStem(s: string): string {
  return String(s ?? '').replace(/[ ._\-[\]()]+/g, '').toLowerCase()
}

/** 组一条剧集候选 */
function buildSeries(
  root: string,
  dir: string,
  items: Array<{ raw: RawFile; p: ParsedVideoName }>,
  evidence: string[],
  allExtras: Array<{ path: string; kind: string; segs: string[] }>,
  sidecarsByDir: Map<string, { nfo: string[]; images: string[]; subtitles: string[] }>,
  sharedDirectory = false
): VideoCandidate {
  const rel = path.relative(root, dir)
  const depth = rel ? rel.split(path.sep).length : 0

  // 集号：文件名给不出来就用 hintSeries 再解析一次。
  // 这正是 hintSeries 的设计用途 —— 目录上下文已经证明这是剧，
  // 可以放开裸集号（`剧名.117.mkv`），但它不会重新打开年份误读那条路。
  const byKey = new Map<string, EpisodeEntry>()
  for (const it of items) {
    let p = it.p
    if (p.season === null && p.episodes.length === 0 && p.absolute_episode === null) {
      p = parseVideoName(it.raw.name, true)
    }

    // 季号的优先级：文件名 > 季目录 > 默认 1。
    // 文件名压过目录，因为 `Season 1/S02E03.mkv` 这种放错位置的文件是真实存在的，
    // 而文件名里明写的 S02 是用户/发布组的直接陈述，比目录位置可信。
    let season = p.season
    if (season === null) {
      const dirSeason = it.raw.segs.slice(depth).map(parseSeasonFolder).find((x) => x?.kind === 'marked')
      season = dirSeason ? dirSeason.season : 1
    }

    const eps = p.episodes.length > 0 ? p.episodes : p.absolute_episode !== null ? [p.absolute_episode] : []
    if (eps.length === 0) {
      // 整季包或认不出集号。挂在季下面当第 0 集会污染集列表，
      // 所以放进文件级 files 由上层处理 —— 但剧集候选没有 files 这一说，
      // 于是记成证据交给后面的 agent，不凭空造一个集号
      evidence.push(`认不出集号：${it.raw.name}`)
      continue
    }

    const part = stackParts(it.raw.base)
    for (const ep of eps) {
      const key = `${season}/${ep}`
      const entry = byKey.get(key) ?? { season, episode: ep, files: [], title: '' }
      entry.files.push({
        path: it.raw.path,
        name: it.raw.name,
        size: it.raw.size,
        parsed: p,
        part: part ? part.part : null
      })
      byKey.set(key, entry)
    }
  }

  const episodes = [...byKey.values()].sort((a, b) => a.season - b.season || a.episode - b.episode)
  for (const e of episodes) e.files.sort((a, b) => (a.part ?? 0) - (b.part ?? 0) || a.name.localeCompare(b.name))

  const title = fileTitle(items[0], dir)
  const year = items.map((it) => it.p.year).find((y) => y > 0) ?? 0
  const sidecars = sharedDirectory
    ? items.reduce((all, item) => {
        const own = narrowSidecars(path.dirname(item.raw.path), item.raw.base, sidecarsByDir)
        const work = narrowSidecars(dir, title.zh || title.en, sidecarsByDir)
        for (const key of ['nfo', 'images', 'subtitles'] as const) all[key] = [...new Set([...all[key], ...own[key], ...work[key]])]
        return all
      }, { nfo: [] as string[], images: [] as string[], subtitles: [] as string[] })
    : mergeSidecars(dir, sidecarsByDir)

  return {
    video_type: 'series',
    path: sharedDirectory ? [...items].sort((a, b) => a.raw.path.localeCompare(b.raw.path))[0].raw.path : dir,
    directory: dir,
    shared_directory: sharedDirectory,
    title_zh: title.zh,
    title_en: title.en,
    year,
    files: [],
    episodes,
    sidecars,
    extras: sharedDirectory ? [] : allExtras.filter((e) => e.path.startsWith(dir + path.sep)).map((e) => ({ path: e.path, kind: e.kind })),
    evidence
  }
}

/**
 * 组电影候选。一个目录里可能并列着好几部电影（散装电影文件夹），
 * 所以这里按分卷词干分组，一组一条。
 */
function buildMovies(
  dir: string,
  items: Array<{ raw: RawFile; p: ParsedVideoName }>,
  allExtras: Array<{ path: string; kind: string; segs: string[] }>,
  sidecarsByDir: Map<string, { nfo: string[]; images: string[]; subtitles: string[] }>,
  sharedDirectory = false
): VideoCandidate[] {
  // 分卷合并：`Movie.CD1.avi` + `Movie.CD2.avi` -> 一条，两个文件
  const byStem = new Map<string, Array<{ raw: RawFile; p: ParsedVideoName; part: number | null }>>()
  for (const it of items) {
    const st = stackParts(it.raw.base)
    const key = normStem(st ? st.stem : it.raw.base)
    const arr = byStem.get(key) ?? []
    arr.push({ raw: it.raw, p: it.p, part: st ? st.part : null })
    byStem.set(key, arr)
  }

  const out: VideoCandidate[] = []
  for (const group of byStem.values()) {
    group.sort((a, b) => (a.part ?? 0) - (b.part ?? 0) || a.raw.name.localeCompare(b.raw.name))
    const head = group[0]

    // 条目路径：一个目录里只有这一部片时用目录，否则用文件本身。
    // 这一条直接决定 resource.path 这个全局唯一键，错了会让两部片抢同一个键。
    const soleInDir = byStem.size === 1 && !sharedDirectory
    const entryPath = soleInDir ? dir : head.raw.path

    // 标题：独占目录时优先用目录名（`沙丘 (2021)/movie.mkv` 这种常见形状里
    // 文件名是没信息的），否则只能靠文件名
    const title = fileTitle(head, dir)
    const dirParsed = soleInDir ? parseVideoName(path.basename(dir)) : null

    const evidence: string[] = []
    if (group.length > 1) evidence.push(`分卷合并 ${group.length} 个文件：${group.map((g) => g.raw.name).join('、')}`)
    evidence.push(`文件「${head.raw.name}」；目录「${path.basename(dir)}」仅提供上下文`)

    out.push({
      video_type: 'movie',
      path: entryPath,
      directory: path.dirname(head.raw.path),
      shared_directory: !soleInDir,
      title_zh: title.zh,
      title_en: title.en,
      year: head.p.year || (dirParsed?.year ?? 0),
      files: group.map((g) => ({
        path: g.raw.path,
        name: g.raw.name,
        size: g.raw.size,
        parsed: g.p,
        part: g.part
      })),
      episodes: [],
      sidecars: soleInDir ? mergeSidecars(dir, sidecarsByDir) : narrowSidecars(dir, head.raw.base, sidecarsByDir),
      extras: soleInDir ? allExtras.filter((e) => e.path.startsWith(dir)).map((e) => ({ path: e.path, kind: e.kind })) : [],
      evidence
    })
  }
  return out
}

/** 一个目录（含子目录）下的所有侧车 */
function mergeSidecars(
  dir: string,
  byDir: Map<string, { nfo: string[]; images: string[]; subtitles: string[] }>
): { nfo: string[]; images: string[]; subtitles: string[] } {
  const out = { nfo: [] as string[], images: [] as string[], subtitles: [] as string[] }
  for (const [d, b] of byDir) {
    if (d !== dir && !d.startsWith(dir + path.sep)) continue
    out.nfo.push(...b.nfo)
    out.images.push(...b.images)
    out.subtitles.push(...b.subtitles)
  }
  return out
}

/**
 * 目录里有多部片时，侧车只认**同名**的那些
 * （`沙丘.mkv` 配 `沙丘.nfo` / `沙丘.chs.srt`）。
 * 不同名的就不分配 —— 分错比不分更糟，一部片挂上另一部的简介是看得见的错。
 */
function narrowSidecars(
  dir: string,
  base: string,
  byDir: Map<string, { nfo: string[]; images: string[]; subtitles: string[] }>
): { nfo: string[]; images: string[]; subtitles: string[] } {
  const all = byDir.get(dir) ?? { nfo: [], images: [], subtitles: [] }
  const hit = (p: string): boolean => {
    const name = path.basename(p).toLowerCase()
    const prefix = base.toLowerCase()
    return name === prefix || ['.', '-', '_'].some(separator => name.startsWith(prefix + separator))
  }
  return {
    nfo: all.nfo.filter(hit),
    images: all.images.filter(hit),
    subtitles: all.subtitles.filter(hit)
  }
}
