<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDown, Loader2, ShieldCheck, Wrench } from 'lucide-vue-next'
import { useImageDownloads } from '@/composables/useImageDownloads'
import type { ImageAudit, ImageAuditEntry } from '@/types/image'

const props = defineProps<{ resourceId: string; compact?: boolean }>(), emit = defineEmits<{ repaired: [] }>()
const expanded = ref(false)
const report = ref<ImageAudit | null>(null), busy = ref(false), error = ref(''), message = ref(''), pending = ref(''), limit = ref(100)
const downloads = useImageDownloads()
const labels: Record<ImageAuditEntry['status'], string> = { ok: '正常', missing: '缺失', damaged: '损坏', unverified: '未校验' }
const issues = computed(() => report.value?.entries.filter(e => e.status !== 'ok') || [])
const repairable = computed(() => report.value?.entries.some(e => e.repairable))
const job = computed(() => downloads.jobs.value.find(j => j.id === pending.value))
const active = computed(() => !!pending.value && (!job.value || ['queued', 'running', 'paused'].includes(job.value.status)))
async function audit() {
  if (busy.value) return
  expanded.value = true
  busy.value = true; error.value = ''; message.value = ''; limit.value = 100
  try { report.value = await window.baoyi.image.audit(props.resourceId) }
  catch (cause) { report.value = null; error.value = (cause as Error).message }
  finally { busy.value = false }
}
async function repair() {
  busy.value = true; error.value = ''; message.value = ''
  try {
    const result = await window.baoyi.image.repair(props.resourceId)
    if (result) { pending.value = result.id; message.value = '已加入修复队列'; await downloads.refresh() }
    else { message.value = '没有可修复的异常页'; report.value = await window.baoyi.image.audit(props.resourceId) }
  } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
watch([() => job.value?.status, busy], async ([status, working]) => {
  if (working) return
  if (!status) { if (pending.value) { pending.value = ''; message.value = '修复记录已移除' }; return }
  if (['queued', 'running', 'paused'].includes(status)) return
  const succeeded = status === 'success', failure = job.value?.error
  pending.value = ''
  await audit()
  if (succeeded) { message.value = '修复完成'; emit('repaired') }
  else error.value = failure || '修复未完成，请在下载记录中重试'
})
</script>

<template>
  <section class="image-integrity" :class="{ compact }" aria-label="文件检查">
    <header><h2 v-if="!compact">文件检查</h2><button class="im-button" :disabled="busy || active" @click="audit"><Loader2 v-if="busy" :size="16" /><ShieldCheck v-else :size="16" />{{ busy ? '检查处理中' : '检查完整性' }}</button><button v-if="compact && (report || error || message)" class="im-icon" :aria-label="expanded ? '收起文件检查' : '展开文件检查结果'" :aria-expanded="expanded" :aria-controls="'audit-'+resourceId" @click="expanded=!expanded"><ChevronDown :size="16" :style="{transform:expanded?'rotate(180deg)':''}"/></button></header>
    <div v-show="!compact || expanded" :id="'audit-'+resourceId" class="audit-result">
    <div v-if="compact" class="result-heading"><h3>文件检查结果</h3></div>
    <button v-if="repairable" class="im-button" :disabled="busy || active" @click="repair"><Wrench :size="16" />修复异常页</button>
    <p v-if="error" class="im-error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="job?.status === 'paused'">修复已暂停</p>
    <template v-if="report">
      <dl aria-label="文件检查结果"><div><dt>总计</dt><dd>{{ report.total }}</dd></div><div v-for="(label, status) in labels" :key="status"><dt>{{ label }}</dt><dd>{{ report[status] }}</dd></div></dl>
      <p v-if="!report.catalogComplete" class="audit-note">缺少完整来源目录，检查范围仅限本地索引和已保存清单。</p>
      <p v-if="report.unverified" class="audit-note">未校验页没有来源校验值，仅确认格式与尺寸可读。</p>
      <details v-if="issues.length"><summary>异常与未校验页面 · {{ issues.length }}</summary><ul><li v-for="entry in issues.slice(0, limit)" :key="entry.key"><strong>{{ entry.title }} · 第 {{ entry.ordinal + 1 }} 页</strong><span>{{ labels[entry.status] }}</span><small>{{ entry.reason }}</small></li></ul><button v-if="issues.length > limit" class="im-button" @click="limit += 100">显示更多</button></details>
    </template>
    </div>
  </section>
</template>

<style scoped>
.image-integrity { margin-top: 28px; border-top: 1px solid var(--divider); padding-top: 20px; font-size: 12px; }
.image-integrity.compact { display: contents; }
.compact > header { flex: none; gap: 2px; }
.compact .audit-result { order: 1; flex: 0 0 100%; min-width: 0; padding: 16px 18px; background: var(--bg-card); border: 1px solid var(--divider); border-radius: 8px; }
.result-heading { margin-bottom: 12px; } .result-heading h3 { font-size: 14px; font-weight: 600; }
header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
h2 { margin: 0 auto 0 0; font-size: 19px; }
dl { display: flex; flex-wrap: wrap; gap: 18px 32px; margin: 18px 0 10px; }
dl div { display: flex; align-items: baseline; gap: 10px; }
dt, .audit-note { color: var(--text-sub); }
dd { margin: 0; font-size: 17px; font-variant-numeric: tabular-nums; }
p { line-height: 1.7; margin: 10px 0; overflow-wrap: anywhere; }
details { margin-top: 12px; } summary { cursor: pointer; color: var(--text-sub); }
ul { margin: 8px 0; padding: 0; list-style: none; }
li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; padding: 10px 0; border-top: 1px solid var(--divider); overflow-wrap: anywhere; }
li strong { font-weight: 500; } li small { grid-column: 1 / -1; color: var(--text-sub); }
</style>
