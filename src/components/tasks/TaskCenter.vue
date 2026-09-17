<script setup lang="ts">
import { computed, getCurrentInstance, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { routerKey } from 'vue-router'
import { Check, ChevronDown, CircleAlert, ExternalLink, FolderOpen, ListTodo, Loader2, Minus, RefreshCw, Square, Trash2, X } from 'lucide-vue-next'
import { useTaskCenter, type TaskScanEntry, type TaskWithResults } from '@/composables/useTaskCenter'
import { useVideoWorkflow, videoJobRetryStages } from '@/composables/useVideoWorkflow'
import { reidentifyVideo, useMediaScan } from '@/composables/useMediaScan'
import { useSettingsStore } from '@/stores/settings'
import IdentifyLog from '@/components/identify/IdentifyLog.vue'
import type { TaskEventLevel, TaskKind, TaskStatus } from '@/types'
import type { VideoDownloadJob, VideoJobRetry, VideoJobStage } from '@/types/video-workflow'
import { errorMessage, formatBytes } from '@/utils'

const center = useTaskCenter()
const { runningTasks, history } = center
const workflow = useVideoWorkflow()
const videoScan = useMediaScan('video')
const actionError = ref('')
let privacyRevision = 0
const router = inject(routerKey, null)
const pinia = getCurrentInstance()?.appContext.config.globalProperties.$pinia
const settings = pinia ? useSettingsStore(pinia) : null
watch(() => settings?.loaded ? settings.settings : null, value => {
  if (value) workflow.applyPreferences(value)
}, { immediate: true, deep: true, flush: 'sync' })
watch(() => !workflow.privacyReady.value || workflow.hideHentai.value, hidden => {
  center.setVideoHidden(hidden)
  privacyRevision++
  actionError.value = ''
}, { immediate: true, flush: 'sync' })
const downloadJobs = workflow.jobs
const runningCount = computed(() => center.runningCount.value + downloadJobs.value.filter(job => job.status === 'running').length)
const queuedCount = computed(() => downloadJobs.value.filter(job => job.status === 'queued').length)
const failedCount = computed(() => center.attentionCount.value + downloadJobs.value.filter(job => videoJobRetryStages(job).length > 0 || job.status === 'failed').length)
const jobSections = computed(() => [
  { key: 'active', label: '下载队列', items: downloadJobs.value.filter(job => job.status === 'running' || job.status === 'queued').sort((a, b) => a.createdAt - b.createdAt) },
  { key: 'finished', label: '下载结果', items: downloadJobs.value.filter(job => job.status !== 'running' && job.status !== 'queued') }
])
const retryingEntry = ref('')
const clearing = ref(false)
const opened = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const expanded = ref(new Set<string>())
const identifyLogs = ref(new Set<string>())
// 面板 body 拆成上下两个滚动区：任务在上、下载固定在底部（B5）。之前四个分区顺序铺在
// 同一个滚动区里，历史一多下载队列就被顶到看不见的地方
const sections = computed(() => [
  { key: 'running', label: '运行中', items: runningTasks.value },
  { key: 'history', label: '最近结束', items: history.value }
])
const downloadSections = computed(() => [
  { key: 'queue', label: '下载队列', jobs: jobSections.value[0].items, collapsible: false },
  { key: 'downloads', label: '下载结果', jobs: jobSections.value[1].items, collapsible: true }
])
const entryLabel = computed(() => `任务中心：${runningCount.value} 个运行中，${queuedCount.value} 个排队，${failedCount.value} 个失败或待处理`)
const kindLabels: Record<TaskKind, string> = {
  'software-scan': '软件扫描', 'game-scan': '游戏扫描', 'video-scan': '影视扫描',
  'ai-identify': 'AI 识别', organize: '目录整理', 'hanime-verify': '网络验证', 'video-download': '视频下载',
  'video-series-download': '系列下载'
}
const statusLabels: Record<TaskStatus, string> = { running: '进行中', success: '已完成', failed: '失败', cancelled: '已停止 / 未完成', interrupted: '应用中断 / 待处理' }
const eventLabels: Record<TaskEventLevel, string> = { info: '信息', success: '完成', warn: '提醒', error: '错误' }
const jobStatusLabels: Record<VideoDownloadJob['status'], string> = { queued: '排队中', running: '处理中', success: '已完成', partial: '部分完成', failed: '失败', cancelled: '已停止', interrupted: '中断待恢复' }
const stageLabels: Record<VideoJobStage, string> = { pending: '待执行', running: '处理中', complete: '完成', failed: '待重试', skipped: '已跳过' }
const retryLabels: Record<VideoJobRetry, string> = { remaining: '仅重试剩余视频', metadata: '补齐资料', registration: '仅重试入库' }
const scanStatusLabels = { new: '新增', updated: '更新', skipped: '跳过', review: '待确认', failed: '失败' }

function jobStatus(job: VideoDownloadJob): string {
  return job.status === 'success' && videoJobRetryStages(job).length ? '部分完成' : jobStatusLabels[job.status]
}
function jobSummary(job: VideoDownloadJob): string {
  const saved = job.items.filter(item => item.transfer === 'complete').length
  return `已保存 ${saved}/${job.items.length} 项` + (job.register
    ? ` · 已入库 ${job.items.filter(item => item.registration === 'complete').length} 项` : ' · 仅保存文件')
}
function openWork(id: string, edit = false): void {
  if (!id || !router) return
  closePanel(false)
  void router.push({ name: 'video-detail', params: { id }, ...(edit ? { query: { edit: '1' } } : {}) })
}
async function retryScan(task: TaskWithResults, entry: TaskScanEntry): Promise<void> {
  if (!entry.resourceId || retryingEntry.value || videoScan.running.value || !workflow.privacyReady.value || workflow.hideHentai.value) return
  const revision = privacyRevision
  retryingEntry.value = task.id + entry.path
  actionError.value = ''
  try {
    const item = await window.baoyi.video.get(entry.resourceId)
    if (revision !== privacyRevision) return
    if (!item) throw new Error('作品不可用，请重新扫描来源目录')
    const updated = await reidentifyVideo(item, false)
    if (updated && revision === privacyRevision) center.setScanResults(task.id, (task.scanEntries ?? []).map(value => value.path === entry.path
      ? { ...value, status: 'updated', message: '重新识别完成，可打开作品核对资料' } : value))
  } catch (cause) { if (revision === privacyRevision) actionError.value = errorMessage(cause) }
  finally { retryingEntry.value = '' }
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}
function taskProgress(task: { kind: TaskKind; processed: number; total: number }): string {
  if (task.kind === 'video-series-download') return task.total > 0 ? `${task.processed} / ${task.total} 集` : '集数待确定'
  if (task.kind !== 'video-download') return task.total > 0 ? `${task.processed} / ${task.total}` : '总数待确定'
  const received = task.processed > 0 ? formatBytes(task.processed) : '0 B'
  return task.total > 0 ? `${received} / ${formatBytes(task.total)}` : `${received} / 大小未知`
}
async function togglePanel(): Promise<void> {
  if (opened.value) { closePanel(); return }
  opened.value = true
  void workflow.refresh()
  await nextTick()
  if (opened.value) closeButton.value?.focus()
}
function closePanel(restoreFocus = true): void {
  opened.value = false
  if (restoreFocus) trigger.value?.focus()
}
function toggleEvents(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}
function identifyKind(task: TaskWithResults): string {
  return task.kind === 'video-scan' ? 'video' : task.kind === 'game-scan' ? 'game'
    : task.kind === 'software-scan' || task.kind === 'ai-identify' ? 'software' : ''
}
function toggleIdentifyLogs(id: string, event: Event): void {
  const next = new Set(identifyLogs.value)
  if ((event.target as HTMLDetailsElement).open) next.add(id)
  else next.delete(id)
  identifyLogs.value = next
}
async function clearHistory(): Promise<void> {
  if (clearing.value) return
  clearing.value = true
  actionError.value = ''
  try {
    await center.clearFinished()
    expanded.value = new Set([...expanded.value].filter(id => runningTasks.value.some(task => task.id === id)))
  } catch (cause) { actionError.value = '清除历史失败：' + errorMessage(cause) }
  finally { clearing.value = false }
}
function outside(event: Event): void {
  const target = event.target as Node | null
  if (opened.value && !panel.value?.contains(target) && !trigger.value?.contains(target)) closePanel(false)
}
function keydown(event: KeyboardEvent): void {
  if (opened.value && event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closePanel()
  }
}
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  document.addEventListener('focusin', outside)
  document.addEventListener('keydown', keydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('focusin', outside)
  document.removeEventListener('keydown', keydown)
})
</script>

