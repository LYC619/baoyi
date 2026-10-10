import { randomUUID } from 'node:crypto'
import type { SqlDb } from './schema.ts'

/** All libraries and Settings share the same category names, scoped by resource kind. */
export function ensureResourceCategory(db: SqlDb, kind: string, value: string): void {
  const name = String(value || '').trim()
  if (!name) return
  db.prepare(`INSERT OR IGNORE INTO categories(id,kind,name,description,icon,sort_order)
    SELECT ?,?,?,'','folder',COALESCE(MAX(sort_order),0)+1 FROM categories WHERE kind=?`)
    .run(randomUUID(),kind,name,kind)
}

/** Repair names saved by older library editors without discarding their assignments. */
export function reconcileResourceCategories(db: SqlDb, kind: string): void {
  const rows = db.prepare(`SELECT DISTINCT category FROM resource WHERE kind=? AND TRIM(COALESCE(category,''))!=''
    AND NOT EXISTS(SELECT 1 FROM categories c WHERE c.kind=resource.kind AND c.name=resource.category)`).all(kind) as {category:string}[]
  for (const row of rows) ensureResourceCategory(db,kind,row.category)
}
