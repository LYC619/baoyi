import { computed, ref } from 'vue'
import { createLatestGuard, plain } from '@/utils'
import type { AIProgress, AIResult, Unsubscribe } from '@/types'

/* 模块级单例：设置页和引导页看到的是同一份进度 */
const progress = ref<AIProgress | null>(null)
const running = ref(false)
const lastResult = ref<AIResult | null>(null)
let unsubscribe: Unsubscribe | null = null

/** 收尾令牌：cancel 后旧轮的 IPC 返回晚于新轮的 begin 才到，过期者不许清状态 */
const rounds = createLatestGuard()

const EMPTY: AIResult = { processed: 0, registered: 0, skipped: 0, failed: 0, tokens: 0, report_id: '' }

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
    const round = rounds.begin()
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
      const result = await window.baoyi.ai.complete(plain(ids))
      lastResult.value = result
      return result
    } finally {
      if (rounds.isCurrent(round)) running.value = false
    }
  }

  function cancel(): void {
    // 不能在这里把 running 置回 false：abort 要等主进程走到下一个轮次边界才生效，
    // 此刻放开按钮，用户就能在旧轮还在收尾时点出第二轮。running 交给两个
    // 「旧轮真的结束了」的时刻去清 —— complete 的 finally 和进度里的 done 事件
    window.baoyi.ai.cancel()
  }

  function reset(): void {
    progress.value = null
    lastResult.value = null
  }

  return { progress, running, percent, activity, phaseLabel, lastResult, complete, cancel, reset }
}
