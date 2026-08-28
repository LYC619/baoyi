/**
 * 真正动文件的那一层。
 *
 * 这是整个抱一里唯一会**改变用户磁盘内容**的代码，所以它的规矩比别处严：
 *   · 绝不覆盖。目标存在就报错退出，让上层记成冲突跳过。
 *   · 跨盘搬运必须「复制 → 逐文件校验 → 才删源」。顺序反了就是数据丢失，
 *     而不是一次失败的操作。
 *   · 每一步都可逆，逆向动作由 organizer.ts 依 plan 执行。
 */

import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { nestedInside, sameVolume } from './plan.ts'

/** 目录是不是一个 junction / 符号链接（而不是实体目录） */
export async function isLink(dir: string): Promise<boolean> {
  try {
    return (await fsp.lstat(dir)).isSymbolicLink()
  } catch {
    return false
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    // lstat 而不是 stat：指向已失效目标的链接自身仍然存在，那种情况也算占用
    await fsp.lstat(p)
    return true
  } catch {
    return false
  }
}

/**
 * 递归比对两棵目录树的文件清单和字节数。
 *
 * 跨盘搬运删源之前必须过这一关。刻意**不**做哈希：几个 GB 的目录逐字节校验
 * 要花掉和复制本身相当的时间，而「文件数一致 + 每个文件大小一致」已经能挡住
 * 真正会发生的那类故障（中途断电、磁盘满、权限拒绝导致的部分复制）。
 *
 * ponytail: 大小相同但内容损坏的情形查不出来。要那种保证得逐文件算哈希，
 * 代价是整理一个 5GB 目录从 30 秒变成 2 分钟。
 */
async function verifyCopy(from: string, to: string): Promise<string> {
  const walk = async (root: string): Promise<Map<string, number>> => {
    const out = new Map<string, number>()
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

  const [src, dst] = await Promise.all([walk(from), walk(to)])
  if (src.size !== dst.size) {
    return `复制校验失败：源 ${src.size} 个文件，目标 ${dst.size} 个`
  }
  for (const [rel, size] of src) {
    if (!dst.has(rel)) return `复制校验失败：目标缺少 ${rel}`
    if (dst.get(rel) !== size) return `复制校验失败：${rel} 大小不一致`
  }
  return ''
}

export interface MoveOutcome {
  ok: boolean
  /** 失败原因，成功时为空串 */
  note: string
}

/**
 * 把整个目录搬到 to。同盘走 rename（毫秒级），跨盘走复制 + 校验 + 删源。
 *
 * to 必须不存在 —— 存在就当冲突退出，绝不合并、绝不覆盖。
 */
export async function moveDir(from: string, to: string): Promise<MoveOutcome> {
  if (!(await exists(from))) return { ok: false, note: `源目录已经不在了：${from}` }
  if (await exists(to)) return { ok: false, note: `目标已存在同名文件夹，跳过：${to}` }
  if (nestedInside(from, to)) {
    return { ok: false, note: `目标 ${to} 在源目录内部，会自我嵌套，已跳过` }
  }

  await fsp.mkdir(path.dirname(to), { recursive: true })

  if (sameVolume(from, to)) {
    try {
      await fsp.rename(from, to)
      return { ok: true, note: '' }
    } catch (err: any) {
      // EXDEV：判断成同盘但其实跨了卷（挂载点、junction 指到别的盘）。退回复制
      if (err?.code !== 'EXDEV') {
        return { ok: false, note: `移动失败：${err?.code ?? err?.message ?? '未知错误'}` }
      }
    }
  }

  // 跨盘：先整棵复制过去
  try {
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  } catch (err: any) {
    // 复制失败要把半成品清掉，否则下次进来会被当成「目标已存在」而永远跳过
    await fsp.rm(to, { recursive: true, force: true }).catch(() => {})
    return { ok: false, note: `复制失败：${err?.code ?? err?.message ?? '未知错误'}` }
  }

  const bad = await verifyCopy(from, to)
  if (bad) {
    await fsp.rm(to, { recursive: true, force: true }).catch(() => {})
    return { ok: false, note: bad }
  }

  // 校验过了才敢删源。这个顺序是这个函数存在的全部意义
  try {
    await fsp.rm(from, { recursive: true, force: true })
  } catch (err: any) {
    // 复制成功但源删不掉（文件被占用）。目标是完好的，所以算成功但要说清楚，
    // 否则用户会以为整理完了，结果磁盘上留着一份重复
    return {
      ok: true,
      note: `已复制到目标，但源目录删除失败（${err?.code ?? '被占用'}），请手动清理：${from}`
    }
  }
  return { ok: true, note: '' }
}

/**
 * 在 at 建一个指向 target 的 junction。
 *
 * 用 junction 而不是 symlink：Windows 上目录 junction 不需要管理员权限也不需要
 * 开发者模式，而目录符号链接两者缺一不可。代价是 junction 只能指向本机绝对路径，
 * 对「把安装版软件在整理目录里露个脸」这个用途完全够用。
 */
export async function makeJunction(at: string, target: string): Promise<MoveOutcome> {
  if (!(await exists(target))) return { ok: false, note: `链接目标不存在：${target}` }
  if (await exists(at)) return { ok: false, note: `目标已存在同名文件夹，跳过：${at}` }

  await fsp.mkdir(path.dirname(at), { recursive: true })
  try {
    await fsp.symlink(target, at, 'junction')
  } catch (err: any) {
    return { ok: false, note: `创建链接失败：${err?.code ?? err?.message ?? '未知错误'}` }
  }
  return { ok: true, note: '' }
}

/** 链接目录里放的那个说明文件。名字带点前缀，避免和软件自己的文件撞名 */
export const LINK_MARK = '.baoyi_link'

/**
 * 在链接目录里写一份元信息。
 *
 * 注意它写进的是 **junction 指向的真实目录**（因为链接是透明的），所以内容里
 * 要说清这一点 —— 否则用户在原安装目录里看到这个文件会一脸茫然。
 */
export async function writeLinkMark(at: string, info: Record<string, unknown>): Promise<void> {
  const body = [
    '# 这个文件由「抱一」创建',
    '#',
    '# 整理目录下有一个 junction 链接指向本目录，抱一在卡片里显示的是链接位置，',
    '# 实际文件仍然在这里、没有被移动过。删掉这个文件不影响软件运行，',
    '# 但抱一就认不出这条链接的来历了。',
    '',
    JSON.stringify(info, null, 2)
  ].join('\n')
  await fsp.writeFile(path.join(at, LINK_MARK), body, 'utf-8').catch(() => {
    /* 标记文件写不进去（目录只读）不该让整理算失败，链接本身已经建好了 */
  })
}

/**
 * 删掉一个 junction。
 *
 * 必须先确认它真的是链接再删 —— 万一传进来的是实体目录，unlink/rm 会把用户的
 * 软件本体删掉。这是整个模块里最需要守住的一道判断。
 */
export async function removeJunction(at: string): Promise<MoveOutcome> {
  if (!(await isLink(at))) {
    return { ok: false, note: `${at} 不是链接，为安全起见没有删除` }
  }
  try {
    // 目录 junction 在 Windows 上要用 rmdir 而不是 unlink
    await fsp.rmdir(at)
  } catch {
    try {
      await fsp.unlink(at)
    } catch (err: any) {
      return { ok: false, note: `删除链接失败：${err?.code ?? err?.message ?? '未知错误'}` }
    }
  }
  return { ok: true, note: '' }
}

/** 一个目录里有多少字节，用来给进度条和确认文案提供体量感 */
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
