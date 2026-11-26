import { tr, locale } from '../i18n/index.ts'

export type LibraryGrouping = 'none' | 'category' | 'directory'
const normalized = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
/** Use the longest configured root, and never confuse sibling path prefixes. */
export function libraryDirectoryGroup(directory: string, roots: string[]): { key: string; name: string } {
  const dir = normalized(directory), lower = dir.toLowerCase()
  const root = roots.map(normalized).filter(value => value && (lower === value.toLowerCase() || lower.startsWith(value.toLowerCase() + '/'))).sort((a,b) => b.length-a.length)[0]
  if (!root) return { key: dir || 'unknown', name: dir.split('/').pop() || tr('位置未知') }
  const parts = dir.slice(root.length).split('/').filter(Boolean)
  return parts.length > 1 ? { key: (root + '/' + parts[0]).toLowerCase(), name: parts[0] }
    : { key: root.toLowerCase(), name: tr('{p0} · 直属', { p0: root.split('/').pop() || root }) }
}
export function libraryBlocks<T>(items: T[], mode: LibraryGrouping, category: (item: T) => string, directory: (item: T) => string, roots: string[]) {
  if (mode === 'none') return [{ key: 'all', name: '', items }]
  const groups = new Map<string, { key: string; name: string; items: T[] }>()
  for (const item of items) {
    const name = category(item).trim()
    const group = mode === 'directory' ? libraryDirectoryGroup(directory(item), roots) : { key: name ? 'category:' + name : 'unclassified', name: name || tr('未分类') }
    if (!groups.has(group.key)) groups.set(group.key, { ...group, items: [] })
    groups.get(group.key)!.items.push(item)
  }
  return [...groups.values()].sort((a,b) => a.name.localeCompare(b.name, locale.value, {numeric:true}))
}
