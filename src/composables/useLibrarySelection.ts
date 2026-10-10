import { computed, ref, watch } from 'vue'

/** Selection belongs to the currently visible result set, never hidden resources. */
export function useLibrarySelection(items: () => ReadonlyArray<{ id: string }>, locked: () => boolean = () => false) {
  const selecting = ref(false), selectedIds = ref(new Set<string>())
  const visibleIds = computed(() => new Set(items().map(item => item.id)))
  watch(visibleIds, ids => { selectedIds.value = new Set([...selectedIds.value].filter(id => ids.has(id))) }, { flush: 'sync' })
  function clear() { if (!locked()) selectedIds.value = new Set() }
  function toggleMode() { if (!locked()) { selecting.value = !selecting.value; clear() } }
  function toggle(id: string) {
    if (locked() || !visibleIds.value.has(id)) return
    const next = new Set(selectedIds.value)
    if (next.has(id)) next.delete(id); else next.add(id)
    selectedIds.value = next
  }
  function selectAll() { if (!locked()) selectedIds.value = new Set(visibleIds.value) }
  function key(event: KeyboardEvent) {
    if (!selecting.value || locked() || event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '') || target?.closest?.('[role="dialog"]')) return
    if (event.key === 'Escape') { event.preventDefault(); toggleMode() }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); selectAll() }
  }
  return { selecting, selectedIds, clear, toggleMode, toggle, selectAll, key }
}
