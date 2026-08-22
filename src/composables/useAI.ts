import { computed, ref } from 'vue'
import type { AIProgress, AIResult, Unsubscribe } from '@/types'

/* 模块级单例：设置页和引导页看到的是同一份进度 */
const progress = ref<AIProgress | null>(null)
const running = ref(false)
const lastResult = ref<AIResult | null>(null)
let unsubscribe: Unsubscribe | null = null

const EMPTY: AIResult = { processed: 0, registered: 0, skipped: 0, failed: 0, tokens: 0 }

function ensureSubscribed(): void {
  if (unsubscribe) return
  unsubscribe = window.baoyi.ai.onProgress((p) => {
    progress.value = p
    if (p.phase === 'done') running.value = false
  })
}

export function useAI() {
  ensureSubscribed()

  const percent = computed(() => {
    const p = progress.value
    if (!p || p.total === 0) return 0
    return Math.min(100, Math.round((p.processed / p.total) * 100))
  })

  /** agent 当前在做什么，用来让用户看见识别过程而不是干等进度条 */
  const activity = computed(() => progress.value?.log ?? '')

  const phaseLabel = computed(() => {
    const p = progress.value
    if (!p) return ''
    if (p.phase === 'done') return '识别完成'
    return `已处理 ${p.processed}/${p.total} 个目录，已注册 ${p.registered} 个软件`
  })

  /** ids 为空表示跑完所有待识别目录与待补全条目 */
  async function complete(ids?: string[]): Promise<AIResult> {
    if (running.value) return { ...EMPTY }
    running.value = true
    progress.value = {
      phase: 'running',
      current: '',
      processed: 0,
      total: ids?.length ?? 0,
      failed: 0,
      registered: 0,
      log: ''
    }
    try {
      const result = await window.baoyi.ai.complete(ids)
      lastResult.value = result
      return result
    } finally {
      running.value = false
    }
  }

  function cancel(): void {
    window.baoyi.ai.cancel()
    running.value = false
  }

  function reset(): void {
    progress.value = null
    lastResult.value = null
  }

  return { progress, running, percent, activity, phaseLabel, lastResult, complete, cancel, reset }
}
