/**
 * 已知存档位置查表 —— 存档发现三层策略里的第三层。
 *
 *   第一层  agent 按游戏名和目录结构推理（prompts.ts）
 *   第二层  扫 %APPDATA% / %LOCALAPPDATA% / My Games / Saved Games（scanner.ts）
 *   第三层  就是这里：查 ludusavi-manifest 编译出来的索引
 *
 * 前两层都在猜，这一层是**查**。数据来自 PCGamingWiki 社区维护的 19000+ 条记录，
 * 由 scripts/build-save-manifest.ts 在构建期编译成 resources/save-manifest.json。
 *
 * 和这一层的其他文件一样不 import services/database.ts，也不 import electron ——
 * 索引文件的位置由调用方传进来（打包后在 process.resourcesPath 下，开发时在仓库里）。
 * 于是自检能拿一份手写的小索引驱动同一份查表和展开逻辑。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 我们认得的占位符 → 展开成什么。
 *
 * `<base>` 是游戏安装目录，只有调用方知道，所以它在这里是特例（见 expandTemplate）。
 * 这张表被编译脚本共用 —— 两边必须是同一份名单，否则索引里会留下运行时展不开的模板，
 * 或者反过来，编译期丢掉了运行时其实认得的路径。
 */
export const PLACEHOLDERS = new Set([
  '<base>',
  '<home>',
  '<osUserName>',
  '<winAppData>',
  '<winLocalAppData>',
  '<winLocalAppDataLow>',
  '<winDocuments>',
  '<winPublic>',
  '<winProgramData>',
  '<winDir>'
])

/**
 * 把一条模板砍到「我们能确定的那一截」，砍不出有用结果时返回空串。
 *
 * 索引里很多条目的最后一两段是我们无从得知的东西：
 *
 *   <winAppData>/EldenRing/<storeUserId>          ← Steam 数字 ID
 *   <home>/AppData/LocalLow/Team Cherry/Hollow Knight/*.dat   ← 通配符
 *
 * 整条丢掉是错的 —— 艾尔登法环和空洞骑士都是这么被丢掉的，而它们的存档**父目录**
 * 恰好正是我们最想备份的东西：`%APPDATA%\EldenRing` 一备就把所有存档档位都带上了，
 * 比只备其中一个用户 ID 的子目录更对。所以在第一个认不得的段上截断，保留祖先目录。
 *
 * 但截断必须有下限：`<winAppData>/<storeUserId>` 砍完只剩 `%APPDATA%` 本身 ——
 * 那会把整个 Roaming 当成某个游戏的存档目录备走。所以要求占位符根之后至少还剩
 * 一个实打实的段，剩不下就整条丢掉。
 */
export function truncateTemplate(template: string): string {
  const segments = template.split('/')
  const kept: string[] = []
  for (const seg of segments) {
    const tokens = seg.match(/<[a-zA-Z]+>/g) ?? []
    if (seg.includes('*') || tokens.some((t) => !PLACEHOLDERS.has(t))) break
    kept.push(seg)
  }
  // 一段都没留下（模板第一段就认不得，比如 <root>/... 或 <xdgData>/...）
  if (kept.length === 0) return ''
  // 只剩下占位符根本身，没有任何具体目录名 —— 见上面的下限说明
  if (kept.length === 1 && /^<[a-zA-Z]+>$/.test(kept[0])) return ''
  return kept.join('/')
}

/**
 * 游戏名归一化，用来当查表的键。
 *
 * 大小写、空格、标点全部抹掉：库里的名字来自模型和用户，`Elden Ring`、`ELDEN RING`、
 * `Elden Ring™` 指的是同一个游戏。中日韩字符保留 —— 国产游戏和汉化版的名字全在那个
 * 区段里，按 `\w` 过滤会把「原神」整个抹成空串。
 *
 * 罗马数字不做转换：`Final Fantasy VII` 和 `Final Fantasy 7` 在这里是两个键。
 * 转换表要手工维护而且会误伤（`Warhammer 40,000` 里的 40000 不是罗马数字），
 * 收益是几十个条目，代价是一张谁也说不清对不对的映射表。
 */
export function normalizeGameName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim()
}

export interface SaveDbEntry {
  /** 索引里记的原名，用来告诉用户「按哪个名字查到的」 */
  name: string
  /** 未展开的路径模板 */
  paths: string[]
}

/**
 * 加载好的索引。对调用方来说是个不透明句柄 —— 只有这个文件该知道它的形状。
 * 导出是为了让 tools.ts 能在 context 里声明「我持有一份索引，也可能没有」。
 */
export interface SaveDbHandle {
  format: number
  source: string
  built_at: string
  games: Record<string, SaveDbEntry>
}

type SaveDbFile = SaveDbHandle

/** 这个运行时只认得 format 1。将来改格式时同步加，读到别的版本就整个不用 */
const SUPPORTED_FORMAT = 1

