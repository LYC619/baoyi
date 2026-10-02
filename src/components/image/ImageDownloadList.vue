<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowDown, ArrowUp, BookOpen, Pause, Play, RotateCcw, Square, Trash2 } from 'lucide-vue-next'
import { useImageDownloads } from '@/composables/useImageDownloads'
import { useRouter } from 'vue-router'
import { formatBytes } from '@/utils'
import type { ImageDownloadJob, ImageDownloadProgress } from '@/types/image'

const downloads = useImageDownloads(), error = ref(''), router = useRouter()
const props = withDefaults(defineProps<{ filter?: 'attention' | 'all' }>(), { filter: 'all' })
const shownJobs = computed(() => downloads.jobs.value.filter(job => props.filter === 'all' || job.status !== 'success'))
const busy = ref(new Set<string>()), optionsBusy = ref(false)
const labels: Record<ImageDownloadJob['status'], string> = { queued: '排队中', running: '下载中', paused: '已暂停', success: '已入库', failed: '失败', cancelled: '已停止', interrupted: '中断待恢复' }
const phases: Record<ImageDownloadProgress['phase'], string> = {
  queued: '排队中', catalog: '读取章节目录', checking: '校验已有页面', connecting: '连接图片服务器',
  receiving: '接收图片', retrying: '等待重试', 'rate-limited': '等待限流', saving: '保存图片', importing: '整理入库', idle: '',
}
const bytes = (value = 0) => value > 0 ? formatBytes(value) : '0 B'
const known = (job: ImageDownloadJob) => job.status === 'success' || (job.progress?.totalKnown ?? job.total > 0)
const phaseLabel = (job: ImageDownloadJob) => job.status === 'running' ? phases[job.progress?.phase || 'connecting'] || labels.running : labels[job.status]
async function changeConcurrency(event: Event) {
  const input = event.target as HTMLInputElement
  error.value = ''; optionsBusy.value = true
  try { await downloads.setOptions({ concurrency: Number(input.value) }) }
  catch (cause) { error.value = (cause as Error).message }
  finally { optionsBusy.value = false; input.value = String(downloads.options.value.concurrency) }
}
async function action(job: ImageDownloadJob, type: 'retry' | 'cancel' | 'dismiss' | 'pause' | 'resume' | 'up' | 'down') {
  if (busy.value.has(job.id)) return
  busy.value.add(job.id)
  error.value = ''
  try {
    if (type === 'retry') await window.baoyi.image.retryJob(job.id)
    else if (type === 'cancel') await window.baoyi.image.cancelJob(job.id)
    else if (type === 'pause') await window.baoyi.image.pauseJob(job.id)
    else if (type === 'resume') await window.baoyi.image.resumeJob(job.id)
    else if (type === 'up' || type === 'down') await window.baoyi.image.moveJob(job.id, type)
    else await window.baoyi.image.dismissJob(job.id)
    await downloads.refresh()
  } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value.delete(job.id) }
}
</script>

