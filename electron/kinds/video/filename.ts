/**
 * 文件名解析：从一个文件名里确定性地读出标题、年份、季集号和技术规格。
 *
 * 纯逻辑，只收字符串。不碰 electron、不读磁盘、不发请求 —— 于是自检可以拿
 * guessit 的真实语料把它整个跑一遍（见 scripts/agent-selfcheck.ts）。
 *
 * ## 这一层为什么存在（而不是直接用 parser/）
 *
 * `parser/` 是 scttcper/video-filename-parser 的移植（MIT，见 parser/ORIGIN.md），
 * 一套在 Radarr/Sonarr 上跑了多年的正则表，技术规格那部分可以直接信。
 * 但它的**标题提取对中文是坏的**：
 *
 *     漫长的季节.S01E05.2023.2160p.WEB-DL.mp4  ->  标题 = 「漫」
 *
 * 原因是 JS 正则里 `\W` 把 CJK 当非单词字符，季集模式里 `[-_\W]+` 那个分隔符类
 * 会把中文标题整个吃掉，非贪婪的 `title` 分组只剩第一个字。这不是某一条正则
 * 写错了 —— 285 条模式里凡是用 `\W` 当分隔符的都有这个毛病，改它们等于重写整个表，
 * 而那张表在 ASCII 片名上是对的，重写只会把对的也弄坏。
 *
 * 所以分工：**上游负责技术事实和季集号，标题由这一层自己算**。
 * 中文片库在本项目里不是边缘情况，它是主要情况。
 *
 * ## 什么不在这里做
 *
 * 认名字（「沙丘2」到底是哪部片）、判断一堆文件是不是同一部剧、剔花絮 ——
 * 那些要么是 agent 的活，要么是扫描器的活。这里只做正则表能穷尽的事：
 * 文件名字面上写了什么。写了什么和它是什么，是两个问题。
 */

import { filenameParse } from './parser/index.ts'
import { parseSeason } from './parser/season/index.ts'
import { removeFileExtension } from './parser/extensions.ts'
import { parseResolutionFromTitle } from './parser/resolution.ts'
import { parseSource, parseSourceGroups } from './parser/source.ts'

/** 解析结果。每个字段都是「文件名上确实写了」的东西，猜出来的一律不在这里 */
export interface ParsedVideoName {
  /** 中文标题。没有中文时是空串 */
  title_zh: string
  /** 拉丁字母标题。没有时是空串 */
  title_en: string
  /** 0 = 文件名里没写年份 */
  year: number
  /**
   * 季号。null = 文件名里没有季的信息。
   *
   * 和「季号是 0」不是一回事 —— 0 是特别篇/SP 的惯例季号（Kodi、Jellyfin 都这么用）。
   */
  season: number | null
  /** 集号，可能多个（`S01E01E02` 这种合集文件）。空数组 = 不是单集 */
  episodes: number[]
  /** 番剧的绝对集号（`[SubsPlease] Frieren - 12`）。null = 没有 */
  absolute_episode: number | null
  /** 整季包（`Show.S01.1080p...`，没有具体集号） */
  full_season: boolean
  /** 特别篇 / SP / OVA */
  is_special: boolean

  resolution: string
  video_codec: string
  /** 片源：BLURAY / WEBDL / WEBRIP / DVD / HDTV… */
  source: string
  release_group: string
  /** 版本标记：导演剪辑版、加长版之类。空数组 = 没有 */
  edition: string[]

  /**
   * 分卷号（`Movie.CD1.avi` 的 1）。null = 不是分卷。
   *
   * 只认 CD/DISC/DISK/DVD + 数字。**刻意不认 `Part N`** ——
   * 「Dune: Part Two」「Harry Potter Part 1」里的 Part 是片名的一部分，
   * 把它当分卷会把两部不同的电影合成一条。分卷这件事宁可漏认（用户手动合并一次），
   * 不能错认（错了就是两部片消失成一部，而用户未必看得出来）。
   */
  part: number | null

  /** 看起来是不是剧集（有季集号、绝对集号、或整季标记） */
  looks_like_series: boolean

  /** 花絮 / 预告 / 样片。这些不该成为库里的条目 */
  is_extra: boolean
  /** 是哪一类附属内容，空串表示不是 */
  extra_kind: string
}

/* ---------------------------- 花絮识别 ---------------------------- */

