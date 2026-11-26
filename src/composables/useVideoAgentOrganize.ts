
import { locale as appLocale, tr, systemMessage } from '../i18n/index.ts'
import { ref } from 'vue'
import type { VideoItem } from '@/types'
import type { VideoAgentActions, VideoAgentPlan, VideoAgentProgress, VideoAgentResult } from '@/types/video-agent-organize'
import { rawErrorMessage, plain } from '@/utils'
import { useTaskCenter } from './useTaskCenter'
const open = ref(false), works = ref<VideoItem[]>([]), plan = ref<VideoAgentPlan | null>(null), result = ref<VideoAgentResult | null>(null)
const actions = ref<VideoAgentActions>({ merge: true, artwork: true, metadata: false, transfer: 'none' })
const busy = ref(''), error = ref(''), progress = ref<VideoAgentProgress | null>(null), groupIds = ref<string[]>([])
const analysisLog = ref('')
let subscribed = false, taskId = '', privacySuppressed = false
const tasks = useTaskCenter()
export function useVideoAgentOrganize() {
  if (!subscribed && typeof window !== 'undefined' && window.baoyi?.videoAgentOrganize) {
    subscribed = true
    window.baoyi.videoAgentOrganize.onProgress(value => {
      progress.value = value
      if (value.log) analysisLog.value += (analysisLog.value ? '\n' : '') + value.log
      if (taskId) tasks.update(taskId, { ...value }, { level: value.level, message: value.log || (value.current ? value.current + ' · ' + value.message : value.message) })
    })
  }
  async function perform(kind: 'prepare' | 'run', action: () => Promise<void>) {
    if (busy.value) return
    busy.value = kind; error.value = ''; progress.value = null
    if (kind === 'prepare') { analysisLog.value = ''; plan.value = null; groupIds.value = [] }
    taskId = tasks.start('video-scan', kind === 'prepare' ? tr("智能整理 · 生成预览") : tr("智能整理 · 执行所选操作"))
    try { await action() }
    catch (cause) {
      const raw = rawErrorMessage(cause)
      const cancelled = /^已停止|^已取消/.test(raw)
      error.value = raw ? systemMessage(raw) : tr('操作未能完成，请稍后重试')
      tasks.finish(taskId, cancelled ? 'cancelled' : 'failed', cancelled ? tr("智能整理已停止") : tr("智能整理未完成"), error.value)
    }
    finally { busy.value = ''; taskId = '' }
  }
  return { open, works, plan, result, actions, groupIds, busy, error, progress, analysisLog,
    show: (selected: VideoItem[]) => {
      if (busy.value && privacySuppressed) return
      if (!busy.value) { works.value = selected; plan.value = null; result.value = null; groupIds.value = []; error.value = ''; analysisLog.value = '' }
      privacySuppressed = false
      open.value = true
    },
    prepare: () => perform('prepare', async () => {
      result.value = null
      plan.value = await window.baoyi.videoAgentOrganize.prepare(works.value.map(work => work.id), plain(actions.value))
      analysisLog.value = plan.value.log
      groupIds.value = plan.value.groups.filter(group => plan.value!.actions.transfer === 'none' ? group.preview.canMerge : group.preview.canOrganize).map(group => group.id)
      for (const warning of plan.value.warnings) tasks.log(taskId, 'warn', warning)
      tasks.log(taskId, 'info', tr("分组分析消耗 {p0} tokens", {p0: (plan.value.tokens.toLocaleString(appLocale.value))}))
      tasks.finish(taskId, plan.value.groupingStatus === 'failed' ? 'failed' : 'success', plan.value.groupingStatus === 'failed'
        ? tr("分组分析未完成，可重新生成预览或继续补封面、补资料")
        : plan.value.warnings.length ? tr('已生成 {p0} 个合集建议，部分分组有提示，请查看后确认', { p0: plan.value.groups.length }) : tr('已生成 {p0} 个合集建议，等待确认', { p0: plan.value.groups.length }))
    }),
    run: () => perform('run', async () => {
      if (!plan.value) return
      result.value = await window.baoyi.videoAgentOrganize.run(plan.value.id, plain(groupIds.value))
      for (const outcome of result.value.outcomes) tasks.log(taskId, outcome.ok ? 'info' : 'warn', outcome.title + '：' + outcome.message)
      tasks.log(taskId, 'info', tr("本轮消耗 {p0} tokens", {p0: (result.value.tokens.toLocaleString(appLocale.value))}))
      const failures = result.value.outcomes.filter(outcome => !outcome.ok).length
      tasks.finish(taskId, result.value.cancelled ? 'cancelled' : failures ? 'failed' : 'success', result.value.cancelled ? tr('智能整理已停止：{p0} 项完成，{p1} 项待处理', { p0: result.value.outcomes.length - failures, p1: failures }) : tr('智能整理结束：{p0} 项完成，{p1} 项待处理', { p0: result.value.outcomes.length - failures, p1: failures }))
    }),
    cancel: () => window.baoyi.videoAgentOrganize.cancel(),
    reset: () => { if (!busy.value) { plan.value = null; result.value = null; analysisLog.value = ''; error.value = '' } },
    hide: () => { privacySuppressed = true; open.value = false; if (!busy.value) { works.value = []; plan.value = null; result.value = null; analysisLog.value = '' } }
  }
}
