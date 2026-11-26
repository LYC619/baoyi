
import { tr } from "../i18n/index.ts"
import { computed, ref } from 'vue'
import { errorMessage, plain } from '@/utils'
import { useTaskCenter } from './useTaskCenter'
import type {
  OrganizeCommand,
  OrganizePreview,
  OrganizeProgress,
  OrganizeResult,
  OrganizeSyncReport,
  OrganizedList,
  RelocateResult,
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
      const message = p.phase === 'done' ? tr('正在汇总整理结果') : tr('正在整理 {p0}/{p1}，{p2} 个失败', {p0: p.processed, p1: p.total, p2: p.failed})
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
    return tr('正在整理 {p0}/{p1}{p2}', {p0: p.processed, p1: p.total, p2: p.failed > 0 ? tr('（{p0} 个失败）', {p0: p.failed}) : ''})
  })

  function preview(ids?: string[]): Promise<OrganizePreview> {
    return window.baoyi.organize.preview(plain(ids))
  }

  async function run(commands: OrganizeCommand[]): Promise<OrganizeResult> {
    if (running.value) {
      return { plan_id: '', moved: 0, linked: 0, skipped: 0, failed: 0, steps: [] }
    }
    running.value = true
    const id = tasks.start('organize', tr("软件目录整理"), { total: commands.length })
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
      if (result.failed > 0) tasks.log(id, 'warn', tr("部分条目整理失败，未完成项保留原位置，请查看整理记录"))
      tasks.finish(id, 'success', tr("整理完成：{p0} 个移动，{p1} 个关联，{p2} 个跳过，{p3} 个失败", {p0: (result.moved), p1: (result.linked), p2: (result.skipped), p3: (result.failed)}))
      return result
    } catch (err) {
      tasks.finish(id, 'failed', tr("目录整理失败"), errorMessage(err))
      throw err
    } finally {
      taskId = null
      running.value = false
    }
  }

  /** 已整理的条目。读的是主进程现算的位置状态，不缓存 —— 用户随时可能在资源管理器里动过 */
  function organized(ids?: string[]): Promise<OrganizedList> {
    return window.baoyi.organize.organized(plain(ids))
  }

  /** 同步整理目录：子文件夹当分类、认领新软件、修复挪过位置的记录、找孤立链接 */
  function sync(): Promise<OrganizeSyncReport> {
    return window.baoyi.organize.sync()
  }

  function relocate(id: string, category: string, folder: string, expectedFrom?: string): Promise<RelocateResult> {
    return window.baoyi.organize.relocate(id, category, folder, expectedFrom)
  }

  function removeLinks(paths: string[]): Promise<{ removed: number; removed_paths: string[]; failed: number; notes: string[] }> {
    return window.baoyi.organize.removeLinks(plain(paths))
  }

  return {
    running,
    progress,
    percent,
    phaseLabel,
    lastResult,
    preview,
    run,
    organized,
    sync,
    relocate,
    removeLinks
  }
}
