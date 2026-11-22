import { getDb } from '../../../services/storage/database'
/**
 * 整理目录的「读回来」编排：把 syncPlan 算出来的对账结果落到库和磁盘上。
 *
 * 分工和 organize/index.ts 一样：syncPlan.ts 只读不写，这里才动库。
 * 但这里**不动用户的真实文件** —— 唯一的磁盘写入是给新入库的软件提图标，
 * 以及删孤立链接（删的是链接本身，不是软件）。
 *
 * 和「扫描目录」刻意分开：设置页早就警告过整理根不能放进扫描范围（否则整理进去的
 * 软件会被重扫再发现一遍）。这里不是把整理根加进扫描，而是另一条只认「整理根下的
 * 文件夹结构」的读回路 —— 它知道第一层是分类、第二层是软件，扫描器不知道。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import type { OrganizeSyncReport } from '../../../../src/types'
import { getSettings } from '../../../services/storage/settings-store.ts'
import { getSoftwareByPath, insertScanned, listSoftware, updateSoftware } from '../db.ts'
import { listCategories, upsertCategory } from '../../../services/taxonomy/taxonomy-store.ts'
import { remapPaths } from '../../../services/storage/organize-plans.ts'
import { exists, samePath, nestedInside } from '../../../services/system/fstree.ts'
import { extractIcon } from '../../../services/media/iconExtractor'
import { readPeInfo } from '../peReader'
import { LINK_MARK, entryExists, removeJunction } from './fsops.ts'
import { rootDirOf } from './plan.ts'
import { matchLayout, scanOrganizeLayout, type RecordRef } from './syncPlan.ts'

export async function syncOrganizeRoot(): Promise<OrganizeSyncReport> {
  const root = getSettings(getDb()).organize_root
  const report: OrganizeSyncReport = {
    root,
    ran: false,
    categories_added: [],
    software_added: [],
    healed: [],
    recategorized: [],
    missing: [],
    orphan_links: [],
    skipped_dirs: [],
    notes: []
  }
  if (!root) {
    report.notes.push('还没有设置整理目标目录')
    return report
  }
  if (!(await exists(root))) {
    report.notes.push(`整理目录不在了：${root}`)
    return report
  }
  report.ran = true

  const layout = await scanOrganizeLayout(root)

  // 分类：文件夹就是分类，缺哪个补哪个。只补不删 —— 删分类会把条目打回「其他」，
  // 而「文件夹没了」未必是用户想删分类（可能只是改了名）
  const existing = listCategories(getDb(), 'software')
  const known = new Set(existing.map((c) => c.name))
  let order = existing.reduce((n, c) => Math.max(n, c.sort_order), 0)
  for (const name of layout.categories) {
    if (known.has(name)) continue
    upsertCategory(
      getDb(), { id: '', name, description: '整理目录下的文件夹，同步时自动登记', icon: 'folder', sort_order: ++order },
      'software'
    )
    known.add(name)
    report.categories_added.push(name)
  }

  // 对账。归档的也要算进来：归档只是卡片墙不显示，文件还在整理目录里
  const records = [...listSoftware(getDb(), {}), ...listSoftware(getDb(), { group: 'archived' })]
  const refs: RecordRef[] = records.map((r) => ({
    id: r.id,
    dir: rootDirOf(r),
    link_target: r.link_target,
    exe_path: r.exe_path,
    category: r.category,
    name: r.name_en || r.name_zh || r.file_name
  }))
  const plan = await matchLayout(layout, refs, entryExists)

  for (const h of plan.healed) {
    // 旧记录可能只把 bin 当作根。文件并没有移动，只补全 source_dir。
    if (!h.preserve_paths) remapPaths(getDb(), h.id, h.from, h.to, h.link_target)
    updateSoftware(getDb(), h.id, { source_dir: h.to })
    report.healed.push({ name: h.name, from: h.from, to: h.to, why: h.why })
  }

  for (const c of plan.recategorized) {
    updateSoftware(getDb(), c.id, { category: c.to })
    report.recategorized.push({ name: c.name, from: c.from, to: c.to })
  }

  for (const a of plan.added) {
    let size = 0
    try {
      size = (await fsp.stat(a.exe)).size
    } catch {
      report.notes.push(`读不到主程序，跳过：${a.exe}`)
      continue
    }
    const pe = readPeInfo(a.exe, size)
    const inserted = insertScanned(getDb(), [
      {
        exe_path: a.exe,
        file_name: path.basename(a.exe),
        file_description: pe.file_description || pe.product_name,
        company: pe.company,
        version: pe.version,
        file_size: size
      }
    ])
    const item = inserted[0] ?? getSoftwareByPath(getDb(), a.exe)
    if (!item) {
      report.notes.push(`入库失败：${a.exe}`)
      continue
    }
    // insertScanned 把 source_dir 记成 exe 所在目录；这里要的是软件目录本身 ——
    // 它才是整理时被搬动 / 被链接的单位，exe 可能躺在它的 bin\ 里
    updateSoftware(getDb(), item.id, { source_dir: a.dir, category: a.category, name_zh: a.name })
    const icon = await extractIcon(a.exe)
    if (icon) updateSoftware(getDb(), item.id, { icon_path: icon })
    report.software_added.push({ name: a.name, dir: a.dir, category: a.category })
  }

  for (const s of plan.skipped) report.skipped_dirs.push({ dir: s.dir, reason: s.reason })
  for (const m of plan.missing) report.missing.push({ name: m.name, dir: m.dir })

  for (const o of plan.orphans) {
    // readlink 读得出目标不等于目标还在：目标被删了链接自己还立着。两种都算失效
    const broken = o.target === '' || !(await exists(o.target))
    // 目标目录里带着抱一写的标记，说明这条链接是整理时建的；没标记的可能是用户自己放的
    const ours = !broken && (await exists(path.join(o.target, LINK_MARK)))
    report.orphan_links.push({ path: o.dir, name: o.name, target: o.target, broken, ours })
  }

  return report
}

/**
 * 删掉孤立链接。只删链接本身：removeJunction 会先确认它真的是链接，
 * 传进来一个实体目录也不会误删 —— 那道判断是整个模块里最要紧的一道。
 */
export async function removeOrphanLinks(
  paths: string[]
): Promise<{ removed: number; removed_paths: string[]; failed: number; notes: string[] }> {
  let removed = 0
  const removed_paths: string[] = []
  let failed = 0
  const notes: string[] = []
  const root = getSettings(getDb()).organize_root
  if (!root) return { removed: 0, removed_paths, failed: paths.length, notes: ['还没有设置整理目录'] }
  const layout = await scanOrganizeLayout(root)
  const records = [...listSoftware(getDb(), {}), ...listSoftware(getDb(), { group: 'archived' })]
  for (const p of new Set(paths)) {
    const entry = layout.software.find(s => samePath(s.dir, p) && s.is_link)
    const owned = records.some(r => nestedInside(p, rootDirOf(r)))
    if (!entry || owned) {
      failed++
      notes.push(`${p}：不是整理目录中的孤立链接，未删除`)
      continue
    }
    const outcome = await removeJunction(p)
    if (outcome.ok) {
      removed++
      removed_paths.push(p)
    } else {
      failed++
      notes.push(`${p}：${outcome.note}`)
    }
  }
  return { removed, removed_paths, failed, notes }
}
