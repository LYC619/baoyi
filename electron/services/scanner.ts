import fs from 'node:fs'
import path from 'node:path'
import type { ScanProgress, ScanResult, SoftwareItem } from '../../src/types'
import { insertScanned, updateSoftware, upsertScanUnits } from './database'
import { extractIcon } from './iconExtractor'
import { readPeInfo } from './peReader'
import { planRoot, type PlannedUnit } from './scanPlan'

/**
 * 扫描只做一件事：把扫描根拆成若干「识别单元」交给 agent，并数清每个单元里有多少 exe。
 *
 * 「怎么拆」全在 scanPlan.ts 里（它不碰数据库，所以能被 selfcheck 真跑）。
 * 这里剩下的是编排：遍历各个根、节流上报进度、写库。
 */

let cancelled = false

export function cancelScan(): void {
  cancelled = true
}

export async function scanDirectories(
  dirs: string[],
  onProgress: (p: ScanProgress) => void
): Promise<ScanResult> {
  cancelled = false

  const planned: PlannedUnit[] = []
  const loose: string[] = []
  let lastReport = 0
  const onDir = (current: string) => {
    const now = Date.now()
    if (now - lastReport < 80) return
    lastReport = now
    const found = planned.reduce((n, u) => n + u.exe_count, 0)
    onProgress({ phase: 'walking', current, found, processed: 0, total: 0 })
  }

  for (const dir of dirs) {
    if (cancelled) break
    const plan = await planRoot(dir, { onDir, cancelled: () => cancelled })
    planned.push(...plan.units)
    loose.push(...plan.loose)
  }

  const found = planned.reduce((n, u) => n + u.exe_count, 0)
  const { added, pending, settled } = upsertScanUnits(planned)

  onProgress({ phase: 'done', current: '', found, processed: planned.length, total: planned.length })
  return { found, added, pending, settled, loose_files: loose }
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
