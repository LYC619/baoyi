/**
 * 目录整理的编排层：出方案 → 用户改 → 执行 → 可撤销。
 *
 * 分工是清楚的：
 *   plan.ts   路径怎么拼、默认走哪种操作（纯函数，可单测）
 *   fsops.ts  真的动文件（唯一会改磁盘的地方）
 *   refs.ts   安装版剪切前的引用取证
 *   这里      读库、拼方案、按 plan 执行、把结果写回库
 *
 * 一条铁律贯穿全文：**先落 plan，再动文件**。反过来的话，执行到一半崩了
 * 就再也没有东西能告诉用户「刚才那半截搬到哪去了」。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import type {
  OrganizeCommand,
  OrganizeEntry,
  OrganizePreview,
  OrganizeProgress,
  OrganizeResult,
  OrganizeStep,
  SoftwareItem,
  UndoResult
} from '../../../../src/types'
import {
  getOrganizePlan,
  getSettings,
  getSoftware,
  listSoftware,
  markPlanUndone,
  remapPaths,
  saveOrganizePlan,
  updateSoftware
} from '../../../services/database'
import { defaultAction, defaultFolder, nestedInside, rebase, targetDir } from './plan'
import {
  exists,
  isLink,
  LINK_MARK,
  makeJunction,
  moveDir,
  removeJunction,
  writeLinkMark
} from './fsops'
import { describeRefs, hasRefs, scanRefs } from './refs'

/**
 * 一个条目「要搬的那个目录」。
 *
 * 用 source_dir 而不是 path.dirname(exe_path)：agent 识别时记下的 source_dir 是
 * 软件的整棵子树根，而 exe 可能躺在 bin\ 里。搬 bin\ 会把软件劈成两半。
 * source_dir 为空（0.1.x 的老条目、手动添加的单个 exe）才退回 exe 所在目录。
 */
function rootDirOf(item: SoftwareItem): string {
  return item.source_dir || path.dirname(item.exe_path)
}

/**
 * 已经整理过的条目不再出现在方案里。
 *
 * 判据是「它当前的位置已经在整理根下面了」—— 比记一个 organized 标记位可靠：
 * 用户可能手工把目录挪回去，那时候它就该重新出现在方案里。
 */
function alreadyOrganized(item: SoftwareItem, root: string): boolean {
  if (!root) return false
  return nestedInside(root, rootDirOf(item))
}

/**
 * 出整理方案。不动任何文件。
 *
 * 引用扫描只对「安装版 + 打算剪切」的条目做 —— 那是唯一需要取证的组合。
 * 绿色软件搬走没有副作用，risky 的根本不会被剪切，两种都不值得花几秒去查注册表。
 */
export async function previewOrganize(ids?: string[]): Promise<OrganizePreview> {
  const root = getSettings().organize_root
  const all = ids?.length
    ? ids.map((id) => getSoftware(id)).filter((x): x is SoftwareItem => x !== null)
    : listSoftware({ group: 'all' })

  const entries: OrganizeEntry[] = []

  for (const item of all) {
    if (!ids?.length && alreadyOrganized(item, root)) continue

    const from = rootDirOf(item)
    const action = defaultAction(item.is_portable, item.move_risk)
    const folder = defaultFolder(item)
    const to = targetDir(root, item.category, folder)

    const warnings: string[] = []
    if (!(await exists(from))) warnings.push(`源目录已经不在了：${from}`)
    if (nestedInside(from, to)) warnings.push('目标路径落在源目录内部，无法移动')

    // 安装版要剪切：先把证据摆出来
    if (action === 'move' && item.is_portable !== true) {
      const refs = await scanRefs(from)
      if (hasRefs(refs)) warnings.push(describeRefs(refs))
    }

    const conflict = to !== '' && (await exists(to))
    if (conflict) warnings.push(`目标已存在同名文件夹，执行时会跳过：${to}`)

    entries.push({
      software_id: item.id,
      name: item.name_en || item.name_zh || item.file_name,
      from_dir: from,
      exe_path: item.exe_path,
      is_portable: item.is_portable,
      move_risk: item.move_risk,
      link_target: item.link_target,
      action,
      category: item.category,
      folder,
      to_dir: to,
      warning: warnings.join('　'),
      conflict
    })
  }

  // 需要用户注意的排在前面：有警告的、以及要动真格（move）的
  entries.sort((a, b) => {
    const wa = a.warning ? 0 : 1
    const wb = b.warning ? 0 : 1
    if (wa !== wb) return wa - wb
    return a.name.localeCompare(b.name, 'zh')
  })

  return { root, entries }
}

