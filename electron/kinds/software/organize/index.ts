import { getDb } from '../../../services/storage/database'
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
import { isMobilePackage } from '../../../../src/utils/software-package'
import fsp from 'node:fs/promises'
import type {
  OrganizeCommand,
  OrganizeEntry,
  OrganizePreview,
  OrganizeProgress,
  OrganizeResult,
  OrganizeStep,
  OrganizedEntry,
  OrganizedList,
  RelocatePreview,
  RelocateResult,
  RemoveSoftwareResult,
  SoftwareItem,
  UndoResult
} from '../../../../src/types'
import { deleteSoftware, getSoftware, getSoftwareByPath, listSoftware, updateSoftware } from '../db.ts'
import { getOrganizePlan, markPlanUndone, remapPaths, saveOrganizePlan } from '../../../services/storage/organize-plans.ts'
import { getSettings } from '../../../services/storage/settings-store.ts'
import { listCategories, upsertCategory } from '../../../services/taxonomy/taxonomy-store.ts'
import { samePath } from '../../../services/system/fstree.ts'
import {
  alreadyOrganized,
  defaultAction,
  defaultFolder,
  nestedInside,
  rebase,
  rootDirOf,
  sameVolume,
  sanitizeFolder,
  targetDir
} from './plan'
import {
  exists,
  entryExists,
  checkLibraryPath,
  isLink,
  LINK_MARK,
  linkTargetOf,
  makeJunction,
  moveDir,
  removeJunction,
  writeLinkMark
} from './fsops'
import { describeRefs, hasRefs, scanRefs } from './refs'

const SHARED_LEAF_DIRS = new Set(['downloads', 'desktop', 'documents', '下载', '桌面', '文档'])

function isSharedLooseExe(item: SoftwareItem, allItems: SoftwareItem[], scanDirs: string[]): boolean {
  if (isMobilePackage(item.exe_path) || item.link_target) return false
  const from = rootDirOf(item)
  if (!samePath(from, path.dirname(item.exe_path))) return false
  if ((item.launchers?.length ?? 0) > 1) return false
  const leaf = path.basename(from.replace(/[\\/]+$/, '')).toLowerCase()
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (SHARED_LEAF_DIRS.has(leaf) || (home && samePath(from, home))) return true
  if (scanDirs.some((r) => r && samePath(r, from))) return true
  return allItems.some(
    (other) =>
      other.id !== item.id &&
      (samePath(rootDirOf(other), from) || samePath(path.dirname(other.exe_path), from))
  )
}

async function moveSingleFile(fromFile: string, toFile: string): Promise<{ ok: boolean; note: string }> {
  try {
    const srcStat = await fsp.stat(fromFile)
    if (!srcStat.isFile()) return { ok: false, note: `未找到源文件：${fromFile}` }
    if (await entryExists(toFile)) return { ok: false, note: `目标文件已存在，已跳过：${toFile}` }
    await fsp.mkdir(path.dirname(toFile), { recursive: true })
    if (sameVolume(fromFile, toFile)) {
      await fsp.rename(fromFile, toFile)
      return { ok: true, note: '' }
    }
    await fsp.copyFile(fromFile, toFile)
    const dstStat = await fsp.stat(toFile)
    if (dstStat.size !== srcStat.size) {
      await fsp.rm(toFile, { force: true }).catch(() => { /* best-effort */ })
      return { ok: false, note: '跨盘复制大小校验不一致，已保留原文件' }
    }
    await fsp.rm(fromFile, { force: true })
    return { ok: true, note: '' }
  } catch (err: any) {
    return { ok: false, note: `文件移动失败：${err?.code ?? err?.message ?? '未知错误'}` }
  }
}

/**
 * 出整理方案。不动任何文件。
 *
 * 引用扫描只对「安装版 + 打算剪切」的条目做 —— 那是唯一需要取证的组合。
 * 绿色软件搬走没有副作用，risky 的根本不会被剪切，两种都不值得花几秒去查注册表。
 */
