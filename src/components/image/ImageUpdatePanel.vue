<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDown, Download, Loader2, RefreshCw } from 'lucide-vue-next'
import { useImageDownloads } from '@/composables/useImageDownloads'
import type { ImageChapterUpdate, ImageUpdateCheck } from '@/types/image'

const props = defineProps<{ resourceId: string; compact?: boolean }>(), emit = defineEmits<{ updated: [] }>()
const expanded = ref(false)
const result = ref<ImageUpdateCheck | null>(null), selected = ref<string[]>([]), busy = ref(false), error = ref(''), message = ref(''), pending = ref('')
const downloads = useImageDownloads(), job = computed(() => downloads.jobs.value.find(j => j.id === pending.value))
const active = computed(() => !!pending.value && (!job.value || ['queued', 'running', 'paused'].includes(job.value.status)))
const newChapters = computed(() => result.value?.chapters.filter(c => c.status === 'new') || [])
const labels: Record<ImageChapterUpdate['status'], string> = { new: '新增', downloaded: '已下载', incomplete: '不完整', unverified: '待核对', unavailable: '来源未列出' }
async function check() {
  if (busy.value || active.value) return
  expanded.value = true
  busy.value = true; error.value = ''; message.value = ''; result.value = null; selected.value = []
  try { result.value = await window.baoyi.image.checkUpdates(props.resourceId); selected.value = newChapters.value.map(c => c.id) }
  catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
async function download() {
  if (!selected.value.length || busy.value || active.value) return
  busy.value = true; error.value = ''; message.value = ''
  try { const queued = await window.baoyi.image.downloadUpdates(props.resourceId, [...selected.value]); pending.value = queued.id; message.value = '新章节已加入下载队列'; await downloads.refresh() }
  catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
watch([() => job.value?.status, busy], ([status, working]) => {
  if (working) return
  if (!status) { if (pending.value) { pending.value = ''; message.value = '下载记录已移除' }; return }
  if (['queued', 'running', 'paused'].includes(status)) return
  const failure = job.value?.error
  pending.value = ''; result.value = null; selected.value = []
  if (status === 'success') { message.value = '新增章节已入库'; emit('updated') }
  else { message.value = ''; error.value = failure || '下载未完成，请检查下载记录' }
})
</script>

<template>
  <section class="image-updates" :class="{ compact }" aria-label="连载更新">
    <header><h2 v-if="!compact">连载更新</h2><button class="im-button" :disabled="busy || active" @click="check"><Loader2 v-if="busy" :size="16" /><RefreshCw v-else :size="16" />{{ busy ? '正在处理' : '检查连载更新' }}</button><button v-if="compact && (result || error || message)" class="im-icon" :aria-label="expanded?'收起连载更新':'展开连载更新结果'" :aria-expanded="expanded" :aria-controls="'updates-'+resourceId" @click="expanded=!expanded"><ChevronDown :size="16" :style="{transform:expanded?'rotate(180deg)':''}"/></button></header>
    <div v-show="!compact || expanded" :id="'updates-'+resourceId" class="update-result">
    <h3 v-if="compact">连载更新结果</h3>
    <p v-if="error" role="alert" class="im-error">{{ error }}</p><p v-if="message" role="status">{{ message }}</p><p v-if="job?.status === 'paused'">新章节下载已暂停</p>
    <template v-if="result">
      <p class="update-source">{{ result.sourceTitle }} · 来源{{ result.sourcePublication === 'completed' ? '已完结' : '连载中' }}<time>{{ new Date(result.checkedAt).toLocaleString() }}</time></p>
      <div class="update-selection"><label><input type="checkbox" aria-label="全选新增章节" :disabled="busy || active || !newChapters.length" :checked="newChapters.length > 0 && selected.length === newChapters.length" :indeterminate="selected.length > 0 && selected.length < newChapters.length" @change="selected = ($event.target as HTMLInputElement).checked ? newChapters.map(c => c.id) : []" />新增 {{ newChapters.length }} 章</label><span>已选 {{ selected.length }} 章</span></div>
      <ul class="update-chapters"><li v-for="chapter in result.chapters" :key="chapter.id" :data-chapter-id="chapter.id"><input v-model="selected" type="checkbox" :value="chapter.id" :disabled="busy || active || chapter.status !== 'new'" :aria-label="`选择章节 ${chapter.title} (${chapter.id})`" /><div><strong>{{ chapter.title }}</strong><small v-if="chapter.localTitle && chapter.localTitle !== chapter.title">本地：{{ chapter.localTitle }}</small></div><span :class="`update-${chapter.status}`">{{ labels[chapter.status] }}</span><small>{{ chapter.localPages }}{{ chapter.expectedPages !== null ? ' / ' + chapter.expectedPages : '' }} 页</small></li></ul>
      <p v-if="!newChapters.length" class="update-note">没有新增章节</p>
      <footer v-else><button class="im-button im-primary" :disabled="!selected.length || busy || active" @click="download"><Download :size="16" />下载所选新章节</button></footer>
    </template>
    </div>
  </section>
</template>

<style scoped>
.image-updates { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--divider); font-size: 12px; }
.image-updates.compact { display: contents; }
.compact > header { flex: none; gap: 2px; }
.compact .update-result { order: 1; flex: 0 0 100%; min-width: 0; padding: 16px 18px; background: var(--bg-card); border: 1px solid var(--divider); border-radius: 8px; }
h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
header, .update-selection { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
h2 { margin: 0; font-size: 19px; } p { margin: 12px 0; line-height: 1.7; overflow-wrap: anywhere; }
.update-source, .update-note, small, .update-selection { color: var(--text-sub); }
.update-source { display: flex; justify-content: space-between; gap: 8px 20px; flex-wrap: wrap; }
.update-selection { padding: 9px 0; } label { display: flex; align-items: center; gap: 8px; }
input { width: 15px; height: 15px; flex: none; accent-color: var(--accent); }
.update-chapters { list-style: none; padding: 0; margin: 0; max-height: 350px; overflow-y: auto; }
li { display: grid; grid-template-columns: 15px minmax(0, 1fr) 72px 72px; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--divider); }
li > div { display: grid; gap: 5px; min-width: 0; overflow-wrap: anywhere; }
strong { font-weight: 500; } li > small { text-align: right; font-variant-numeric: tabular-nums; }
.update-new { color: var(--accent); } .update-incomplete { color: var(--warning); }
footer { display: flex; justify-content: flex-end; margin-top: 14px; }
</style>
