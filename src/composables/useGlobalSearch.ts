import { ref } from 'vue'

const globalSearchOpen = ref(false)
const globalSearchSeed = ref('')

export function useGlobalSearch() {
  function openGlobalSearch(initialQuery = '') {
    globalSearchSeed.value = initialQuery
    globalSearchOpen.value = true
  }

  function closeGlobalSearch() {
    globalSearchOpen.value = false
  }

  return {
    open: globalSearchOpen,
    seed: globalSearchSeed,
    openGlobalSearch,
    closeGlobalSearch
  }
}
