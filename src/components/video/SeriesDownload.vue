<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDownToLine, CheckCircle2, CircleAlert, Download, FolderOpen, Loader2, RefreshCw, X } from 'lucide-vue-next'
import { useVideoSeriesDownload } from '@/composables/useVideoSeriesDownload'
import { formatBytes } from '@/utils'
import { useVideoStore } from '@/stores/video'

const props = defineProps<{ id: string; hanimeId: string }>()
const series = useVideoSeriesDownload(props.id)
const store = useVideoStore()
const {
  catalog, sourceLabel, selectedVideoCodes, queuedVideoCodes, episodeResults, processedCount,
  resolving, downloading, cancelling, progress, result, error
} = series

const allSelected = computed({
  get: () => !!catalog.value?.episodes.length && selectedVideoCodes.value.length === catalog.value.episodes.length,
  set: (checked: boolean) => { selectedVideoCodes.value = checked ? catalog.value?.episodes.map(episode => episode.videoCode) ?? [] : [] }
})
const rows = computed(() => {
  const outcomes = new Map(episodeResults.value.map(episode => [episode.videoCode, episode]))
  return (catalog.value?.episodes ?? episodeResults.value).map(episode => {
    const outcome = outcomes.get(episode.videoCode)
    const current = downloading.value && progress.value.episodeIndex > 0 && progress.value.videoCode === episode.videoCode
    const status = outcome?.status ?? (current ? 'running' : 'pending')
    const label = outcome ? { success: '已完成', failed: '失败', skipped: '已存在', cancelled: '已取消' }[outcome.status]
      : current ? (progress.value.phase === 'resolving' ? '解析中' : '下载中')
        : result.value && queuedVideoCodes.value.includes(episode.videoCode) ? '未开始'
          : selectedVideoCodes.value.includes(episode.videoCode) ? '待下载' : '未选择'
    return { ...episode, title: outcome?.title || episode.title, outcome, status, label }
  })
})

