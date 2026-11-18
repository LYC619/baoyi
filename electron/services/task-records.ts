import type { TaskRecord } from '../../src/types/index.ts'
import type { SqlDb } from './schema.ts'

type Row = Record<string, any>

export function listTaskRecords(d: SqlDb): TaskRecord[] {
  const rows = d.prepare('SELECT * FROM task_records ORDER BY started_at DESC LIMIT 30').all() as Row[]
  return rows.map(row => ({
    id: String(row.id), kind: row.kind, title: String(row.title), status: row.status,
    startedAt: Number(row.started_at), finishedAt: Number(row.finished_at) || undefined,
    processed: Number(row.processed) || 0, total: Number(row.total) || 0, percent: Number(row.percent) || 0,
    current: String(row.current || ''), message: String(row.message || ''), error: String(row.error || '') || undefined,
    events: (() => { try { const value = JSON.parse(String(row.events || '[]')); return Array.isArray(value) ? value : [] } catch { return [] } })()
  })) as TaskRecord[]
}

export function saveTaskRecord(d: SqlDb, task: TaskRecord): void {
  d.prepare(`INSERT INTO task_records (id, kind, title, status, started_at, finished_at, processed, total, percent, current, message, error, events)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at, processed = excluded.processed,
      total = excluded.total, percent = excluded.percent, current = excluded.current, message = excluded.message,
      error = excluded.error, events = excluded.events`).run(task.id, task.kind, task.title, task.status, task.startedAt, task.finishedAt || 0, task.processed, task.total, task.percent, task.current, task.message, task.error || '', JSON.stringify(task.events))
}

export function interruptRunningTasks(d: SqlDb): void {
  d.prepare(`UPDATE task_records SET status = 'interrupted', finished_at = ?, message = '应用关闭前未完成，可重新执行' WHERE status = 'running'`).run(Date.now())
}

export function clearTaskRecords(d: SqlDb, ids?: string[]): number {
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !id || id.length > 256))) throw new Error('任务范围无效')
  if (ids?.length === 0) return 0
  const selected = ids ? [...new Set(ids)] : undefined
  return Number(d.prepare(`DELETE FROM task_records WHERE status != 'running'${selected ? ' AND id IN (' + selected.map(() => '?').join(',') + ')' : ''}`).run(...(selected || [])).changes)
}
