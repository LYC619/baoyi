import { ref, watch } from 'vue'
import { useSoftwareStore } from '@/stores/software'
import { debounce } from '@/utils'

/**
 * 搜索框绑定：本地 ref 立即回显，防抖后再打库。
 * 中英文都靠 SQL 的 LIKE 模糊匹配（命中名称 / 说明 / 标签 / 文件名）。
 */
export function useSearch(wait = 220) {
  const store = useSoftwareStore()
  const text = ref(store.keyword)

  const commit = debounce((value: string) => {
    store.keyword = value
    void store.load()
  }, wait)

  watch(text, (value) => commit(value))

  function clear(): void {
    text.value = ''
    store.keyword = ''
    void store.load()
  }

  return { text, clear }
}