<template>
  <div class="task-center">
    <button
      ref="trigger"
      type="button"
      class="task-trigger"
      :class="{ 'task-trigger--open': opened, 'task-trigger--busy': runningCount + queuedCount > 0 }"
      :title="entryLabel"
      :aria-label="entryLabel"
      aria-haspopup="dialog"
      aria-controls="task-center-panel"
      :aria-expanded="opened"
      @click="togglePanel"
    >
      <Loader2 v-if="runningCount" :size="15" class="task-spin" />
      <ListTodo v-else :size="15" />
      <span>任务</span>
      <span v-if="runningCount" class="task-trigger__count">{{ runningCount }}</span>
      <span v-else-if="queuedCount" class="task-trigger__count">{{ queuedCount }}</span>
      <span v-if="failedCount" class="task-trigger__failed" :title="`${failedCount} 个任务失败`">{{ failedCount }}</span>
    </button>

    <Teleport to="body">
      <Transition name="task-panel">
        <section
          v-if="opened"
          id="task-center-panel"
          ref="panel"
          class="task-panel"
          role="dialog"
          aria-labelledby="task-center-title"
          aria-describedby="task-center-note"
        >
          <header class="task-panel__header">
            <div>
              <h2 id="task-center-title">任务与下载</h2>
              <p id="task-center-note">下载依次执行；重启后可恢复未完成的部分。</p>
            </div>
            <button type="button" class="task-panel__clear" :disabled="clearing || history.length === 0" title="清除当前可见的扫描、识别等历史；运行中任务与下载结果继续保留" @click="clearHistory">
              <Trash2 :size="13" />清除历史
            </button>
            <button ref="closeButton" type="button" class="task-panel__close" title="关闭任务面板" aria-label="关闭任务面板" @click="closePanel()">
              <X :size="16" />
            </button>
          </header>

          <div class="task-panel__body">
            <p v-if="actionError || workflow.jobsError.value" class="task-card__error" role="alert">{{ actionError || workflow.jobsError.value }}</p>
            <div v-if="runningCount === 0 && history.length === 0 && downloadJobs.length === 0" class="task-panel__empty">
              <ListTodo :size="30" :stroke-width="1.3" />
              <h3>暂无任务</h3>
              <p>扫描、识别、整理和验证的进度会显示在这里。</p>
            </div>
            <template v-for="section in sections" :key="section.key">
              <section v-if="section.items.length" class="task-group" :aria-label="section.label">
                <h3 class="task-group__heading">{{ section.label }}<span>{{ section.items.length }}</span></h3>
                <article v-for="task in section.items" :key="task.id" class="task-card" :class="`task-card--${task.status}`">
                  <div class="task-card__head">
                    <Loader2 v-if="task.status === 'running'" :size="16" class="task-spin task-card__icon" />
                    <Check v-else-if="task.status === 'success'" :size="16" class="task-card__icon" />
                    <CircleAlert v-else-if="task.status === 'failed'" :size="16" class="task-card__icon" />
                    <Minus v-else :size="16" class="task-card__icon" />
                    <h4>{{ task.title }}</h4>
                    <span class="task-card__status">{{ statusLabels[task.status] }}</span>
                  </div>
                  <div class="task-card__meta">
                    <span>{{ kindLabels[task.kind] }}</span>
                    <span :title="new Date(task.startedAt).toLocaleString()">{{ time(task.startedAt) }} 开始</span>
                    <span v-if="task.finishedAt" :title="new Date(task.finishedAt).toLocaleString()">{{ time(task.finishedAt) }} 结束</span>
                    <span v-if="task.status === 'success' && task.events.some(e => e.level === 'warn')" class="task-card__warning">有提醒</span>
                  </div>
                  <div v-if="task.status === 'running'" class="task-progress">
                    <div
                      class="task-progress__bar"
                      :class="{ 'task-progress__bar--unknown': task.total === 0 }"
                      role="progressbar"
                      :aria-label="task.title"
                      :aria-valuemin="0"
                      :aria-valuemax="100"
                      :aria-valuenow="task.total > 0 ? task.percent : undefined"
                      :aria-valuetext="taskProgress(task)"
                    ><i :style="task.total > 0 ? { width: `${task.percent}%` } : undefined" /></div>
                    <span>{{ taskProgress(task) }}</span>
                  </div>
                  <p v-if="task.message" class="task-card__message">{{ task.message }}</p>
                  <p v-if="task.current" class="task-card__current" :title="task.current">{{ task.current }}</p>
                  <p v-if="task.error" class="task-card__error">{{ task.error }}</p>
                  <details v-if="task.scanEntries?.length" class="task-scan-results">
                    <summary>逐项结果 · {{ task.scanEntries.length }}</summary>
                    <ul>
                      <li v-for="(entry, index) in task.scanEntries" :key="index">
                        <strong>{{ scanStatusLabels[entry.status] }}</strong><span class="mono">{{ entry.path }}</span><p>{{ entry.message }}</p>
                        <div v-if="entry.resourceId && task.kind === 'video-scan'" class="task-card__actions">
                          <button type="button" @click="openWork(entry.resourceId, entry.status === 'review')">{{ entry.status === 'review' ? '修正资料' : '打开作品' }}</button>
                          <button v-if="entry.status === 'failed' || entry.status === 'review'" type="button" :disabled="!!retryingEntry || videoScan.running.value" @click="retryScan(task, entry)">重新识别此作品</button>
                        </div>
                        <small v-else-if="entry.status === 'failed' || entry.status === 'review'">尚无作品记录，请检查来源目录后重新扫描。</small>
                      </li>
                    </ul>
                  </details>
                  <button
                    type="button"
                    class="task-card__logs"
                    :aria-expanded="expanded.has(task.id)"
                    :aria-controls="`${task.id}-events`"
                    @click="toggleEvents(task.id)"
                  >
                    <ChevronDown :size="13" :class="{ 'task-card__chevron--open': expanded.has(task.id) }" />
                    {{ expanded.has(task.id) ? '收起日志' : '查看日志' }} · {{ task.events.length }}
                  </button>
                  <ol v-if="expanded.has(task.id)" :id="`${task.id}-events`" class="task-events">
                    <li v-for="(event, index) in task.events" :key="index" :class="`task-event--${event.level}`">
                      <time>{{ time(event.at) }}</time><span class="task-events__level">{{ eventLabels[event.level] }}</span><span>{{ event.message }}</span>
                    </li>
                  </ol>
                  <details v-if="identifyKind(task) && task.status !== 'running'" class="task-identify" @toggle="toggleIdentifyLogs(task.id, $event)">
                    <summary>查看识别日志</summary>
                    <IdentifyLog v-if="identifyLogs.has(task.id)" :resource-kind="identifyKind(task)" :since="task.startedAt" :until="task.finishedAt" />
                  </details>
                </article>
              </section>
            </template>
          </div>
          <div v-if="downloadJobs.length" class="task-panel__downloads" aria-label="下载">
            <template v-for="section in downloadSections" :key="section.key">
              <component :is="section.collapsible ? 'details' : 'section'" v-if="section.jobs.length" class="task-group" :class="{ 'task-group--downloads': section.collapsible }" :aria-label="section.label">
                <component :is="section.collapsible ? 'summary' : 'h3'" class="task-group__heading">{{ section.label }}<span>{{ section.jobs.length }}</span></component>
                <article v-for="job in section.jobs" :key="job.id" class="task-card download-task" :class="`task-card--${job.status}`">
                  <div class="task-card__head">
                    <Loader2 v-if="job.status === 'running'" :size="16" class="task-spin task-card__icon" />
                    <h4>{{ job.title }}</h4><span class="task-card__status">{{ jobStatus(job) }}</span>
                  </div>
                  <p class="task-card__message">{{ jobSummary(job) }}</p>
                  <p v-if="job.message" class="task-card__message">{{ job.message }}</p>
                  <div class="task-card__actions">
                    <button v-if="job.resourceId" type="button" @click="openWork(job.resourceId)"><ExternalLink :size="13" />打开作品</button>
                    <button v-if="job.directory" type="button" :disabled="workflow.actionIds.value.has(job.id)" @click="workflow.reveal(job.id)"><FolderOpen :size="13" />打开目录</button>
                    <button v-if="job.status === 'running' || job.status === 'queued'" type="button" :disabled="workflow.actionIds.value.has(job.id)" @click="workflow.cancel(job.id)"><Square :size="12" />{{ job.status === 'queued' ? '取消排队' : '停止下载' }}</button>
                    <button v-for="stage in videoJobRetryStages(job)" :key="stage" type="button" :disabled="workflow.actionIds.value.has(job.id)" @click="workflow.retry(job.id, stage)"><RefreshCw :size="13" />{{ retryLabels[stage] }}</button>
                  </div>
                  <details class="task-download-items">
                    <summary>查看 {{ job.items.length }} 项的下载、资料和入库结果</summary>
                    <ul>
                      <li v-for="item in job.items" :key="item.videoCode">
                        <strong>{{ item.title || item.videoCode }}</strong>
                        <span>视频：{{ stageLabels[item.transfer] }} · 资料：{{ stageLabels[item.metadata] }} · 入库：{{ job.register ? stageLabels[item.registration] : '仅保存文件' }}</span>
                        <span v-if="item.transfer === 'running'">已接收 {{ formatBytes(item.receivedBytes) }}{{ item.totalBytes > 0 ? ' / ' + formatBytes(item.totalBytes) : ' · 大小未知' }}</span>
                        <span v-if="item.sourceLabel">实际清晰度：{{ item.sourceLabel }}</span>
                        <p v-if="item.error" class="task-card__error">{{ item.error }}</p>
                        <p v-for="warning in item.warnings" :key="warning" class="task-card__warning">{{ warning }}</p>
                      </li>
                    </ul>
                    <p v-for="warning in job.warnings" :key="warning" class="task-card__warning">{{ warning }}</p>
                  </details>
                </article>
              </component>
            </template>
          </div>
          <footer class="task-panel__footer">扫描等记录保留最近 30 项、每项 100 条事件。下载结果独立保留；补资料和重试入库不重新传输视频。</footer>
        </section>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.task-center { display: flex; align-items: center; margin-left: auto; padding: 0 12px; -webkit-app-region: no-drag; }
