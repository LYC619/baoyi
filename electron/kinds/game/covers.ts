/**
 * 封面搜索的纯逻辑：查询词怎么拼、候选图从哪儿来、URL 收不收、排第几。
 *
 * 和这一层其他文件同一个约定 —— 只收数据、不发请求、不碰 electron，
 * 于是自检能把「查询词优先级、URL 白名单、扩展名推断、去重排序」整个跑一遍。
 * service.ts 那边只负责真的发请求、真的下载、真的落库。
 *
 * ## 为什么主源是 Steam 而不是搜索服务商
 *
 * 五家搜索服务商里只有两家能返回**图片** URL（Bing 有独立的 /images/search，
 * SearXNG 有 categories=images）；Tavily / Exa / Firecrawl 都只回网页。
 * 只做服务商这一条路，大多数人按下按钮之后永远搜不到东西。
 *
 * Steam 的商店搜索接口不要 key，返回 appid，而封面地址是能从 appid **推**出来的
 * 固定形状。于是主源不依赖任何配置，装完就能用；服务商图搜作为补充，
 * 专门补 Steam 上没有的那些（RPG Maker 小作品、模拟器 ROM、国产单机）。
 */

/** 一个候选封面。`kind` 只用来在界面上说明这张图哪儿来的 */
export interface CoverCandidate {
  url: string
  /** 界面上那行说明，例如「Steam 竖版封面」 */
  label: string
  source: 'steam' | 'search'
  /** 竖版封面（2:3）优先展示，横版图当兜底 */
  portrait: boolean
  /** 同源内部的排序权重，小的在前 */
  rank: number
}

/**
 * 允许下载的图片主机。
 *
 * 这不是防御性代码：候选 URL 有一半来自模型/搜索服务商的返回，等于**外部输入**。
 * 不设白名单，等于让远端决定这个进程去连哪台机器 —— 一个被污染的搜索结果就能
 * 让抱一去访问任意地址。白名单之外的候选直接不进列表，用户看不到也点不到。
 *
 * Steam 的图走 CDN，几个域名历史上都在用，全列上。
 */
export const IMAGE_HOSTS = [
  'cdn.cloudflare.steamstatic.com',
  'cdn.akamai.steamstatic.com',
  'shared.cloudflare.steamstatic.com',
  'shared.akamai.steamstatic.com',
  'steamcdn-a.akamaihd.net',
  'media.steampowered.com',
  // 图搜常见的图床/维基，都是只读静态资源
  'upload.wikimedia.org',
  'static.wikia.nocookie.net',
  'images.igdb.com',
  'cdn2.steamgriddb.com',
  'www.mobygames.com',
  'cdn.mobygames.com'
]

/** 认的图片扩展名。和 links.ts 的 COVER_EXTS 是同一份名单，别在这儿另开一个 */
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp']

/** 下载单张封面的体积上限。12 MB 装得下任何合理的竖版封面 */
export const MAX_COVER_BYTES = 12 * 1024 * 1024

/** 一次最多给用户看多少张 —— 再多就不是「挑一张」而是「翻图库」了 */
export const MAX_CANDIDATES = 12

/**
 * 拼搜索用的游戏名，**英文名优先**。
 *
 * 英文名优先不是偏好，是命中率决定的：Steam 的商店搜索和大多数图床都以英文原名
 * 建索引，「艾尔登法环」查不到而 `Elden Ring` 一发就中。中文名只在没有英文名时用。
 * 两个都没有就退到目录名 —— 那至少是用户自己认得的字。
 *
 * 返回的是**去重后**的候选查询词，按优先级排。调用方按顺序试，中了就停。
 */
export function coverQueries(g: {
  name_en?: string
  name_zh?: string
  source_dir?: string
  file_name?: string
}): string[] {
  const out: string[] = []
  const push = (raw: string | undefined): void => {
    const v = cleanQuery(raw ?? '')
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v)
  }
  push(g.name_en)
  push(g.name_zh)
  // 目录名兜底：去掉 `(2002304)` 这种 appid 尾巴和常见的版本噪声
  push(dirNameToQuery(g.source_dir ?? ''))
  return out
}

/**
 * 清一条查询词。
 *
 * 去掉的是**商店/压缩包带来的噪声**，不是游戏名的一部分：版本号、语言标记、
 * 「豪华版」这类后缀。留着它们会让本来能命中的名字查不到，
 * 而删过头（比如把罗马数字当版本号删掉）比不删更糟，所以只删有把握的那几类。
 */
