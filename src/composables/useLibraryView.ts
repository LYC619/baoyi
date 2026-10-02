import { ref, watch } from 'vue'
import type { LibraryGrouping } from '@/utils/library-grouping'
export function useLibraryView(kind: string, defaultGrouping: LibraryGrouping = 'category') {
  let saved: any = {}
  try { saved = JSON.parse(localStorage.getItem('library-view-' + kind) || '{}') } catch { /* defaults */ }
  const grouping = ref<LibraryGrouping>(['none','category','directory'].includes(saved.grouping) ? saved.grouping : defaultGrouping)
  const cardSize = ref(Math.min(260, Math.max(110, Number(saved.cardSize) || 150)))
  const layout = ref(saved.layout === 'list' ? 'list' : 'grid')
  watch([grouping, cardSize, layout], () => { try { localStorage.setItem('library-view-' + kind, JSON.stringify({grouping:grouping.value,cardSize:cardSize.value,layout:layout.value})) } catch { /* A view preference must not block the library. */ } })
  return { grouping, cardSize, layout }
}