.task-trigger { display: flex; align-items: center; gap: 6px; height: 27px; padding: 0 9px; border-radius: var(--radius-btn); color: var(--text-sub); font-size: var(--fs-tag); }
.task-trigger:hover, .task-trigger--open { background: var(--hover-surface); color: var(--text-main); }
.task-trigger--busy { color: var(--accent); }
.task-trigger__count, .task-trigger__failed { min-width: 16px; padding: 0 4px; border-radius: 5px; font-size: 11px; line-height: 17px; text-align: center; font-variant-numeric: tabular-nums; }
.task-trigger__count { background: var(--active-surface); color: var(--accent); }
.task-trigger__failed { background: var(--danger-bg); color: var(--danger); }
.task-trigger:focus-visible, .task-panel button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.task-panel { position: fixed; z-index: 120; top: calc(var(--titlebar-h) + 8px); right: 12px; display: flex; flex-direction: column; width: min(490px, calc(100vw - 24px)); max-height: calc(100vh - var(--titlebar-h) - 20px); color: var(--text-main); background: var(--bg-elevated); border: 1px solid var(--divider); border-radius: var(--radius-card); box-shadow: var(--shadow-pop); overflow: hidden; -webkit-app-region: no-drag; }
.task-panel__header { display: flex; align-items: center; gap: 10px; padding: 15px 16px 13px; border-bottom: 1px solid var(--divider); }
.task-panel__header > div { min-width: 0; flex: 1; }
.task-panel__header h2 { font-size: var(--fs-card-title); font-weight: 500; }
.task-panel__header p { margin-top: 4px; color: var(--text-sub); font-size: 11px; }
.task-panel__clear, .task-panel__close { display: flex; align-items: center; justify-content: center; gap: 5px; flex: none; height: 28px; padding: 0 6px; border-radius: 5px; color: var(--text-sub); font-size: 11px; }
.task-panel__clear:hover:not(:disabled), .task-panel__close:hover { color: var(--text-main); background: var(--hover-surface); }
.task-panel__clear:disabled { opacity: 0.4; cursor: default; }
.task-panel__header, .task-panel__footer { flex: none; }
.task-panel__body { flex: 1 1 auto; min-height: 0; padding: 12px; overflow-y: auto; overscroll-behavior: contain; }
/* 下载区固定在 footer 上方、自己滚动，最多占 45vh（面板本身没有确定高度，百分比 max-height 算不出来）；
   任务多时上面那块被压缩滚动，下载队列始终看得见 */