export function cleanQuery(raw: string): string {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  s = s.replace(/[　\s]+/g, ' ')
  // 括号里的整块噪声：(2002304)、[中文汉化]、【豪华版】
  s = s.replace(/[（(\[【][^）)\]】]*[）)\]】]/g, ' ')

  // 版本号要在**点还在**的时候删：v1.2.3 里的点是版本号的一部分，
  // 先把点换成空格的话，剩下的 `2 3` 就变成了游戏名的一截
  s = s.replace(/\b(v|ver|version|build)[\s._-]*\d[\d._]*\b/gi, ' ')

  // 再把分隔符归一成空格。这一步必须排在删后缀**之前** ——
  // `_` 在正则里是单词字符，`Hades_Deluxe Edition` 里 `_D` 之间没有 \b，
  // 于是 `\bdeluxe` 压根匹配不上，后缀留在名字里一起被拿去搜（自检抓到过）
  s = s.replace(/[_.]+/g, ' ')

  // 常见的发行/语言后缀
  s = s.replace(
    /\b(repack|multi\d*|proper|incl\.?\s*dlc|goty|deluxe\s*edition|definitive\s*edition|complete\s*edition)\b/gi,
    ' '
  )
  return s.replace(/\s{2,}/g, ' ').trim()
}

/** 目录名转查询词。比 cleanQuery 多剥一层：目录名常带整理者留的前后缀 */
export function dirNameToQuery(dir: string): string {
  const base = String(dir ?? '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop()
  return cleanQuery(base ?? '')
}

/* ------------------------------ Steam ------------------------------ */

/**
 * Steam 商店搜索接口。不要 key，返回 `{ items: [{ id, name, tiny_image }] }`。
 *
 * 用 `cc=us&l=english` 而不是跟随系统区域：结果里的 `name` 用来跟查询词比对，
 * 中文区返回的是译名，跟英文查询词比不出高低。封面图本身不分区域。
 */
export function steamSearchUrl(query: string): string {
  return `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(
    query
  )}&cc=us&l=english`
}

/**
 * 从 appid 推出候选封面地址。
 *
 * Steam 每个 app 的图有固定几种，但**不保证都存在** —— library_600x900 是较晚
 * 才铺开的，老游戏往往只有 header。所以这里只负责「可能有哪些」，
 * 哪些真的存在由 service 层逐个 HEAD 过一遍决定（拿不到 200 的不进列表）。
 *
 * 顺序就是推荐顺序：竖版 → 竖版小图 → 横版。封面墙是 2:3 的框，
 * 横版塞进去会被裁掉两边，只能当兜底。
 */
export function steamCoverCandidates(appid: number | string, name = ''): CoverCandidate[] {
  const id = String(appid).trim()
  if (!/^\d+$/.test(id)) return []
  const base = `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}`
  const tag = name ? `（${name}）` : ''
  return [
    { url: `${base}/library_600x900_2x.jpg`, label: `Steam 竖版封面 2x${tag}`, source: 'steam', portrait: true, rank: 0 },
    { url: `${base}/library_600x900.jpg`, label: `Steam 竖版封面${tag}`, source: 'steam', portrait: true, rank: 1 },
    { url: `${base}/portrait.png`, label: `Steam 竖版海报${tag}`, source: 'steam', portrait: true, rank: 2 },
    { url: `${base}/library_hero.jpg`, label: `Steam 横版主图${tag}`, source: 'steam', portrait: false, rank: 3 },
    { url: `${base}/header.jpg`, label: `Steam 横版头图${tag}`, source: 'steam', portrait: false, rank: 4 }
  ]
}

/**
 * Steam 搜索结果里挑最像的那个 app。
 *
 * 只做**归一后相等**和**包含**两级，不做模糊距离：模糊匹配会把
 * 「Portal」匹到「Portal 2」上，而封面错了比没封面更糟（用户得先发现错了）。
 * 拿不准就返回前若干个都当候选，让用户在图上选 —— 图比名字直观。
 */
export function pickSteamApps(
  items: Array<{ id?: unknown; name?: unknown; type?: unknown }>,
  query: string,
  limit = 3
): Array<{ id: number; name: string }> {
  const want = normalizeName(query)
  const valid = items
    .map((it) => ({
      id: Number(it?.id),
      name: String(it?.name ?? ''),
      type: String(it?.type ?? 'app').toLowerCase()
    }))
    .filter((it) => Number.isInteger(it.id) && it.id > 0)
    // 只要本体。DLC 和原声带在商店搜索里跟本体一起回来（「ELDEN RING Tarnished Pack」、
    // 「Sultan's Game - Original Soundtrack」），而它们四种封面图全都不存在 ——
    // 实测过。不滤掉就是每条白烧 4 次探测请求，换回来一个空
    .filter((it) => it.type === 'app' || it.type === '')
    .map(({ id, name }) => ({ id, name }))

  const exact = valid.filter((it) => normalizeName(it.name) === want)
  const partial = valid.filter((it) => {
    const n = normalizeName(it.name)
    return n !== want && (n.includes(want) || want.includes(n))
  })
  const rest = valid.filter(
    (it) => !exact.includes(it) && !partial.includes(it)
  )
  return [...exact, ...partial, ...rest].slice(0, limit)
}

/** 名字归一：只留字母数字和 CJK，大小写不敏感。和 savedb 的归一同一个思路 */
export function normalizeName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/* ------------------------------ URL 收不收 ------------------------------ */

/**
 * 这个 URL 能不能当候选封面下载。
 *
 * 三道：必须是 https、主机必须在白名单里、看起来得是图片。
 * 第三条放宽了 —— 图搜返回的地址常带 query（`?width=600`），
 * 所以只看**路径部分**的扩展名，且 content-type 那一关留给下载时再卡。
 */
export function acceptImageUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(String(raw ?? ''))
  } catch {
    return false
  }
  // 只收 https：http 会被 Chromium 的混合内容策略挡掉，file:// 更是不能碰
  if (u.protocol !== 'https:') return false
  if (!IMAGE_HOSTS.includes(u.hostname.toLowerCase())) return false
  const ext = extFromPath(u.pathname)
  return ext !== ''
}

