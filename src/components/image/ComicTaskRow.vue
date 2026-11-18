<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from '@/composables/useToast'
import { comicPhaseLabels, comicStatusLabels, type ComicTaskAction, type ComicTaskRow } from '@/composables/useComicDownloads'
import { errorMessage, formatBytes } from '@/utils'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import type { ComicProxy, JobLogEntry } from '@/types/comic-ingest'

const props = defineProps<{
  row: ComicTaskRow; concurrency: number
  run: (row: ComicTaskRow, action: ComicTaskAction, proxy?: ComicProxy) => Promise<void>
  logs: (row: ComicTaskRow) => Promise<JobLogEntry[]>
}>()
const router = useRouter(), busy = ref(false), proxyOpen = ref(false), mode = ref<ComicProxy['mode']>('system'), custom = ref('127.0.0.1:7890')
const logOpen = ref(false), entries = ref<JobLogEntry[]>([])
const actionLabels: Record<ComicTaskAction, string> = { pause: '暂停下载', cancel: '停止下载', retry: '重试剩余页', dismiss: '移除记录', open: '打开作品', logs: '查看过程', resume: '继续下载', up: '上移任务', down: '下移任务', proxy: '更换连接方式', revalidate: '重新核验', clean: '停止并清理暂存' }
function label(kind: ComicTaskAction) {
  if (kind === 'retry') {
    if (['已落盘，待登记', '登记入库'].includes(props.row.phaseLabel)) return '重试登记'
    if (props.row.status === 'paused') return '继续下载'
  }
  return actionLabels[kind]
}
function disabled(kind: ComicTaskAction) {
  return busy.value || kind === 'retry' && (props.row.retryNotBefore || 0) > Date.now()
    || kind === 'up' && (props.row.queuePosition || 1) <= 1
    || kind === 'down' && (props.row.queuePosition || 1) >= (props.row.queueTotal || 0)
}
async function action(kind: ComicTaskAction, saveProxy = false) {
  if (busy.value) return
  if (kind === 'clean' && !window.confirm(`停止“${props.row.title}”并清理暂存？将删除已下载的临时图片文件，此操作不可撤销。`)) return
  busy.value = true
  try {
    if (kind === 'open') await router.push({ name: 'image-detail', params: { id: props.row.resourceId } })
    else if (kind === 'logs') { entries.value = await props.logs(props.row); logOpen.value = true }
    else if (kind === 'proxy' && !saveProxy) {
      const value = await window.baoyi.comic.defaults(); mode.value = value.proxy.mode
      if (value.proxy.mode === 'custom') custom.value = value.proxy.url
      proxyOpen.value = true
    } else {
      await props.run(props.row, kind, saveProxy ? (mode.value === 'custom' ? { mode: 'custom', url: custom.value } : { mode: mode.value }) : undefined)
      proxyOpen.value = false
    }
  } catch (cause) { useToast().error(errorMessage(cause)) }
  finally { busy.value = false }
}
</script>

