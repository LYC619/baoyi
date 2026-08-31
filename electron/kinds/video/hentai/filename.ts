/**
 * 里番文件名解析。共用解析器的**前置处理**，不是另一个解析器。
 *
 * 纯逻辑，只收字符串。不碰 electron、不读磁盘、不发请求。
 *
 * ## 为什么不改 kinds/video/filename.ts
 *
 * 那份是共用的，`parser/` 底下 285 条正则在普通片库上是对的。把 `ROUND1`
 * 加进共用的集号表，代价是一部真名叫「ROUND 1」的片子从此被拆成「ROUND」第 1 集 ——
 * 拿一个真实的回归换一个小众格式，不划算。所以专用规则留在这个文件里，
 * 只有分类是里番的那条路会走到它。
 *
 * ## 实测：共用解析器在这批文件名上错在哪儿
 *
 * 清晰度（`_720P` / `_1080P`）和 `第N話` / `EPN` 现在就全对，不用管。
 * 不认的是 `＃N` / `#N` / `ROUND N`。而且失败是连锁的：集号没认出来 →
 * 标题的切割点往后跑 → `[中文字幕]` 被当成标题的一部分吃进去 →
 * `title_zh` 变成 `... プリンセス 中文字幕`，集号还漏到了 `title_en`。
 *
 * 所以这里做三步：剥尾部标记 → 认集号 → 剩下的是作品名。
 *
 * ## 六个集号模式全在这张表里，不只补缺的那三个
 *
 * `第N話` / `EPN` 共用解析器本来就认。但集号的**位置**决定标题在哪儿切，
 * 一半在这里切一半在那边切，就有两个切割点要对齐 —— 而它们对不齐的时候，
 * 表现是标题里多半截或少半截，没有报错。一张表一个切点，比省三行正则值。
 *
 * ## 剥下来的标记不是垃圾，是站方标签
 *
 * hanime 的 `video_attributes` 域里就有 **無碼、AI解碼、中文字幕、1080p**
 * （见 doc/hanime-api-notes.md 第七节）。也就是说 `[中文字幕]` 和 `_720P`
 * 是站方标签在文件名上的投影 —— 剥的时候顺手记下来，等于不联网就先拿到几个标签。
 *
 * 繁简不能靠字面相等：文件名里常见「无修正」，站方 key 是「無碼」。
 * 于是有下面那张别名表，它放在解析器旁边而不是业务逻辑里。
 */

import { parseVideoName, type ParsedVideoName } from '../filename.ts'

/** 共用解析结果 + 从文件名尾巴上回收到的站方标签 */
export interface ParsedHentaiName extends ParsedVideoName {
  /**
   * 剥下来的标记，已过别名表归一。顺序按它们在文件名里出现的先后。
   *
   * 认不出的方括号内容原样留着 —— 不预设里面一定是什么词，
   * 站方那 235 个标签这里只对得上其中几个，剩下的照样是用户写下的信息。
   */
  site_tags: string[]
}

/* ---------------------------- 别名表 ---------------------------- */

/**
 * 文件名上的写法 -> 站方 key。左边小写化后比对，右边一律是站方那个繁体 key。
 *
 * 只收**确定**对得上的那几个。拿不准的宁可原样留着当自由标签，
 * 也不硬归到一个站方 key 上 —— 归错了之后用户在界面上看到的是一个
 * 他没写过、也不知道打哪儿来的词。
 */
const TAG_ALIASES: Record<string, string> = {
  无修正: '無碼',
  無修正: '無碼',
  无码: '無碼',
  無碼: '無碼',
  uncensored: '無碼',
  解码: 'AI解碼',
  解碼: 'AI解碼',
  ai解码: 'AI解碼',
  ai解碼: 'AI解碼',
  ai无码: 'AI解碼',
  ai無碼: 'AI解碼',
  中文字幕: '中文字幕',
  中文subtitle: '中文字幕',
  中文配音: '中文配音',
  同人作品: '同人作品',
  断面图: '斷面圖',
  斷面圖: '斷面圖',
  asmr: 'ASMR'
}

/** 一个剥下来的标记归一成站方 key；对不上就原样返回（去掉首尾空白） */
export function normalizeTag(raw: string): string {
  const t = toHalfWidth(String(raw ?? '')).trim()
  return TAG_ALIASES[t.toLowerCase()] ?? t
}

/* ------------------------- 全角 / 半角 ------------------------- */

/**
 * 全角转半角，只转数字、空格和井号这三样，而且**逐字符一对一** ——
 * 转换前后的下标严格对齐，于是可以拿转换后的串去匹配、拿下标回原串上切。
 *
 * 不做全量转换：作品名里的全角标点（`！`、`～`、`・`）是名字的一部分，
 * 转成半角之后和站上的标题对不上，刮削搜索就搜不到了。
 * 全角数字同理 —— 「巨乳女教師２」的那个２属于名字，只有集号那一段才该抹平。
 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/＃/g, '#')
    .replace(/　/g, ' ')
}

/* ---------------------------- 剥标记 ---------------------------- */

/** 站方就这四档清晰度，`_720P` 这种尾巴认的是它们 */
const RES_SUFFIX = /[_\s]+(240|480|720|1080)[pP]\b/g

/** 方括号连排：`[中文字幕][无修正]`。半角、全角、方头括号都认 */
const BRACKETS = /[[［【]([^\]］】]*)[\]］】]/g

