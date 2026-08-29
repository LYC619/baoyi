/**
 * 整理方案里的纯逻辑：路径怎么拼、文件夹名怎么规范、一条软件默认该走哪种操作。
 *
 * 和 agent/paths.ts 同样的理由单独成文件 —— 它不依赖 electron 和数据库，
 * 而这里每一个函数算错的后果都是「文件被搬到了不该去的地方」，
 * 属于最该单独验证的那一类（见 scripts/agent-selfcheck.ts）。
 */

import path from 'node:path'
import type { MoveRisk, OrganizeAction, SoftwareItem } from '../../../../src/types'
import { nestedInside, sanitizeFolder } from '../../../services/fstree.ts'

/**
 * 文件夹名规范和路径包含判断都搬到了公共层（services/fstree.ts）——
 * 游戏存档备份也要用它们，而「一个文件夹名能不能建出来」跟品类无关。
 * 这里原样转出去，整理模块内部和自检的引用都不必知道它们搬过家了。
 */
export { nestedInside, sanitizeFolder }

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