/**
 * 索引在进程里只加载一次。
 *
 * 缓存 null 和缓存一份索引是两种不同的状态，所以用一个独立的 loaded 标记：
 * 文件不存在（开发时还没编译、或打包时漏了）是个正常状态，不该每次查表都去
 * 重新 stat 一遍磁盘。
 */
let cache: SaveDbFile | null = null
let loaded = false

/** 只给自检用：清掉缓存，好让同一个进程里能换着索引跑 */
export function resetSaveDb(): void {
  cache = null
  loaded = false
}

/**
 * 加载索引。读不到、格式不对、JSON 坏了，一律返回 null 而不是抛 ——
 * 查表是三层里的**兜底**一层，它不可用时前两层照样工作，不该让整个识别失败。
 */
export function loadSaveDb(indexPath: string): SaveDbFile | null {
  if (loaded) return cache
  loaded = true
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as SaveDbFile
    if (!parsed || parsed.format !== SUPPORTED_FORMAT || typeof parsed.games !== 'object') {
      cache = null
      return null
    }
    cache = parsed
  } catch {
    cache = null
  }
  return cache
}

export interface ExpandContext {
  /** 游戏安装目录，展开 `<base>` 用。不知道时传空串，带 `<base>` 的模板会被跳过 */
  base?: string
  home?: string
}

/**
 * 把一条模板展开成真实路径。展不开时返回空串。
 *
 * 反斜杠统一：索引里的模板用 `/` 分隔（YAML 源就是那么写的），而这些路径最终会
 * 落进 resource 表、进 prompt、显示在界面上，跟 Windows 上其他路径混在一起。
 * path.resolve 会顺手把分隔符归一化，所以这里不额外处理。
 */
export function expandTemplate(template: string, ctx: ExpandContext = {}): string {
  const home = ctx.home ?? os.homedir()
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const map: Record<string, string> = {
    '<home>': home,
    '<osUserName>': os.userInfo().username,
    '<winAppData>': appdata,
    '<winLocalAppData>': local,
    '<winLocalAppDataLow>': path.join(home, 'AppData', 'LocalLow'),
    '<winDocuments>': path.join(home, 'Documents'),
    '<winPublic>': process.env.PUBLIC || 'C:\\Users\\Public',
    '<winProgramData>': process.env.ProgramData || 'C:\\ProgramData',
    '<winDir>': process.env.SystemRoot || 'C:\\Windows'
  }
  if (ctx.base) map['<base>'] = ctx.base

  // 索引里的模板已经在编译期截断过（truncateTemplate），所以这里剩下的占位符
  // 都是认得的 —— 除了 <base>：它认不认得取决于调用方给不给安装目录。
  const cut = truncateTemplate(template)
  if (!cut) return ''

  let out = cut
  for (const token of cut.match(/<[a-zA-Z]+>/g) ?? []) {
    const value = map[token]
    if (!value) return '' // 只可能是 <base> 而调用方没给安装目录
    out = out.split(token).join(value)
  }
  return path.resolve(out)
}

export interface SaveDbHit {
  /** 索引里那个游戏的原名 */
  matched: string
  /** 展开后的绝对路径，已去重、已去掉被别人包含的那些 */
  paths: string[]
}

/**
 * 丢掉那些落在别的候选里面的路径。
 *
 * 截断之后同一个游戏常常同时给出 `…\Saves` 和 `…\Saves\debug.celeste` ——
 * 备份父目录已经把子路径整个带上了，两条都留着只会让用户多点一次、多备一份。
 * 留浅的那条：备份的目标本该是整个存档目录，而不是其中某个文件。
 */
function shallowest(paths: string[]): string[] {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  return paths.filter((candidate) => {
    const c = norm(candidate)
    return !paths.some((other) => {
      if (other === candidate) return false
      const o = norm(other)
      return c.startsWith(`${o}\\`) || c.startsWith(`${o}/`)
    })
  })
}

/**
 * 按名字查已知存档位置。查不到返回 null。
 *
 * names 可以给多个（中文名、英文名、目录名）—— 库里一个游戏有好几个名字，
 * 而索引的键是英文原名。按顺序试，第一个命中的就用它。
 */
export function lookupSavePaths(
  db: SaveDbFile | null,
  names: string[],
  ctx: ExpandContext = {}
): SaveDbHit | null {
  if (!db) return null

  for (const name of names) {
    const key = normalizeGameName(name || '')
    if (!key) continue
    const entry = db.games[key]
    if (!entry) continue

    const paths: string[] = []
    for (const template of entry.paths) {
      const full = expandTemplate(template, ctx)
      if (full && !paths.includes(full)) paths.push(full)
    }
    // 命中了但全都展不开（整条都是 <base> 而调用方没给安装目录）等于没命中
    if (paths.length === 0) continue
    return { matched: entry.name, paths: shallowest(paths) }
  }
  return null
}
