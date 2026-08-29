/**
 * 整理模块里真正动文件的那一层。
 *
 * 会改写用户磁盘的地方总共两处 —— 这里，和游戏的存档备份（kinds/game/backup.ts）。
 * 两处的规矩相同，共用 services/fstree.ts 的复制校验：
 *   · 绝不覆盖。目标存在就报错退出，让上层记成冲突跳过。
 *   · 跨盘搬运必须「复制 → 逐文件校验 → 才删源」。顺序反了就是数据丢失，
 *     而不是一次失败的操作。
 *   · 每一步都可逆，逆向动作由 organizer.ts 依 plan 执行。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { dirSize, exists, verifyCopy } from '../../../services/fstree.ts'
import { nestedInside, sameVolume } from './plan.ts'

/**
 * 目录树的遍历、复制校验、体量统计都在公共层（services/fstree.ts）——
 * 「怎么确认这份拷贝是完整的」跟「为什么要复制」无关，游戏存档备份用的是同一套。
 * 这里转出去，整理模块内部的引用不必知道它们搬过家了。
 */
export { dirSize, exists }

/** 目录是不是一个 junction / 符号链接（而不是实体目录） */
export async function isLink(dir: string): Promise<boolean> {
  try {
    return (await fsp.lstat(dir)).isSymbolicLink()
  } catch {
    return false
  }
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