export async function previewOrganize(ids?: string[]): Promise<OrganizePreview> {
  const settings = getSettings(getDb())
  const root = settings.organize_root
  const libraryItems = [...listSoftware(getDb(), {}), ...listSoftware(getDb(), { group: 'archived' })]
  const scanDirs = settings.software_scan_dirs ?? []
  const all = ids?.length
    ? ids.map((id) => getSoftware(getDb(), id)).filter((x): x is SoftwareItem => x !== null)
    : listSoftware(getDb(), { group: 'all' })

  const entries: OrganizeEntry[] = []

  for (const item of all) {
    if (!ids?.length && (alreadyOrganized(item, root) || isMobilePackage(item.exe_path))) continue

    const from = rootDirOf(item)
    const mobile = isMobilePackage(item.exe_path)
    const looseSingle = isSharedLooseExe(item, libraryItems, scanDirs)
    const action = mobile
      ? 'skip'
      : looseSingle
        ? item.is_portable === false && item.move_risk === 'risky'
          ? 'skip'
          : 'move'
        : defaultAction(item.is_portable, item.move_risk)
    const baseName = path.basename(item.exe_path, path.extname(item.exe_path))
    const folder = looseSingle
      ? sanitizeFolder(item.name_en || item.name_zh || baseName, baseName || 'App')
      : defaultFolder(item)
    const to = targetDir(root, item.category, folder)

    const warnings: string[] = []
    if (mobile) warnings.push('手机 APP 安装包保留原文件，本次不参与电脑软件的整目录整理')
    if (looseSingle) warnings.push('位于共用目录，整理时仅将该单文件移入新建子文件夹，不移动整个上级目录')
    if (!(await exists(looseSingle ? item.exe_path : from))) warnings.push(`源路径已经不在了：${looseSingle ? item.exe_path : from}`)
    if (!looseSingle && nestedInside(from, to)) warnings.push('目标路径落在源目录内部，无法移动')

    // 安装版要剪切：先把证据摆出来
    if (action === 'move' && item.is_portable !== true && !looseSingle) {
      const refs = await scanRefs(from)
      if (hasRefs(refs)) warnings.push(describeRefs(refs))
    }

    const conflict = to !== '' && (await exists(to))
    if (conflict) warnings.push(`目标已存在同名文件夹，执行时会跳过：${to}`)

    entries.push({
      software_id: item.id,
      name: item.name_en || item.name_zh || item.file_name,
      from_dir: looseSingle ? item.exe_path : from,
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
  const settings = getSettings(getDb())
  const root = settings.organize_root
  const libraryItems = [...listSoftware(getDb(), {}), ...listSoftware(getDb(), { group: 'archived' })]
  const scanDirs = settings.software_scan_dirs ?? []
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
    const item = getSoftware(getDb(), cmd.software_id)
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

    const looseSingle = isSharedLooseExe(item, libraryItems, scanDirs)
    if (isMobilePackage(item.exe_path)) {
      step.note = '手机 APP 安装包不参与电脑软件的整目录整理'
    } else if (looseSingle) {
      const toExe = path.join(to, path.basename(item.exe_path))
      step.single_file = true
      step.to_exe = toExe
      if (cmd.action === 'junction') {
        step.note = '共用目录下的单文件不支持整目录链接，请选择移动或跳过'
      } else if (await entryExists(to)) {
        step.note = `目标已存在同名目录，已跳过：${to}`
      } else {
        await fsp.mkdir(to, { recursive: true })
        const outcome = await moveSingleFile(item.exe_path, toExe)
        step.ok = outcome.ok
        step.note = outcome.note
        if (outcome.ok) {
          updateSoftware(getDb(), item.id, {
            exe_path: toExe,
            source_dir: to,
            launchers: (item.launchers ?? []).map((l) =>
              samePath(l.path, item.exe_path) ? { ...l, path: toExe } : l
            )
          })
        } else {
          await fsp.rmdir(to).catch(() => { /* best-effort */ })
        }
      }
    } else if (cmd.action === 'move') {
      // 已经是链接的条目不能「移动」：那会把链接搬走，真实文件留在原地，
      // 而链接的相对含义已经变了。要先转实体再谈移动
      if (await isLink(from)) {
        step.note = '这一条目前是链接，不能直接移动。先在详情页「转为实体」再整理'
      } else {
        const outcome = await moveDir(from, to)
        step.ok = outcome.ok
        step.note = outcome.note
        if (outcome.ok) remapPaths(getDb(), item.id, from, to, '')
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
          remapPaths(getDb(), item.id, from, to, from)
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
  const planId = steps.length > 0 ? saveOrganizePlan(getDb(), root, steps) : ''

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
  const plan = getOrganizePlan(getDb(), planId)
  if (!plan) return { restored: 0, failed: 0, notes: ['找不到这条整理记录'] }
  if (plan.undone_at > 0) return { restored: 0, failed: 0, notes: ['这条记录已经撤销过了'] }

  let restored = 0
  let failed = 0
  const notes: string[] = []

  for (const step of [...plan.steps].reverse()) {
    if (!step.ok) continue

    if (step.single_file) {
      const outcome = await moveSingleFile(step.to_exe, step.from_exe)
      if (outcome.ok) {
        await fsp.rmdir(step.to).catch(() => { /* best-effort */ })
        const current = getSoftware(getDb(), step.software_id)
        if (current) {
          updateSoftware(getDb(), step.software_id, {
            exe_path: step.from_exe,
            source_dir: step.from,
            launchers: (current.launchers ?? []).map((l) =>
              samePath(l.path, step.to_exe) ? { ...l, path: step.from_exe } : l
            )
          })
        }
        restored++
      } else {
        failed++
        notes.push(`${step.name}：${outcome.note}`)
      }
      continue
    }

    if (step.type === 'junction') {
      const outcome = await removeJunction(step.to)
      if (outcome.ok) {
        // 标记文件写在真实目录里（junction 是透明的），链接删掉之后它还留着
        await fsp.rm(path.join(step.from, LINK_MARK), { force: true }).catch(() => { /* best-effort */ })
        remapPaths(getDb(), step.software_id, step.to, step.from, '')
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
      remapPaths(getDb(), step.software_id, step.to, step.from, '')
      restored++
      if (outcome.note) notes.push(`${step.name}：${outcome.note}`)
    } else {
      failed++
      notes.push(`${step.name}：${outcome.note}`)
    }
  }

  // 部分失败也打标：剩下的那些已经回不去了，再点一次撤销只会把成功的那批
  // 反向搬第二遍。失败原因在 notes 里，用户按提示手工处理
  markPlanUndone(getDb(), planId)
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
  const item = getSoftware(getDb(), id)
  if (!item) return { ok: false, message: '找不到这个条目' }
  if (!item.link_target) return { ok: false, message: '这一条不是链接，无需转换' }

  const linkPath = item.source_dir || path.dirname(item.exe_path)
  if (!(await isLink(linkPath))) {
    return { ok: false, message: `${linkPath} 已经不是链接了，可能已被手工处理过` }
  }
  if (!samePath(await linkTargetOf(linkPath), item.link_target)) {
    return { ok: false, message: '链接目标已变化，请先核对软件记录' }
  }
  const invalid = await checkLibraryPath(getSettings(getDb()).organize_root, linkPath)
  if (invalid) return { ok: false, message: invalid }
  const shared = [...listSoftware(getDb(), {}), ...listSoftware(getDb(), { group: 'archived' })].some(r => r.id !== id && (
    nestedInside(linkPath, rootDirOf(r)) || nestedInside(item.link_target, rootDirOf(r)) || (r.link_target && samePath(r.link_target, item.link_target))
  ))
  if (shared) return { ok: false, message: '其他软件记录仍依赖这个目录，请先处理共用记录' }

  const staging = `${linkPath}.baoyi_tmp`
  if (await entryExists(staging)) {
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

  await fsp.rm(path.join(linkPath, LINK_MARK), { force: true }).catch(() => { /* best-effort */ })
  updateSoftware(getDb(), id, { link_target: '' })
  return { ok: true, message: `已转为实体目录：${linkPath}` }
}

/** 只删链接，不动源。条目的路径退回真实位置 */
export async function unlink(id: string): Promise<{ ok: boolean; message: string }> {
  const item = getSoftware(getDb(), id)
  if (!item) return { ok: false, message: '找不到这个条目' }
  if (!item.link_target) return { ok: false, message: '这一条不是链接，没有可移除的链接' }

  const linkPath = item.source_dir || path.dirname(item.exe_path)
  const invalid = await checkLibraryPath(getSettings(getDb()).organize_root, linkPath)
  if (invalid) return { ok: false, message: invalid }
  if (!samePath(await linkTargetOf(linkPath), item.link_target)) return { ok: false, message: '链接目标已变化，请先核对软件记录' }
  const shared = [...listSoftware(getDb(), {}), ...listSoftware(getDb(), { group: 'archived' })].some(r => r.id !== id && nestedInside(linkPath, rootDirOf(r)))
  if (shared) return { ok: false, message: '其他软件记录仍共用这个链接，请先处理共用记录' }
  const outcome = await removeJunction(linkPath)
  if (!outcome.ok) return { ok: false, message: outcome.note }

  await fsp.rm(path.join(item.link_target, LINK_MARK), { force: true }).catch(() => { /* best-effort */ })
  remapPaths(getDb(), id, linkPath, item.link_target, '')
  return { ok: true, message: `已移除链接，条目指回 ${item.link_target}` }
}

/* ------------------------------ 已整理 ------------------------------ */

/**
 * 已整理的条目：当前位置已经在整理根下面的那些。
 *
 * 和 previewOrganize 正好互补 —— 那边把它们滤掉，这边只要它们。归档的也算：
 * 归档只是卡片墙不显示，文件还在整理目录里占着位置。
 */
export async function listOrganized(ids?: string[]): Promise<OrganizedList> {
  const root = getSettings(getDb()).organize_root
  if (!root) return { root: '', entries: [] }

  const items = ids
    ? [...new Set(ids)].map(id => getSoftware(getDb(), id)).filter((item): item is SoftwareItem => item !== null)
    : [...listSoftware(getDb(), {}), ...listSoftware(getDb(), { group: 'archived' })]
  const entries: OrganizedEntry[] = []

  for (const item of items) {
    if (!alreadyOrganized(item, root)) continue
    const dir = rootDirOf(item)
    const present = await entryExists(dir)
    const liveLink = await isLink(dir)
    // Existing paths are classified by the disk, including reinstalls over old junctions.
    const link = present ? liveLink : item.link_target !== ''
    const target = liveLink ? await linkTargetOf(dir) : link ? item.link_target : ''
    const rel = path.relative(root, dir).split(/[\\/]/).filter(Boolean)
    const folderCategory = rel.length > 1 ? rel[0] : ''

    entries.push({
      software_id: item.id,
      name: item.name_en || item.name_zh || item.file_name,
      dir,
      exe_path: item.exe_path,
      category: item.category,
      folder_category: folderCategory,
      folder: path.basename(dir),
      is_link: link,
      link_target: target,
      target_ok: link ? target !== '' && (await exists(target)) : true,
      present,
      exe_present: await exists(item.exe_path),
      category_mismatch: folderCategory !== '' && folderCategory !== item.category,
      is_portable: item.is_portable,
      move_risk: item.move_risk,
      is_archived: item.is_archived
    })
  }

  entries.sort(
    (a, b) =>
      a.folder_category.localeCompare(b.folder_category, 'zh') ||
      a.name.localeCompare(b.name, 'zh')
  )
  return { root, entries }
}

/**
 * 改一条已整理条目的分类 / 文件夹名。
 *
 * 实体目录就是再搬一次；链接是「删旧 junction → 在新位置建一个指向同一处的 junction」，
 * 真实文件自始至终没动。新链接建不起来就把旧的原位补回去 —— 不能让整理目录里
 * 凭空少一条。
 */
export async function previewRelocateOrganized(
  id: string,
  category: string,
  folder: string
): Promise<RelocatePreview> {
  const root = getSettings(getDb()).organize_root
  const item = getSoftware(getDb(), id)
  const from = item ? rootDirOf(item) : ''
  const to = targetDir(root, category, folder)
  const preview: RelocatePreview = { ok: false, message: '', from, to, category: path.basename(path.dirname(to)), folder: path.basename(to), is_link: false }
  const fail = (message: string) => ({ ...preview, message })
  if (!root) return fail('还没有设置整理目标目录')
  if (!item) return fail('找不到这个条目')
  if (isMobilePackage(item.exe_path)) return fail('手机 APP 安装包不参与电脑软件的整目录整理')
  const invalid = await checkLibraryPath(root, from) || await checkLibraryPath(root, to)
  if (invalid) return fail(invalid)
  if (!samePath(from, to) && await entryExists(to)) return fail(`目标已存在，没有动：${to}`)
  if (!await entryExists(from)) return fail('原目录已不存在，请先同步整理目录')
  const other = [...listSoftware(getDb(), {}), ...listSoftware(getDb(), { group: 'archived' })].find(r => r.id !== id && nestedInside(from, rootDirOf(r)))
  if (other) return fail('这个文件夹还有其他软件记录引用，请先合并或移除重复记录')
  const duplicate = getSoftwareByPath(getDb(), rebase(item.exe_path, from, to))
  if (duplicate && duplicate.id !== id) return fail('目标程序路径已被另一条记录占用')

  const liveLink = await isLink(from)
  if (item.link_target || liveLink) {
    const target = await linkTargetOf(from)
    if (!liveLink || !target) return fail('链接状态已变化，请先检查原目录')
    if (item.link_target && !samePath(item.link_target, target)) return fail('链接目标已变化，请先核对软件记录')
    if (!await exists(target)) return fail('链接目标已失效，原链接保留，请先修复目标路径')
    preview.is_link = true
  }
  if (!preview.is_link && item.is_portable !== true && !samePath(from, to)) {
    preview.warning = '安装版或尚未确认类型的软件移动后，注册表、快捷方式和卸载程序可能仍指向原位置。建议用安装程序重新安装到目标目录。'
  }
  return { ...preview, ok: true }
}

/** Register a newly used folder category without rescanning the whole library. */
function ensureFolderCategory(name: string): void {
  const categories = listCategories(getDb(), 'software')
  if (categories.some(c => c.name === name)) return
  upsertCategory(getDb(), { id: '', name, description: '整理目录下的文件夹', icon: 'folder', sort_order: Math.max(0, ...categories.map(c => c.sort_order)) + 1 }, 'software')
}

export async function relocateOrganized(id: string, category: string, folder: string, expectedFrom?: string): Promise<RelocateResult> {
  const preview = await previewRelocateOrganized(id, category, folder)
  if (!preview.ok) return preview
  const { from, to } = preview
  if (expectedFrom && !samePath(from, expectedFrom)) return { ok: false, message: '位置已变化，请重新预览' }
  const item = getSoftware(getDb(), id)!
  if (samePath(from, to)) {
    updateSoftware(getDb(), id, { category: preview.category })
    ensureFolderCategory(preview.category)
    return { ok: true, message: '位置没有变化，分类已同步' }
  }

  if (preview.is_link) {
    const target = await linkTargetOf(from)
    // 先建新链接，成功后才删旧的，失败不会丢掉原入口。
    const made = await makeJunction(to, target)
    if (!made.ok) return { ok: false, message: made.note }

    const dropped = await removeJunction(from)
    if (!dropped.ok) {
      await removeJunction(to)
      return { ok: false, message: dropped.note }
    }
    await writeLinkMark(to, {
      software: item.name_en || item.name_zh || item.file_name,
      real_path: target,
      link_path: to,
      created_at: new Date().toISOString(),
      reason: 'relocate'
    })
    remapPaths(getDb(), id, from, to, target)
    updateSoftware(getDb(), id, { category: preview.category, source_dir: to })
    ensureFolderCategory(preview.category)
    return { ok: true, message: `链接已移到 ${to}` }
  }

  const outcome = await moveDir(from, to)
  if (!outcome.ok) return { ok: false, message: outcome.note }
  remapPaths(getDb(), id, from, to, '')
  updateSoftware(getDb(), id, { category: preview.category, source_dir: to })
  ensureFolderCategory(preview.category)
  return { ok: true, message: outcome.note ? `已移动到 ${to}。${outcome.note}` : `已移动到 ${to}` }
}

/**
 * 移除一条记录，顺手把整理目录里属于它的链接删掉。
 *
 * 只删链接、不删实体：用户要的是「删记录别留一个空壳链接」，不是「删软件」。
 * 链接删不掉就连记录也不删 —— 留一半的状态（记录没了、链接还在）正是这个
 * 功能要治的毛病。
 *
 * 「属于它的」要守住：link_target 为空、又不在整理根下面的 junction 不碰 ——
 * 那是用户自己在别处建的链接，抱一没有资格替他删。
 */
export async function deleteSoftwareRecord(id: string): Promise<RemoveSoftwareResult> {
  const item = getSoftware(getDb(), id)
  if (!item) return { ok: true, message: '记录已经不在了', link_removed: false }

  const root = getSettings(getDb()).organize_root
  const dir = rootDirOf(item)
  const liveLink = await isLink(dir)
  const safeLayout = root !== '' && !(await checkLibraryPath(root, dir))
  const target = liveLink ? await linkTargetOf(dir) : ''
  // 记录里保存的链接仍归这条记录管理，即使用户后来换过整理根。
  const ours = item.link_target !== '' || (safeLayout && target !== '' && await exists(path.join(target, LINK_MARK)))
  const shared = [...listSoftware(getDb(), {}), ...listSoftware(getDb(), { group: 'archived' })].some(x => x.id !== id && nestedInside(dir, rootDirOf(x)))
  let real = item.link_target
  let removed = false

  if (liveLink && ours && !shared) {
    if (item.link_target && !samePath(item.link_target, target)) {
      return { ok: false, message: '链接目标已变化，请先核对后再移除记录', link_removed: false }
    }
    const read = await linkTargetOf(dir)
    if (read) real = read
    const dropped = await removeJunction(dir)
    if (!dropped.ok) {
      return {
        ok: false,
        message: `链接删除失败：${dropped.note}。为免留下半截状态，记录没有删除`,
        link_removed: false
      }
    }
    removed = true
  }

  // 标记文件写在真实目录里。只有确认没有别的条目还指向同一个真实目录时才清掉它，
  // 否则会把另一条链接的来历一起抹了
  if (real && removed) {
    const others = [...listSoftware(getDb(), {}), ...listSoftware(getDb(), { group: 'archived' })].filter(
      (x) => x.id !== id && x.link_target !== '' && samePath(x.link_target, real)
    )
    if (others.length === 0) {
      await fsp.rm(path.join(real, LINK_MARK), { force: true }).catch(() => { /* best-effort */ })
    }
  }

  deleteSoftware(getDb(), id)
  return {
    ok: true,
    message: removed ? '已移除记录，整理目录里的链接一并删掉了' : '已移除记录',
    link_removed: removed
  }
}