const qualityOptions = [
  { value: '', label: '自动选择最高可用' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
  { value: '360p', label: '360p' }
]

const queuePercent = computed(() => {
  const total = progress.value.episodeTotal
  if (!total) return 0
  return Math.min(100, Math.floor(processedCount.value * 100 / total))
})
const currentBytePercent = computed(() => progress.value.totalBytes > 0
  ? Math.min(100, Math.floor(progress.value.receivedBytes * 100 / progress.value.totalBytes)) : 0)
const currentText = computed(() => {
  if (progress.value.episodeIndex <= 0) return '等待选择保存目录'
  return `第 ${progress.value.episodeIndex}/${progress.value.episodeTotal} 集 · ${progress.value.title}`
})
const statusText = computed(() => {
  if (resolving.value) return '正在读取系列播放清单…'
  if (cancelling.value) return '正在取消并等待当前集收尾…'
  if (downloading.value) return progress.value.message || currentText.value
  if (result.value?.status === 'success') return '系列下载完成，已归档并入库'
  if (result.value?.status === 'cancelled') return result.value.message
  if (result.value?.status === 'failed') return result.value.message
  return error.value || '先解析系列播放清单'
})
const displayTitle = computed(() => catalog.value?.title || '尚未解析站点系列')
const displayCode = computed(() => catalog.value?.videoCode || props.hanimeId)
const warnings = computed(() => [...new Set([
  ...(catalog.value?.warnings ?? []), ...episodeResults.value.flatMap(episode => episode.warnings), ...(result.value?.warnings ?? [])
])])
const resultSummary = computed(() => {
  const value = result.value
  if (!value) return ''
  const remaining = Math.max(0, value.total - value.completed - value.failed - value.skipped)
  return `完成 ${value.completed} · 失败 ${value.failed} · 跳过 ${value.skipped}${remaining ? ` · 未完成 ${remaining}` : ''}${value.fallback ? ` · 清晰度回退 ${value.fallback}` : ''}`
})

async function resolve(): Promise<void> { await series.resolve() }
async function start(): Promise<void> {
  const result = await series.download(sourceLabel.value)
  if (result?.completed) await store.reload()
}
async function cancel(): Promise<void> { await series.cancel() }
async function reveal(): Promise<void> { await series.reveal() }
async function retry(): Promise<void> { await series.retryFailed() }
</script>

<template>
  <div class="series-download">
    <div class="series-download__head">
      <div>
        <h2 class="sec-title">系列下载</h2>
      </div>
      <button
        type="button"
        class="btn btn--subtle"
        :disabled="resolving || downloading"
        :title="catalog ? '重新读取系列播放清单' : '读取系列播放清单'"
        @click="resolve"
      >
        <Loader2 v-if="resolving" :size="14" class="spin" />
        <RefreshCw v-else :size="14" />
        {{ catalog ? '重新解析' : '解析系列' }}
      </button>
    </div>

    <dl class="series-download__facts">
      <dt>站点标题</dt><dd :title="displayTitle">{{ displayTitle }}</dd>
      <dt>站点编号</dt><dd>{{ displayCode }}</dd>
      <template v-if="catalog">
        <dt>实际集数</dt><dd>{{ catalog.episodes.length }} 集</dd>
      </template>
    </dl>

    <div v-if="catalog" class="series-download__controls">
      <label class="series-download__select">
        <span>目标清晰度</span>
        <select v-model="sourceLabel" :disabled="downloading || resolving">
          <option v-for="option in qualityOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <button type="button" class="btn btn--primary" :disabled="downloading || resolving || !selectedVideoCodes.length" @click="start">
        <Download :size="14" />
        选择目录并下载
      </button>
    </div>

    <div v-if="catalog" class="series-download__selection">
      <label>
        <input v-model="allSelected" type="checkbox" :indeterminate="selectedVideoCodes.length > 0 && !allSelected" :disabled="downloading || resolving">
        <span>全选</span>
      </label>
      <span>已选 {{ selectedVideoCodes.length }} / {{ catalog.episodes.length }} 集</span>
    </div>
    <ul v-if="rows.length" class="series-download__episodes" aria-label="系列集数与下载结果">
      <li v-for="row in rows" :key="row.videoCode" :class="`series-download__episode--${row.status}`">
        <label class="series-download__episode-title">
          <input v-model="selectedVideoCodes" type="checkbox" :value="row.videoCode" :disabled="downloading || resolving || !catalog">
          <span>{{ row.title }} <small>[{{ row.videoCode }}]</small></span>
        </label>
        <span class="series-download__episode-status" :title="row.outcome?.path || row.outcome?.message">{{ row.label }}</span>
        <p v-if="row.outcome" class="series-download__episode-message">
          <span v-if="row.outcome.sourceLabel">{{ row.outcome.sourceLabel }} · </span>{{ row.outcome.message }}
        </p>
      </li>
    </ul>

    <div v-if="warnings.length" class="series-download__warnings">
      <ArrowDownToLine :size="14" />
      <ul><li v-for="warning in warnings" :key="warning">{{ warning }}</li></ul>
    </div>

    <div v-if="downloading || result" class="series-download__progress">
      <div class="series-download__progress-head">
        <span>{{ statusText }}</span>
        <span v-if="progress.episodeTotal" class="series-download__count">{{ processedCount }}/{{ progress.episodeTotal }} 集</span>
      </div>
      <div class="series-download__bar" :class="{ 'series-download__bar--unknown': downloading && progress.episodeTotal === 0 }"
        role="progressbar" aria-label="系列处理进度" :aria-valuemin="0" :aria-valuemax="100"
        :aria-valuenow="progress.episodeTotal > 0 ? queuePercent : undefined" :aria-valuetext="`${processedCount}/${progress.episodeTotal} 集`">
        <i :style="progress.episodeTotal > 0 ? { width: `${queuePercent}%` } : undefined" />
      </div>
      <div v-if="downloading && progress.episodeIndex > 0" class="series-download__current">
        <span>{{ currentText }}</span><span v-if="progress.totalBytes > 0" class="series-download__count">{{ currentBytePercent }}%</span>
      </div>
      <div v-if="downloading && progress.episodeIndex > 0" class="series-download__bytes">
        <span>{{ formatBytes(progress.receivedBytes) }} / {{ progress.totalBytes > 0 ? formatBytes(progress.totalBytes) : '大小未知' }}</span>
        <span>{{ formatBytes(progress.bytesPerSecond) }}/秒</span>
      </div>
      <div v-if="result" class="series-download__result" :class="`series-download__result--${result.status}`">
        <CheckCircle2 v-if="result.status === 'success'" :size="15" />
        <CircleAlert v-else :size="15" />
        <span>{{ resultSummary }}</span>
      </div>
      <div class="series-download__actions">
        <button v-if="downloading" type="button" class="btn btn--ghost" :disabled="cancelling" @click="cancel">
          <Loader2 v-if="cancelling" :size="14" class="spin" />
          <X v-else :size="14" />
          {{ cancelling ? '正在取消…' : '取消系列下载' }}
        </button>
        <button v-if="result?.path" type="button" class="btn btn--ghost" @click="reveal">
          <FolderOpen :size="14" />
          打开保存目录
        </button>
        <button v-if="result?.failed" type="button" class="btn btn--ghost" :disabled="downloading || resolving" @click="retry">
          <RefreshCw :size="14" />重试失败集
        </button>
      </div>
    </div>

    <p v-if="resolving" class="series-download__current" role="status">{{ statusText }}</p>
    <p v-if="error" class="series-download__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.series-download { display: flex; min-width: 0; flex-direction: column; gap: 12px; }
.series-download__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.series-download__facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: var(--fs-tag); }
.series-download__facts dt { color: var(--text-faint); white-space: nowrap; }
.series-download__facts dd { min-width: 0; margin: 0; overflow: hidden; color: var(--text-sub); text-overflow: ellipsis; white-space: nowrap; }
.series-download__controls { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 10px; }
.series-download__select { display: flex; min-width: 170px; flex: 1; flex-direction: column; gap: 5px; color: var(--text-faint); font-size: var(--fs-tag); }
.series-download__select select { height: 30px; min-width: 0; padding: 0 8px; border: 1px solid var(--divider); border-radius: var(--radius-btn); background: var(--bg-main); color: var(--text-main); }
.series-download__warnings { display: flex; align-items: flex-start; gap: 7px; color: var(--warning, #c88726); font-size: var(--fs-tag); line-height: 1.55; }
.series-download__warnings > svg { flex: none; margin-top: 2px; }
.series-download__warnings ul { min-width: 0; margin: 0; padding: 0; list-style: none; overflow-wrap: anywhere; }
.series-download__selection, .series-download__selection label { display: flex; align-items: center; gap: 8px; }
.series-download__selection { justify-content: space-between; color: var(--text-sub); font-size: var(--fs-tag); }
.series-download input[type=checkbox] { flex: none; width: 14px; height: 14px; margin: 0; accent-color: var(--accent); }
.series-download__episodes { max-height: 340px; overflow-y: auto; margin: 0; padding: 0; list-style: none; border-block: 1px solid var(--divider); }
.series-download__episodes li { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 10px; padding: 9px 0; min-height: 36px; font-size: var(--fs-tag); }
.series-download__episodes li + li { border-top: 1px solid var(--divider); }
.series-download__episode-title { display: flex; align-items: flex-start; min-width: 0; gap: 8px; color: var(--text-sub); line-height: 1.5; overflow-wrap: anywhere; }
.series-download__episode-title input { margin-top: 2px !important; }
.series-download__episode-title small { color: var(--text-faint); font-size: 11px; }
.series-download__episode-status { align-self: start; color: var(--text-faint); line-height: 1.5; white-space: nowrap; }
.series-download__episode--success .series-download__episode-status { color: var(--success, #4d9b72); }
.series-download__episode--failed .series-download__episode-status { color: var(--danger, #c65c5c); }
.series-download__episode--running .series-download__episode-status { color: var(--accent); }
.series-download__episode-message { grid-column: 1 / -1; margin: 4px 0 0 22px; color: var(--text-faint); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.series-download__episode--failed .series-download__episode-message { color: var(--danger, #c65c5c); }
.series-download__progress { display: flex; flex-direction: column; gap: 7px; padding-top: 2px; }
.series-download__progress-head, .series-download__current, .series-download__actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.series-download__progress-head { color: var(--text-sub); font-size: var(--fs-tag); }
.series-download__progress-head > span:first-child, .series-download__current > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.series-download__count { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
.series-download__bytes { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 10px; color: var(--text-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.series-download__bar { height: 5px; overflow: hidden; border-radius: 5px; background: var(--active-surface); }
.series-download__bar i { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width var(--t-fast) ease; }
.series-download__bar--unknown i { width: 35%; animation: series-download-indeterminate 1.5s ease-in-out infinite; }
.series-download__current { color: var(--text-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.series-download__result { display: flex; align-items: flex-start; gap: 7px; color: var(--text-sub); font-size: var(--fs-tag); line-height: 1.5; }
.series-download__result > svg { flex: none; }
.series-download__result--success { color: var(--success, #4d9b72); }
.series-download__result--failed, .series-download__result--cancelled { color: var(--warning, #c88726); }
.series-download__actions { justify-content: flex-start; flex-wrap: wrap; }
.series-download__error { margin: 0; color: var(--danger, #c65c5c); font-size: var(--fs-tag); line-height: 1.55; overflow-wrap: anywhere; }
@keyframes series-download-indeterminate { 0% { transform: translateX(-120%); } 100% { transform: translateX(300%); } }
@media (max-width: 560px) { .series-download__head { align-items: stretch; flex-direction: column; } .series-download__head > .btn { align-self: flex-start; } }
@media (prefers-reduced-motion: reduce) { .series-download__bar--unknown i { animation: none; } }
</style>
