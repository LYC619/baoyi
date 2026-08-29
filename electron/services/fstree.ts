/**
 * 目录树的读与比对，以及路径本身的形状规矩。公共层的东西，不认识任何业务。
 *
 * 单独成文件的理由和 services/schema.ts 一样：这里每一个函数算错的后果都是
 * **用户的文件出事** —— 复制校验放行了一次残缺的拷贝、路径包含判断漏掉一种
 * 嵌套写法、文件夹名没洗干净导致目标落在别处。所以它只依赖 node 内置模块，
 * 自检能直接拿真实临时目录驱动它（见 scripts/agent-selfcheck.ts）。
 *
 * 由整理模块和游戏存档备份共用。两者「为什么复制」完全不同（一个是搬家、
 * 一个是留档），但「怎么确认这份拷贝是完整的」是同一件事，不该有两份实现 ——
 * 有两份就意味着某天只修好其中一份。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/* ============================== 路径的形状 ============================== */

/** Windows 文件名里不能出现的字符，外加控制字符 */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * Windows 保留的设备名。叫 CON 或 NUL 的文件夹建不出来，
 * 而失败信息是「参数错误」，不看这张表根本猜不到原因。
 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

/**
 * 把用户输入、软件名、游戏名洗成一个能真的建出来的文件夹名。
 *
 * 结尾的点和空格必须去掉：Windows 允许你请求 `Foo.`，但建出来的是 `Foo`，
 * 于是「目标已存在」的判断和实际落地的路径就对不上了。
 */
export function sanitizeFolder(raw: string, fallback = 'Unnamed'): string {
  const cleaned = raw
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 64)
  if (!cleaned) return fallback
  if (RESERVED.has(cleaned.toLowerCase())) return `${cleaned}_`
  return cleaned
}

/**
 * to 落在 from 里面吗（或者就是 from 自己）。
 *
 * 这是必须拦的一种情形：把整理根设成 `D:\Software`，而某个软件本来就在
 * `D:\Software\x64dbg` —— 复制会一边读一边往自己里面写，走到磁盘满为止。
 * rename 那条路也会直接报 EINVAL。存档备份那边同理：备份根设在存档目录里面，
 * 或者存档目录设在备份根里面，都是同一类自我吞噬。
 *
 * 两种分隔符都要认：库里的路径来自模型、来自对话框、也来自用户手输，
 * 只比 `\` 会让 `D:/Games` 这种写法整个漏过去。
 */
export function nestedInside(from: string, to: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  const f = norm(from)
  const t = norm(to)
  return t === f || t.startsWith(`${f}\\`) || t.startsWith(`${f}/`)
}

/**
 * 这个路径是不是一整个盘 / 一整个网络共享（`D:\`、`d:/`、`\\server\share`）。
 * 往这种路径上做「先删再写」是灾难。
 *
 * 判据是「resolve 之后它的父目录就是它自己」—— UNC 共享根也满足，那正是想要的：
 * 覆盖一整个共享和覆盖一整个盘一样坏。
 *
 * **不要单独用它来判断安全性。** 裸盘符 `D:`（没有反斜杠）是「盘 D 上的当前
 * 目录」而不是盘根，resolve 出来是个普通目录，这里会返回 false。那种路径的
 * 正确处理是当成「不是绝对路径」拒掉（见 backup.ts 的 restoreBlocked），
 * 因为它的含义取决于进程的当前目录 —— 猜它指哪儿本身就是错的。
 */
export function isDriveRoot(p: string): boolean {
  const resolved = path.resolve(p)
  return path.dirname(resolved) === resolved
}

/* ============================== 目录树 ============================== */

/** 一棵树的清单：相对路径（小写）-> 字节数。符号链接记 -1，只比存在性 */
export type TreeListing = Map<string, number>

/**
 * 递归列出一棵目录树里的所有文件。
 *
 * 键小写化是为了在 Windows 上跨两次遍历对得上 —— 复制过去的文件名大小写理论上
 * 一致，但网络盘和某些同步工具会改写它，那不该被算成「复制失败」。
 */
export async function walkTree(root: string): Promise<TreeListing> {
  const out: TreeListing = new Map()
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      const rel = path.relative(root, full).toLowerCase()
      if (e.isDirectory()) {
        stack.push(full)
        continue
      }
      if (e.isSymbolicLink()) {
        // 链接不比大小，只记它存在 —— lstat 的 size 是链接自身，两边不可比
        out.set(rel, -1)
        continue
      }
      out.set(rel, (await fsp.stat(full)).size)
    }
  }
  return out
}

/**
 * 比对两棵目录树的文件清单和字节数，返回一句失败原因（一致时为空串）。
 *
 * 刻意**不**做哈希：几个 GB 的目录逐字节校验要花掉和复制本身相当的时间，
 * 而「文件数一致 + 每个文件大小一致」已经能挡住真正会发生的那类故障
 * （中途断电、磁盘满、权限拒绝导致的部分复制）。
 *
 * ponytail: 大小相同但内容损坏的情形查不出来。要那种保证得逐文件算哈希，
 * 代价是整理一个 5GB 目录从 30 秒变成 2 分钟。
 */
export function diffTrees(src: TreeListing, dst: TreeListing): string {
  if (src.size !== dst.size) {
    return `复制校验失败：源 ${src.size} 个文件，目标 ${dst.size} 个`
  }
  for (const [rel, size] of src) {
    if (!dst.has(rel)) return `复制校验失败：目标缺少 ${rel}`
    if (dst.get(rel) !== size) return `复制校验失败：${rel} 大小不一致`
  }
  return ''
}

/** 遍历两边再比一次。复制完、删源之前必须过这一关 */
export async function verifyCopy(from: string, to: string): Promise<string> {
  const [src, dst] = await Promise.all([walkTree(from), walkTree(to)])
  return diffTrees(src, dst)
}

/** 一棵树的体量。文件数和总字节数都要，备份记录里两个都存 */
export function tallyTree(listing: TreeListing): { files: number; bytes: number } {
  let bytes = 0
  for (const size of listing.values()) if (size > 0) bytes += size
  return { files: listing.size, bytes }
}

/**
 * 一个目录里有多少字节，同步版。用来给进度条和确认文案提供体量感，
 * 所以设了访问上限 —— 数量级对了就够用，不值得为它把界面卡住。
 */
export function dirSize(dir: string): number {
  let total = 0
  const stack = [dir]
  let visited = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (++visited > 20_000) return total
      const full = path.join(current, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        total += fs.statSync(full).size
      } catch {
        /* 读不到就不计 */
      }
    }
  }
  return total
}

/* ============================== 存在性 ============================== */

export async function exists(p: string): Promise<boolean> {
  try {
    // lstat 而不是 stat：指向已失效目标的链接自身仍然存在，那种情况也算占用
    await fsp.lstat(p)
    return true
  } catch {
    return false
  }
}