/**
 * 附属内容的标记。命中就不该作为条目入库 —— 一个 30 秒的预告片和正片
 * 在海报墙上占同样大的格子，而用户想看的是正片。
 *
 * 中英文都要认：中文片源里「花絮」「预告」「片头」是常态，
 * Emby.Naming 那套只认英文的。
 */
const EXTRA_PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  { kind: 'sample', regex: /\bsample\b|[-_. ]sample[-_. ]?\d*$/i },
  { kind: 'trailer', regex: /\btrailers?\b|预告片?|先导片/i },
  { kind: 'featurette', regex: /\bfeaturettes?\b|\bbehind[-_. ]the[-_. ]scenes\b|花絮|幕后/i },
  { kind: 'interview', regex: /\binterviews?\b|访谈|专访/i },
  { kind: 'deleted', regex: /\bdeleted[-_. ]scenes?\b|删减片段/i },
  { kind: 'opening', regex: /\b(?:NC)?(?:OP|ED)\d*\b(?![a-z])|片头曲?|片尾曲?/i },
  { kind: 'other', regex: /\bextras?\b|\bbonus\b|\bscene\b|彩蛋|制作特辑/i }
]

/** 这个文件名看起来是不是附属内容 */
export function detectExtra(name: string): { is_extra: boolean; kind: string } {
  const base = removeFileExtension(name)
  for (const { kind, regex } of EXTRA_PATTERNS) {
    if (regex.test(base)) return { is_extra: true, kind }
  }
  return { is_extra: false, kind: '' }
}

/* ---------------------------- 标题切割 ---------------------------- */

/**
 * 技术标记：标题在**第一个**这类标记处结束。
 *
 * 按「最靠前的命中位置」切，不按优先级 —— `沙丘.2024.2160p` 和
 * `沙丘.2160p.2024` 都该切出「沙丘」。
 *
 * 顺序在这里不重要，位置才重要。所以下面是逐条 exec 取最小 index，
 * 而不是拼成一个大正则（大正则的交替分支会按书写顺序而不是位置匹配）。
 */
