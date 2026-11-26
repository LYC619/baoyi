
import { tr } from '../i18n/index.ts'
import type { DocumentItem, DocumentProjectReference } from '../types/workspace'

export function recentGroupDocuments(rows: readonly DocumentItem[]): DocumentItem[] {
  return [...rows].sort((a, b) => {
    const aRead = a.lastReadAt > 0, bRead = b.lastReadAt > 0
    if (aRead !== bRead) return aRead ? -1 : 1
    return (aRead ? b.lastReadAt - a.lastReadAt : b.updatedAt - a.updatedAt)
      || a.id.localeCompare(b.id)
  }).slice(0, 4)
}

export function documentProgress(
  item: Pick<DocumentItem, 'readable' | 'readState' | 'pageCount' | 'position'>,
): number | null {
  if (!item.readable) return null
  if (item.readState === 'read') return 100
  if (!Number.isFinite(item.pageCount) || item.pageCount < 1) return null
  if (item.readState === 'unread') return 0
  const page = Number.isFinite(item.position.page) ? item.position.page : 1
  const offset = Number.isFinite(item.position.offset)
    ? item.position.offset
    : 0
  const ratio =
    (Math.max(1, Math.min(item.pageCount, page)) -
      1 +
      Math.max(0, Math.min(1, offset))) /
    item.pageCount
  return Math.min(99, Math.max(0, Math.round(ratio * 100)))
}

export function groupDocuments(rows: DocumentItem[], sort: string) {
  const recent = rows
    .filter((i) => i.readable && i.readState === 'reading' && i.lastReadAt > 0)
    .sort((a, b) => b.lastReadAt - a.lastReadAt)
    .slice(0, 6)
  const used = new Set(recent.map((i) => i.id))
  return {
    recent,
    remaining: rows
      .filter((i) => !used.has(i.id))
      .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh') : b.updatedAt - a.updatedAt),
  }
}

export function documentSections(rows: DocumentItem[], groupBy: string, names: Map<string, string>, title: string) {
  const groups = new Map<string, { key: string; title: string; items: DocumentItem[] }>()
  for (const item of rows) {
    const keys = groupBy === 'tag' ? [...new Set(item.tags.length ? item.tags : [''])]
      : [groupBy === 'category' ? item.type : groupBy === 'source' ? item.sourceDir || '' : groupBy === 'custom' ? item.customGroupId || '' : 'all']
    for (const key of keys) {
      const label = groupBy === 'none' ? title : groupBy === 'category' ? item.typeName : groupBy === 'custom' ? names.get(key) || tr("未分组") : groupBy === 'source' ? key || tr("来源未记录") : key || tr("无标签")
      if (!groups.has(key)) groups.set(key, { key: groupBy + ':' + key, title: label, items: [] })
      groups.get(key)!.items.push(item)
    }
  }
  return [...groups.values()]
}

export function tagCounts(rows: DocumentItem[]) {
  const counts = new Map<string, number>()
  for (const row of rows)
    for (const tag of new Set(row.tags))
      counts.set(tag, (counts.get(tag) || 0) + 1)
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b, 'zh'))
    .map(([name, count]) => ({ name, count }))
}

export function projectCounts(references: DocumentProjectReference[]) {
  const projects = new Map<string, Set<string>>()
  for (const r of references) {
    if (!projects.has(r.documentId)) projects.set(r.documentId, new Set())
    projects.get(r.documentId)!.add(r.projectId)
  }
  return new Map([...projects].map(([id, values]) => [id, values.size]))
}
