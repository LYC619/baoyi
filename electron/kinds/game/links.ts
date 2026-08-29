/**
 * 关联文件与封面的纯逻辑 —— Step 7 的判断规则都在这儿。
 *
 * 和这一层的其他文件同一个约定：只收数据、不碰 electron、不碰 database.ts，
 * 于是自检能把「去重、封顶、类型猜测、封面文件名」整个跑一遍。
 * service.ts 那边只负责选文件、拷文件、写库这几件必须有 Electron 才做得了的事。
 *
 * 关联文件这个字段在 Step 2 就建好了（game_meta.linked_files），识别时 agent
 * 也会往里填（tools.ts 的 coerceLinkedFiles）。Step 7 补的是**用户自己管**这一半：
 * 加、删、改标签、点开。两条来路的规则必须是同一份，否则「agent 填的最多 10 条、
 * 手工加的没有上限」这种事迟早出现。
 */

import path from 'node:path'
import type { LinkedFile } from '../../../src/types'

/** 闭集，库里存的是字符串，读回来要按这个名单兜一次 */
export const LINK_TYPES: Array<LinkedFile['type']> = [
  'guide',
  'trainer',
  'mod',
  'emulator',
  'other'
]

/**
 * 一个游戏最多挂多少条关联文件。
 *
 * 20 而不是无限：这份名单是给人看的，详情页上列到第二十条就已经不是「关联文件」
 * 而是「另一个文件管理器」了。真有那么多东西要管，该记的是那个目录而不是每个文件。
 * agent 那边另有个更紧的上限（10），理由不同 —— 那是怕它把整个游戏目录抄进来。
 */
export const MAX_LINKS = 20

/** 标签最长多少字。和 tools.ts 的 str(label, 20) 是同一个数 */
export const MAX_LABEL = 20

/**
 * 按扩展名猜一个类型。
 *
 * 猜得**保守**是刻意的：只有文档类和目录有把握，exe 一律归 other 而不是猜
 * 「修改器」—— 游戏目录旁边的 exe 可能是修改器，也可能是配置工具、汉化补丁、
 * 或者另一个游戏的启动器。猜错了用户得先看懂我们猜错了才能改，
 * 而 other 显示出来就是文件名本身，他一眼就知道该选什么。
 *
 * 类型这个字段只影响列表上显示的那个词（label 为空时的退路），不影响任何行为，
 * 所以「猜不准就不猜」的代价很低。
 */
export function guessLinkType(target: string, isDir = false): LinkedFile['type'] {
  if (isDir) return 'mod' // MOD 几乎总是一个目录，攻略和修改器几乎总是单个文件
  const ext = path.extname(target).toLowerCase()
  if (['.pdf', '.txt', '.md', '.doc', '.docx', '.html', '.htm', '.mht', '.chm'].includes(ext)) {
    return 'guide'
  }
  return 'other'
}

/** 路径比较统一走这个：Windows 不区分大小写，尾斜杠也不该算两条 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 这条路径在不在这个游戏的关联名单里。service 层拿它当越界检查 */
export function hasLink(list: LinkedFile[], target: string): boolean {
  return list.some((f) => samePath(f.path, target))
}

/**
 * 把新选的几条并进已有名单。返回新数组，不改入参。
 *
 * 三件事：已经在名单里的跳过（不是报错 —— 用户多选时框住一个已经加过的很正常）、
 * 标签截断、总数封顶。封顶时保留**已有的**那些，新的从头往里填到满为止：
 * 已有的那些是用户之前一条条挑出来的，比这一次框选的更该留。
 */
export function addLinks(list: LinkedFile[], incoming: LinkedFile[]): LinkedFile[] {
  const out = [...list]
  for (const item of incoming) {
    if (out.length >= MAX_LINKS) break
    if (!item.path.trim()) continue
    if (hasLink(out, item.path)) continue
    out.push({
      path: path.resolve(item.path),
      label: (item.label || '').trim().slice(0, MAX_LABEL) || path.basename(item.path),
      type: LINK_TYPES.includes(item.type) ? item.type : 'other'
    })
  }
  return out
}

/** 删一条。删不存在的那条时原样返回，让调用方自己决定要不要报 */
export function removeLink(list: LinkedFile[], target: string): LinkedFile[] {
  return list.filter((f) => !samePath(f.path, target))
}

/**
 * 改一条的标签。空标签退回文件名，而不是留一个空白 ——
 * 列表上那一列是用户认这条记录的唯一依据。
 */
export function relabelLink(list: LinkedFile[], target: string, label: string): LinkedFile[] {
  return list.map((f) =>
    samePath(f.path, target)
      ? { ...f, label: label.trim().slice(0, MAX_LABEL) || path.basename(f.path) }
      : f
  )
}

/* ------------------------------ 封面 ------------------------------ */

/**
 * 认的图片格式。
 *
 * 只放 Chromium 一定渲染得出来的那几个 —— 封面最终是渲染进程里的一个 <img>，
 * 收下一个 .tga 或 .psd 只会让用户看到一张破图，而破图比「这个格式不支持」
 * 难懂得多。.ico 刻意不收：它是图标，塞进 2:3 的封面框里必然糊。
 */
export const COVER_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp']

export function isCoverExt(file: string): boolean {
  return COVER_EXTS.includes(path.extname(file).toLowerCase())
}

/**
 * 封面在封面目录里叫什么。
 *
 * 用游戏 id 而不是游戏名：名字会改（详情页上就能改），而文件名跟着改就得同步
 * 挪文件，不挪就变成一堆对不上的孤儿。id 是不变的。
 *
 * 扩展名跟着源文件走，不统一转成 png —— 转格式要引一个图像库，而唯一的收益是
 * 文件名整齐。代价是换封面时可能留下一个旧扩展名的孤儿文件，所以调用方要
 * 顺手清一遍同名的其他扩展名（见 service.ts 的 setGameCover）。
 */
export function coverFileName(id: string, source: string): string {
  const ext = path.extname(source).toLowerCase()
  return `${id}${COVER_EXTS.includes(ext) ? ext : '.png'}`
}

/** 同一个游戏所有可能的封面文件名，换扩展名时拿它清孤儿 */
export function coverSiblings(id: string): string[] {
  return COVER_EXTS.map((ext) => `${id}${ext}`)
}