/** 从路径里取扩展名，认不出返回空串 */
export function extFromPath(pathname: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(String(pathname ?? ''))
  if (!m) return ''
  const ext = `.${m[1].toLowerCase()}`
  return IMAGE_EXTS.includes(ext) ? ext : ''
}

/**
 * 从 content-type 推扩展名。下载时**以这个为准**，不信 URL 上写的那个 ——
 * 远端完全可以在 `.png` 地址上回一张 jpeg，而写错扩展名的文件在
 * `<img>` 里未必渲染得出来。
 */
export function extFromContentType(ct: string): string {
  const type = String(ct ?? '').split(';')[0].trim().toLowerCase()
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/x-ms-bmp': '.bmp'
  }
  return map[type] ?? ''
}

/**
 * 候选列表定型：过白名单 → 按 URL 去重 → 竖版优先 → 同类按 rank → 封顶。
 *
 * 竖版排前面是因为封面墙的框是 2:3 的。去重按**完整 URL**，
 * 不按主机或文件名 —— 同一个游戏在不同尺寸下是不同的候选，都该留着让用户挑。
 */
export function finalizeCandidates(list: CoverCandidate[]): CoverCandidate[] {
  const seen = new Set<string>()
  const out: CoverCandidate[] = []
  for (const c of list) {
    if (!acceptImageUrl(c.url)) continue
    const key = c.url.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  out.sort((a, b) => {
    if (a.portrait !== b.portrait) return a.portrait ? -1 : 1
    if (a.source !== b.source) return a.source === 'steam' ? -1 : 1
    return a.rank - b.rank
  })
  return out.slice(0, MAX_CANDIDATES)
}

/**
 * 从图搜结果里捞候选。
 *
 * 服务商返回的结构五花八门，这里只认「有个像图片地址的字段」这一件事，
 * 认不出的整条丢掉 —— 宁可少给几张，也不要把一个网页地址塞进 <img>。
 */
export function candidatesFromSearch(
  hits: Array<{ url?: unknown; imageUrl?: unknown; thumbnail?: unknown; title?: unknown }>
): CoverCandidate[] {
  const out: CoverCandidate[] = []
  hits.forEach((h, i) => {
    const url = [h.imageUrl, h.url, h.thumbnail].find(
      (v) => typeof v === 'string' && acceptImageUrl(v)
    )
    if (typeof url !== 'string') return
    out.push({
      url,
      label: String(h.title ?? '').trim().slice(0, 40) || '搜索结果',
      source: 'search',
      // 图搜给不出可靠的长宽，一律当非竖版排在 Steam 后面
      portrait: false,
      rank: i
    })
  })
  return out
}
