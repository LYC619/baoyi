/**
 * 游戏目录的判断规则，以及存档目录的候选与验证。
 *
 * 单独成文件的理由和 software/scanPlan.ts 一样：这里只读文件系统，不碰数据库、
 * 不碰 Electron，所以 npm run selfcheck 能拿真实的临时目录树把它整个跑一遍。
 *
 * 和软件那边最大的不同是「一个目录 = 一个东西」在游戏上基本成立：软件目录里
 * 可能并列着好几个独立工具（工具箱目录），游戏目录里几乎不会。所以这里不做
 * 「把一个目录拆成若干识别单元」，只回答两个问题 ——
 * 「这个目录是不是一个游戏」，以及「凭什么这么说」。
 *
 * 证据本身也要交给 agent：判出 Unity 之后，「主程序是 X.exe 而不是
 * UnityCrashHandler64.exe」就是一条能直接下结论的规则，比让模型逐个 get_file_info
 * 去猜便宜得多。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/* ============================== 游戏目录判断 ============================== */

/**
 * 遍历护栏。游戏目录里没有 node_modules，但有大量体积巨大的资源目录，
 * 进去数 exe 纯属浪费。redist / DirectX 这类目录**不跳过** —— 它们是
 * 「这是个游戏」的证据之一，只是不该在里面找主程序。
 */
const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', '.git', 'node_modules',
  '__pycache__', 'cache', 'temp', 'tmp', 'logs', 'crashes'
])

/** 找主程序时最多下钻几层。Unreal 的主程序在 <Game>\Binaries\Win64\ 下，三层够 */
const MAX_EXE_DEPTH = 3
/** 一个候选目录最多列几个 exe。列表是给模型看的，太长只会挤掉别的信息 */
const MAX_EXES = 40
/** 收纳目录最多往下钻几层再放弃，同 scanPlan 的 MAX_UNIT_DEPTH */
const MAX_COLLECTION_DEPTH = 3

export interface GameExe {
  path: string
  size: number
}

export interface GameCandidate {
  dir: string
  root: string
  /**
   * 命中的证据，人类可读，原样进 prompt。
   * **空数组是有意义的**：目录里有 exe 但认不出引擎 —— 老游戏、汉化整合包、
   * 或者压根不是游戏。交给 agent 去看，不要在这里替它下结论。
   */
  evidence: string[]
  /** 目录里的 exe，按体积从大到小。不做任何过滤，过滤规则写在 prompt 里 */
  exes: GameExe[]
  /**
   * 高置信度的主程序猜测，拿不准就是空串。
   * 只有两条判据够硬才填（见 guessMain），宁可空着也不要给一个错的 ——
   * 模型对「系统给的提示」的信任度远高于它自己看到的东西。
   */
  likely_main: string
}

/** 一个目录这一层的样子，判断规则全部只看它 */
export interface Listing {
  /** 小写文件名 */
  files: Set<string>
  /** 小写子目录名。指纹匹配用这个 */
  dirs: Set<string>
  /**
   * 子目录的原样名字。**拼路径只能用它** —— 用小写那份在 Windows 上
   * 侥幸能读到（文件系统不区分大小写），但拼出来的路径会原样落进
   * resource.path 和 source_dir，之后跟真实路径对不上，在区分大小写的
   * 文件系统上则直接读不到。
   */
  dirNames: string[]
  /** 这一层出现过的小写扩展名 */
  exts: Set<string>
}

const EMPTY_LISTING = (): Listing => ({
  files: new Set(),
  dirs: new Set(),
  dirNames: [],
  exts: new Set()
})

export function readListing(dir: string): Listing {
  const out = EMPTY_LISTING()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out // 权限不足 / 目录已消失，当成空目录
  }
  for (const e of entries) {
    const lower = e.name.toLowerCase()
    if (e.isDirectory()) {
      out.dirs.add(lower)
      out.dirNames.push(e.name)
    } else if (e.isFile()) {
      out.files.add(lower)
      const ext = path.extname(lower)
      if (ext) out.exts.add(ext)
    }
  }
  return out
}

/**
 * Unity 把公司名和产品名明文写在 <X>_Data\app.info 里，两行，第一行公司第二行产品。
 *
 * 这两个字符串就是存档目录 `%LOCALAPPDATA%Low\<公司>\<产品>` 的两截 ——
 * 读它是白拿的。真机上第一次跑「苏丹的游戏」时模型把发行商猜成了 2P Games
 * （实际是 DoubleCross），六次 detect_save_path 全打空，而答案就躺在这个
 * 82 字节的文件里。能在本地读到的事实，不要让模型去猜。
 */
