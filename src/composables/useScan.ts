import { computed, ref } from 'vue'
import { createLatestGuard, plain } from '@/utils'
import type { ScanProgress, ScanResult, Unsubscribe } from '@/types'

/* 模块级单例，理由同 useAI */
const progress = ref<ScanProgress | null>(null)
const running = ref(false)
const lastResult = ref<ScanResult | null>(null)
let unsubscribe: Unsubscribe | null = null

/** 收尾令牌：cancel 后旧轮的 IPC 返回晚于新轮的 begin 才到，过期者不许清状态 */
const rounds = createLatestGuard()

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

  /**
   * dirs 往往直接来自 settings store，那是一个 reactive 代理数组 ——
   * 必须在这里拍平，contextBridge 收到代理会当场同步抛。见 utils 里的 plain()
   */
  async function run(dirs: string[]): Promise<ScanResult> {
    if (running.value || dirs.length === 0) {
      return { found: 0, added: 0, pending: 0, settled: 0, loose_files: [] }
    }
    running.value = true
    const round = rounds.begin()
    progress.value = { phase: 'walking', current: '', found: 0, processed: 0, total: 0 }
    try {
      const result = await window.baoyi.scan.run(plain(dirs))
      lastResult.value = result
      return result
    } finally {
      if (rounds.isCurrent(round)) running.value = false
    }
  }

  function cancel(): void {
    // 不能在这里把 running 置回 false：主进程那一轮未必已经停，此刻放开按钮，
    // 用户就能在旧轮还在收尾时点出第二轮。清 running 交给 run 的 finally
    // 和进度里的 done 事件 —— 那两个时刻旧轮是真的结束了
    window.baoyi.scan.cancel()
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
