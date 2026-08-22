import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ScanProgress, ScanResult, ScanUnit, SoftwareItem } from '../../src/types'
import { insertScanned, updateSoftware, upsertScanUnits } from './database'
import { extractIcon } from './iconExtractor'
import { readPeInfo } from './peReader'

/**
 * 扫描只做一件事：把扫描根拆成若干「识别单元」交给 agent，并数清每个单元里有多少 exe。
 *
 * 这里刻意不再判断「哪个 exe 是主程序」「哪些该过滤」「32/64 位怎么合并」——
 * 那些规则全部交给 agent（见 agent/prompts.ts）。留在这里的只有遍历护栏：
 * 没有它们，选中 C:\ 会把 WinSxS 走穿，那是性能问题，不是识别问题。
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '$recycle.bin', 'system volume information',
  'windows', 'winsxs', 'temp', 'tmp', 'cache', '__pycache__', '.cache'
])

/** 防止用户误选 C:\ 时无限递归 */
const MAX_DEPTH = 8
/** 单个识别单元内最多统计的 exe 数，纯粹是计数上限，不影响 agent 能看到什么 */
const MAX_EXES_PER_UNIT = 2000

let cancelled = false

export function cancelScan(): void {
  cancelled = true
}

function skippable(name: string): boolean {
  return SKIP_DIRS.has(name.toLowerCase()) || name.startsWith('.')
}

/** 递归统计一个目录下的 exe 数量 */
async function countExes(root: string, report: (dir: string) => void): Promise<number> {
  let count = 0
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (stack.length > 0) {
    if (cancelled || count >= MAX_EXES_PER_UNIT) break
    const { dir, depth } = stack.pop()!
    report(dir)

    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue // 权限不足 / 目录已消失，跳过即可
    }

    for (const entry of entries) {
      if (cancelled) break
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

type PlannedUnit = Pick<ScanUnit, 'dir' | 'root' | 'exe_count' | 'loose_only'>

/**
 * 把扫描根拆成识别单元：
 *   · 每个直接子目录各是一个单元 —— agent 拿到整棵子树，才能把 x32/x64 合并成一条
 *   · 扫描根本身如果直接放着 exe（绿色软件常见），单独作为一个 loose_only 单元
 */
async function planRoot(root: string, report: (dir: string) => void): Promise<PlannedUnit[]> {
  const units: PlannedUnit[] = []
  report(root)

  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return units
  }

  let looseCount = 0
  for (const entry of entries) {
    if (cancelled) break
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe') looseCount++
  }
  if (looseCount > 0) {
    units.push({ dir: root, root, exe_count: looseCount, loose_only: true })
  }

  for (const entry of entries) {
    if (cancelled) break
    if (!entry.isDirectory() || skippable(entry.name)) continue
    const dir = path.join(root, entry.name)
    const exeCount = await countExes(dir, report)
    // 一个 exe 都没有的目录不用惊动 agent
    if (exeCount > 0) units.push({ dir, root, exe_count: exeCount, loose_only: false })
    await new Promise((r) => setImmediate(r)) // 让出事件循环，保持窗口响应
  }

  return units
}

export async function scanDirectories(
  dirs: string[],
  onProgress: (p: ScanProgress) => void
): Promise<ScanResult> {
  cancelled = false

  const planned: PlannedUnit[] = []
  let lastReport = 0
  const report = (current: string) => {
    const now = Date.now()
    if (now - lastReport < 80) return
    lastReport = now
    const found = planned.reduce((n, u) => n + u.exe_count, 0)
    onProgress({ phase: 'walking', current, found, processed: 0, total: 0 })
  }

  for (const dir of dirs) {
    if (cancelled) break
    planned.push(...(await planRoot(dir, report)))
  }

  const found = planned.reduce((n, u) => n + u.exe_count, 0)
  const { added, pending, settled } = upsertScanUnits(planned)

  onProgress({ phase: 'done', current: '', found, processed: planned.length, total: planned.length })
  return { found, added, pending, settled }
}

/** 手动添加单个 exe：直接入库成待补全条目，交给 AI 那一步识别 */
export async function addSingleExe(exePath: string): Promise<SoftwareItem[]> {
  let size = 0
  try {
    size = fs.statSync(exePath).size
  } catch {
    return []
  }
  const pe = readPeInfo(exePath, size)
  const inserted = insertScanned([
    {
      exe_path: exePath,
      file_name: path.basename(exePath),
      file_description: pe.file_description || pe.product_name,
      company: pe.company,
      version: pe.version,
      file_size: size
    }
  ])
  for (const item of inserted) {
    const iconPath = await extractIcon(item.exe_path)
    if (iconPath) updateSoftware(item.id, { icon_path: iconPath })
  }
  return inserted
}
