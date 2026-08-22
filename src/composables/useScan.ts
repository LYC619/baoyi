import { computed, ref } from 'vue'
import type { ScanProgress, ScanResult, Unsubscribe } from '@/types'

/* 模块级单例，理由同 useAI */
const progress = ref<ScanProgress | null>(null)
const running = ref(false)
const lastResult = ref<ScanResult | null>(null)
let unsubscribe: Unsubscribe | null = null

function ensureSubscribed(): void {
  if (unsubscribe) return
  unsubscribe = window.baoyi.scan.onProgress((p) => {
    progress.value = p
    if (p.phase === 'done') running.value = false
  })
}

export function useScan() {
  ensureSubscribed()

  const percent = computed(() => {
    const p = progress.value
    if (!p || p.total === 0) return 0
    return Math.min(100, Math.round((p.processed / p.total) * 100))
  })

  const phaseLabel = computed(() => {
    const p = progress.value
    if (!p) return ''
    if (p.phase === 'walking') return `正在遍历目录，已发现 ${p.found} 个程序`
    if (p.phase === 'reading') return `正在读取文件信息 ${p.processed}/${p.total}`
    return '扫描完成'
  })

  async function run(dirs: string[]): Promise<ScanResult> {
    if (running.value || dirs.length === 0) return { found: 0, added: 0, pending: 0, settled: 0 }
    running.value = true
    progress.value = { phase: 'walking', current: '', found: 0, processed: 0, total: 0 }
    try {
      const result = await window.baoyi.scan.run(dirs)
      lastResult.value = result
      return result
    } finally {
      running.value = false
    }
  }

  function cancel(): void {
    window.baoyi.scan.cancel()
    running.value = false
  }

  async function pickDirectory(): Promise<string | null> {
    return window.baoyi.scan.pickDirectory()
  }

  function reset(): void {
    progress.value = null
    lastResult.value = null
  }

  return { progress, running, percent, phaseLabel, lastResult, run, cancel, pickDirectory, reset }
}