const TECH_MARKERS: RegExp[] = [
  // 季集：S01E02 / S01 / 1x02 / 第1季 / 第01集 / EP01
  /[-_. [(]s\d{1,4}(?:[-_. ]?e\d{1,4})*\b/i,
  /[-_. [(]\d{1,2}x\d{1,3}\b/i,
  /第\s*[0-9一二三四五六七八九十百零]+\s*[季集话話期]/,
  /[-_. [(](?:ep?|episode)[-_. ]?\d{1,4}\b/i,
  /[-_. [(]season[-_. ]?\d{1,2}\b/i,
  // 年份：1900-2099，前后必须是分隔符或字符串边界，否则「2012」这种片名会被切掉
  /[-_. [(](?:19[0-9]\d|20\d\d)(?=[-_. \])]|$)/,
  // 分辨率
  /[-_. [(](?:\d{3,4}[pi]|\d{3,4}x\d{3,4}|4k|uhd|fhd|hd)\b/i,
  // 片源
  /[-_. [(](?:blu[-_. ]?ray|bd(?:rip|remux|\d{2,3})?|web[-_. ]?dl|web[-_. ]?rip|webrip|hdtv|hdrip|dvdrip|dvd[59r]?|remux|hdcam|cam|ts|tc|scr|screener|vhs)\b/i,
  // 编码 / 音轨
  /[-_. [(](?:[xh][-_. ]?26[45]|hevc|avc|av1|vp9|xvid|divx|mpeg-?[24])\b/i,
  /[-_. [(](?:ddp?5[-_. ]1|dts(?:-?hd)?|truehd|atmos|aac|flac|ac3|eac3|opus|mp3|dolby)\b/i,
  /[-_. [(](?:10bit|8bit|hdr10?\+?|dolby[-_. ]?vision|dovi|sdr)\b/i,
  // 语言 / 字幕标记。中文那些单列一条：`\b` 是零宽断言，在 CJK 两侧不成立
  // （CJK 是「非单词字符」，两个 CJK 之间没有边界），加了反而永远匹配不上
  /[-_. [(](?:multi|dual[-_. ]?audio)\b/i,
  /[-_. [(]?(?:国粤双语|国语中字|中英字幕|中英双字|简繁英|简繁|简中|繁中|内封|内嵌|外挂字幕)/,
  // 平台
  /[-_. [(](?:nf|netflix|amzn|amazon|dsnp|disney|hmax|hbo|atvp|itunes|viu|iqiyi|youku|bilibili|mgtv)\b/i
]

/**
 * 番剧的裸集号：`[字幕组] 标题 - 12 [CRC]` 里那个 ` - 12`。
 *
 * 只在文件名以 `[字幕组]` 开头时才当切点。裸数字太危险 ——
 * `Se7en - 7` 之类的片名会被切掉半截，而字幕组前缀是番剧命名的明确信号
 * （anitomy、Sonarr 的 anime 分支都靠它区分）。
 */
const ANIME_EPISODE_CUT = /[-_. ]+-?\s*\d{1,3}(?:v\d)?(?:[-_. ]|\s*\[|$)/

/**
 * 切出标题部分：删掉扩展名、开头的发布组方括号、以及第一个技术标记之后的一切。
 *
 * 番剧的 `[字幕组]` 前缀单独处理 —— 它在标题**前面**，不是标记，
 * 而 parseGroup 已经把它当发布组认出来了，这里只负责剥掉。
 */
export function titleRegion(name: string): string {
  let s = removeFileExtension(String(name ?? ''))

  // 开头的一到多个方括号块：字幕组、REQ 标记、分辨率前缀
  const hadBracketPrefix = /^\s*\[[^\]]*\]/.test(s)
  s = s.replace(/^(?:\s*\[[^\]]*\]\s*)+/g, ' ')
  // 结尾的 8 位 CRC 校验码 [1A2B3C4D]，番剧文件名的惯例
  s = s.replace(/\s*\[[0-9a-f]{8}\]\s*$/i, ' ')

  const markers = hadBracketPrefix ? [...TECH_MARKERS, ANIME_EPISODE_CUT] : TECH_MARKERS

  let cut = s.length
  for (const re of markers) {
    const m = re.exec(s)
    // index 为 0 时不切：整个名字就是个技术标记的话，切完什么都不剩
    if (m && m.index > 0 && m.index < cut) cut = m.index
  }
  return s.slice(0, cut)
}

const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/

/**
 * 把标题拆成中文名和外文名。
 *
 * 中文片源的惯例是两个名字挨着放：`三体.Three-Body.2023`、
 * `灌篮高手.THE.FIRST.SLAM.DUNK.2022`。拆开之后两个都能用来搜 TMDB，
 * 而英文名的命中率明显更高（和 0.6 封面搜索那条经验一致）。
 *
 * 按 token 分组而不是按「第一个非 CJK 字符」切：`流浪地球2` 里的 2
 * 是片名的一部分，按字符切会切出「流浪地球」和「2」两个都不对的名字。
 */
export function splitTitle(raw: string): { zh: string; en: string } {
  const tokens = String(raw ?? '')
    .replace(/[._]+/g, ' ')
    .replace(/[[\]()【】]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const zh: string[] = []
  const en: string[] = []
  for (const t of tokens) {
    if (CJK.test(t)) zh.push(t)
    else en.push(t)
  }

  // 纯数字或单个连字符不足以成名，跟着前一组走。`Dune - Part Two` 里那个
  // 破折号被拆成独立 token，留着会变成标题的一部分
  const clean = (parts: string[]): string =>
    parts
      .filter((p) => !/^[-–—:：|]+$/.test(p))
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim()

  return { zh: clean(zh), en: clean(en) }
}

/* ---------------------------- 拉丁季集 ---------------------------- */

/**
 * `1x02` 那种写法里，什么样的第一个数字才可能是季号。
 *
 * `NxM` 这个形状被三种东西共用：季集（`5x07`）、体育赛事的年份季
 * （`MotoGP.2016x03`）、以及像素尺寸和长宽比（`1280x720`、`16x9`）。
 * 靠「第二段不超过 3 位」挡不住 —— `1280x720` 的 720 正好 3 位。
 *
 * 所以按第一个数字的取值范围分：1-99 是季号，1900-2099 是赛季年，
 * 其余（240x360、640x480、1280x720、1920x1080）一律不是。
 * 长宽比 `16x9`、`4x3` 落在 1-99 里，只能单独列出来。
 */
const ASPECT_RATIOS = new Set(['4x3', '16x9', '16x10', '21x9'])

function seasonLikeNumber(n: number): boolean {
  return (n >= 1 && n <= 99) || (n >= 1900 && n <= 2099)
}

/**
 * 「Season」这个词是片名的一部分，不是季标记。
 *
 *     Open Season 2 (2008) - Bluray-1080p.x264.DTS.mkv   ← 片名叫《丛林大反攻 2》
 *     Show.Name.Season.2025.1080p.WEB-DL...              ← 2025 是年份
 *
 * 两条判据：
 * - 季号后面跟着括号年份。整季包不会写成 `Season 2 (2008)`，电影会。
 * - 季号本身落在 1900-2099，且是拼出来的 `Season` 形式。`Season 2025` 里那个
 *   四位数几乎总是年份 —— guessit 在自己的语料里也把这条标成 `-season`。
 *   `NxNN` 形式（`MotoGP.2016x03`）不走这里，赛季年在那个形式下是真的。
 */
function seasonWordIsTitle(base: string, m: RegExpExecArray): boolean {
  const spelledOut = /^seasons?/i.test(m[0].replace(/^[-_. [(]/, ''))
  if (spelledOut && Number(m[1]) >= 1900 && Number(m[1]) <= 2099) return true
  const after = base.slice(m.index + m[0].length)
  return /^[-_. ]*[([](?:19[0-9]\d|20\d\d)[)\]]/.test(after)
}

/**
 * 文件名里**明写出来的**季集号。
 *
 * 上游那张表在这几种最常见的写法上偶尔会输给自己的其他模式：
 *
 *     Adventure.Time.S08E16.Elements.Part.1.Skyhooks...  ->  上游给 E1（匹配了 Part.1）
 *     The Office - S06xE01.avi                           ->  上游给 null
 *     My.Name.Is.Earl.S01Extras...                       ->  上游给 null
 *
 * `S08E16` 这种写法是无歧义的，没有任何理由让它去和 `Part.1` 竞争。所以这一层
 * 先自己读明写的形式，读不到才落回上游那张表（那张表擅长的是 scene 命名的
 * 各种变体，不是这几种规范写法）。
 */
export function parseLatinSeasonEpisode(
  name: string
): { season: number | null; episodes: number[]; full_season: boolean } | null {
  const base = removeFileExtension(String(name ?? ''))
  const head = '(?:^|(?<=[-_. [(]))'

  // S01E02 / S01E02E03 / S01E02-E03 / S06xE01 / S013E18
  const se = new RegExp(`${head}s(\\d{1,4})((?:[-_. x]?e\\d{1,4})+)`, 'i').exec(base)
  if (se) {
    const eps = [...se[2].matchAll(/e(\d{1,4})/gi)].map((m) => Number(m[1]))
    return { season: Number(se[1]), episodes: eps, full_season: false }
  }

  // 1x02 / 05x07 / 2016x03（体育赛事拿年份当季号）
  const cross = new RegExp(`${head}(\\d{1,4})x(\\d{1,3})(?!\\d)`, 'i').exec(base)
  if (
    cross &&
    seasonLikeNumber(Number(cross[1])) &&
    !ASPECT_RATIOS.has(`${Number(cross[1])}x${Number(cross[2])}`) &&
    // 四位数开头再跟一个 1-2 位数的是日期：`Something.2008x12.13` 是 2008-12-13。
    // 只在四位数时查这一条 —— `The.Mentalist.2x21.18-5-4` 里 `.18` 是集名的开头，
    // 而它的季号只有一位数，不可能是年份
    !(cross[1].length === 4 && new RegExp(`^[-_.]\\d{1,2}(?!\\d)`).test(base.slice(cross.index + cross[0].length)))
  ) {
    return { season: Number(cross[1]), episodes: [Number(cross[2])], full_season: false }
  }

  // S01 / Season 1 / Seasons 1 / Season.01 —— 整季包，没有具体集号
  const seasonOnly = new RegExp(`${head}(?:s|seasons?[-_. ]?)(\\d{1,4})(?![\\dxe])`, 'i').exec(base)
  if (seasonOnly && !seasonWordIsTitle(base, seasonOnly)) {
    return { season: Number(seasonOnly[1]), episodes: [], full_season: true }
  }
  // `S01Extras` 这种季号后面直接跟字母的：上面那条被 `(?![\dxe])` 挡掉了
  // （挡它是为了不把 `S01E02` 的 E 吞掉），单独补一条
  const seasonThenWord = new RegExp(`${head}s(\\d{1,4})(?=[a-z]{2,})`, 'i').exec(base)
  if (seasonThenWord) {
    return { season: Number(seasonThenWord[1]), episodes: [], full_season: false }
  }

  // E13 / EP01 / Episode 4 —— 只有集号，季号得靠目录结构或 agent 定
  const epOnly = new RegExp(`${head}(?:episode[-_. ]?|ep[-_. ]?|e)(\\d{1,4})(?!\\d)`, 'i').exec(base)
  if (epOnly) {
    return { season: null, episodes: [Number(epOnly[1])], full_season: false }
  }

  return null
}

/**
 * 番剧的裸集号：`[字幕组] 标题 08 [CRC]`、`[组].标题.27.[1280x720].[CRC]`。
 *
 * 番剧命名不写 S/E，集号是个裸数字，靠 `[字幕组]` 前缀这个惯例来确认
 * 「这个裸数字是集号而不是片名的一部分」。没有前缀就不认 ——
 * `Se7en`、`2012`、`Rush 2013` 都会被裸数字规则毁掉。
 */
export function parseAnimeEpisode(name: string): number | null {
  const base = removeFileExtension(String(name ?? ''))
  if (!/^\s*\[[^\]]*\]/.test(base)) return null

  // 开头的一到多个方括号块：字幕组、来源、规格前缀（`[组] [BD][1080p] 标题 08`）
  const s = base.replace(/^(?:\s*\[[^\]]*\]\s*)+/g, ' ')

  // 集号在标题**前面**的写法：`[DeadFish] 01 - Tari Tari [BD][720p]`。
  // 这一支先试，因为它的位置最明确（剥掉前缀方括号后紧跟着就是数字）
  const lead = /^\s*(\d{1,3})(?:v\d)?(?![\da-z])/i.exec(s)
  if (lead) return Number(lead[1])

  // 集号紧跟在标题后面，不一定在末尾 ——
  // `Monster 34 - At the End of Darkness [CRC]` 的集号后面还有个集名。
  // 所以按「标题 + 分隔符 + 1到3位数字」来找，而不是锚在结尾。
  // 标题部分排掉 `[`：`[XCT] Persepolis [H264+Aac-128(...)]` 里那个 128
  // 在方括号内，不是集号。
  // 结尾的 `(?![\da-z])` 刻意不写成 `\b` 或 `(?!\w)`：`\w` 含下划线，而
  // `_Laughing_Salesman_14_[DVD]` 里集号后面正好是下划线
  const m = /^([^[\]]*?[a-z一-鿿][^[\]]*?)[-_. ]+-?\s*(\d{1,3})(?:v\d)?(?![\da-z])/i.exec(s)
  if (!m) return null

  // 裸数字后面**直接**跟技术标记的，那个数字是片名的一部分，不是集号：
  //
  //     [h265 - hevc] transformers 2 1080p french ac3 6ch   ← 变形金刚 2
  //
  // 「直接」是关键 —— 番剧惯例把规格放在括号里（`Frieren - 12 (1080p)`），
  // 括号是个明确的分界，括号里的 1080p 不影响前面那个 12 是集号
  const after = s.slice(m.index + m[0].length)
  if (/^[-_. ]*(?:\d{3,4}[pi]|4k|uhd|blu[-_. ]?ray|web[-_. ]?dl|hdtv|dvdrip|bdrip|[xh]26[45]|hevc)\b/i.test(after)) {
    return null
  }

  return Number(m[2])
}

/* ---------------------------- 中文季集 ---------------------------- */

const CN_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10
}

/**
 * 中文数字转阿拉伯数字，只处理 1-99（季数和集数不会更大）。
 *
 * 「第十二季」「第二十集」在国产剧命名里是常态，而上游那套正则一个都不认。
 * 不引数字转换库：范围就到 99，规则三行写完，引一个包换来的是一份依赖。
 */
export function cnNumber(raw: string): number {
  const s = String(raw ?? '').trim()
  if (/^\d+$/.test(s)) return Number(s)
  if (s.length === 0) return 0

  // 十、十一、二十、二十三
  const ten = s.indexOf('十')
  if (ten >= 0) {
    const high = ten === 0 ? 1 : (CN_DIGITS[s[ten - 1]] ?? 0)
    const low = ten === s.length - 1 ? 0 : (CN_DIGITS[s[ten + 1]] ?? 0)
    return high * 10 + low
  }
  // 单字，或「二三」这种连写（按位拼）
  let n = 0
  for (const ch of s) {
    const d = CN_DIGITS[ch]
    if (d === undefined) return 0
    n = n * 10 + d
  }
  return n
}

/** 中文季集标记：第2季第15集 / 第二季 / 第15话 */
export function parseCnSeasonEpisode(name: string): { season: number | null; episode: number | null } {
  const base = removeFileExtension(String(name ?? ''))
  const seasonM = /第\s*([0-9一二三四五六七八九十百零]+)\s*[季部]/.exec(base)
  const epM = /第\s*([0-9一二三四五六七八九十百零]+)\s*[集话話期]/.exec(base)
  const season = seasonM ? cnNumber(seasonM[1]) || null : null
  const episode = epM ? cnNumber(epM[1]) || null : null
  return { season, episode }
}

/* ---------------------------- 主入口 ---------------------------- */

/** 分卷号。只认 CD/DISC/DISK/DVD + 数字，理由见 ParsedVideoName.part */
export function parsePart(name: string): number | null {
  const m = /[-_. [(](?:cd|disc|disk|dvd)[-_. ]?([1-9])\b/i.exec(removeFileExtension(name))
  return m ? Number(m[1]) : null
}

/**
 * 年份。取**标题区之后最后一个**四位年份。
 *
 * 「最后一个」而不是第一个：`Blade.Runner.2049.2017.2160p` 里 2049 是片名的
 * 一部分（切标题时它成了切点，所以落在标题区之后），2017 才是上映年。
 * 同理 `2012.2009.1080p` —— 片名叫《2012》，年份是 2009。
 *
 * 这条规则会错的情况是「片名里的数字排在真年份后面」，而那种命名本身
 * 就没法机械区分。宁可在这类罕见名字上错，也不要在《银翼杀手 2049》上错。
 */
export function parseYear(name: string): number {
  const base = removeFileExtension(String(name ?? ''))
  // 带括号的年份是最明确的标记，优先：`某片(2019).mkv`
  const paren = /[([](19[0-9]\d|20\d\d)[)\]]/.exec(base)
  if (paren) return Number(paren[1])

  const title = titleRegion(name)
  const rest = base.slice(title.length)
  // 排除分辨率里的四位数：`Apotheosis_1920x1080.mp4` 的 1920 不是 1920 年。
  // 也排除紧跟数字的（`20240315` 这种日期戳的前四位）
  // 前面的 `(?<![\dA-Za-z])`：`BT2020`、`AAC2` 里的四位数不是年份 ——
  // 「取最后一个」的规则碰上 `Life of Pi 2012 ... BT2020 ...` 会选中 BT2020。
  // 后面的 `(?![\dpiXx])`：`1920x1080` / `1920X1080` 是分辨率，`1080p` 里的 p 同理
  const all = rest.match(/(?<![\dA-Za-z])(?:19[0-9]\d|20\d\d)(?![\dpiXx])/g)
  if (all && all.length > 0) return Number(all[all.length - 1])

  return 0
}

/**
 * 文件名里有没有**真正的**季集标记。
 *
 * 这道闸门是这个文件里最要紧的一处。上游那张表里有
 * `four-digit-scene-numbering` 这类模式，专门认 `Show.0102.avi` 这种
 * 老 scene 命名（S01E02）。它在剧集上是对的，但拿去解析电影就是灾难：
 *
 *     Dune.Part.Two.2024.2160p...  ->  S20E24
 *
 * 每部带年份的电影都会变成剧集，海报墙上全是「24/0 集」。上游靠调用方传
 * `isTv=true` 来避免（Sonarr 知道自己在导入剧集），而在文件名这一层没有
 * 那个上下文，只能显式检查有没有季集标记。
 *
 * 宁可漏认（一部剧被当成电影，用户在确认面板里改一下），不能错认 ——
 * 错认会把一部电影拆成一部「剧」，而它的年份变成季号，用户完全看不出为什么。
 */
export function hasSeriesMarker(name: string): boolean {
  const base = removeFileExtension(String(name ?? ''))
  return (
    // 明写出来的那几种形式，和 parseLatinSeasonEpisode 认的是同一套
    parseLatinSeasonEpisode(base) !== null ||
    // 第N季 / 第N集 / 第N话
    /第\s*[0-9一二三四五六七八九十百零]+\s*[季集话話期部]/.test(base) ||
    // 番剧惯例：[字幕组] 标题 - 12 [CRC]
    parseAnimeEpisode(base) !== null
  )
}

/**
 * 上游把文件名里的四位年份读成了季集号。
 *
 *     某片.2020.1080p.mkv  ->  上游给 S20E20
 *
 * 上游那条 `four-digit-scene-numbering` 模式认的是 `Show.0102.avi`（S01E02）
 * 这种老 scene 命名，在剧集上是对的。平时 hasSeriesMarker 那道闸门挡着它，
 * 但扫描器传 `hintSeries=true` 时闸门是开的 —— 而一个剧集目录里混进一个
 * 按电影命名的文件（预告、番外）是常事。
 *
 * 判据：文件名里有年份，且上游给的季集号正好是那个年份拆成的两半。
 */
function yearMisreadAsSeason(name: string, parsed: { seasons: number[]; episodeNumbers: number[] }): boolean {
  const year = parseYear(name)
  if (year === 0) return false
  const season = parsed.seasons[0]
  const episode = parsed.episodeNumbers[0]
  if (season === undefined || episode === undefined) return false
  return season === Math.floor(year / 100) && episode === year % 100
}

/**
 * 解析一个视频文件名。
 *
 * `hintSeries` 只影响季集那部分该不该跑：拿不准时传 undefined，
 * 这个函数会自己判断（有季集号或绝对集号就是剧集）。扫描器知道
 * 「这个文件在一个有 12 个同名文件的目录里」时，传 true 能让
 * `Show.12.mkv` 这种没有 S/E 标记的文件也被当成第 12 集。
 */
export function parseVideoName(name: string, hintSeries?: boolean): ParsedVideoName {
  const raw = String(name ?? '')

  const tech = filenameParse(raw, false) as any
  const cn = parseCnSeasonEpisode(raw)
  const extra = detectExtra(raw)

  // 明写的季集形式先自己读，理由见 parseLatinSeasonEpisode
  const latin = parseLatinSeasonEpisode(raw)

  // 只在真有季集标记时才跑上游的季集解析，理由见 hasSeriesMarker。
  // 上游在这里只补明写形式覆盖不到的 scene 命名变体
  const marked = hasSeriesMarker(raw)
  const raw2 = marked || hintSeries === true ? parseSeason(raw) : null
  // hintSeries 的意思是「目录上下文看着像剧集」，不是「把年份保护也一起关掉」。
  // 没有真标记、只靠 hint 放进来的结果，要再挡一道年份误读
  const season = marked || raw2 === null || !yearMisreadAsSeason(raw, raw2) ? raw2 : null

  const anime = parseAnimeEpisode(raw)

  const seasons: number[] = latin?.season != null ? [latin.season] : (season?.seasons ?? [])
  const upstreamEps: number[] = season?.episodeNumbers ?? []
  // 优先级：明写的季集 > 番剧惯例 > 上游那张 scene 命名表。
  //
  // 番剧排在上游前面，因为上游那张表不认番剧命名，只是碰巧被某条模式匹配上：
  // `[ShinBunBu-Subs] Bleach - 02-03 (...)` 上游给第 3 集，而合集文件的
  // 首集号才是 2。命名惯例明确的时候，专门为它写的规则比通用表可信
  const episodeNumbers: number[] =
    latin !== null && latin.episodes.length > 0
      ? latin.episodes
      : anime !== null
        ? [anime]
        : upstreamEps
  const fullSeason = latin?.full_season || (season?.fullSeason ?? false)

  // 中文标记优先：`权力的游戏.第二季.第05集` 上游因为「第」不是 ASCII
  // 完全认不出来，而中文标记本身是无歧义的
  let seasonNo: number | null = cn.season ?? (seasons.length > 0 ? seasons[0] : null)
  let episodes: number[] = cn.episode !== null ? [cn.episode] : episodeNumbers
  let absolute: number | null = null

  // 番剧的绝对集号：上游认出了集数但没认出季，且中文标记也没给出集号。
  // 「中文标记也没给」这个条件不能省 —— `狂飙.第01集` 是明确的第 1 集，
  // 把它降级成「绝对集号」会让它排不进任何一季
  if (cn.episode === null && seasons.length === 0 && episodeNumbers.length > 0) {
    absolute = episodeNumbers[0]
    episodes = []
    // 绝对集号不带季信息。硬填 1 是错的：番剧第二季的第 13 集绝对编号
    // 可能是 25，填成 S01E25 会和第一季撞车。留 null，让扫描器按目录结构
    // 或 agent 去定季 —— 它们有更多信息
    seasonNo = cn.season ?? null
  }

  const { zh, en } = splitTitle(titleRegion(raw))

  const looksLikeSeries =
    seasonNo !== null || episodes.length > 0 || absolute !== null || fullSeason || hintSeries === true

  return {
    title_zh: zh,
    title_en: en,
    year: parseYear(raw),
    season: seasonNo,
    episodes,
    absolute_episode: absolute,
    full_season: fullSeason,
    is_special: season?.isSpecial ?? false,
    // 分辨率和片源只取**文件名字面上写了**的。
    //
    // 不走上游的 parseQuality：它会从 `.mkv` 扩展名猜出 WEBDL + 720p
    // （Radarr 需要一个画质来做下载决策，猜一个比没有强）。对抱一恰好相反 ——
    // 把编出来的分辨率当「本地事实」显示在详情页上，比留空更糟：
    // 用户看到「720p」不会怀疑它，而真值第 4 步能从容器里读出来。
    resolution: literalResolution(raw),
    video_codec: typeof tech.videoCodec === 'string' ? tech.videoCodec : '',
    source: literalSource(raw),
    release_group: cleanGroup(tech.group),
    edition: editionLabels(tech.edition),
    part: parsePart(raw),
    looks_like_series: looksLikeSeries,
    is_extra: extra.is_extra,
    extra_kind: extra.kind
  }
}

/** 分辨率：只认文件名里写着的，认不出就是空串 */
function literalResolution(name: string): string {
  const r = parseResolutionFromTitle(removeFileExtension(name)).resolution
  return typeof r === 'string' ? r.toLowerCase() : ''
}

/** 片源：只认文件名里写着的。扩展名推断那条路不走 */
function literalSource(name: string): string {
  const base = removeFileExtension(name)
  const groups = parseSourceGroups(base)
  // 一个模式都没命中就是「文件名没说」，别让 parseSource 的策略表编一个出来
  if (!Object.values(groups).some(Boolean)) return ''
  const sources = parseSource(base, groups)
  return sources.length > 0 ? String(sources[0]) : ''
}

/**
 * 发布组名里剔掉技术词。
 *
 * 上游的 parseGroup 取「最后一个连字符后面的东西」，于是
 * `流浪地球2.2023.2160p.WEB-DL.mkv` 会把 `DL` 当成发布组，
 * `Movie-sample.mkv` 会把 `sample` 当成发布组。空着比错着好 ——
 * 详情页上「发布组：DL」是一条假信息，而用户没法判断它是假的。
 */
const NOT_A_GROUP = new Set([
  'dl', 'rip', 'sample', 'proper', 'repack', 'real', 'internal', 'extended',
  'remux', 'web', 'bd', 'hd', 'uhd', 'ray', 'dts', 'hd1080p', 'x264', 'x265',
  'hevc', 'avc', 'aac', 'ac3', 'mkv', 'mp4', 'avi', 'sub', 'subs', 'cn', 'chs', 'cht'
])

function cleanGroup(raw: unknown): string {
  const g = typeof raw === 'string' ? raw.trim() : ''
  if (!g) return ''
  if (NOT_A_GROUP.has(g.toLowerCase())) return ''
  // 纯数字不是组名（`Movie-2024` 那个 2024 是年份）
  if (/^\d+$/.test(g)) return ''
  return g
}

/** 上游的 edition 是一堆布尔标记，转成能直接显示的中文标签 */
function editionLabels(edition: unknown): string[] {
  if (!edition || typeof edition !== 'object') return []
  const map: Record<string, string> = {
    directors: '导演剪辑版',
    extended: '加长版',
    theatrical: '影院版',
    unrated: '未分级版',
    uncut: '未删减版',
    remastered: '重制版',
    imax: 'IMAX 版',
    fanEdit: '粉丝剪辑版',
    special: '特别版',
    internal: '内部版',
    limited: '限定版',
    hdr: 'HDR',
    hsbs: '左右 3D',
    sbs: '左右 3D',
    hou: '上下 3D',
    ou: '上下 3D',
    threeD: '3D'
  }
  const out: string[] = []
  for (const [key, label] of Object.entries(edition as Record<string, unknown>)) {
    if (value(key, label) && !out.includes(map[key] ?? '')) {
      const l = map[key]
      if (l) out.push(l)
    }
  }
  return out

  function value(_k: string, v: unknown): boolean {
    return v === true
  }
}
