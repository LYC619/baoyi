<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { VideoRemovalPreview } from '@/types/video-management'
import { errorMessage, formatBytes, plain } from '@/utils'
const props = defineProps<{ resourceIds: string[]; episodeId?: string }>()
const emit = defineEmits<{ close: []; changed: [detachedId: string] }>()
const dialog = ref<HTMLDialogElement | null>(null), action = ref<'remove' | 'detach'>('remove'), deleteLocal = ref(false)
const preview = ref<VideoRemovalPreview | null>(null), busy = ref(false), failure = ref('')
let revision = 0
async function inspect() {
  const current = ++revision; preview.value = null; failure.value = ''
  try { const result = await window.baoyi.video.previewRemoval(plain({ resourceIds: props.resourceIds, episodeId: props.episodeId, action: action.value, deleteLocal: action.value === 'remove' && deleteLocal.value })); if (current === revision) preview.value = result }
  catch (e) { if (current === revision) failure.value = errorMessage(e) }
}
onMounted(() => { dialog.value?.showModal(); void inspect() })
watch([action, deleteLocal], inspect)
async function apply() {
  if (!preview.value) return
  busy.value = true; failure.value = ''
  try {
    const result = await window.baoyi.video.applyRemoval(plain(preview.value))
    emit('changed', result.detachedId)
    if (result.warnings.length) { failure.value = result.warnings.join('；'); preview.value = null }
    else emit('close')
  } catch (e) { failure.value = errorMessage(e); preview.value = null } finally { busy.value = false }
}
</script>
<template>
  <dialog ref="dialog" class="video-removal" aria-labelledby="removal-title" @cancel.prevent="!busy && emit('close')">
    <header><h2 id="removal-title">{{ episodeId ? '管理这一集' : '删除所选作品' }}</h2><button class="btn btn--ghost" :disabled="busy" @click="emit('close')">关闭</button></header>
    <p v-if="episodeId">文件缺失时可以关闭此窗口，继续保留为待补齐。</p>
    <label v-if="episodeId">操作<select v-model="action" class="input" :disabled="busy"><option value="remove">移除库内记录</option><option value="detach">移出合集，作为独立视频</option></select></label>
    <label v-if="action === 'remove'" class="check"><input v-model="deleteLocal" type="checkbox" :disabled="busy" />同时将专属本地文件移入回收站</label>
    <p>{{ action === 'detach' ? '文件位置和观看进度会保留，首页将显示独立条目。' : deleteLocal ? '共享文件会保留；已缺失的文件无需处理。' : '本地文件保留，后续普通重扫会跳过已移除的内容。' }}</p>
    <template v-if="preview"><p>{{ preview.titles.join('、') }} · {{ preview.episodeCount }} 个内容项</p><ul><li v-for="file in preview.files" :key="file.path"><span>{{ file.path }}</span><small>{{ file.shared ? '共享，保留' : !file.present ? '已缺失' : deleteLocal && action === 'remove' ? '移入回收站' : '保留文件' }} · {{ formatBytes(file.size) }}</small></li></ul></template>
    <p v-if="failure" role="alert">{{ failure }}</p>
    <footer><button v-if="!preview && !busy" class="btn btn--subtle" @click="inspect">重新检查范围</button><button class="btn btn--primary" :disabled="busy || !preview" @click="apply">{{ busy ? '正在处理…' : action === 'detach' ? '确认移出合集' : deleteLocal ? '删除记录并移入回收站' : '确认移除记录' }}</button></footer>
  </dialog>
</template>
<style scoped>
.video-removal{width:min(700px,90vw);max-height:85vh;overflow:auto;padding:24px;border:1px solid var(--card-border);border-radius:12px;background:var(--bg-card);color:var(--text-main)}.video-removal::backdrop{background:#0009}header,footer{display:flex;align-items:center;justify-content:space-between;gap:16px}h2{font-size:18px}p{line-height:1.7;margin:14px 0;color:var(--text-muted)}label{display:grid;gap:8px}.check{display:flex;margin:18px 0}ul{list-style:none;padding:0;max-height:250px;overflow:auto}li{display:grid;gap:5px;padding:10px 0;overflow-wrap:anywhere;border-bottom:1px solid var(--card-border)}small{color:var(--text-faint)}footer{justify-content:flex-end;margin-top:16px}
</style>
