import { errorMessage } from '@/utils'
import { useToast } from '@/composables/useToast'
import { ref, watch } from 'vue'
import type { LibraryGrouping } from '@/utils/library-grouping'
export function useLibraryView(kind: string, defaultGrouping: LibraryGrouping = 'category') {
  let saved: any = {}
  try {
    const value = JSON.parse(localStorage.getItem('library-view-' + kind) || '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value
  } catch { /* 偏好缺失或无法解析时使用当前默认视图。 */ }
  const grouping = ref<LibraryGrouping>(['none','category','directory'].includes(saved.grouping) ? saved.grouping : defaultGrouping)
  const cardSize = ref(Math.min(260, Math.max(110, Number(saved.cardSize) || 150)))
  const layout = ref(saved.layout === 'list' ? 'list' : 'grid')
  const coverShape=ref<'portrait'|'landscape'>(saved.coverShape==='landscape'?'landscape':'portrait')
  watch([grouping, cardSize, layout,coverShape], () => { try { localStorage.setItem('library-view-' + kind, JSON.stringify({grouping:grouping.value,cardSize:cardSize.value,layout:layout.value,coverShape:coverShape.value})) } catch (cause) { useToast().error(errorMessage(cause)) } })
  return { grouping, cardSize, layout,coverShape }
}