function unityAppInfo(dir: string, dataDir: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(dir, dataDir), { encoding: 'utf8' })
    const [company, product] = raw.split(/\r?\n/).map((s) => s.trim())
    if (!company || !product) return []
    return [
      `Unity 的公司名 / 产品名（读自 ${dataDir}）：${company} / ${product}`,
      `→ 存档大概率在 %LOCALAPPDATA%Low\\${company}\\${product}，先验这一个`
    ]
  } catch {
    return [] // 没有这个文件、或者不是文本，都不影响别的判断
  }
}

/**
 * 引擎 / 平台指纹。
 *
 * 每条都是「看见它基本就能确定」的强特征，不放模棱两可的（比如 d3d9.dll、
 * 一个孤零零的 .ini）—— 弱特征堆多了只会让 evidence 看着很满，而 agent
 * 照样得自己去看，等于白花 token。
 */
function engineEvidence(dir: string, l: Listing): string[] {
  const found: string[] = []
  const has = (n: string) => l.files.has(n)
  const anyFile = (re: RegExp) => [...l.files].some((f) => re.test(f))
  const unityData = l.dirNames.find((d) => d.toLowerCase().endsWith('_data'))

  if (has('steam_appid.txt')) found.push('有 steam_appid.txt —— Steam 平台的游戏')
  if (has('steam_api.dll') || has('steam_api64.dll')) found.push('链接了 Steam 接口（steam_api*.dll）')
  // 真机上撞到的：国区玩家的库里 WeGame 装的游戏不少，而它一个引擎特征都不留
  if (l.dirs.has('rail_files') || l.dirs.has('tcls')) {
    found.push('WeGame（腾讯游戏平台）装的游戏 —— 有 rail_files\\ 或 TCLS\\')
  }

  if (has('unityplayer.dll') || unityData || anyFile(/^unitycrashhandler\d*\.exe$/)) {
    found.push(
      unityData
        ? `Unity 引擎（有 ${unityData}\\ 数据目录）—— 主程序通常是与它同名的那个 exe`
        : 'Unity 引擎（有 UnityPlayer.dll / UnityCrashHandler）'
    )
    if (unityData) found.push(...unityAppInfo(dir, path.join(unityData, 'app.info')))
  }
  if (l.dirs.has('engine') || l.exts.has('.pak')) found.push('可能是 Unreal 引擎（有 Engine\\ 或 .pak）')
  if (has('data.win')) found.push('GameMaker 引擎（有 data.win）')
  if (l.dirs.has('renpy') || l.exts.has('.rpa')) found.push("Ren'Py 引擎（视觉小说）")
  if (l.exts.has('.pck')) found.push('可能是 Godot 引擎（有 .pck）')
  if (anyFile(/^rgss\d*\w*\.dll$/)) found.push('RPG Maker XP/VX 引擎（有 RGSS*.dll）')
  if (l.dirs.has('www') && has('nw.dll')) found.push('RPG Maker MV/MZ 引擎（有 www\\ + nw.dll）')
  else if (has('nw.dll')) found.push('NW.js 打包的程序')
  if (l.exts.has('.xp3')) found.push('KiriKiri 引擎（有 .xp3）')
  if (l.exts.has('.qsp')) found.push('QSP 引擎（文字冒险 / 互动小说）')
  if (l.exts.has('.unity3d')) found.push('Unity 资源包（.unity3d）')

  // 自带存档目录：既是「这是游戏」的旁证，也直接是 detect_save_path 的第一个候选
  for (const name of ['save', 'saves', 'savedata', 'savegame', 'savegames', '存档']) {
    if (l.dirs.has(name)) {
      found.push(`目录内自带 ${name}\\ —— 很可能就地存档，值得用 detect_save_path 验一验`)
      break
    }
  }
  return found
}

/**
 * 往下探一层再判一次 Unreal：它的 Engine\ 和 Content\Paks\ 挂在
 * <根>\<GameName>\ 底下，只看根那一层看不到。只探这一个引擎，因为只有它
 * 的指纹**必然**不在根层；别的引擎能在根层认出来就不必多读一次盘。
 */
function nestedEvidence(dir: string, l: Listing): string[] {
  if (l.dirs.has('engine')) return [] // 根层已经命中，不重复
  for (const sub of l.dirNames) {
    if (SKIP_DIRS.has(sub.toLowerCase())) continue
    const inner = readListing(path.join(dir, sub))
    if (inner.dirs.has('binaries') && inner.dirs.has('content')) {
      return [`Unreal 引擎（${sub}\\ 下有 Binaries\\ 和 Content\\）`]
    }
  }
  return []
}

