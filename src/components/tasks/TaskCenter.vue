<script setup lang="ts">
/**
 * 顶栏的「日志」面板（实测第四轮之前叫「任务」）。
 *
 * 四个页签：任务（扫描 / 识别 / 整理这类进程内任务）、下载记录、整理记录、识别与调用。
 * 以前下载队列和任务挤在同一块里，整理记录藏在影视墙副菜单栏，搜索调用记录躲在设置页 ——
 * 用户看见顶栏一个红色的 7，翻遍面板也不知道是哪 7 个。现在角标只数两样：下载待处理 + 任务失败，
 * 悬停能看拆分；下载记录默认只看待处理，看完能一条条「移除记录」。
 */
import { computed, getCurrentInstance, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { routerKey } from 'vue-router'
import { Check, ChevronDown, CircleAlert, ExternalLink, FolderOpen, Loader2, Minus, RefreshCw, ScrollText, Square, Trash2, X } from 'lucide-vue-next'
import { useTaskCenter, type TaskScanEntry, type TaskWithResults } from '@/composables/useTaskCenter'
import { useVideoWorkflow, videoJobRetryStages } from '@/composables/useVideoWorkflow'
import { reidentifyVideo, useMediaScan } from '@/composables/useMediaScan'
import { activeModule } from '@/composables/useModules'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import IdentifyLog from '@/components/identify/IdentifyLog.vue'
import SearchCallLog from '@/components/identify/SearchCallLog.vue'
import OrganizeHistory from '@/components/video/OrganizeHistory.vue'
import { filterVisibleJournals } from '@/components/video/useOrganizeSession'
import type { TaskEventLevel, TaskKind, TaskStatus } from '@/types'
import type { VideoOrganizeJournal } from '@/types/video-organize'
import type { VideoDownloadJob, VideoJobRetry, VideoJobStage } from '@/types/video-workflow'
import { errorMessage, formatBytes } from '@/utils'

type Tab = 'tasks' | 'downloads' | 'organize' | 'identify'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'tasks', label: '任务' }, { key: 'downloads', label: '下载记录' }, { key: 'organize', label: '整理记录' }, { key: 'identify', label: '识别与调用' }
]

