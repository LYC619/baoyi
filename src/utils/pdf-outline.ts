
import { tr } from '../i18n/index.ts'
import type { PDFDocumentProxy } from 'pdfjs-dist'
export interface OutlineNode {
  id: string
  title: string
  dest: unknown
  children: OutlineNode[]
}
export function normalizeOutline(outline: unknown) {
  let total = 0,
    truncated = false
  function visit(items: unknown, depth: number, prefix: string): OutlineNode[] {
    if (!Array.isArray(items)) return []
    if (depth >= 32) {
      if (items.length) truncated = true
      return []
    }
    const nodes: OutlineNode[] = []
    for (let i = 0; i < items.length; i++) {
      if (total >= 5000) {
        truncated = true
        break
      }
      const item = items[i]
      if (!item || typeof item !== 'object') continue
      total++
      const id = prefix + i
      nodes.push({
        id,
        title: String(item.title || tr("未命名章节")),
        dest: item.dest ?? null,
        children: visit(item.items, depth + 1, id + '.'),
      })
    }
    return nodes
  }
  const nodes = visit(outline, 0, '')
  return { nodes, truncated }
}
export async function outlinePage(
  pdf: Pick<PDFDocumentProxy, 'numPages' | 'getDestination' | 'getPageIndex'>,
  target: unknown,
): Promise<number | null> {
  try {
    const dest =
      typeof target === 'string' ? await pdf.getDestination(target) : target
    if (!Array.isArray(dest) || !dest.length) return null
    const ref = dest[0]
    const index =
      typeof ref === 'number'
        ? ref
        : ref && Number.isInteger(ref.num) && Number.isInteger(ref.gen)
          ? await pdf.getPageIndex(ref)
          : NaN
    return Number.isInteger(index) && index >= 0 && index < pdf.numPages
      ? index + 1
      : null
  } catch {
    return null
  }
}