/** 递归收集 exe，按体积从大到小 */
function collectExes(root: string): GameExe[] {
  const out: GameExe[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (stack.length > 0 && out.length < MAX_EXES) {
    const { dir, depth } = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (out.length >= MAX_EXES) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < MAX_EXE_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase())) {
          stack.push({ dir: full, depth: depth + 1 })
        }
      } else if (e.isFile() && path.extname(e.name).toLowerCase() === '.exe') {
        let size = 0
        try {
          size = fs.statSync(full).size
        } catch {
          /* 读不到大小不影响列出 */
        }
        out.push({ path: full, size })
      }
    }
  }
  return out.sort((a, b) => b.size - a.size)
}

/**
 * 只在两条硬判据下给出主程序猜测：
 *   1. Unity 的 X_Data\ 旁边那个 X.exe —— 这是引擎强制的命名，不会错；
 *   2. 与目录同名的 exe。
 *
 * 刻意**不**拿「体积最大的 exe」兜底。Unity 游戏的主程序常常只有 600KB
 * （资源全在 _Data\ 里），而同目录的 UnityCrashHandler64.exe 有 1MB ——
 * 按体积挑正好挑中崩溃上报程序。给错提示比不给提示更糟：模型会照单全收。
 */
export function guessMain(dir: string, l: Listing, exes: GameExe[]): string {
  const byName = new Map(exes.map((e) => [path.basename(e.path).toLowerCase(), e.path]))

  const unityData = [...l.dirs].find((d) => d.endsWith('_data'))
  if (unityData) {
    const hit = byName.get(`${unityData.slice(0, -'_data'.length)}.exe`)
    if (hit) return hit
  }

  const base = path.basename(dir).toLowerCase()
  const sameName = byName.get(`${base}.exe`)
  if (sameName) return sameName

  // 目录名常带着平台或版本的尾巴：「洛克王国：世界(2002304)」「某游戏 v1.2」「某游戏 [汉化版]」。
  // 去掉尾巴再对一次，命中的仍然是精确同名，不是模糊匹配 —— 「某游戏卸载.exe」不会中
  const trimmed = base.replace(/\s*[（(\[【].*$/, '').replace(/\s+v?[\d.]+$/, '').trim()
  return (trimmed && trimmed !== base && byName.get(`${trimmed}.exe`)) || ''
}

/** 判一个目录：是游戏候选就返回它，不是就返回 null */
export function inspectDir(dir: string, root: string): GameCandidate | null {
  const listing = readListing(dir)
  // 收纳目录（这一层清一色是文件夹）不是候选。这一条不只是给 scanGameRoot 用的
  // 兜底 —— inspectDir 也会被直接调用（用户指着一个目录说「就认这个」），
  // 而 D:\Games 这样的收纳目录下面递归数得到几十个 exe，不拦就会被当成一个游戏
  if (looksLikeCollection(listing)) return null

  const exes = collectExes(dir)
  // 一个 exe 都没有的目录不用惊动 agent。ROM / 模拟器不在 0.6 的范围内
  if (exes.length === 0) return null

  const evidence = [...engineEvidence(dir, listing), ...nestedEvidence(dir, listing)]
  return { dir, root, evidence, exes, likely_main: guessMain(dir, listing, exes) }
}

/**
 * 这是用户自己建的收纳目录（`D:\Games\单机`），还是一个游戏？
 * 判据同 scanPlan.looksLikeCollection：这一层除了文件夹什么都没有。
 * 游戏目录哪怕主程序藏在 Binaries\ 里，根层也总会留下 readme、启动器或配置。
 */
export function looksLikeCollection(l: Listing): boolean {
  return l.files.size === 0 && l.dirs.size > 0
}

export interface GameScanOptions {
  onDir?: (dir: string) => void
  cancelled?: () => boolean
}

/**
 * 把一个扫描根拆成游戏候选。收纳目录会往下钻，最多 MAX_COLLECTION_DEPTH 层。
 *
 * ponytail: 纯启发式，没读任何文件内容。已知会漏的形状是「整合包把游戏本体
 * 塞在第 4 层以下」，以及「一个目录里真的并排放了两个游戏」——
 * 后者会被当成一个候选交给 agent，prompt 里留了「一个目录多个游戏」那一条兜着。
 */
export async function scanGameRoot(
  root: string,
  opts: GameScanOptions = {}
): Promise<GameCandidate[]> {
  const found: GameCandidate[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (opts.cancelled?.()) return
    opts.onDir?.(dir)

    const listing = readListing(dir)
    if (!looksLikeCollection(listing)) {
      const candidate = inspectDir(dir, root)
      if (candidate) found.push(candidate)
      return
    }
    if (depth >= MAX_COLLECTION_DEPTH) return

    for (const sub of listing.dirNames) {
      if (opts.cancelled?.()) break
      if (SKIP_DIRS.has(sub.toLowerCase())) continue
      await walk(path.join(dir, sub), depth + 1)
      await new Promise((r) => setImmediate(r)) // 让出事件循环，保持窗口响应
    }
  }

  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const e of entries) {
    if (opts.cancelled?.()) break
    if (!e.isDirectory() || SKIP_DIRS.has(e.name.toLowerCase())) continue
    await walk(path.join(root, e.name), 1)
  }
  return found
}

/* ============================== 存档目录 ============================== */

/**
 * 存档几乎总在游戏目录**之外**（AppData、我的文档、Saved Games），所以
 * detect_save_path 必须能走出识别沙箱。走出去就得有另一道边界 —— 就是这里。
 *
 * 白名单是「游戏可能存档的地方」，不是「用户的整个主目录」：模型给一个
 * `C:\Users\x\Desktop\工作` 或 `C:\Windows\System32`，必须当场被拒。
 * 这道墙只管**读**，写入（备份）是 Step 5 的事，走它自己的出口。
 */
export function saveRoots(home: string = os.homedir()): string[] {
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  return [
    appdata,
    local,
    path.join(home, 'AppData', 'LocalLow'),
    path.join(home, 'Documents'),
    path.join(home, 'My Documents'),
    path.join(home, 'Saved Games'),
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Documents')
  ]
}

/**
 * 展开模型爱写的那几个环境变量写法。
 *
 * 用固定映射而不是 process.env 全量展开：一是结果在自检里是确定的，
 * 二是模型写出 `%PATH%\save` 这种东西时，展开它没有任何意义。
 * 认不出来的 %XXX% 原样留着 —— 后面 saveRootOf 会因为它不在白名单里而拒掉，
 * 报错信息里带着那个没展开的变量名，比悄悄换成空串好查。
 */
export function expandSavePath(raw: string, home: string = os.homedir()): string {
  const vars: Record<string, string> = {
    APPDATA: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    LOCALLOW: path.join(home, 'AppData', 'LocalLow'),
    USERPROFILE: home,
    HOMEPATH: home,
    DOCUMENTS: path.join(home, 'Documents'),
    MYDOCUMENTS: path.join(home, 'Documents'),
    SAVEDGAMES: path.join(home, 'Saved Games'),
    PUBLIC: process.env.PUBLIC || 'C:\\Users\\Public'
  }
  const expanded = raw
    .trim()
    .replace(/%([A-Za-z_]+)%/g, (whole, name: string) => vars[name.toUpperCase()] ?? whole)
    // 模型偶尔写成 unix 风格的 ~；顺手认了，比回一句报错让它再猜一轮便宜
    .replace(/^~(?=[\\/]|$)/, home)
  return path.resolve(expanded)
}

/** target 落在哪个白名单根之下，不在任何一个之下返回 null */
export function saveRootOf(target: string, roots: string[]): string | null {
  const t = path.resolve(target).replace(/[\\/]+$/, '').toLowerCase()
  for (const root of roots) {
    const r = path.resolve(root).replace(/[\\/]+$/, '').toLowerCase()
    if (t === r || t.startsWith(`${r}\\`) || t.startsWith(`${r}/`)) return root
  }
  return null
}

export interface SaveProbe {
  exists: boolean
  /** 递归文件数 */
  files: number
  bytes: number
  /** 最新的 mtime。存在但全是 0 字节 / 十年没动的目录，多半不是这个游戏的存档 */
  newest: number
  /** 抽几个文件名给 agent 看，存档文件的扩展名往往一眼能认 */
  sample: string[]
}

const PROBE_MAX_FILES = 500

/** 只读地看一眼一个候选存档目录。不存在不是错误，是一个结论 */
export function probeSave(target: string): SaveProbe {
  const out: SaveProbe = { exists: false, files: 0, bytes: 0, newest: 0, sample: [] }

  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    return out
  }
  out.exists = true

  if (stat.isFile()) {
    out.files = 1
    out.bytes = stat.size
    out.newest = stat.mtimeMs
    out.sample = [path.basename(target)]
    return out
  }

  const stack = [target]
  while (stack.length > 0 && out.files < PROBE_MAX_FILES) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (out.files >= PROBE_MAX_FILES) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!e.isFile()) continue
      out.files++
      if (out.sample.length < 8) out.sample.push(e.name)
      try {
        const s = fs.statSync(full)
        out.bytes += s.size
        if (s.mtimeMs > out.newest) out.newest = s.mtimeMs
      } catch {
        /* 单个文件读不到不影响整体结论 */
      }
    }
  }
  return out
}