/**
 * 集号模式。全角已经在 toHalfWidth 里抹平，这里只写半角。
 *
 * `ROUND` 和 `EP` 后面允许有空格，`第N話` 的「話/话」两种写法都收。
 * 每条都**必须带标记**（#/ROUND/第..話/EP）—— 光秃秃一个数字不算集号，
 * 否则 `巨乳女教師2` 会被拆成「巨乳女教師」第 2 集。
 */
const EPISODE_PATTERNS: RegExp[] = [
  /第\s*(\d{1,4})\s*[話话]/,
  /\bROUND\s*(\d{1,4})\b/i,
  /\bEP\.?\s*(\d{1,4})\b/i,
  /#\s*(\d{1,4})(?!\d)/
]

/* ---------------------------- 入口 ---------------------------- */

/**
 * 解析一个里番文件名。
 *
 * 技术事实（分辨率、编码、片源、发布组）仍旧交给共用解析器 —— 它在这上面
 * 本来就是对的，而那部分逻辑重写一遍只会长出第二处要维护的正则表。
 * 这里覆盖的只有共用规则在里番上判错的那几项：标题、集号、`is_special`。
 */
export function parseHentaiName(name: string): ParsedHentaiName {
  const raw = String(name ?? '')

  // 技术事实照旧从**原始**文件名上读：`_720P` 得留在原地它才认得出来
  const tech = parseVideoName(raw)

  let work = stripExtension(raw)

  // 全角只在**匹配**的时候抹平，切下来的还是原串那一段：
  // 「巨乳女教師２」的全角２是名字的一部分，抹平它等于改了作品名
  const flat = (): string => toHalfWidth(work)

  // 从后往前切，这样前面那些匹配的下标不会因为切割而失效。
  // 于是收集到的顺序是倒的，最后再翻回文件名上的先后
  const back: string[] = []

  // 1. 剥清晰度。站方 video_attributes 里有 1080p 这个标签，所以它也算一个
  let res = ''
  for (const m of [...flat().matchAll(RES_SUFFIX)].reverse()) {
    res = `${m[1]}p`
    back.push(res)
    work = cut(work, m.index!, m[0].length)
  }

  // 2. 剥方括号，内容留着当标签
  for (const m of [...work.matchAll(BRACKETS)].reverse()) {
    const t = normalizeTag(m[1])
    if (t) back.push(t)
    work = cut(work, m.index!, m[0].length)
  }

  const tags = back.reverse()

  // 3. 认集号。认出来之后把那一段从标题里切掉 —— 切点只有这一个。
  //
  // 有多处命中时取**最靠后**的那个，不是模式表里排第一的那个：
  // 集号写在作品名后面是通例，而作品名里本来就带着 `ROUND 1` 这种词的时候，
  // 按表的顺序挑会切错地方 —— 切错之后剩下的那半截会漏进 title_en，
  // 表现是标题里多出一个 `＃12`，看着像解析器在乱码
  let episode: number | null = null
  let hit: { at: number; len: number } | null = null
  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(flat())
    if (!m) continue
    if (hit === null || m.index > hit.at) {
      hit = { at: m.index, len: m[0].length }
      episode = Number(m[1])
    }
  }
  if (hit !== null) work = cut(work, hit.at, hit.len)

  // 4. 剩下的是作品名。再过一次共用解析器只为了拿它的中英拆分 ——
  //    这时候串上已经没有集号和标记了，切割点跑不掉
  const title = parseVideoName(work.replace(/\s+/g, ' ').trim())

  return {
    ...tech,
    title_zh: title.title_zh,
    title_en: title.title_en,
    // 共用的分辨率表不认 240p，而它是站方四档之一。剥下来的那个是文件名上
    // 白纸黑字写着的，比留空强；共用解析器认得出来时以它为准
    resolution: tech.resolution || res,
    // 里番不分季。集号一律当绝对集号：站上「ROUND1」「＃2」是作品内的序号，
    // 不挂在任何一季下面，硬填 season=1 会和将来真有分季的作品撞车
    season: null,
    episodes: [],
    absolute_episode: episode,
    full_season: false,
    // 里番里 OVA 是常态而不是特别篇，所以这里钉死成 false。
    //
    // 注意这是一道**护栏，不是在修一个观察到的错**：v0.8-计划.md 第四节推测
    // `ピュアピュア OVA ＃2` 会被共用规则判成特别篇（说 `\bOVA\b` 在拉丁字母
    // 中间的边界匹配得上），实测**没有** —— 上面那四种写法 is_special 全是 false，
    // 因为共用解析器只在真有季集标记时才跑上游的 parseSeason。计划里那句已改。
    // 钉死它的理由是这条路径本来就不该依赖那个巧合：哪天上游的季集判断
    // 覆盖面变宽，一整批里番会悄悄挪到第 0 季去，在库里和正片分家
    is_special: false,
    looks_like_series: episode !== null,
    site_tags: tags
  }
}

/** 挖掉 [at, at+len)，留一个空格顶位，免得两边的词粘成一个 */
function cut(s: string, at: number, len: number): string {
  return s.slice(0, at) + ' ' + s.slice(at + len)
}

/** 只剥真的是扩展名的那一截。`＃2` 前面没有点，不会被误伤 */
function stripExtension(name: string): string {
  return name.replace(/\.(mkv|mp4|avi|wmv|rmvb|mov|flv|ts|m2ts|webm)$/i, '')
}
