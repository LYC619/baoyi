/** Apply a range only within the currently displayed order. Hidden rows are never added. */
export function rangeSelection(order: string[], selected: string[], id: string, anchor: string, shift = false): string[] {
  const index = order.indexOf(id), start = order.indexOf(anchor)
  if (index < 0) return selected
  const next = new Set(selected), add = !next.has(id)
  const ids = shift && start >= 0 ? order.slice(Math.min(index, start), Math.max(index, start) + 1) : [id]
  for (const value of ids) { if (add) next.add(value); else next.delete(value) }
  return [...next]
}