/**
 * 按用户提交的指令执行整理。
 *
 * commands 来自渲染进程，不可信：目标路径由这里用 targetDir 现拼，
 * 绝不接受渲染进程传过来的 to_dir —— 那等于让页面决定往磁盘哪里写。
 */
export async function runOrganize(
  commands: OrganizeCommand[],
  onProgress: (p: OrganizeProgress) => void
): Promise<OrganizeResult> {
  const root = getSettings().organize_root
  const steps: OrganizeStep[] = []
  const todo = commands.filter((c) => c.action !== 'skip')

  let processed = 0
  const report = (current: string, failed: number) =>
    onProgress({ phase: 'running', current, processed, total: todo.length, failed })

  if (!root) {
    return { plan_id: '', moved: 0, linked: 0, skipped: commands.length, failed: 0, steps: [] }
  }

  let failed = 0
  for (const cmd of todo) {
    const item = getSoftware(cmd.software_id)
    if (!item) {
      processed++
      continue
    }

    const from = rootDirOf(item)
    const to = targetDir(root, cmd.category, cmd.folder)
    report(item.name_en || item.name_zh || item.file_name, failed)

    const step: OrganizeStep = {
      type: cmd.action,
      software_id: item.id,
      name: item.name_en || item.name_zh || item.file_name,
      from,
      to,
      from_exe: item.exe_path,
      to_exe: rebase(item.exe_path, from, to),
      ok: false,
      note: ''
    }

    if (cmd.action === 'move') {
      // 已经是链接的条目不能「移动」：那会把链接搬走，真实文件留在原地，
      // 而链接的相对含义已经变了。要先转实体再谈移动
      if (await isLink(from)) {
        step.note = '这一条目前是链接，不能直接移动。先在详情页「转为实体」再整理'
      } else {
        const outcome = await moveDir(from, to)
        step.ok = outcome.ok
        step.note = outcome.note
        if (outcome.ok) remapPaths(item.id, from, to, '')
      }
    } else {
      // 已经是链接的条目不能再套一层链接。整目录预览时这种条目会被
      // alreadyOrganized 滤掉，但用户点着某一条单独整理时走不到那个过滤
      if (item.link_target || (await isLink(from))) {
        step.note = '这一条已经是链接了，不需要再建。要换位置先「移除链接」再整理'
      } else {
        const outcome = await makeJunction(to, from)
        step.ok = outcome.ok
        step.note = outcome.note
        if (outcome.ok) {
          await writeLinkMark(to, {
            software: step.name,
            real_path: from,
            link_path: to,
            created_at: new Date().toISOString(),
            reason: item.is_portable === true ? 'portable-but-linked' : `move_risk=${item.move_risk}`
          })
          // exe_path 指向链接那一侧：用户在整理目录里看到的就是它，
          // 而 junction 是透明的，从链接启动和从真实路径启动完全等价
          remapPaths(item.id, from, to, from)
        }
      }
    }

    if (!step.ok) failed++
    steps.push(step)
    processed++
    report(step.name, failed)
  }

  onProgress({ phase: 'done', current: '', processed, total: todo.length, failed })

  // 只要动过一次文件就必须留下 plan，哪怕全都失败了 —— 失败的那些也可能
  // 已经把文件复制了一半，用户需要看到清单才知道去哪儿检查
  const planId = steps.length > 0 ? saveOrganizePlan(root, steps) : ''

  return {
    plan_id: planId,
    moved: steps.filter((s) => s.ok && s.type === 'move').length,
    linked: steps.filter((s) => s.ok && s.type === 'junction').length,
    skipped: commands.length - todo.length,
    failed,
    steps
  }
}

/**
 * 按 plan 逆向执行。
 *
 * 逆序走：先做的最后撤。同一批里如果有两条互相嵌套的目录（不该发生，但用户可以
 * 手工编辑目标路径造出来），逆序是唯一能安全解开的顺序。
 *
 * 只撤 ok 的步骤。失败的那些本来就没动成，再「撤」一遍等于凭空删东西。
 */
