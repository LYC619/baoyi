import { computed, ref } from 'vue'
import { errorMessage, plain } from '@/utils'
import { useTaskCenter } from './useTaskCenter'
import type {
  OrganizeCommand,
  OrganizePreview,
  OrganizeProgress,
  OrganizeResult,
  Unsubscribe
} from '@/types'

/* 模块级单例，理由同 useScan：设置页和预览面板看到的是同一份进度 */
const running = ref(false)
const progress = ref<OrganizeProgress | null>(null)
const lastResult = ref<OrganizeResult | null>(null)
let unsubscribe: Unsubscribe | null = null
const tasks = useTaskCenter()
let taskId: string | null = null

export function useOrganize() {
  if (!unsubscribe) {
    unsubscribe = window.baoyi.organize.onProgress((p) => {
      if (!taskId) return
      progress.value = p
      const message = p.phase === 'done' ? '正在汇总整理结果' : `正在整理 ${p.processed}/${p.total}，${p.failed} 个失败`
      tasks.update(taskId, { processed: p.processed, total: p.total, current: p.current, message }, { message: message + (p.current ? ' · ' + p.current : '') })
    })
  }

  const percent = computed(() => {
    const p = progress.value
    if (!p || p.total === 0) return 0
    return Math.min(100, Math.round((p.processed / p.total) * 100))
  })

  const phaseLabel = computed(() => {
    const p = progress.value
    if (!p || p.phase === 'done') return ''
    return `正在整理 ${p.processed}/${p.total}${p.failed > 0 ? `（${p.failed} 个失败）` : ''}`
  })

  function preview(ids?: string[]): Promise<OrganizePreview> {
    return window.baoyi.organize.preview(plain(ids))
  }

  async function run(commands: OrganizeCommand[]): Promise<OrganizeResult> {
    if (running.value) {
      return { plan_id: '', moved: 0, linked: 0, skipped: 0, failed: 0, steps: [] }
    }
    running.value = true
    const id = tasks.start('organize', '软件目录整理', { total: commands.length })
    taskId = id
    progress.value = { phase: 'running', current: '', processed: 0, total: commands.length, failed: 0 }
    try {
      // commands 直接来自面板上的 reactive 数组，必须先拍平，见 utils 的 plain()
      const result = await window.baoyi.organize.run(plain(commands))
      lastResult.value = result
      tasks.update(id, { processed: result.moved + result.linked + result.skipped + result.failed })
      for (const step of result.steps) {
        if (!step.ok && step.note) tasks.log(id, 'warn', (step.name ? step.name + '：' : '') + step.note)
      }
      if (result.failed > 0) tasks.log(id, 'warn', '部分条目整理失败，未完成项保留原位置，请查看整理记录')
      tasks.finish(id, 'success', `整理完成：${result.moved} 个移动，${result.linked} 个关联，${result.skipped} 个跳过，${result.failed} 个失败`)
      return result
    } catch (err) {
      tasks.finish(id, 'failed', '目录整理失败', errorMessage(err))
      throw err
    } finally {
      taskId = null
      running.value = false
    }
  }

  return { running, progress, percent, phaseLabel, lastResult, preview, run }
}
