/**
 * 把一个扫描根拆成若干「识别单元」。
 *
 * 单独成一个文件的理由和 organize/plan.ts 一样：这里只读文件系统，不碰数据库、
 * 不碰 Electron，所以 npm run selfcheck 能拿真实的临时目录树把它整个跑一遍。
 * scanner.ts 负责调它、报进度、写库。
 *
 * 这里刻意不判断「哪个 exe 是主程序」「哪些该过滤」「32/64 位怎么合并」——
 * 那些规则全部交给 agent（见 agent/prompts.ts）。留在这里的只有两件事：
 * 遍历护栏，以及「这个目录是一个软件，还是用户自己建的收纳目录」。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ScanUnit } from '../../../src/types'

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '$recycle.bin', 'system volume information',
  'windows', 'winsxs', 'temp', 'tmp', 'cache', '__pycache__', '.cache'
])

/** 防止用户误选 C:\ 时无限递归 */
const MAX_DEPTH = 8
/** 单个识别单元内最多统计的 exe 数，纯粹是计数上限，不影响 agent 能看到什么 */
const MAX_EXES_PER_UNIT = 2000
/**
 * 识别单元最深落在扫描根下第几层。1 = 直接子目录。
 * 分类目录每下钻一层就 +1，到这一层还没看出是软件目录就放弃 —— 再往下多半是
 * 某个软件的 bin\、locales\，把它们单独交给 agent 只会白花钱。
 */
const MAX_UNIT_DEPTH = 3

/** 还没解压的压缩包。它们不算「这一层有东西」，见 looksLikeCollection */
const ARCHIVE_EXTS = new Set(['.rar', '.zip', '.7z'])
/** 散落在扫描根那一层、只提示不处理的文件类型 */
const LOOSE_EXTS = new Set(['.exe', '.rar', '.zip', '.7z'])

export type PlannedUnit = Pick<ScanUnit, 'dir' | 'root' | 'exe_count' | 'loose_only'>

export interface ScanPlan {
  units: PlannedUnit[]
  /**
   * 散落在扫描根那一层的 exe 和压缩包。不生成识别单元 ——
   * 一个躺在 D:\Software 根上的安装器或没解压的包，还不是「装好的软件」，
   * 花钱识别它没有意义。只把数量报给用户，让他自己决定要不要归位。
   */
  loose: string[]
}

export interface PlanOptions {
  /** 每进入一个目录回调一次，用来在界面上显示「正在遍历……」 */
  onDir?: (dir: string) => void
  /** 返回 true 时立刻收手 */
  cancelled?: () => boolean
}

export function skippable(name: string): boolean {
  return SKIP_DIRS.has(name.toLowerCase()) || name.startsWith('.')
}

/** 一个目录这一层长什么样。三个字段就够决定它是软件还是收纳目录了 */
interface Level {
  /** 可以进去的子目录（skippable 的已经滤掉），绝对路径 */
  dirs: string[]
  /** 这一层直接躺着 exe */
  hasExe: boolean
  /** 这一层有除压缩包以外的普通文件 */
  hasFiles: boolean
}

async function readLevel(dir: string): Promise<Level> {
  const level: Level = { dirs: [], hasExe: false, hasFiles: false }

  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return level // 权限不足 / 目录已消失，当成空目录
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skippable(entry.name)) level.dirs.push(path.join(dir, entry.name))
      continue
    }
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (ext === '.exe') level.hasExe = true
    else if (!ARCHIVE_EXTS.has(ext)) level.hasFiles = true
  }
  return level
}

/**
 * 这是用户自己建的收纳目录（`1.system`、`3.实用工具`），还是一个软件？
 *
 * 判据只有一条：**这一层除了文件夹什么都没有**。
 *   · 收纳目录是用户自己码出来的，里面清一色是文件夹，顶多躺着几个还没解压的压缩包
 *   · 软件目录哪怕主程序藏在子目录里（Ghidra 靠 ghidraRun.bat 起、XMouseButtonControl
 *     把主程序分在 32bit\ 和 64bit\ 里），自己这一层也总会留下 readme、license、
 *     启动脚本或配置文件
 *
 * 「有 exe 就是软件目录」这一条不够用，且判错的方向是**不可挽回**的：
 * 一个单元就是一次 agent 会话，沙箱只开放 unit.dir 这棵子树。把一个软件拆成两个单元，
 * 32 位和 64 位就永远合不回一条了；反过来把收纳目录整个交给 agent，prompt 里的
 * 「合集目录」那一节还能兜住。所以拿不准时一律不拆。
 *
 * ponytail: 纯启发式，没读文件内容。已知它会误判的形状是「清一色子文件夹、
 * 连 readme 都没有的软件」—— 那种目录会被下钻拆开。真撞上了再往上加判据
 * （比如子目录名成对出现 x86/x64、或子目录里有同名 exe），不要改成递归读文件。
 */
function looksLikeCollection(level: Level): boolean {
  return !level.hasExe && !level.hasFiles && level.dirs.length > 0
}

/** 递归统计一个目录下的 exe 数量 */
async function countExes(root: string, opts: PlanOptions): Promise<number> {
  let count = 0
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (stack.length > 0) {
    if (opts.cancelled?.() || count >= MAX_EXES_PER_UNIT) break
    const { dir, depth } = stack.pop()!
    opts.onDir?.(dir)

    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue // 权限不足 / 目录已消失，跳过即可
    }

    for (const entry of entries) {
      if (opts.cancelled?.()) break
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH || skippable(entry.name)) continue
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe') {
        count++
        if (count >= MAX_EXES_PER_UNIT) break
      }
    }
  }
  return count
}

/**
 * 判一个目录：软件目录就生成识别单元，收纳目录就下钻一层再对每个子目录重判。
 * depth 从 1 起算（扫描根的直接子目录）。
 */
async function planDir(
  dir: string,
  root: string,
  depth: number,
  units: PlannedUnit[],
  opts: PlanOptions
): Promise<void> {
  if (opts.cancelled?.()) return
  opts.onDir?.(dir)

  const level = await readLevel(dir)

  if (!looksLikeCollection(level)) {
    // 软件目录：整棵子树交给 agent，它才有可能把 x32/x64 合并成一条
    const exeCount = await countExes(dir, opts)
    // 一个 exe 都没有的目录不用惊动 agent
    if (exeCount > 0) units.push({ dir, root, exe_count: exeCount, loose_only: false })
    return
  }

  if (depth >= MAX_UNIT_DEPTH) return

  for (const sub of level.dirs) {
    if (opts.cancelled?.()) break
    await planDir(sub, root, depth + 1, units, opts)
    await new Promise((r) => setImmediate(r)) // 让出事件循环，保持窗口响应
  }
}

/** 把一个扫描根拆成识别单元，同时把根那一层的散落文件记下来 */
export async function planRoot(root: string, opts: PlanOptions = {}): Promise<ScanPlan> {
  const units: PlannedUnit[] = []
  const loose: string[] = []
  opts.onDir?.(root)

  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return { units, loose }
  }

  for (const entry of entries) {
    if (opts.cancelled?.()) break
    if (!entry.isFile()) continue
    if (LOOSE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      loose.push(path.join(root, entry.name))
    }
  }

  for (const entry of entries) {
    if (opts.cancelled?.()) break
    if (!entry.isDirectory() || skippable(entry.name)) continue
    await planDir(path.join(root, entry.name), root, 1, units, opts)
    await new Promise((r) => setImmediate(r))
  }

  return { units, loose }
}