const center = useTaskCenter()
const { runningTasks, history } = center
const workflow = useVideoWorkflow()
const videoScan = useMediaScan('video')
const { success, toast } = useToast()
const actionError = ref('')
let privacyRevision = 0
const router = inject(routerKey, null)
const pinia = getCurrentInstance()?.appContext.config.globalProperties.$pinia
const settings = pinia ? useSettingsStore(pinia) : null
const privateHidden = computed(() => !workflow.privacyReady.value || workflow.hideHentai.value)
watch(() => settings?.loaded ? settings.settings : null, value => {
  if (value) workflow.applyPreferences(value)
}, { immediate: true, deep: true, flush: 'sync' })
const downloadJobs = workflow.jobs
const activeJob = (job: VideoDownloadJob) => job.status === 'running' || job.status === 'queued'
const needsAttention = (job: VideoDownloadJob) => !activeJob(job) && (videoJobRetryStages(job).length > 0 || job.status === 'failed')
const runningCount = computed(() => center.runningCount.value + downloadJobs.value.filter(job => job.status === 'running').length)
const queuedCount = computed(() => downloadJobs.value.filter(job => job.status === 'queued').length)
const downloadAttention = computed(() => downloadJobs.value.filter(needsAttention).length)
const failedCount = computed(() => center.attentionCount.value + downloadAttention.value)
const attentionHint = computed(() => [
  downloadAttention.value ? `${downloadAttention.value} 个下载待处理（失败或有剩余项，可重试或移除记录）` : '',
  center.attentionCount.value ? `${center.attentionCount.value} 个任务失败、中断或有待确认项` : ''
].filter(Boolean).join('；'))
const tab = ref<Tab>('tasks')
const downloadFilter = ref<'attention' | 'all'>('attention')
const shownJobs = computed(() => downloadFilter.value === 'all' ? downloadJobs.value : downloadJobs.value.filter(job => activeJob(job) || needsAttention(job)))
const jobSections = computed(() => [
  { key: 'active', label: '下载队列', jobs: shownJobs.value.filter(activeJob).sort((a, b) => a.createdAt - b.createdAt) },
  { key: 'finished', label: downloadFilter.value === 'all' ? '下载结果' : '待处理的下载', jobs: shownJobs.value.filter(job => !activeJob(job)) }
])
const journals = ref<VideoOrganizeJournal[]>([])
const journalsLoaded = ref(false)
const journalBusy = ref(false)
const journalError = ref('')
const pendingJournals = computed(() => journals.value.filter(journal => journal.status === 'partial' || journal.status === 'running' || journal.status === 'rollback-partial').length)
const tabCounts = computed<Record<Tab, number>>(() => ({
  tasks: runningTasks.value.length, downloads: downloadAttention.value + queuedCount.value + downloadJobs.value.filter(job => job.status === 'running').length,
  organize: journalsLoaded.value ? pendingJournals.value : 0, identify: 0
}))
const retryingEntry = ref('')
watch(privateHidden, hidden => {
  center.setVideoHidden(hidden)
  privacyRevision++
  actionError.value = ''
  retryingEntry.value = ''
  journals.value = []
  journalsLoaded.value = false
  journalError.value = ''
}, { immediate: true, flush: 'sync' })
const clearing = ref(false)
const opened = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const expanded = ref(new Set<string>())
const identifyLogs = ref(new Set<string>())
const sections = computed(() => [
  { key: 'running', label: '运行中', items: runningTasks.value },
  { key: 'history', label: '最近结束', items: history.value }
])
const entryLabel = computed(() => `日志：${runningCount.value} 个运行中，${queuedCount.value} 个排队，${failedCount.value} 个失败或待处理`)
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
const identifyKindLabel = computed(() => ({ software: '软件', game: '游戏', video: '影视' })[activeModule.value])

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
  if (!entry.resourceId || retryingEntry.value || videoScan.running.value || privateHidden.value) return
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
async function retryUnit(dir: string): Promise<void> {
  try {
    if (!(await window.baoyi.scan.retry(dir))) { toast('这个目录已经不在扫描列表里了'); return }
    success('已退回待识别，到设置页「扫描与识别」点「开始识别」重跑')
  } catch (cause) { actionError.value = errorMessage(cause) }
}

