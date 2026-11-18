import type { ScanUnit, ScanUnitStatus } from '../../src/types/index.ts'
import type { SqlDb } from './schema.ts'
import { transaction } from '../workspace/validation.ts'

type Row = Record<string, any>

/* ------------------------------ 扫描单元 ------------------------------ */

function rowToUnit(row: Row): ScanUnit {
  return {
    dir: row.dir,
    root: row.root,
    exe_count: row.exe_count ?? 0,
    loose_only: row.loose_only === 1,
    status: (row.status ?? 'pending') as ScanUnitStatus,
    note: row.note ?? '',
    registered: row.registered ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

/**
 * 写入本次扫描发现的目录。已存在的目录保留原状态（不重复付费识别），只刷新 exe 数量。
 *
 * 返回的三个数字是按**状态**分的，不是按「行是否已存在」分的 ——
 * 一个之前就在表里、但还没识别过的目录，对用户来说仍然是「待识别」而不是「已处理」。
 */
export function upsertScanUnits(
  d: SqlDb, units: Array<Pick<ScanUnit, 'dir' | 'root' | 'exe_count' | 'loose_only'>>
): { added: number; pending: number; settled: number } {

  const now = Date.now()
  const insert = d.prepare(
    `INSERT INTO scan_units (dir, root, exe_count, loose_only, status, note, registered, created_at, updated_at)
     VALUES (@dir, @root, @exe_count, @loose_only, 'pending', '', 0, @now, @now)
     ON CONFLICT(dir) DO UPDATE SET exe_count = @exe_count, root = @root, updated_at = @now`
  )
  const current = d.prepare('SELECT status FROM scan_units WHERE dir = ?')

  let added = 0
  let pending = 0
  let settled = 0
  transaction(d, () => {
    for (const u of units) {
      const row = current.get(u.dir) as Row | undefined
      if (!row) {
        added++
        pending++
      } else if (row.status === 'pending' || row.status === 'failed') {
        // 之前就发现了但还没识别成功，这次照样得跑
        pending++
      } else {
        settled++
      }
      insert.run({
        dir: u.dir,
        root: u.root,
        exe_count: u.exe_count,
        loose_only: u.loose_only ? 1 : 0,
        now
      })
    }
  })

  return { added, pending, settled }
}

export function listScanUnits(d: SqlDb, status?: ScanUnitStatus): ScanUnit[] {

  const rows = (
    status
      ? d.prepare('SELECT * FROM scan_units WHERE status = ? ORDER BY dir').all(status)
      : d.prepare('SELECT * FROM scan_units ORDER BY status, dir').all()
  ) as Row[]
  return rows.map(rowToUnit)
}

/**
 * 还需要跑 agent 的目录：没跑过的，加上跑失败的。
 * 失败的必须算进来 —— 否则一个目录失败一次就永远卡住，只能靠「全部重新识别」才捞得回来。
 */
export function listUnfinishedUnits(d: SqlDb): ScanUnit[] {
  const rows = d
    .prepare(`SELECT * FROM scan_units WHERE status IN ('pending','failed') ORDER BY status, dir`)
    .all() as Row[]
  return rows.map(rowToUnit)
}

export function markScanUnit(
  d: SqlDb, dir: string,
  status: ScanUnitStatus,
  note = '',
  registered = 0
): void {
  d
    .prepare(
      `UPDATE scan_units SET status = ?, note = ?, registered = ?, updated_at = ? WHERE dir = ?`
    )
    .run(status, note.slice(0, 300), registered, Date.now(), dir)
}

/** 把所有非 pending 的单元退回 pending，用于「全部重新识别」 */
export function resetScanUnits(d: SqlDb): number {
  const info = d
    .prepare(`UPDATE scan_units SET status = 'pending', note = '', updated_at = ? WHERE status != 'pending'`)
    .run(Date.now())
  return Number(info.changes)
}

/** 单个目录退回待识别。跳过/失败的目录旁边那个「重试」按钮走这里 */
export function resetScanUnit(d: SqlDb, dir: string): boolean {
  const info = d
    .prepare(`UPDATE scan_units SET status = 'pending', note = '', updated_at = ? WHERE dir = ?`)
    .run(Date.now(), dir)
  return Number(info.changes) > 0
}

/** 扫描目录被移除时，连带清掉它名下的单元 */
export function removeScanUnitsUnder(d: SqlDb, root: string): number {
  const info = d.prepare('DELETE FROM scan_units WHERE root = ?').run(root)
  return Number(info.changes)
}
