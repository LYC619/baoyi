/**
 * 海报的纯逻辑：文件叫什么、同目录哪张图算海报、哪个下载地址收不收。
 *
 * 和 `kinds/video/` 下其他文件同一个约定 —— 只收数据、不发请求、不碰 electron，
 * 于是自检能把「挑图优先级、URL 白名单、扩展名推断」整个跑一遍。
 * service.ts 那边才真的下载、真的拷文件、真的写库。
 *
 * ## 为什么海报不复用游戏的 covers/
 *
 * 游戏封面几乎全是用户一张张挑的，属于**用户资产**，清缓存不能碰。影视海报
 * 绝大多数是刮削下来的，丢了重刮一次就有 —— 更接近缓存。分开放，将来「清理
 * 图片缓存」那个功能才有个明确的边界可以下手，不至于连带把用户挑的图删掉。
 *
 * ## 为什么白名单是算出来的，不是写死的
 *
 * 游戏封面那边能写死一串 Steam CDN 域名，是因为地址由我们自己拼。影视这边
 * 图片域名是**用户配的**（`TmdbConfig.image_domain` 存在的理由就是官方那个
 * 域名在国内连不上，用户要填自己的反代）。写死 `image.tmdb.org` 等于把配了
 * 反代的用户全挡在外面，而那批人正是最需要这个功能的。所以白名单从当下这份
 * 配置里算：允许的就是「用户自己填的那台机器」，不是「远端说了算」。
 */

import path from 'node:path'
import type { TmdbConfig } from '../../../src/types'
import { normDomain, DEFAULT_IMAGE_DOMAIN } from './tmdb.ts'

/**
 * 认的图片格式。和游戏封面那份名单刻意保持一致（见 game/links.ts 的 COVER_EXTS）——
 * 两处都是最终塞进渲染进程 `<img>` 的图，能渲染的集合是同一个。
 * 不 import 过来是因为 `kinds/` 之间不该互相依赖；差异靠自检盯着。
 */
export const POSTER_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp']

/** 单张海报的体积上限。TMDB 的 w500 竖版海报通常几十 KB，8 MB 是留足了余量的天花板 */
export const MAX_POSTER_BYTES = 8 * 1024 * 1024

export function isPosterExt(file: string): boolean {
  return POSTER_EXTS.includes(path.extname(file).toLowerCase())
}

/**
 * 海报在海报目录里叫什么。
 *
 * 用条目 id 而不是片名，和游戏封面同一个理由：片名会改（详情页上就能改，
 * 刮削也会改），文件名跟着改就得同步挪文件，不挪就是一堆对不上的孤儿。
 */
export function posterFileName(id: string, source: string): string {
  const ext = path.extname(source).toLowerCase()
  return `${id}${POSTER_EXTS.includes(ext) ? ext : '.jpg'}`
}

/** 同一个条目所有可能的海报文件名，换扩展名时拿它清孤儿 */
export function posterSiblings(id: string): string[] {
  return POSTER_EXTS.map((ext) => `${id}${ext}`)
}

/**
 * `poster_path` 里存的这个值是不是本地文件。
 *
 * 这一列有两种值：刮削时先落 TMDB 的相对路径（`/abc123.jpg`），下载完覆盖成
 * 本机绝对路径。两者都以分隔符开头，光看第一个字符分不出来 —— 判据是
 * **有没有盘符或 UNC 前缀**（Windows），以及路径里有没有目录层级。
 *
 * 分错的代价是实的：把相对路径当本地文件，界面上就是一张永远加载不出来的破图；
 * 把本地文件当相对路径，就会去拼一个 `https://image.tmdb.org/t/p/w500/D:/...`。
 */
export function isLocalPoster(value: string): boolean {
  const v = String(value ?? '').trim()
  if (!v) return false
  // Windows 盘符（D:\... / D:/...）或 UNC（\\server\share）
  if (/^[a-z]:[\\/]/i.test(v)) return true
  if (v.startsWith('\\\\')) return true
  // POSIX 绝对路径：TMDB 的相对路径只有一层（`/abc.jpg`），本地路径必然更深
  if (v.startsWith('/')) return v.slice(1).includes('/')
  return false
}

/**
 * 从同目录的图片里挑一张当海报，挑不到返回空串。
 *
 * 优先级按 Kodi/tinyMediaManager 那套约定来 —— 这些名字不是我们定的，是刮削器
 * 十几年下来的既成事实，用户目录里已经躺着的就是这些文件名：
 *   `poster.jpg` / `folder.jpg` / `<片名>-poster.jpg` 是竖版海报；
 *   `fanart.jpg` / `backdrop.jpg` 是横版剧照 —— 塞进 2:3 的框里会被裁掉两边，
 *   所以只当兜底，有竖版就不用它。
 *
 * 认不出名字的图排在最后：一个目录里孤零零一张 jpg，十次里有九次就是海报。
 * 但 `thumb` / `banner` / `clearlogo` 这几类明确不是海报的直接排除 —— 它们塞进
 * 竖版框里的结果比首字占位更难看。
 */
export function pickSidecarPoster(images: string[], baseName = ''): string {
  const base = normalizeBase(baseName)
  let best = ''
  let bestRank = Infinity
  for (const img of images) {
    if (!isPosterExt(img)) continue
    const name = path.basename(img, path.extname(img)).toLowerCase()
    const rank = posterRank(name, base)
    if (rank < bestRank) {
      bestRank = rank
      best = img
    }
  }
  return bestRank === Infinity ? '' : best
}

