import { randomUUID } from 'node:crypto'
import { rebase } from '../../kinds/software/organize/plan.ts'
import type { OrganizePlan, OrganizeStep, SoftwareItem } from '../../../src/types/index.ts'
import { getSoftware } from '../../kinds/software/db.ts'
import type { SqlDb } from './schema.ts'
import { transaction } from '../../workspace/validation.ts'

type Row = Record<string, any>

/* ------------------------------ 整理记录 ------------------------------ */

function rowToPlan(row: Row): OrganizePlan {
  let steps: OrganizeStep[] = []
  try {
    const parsed = JSON.parse(row.steps ?? '[]')
    if (Array.isArray(parsed)) steps = parsed
  } catch {
    /* 解析不出来就当空，至少记录本身还在，用户能看到「那天整理过」 */
  }
  return {
    id: row.id,
    created_at: row.created_at,
    root: row.root ?? '',
    undone_at: row.undone_at ?? 0,
    steps
  }
}

export function saveOrganizePlan(d: SqlDb, root: string, steps: OrganizeStep[]): string {
  const id = randomUUID()
  d
    .prepare(
      `INSERT INTO organize_plans (id, created_at, root, undone_at, steps)
       VALUES (?, ?, ?, 0, ?)`
    )
    .run(id, Date.now(), root, JSON.stringify(steps))
  return id
}

export function listOrganizePlans(d: SqlDb): OrganizePlan[] {
  return (
    d.prepare('SELECT * FROM organize_plans ORDER BY created_at DESC').all() as Row[]
  ).map(rowToPlan)
}

export function getOrganizePlan(d: SqlDb, id: string): OrganizePlan | null {
  const row = d.prepare('SELECT * FROM organize_plans WHERE id = ?').get(id) as Row | undefined
  return row ? rowToPlan(row) : null
}

/** 撤销完成后打标。已撤销的记录留着 —— 它回答的是「那天到底动了什么」 */
export function markPlanUndone(d: SqlDb, id: string): void {
  // 反引号不是随手写的：selfcheck 靠模板字符串的边界从构建产物里抠 SQL 原文出来
  // 做 prepare 校验（见 scripts/agent-selfcheck.ts），单引号的语句它取不到
  d.prepare(`UPDATE organize_plans SET undone_at = ? WHERE id = ?`).run(Date.now(), id)
}

/**
 * 目录搬走之后，把库里所有指向旧位置的路径改到新位置。
 *
 * 要改的不止 exe_path —— launchers 里每个启动端、source_dir、以及 scan_units
 * 的主键都带着旧前缀。漏掉任何一个都会表现成「整理完点启动就失败」，
 * 而那时候用户已经不知道是整理干的了。
 *
 * fromDir / toDir 传目录，不带结尾分隔符。
 */
export function remapPaths(
  d: SqlDb, id: string,
  fromDir: string,
  toDir: string,
  linkTarget: string
): SoftwareItem | null {

  const item = getSoftware(d, id)
  if (!item) return null

  const launchers = item.launchers.map((l) => ({ ...l, path: rebase(l.path, fromDir, toDir) }))
  const nextExe = rebase(item.exe_path, fromDir, toDir)

  transaction(d, () => {
    d.prepare(
      `UPDATE resource SET path = @exe_path, source_dir = @source_dir, updated_at = @updated_at
       WHERE id = @id`
    ).run({
      id,
      exe_path: nextExe,
      source_dir: rebase(item.source_dir, fromDir, toDir),
      updated_at: Date.now()
    })
    // launchers 和 link_target 是软件私有的，在 meta 表上
    d.prepare(
      `UPDATE software_meta SET launchers = @launchers, link_target = @link_target
       WHERE resource_id = @id`
    ).run({ id, launchers: JSON.stringify(launchers), link_target: linkTarget })

    // scan_units.dir 是主键，改不了就删旧插新。整理过的目录已经不在扫描根下了，
    // 留着那一行只会让下次「全部重新识别」去一个不存在的路径
    const unit = d.prepare('SELECT * FROM scan_units WHERE dir = ?').get(fromDir) as Row | undefined
    if (unit) {
      d.prepare('DELETE FROM scan_units WHERE dir = ?').run(fromDir)
      d.prepare(
        `INSERT INTO scan_units (dir, root, exe_count, loose_only, status, note, registered, created_at, updated_at)
         VALUES (@dir, @root, @exe_count, @loose_only, @status, @note, @registered, @created_at, @updated_at)
         ON CONFLICT(dir) DO NOTHING`
      ).run({ ...unit, dir: toDir, updated_at: Date.now() })
    }
  })

  return getSoftware(d, id)
}
