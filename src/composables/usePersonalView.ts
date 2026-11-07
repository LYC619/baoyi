import { reactive, ref, watch, onMounted, onBeforeUnmount } from 'vue'

export function usePersonalView<T extends Record<string, string>>(key: string, defaults: T): T {
  let stored: Record<string, unknown> = {}
  try { stored = JSON.parse(sessionStorage.getItem('personal-view-' + key) || '{}') || {} } catch { /* optional view state */ }
  const values = { ...defaults }
  for (const field of Object.keys(defaults)) if (typeof stored[field] === 'string' && (stored[field] as string).length < 2000) values[field as keyof T] = stored[field] as T[keyof T]
  const state = reactive(values) as T
  watch(state, () => { try { sessionStorage.setItem('personal-view-' + key, JSON.stringify(state)) } catch { /* storage may be full */ } }, { deep:true })
  return state
}

export function usePersonalDate() {
  const current = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
  const today = ref(current())
  const refresh = () => { today.value = current() }
  let timer: ReturnType<typeof setInterval>
  onMounted(() => { timer = setInterval(refresh,30000); window.addEventListener('focus',refresh); document.addEventListener('visibilitychange',refresh) })
  onBeforeUnmount(() => { clearInterval(timer); window.removeEventListener('focus',refresh); document.removeEventListener('visibilitychange',refresh) })
  return today
}
