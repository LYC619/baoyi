import { ref } from 'vue'

export interface BulkItem { id: string; name: string }
export interface BulkFailure extends BulkItem { message: string }

/** Keep a stable batch, expose partial failures, and reject overlapping submissions. */
export function useBulkOperation() {
  const busy = ref(false), processed = ref(0), total = ref(0), succeeded = ref(0)
  const failures = ref<BulkFailure[]>([])
  async function run<T extends BulkItem>(items: T[], apply: (item: T) => Promise<void>) {
    if (busy.value || !items.length) return
    busy.value = true; processed.value = 0; total.value = items.length; succeeded.value = 0; failures.value = []
    const batch = items.map(item => ({ ...item }))
    try {
      for (const item of batch) {
        try { await apply(item); succeeded.value++ }
        catch (cause) { failures.value.push({ id: item.id, name: item.name, message: cause instanceof Error ? cause.message : String(cause) }) }
        processed.value++
      }
    } finally { busy.value = false }
  }
  return { busy, processed, total, succeeded, failures, run }
}
