/**
 * 整理方案里的纯逻辑：路径怎么拼、文件夹名怎么规范、一条软件默认该走哪种操作。
 *
 * 和 agent/paths.ts 同样的理由单独成文件 —— 它不依赖 electron 和数据库，
 * 而这里每一个函数算错的后果都是「文件被搬到了不该去的地方」，
 * 属于最该单独验证的那一类（见 scripts/agent-selfcheck.ts）。
 */

import path from 'node:path'
import type { MoveRisk, OrganizeAction, SoftwareItem } from '../../../src/types'

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
 * 把用户输入或软件名洗成一个能真的建出来的文件夹名。
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
 * 默认目标文件夹名：软件的英文正式名优先。
 *
 * 用英文名而不是中文名，理由和 0.3 的命名规范是同一条 —— 目标目录是要用
 * 资源管理器、命令行、构建脚本去访问的，中文路径在那些地方是负担。
 * 没有英文名才退回中文名，最后退回原目录名。
 */
export function defaultFolder(item: Pick<SoftwareItem, 'name_en' | 'name_zh' | 'exe_path'>): string {
  const current = path.basename(path.dirname(item.exe_path))
  return sanitizeFolder(item.name_en || item.name_zh || current, current || 'Unnamed')
}

/**
 * 目标完整路径 = 整理根 / 分类 / 文件夹名。
 * 分类名也要洗 —— 用户可以把分类命名成「图像 / 视频」，那个斜杠会凭空多出一层目录。
 */
export function targetDir(root: string, category: string, folder: string): string {
  if (!root) return ''
  return path.join(root, sanitizeFolder(category, '其他'), sanitizeFolder(folder))
}

/**
 * 一条软件默认该怎么处理。用户可以在预览面板里逐条翻转，这里只给起点。
 *
 * 绿色软件搬走没有副作用，直接剪切。
 * 安装版判定为 safe 的也剪切 —— 但执行前还要过一遍引用扫描（见 organizer.ts），
 * 那一步才是真正的闸门，这里只决定「先摆哪个」。
 * risky 和 unknown 一律只做链接：unknown 是「没看出来」，赌它没事的代价是装的软件坏掉。
 */
export function defaultAction(isPortable: boolean | null, risk: MoveRisk): OrganizeAction {
  if (isPortable === true) return 'move'
  return risk === 'safe' ? 'move' : 'junction'
}

/**
 * 把 p 里的 fromDir 前缀换成 toDir。不在前缀下的路径原样返回 ——
 * 一个条目的附属启动端完全可能在别的目录里，那种不该被跟着改。
 *
 * 比较时忽略大小写：Windows 路径不区分大小写，而库里存的和 agent 当时看到的
 * 大小写未必一致（D:\Tools 和 d:\tools 是同一个目录）。
 */
export function rebase(p: string, fromDir: string, toDir: string): string {
  if (!p) return p
  const from = fromDir.replace(/[\\/]+$/, '')
  if (!from) return p
  if (p.toLowerCase() === from.toLowerCase()) return toDir
  if (!p.toLowerCase().startsWith(`${from.toLowerCase()}\\`)) return p
  return path.join(toDir, p.slice(from.length + 1))
}

/**
 * 两个路径是否在同一个盘上。同盘可以直接 rename（毫秒级），跨盘只能复制再删。
 * 判断依据是盘符，UNC 路径（\\server\share）一律当作跨盘 —— 保守走复制校验那条路。
 */
export function sameVolume(a: string, b: string): boolean {
  const of = (p: string) => {
    const m = /^([a-zA-Z]):/.exec(path.resolve(p))
    return m ? m[1].toLowerCase() : ''
  }
  const va = of(a)
  const vb = of(b)
  return va !== '' && va === vb
}

/**
 * 目标路径落在源目录里面吗。
 *
 * 这是必须拦的一种情形：把整理根设成 `D:\Software`，而某个软件本来就在
 * `D:\Software\x64dbg` —— 复制会一边读一边往自己里面写，走到磁盘满为止。
 * rename 那条路也会直接报 EINVAL。
 */
export function nestedInside(from: string, to: string): boolean {
  const f = path.resolve(from).replace(/[\\/]+$/, '').toLowerCase()
  const t = path.resolve(to).replace(/[\\/]+$/, '').toLowerCase()
  return t === f || t.startsWith(`${f}\\`)
}
