import type { RelocatePreview } from '../types'

export interface SoftwareCategoryMove { id: string; name: string; preview: RelocatePreview }

/** Prepare every physical change before asking once; this function never writes. */
export async function previewSoftwareCategoryChanges(ids: string[], category: string): Promise<SoftwareCategoryMove[]> {
  const selected = new Set(ids)
  const list = await window.baoyi.organize.organized()
  const changes: SoftwareCategoryMove[] = []
  for (const entry of list.entries) {
    if (!selected.has(entry.software_id) || entry.folder_category === category) continue
    const preview = await window.baoyi.organize.previewRelocate(entry.software_id, category, entry.folder)
    if (!preview.ok) throw new Error(`${entry.name}：${preview.message}`)
    changes.push({ id: entry.software_id, name: entry.name, preview })
  }
  // Two selected records may sanitize to the same destination. Refuse the whole preview.
  const targets = new Set<string>()
  for (const change of changes) {
    const key = change.preview.to.toLowerCase()
    if (targets.has(key)) throw new Error('多个软件的目标文件夹重名，请到“已整理”页分别归置')
    targets.add(key)
  }
  return changes
}

export function categoryMoveConfirmation(moves: SoftwareCategoryMove[]): string {
  return `修改分类会重新归置 ${moves.length} 个已整理软件。实体目录将移动，链接只改变入口位置。\n\n` +
    moves.map(m => `${m.name}\n从：${m.preview.from}\n到：${m.preview.to}${m.preview.warning ? '\n' + m.preview.warning : ''}`).join('\n\n') + '\n\n确认继续？'
}
