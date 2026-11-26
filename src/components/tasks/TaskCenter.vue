<script setup lang="ts">
import { locale as appLocale, tr } from '../../i18n/index.ts'

/**
 * 顶栏的「日志」面板（实测第四轮之前叫「任务」）。
 *
 * 跟随当前模块显示任务、下载、整理和识别记录；角标与清除范围保持一致。
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
import { useProjectLaunch } from '@/composables/useProjectLaunch'
import {useDocumentInsights} from '@/composables/useDocumentInsights'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import IdentifyLog from '@/components/identify/IdentifyLog.vue'
import SearchCallLog from '@/components/identify/SearchCallLog.vue'
import ComicDownloadList from '@/components/image/ComicDownloadList.vue'
import {useComicIngest} from '@/composables/useComicIngest'
import { useImageDownloads } from '@/composables/useImageDownloads'
import OrganizeHistory from '@/components/video/OrganizeHistory.vue'
import { filterVisibleJournals } from '@/components/video/useOrganizeSession'
import type { TaskEventLevel, TaskKind, TaskStatus } from '@/types'
import type { VideoOrganizeJournal } from '@/types/video-organize'
import type { VideoDownloadJob, VideoJobRetry, VideoJobStage } from '@/types/video-workflow'
import { errorMessage, formatBytes } from '@/utils'

type Tab = 'tasks' | 'downloads' | 'organize' | 'identify'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'tasks', get label() { return tr("任务") } }, { key: 'downloads', get label() { return tr("下载记录") } }, { key: 'organize', get label() { return tr("整理记录") } }, { key: 'identify', get label() { return tr("识别与调用") } }
]

const projectLauncher=useProjectLaunch()
const insightQueue=useDocumentInsights()
const insightRuns=computed(()=>activeModule.value==='document'?insightQueue.runs.value:[])
const activeInsights=computed(()=>insightRuns.value.filter(run=>['queued','running'].includes(run.status)))
onMounted(()=>insightQueue.initialize())
const projectRuns=computed(()=>activeModule.value==='project'?projectLauncher.runs.value.slice(0,40):[])
const activeProjectRuns=computed(()=>projectRuns.value.filter(run=>['starting','running','stopping'].includes(run.status)))
const projectRunLabels={get starting() { return tr('正在启动') },get running() { return tr('运行中') },get stopping() { return tr('正在停止') },get exited() { return tr('已结束') },get failed() { return tr('失败') },get interrupted() { return tr('上次中断') }}
function showProjectRuns(){closePanel();projectLauncher.showRuns.value=true}
const center = useTaskCenter(() => activeModule.value)
const { runningTasks, history } = center
const workflow = useVideoWorkflow()
const imageDownloads = useImageDownloads()
const comicIngest=useComicIngest()
const videoScan = useMediaScan('video')
const { success, toast } = useToast()
const actionError = ref('')
let privacyScope = new AbortController()
onBeforeUnmount(() => privacyScope.abort())
const router = inject(routerKey, null)
const pinia = getCurrentInstance()?.appContext.config.globalProperties.$pinia
const settings = pinia ? useSettingsStore(pinia) : null
const privateHidden = computed(() => !workflow.privacyReady.value || workflow.hideHentai.value)
watch(() => settings?.loaded ? settings.settings : null, value => {
  if (value) workflow.applyPreferences(value)
}, { immediate: true, deep: true, flush: 'sync' })
const downloadJobs = computed(() => activeModule.value === 'video' ? workflow.jobs.value : [])
const imageJobs = computed(() => activeModule.value === 'image' ? [...imageDownloads.jobs.value,...comicIngest.jobs.value] : [])
const activeImageJobs = computed(() => activeModule.value === 'image' ? [...imageDownloads.active.value,...comicIngest.active.value] : [])
const imageAttention = computed(() => activeModule.value === 'image' ? imageDownloads.attention.value.length+comicIngest.attention.value.length : 0)
const activeJob = (job: VideoDownloadJob) => job.status === 'running' || job.status === 'queued'
const needsAttention = (job: VideoDownloadJob) => !activeJob(job) && (videoJobRetryStages(job).length > 0 || job.status === 'failed')
const runningDownloads = computed(() => downloadJobs.value.filter(job => job.status === 'running').length + activeImageJobs.value.filter(j=>j.status==='running').length)
const runningCount = computed(() => center.runningCount.value + runningDownloads.value + activeProjectRuns.value.length + activeInsights.value.length)
const queuedCount = computed(() => downloadJobs.value.filter(job => job.status === 'queued').length + activeImageJobs.value.filter(j=>j.status==='queued').length)
const downloadAttention = computed(() => downloadJobs.value.filter(needsAttention).length + imageAttention.value)
const failedCount = computed(() => center.attentionCount.value + downloadAttention.value)
const attentionHint = computed(() => [
  downloadAttention.value ? tr('{p0} 个下载待处理（失败或有剩余项，可重试或移除记录）', {p0: downloadAttention.value}) : '',
  center.attentionCount.value ? tr('{p0} 个任务失败、中断或有待确认项', {p0: center.attentionCount.value}) : ''
].filter(Boolean).join('；'))
const tab = ref<Tab>('tasks')
const availableTabs = computed(() => TABS.filter(t => activeModule.value === 'image' ? t.key === 'downloads'
  : activeModule.value === 'video' || t.key === 'tasks' || t.key === 'identify'))
const downloadFilter = ref<'attention' | 'all'>('attention')
const shownJobs = computed(() => downloadFilter.value === 'all' ? downloadJobs.value : downloadJobs.value.filter(job => activeJob(job) || needsAttention(job)))
const shownImageCount = computed(() => downloadFilter.value === 'all' ? imageJobs.value.length : activeImageJobs.value.length + imageAttention.value)
const hasDownloadHistory = computed(() => downloadJobs.value.length + imageJobs.value.length > 0)
const jobSections = computed(() => [
  { key: 'active', label: tr('下载队列'), jobs: shownJobs.value.filter(activeJob).sort((a, b) => a.createdAt - b.createdAt) },
  { key: 'finished', label: downloadFilter.value === 'all' ? tr("下载结果") : tr("待处理的下载"), jobs: shownJobs.value.filter(job => !activeJob(job)) }
])
const journals = ref<VideoOrganizeJournal[]>([])
const journalsLoaded = ref(false)
const journalBusy = ref(false)
const journalError = ref('')
const pendingJournals = computed(() => journals.value.filter(journal => journal.status === 'partial' || journal.status === 'running' || journal.status === 'rollback-partial').length)
const tabCounts = computed<Record<Tab, number>>(() => ({
  tasks: runningTasks.value.length + activeProjectRuns.value.length + activeInsights.value.length, downloads: downloadAttention.value + queuedCount.value + runningDownloads.value,
  organize: journalsLoaded.value ? pendingJournals.value : 0, identify: 0
}))
const retryingEntry = ref('')
watch(privateHidden, hidden => {
  center.setVideoHidden(hidden)
  privacyScope.abort(); privacyScope = new AbortController()
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
  { key: 'running', label: tr('运行中'), items: runningTasks.value },
  { key: 'history', label: tr('最近结束'), items: history.value }
])
const entryLabel = computed(() => tr('{p0}日志：{p1} 个运行中，{p2} 个排队，{p3} 个失败或待处理', {p0: identifyKindLabel.value, p1: runningCount.value, p2: queuedCount.value, p3: failedCount.value}))
const kindLabels: Record<TaskKind, string> = {
  get 'software-scan'() { return tr('软件扫描') }, get 'game-scan'() { return tr('游戏扫描') }, get 'video-scan'() { return tr('影视扫描') },
  get 'ai-identify'() { return tr('AI 识别') }, get organize() { return tr('目录整理') }, get 'hanime-verify'() { return tr('网络验证') }, get 'video-download'() { return tr('视频下载') },
  get 'video-series-download'() { return tr('系列下载') }, get 'audio-download'() { return tr('音乐下载') }
}
const statusLabels: Record<TaskStatus, string> = { get running() { return tr('进行中') }, get success() { return tr('已完成') }, get failed() { return tr('失败') }, get cancelled() { return tr('已停止 / 未完成') }, get interrupted() { return tr('应用中断 / 待处理') } }
const eventLabels: Record<TaskEventLevel, string> = { get info() { return tr('信息') }, get success() { return tr('完成') }, get warn() { return tr('提醒') }, get error() { return tr('错误') } }
const jobStatusLabels: Record<VideoDownloadJob['status'], string> = { get queued() { return tr('排队中') }, get running() { return tr('处理中') }, get success() { return tr('已完成') }, get partial() { return tr('部分完成') }, get failed() { return tr('失败') }, get cancelled() { return tr('已停止') }, get interrupted() { return tr('中断待恢复') } }
const stageLabels: Record<VideoJobStage, string> = { get pending() { return tr('待执行') }, get running() { return tr('处理中') }, get complete() { return tr('完成') }, get failed() { return tr('待重试') }, get skipped() { return tr('已跳过') } }
const retryLabels: Record<VideoJobRetry, string> = { get remaining() { return tr('仅重试剩余视频') }, get metadata() { return tr('补齐资料') }, get registration() { return tr('仅重试入库') } }
const scanStatusLabels = { get new() { return tr('新增') }, get updated() { return tr('更新') }, get skipped() { return tr('跳过') }, get review() { return tr('待确认') }, get failed() { return tr('失败') } }
const identifyKindLabel = computed(() => ({ get software() { return tr('软件') }, get game() { return tr('游戏') }, get video() { return tr('影视') }, get image() { return tr('图片') }, get project() { return tr('项目') }, get document() { return tr('资料') }, get personal() { return tr('个人') } })[activeModule.value])
const scopeNote = computed(() => activeModule.value === 'image' ? tr("仅显示图片下载、修复与连载更新记录。暂停后可继续下载。")
  : tr("仅显示{p0}模块的记录；切换顶部模块可查看对应日志。", {p0: (identifyKindLabel.value)}))
watch(activeModule, () => {
  privacyScope.abort(); privacyScope = new AbortController()
  tab.value = activeModule.value === 'image' ? 'downloads' : 'tasks'
  actionError.value = ''; expanded.value.clear(); identifyLogs.value.clear()
}, { immediate: true })

function jobStatus(job: VideoDownloadJob): string {
  return job.status === 'success' && videoJobRetryStages(job).length ? tr("部分完成") : jobStatusLabels[job.status]
}
function jobSummary(job: VideoDownloadJob): string {
  const saved = job.items.filter(item => item.transfer === 'complete').length
  return tr('已保存 {p0}/{p1} 项', {p0: saved, p1: job.items.length}) + (job.register
    ? tr(' · 已入库 {p0} 项', {p0: job.items.filter(item => item.registration === 'complete').length}) : tr(' · 仅保存文件'))
}
function openWork(id: string, edit = false): void {
  if (!id || !router) return
  closePanel(false)
  void router.push({ name: 'video-detail', params: { id }, ...(edit ? { query: { edit: '1' } } : {}) })
}
async function retryScan(task: TaskWithResults, entry: TaskScanEntry): Promise<void> {
  if (!entry.resourceId || retryingEntry.value || videoScan.running.value || privateHidden.value) return
  const { signal } = privacyScope
  retryingEntry.value = task.id + entry.path
  actionError.value = ''
  try {
    const item = await window.baoyi.video.get(entry.resourceId)
    if (signal.aborted) return
    if (!item) throw new Error(tr('作品不可用，请重新扫描来源目录'))
    const updated = await reidentifyVideo(item, false)
    if (updated && !signal.aborted) center.setScanResults(task.id, (task.scanEntries ?? []).map(value => value.path === entry.path
      ? { ...value, status: 'updated', message: tr("重新识别完成，可打开作品核对资料") } : value))
  } catch (cause) { if (!signal.aborted) actionError.value = errorMessage(cause) }
  finally { retryingEntry.value = '' }
}
async function retryUnit(dir: string): Promise<void> {
  try {
    if (!(await window.baoyi.scan.retry(dir))) { toast(tr("这个目录已经不在扫描列表里了")); return }
    success(tr("已退回待识别，到设置页「扫描与识别」点「开始识别」重跑"))
  } catch (cause) { actionError.value = errorMessage(cause) }
}

/* ------------------------------ 整理记录 ------------------------------ */
async function loadJournals(): Promise<void> {
  if (activeModule.value !== 'video' || journalBusy.value || !workflow.privacyReady.value || typeof window === 'undefined' || !window.baoyi?.videoOrganize) return
  const { signal } = privacyScope
  journalBusy.value = true
  journalError.value = ''
  try {
    const saved = await window.baoyi.videoOrganize.list()
    const visible = await filterVisibleJournals(saved, privateHidden.value)
    if (signal.aborted) return
    journals.value = visible
    journalsLoaded.value = true
  } catch (cause) { if (!signal.aborted) journalError.value = privateHidden.value ? tr("读取整理记录失败，请重试。") : errorMessage(cause) }
  finally { journalBusy.value = false }
}
async function recoverJournal(id: string, action: 'retry' | 'rollback'): Promise<void> {
  if (journalBusy.value || !journals.value.some(journal => journal.id === id && (action === 'retry' ? journal.canRetry : journal.canRollback))) return
  const { signal } = privacyScope
  journalBusy.value = true
  journalError.value = ''
  try {
    const journal = await window.baoyi.videoOrganize[action](id)
    if (signal.aborted) return
    journals.value = [journal, ...journals.value.filter(value => value.id !== journal.id)].sort((a, b) => b.updatedAt - a.updatedAt)
  } catch (cause) { if (!signal.aborted) journalError.value = errorMessage(cause) }
  finally { journalBusy.value = false }
}
function showTab(next: Tab): void {
  if (!availableTabs.value.some(t => t.key === next)) return
  tab.value = next
  if (next === 'organize' && !journalsLoaded.value) void loadJournals()
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString(appLocale.value, { hour12: false })
}
function taskProgress(task: { kind: TaskKind; processed: number; total: number }): string {
  if (task.kind === 'video-series-download') return task.total > 0 ? tr("{p0} / {p1} 集", {p0: (task.processed), p1: (task.total)}) : tr("集数待确定")
  if (task.kind !== 'video-download' && task.kind !== 'audio-download') return task.total > 0 ? `${task.processed} / ${task.total}` : tr("总数待确定")
  const received = task.processed > 0 ? formatBytes(task.processed) : '0 B'
  return task.total > 0 ? `${received} / ${formatBytes(task.total)}` : tr("{p0} / 大小未知", {p0: (received)})
}
async function togglePanel(): Promise<void> {
  if (opened.value) { closePanel(); return }
  opened.value = true
  if (activeModule.value === 'video') void workflow.refresh()
  if (activeModule.value === 'image') {void imageDownloads.refresh();void comicIngest.refresh()}
  if (tab.value === 'organize') void loadJournals()
  await nextTick()
  if (opened.value) closeButton.value?.focus()
}
function closePanel(restoreFocus = true): void {
  opened.value = false
  if (restoreFocus) trigger.value?.focus()
}
watch(comicIngest.showRecords,show=>{if(show){comicIngest.showRecords.value=false;tab.value='downloads';downloadFilter.value='all';if(!opened.value)void togglePanel()}})
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
  } catch (cause) { actionError.value = tr("清除历史失败：") + errorMessage(cause) }
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
      <span>{{ $t("日志") }}</span>
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
              <h2 id="task-center-title">{{ $t("{p0}日志", {p0: (identifyKindLabel)}) }}</h2>
              <p id="task-center-note">{{ attentionHint || scopeNote }}</p>
            </div>
            <button v-if="tab === 'tasks'" type="button" class="task-panel__clear" :disabled="clearing || history.length === 0" :title="$t('清除当前可见的扫描、识别等历史；运行中任务与下载记录继续保留')" @click="clearHistory">
              <Trash2 :size="13" />{{ $t("清除历史") }}</button>
            <button ref="closeButton" type="button" class="task-panel__close" :title="$t('关闭日志面板')" :aria-label="$t('关闭日志面板')" @click="closePanel()">
              <X :size="16" />
            </button>
          </header>
          <nav class="task-tabs no-select" :aria-label="$t('日志类别')">
            <button v-for="item in availableTabs" :key="item.key" type="button" :aria-current="tab === item.key ? 'page' : undefined" @click="showTab(item.key)">
              {{ item.label }}<span v-if="tabCounts[item.key]" class="task-tabs__count" :class="{ 'task-tabs__count--warn': item.key === 'downloads' && downloadAttention > 0 || item.key === 'organize' }">{{ tabCounts[item.key] }}</span>
            </button>
          </nav>

          <div class="task-panel__body">
            <p v-if="actionError || activeModule === 'video' && workflow.jobsError.value" class="task-card__error" role="alert">{{ actionError || workflow.jobsError.value }}</p>
            <template v-if="tab === 'tasks'">
              <div v-if="runningTasks.length === 0 && history.length === 0 && projectRuns.length === 0 && insightRuns.length===0" class="task-panel__empty">
                <ScrollText :size="30" :stroke-width="1.3" />
                <h3>{{ $t("暂无任务") }}</h3>
                <p>{{ $t("{p0}模块的任务进度和历史会显示在这里。", {p0: (identifyKindLabel)}) }}<template v-if="activeModule === 'video'">{{ $t("下载在「下载记录」页签。") }}</template></p>
              </div>
              <section v-if="insightRuns.length" class="task-group" :aria-label="$t('资料精读任务')"><h3 class="task-group__heading">{{ $t("资料精读") }}<span>{{insightRuns.length}}</span></h3><article v-for="run in insightRuns" :key="run.id" class="task-card"><div class="task-card__head"><h4>{{run.name}}</h4><span class="task-card__status">{{ $systemMessage(run.phase) }}</span></div><p v-if="run.error" class="task-card__error">{{ $systemMessage(run.error) }}</p><div class="task-card__actions"><button v-if="['queued','running'].includes(run.status)" @click="insightQueue.cancel(run.id)">{{ $t("停止精读") }}</button><button v-else @click="insightQueue.open([run.documentId]);closePanel()">{{ $t("重新精读") }}</button></div></article></section>
              <section v-if="projectRuns.length" class="task-group" :aria-label="$t('项目命令运行')"><h3 class="task-group__heading">{{ $t("项目命令") }}<span>{{projectRuns.length}}</span></h3><article v-for="run in projectRuns" :key="run.id" class="task-card"><div class="task-card__head"><h4>{{run.profileName}}</h4><span class="task-card__status">{{projectRunLabels[run.status]}}</span></div><p class="task-card__meta">{{ $t("{p0} · 仅保留本机运行记录", {p0: (new Date(run.startedAt).toLocaleString($locale))}) }}</p><p v-if="run.error" class="task-card__error">{{ $systemMessage(run.error) }}</p><div class="task-card__actions"><button type="button" @click="showProjectRuns">{{ $t("查看输出与运行详情") }}</button></div></article></section>
              <template v-for="section in sections" :key="section.key">
                <section v-if="section.items.length" class="task-group" :aria-label="section.label">
                  <h3 class="task-group__heading">{{ section.label }}<span>{{ section.items.length }}</span></h3>
                  <article v-for="task in section.items" :key="task.id" class="task-card" :class="`task-card--${task.status}`">
                    <div class="task-card__head">
                      <Loader2 v-if="task.status === 'running'" :size="16" class="task-spin task-card__icon" />
                      <Check v-else-if="task.status === 'success'" :size="16" class="task-card__icon" />
                      <CircleAlert v-else-if="task.status === 'failed'" :size="16" class="task-card__icon" />
                      <Minus v-else :size="16" class="task-card__icon" />
                      <h4>{{ $systemMessage(task.title) }}</h4>
                      <span class="task-card__status">{{ statusLabels[task.status] }}</span>
                    </div>
                    <div class="task-card__meta">
                      <span>{{ kindLabels[task.kind] }}</span>
                      <span :title="new Date(task.startedAt).toLocaleString($locale)">{{ $t("{p0} 开始", {p0: (time(task.startedAt))}) }}</span>
                      <span v-if="task.finishedAt" :title="new Date(task.finishedAt).toLocaleString($locale)">{{ $t("{p0} 结束", {p0: (time(task.finishedAt))}) }}</span>
                      <span v-if="task.status === 'success' && task.events.some(e => e.level === 'warn')" class="task-card__warning">{{ $t("有提醒") }}</span>
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
                    <p v-if="task.message" class="task-card__message">{{ $systemMessage(task.message) }}</p>
                    <p v-if="task.current" class="task-card__current" :title="task.current">{{ task.current }}</p>
                    <p v-if="task.error" class="task-card__error">{{ $systemMessage(task.error) }}</p>
                    <details v-if="task.scanEntries?.length" class="task-scan-results">
                      <summary>{{ $t("逐项结果 · {p0}", {p0: (task.scanEntries.length)}) }}</summary>
                      <ul>
                        <li v-for="(entry, index) in task.scanEntries" :key="index">
                          <strong>{{ scanStatusLabels[entry.status] }}</strong><span class="mono">{{ entry.path }}</span><p>{{ $systemMessage(entry.message) }}</p>
                          <div v-if="entry.resourceId && task.kind === 'video-scan'" class="task-card__actions">
                            <button type="button" @click="openWork(entry.resourceId, entry.status === 'review')">{{ entry.status === 'review' ? $t('修正资料') : $t('打开作品') }}</button>
                            <button v-if="entry.status === 'failed' || entry.status === 'review'" type="button" :disabled="!!retryingEntry || videoScan.running.value" @click="retryScan(task, entry)">{{ $t("重新识别此作品") }}</button>
                          </div>
                          <small v-else-if="entry.status === 'failed' || entry.status === 'review'">{{ $t("尚无作品记录，请检查来源目录后重新扫描。") }}</small>
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
                      {{ expanded.has(task.id) ? $t('收起日志') : $t('查看日志') }} · {{ task.events.length }}
                    </button>
                    <ol v-if="expanded.has(task.id)" :id="`${task.id}-events`" class="task-events">
                      <li v-for="(event, index) in task.events" :key="index" :class="`task-event--${event.level}`">
                        <time>{{ time(event.at) }}</time><span class="task-events__level">{{ eventLabels[event.level] }}</span><span>{{ $systemMessage(event.message) }}</span>
                      </li>
                    </ol>
                    <details v-if="identifyKind(task) && task.status !== 'running'" class="task-identify" @toggle="toggleIdentifyLogs(task.id, $event)">
                      <summary>{{ $t("查看识别日志") }}</summary>
                      <IdentifyLog v-if="identifyLogs.has(task.id)" :resource-kind="identifyKind(task)" :since="task.startedAt" :until="task.finishedAt" />
                    </details>
                  </article>
                </section>
              </template>
            </template>

            <div v-else-if="tab === 'downloads'" class="task-panel__downloads" :aria-label="$t('下载记录')">
              <div class="task-filter">
                <label>{{ $t("显示") }}<select v-model="downloadFilter" class="select" :aria-label="$t('下载记录范围')"><option value="attention">{{ $t("待处理") }}</option><option value="all">{{ $t("全部") }}</option></select></label>
                <span>{{ downloadFilter === 'all' ? $t('共 {p0} 条', {p0: downloadJobs.length + imageJobs.length}) : $t('{p0} 条待处理', {p0: downloadAttention}) }}</span>
              </div>
              <ComicDownloadList v-if="activeModule === 'image'" :filter="downloadFilter" />

              <div v-if="!shownJobs.length && !shownImageCount" class="task-panel__empty">
                <Check v-if="hasDownloadHistory" :size="30" :stroke-width="1.3" />
                <ScrollText v-else :size="30" :stroke-width="1.3" />
                <h3>{{ hasDownloadHistory ? $t('没有待处理的下载') : $t('暂无下载记录') }}</h3>
                <p>{{ hasDownloadHistory ? $t('切到「全部」能看到已完成的记录。') : activeModule === 'image' ? $t('从在线漫画添加哔咔或 JM 作品后，进度和结果会显示在这里。') : $t('添加下载任务后，进度和结果会显示在这里。') }}</p>
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
                    <p v-if="job.message" class="task-card__message">{{ $systemMessage(job.message) }}</p>
                    <p v-for="item in job.items.filter(value => value.transfer === 'running')" :key="'progress-'+item.videoCode" class="task-card__message" role="status">
                      {{ $t("{p0} · {p1} · 已接收 {p2}", {p0: (item.title || item.videoCode), p1: (item.transferMessage || $t('正在连接来源')), p2: (item.receivedBytes > 0 ? formatBytes(item.receivedBytes) : '0 B')}) }}<template v-if="item.totalBytes > 0"> / {{ formatBytes(item.totalBytes) }}（{{ Math.min(100, Math.floor(item.receivedBytes * 100 / item.totalBytes)) }}%）</template><template v-if="item.bytesPerSecond"> · {{ formatBytes(item.bytesPerSecond) }}/s</template>
                    </p>
                    <div class="task-card__actions">
                      <button v-if="job.resourceId" type="button" @click="openWork(job.resourceId)"><ExternalLink :size="13" />{{ $t("打开作品") }}</button>
                      <button v-if="job.directory" type="button" :disabled="workflow.actionIds.value.has(job.id)" @click="workflow.reveal(job.id)"><FolderOpen :size="13" />{{ $t("打开目录") }}</button>
                      <button v-if="activeJob(job)" type="button" :disabled="workflow.actionIds.value.has(job.id)" @click="workflow.cancel(job.id)"><Square :size="12" />{{ job.status === 'queued' ? $t('取消排队') : $t('停止下载') }}</button>
                      <button v-for="stage in videoJobRetryStages(job)" :key="stage" type="button" :disabled="workflow.actionIds.value.has(job.id)" @click="workflow.retry(job.id, stage)"><RefreshCw :size="13" />{{ retryLabels[stage] }}</button>
                      <span v-if="!activeJob(job)" class="hint">{{ $t("缓存管理：右上角设置 → 影视 → 下载与缓存") }}</span>
                      <button v-if="!activeJob(job)" type="button" class="task-card__dismiss" :title="$t('只移除记录，文件和作品都保留；如需释放分片空间，请先查看下载缓存')" :disabled="workflow.actionIds.value.has(job.id)" @click="workflow.dismiss(job.id)"><Trash2 :size="12" />{{ $t("移除记录") }}</button>
                    </div>
                    <details class="task-download-items">
                      <summary>{{ $t("查看 {p0} 项的下载、资料和入库结果", {p0: (job.items.length)}) }}</summary>
                      <ul>
                        <li v-for="item in job.items" :key="item.videoCode">
                          <strong>{{ item.title || item.videoCode }}</strong>
                          <span>{{ $t("视频：{p0} · 资料：{p1} · 入库：{p2}", {p0: (stageLabels[item.transfer]), p1: (stageLabels[item.metadata]), p2: (job.register ? stageLabels[item.registration] : $t('仅保存文件'))}) }}</span>
                          <span v-if="item.transfer === 'running'">{{ $t("{p0} · 已接收 {p1}{p2}", {p0: (item.transferMessage || $t('正在下载')), p1: (formatBytes(item.receivedBytes)), p2: (item.totalBytes > 0 ? ' / ' + formatBytes(item.totalBytes) : $t(' · 大小未知'))}) }}<template v-if="item.bytesPerSecond"> · {{ formatBytes(item.bytesPerSecond) }}/s</template></span>
                          <span v-if="item.sourceLabel">{{ $t("实际清晰度：{p0}", {p0: (item.sourceLabel)}) }}</span>
                          <p v-if="item.error" class="task-card__error">{{ $systemMessage(item.error) }}</p>
                          <p v-for="warning in item.warnings" :key="warning" class="task-card__warning">{{ $systemMessage(warning) }}</p>
                        </li>
                      </ul>
                      <p v-for="warning in job.warnings" :key="warning" class="task-card__warning">{{ $systemMessage(warning) }}</p>
                    </details>
                  </article>
                </section>
              </template>
            </div>

            <div v-else-if="tab === 'organize'" class="task-panel__organize">
              <p v-if="journalError" class="task-card__error" role="alert">{{ journalError }}</p>
              <p v-if="journalBusy" class="task-panel__hint" role="status"><Loader2 :size="13" class="task-spin" />{{ $t("正在读取整理记录…") }}</p>
              <OrganizeHistory :journals="journals" :loaded="journalsLoaded" :busy="journalBusy" @refresh="loadJournals" @retry="id => recoverJournal(id, 'retry')" @rollback="id => recoverJournal(id, 'rollback')" />
            </div>

            <div v-else class="task-panel__identify">
              <p class="task-panel__hint">{{ $t("当前看的是「{p0}」模块的识别日志；切换顶栏模块就换一份。设置页「识别日志」页签里也有同一份。", {p0: (identifyKindLabel)}) }}</p>
              <IdentifyLog :key="activeModule" :resource-kind="activeModule" @retry="retryUnit" />
              <SearchCallLog :key="activeModule" :resource-kind="activeModule" />
            </div>
          </div>
          <footer class="task-panel__footer">{{ activeModule === 'image' || activeModule === 'video' ? $t('下载记录独立保留；移除记录只删记录，不删文件。') : $t('任务记录共保留最近 30 项，每项 100 条事件。清除历史只影响当前模块。') }}</footer>
        </section>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.task-center { flex-shrink:0;white-space:nowrap;display: flex; align-items: center; margin-left: auto; padding: 0 12px; -webkit-app-region: no-drag; }
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
@media(max-width:1050px){.task-center{padding-inline:4px}.task-trigger{padding-inline:5px}}
@media (max-width: 540px) { .task-center { padding: 0 4px; } .task-trigger { padding: 0 5px; } .task-panel__header { gap: 5px; padding: 12px; } .task-panel__clear { font-size: 10px; } .task-tabs { gap: 10px; padding-inline: 12px; } }
</style>
