<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDownToLine, CheckCircle2, Download, FolderOpen, Loader2, RefreshCw, X } from 'lucide-vue-next'
import { useVideoDownload } from '@/composables/useVideoDownload'
import { formatBytes } from '@/utils'
import { useVideoStore } from '@/stores/video'

const props = defineProps<{ id: string; hanimeId: string }>()
const download = useVideoDownload(props.id)
const store = useVideoStore()
const {
  catalog, selectedSourceId, resolving, downloading, cancelling, progress, result, error, path
} = download
const selectedSource = computed(() => catalog.value?.sources.find(source => source.id === selectedSourceId.value) ?? null)
const percent = computed(() => progress.value.totalBytes > 0
  ? Math.min(100, Math.floor(progress.value.receivedBytes * 100 / progress.value.totalBytes)) : 0)
const statusText = computed(() => {
  if (resolving.value) return '正在读取播放器信息…'
  if (cancelling.value) return '正在取消并清理临时文件…'
  if (downloading.value) return progress.value.message || '正在下载…'
  if (result.value?.status === 'success') return '下载完成，已归档并入库'
  if (result.value?.status === 'cancelled') return result.value.message
  return error.value || '先解析播放器以获取可下载清晰度'
})
const displayTitle = computed(() => catalog.value?.title || '尚未解析站点标题')
const displayCode = computed(() => catalog.value?.videoCode || props.hanimeId)
const warnings = computed(() => [...new Set([...(catalog.value?.warnings ?? []), ...(result.value?.warnings ?? [])])])

function bytes(value: number): string { return value > 0 ? formatBytes(value) : '0 B' }
function speed(value: number): string { return `${bytes(value)}/秒` }
async function resolve(): Promise<void> { await download.resolve() }
async function start(): Promise<void> {
  const result = await download.download()
  if (result?.status === 'success') await store.reload()
}
async function cancel(): Promise<void> { await download.cancel() }
async function reveal(): Promise<void> { await download.reveal() }
</script>

<template>
  <div class="single-download">
    <div class="single-download__head">
      <div>
        <h2 class="sec-title">单集下载</h2>
        <p class="single-download__note">仅保存视频文件，不改动本地条目、海报或观看状态。</p>
      </div>
      <button
        type="button"
        class="btn btn--subtle"
        :disabled="resolving || downloading"
        :title="catalog ? '重新读取播放器清晰度' : '读取播放器清晰度'"
        @click="resolve"
      >
        <Loader2 v-if="resolving" :size="14" class="spin" />
        <RefreshCw v-else :size="14" />
        {{ catalog ? '重新解析' : '解析清晰度' }}
      </button>
    </div>

    <dl class="single-download__facts">
      <dt>站点标题</dt><dd :title="displayTitle">{{ displayTitle }}</dd>
      <dt>站点编号</dt><dd>{{ displayCode }}</dd>
    </dl>

    <div v-if="catalog" class="single-download__controls">
      <label class="single-download__select">
        <span>清晰度</span>
        <select v-model="selectedSourceId" :disabled="downloading">
          <option v-for="source in catalog.sources" :key="source.id" :value="source.id">
            {{ source.label }} .{{ source.extension.toUpperCase() }}
          </option>
        </select>
      </label>
      <button type="button" class="btn btn--primary" :disabled="!selectedSource || downloading" @click="start">
        <Download :size="14" />
        另存为并下载
      </button>
    </div>

    <div v-if="warnings.length" class="single-download__warnings">
      <ArrowDownToLine :size="14" />
      <span v-for="warning in warnings" :key="warning">{{ warning }}</span>
    </div>

    <div v-if="downloading || result" class="single-download__progress">
      <div class="single-download__progress-head">
        <span>{{ statusText }}</span>
        <span v-if="progress.totalBytes > 0">{{ percent }}%</span>
      </div>
      <div class="single-download__bar" :class="{ 'single-download__bar--unknown': progress.totalBytes === 0 }">
        <i :style="progress.totalBytes > 0 ? { width: `${percent}%` } : undefined" />
      </div>
      <div class="single-download__meta">
        <span>{{ bytes(progress.receivedBytes) }} / {{ progress.totalBytes > 0 ? bytes(progress.totalBytes) : '大小未知' }}</span>
        <span>{{ speed(progress.bytesPerSecond) }}</span>
      </div>
      <div class="single-download__actions">
        <button v-if="downloading" type="button" class="btn btn--ghost" :disabled="cancelling" @click="cancel">
          <Loader2 v-if="cancelling" :size="14" class="spin" />
          <X v-else :size="14" />
          {{ cancelling ? '正在取消…' : '取消下载' }}
        </button>
        <button v-if="result?.status === 'success' && path" type="button" class="btn btn--ghost" @click="reveal">
          <FolderOpen :size="14" />
          打开所在位置
        </button>
        <CheckCircle2 v-if="result?.status === 'success'" :size="16" class="single-download__ok" />
      </div>
    </div>

    <p v-if="error && !downloading" class="single-download__error">{{ error }}</p>
</div>
</template>

<style scoped>
.single-download { display: flex; flex-direction: column; gap: 12px; }
.single-download__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.single-download__note { margin: -3px 0 0; color: var(--text-faint); font-size: var(--fs-tag); line-height: 1.55; }
.single-download__facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: var(--fs-tag); }
.single-download__facts dt { color: var(--text-faint); white-space: nowrap; }
.single-download__facts dd { min-width: 0; margin: 0; overflow: hidden; color: var(--text-sub); text-overflow: ellipsis; white-space: nowrap; }
.single-download__controls { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 10px; }
.single-download__select { display: flex; min-width: 150px; flex: 1; flex-direction: column; gap: 5px; color: var(--text-faint); font-size: var(--fs-tag); }
.single-download__select select { height: 30px; min-width: 0; padding: 0 8px; border: 1px solid var(--divider); border-radius: var(--radius-btn); background: var(--bg-main); color: var(--text-main); }
.single-download__warnings { display: flex; align-items: flex-start; gap: 7px; color: var(--warning, #c88726); font-size: var(--fs-tag); line-height: 1.55; }
.single-download__progress { display: flex; flex-direction: column; gap: 7px; padding-top: 2px; }
.single-download__progress-head, .single-download__meta, .single-download__actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.single-download__progress-head { color: var(--text-sub); font-size: var(--fs-tag); }
.single-download__bar { height: 5px; overflow: hidden; border-radius: 5px; background: var(--active-surface); }
.single-download__bar i { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width var(--t-fast) ease; }
.single-download__bar--unknown i { width: 35%; animation: single-download-indeterminate 1.5s ease-in-out infinite; }
.single-download__meta { color: var(--text-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.single-download__actions { justify-content: flex-start; }
.single-download__ok { margin-left: auto; color: var(--success, #4d9b72); }
.single-download__error { margin: 0; color: var(--danger, #c65c5c); font-size: var(--fs-tag); line-height: 1.55; overflow-wrap: anywhere; }
@keyframes single-download-indeterminate { 0% { transform: translateX(-120%); } 100% { transform: translateX(300%); } }
@media (max-width: 560px) { .single-download__head { align-items: stretch; flex-direction: column; } .single-download__head > .btn { align-self: flex-start; } }
@media (prefers-reduced-motion: reduce) { .single-download__bar--unknown i { animation: none; } }
</style>