export async function undoOrganize(planId: string): Promise<UndoResult> {
  const plan = getOrganizePlan(planId)
  if (!plan) return { restored: 0, failed: 0, notes: ['找不到这条整理记录'] }
  if (plan.undone_at > 0) return { restored: 0, failed: 0, notes: ['这条记录已经撤销过了'] }

  let restored = 0
  let failed = 0
  const notes: string[] = []

  for (const step of [...plan.steps].reverse()) {
    if (!step.ok) continue

    if (step.type === 'junction') {
      const outcome = await removeJunction(step.to)
      if (outcome.ok) {
        // 标记文件写在真实目录里（junction 是透明的），链接删掉之后它还留着
        await fsp.rm(path.join(step.from, LINK_MARK), { force: true }).catch(() => {})
        remapPaths(step.software_id, step.to, step.from, '')
        restored++
      } else {
        failed++
        notes.push(`${step.name}：${outcome.note}`)
      }
      continue
    }

    // move 的逆动作就是反着搬一次，连同校验和「不覆盖」的规矩一起复用
    const outcome = await moveDir(step.to, step.from)
    if (outcome.ok) {
      remapPaths(step.software_id, step.to, step.from, '')
      restored++
      if (outcome.note) notes.push(`${step.name}：${outcome.note}`)
    } else {
      failed++
      notes.push(`${step.name}：${outcome.note}`)
    }
  }

  // 部分失败也打标：剩下的那些已经回不去了，再点一次撤销只会把成功的那批
  // 反向搬第二遍。失败原因在 notes 里，用户按提示手工处理
  markPlanUndone(planId)
  return { restored, failed, notes }
}

/**
 * 把一条链接换成实体：真实文件搬到链接所在的位置。
 *
 * 顺序是关键 —— 先把真实目录搬到一个临时名，再删链接，再改名到位。
 * 直接搬到链接路径上会失败（那个位置被链接占着），而先删链接再搬的话，
 * 中间那一瞬间万一崩了，用户会发现整理目录里什么都没有了。
 */
export async function materialize(id: string): Promise<{ ok: boolean; message: string }> {
  const item = getSoftware(id)
  if (!item) return { ok: false, message: '找不到这个条目' }
  if (!item.link_target) return { ok: false, message: '这一条不是链接，无需转换' }

  const linkPath = item.source_dir || path.dirname(item.exe_path)
  if (!(await isLink(linkPath))) {
    return { ok: false, message: `${linkPath} 已经不是链接了，可能已被手工处理过` }
  }

  const staging = `${linkPath}.baoyi_tmp`
  if (await exists(staging)) {
    return { ok: false, message: `临时目录 ${staging} 已存在，请先手工清理` }
  }

  const moved = await moveDir(item.link_target, staging)
  if (!moved.ok) return { ok: false, message: moved.note }

  const dropped = await removeJunction(linkPath)
  if (!dropped.ok) {
    // 链接删不掉：把真实文件搬回去，回到操作前的状态
    await moveDir(staging, item.link_target)
    return { ok: false, message: dropped.note }
  }

  try {
    await fsp.rename(staging, linkPath)
  } catch (err: any) {
    return {
      ok: false,
      message: `已搬到 ${staging} 但改名失败（${err?.code ?? '未知'}），请手工改名为 ${linkPath}`
    }
  }

  await fsp.rm(path.join(linkPath, LINK_MARK), { force: true }).catch(() => {})
  updateSoftware(id, { link_target: '' })
  return { ok: true, message: `已转为实体目录：${linkPath}` }
}

/** 只删链接，不动源。条目的路径退回真实位置 */
export async function unlink(id: string): Promise<{ ok: boolean; message: string }> {
  const item = getSoftware(id)
  if (!item) return { ok: false, message: '找不到这个条目' }
  if (!item.link_target) return { ok: false, message: '这一条不是链接，没有可移除的链接' }

  const linkPath = item.source_dir || path.dirname(item.exe_path)
  const outcome = await removeJunction(linkPath)
  if (!outcome.ok) return { ok: false, message: outcome.note }

  await fsp.rm(path.join(item.link_target, LINK_MARK), { force: true }).catch(() => {})
  remapPaths(id, linkPath, item.link_target, '')
  return { ok: true, message: `已移除链接，条目指回 ${item.link_target}` }
}
