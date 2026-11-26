import { transaction } from '../../workspace/validation.ts'
import type { SqlDb } from '../../services/storage/schema.ts'

/** Include hidden groups: taxonomy edits must not leave stale tags behind. */
export function imageTagCounts(db: SqlDb, excludeHidden = false): Array<{ name: string; count: number }> {
  if (excludeHidden) {
    return db.prepare(`SELECT t.value AS name, COUNT(DISTINCT r.id) AS count
      FROM resource r JOIN image_meta m ON m.resource_id=r.id, json_each(r.tags) t
      WHERE r.kind='image' AND (m.group_id IS NULL OR NOT EXISTS(SELECT 1 FROM image_groups g WHERE g.id=m.group_id AND g.hidden=1))
      GROUP BY t.value ORDER BY t.value`).all() as Array<{ name: string; count: number }>
  }
  return db.prepare(`SELECT t.value AS name, COUNT(DISTINCT r.id) AS count
    FROM resource r, json_each(r.tags) t WHERE r.kind='image'
    GROUP BY t.value ORDER BY t.value`).all() as Array<{ name: string; count: number }>
}

export function renameImageTag(db: SqlDb, from: string, to: string | null): number {
  if (typeof from !== 'string' || !from.trim() || (to !== null && (typeof to !== 'string' || !to.trim() || to.trim().length > 60))) throw new Error('标签名称无效')
  const target = to?.trim() ?? null
  if (target === from) return 0
  return transaction(db, () => {
    const rows = db.prepare(`SELECT id,tags FROM resource WHERE kind='image' AND EXISTS(SELECT 1 FROM json_each(tags) WHERE value=?)`).all(from) as Array<{ id: string; tags: string }>
    const update = db.prepare("UPDATE resource SET tags=?, updated_at=? WHERE id=? AND kind='image'")
    for (const row of rows) {
      const tags = JSON.parse(row.tags) as string[]
      update.run(JSON.stringify([...new Set(tags.flatMap(tag => tag === from ? target === null ? [] : [target] : [tag]))]), Date.now(), row.id)
    }
    return rows.length
  })
}
