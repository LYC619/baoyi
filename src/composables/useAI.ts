
import { locale as appLocale } from '../i18n/index.ts'

import { tr } from "../i18n/index.ts"
import { computed, ref } from 'vue'
import { createLatestGuard, errorMessage, plain } from '@/utils'
import { useTaskCenter } from './useTaskCenter'
import type { AIProgress, AIResult, Unsubscribe } from '@/types'

/* 模块级单例：设置页和引导页看到的是同一份进度 */
const progress = ref<AIProgress | null>(null)
const running = ref(false)
const lastResult = ref<AIResult | null>(null)
let unsubscribe: Unsubscribe | null = null
const tasks = useTaskCenter()
let activeTask: { id: string; cancelled: boolean } | null = null

/** 收尾令牌：cancel 后旧轮的 IPC 返回晚于新轮的 begin 才到，过期者不许清状态 */
const rounds = createLatestGuard()

const EMPTY: AIResult = { processed: 0, registered: 0, skipped: 0, failed: 0, tokens: 0, report_id: '' }

function ensureSubscribed(): void {
  if (unsubscribe) return
  unsubscribe = window.baoyi.ai.onProgress((p) => {
    if (!activeTask) return
    progress.value = p
    const message = p.log || (p.phase === 'done' ? tr('正在汇总识别结果') : tr('已处理 {p0}/{p1} 个目录，已注册 {p2} 个软件', {p0: p.processed, p1: p.total, p2: p.registered}))
    tasks.update(activeTask.id, {
      processed: p.processed, total: p.total, current: p.current,
      message: activeTask.cancelled ? tr("正在停止，等待当前识别步骤收尾…") : message
    }, { message: p.current ? `${message} · ${p.current}` : message })
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
    if (p.phase === 'done') return tr('识别完成')
    return tr('已处理 {p0}/{p1} 个目录，已注册 {p2} 个软件', {p0: p.processed, p1: p.total, p2: p.registered})
  })

  /** ids 为空表示跑完所有待识别目录与待补全条目 */
  async function complete(ids?: string[]): Promise<AIResult> {
    if (running.value) return { ...EMPTY }
    running.value = true
    const round = rounds.begin()
    const task = { id: tasks.start('ai-identify', tr("软件 AI 识别"), { total: ids?.length ?? 0 }), cancelled: false }
    activeTask = task
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
      tasks.update(task.id, { processed: result.processed })
      const message = tr('已处理 {p0} 个目录，{p1} 个注册，{p2} 个跳过，{p3} 个失败；{p4} tokens', {p0: result.processed, p1: result.registered, p2: result.skipped, p3: result.failed, p4: result.tokens.toLocaleString(appLocale.value)})
      if (result.failed > 0) tasks.log(task.id, 'warn', tr("存在识别失败项，可在识别日志中查看原因"))
      if (result.report_id) tasks.log(task.id, 'info', tr("详细识别报告：") + result.report_id)
      tasks.finish(task.id, task.cancelled ? 'cancelled' : 'success', (task.cancelled ? tr("识别已停止：") : tr("识别完成：")) + message)
      return result
    } catch (err) {
      tasks.finish(task.id, 'failed', tr("AI 识别失败"), errorMessage(err))
      throw err
    } finally {
      if (rounds.isCurrent(round)) { running.value = false; activeTask = null }
    }
  }

  function cancel(): void {
    if (!activeTask || activeTask.cancelled || progress.value?.phase === 'done') return
    window.baoyi.ai.cancel()
    activeTask.cancelled = true
    tasks.update(activeTask.id, { message: tr("正在停止，等待当前识别步骤收尾…") })
    tasks.log(activeTask.id, 'warn', tr("用户请求停止识别；已注册的结果保留"))
  }

  function reset(): void {
    progress.value = null
    lastResult.value = null
  }

  return { progress, running, percent, activity, phaseLabel, lastResult, complete, cancel, reset }
}
