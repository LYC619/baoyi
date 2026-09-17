import { ref } from 'vue'
import type { VideoItem } from '@/types'
import type { VideoAgentActions, VideoAgentPlan, VideoAgentProgress, VideoAgentResult } from '@/types/video-agent-organize'
import { errorMessage, plain } from '@/utils'
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
    taskId = tasks.start('video-scan', kind === 'prepare' ? 'Agent 整理 · 生成预览' : 'Agent 整理 · 执行所选操作')
    try { await action() }
    catch (cause) {
      error.value = errorMessage(cause).replace(/^(?:Error:\s*)?Error invoking remote method ['"]video-agent:[^'"]+['"]:\s*(?:Error:\s*)?/, '')
      const cancelled = /^已停止|^已取消/.test(error.value)
      tasks.finish(taskId, cancelled ? 'cancelled' : 'failed', cancelled ? 'Agent 整理已停止' : 'Agent 整理未完成', error.value)
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
      tasks.log(taskId, 'info', `分组分析消耗 ${plan.value.tokens.toLocaleString()} tokens`)
      tasks.finish(taskId, plan.value.groupingStatus === 'failed' ? 'failed' : 'success', plan.value.groupingStatus === 'failed'
        ? '分组分析未完成，可重新生成预览或继续补封面、补资料'
        : `已生成 ${plan.value.groups.length} 个合集建议${plan.value.warnings.length ? '，部分分组有提示，请查看后确认' : '，等待确认'}`)
    }),
    run: () => perform('run', async () => {
      if (!plan.value) return
      result.value = await window.baoyi.videoAgentOrganize.run(plan.value.id, plain(groupIds.value))
      for (const outcome of result.value.outcomes) tasks.log(taskId, outcome.ok ? 'info' : 'warn', outcome.title + '：' + outcome.message)
      tasks.log(taskId, 'info', `本轮消耗 ${result.value.tokens.toLocaleString()} tokens`)
      const failures = result.value.outcomes.filter(outcome => !outcome.ok).length
      tasks.finish(taskId, result.value.cancelled ? 'cancelled' : failures ? 'failed' : 'success', `Agent 整理${result.value.cancelled ? '已停止' : '结束'}：${result.value.outcomes.length - failures} 项完成，${failures} 项待处理`)
    }),
    cancel: () => window.baoyi.videoAgentOrganize.cancel(),
    reset: () => { if (!busy.value) { plan.value = null; result.value = null; analysisLog.value = ''; error.value = '' } },
    hide: () => { privacySuppressed = true; open.value = false; if (!busy.value) { works.value = []; plan.value = null; result.value = null; analysisLog.value = '' } }
  }
}