/** 排除名单：这些图不是竖版海报，塞进海报框里只会更难看 */
const NOT_POSTER = ['banner', 'clearlogo', 'clearart', 'logo', 'disc', 'discart', 'characterart']

/** 越小越优先，Infinity 表示不收 */
function posterRank(name: string, base: string): number {
  if (NOT_POSTER.some((k) => name === k || name.endsWith(`-${k}`))) return Infinity
  // 缩略图：单集截图（`s01e02-thumb`）和 landscape 那类，一律不当海报
  if (name === 'thumb' || name.endsWith('-thumb') || name === 'landscape') return Infinity

  if (name === 'poster' || name === 'cover') return 0
  if (base && (name === `${base}-poster` || name === `${base}poster`)) return 1
  // folder.jpg 是 Windows 资源管理器的目录缩略图约定，多数刮削器会顺手写一份
  if (name === 'folder' || name === 'default') return 2
  if (name.endsWith('-poster') || name.endsWith('_poster')) return 3
  // 季海报：`season01-poster`。整部剧的海报缺席时它比横版剧照像样
  if (/^season\d*(-poster)?$/.test(name)) return 4
  if (name === 'fanart' || name === 'backdrop' || name === 'background') return 8
  if (base && name === base) return 5
  return 6
}

/** 片名归一成文件名前缀的样子，用来认 `<片名>-poster.jpg` */
function normalizeBase(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/i, '')
}

/**
 * 这个下载地址收不收。
 *
 * 三道：必须是 https、主机必须是**当下这份配置里的图片域名**、路径看起来是图片。
 * 第二道是要紧的那道 —— 地址里的相对路径来自 TMDB 的响应，等于外部输入，
 * 不卡主机就等于让远端决定这个进程去连哪台机器。
 */
export function acceptPosterUrl(raw: string, cfg: TmdbConfig): boolean {
  let u: URL
  try {
    u = new URL(String(raw ?? ''))
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  const allowed = normDomain(cfg?.image_domain ?? '', DEFAULT_IMAGE_DOMAIN).toLowerCase()
  if (u.hostname.toLowerCase() !== allowed) return false
  return extFromPath(u.pathname) !== ''
}

/**
 * `poster_path` 里这个值是不是一个外站的绝对地址。
 *
 * 这一列现在有**三**种值（前两种是 v0.7 就有的）：
 *   1. TMDB 的相对路径 `/abc123.jpg`；
 *   2. 下载完覆盖上去的本机绝对路径；
 *   3. hanime 的封面地址 —— 一个完整的 `https://...`。
 *
 * 第三种非要是完整地址不可：TMDB 那边地址是我们自己拼的（域名在配置里），
 * 而 hanime 的封面 URL 是从它自己的页面上读出来的，主机名**我们说不出来**。
 * 所以只能原样存着，下载时再判。
 *
 * 不加这个判断的后果很具体：`isLocalPoster('https://x/y.jpg')` 是 false，
 * 于是它会被当成 TMDB 的相对路径，拼出 `https://image.tmdb.org/t/p/w500/https://x/y.jpg`。
 */
export function isRemotePoster(value: string): boolean {
  return /^https?:\/\//i.test(String(value ?? '').trim())
}

/**
 * 私有网段和回环。外站给的图片地址必须挡掉这些。
 *
 * hanime 的页面是外部输入，它写什么主机名我们就会去连什么主机名 ——
 * 指向 `127.0.0.1` 或 `192.168.x.x` 的话，这个进程就变成了一个替远端
 * 探内网的工具。TMDB 那边不需要这一道是因为那边主机名是**用户自己配的**，
 * 用户填自己的反代（甚至就是局域网里的一台机器）是正当用法。
 */
const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0$|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i

/**
 * 外站（当下只有 hanime）的封面地址收不收。
 *
 * 和 `acceptPosterUrl` 是两套判据，**故意不合并**：
 *
 * - TMDB 那边主机名在配置里，能用**正向白名单**（只许连用户填的那台）；
 * - hanime 的封面在哪个 CDN 上我们不知道（真页面至今没抓到，见待确认 H），
 *   编一个白名单出来就是在假装知道 —— 而猜错的表现是「封面永远刮不到」，
 *   和这个功能压根没接上长得一模一样。所以这边只能用**反向护栏**：
 *   必须 https、不许指向内网、扩展名不做要求（CDN 常常不带扩展名，
 *   真正的格式以 content-type 为准）。
 */
export function acceptExternalPosterUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(String(raw ?? ''))
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (PRIVATE_HOST.test(u.hostname)) return false
  return u.hostname.includes('.')
}

/** 从路径里取扩展名，认不出返回空串 */
export function extFromPath(pathname: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(String(pathname ?? ''))
  if (!m) return ''
  const ext = `.${m[1].toLowerCase()}`
  return POSTER_EXTS.includes(ext) ? ext : ''
}

/**
 * 从 content-type 推扩展名。下载时**以这个为准**，不信 URL 上写的那个 ——
 * 远端完全可以在 `.jpg` 地址上回一张 webp，而扩展名写错的文件在 `<img>` 里
 * 未必渲染得出来。同 game/covers.ts 的同名函数。
 */
export function extFromContentType(ct: string): string {
  const type = String(ct ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
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
