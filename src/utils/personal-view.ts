
import { tr } from '../i18n/core.ts'
import type { PersonalRecord } from '../types/workspace.ts'

export function daysUntil(value: unknown, today: string): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== value) return null
  return Math.round((time - Date.parse(today)) / 86400000)
}

export function dueText(value: unknown, today: string) {
  const days = daysUntil(value, today)
  return days === null ? tr('未设置日期') : days < 0 ? tr('已逾期 {p0} 天', {p0: -days}) : days === 0 ? tr('今天到期') : tr('{p0} 天后到期', {p0: days})
}

export function filterTodos(records: PersonalRecord[], view: string, query: string, today: string) {
  const needle = query.trim().toLocaleLowerCase()
  return records.filter(r => {
    if (r.kind !== 'todo' || ![r.name, r.body].join(' ').toLocaleLowerCase().includes(needle)) return false
    const days = daysUntil(r.data.dueOn, today)
    if (view === 'all') return true
    if (view === 'completed') return !!r.data.done
    if (r.data.done) return false
    if (view === 'overdue') return days !== null && days < 0
    if (view === 'today') return days === 0
    if (view === 'upcoming') return days !== null && days > 0 && days <= 7
    return true
  }).sort((a,b) => Number(!!a.data.done) - Number(!!b.data.done) || String(a.data.dueOn || '9999').localeCompare(String(b.data.dueOn || '9999')) || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}
