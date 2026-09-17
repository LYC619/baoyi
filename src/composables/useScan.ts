import { computed, ref } from 'vue'
import { createLatestGuard, errorMessage, plain } from '@/utils'
import { useTaskCenter } from './useTaskCenter'
import type { ScanProgress, ScanResult, Unsubscribe } from '@/types'

/* 模块级单例，理由同 useAI */
const progress = ref<ScanProgress | null>(null)
const running = ref(false)
const stopping = ref(false)
const lastResult = ref<ScanResult | null>(null)
let unsubscribe: Unsubscribe | null = null
const tasks = useTaskCenter()
let activeTask: { id: string; cancelled: boolean } | null = null

/** 收尾令牌：cancel 后旧轮的 IPC 返回晚于新轮的 begin 才到，过期者不许清状态 */
const rounds = createLatestGuard()

function ensureSubscribed(): void {
  if (unsubscribe) return
  unsubscribe = window.baoyi.scan.onProgress((p) => {
    if (!activeTask) return
    progress.value = p
    const message = p.phase === 'walking' ? `正在遍历目录，已发现 ${p.found} 个程序`
      : p.phase === 'reading' ? `正在读取文件信息 ${p.processed}/${p.total}` : '正在汇总扫描结果'
    tasks.update(activeTask.id, {
      processed: p.processed, total: p.total, current: p.current,
      message: activeTask.cancelled ? '正在停止，等待扫描收尾…' : message
    }, { message: p.current ? `${message} · ${p.current}` : message })
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
    if (running.value && stopping.value) return '正在停止，等待扫描收尾…'
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
    stopping.value = false
    const round = rounds.begin()
    const task = { id: tasks.start('software-scan', '软件目录扫描', { current: dirs.join('；') }), cancelled: false }
    activeTask = task
    progress.value = { phase: 'walking', current: '', found: 0, processed: 0, total: 0 }
    try {
      const result = await window.baoyi.scan.run(plain(dirs))
      lastResult.value = result
      const message = `发现 ${result.found} 个程序，${result.added} 个新增目录，${result.pending} 个待识别，${result.settled} 个已识别过`
      if (result.loose_files.length) tasks.log(task.id, 'warn', `另有 ${result.loose_files.length} 个散落文件，本次未处理`)
      tasks.finish(task.id, task.cancelled ? 'cancelled' : 'success', (task.cancelled ? '扫描已停止：' : '扫描完成：') + message)
      return result
    } catch (err) {
      tasks.finish(task.id, 'failed', '软件扫描失败', errorMessage(err))
      throw err
    } finally {
      if (rounds.isCurrent(round)) { running.value = false; activeTask = null }
    }
  }

  function cancel(): void {
    if (!activeTask || activeTask.cancelled || progress.value?.phase === 'done') return
    window.baoyi.scan.cancel()
    activeTask.cancelled = true
    stopping.value = true
    tasks.update(activeTask.id, { message: '正在停止，等待扫描收尾…' })
    tasks.log(activeTask.id, 'warn', '用户请求停止扫描；等待本轮返回，不提前解锁')
  }

  async function pickDirectory(): Promise<string | null> {
    return window.baoyi.scan.pickDirectory()
  }

  function reset(): void {
    progress.value = null
    lastResult.value = null
  }

  return { progress, running, stopping, percent, phaseLabel, lastResult, run, cancel, pickDirectory, reset }
}
