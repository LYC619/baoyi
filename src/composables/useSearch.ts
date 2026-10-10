import { computed, watch } from 'vue'
import { useSoftwareStore } from '@/stores/software'

/** Keep the displayed query and filter state identical; debounce only the lookup. */
export function useSearch(wait = 220) {
  const store = useSoftwareStore()
  const text = computed({ get: () => store.keyword, set: (value: string) => { store.keyword = value } })
  watch(text, (_value, _previous, onCleanup) => {
    const timer = setTimeout(() => void store.load(), wait)
    onCleanup(() => clearTimeout(timer))
  })
  function clear(): void { text.value = ''; void store.load() }
  return { text, clear }
}