<template>
  <article class="comic-task" :data-job-id="row.id" :data-provider="row.provider">
    <header><strong :title="row.title">{{ row.title }}</strong><small>{{ row.provider === 'jm' ? 'JM' : '哔咔' }}</small><span class="download-phase" aria-live="polite">{{ comicStatusLabels[row.status] }}</span></header>
    <p v-if="row.phaseLabel">{{ row.phaseLabel }}<span v-if="row.status === 'queued' && row.queuePosition"> · 排队第 {{ row.queuePosition }}</span></p>
    <div class="download-meter"><div class="download-meter-label"><span>整部</span><span v-if="row.totalKnown">{{ row.chapterDone }} / {{ row.chapterTotal }} 章 · {{ row.processed }} / {{ row.total }} 页</span><span v-else>目录 {{ row.progress?.catalogChapters || 0 }} / {{ row.chapterTotal }} 章</span></div><progress aria-label="整部页数" :value="row.totalKnown ? row.processed : row.status === 'running' ? undefined : 0" :max="row.total || 1" /></div>
    <div v-if="row.progress?.chapterIndex && row.totalKnown" class="download-meter"><div class="download-meter-label"><span>{{ row.chapterTitle }}</span><span>{{ row.progress.chapterProcessed }} / {{ row.progress.chapterTotal }} 页</span></div><progress aria-label="当前章节页数" :value="row.progress.chapterProcessed" :max="row.progress.chapterTotal || 1" /></div>
    <p v-else-if="row.current">{{ row.current }}</p>
    <dl v-if="row.progress" class="download-stats"><div><dt>已保存</dt><dd>{{ formatBytes(row.progress.storedBytes) }}</dd></div><div><dt>本次接收</dt><dd>{{ formatBytes(row.progress.receivedBytes) }}</dd></div><div><dt>接收速度</dt><dd>{{ formatBytes(row.status === 'running' && row.progress.phase === 'receiving' ? row.progress.bytesPerSecond : 0) }}/s</dd></div><div><dt>复用页面</dt><dd>{{ row.progress.reusedPages }} 页</dd></div></dl>
    <p v-if="row.status === 'running' && row.progress?.effectiveConcurrency && row.progress.effectiveConcurrency < concurrency">限流保护 · 当前 {{ row.progress.effectiveConcurrency }} 路</p>
    <p v-if="(row.retryNotBefore || 0) > Date.now()">可重试时间：{{ new Date(row.retryNotBefore!).toLocaleTimeString() }}</p>
    <p v-if="row.error" class="download-error">{{ row.error }}</p>
    <p v-if="row.requiresRevalidation">此任务来自备份，请重新解析作品并核对存放位置。</p>
    <footer><button v-for="kind in row.actions" :key="kind" class="im-button" :aria-label="label(kind)" :disabled="disabled(kind)" @click="action(kind)">{{ label(kind) }}</button></footer>
    <form v-if="proxyOpen" class="comic-retry" @submit.prevent="action('proxy', true)"><label>连接方式<select v-model="mode" aria-label="重试连接方式"><option value="system">跟随系统代理</option><option value="custom">指定代理</option><option value="builtin">使用当前内置代理</option></select></label><label v-if="mode === 'custom'">代理地址<input v-model="custom" aria-label="重试代理地址" placeholder="127.0.0.1:7890" /></label><button class="im-button" :disabled="busy || (row.retryNotBefore || 0) > Date.now()">保存并重试</button><button type="button" class="im-button" @click="proxyOpen = false">取消</button></form>
    <ProjectDialog v-if="logOpen" :title="row.title + ' · 下载过程'" @close="logOpen = false"><div class="comic-log"><p v-if="!entries.length">此任务没有本机过程记录。</p><p v-for="(entry, index) in entries" :key="index">{{ new Date(entry.at).toLocaleString() }} · {{ comicStatusLabels[entry.status] }} · {{ comicPhaseLabels[entry.phase] }} · {{ entry.processed }} / {{ entry.total }} 页<span v-if="entry.errorCode"> · {{ entry.errorCode === 'DOWNLOAD_FAILED' ? '下载失败' : entry.errorCode }}</span></p></div></ProjectDialog>
  </article>
</template>

<style scoped>
.comic-task{border:1px solid var(--divider);border-radius:8px;background:var(--bg-card);padding:16px;margin:14px 0;font-size:12px;min-width:0}.comic-task header{display:flex;align-items:baseline;gap:12px}.comic-task strong{font-size:14px;overflow-wrap:anywhere}.comic-task small,.download-phase{color:var(--text-sub);white-space:nowrap}.download-phase{margin-left:auto}.comic-task p{color:var(--text-sub);line-height:1.7}.download-meter{margin:12px 0}.download-meter-label{display:flex;justify-content:space-between;gap:12px;margin-bottom:5px;color:var(--text-sub)}.download-meter progress{width:100%;height:5px;accent-color:var(--accent)}.download-stats{display:flex;flex-wrap:wrap;gap:10px 24px;color:var(--text-sub)}.download-stats div{display:flex;gap:8px}.download-stats dd{margin:0}.comic-task footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.comic-task .download-error{color:var(--danger)}.comic-retry{display:flex;align-items:end;flex-wrap:wrap;gap:8px;margin-top:12px}.comic-retry label{display:grid;gap:6px}.comic-retry input,.comic-retry select{max-width:220px;padding:8px;color:var(--text-main);background:var(--bg-main);border:1px solid var(--divider);border-radius:5px}.comic-log{max-height:50vh;overflow:auto;font-size:12px;line-height:1.7;color:var(--text-sub)}
</style>