/* ------------------------------ 整理记录 ------------------------------ */
async function loadJournals(): Promise<void> {
  if (journalBusy.value || !workflow.privacyReady.value || typeof window === 'undefined' || !window.baoyi?.videoOrganize) return
  const revision = privacyRevision
  journalBusy.value = true
  journalError.value = ''
  try {
    const saved = await window.baoyi.videoOrganize.list()
    const visible = await filterVisibleJournals(saved, privateHidden.value)
    if (revision !== privacyRevision) return
    journals.value = visible
    journalsLoaded.value = true
  } catch (cause) { if (revision === privacyRevision) journalError.value = privateHidden.value ? '读取整理记录失败，请重试。' : errorMessage(cause) }
  finally { journalBusy.value = false }
}
async function recoverJournal(id: string, action: 'retry' | 'rollback'): Promise<void> {
  if (journalBusy.value || !journals.value.some(journal => journal.id === id && (action === 'retry' ? journal.canRetry : journal.canRollback))) return
  const revision = privacyRevision
  journalBusy.value = true
  journalError.value = ''
  try {
    const journal = await window.baoyi.videoOrganize[action](id)
    if (revision !== privacyRevision) return
    journals.value = [journal, ...journals.value.filter(value => value.id !== journal.id)].sort((a, b) => b.updatedAt - a.updatedAt)
  } catch (cause) { if (revision === privacyRevision) journalError.value = errorMessage(cause) }
  finally { journalBusy.value = false }
}
function showTab(next: Tab): void {
  tab.value = next
  if (next === 'organize' && !journalsLoaded.value) void loadJournals()
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
  if (tab.value === 'organize') void loadJournals()
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
      :title="attentionHint || entryLabel"
      :aria-label="entryLabel"
      aria-haspopup="dialog"
      aria-controls="task-center-panel"
      :aria-expanded="opened"
      @click="togglePanel"
    >
      <Loader2 v-if="runningCount" :size="15" class="task-spin" />
      <ScrollText v-else :size="15" />
      <span>日志</span>
      <span v-if="runningCount" class="task-trigger__count">{{ runningCount }}</span>
      <span v-else-if="queuedCount" class="task-trigger__count">{{ queuedCount }}</span>
      <span v-if="failedCount" class="task-trigger__failed" :title="attentionHint">{{ failedCount }}</span>
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
              <h2 id="task-center-title">日志</h2>
              <p id="task-center-note">{{ attentionHint || '任务、下载、整理和识别的记录都在这里；下载依次执行，重启后可恢复未完成的部分。' }}</p>
            </div>
            <button v-if="tab === 'tasks'" type="button" class="task-panel__clear" :disabled="clearing || history.length === 0" title="清除当前可见的扫描、识别等历史；运行中任务与下载记录继续保留" @click="clearHistory">
              <Trash2 :size="13" />清除历史
            </button>
            <button ref="closeButton" type="button" class="task-panel__close" title="关闭日志面板" aria-label="关闭日志面板" @click="closePanel()">
              <X :size="16" />
            </button>
          </header>
          <nav class="task-tabs no-select" aria-label="日志类别">
            <button v-for="item in TABS" :key="item.key" type="button" :aria-current="tab === item.key ? 'page' : undefined" @click="showTab(item.key)">
              {{ item.label }}<span v-if="tabCounts[item.key]" class="task-tabs__count" :class="{ 'task-tabs__count--warn': item.key === 'downloads' && downloadAttention > 0 || item.key === 'organize' }">{{ tabCounts[item.key] }}</span>
            </button>
          </nav>

          <div class="task-panel__body">
            <p v-if="actionError || workflow.jobsError.value" class="task-card__error" role="alert">{{ actionError || workflow.jobsError.value }}</p>
            <template v-if="tab === 'tasks'">
              <div v-if="runningTasks.length === 0 && history.length === 0" class="task-panel__empty">
                <ScrollText :size="30" :stroke-width="1.3" />
                <h3>暂无任务</h3>
                <p>扫描、识别、整理和验证的进度会显示在这里。下载在「下载记录」页签。</p>
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
            </template>

            <div v-else-if="tab === 'downloads'" class="task-panel__downloads" aria-label="下载记录">
              <div class="task-filter">
                <label>显示<select v-model="downloadFilter" class="select" aria-label="下载记录范围"><option value="attention">待处理</option><option value="all">全部</option></select></label>
                <span>{{ downloadFilter === 'all' ? `共 ${downloadJobs.length} 条` : `${downloadAttention} 条待处理` }}</span>
              </div>
              <div v-if="!shownJobs.length" class="task-panel__empty">
                <Check v-if="downloadJobs.length" :size="30" :stroke-width="1.3" />
                <ScrollText v-else :size="30" :stroke-width="1.3" />
                <h3>{{ downloadJobs.length ? '没有待处理的下载' : '暂无下载记录' }}</h3>
                <p>{{ downloadJobs.length ? '切到「全部」能看到已完成的记录。' : '从 Hanime 添加作品后，进度和结果会显示在这里。' }}</p>
              </div>
              <template v-for="section in jobSections" :key="section.key">
                <section v-if="section.jobs.length" class="task-group" :aria-label="section.label">
                  <h3 class="task-group__heading">{{ section.label }}<span>{{ section.jobs.length }}</span></h3>
                  <article v-for="job in section.jobs" :key="job.id" class="task-card download-task" :class="`task-card--${job.status}`">
                    <div class="task-card__head">
                      <Loader2 v-if="job.status === 'running'" :size="16" class="task-spin task-card__icon" />
                      <CircleAlert v-else-if="needsAttention(job)" :size="16" class="task-card__icon" />
                      <h4>{{ job.title }}</h4><span class="task-card__status">{{ jobStatus(job) }}</span>
                    </div>
                    <p class="task-card__message">{{ jobSummary(job) }}</p>
                    <p v-if="job.message" class="task-card__message">{{ job.message }}</p>
                    <div class="task-card__actions">
                      <button v-if="job.resourceId" type="button" @click="openWork(job.resourceId)"><ExternalLink :size="13" />打开作品</button>
                      <button v-if="job.directory" type="button" :disabled="workflow.actionIds.value.has(job.id)" @click="workflow.reveal(job.id)"><FolderOpen :size="13" />打开目录</button>
                      <button v-if="activeJob(job)" type="button" :disabled="workflow.actionIds.value.has(job.id)" @click="workflow.cancel(job.id)"><Square :size="12" />{{ job.status === 'queued' ? '取消排队' : '停止下载' }}</button>
                      <button v-for="stage in videoJobRetryStages(job)" :key="stage" type="button" :disabled="workflow.actionIds.value.has(job.id)" @click="workflow.retry(job.id, stage)"><RefreshCw :size="13" />{{ retryLabels[stage] }}</button>
                      <button v-if="!activeJob(job)" type="button" class="task-card__dismiss" title="只删这条记录，文件和作品都不动；角标不再数它" :disabled="workflow.actionIds.value.has(job.id)" @click="workflow.dismiss(job.id)"><Trash2 :size="12" />移除记录</button>
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
                </section>
              </template>
            </div>

            <div v-else-if="tab === 'organize'" class="task-panel__organize">
              <p v-if="journalError" class="task-card__error" role="alert">{{ journalError }}</p>
              <p v-if="journalBusy" class="task-panel__hint" role="status"><Loader2 :size="13" class="task-spin" />正在读取整理记录…</p>
              <OrganizeHistory :journals="journals" :loaded="journalsLoaded" :busy="journalBusy" @refresh="loadJournals" @retry="id => recoverJournal(id, 'retry')" @rollback="id => recoverJournal(id, 'rollback')" />
            </div>

            <div v-else class="task-panel__identify">
              <p class="task-panel__hint">当前看的是「{{ identifyKindLabel }}」模块的识别日志；切换顶栏模块就换一份。设置页「识别日志」页签里也有同一份。</p>
              <IdentifyLog :resource-kind="activeModule" @retry="retryUnit" />
              <SearchCallLog />
            </div>
          </div>
          <footer class="task-panel__footer">任务记录保留最近 30 项、每项 100 条事件。下载记录独立保留，补资料和重试入库不重新传输视频；「移除记录」只删记录不删文件。</footer>
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
.task-panel { position: fixed; z-index: 120; top: calc(var(--titlebar-h) + 8px); right: 12px; display: flex; flex-direction: column; width: min(560px, calc(100vw - 24px)); max-height: calc(100vh - var(--titlebar-h) - 20px); color: var(--text-main); background: var(--bg-elevated); border: 1px solid var(--divider); border-radius: var(--radius-card); box-shadow: var(--shadow-pop); overflow: hidden; -webkit-app-region: no-drag; }
.task-panel__header { display: flex; align-items: center; gap: 10px; padding: 15px 16px 11px; }
.task-panel__header > div { min-width: 0; flex: 1; }
.task-panel__header h2 { font-size: var(--fs-card-title); font-weight: 500; }
.task-panel__header p { margin-top: 4px; color: var(--text-sub); font-size: 11px; line-height: 1.6; }
.task-panel__clear, .task-panel__close { display: flex; align-items: center; justify-content: center; gap: 5px; flex: none; height: 28px; padding: 0 6px; border-radius: 5px; color: var(--text-sub); font-size: 11px; }
.task-panel__clear:hover:not(:disabled), .task-panel__close:hover { color: var(--text-main); background: var(--hover-surface); }
.task-panel__clear:disabled { opacity: 0.4; cursor: default; }
.task-tabs { flex: none; display: flex; gap: 16px; padding: 0 16px; border-bottom: 1px solid var(--divider); }
.task-tabs button { display: flex; align-items: center; gap: 5px; padding: 8px 0; font-size: 12px; color: var(--text-sub); border-bottom: 2px solid transparent; }
.task-tabs button:hover { color: var(--text-main); }
.task-tabs button[aria-current] { color: var(--text-main); border-color: var(--accent); }
.task-tabs__count { min-width: 16px; padding: 0 4px; border-radius: 5px; background: var(--active-surface); color: var(--accent); font-size: 10px; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }
.task-tabs__count--warn { background: var(--danger-bg); color: var(--danger); }
.task-panel__header, .task-panel__footer { flex: none; }
.task-panel__body { flex: 1 1 auto; min-height: 0; padding: 12px; overflow-y: auto; overscroll-behavior: contain; }
.task-filter { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 4px 10px; color: var(--text-sub); font-size: var(--fs-tag); }
.task-filter label { display: flex; align-items: center; gap: 8px; }
.task-filter .select { height: 26px; font-size: 12px; }
.task-panel__hint { display: flex; align-items: center; gap: 6px; margin: 0 4px 10px; color: var(--text-sub); font-size: var(--fs-tag); line-height: 1.6; }
.task-panel__identify { display: grid; gap: 14px; }
.task-panel__empty { display: grid; justify-items: center; gap: 12px; padding: 34px 16px; color: var(--text-sub); text-align: center; }
.task-panel__empty h3 { font-family: var(--font-display); color: var(--text-main); font-size: 17px; font-weight: 400; }
.task-panel__empty p { font-size: var(--fs-tag); line-height: 1.7; }
.task-group + .task-group { margin-top: 18px; }
.task-group__heading { display: flex; gap: 8px; align-items: center; margin: 0 4px 9px; font-weight: 500; font-size: var(--fs-tag); color: var(--text-sub); }
.task-group__heading span { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
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
.task-card--partial .task-card__icon, .task-card--interrupted .task-card__icon { color: var(--warning); }
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
.task-card__actions .task-card__dismiss { margin-left: auto; color: var(--text-sub); }
.task-card__actions .task-card__dismiss:hover:not(:disabled) { color: var(--danger); }
.task-download-items, .task-scan-results { margin-top: 10px; color: var(--text-sub); font-size: var(--fs-tag); line-height: 1.65; }
.task-download-items summary, .task-scan-results summary { cursor: pointer; padding: 4px 0; }
.task-download-items ul, .task-scan-results ul { list-style: none; padding: 0; }
.task-download-items li, .task-scan-results li { display: flex; flex-direction: column; gap: 3px; padding: 9px 0; border-top: 1px solid var(--divider); overflow-wrap: anywhere; }
.task-download-items strong, .task-scan-results strong { color: var(--text-main); font-weight: 500; }
.task-card--partial .task-card__status, .task-card--interrupted .task-card__status, .task-card__warning { color: var(--text-main); }
.task-card--queued .task-card__status { color: var(--text-main); }
.task-panel summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
:global([data-theme='light']) .task-panel .task-card__error, :global([data-theme='light']) .task-trigger__failed, :global([data-theme='light']) .task-tabs__count--warn { color: #b42332; }
.task-panel-enter-active, .task-panel-leave-active { transition: opacity var(--t-fast) ease, transform var(--t-fast) ease; }
.task-panel-enter-from, .task-panel-leave-to { opacity: 0; transform: translateY(-5px); }
@keyframes task-spin { to { transform: rotate(360deg); } }
@keyframes task-indeterminate { 0% { transform: translateX(-110%); } 100% { transform: translateX(390%); } }
@media (prefers-reduced-motion: reduce) { .task-spin, .task-progress__bar--unknown i { animation: none; } .task-progress__bar i, .task-panel-enter-active, .task-panel-leave-active { transition: none; } }
@media (max-width: 540px) { .task-center { padding: 0 4px; } .task-trigger { padding: 0 5px; } .task-panel__header { gap: 5px; padding: 12px; } .task-panel__clear { font-size: 10px; } .task-tabs { gap: 10px; padding-inline: 12px; } }
</style>