<template>
  <section v-if="shownJobs.length" class="image-download-list">
    <div class="download-controls"><h3>漫画下载</h3><label>并发 <input type="number" min="1" max="3" step="1" aria-label="图片下载并发" :disabled="optionsBusy" :value="downloads.options.value.concurrency" @change="changeConcurrency" /></label></div>
    <p v-if="error" role="alert" class="download-error">{{ error }}</p>
    <article v-for="job in shownJobs" :key="job.id" :data-job-id="job.id">
      <header class="download-heading">
        <strong :title="job.work.title">{{ job.work.title }}</strong>
        <span class="download-phase" aria-live="polite">{{ phaseLabel(job) }}</span>
      </header>
      <div class="download-meter">
        <div class="download-meter-label">
          <span>整部</span>
          <span v-if="known(job)">{{ job.completedChapters }} / {{ job.chapters.length }} 章 · {{ job.processed }} / {{ job.total }} 页</span>
          <span v-else>目录 {{ job.progress?.catalogChapters || 0 }} / {{ job.chapters.length }} 章</span>
        </div>
        <progress aria-label="整部页数" :value="known(job) ? job.processed : job.status === 'running' ? undefined : 0" :max="job.total || 1" />
      </div>
      <div v-if="job.progress?.chapterIndex && known(job)" class="download-meter">
        <div class="download-meter-label">
          <span class="download-chapter">{{ job.chapters[job.progress.chapterIndex - 1]?.title || job.current }}</span>
          <span>{{ job.progress.chapterProcessed }} / {{ job.progress.chapterTotal }} 页</span>
        </div>
        <progress aria-label="当前章节页数" :value="job.progress.chapterProcessed" :max="job.progress.chapterTotal || 1" />
      </div>
      <dl v-if="job.progress" class="download-stats">
        <div><dt>已保存</dt><dd>{{ bytes(job.progress.storedBytes) }}</dd></div>
        <div><dt>本次接收</dt><dd>{{ bytes(job.progress.receivedBytes) }}</dd></div>
        <div><dt>接收速度</dt><dd>{{ bytes(job.status === 'running' && job.progress.phase === 'receiving' ? job.progress.bytesPerSecond : 0) }}/s</dd></div>
        <div><dt>复用页面</dt><dd>{{ job.progress.reusedPages }} 页</dd></div>
      </dl>
      <p v-if="job.status === 'running' && job.progress?.retryAt" class="download-wait">重试于 {{ new Date(job.progress.retryAt).toLocaleTimeString() }}</p>
      <p v-if="job.status === 'running' && job.progress?.effectiveConcurrency && job.progress.effectiveConcurrency < downloads.options.value.concurrency" class="download-wait">限流保护 · 当前 {{ job.progress.effectiveConcurrency }} 路</p>
      <p v-if="job.error" class="download-error">{{ job.error }}</p>
      <footer>
        <button v-if="job.resourceId" @click="router.push({ name: 'image-detail', params: { id: job.resourceId } })"><BookOpen :size="15" />打开作品</button>
        <template v-if="job.status === 'queued'">
          <span class="download-order">队列第 {{ job.queuePosition }} 位</span>
          <button title="上移任务" aria-label="上移任务" class="download-icon" :disabled="busy.has(job.id) || (job.queuePosition || 1) <= 1" @click="action(job, 'up')"><ArrowUp :size="15" /></button>
          <button title="下移任务" aria-label="下移任务" class="download-icon" :disabled="busy.has(job.id) || (job.queuePosition || 1) >= downloads.jobs.value.filter(j => j.status === 'queued').length" @click="action(job, 'down')"><ArrowDown :size="15" /></button>
        </template>
        <button v-if="['queued', 'running'].includes(job.status)" title="暂停下载" aria-label="暂停下载" class="download-icon" :disabled="busy.has(job.id)" @click="action(job, 'pause')"><Pause :size="15" /></button>
        <button v-if="job.status === 'paused'" title="继续下载" aria-label="继续下载" class="download-icon" :disabled="busy.has(job.id)" @click="action(job, 'resume')"><Play :size="15" /></button>
        <button v-if="['queued', 'running', 'paused'].includes(job.status)" title="停止下载" aria-label="停止下载" class="download-icon" :disabled="busy.has(job.id)" @click="action(job, 'cancel')"><Square :size="15" /></button>
        <template v-if="!['queued', 'running'].includes(job.status)">
          <button v-if="!['success', 'paused'].includes(job.status)" title="重试缺失页" aria-label="重试缺失页" class="download-icon" :disabled="busy.has(job.id)" @click="action(job, 'retry')"><RotateCcw :size="15" /></button>
          <button title="移除记录" aria-label="移除记录" class="download-icon" :disabled="busy.has(job.id)" @click="action(job, 'dismiss')"><Trash2 :size="15" /></button>
        </template>
      </footer>
    </article>
  </section>
</template>

<style scoped>
.image-download-list{margin:15px 0;color:var(--text-main);font-size:12px;min-width:0}
.image-download-list h3{font-size:13px;color:var(--text-sub);font-weight:500}
.download-controls{display:flex;align-items:center;justify-content:space-between;gap:12px}.download-controls label{display:flex;align-items:center;gap:8px;color:var(--text-sub)}.download-controls input{width:58px;height:30px;border:1px solid var(--divider);border-radius:4px;background:var(--bg-card);color:var(--text-main);padding:4px 6px;font-variant-numeric:tabular-nums}
.image-download-list article{padding:14px;border:1px solid var(--divider);background:var(--bg-card);border-radius:7px;margin:10px 0;min-width:0}
.download-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}
.download-heading strong{font-size:13px;font-weight:500;line-height:1.6;min-width:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.download-phase{color:var(--text-sub);white-space:nowrap;flex:none;line-height:1.6}
.download-meter{margin-top:10px}
.download-meter-label{display:flex;justify-content:space-between;align-items:baseline;gap:12px;color:var(--text-sub);line-height:1.6}
.download-meter-label>span:last-child{flex:none;font-variant-numeric:tabular-nums}
.download-chapter{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.image-download-list progress{display:block;width:100%;height:5px;accent-color:var(--accent);margin-top:6px}
.download-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0 0;font-variant-numeric:tabular-nums}
.download-stats>div{min-width:0}.download-stats dt{color:var(--text-faint);font-size:11px;margin-bottom:4px}.download-stats dd{margin:0;overflow-wrap:anywhere}
.download-wait{color:var(--text-sub);font-size:11px}
.image-download-list footer{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.download-order{align-self:center;margin-right:auto;color:var(--text-sub);font-variant-numeric:tabular-nums}
.image-download-list button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:5px 9px;border-radius:4px;background:var(--hover-surface);color:var(--text-main);cursor:pointer}
.image-download-list .download-icon{width:30px;height:30px;padding:0}
.image-download-list button:hover{background:var(--active-surface);color:var(--accent)}
.image-download-list button:disabled{opacity:.4;cursor:default}
.image-download-list .download-error{color:var(--danger);line-height:1.6;overflow-wrap:anywhere}
@media(max-width:650px){.download-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.download-heading{gap:8px}.download-meter-label{flex-wrap:wrap;gap:4px 10px}}
</style>