.task-panel__downloads { flex: none; max-height: 45vh; padding: 12px; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid var(--divider); background: var(--bg-side); }
.task-panel__empty { display: grid; justify-items: center; gap: 12px; padding: 34px 16px; color: var(--text-sub); text-align: center; }
.task-panel__empty h3 { font-family: var(--font-display); color: var(--text-main); font-size: 17px; font-weight: 400; }
.task-panel__empty p { font-size: var(--fs-tag); line-height: 1.7; }
.task-group + .task-group { margin-top: 18px; }
.task-group__heading { display: flex; gap: 8px; align-items: center; margin: 0 4px 9px; font-weight: 500; font-size: var(--fs-tag); color: var(--text-sub); }
.task-group__heading span { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.task-group--downloads > summary { cursor: pointer; padding: 8px 0; }
.task-group--downloads > summary::before { content: '▸'; }
.task-group--downloads[open] > summary::before { content: '▾'; }
.task-identify { margin-top: 10px; }
.task-identify > summary { cursor: pointer; font-size: 12px; color: var(--accent); }
.task-card { padding: 12px; border: 1px solid var(--divider); border-radius: var(--radius-input); background: var(--bg-side); }
.task-card + .task-card { margin-top: 8px; }
.task-card__head { display: flex; align-items: flex-start; gap: 7px; }
.task-card__head h4 { min-width: 0; flex: 1; font-size: var(--fs-body); font-weight: 500; line-height: 1.5; overflow-wrap: anywhere; user-select: text; }
.task-card__icon { margin-top: 2px; flex: none; }
.task-card__status { flex: none; font-size: 11px; line-height: 20px; }
.task-card--running .task-card__icon, .task-card--running .task-card__status { color: var(--accent); }
.task-card--success .task-card__icon, .task-card--success .task-card__status { color: var(--success); }
.task-card--failed .task-card__icon, .task-card--failed .task-card__status { color: var(--danger); }
.task-card--cancelled .task-card__icon, .task-card--cancelled .task-card__status { color: var(--text-sub); }
.task-card__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 6px; color: var(--text-sub); font-size: 10px; font-variant-numeric: tabular-nums; }
.task-card__warning { color: var(--warning); }
.task-progress { display: flex; align-items: center; gap: 10px; margin-top: 11px; }
.task-progress > span { flex: none; color: var(--text-sub); font-size: 11px; font-variant-numeric: tabular-nums; }
.task-progress__bar { flex: 1; height: 4px; overflow: hidden; background: var(--active-surface); border-radius: 4px; }
.task-progress__bar i { display: block; height: 100%; background: var(--accent); border-radius: inherit; transition: width var(--t-fast) ease; }
.task-progress__bar--unknown i { width: 35%; animation: task-indeterminate 1.6s ease-in-out infinite; }
.task-card__message, .task-card__error { margin-top: 8px; font-size: var(--fs-tag); line-height: 1.65; overflow-wrap: anywhere; white-space: pre-wrap; user-select: text; }
.task-card__error { color: var(--danger); }
.task-card__current { margin-top: 5px; font-size: 11px; font-family: var(--font-mono); color: var(--text-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: text; }
.task-card__logs { display: flex; align-items: center; gap: 4px; margin-top: 10px; padding: 2px 0; font-size: 11px; color: var(--text-sub); }
.task-card__logs:hover { color: var(--accent); }
.task-card__chevron--open { transform: rotate(180deg); }
.task-events { display: grid; gap: 8px; margin-top: 9px; padding-top: 10px; border-top: 1px solid var(--divider); max-height: 240px; overflow-y: auto; list-style: none; user-select: text; }
.task-events li { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 7px; align-items: baseline; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; white-space: pre-wrap; }
.task-events time { font-variant-numeric: tabular-nums; color: var(--text-sub); }
.task-events__level { color: var(--text-sub); }
.task-event--warn .task-events__level { color: var(--warning); }
.task-event--error { color: var(--danger); }
.task-event--error .task-events__level { color: inherit; }
.task-event--success .task-events__level { color: var(--success); }
.task-panel__footer { padding: 10px 16px; border-top: 1px solid var(--divider); color: var(--text-sub); font-size: 10px; line-height: 1.7; }
.task-spin { animation: task-spin 1.4s linear infinite; }
.task-card__actions { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 10px; }
.task-card__actions button { display: inline-flex; align-items: center; gap: 4px; min-height: 28px; color: var(--text-main); font-size: var(--fs-tag); border-bottom: 1px solid var(--divider); }
.task-card__actions button:disabled { opacity: .45; cursor: default; }
.task-download-items, .task-scan-results { margin-top: 10px; color: var(--text-sub); font-size: var(--fs-tag); line-height: 1.65; }
.task-download-items summary, .task-scan-results summary { cursor: pointer; padding: 4px 0; }
.task-download-items ul, .task-scan-results ul { list-style: none; padding: 0; }
.task-download-items li, .task-scan-results li { display: flex; flex-direction: column; gap: 3px; padding: 9px 0; border-top: 1px solid var(--divider); overflow-wrap: anywhere; }
.task-download-items strong, .task-scan-results strong { color: var(--text-main); font-weight: 500; }
.task-card--partial .task-card__status, .task-card--interrupted .task-card__status, .task-card__warning { color: var(--text-main); }
.task-card--queued .task-card__status { color: var(--text-main); }
.task-panel summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
:global([data-theme='light']) .task-panel .task-card__error, :global([data-theme='light']) .task-trigger__failed { color: #b42332; }
.task-panel-enter-active, .task-panel-leave-active { transition: opacity var(--t-fast) ease, transform var(--t-fast) ease; }
.task-panel-enter-from, .task-panel-leave-to { opacity: 0; transform: translateY(-5px); }
@keyframes task-spin { to { transform: rotate(360deg); } }
@keyframes task-indeterminate { 0% { transform: translateX(-110%); } 100% { transform: translateX(390%); } }
@media (prefers-reduced-motion: reduce) { .task-spin, .task-progress__bar--unknown i { animation: none; } .task-progress__bar i, .task-panel-enter-active, .task-panel-leave-active { transition: none; } }
@media (max-width: 540px) { .task-center { padding: 0 4px; } .task-trigger { padding: 0 5px; } .task-panel__header { gap: 5px; padding: 12px; } .task-panel__clear { font-size: 10px; } }
</style>
