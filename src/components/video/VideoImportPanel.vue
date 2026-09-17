<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FolderPlus, Loader2, RefreshCw, X } from 'lucide-vue-next'
import { useVideoImport } from '@/composables/useVideoImport'
import { rangeSelection } from '@/utils/range-selection'
import type { VideoImportEdits, VideoImportEntry } from '@/types/video-import'
import { videoDateLabel } from '@/utils/video-content'
const session = useVideoImport()
const { batch, batches, busy, error, useAgent } = session
const dialog = ref<HTMLDialogElement | null>(null), activeId = ref(''), anchor = ref(''), filter = ref('all')
const form = ref({ title: '', originalTitle: '', category: '', description: '', tags: '' }), original = ref('')
const dirty = computed(() => JSON.stringify(form.value) !== original.value)
const canSelect = (entry: VideoImportEntry) => entry.status === 'ready' || entry.status === 'review'
const rows = computed(() => batch.value?.entries.filter(entry => filter.value === 'all' || entry.status === filter.value) || [])
const selected = computed(() => batch.value?.entries.filter(entry => entry.selected && canSelect(entry)) || [])
const active = computed(() => batch.value?.entries.find(entry => entry.id === activeId.value) || null)
const labels = { ready: '待确认', review: '资料待补齐', skipped: '已跳过', failed: '识别失败', confirmed: '已入库' }
const working = computed(() => !!busy.value || !!batch.value && ['scanning', 'reviewing', 'committing'].includes(batch.value.status))
function resetForm() {
  const entry = active.value
  form.value = { title: entry?.title || '', originalTitle: entry?.originalTitle || '', category: entry?.category || '', description: entry?.description || '', tags: entry?.tags.join('、') || '' }
  original.value = JSON.stringify(form.value)
}
watch(() => batch.value?.id, () => { activeId.value = batch.value?.entries[0]?.id || ''; anchor.value = ''; resetForm() }, { immediate: true })
watch(() => batch.value?.revision, () => {
  if (!active.value && batch.value?.entries.length) { activeId.value = batch.value.entries[0].id; resetForm() }
  else if (!dirty.value) resetForm()
})
async function save(): Promise<boolean> {
  if (!dirty.value || !active.value || !canSelect(active.value)) return true
  const edits: VideoImportEdits = { ...form.value, tags: form.value.tags.split(/[、,，\n]/).map(tag => tag.trim()).filter(Boolean) }
  const result = await session.update({ entry: { id: active.value.id, edits } })
  if (result) resetForm()
  return !!result
}
async function choose(entry: VideoImportEntry) { if (await save()) { activeId.value = entry.id; resetForm() } }
async function toggle(entry: VideoImportEntry, event: MouseEvent) {
  if (working.value || !canSelect(entry) || !await save()) return
  const ids = rangeSelection(rows.value.filter(canSelect).map(row => row.id), selected.value.map(row => row.id), entry.id, anchor.value, event.shiftKey)
  if (!event.shiftKey || !anchor.value) anchor.value = entry.id
  await session.update({ selectedIds: ids })
}
async function selectAll() {
  if (!await save()) return
  const ids = rows.value.filter(canSelect).map(row => row.id), all = ids.every(id => selected.value.some(row => row.id === id))
  await session.update({ selectedIds: all ? selected.value.filter(row => !ids.includes(row.id)).map(row => row.id) : [...new Set([...selected.value.map(row => row.id), ...ids])] })
}
async function review(ids: string[]) { if (await save()) await session.review(ids) }
async function confirm() { if (await save()) await session.confirm(selected.value.map(row => row.id)) }
async function close() { if (!working.value && !await save()) return; session.open.value = false }
async function switchBatch(id: string) { if (await save()) await session.show(id) }
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => dialog.value?.close())
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="import-panel" aria-labelledby="video-import-title" @cancel.prevent="close">
      <header><div><h2 id="video-import-title">视频导入确认</h2><p>先识别、再勾选入库。关闭后可从“导入确认”继续。</p></div><button type="button" aria-label="关闭导入确认" @click="close"><X :size="19" /></button></header>
      <div class="import-tools">
        <select :value="batch?.id || ''" :disabled="working" aria-label="导入批次" @change="switchBatch(($event.target as HTMLSelectElement).value)"><option value="" disabled>选择一批导入</option><option v-for="row in batches" :key="row.id" :value="row.id">{{ new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false }) }} · {{ row.total }} 项 / {{ row.pending }} 项待确认</option></select>
        <label class="agent-toggle"><input type="checkbox" :checked="useAgent" :disabled="working" @change="session.setAgent(($event.target as HTMLInputElement).checked)" />新批次启用 Agent</label>
        <button class="btn btn--ghost" :disabled="working || dirty" @click="session.begin()"><FolderPlus :size="14" />选择目录</button>
      </div>
      <p class="import-note">{{ useAgent ? '先读本地资料，再用 Agent 联网复查。结果确认后保存。' : '仅用本地文件、info 和 NFO 识别；也可单独选中条目让 Agent 复查。' }}</p>
      <p v-if="error || batch?.error" class="import-error" role="alert">{{ error || batch?.error }}</p>
      <div v-if="working" class="import-progress" role="status"><Loader2 class="spin" :size="15" /><span>{{ busy === 'confirm' ? '正在确认入库、补充封面…' : batch?.progress?.log || '正在处理…' }} <template v-if="batch?.progress?.total">{{ batch.progress.processed }}/{{ batch.progress.total }}</template></span><button v-if="busy === 'scan' || busy === 'review'" @click="session.cancel">停止识别</button></div>
      <div class="import-body">
        <section class="import-list" aria-label="本批识别结果">
          <div class="import-list__tools"><button :disabled="working" @click="selectAll">全选 / 取消当前列表</button><select v-model="filter" aria-label="导入结果筛选"><option value="all">全部 {{ batch?.entries.length || 0 }} 项</option><option value="ready">待确认</option><option value="review">资料待补齐</option><option value="failed">识别失败</option><option value="confirmed">已入库</option></select></div>
          <p class="import-note">按住 Shift 点击复选框，可连续选择。</p>
          <ul><li v-for="entry in rows" :key="entry.id" :class="{ active: activeId === entry.id }"><input type="checkbox" :checked="entry.selected" :disabled="working || !canSelect(entry)" :aria-label="'选择导入：' + entry.title" @click.prevent="toggle(entry, $event)" /><button :disabled="working" @click="choose(entry)"><span>{{ entry.title }}</span><small :class="'state-' + entry.status">{{ labels[entry.status] }} · {{ entry.action === 'update' ? '更新已有作品' : entry.episodeCount > 1 ? entry.episodeCount + ' 集合集' : '新增作品' }}</small><small class="entry-path" :title="entry.path">{{ entry.path }}</small></button></li></ul>
          <p v-if="!rows.length" class="import-empty">{{ working ? '正在读取目录…' : '选择视频目录后，识别结果会保存在这里。' }}</p>
        </section>
        <section class="import-detail" aria-label="条目资料">
          <template v-if="active">
            <div class="import-detail__heading"><h3>{{ labels[active.status] }}</h3><span>{{ active.fileCount }} 个视频 · {{ active.episodeCount }} 项内容</span></div>
            <p v-if="active.publishedStart" class="import-note">发布时间：{{ videoDateLabel(active.publishedStart) }}<template v-if="active.publishedEnd !== active.publishedStart"> ～ {{ videoDateLabel(active.publishedEnd) }}</template></p>
            <form @submit.prevent="save"><fieldset :disabled="working || !canSelect(active)"><label>名称<input v-model="form.title" maxlength="240" /></label><label>原名<input v-model="form.originalTitle" maxlength="240" /></label><label>分类<select v-model="form.category"><option v-for="category in ['电影', '剧集', '动画', '纪录片', '综艺', '里番', '其他']" :key="category">{{ category }}</option><option v-if="form.category && !['电影', '剧集', '动画', '纪录片', '综艺', '里番', '其他'].includes(form.category)">{{ form.category }}</option></select></label><label>简介<textarea v-model="form.description" rows="5" maxlength="20000" /></label><label>标签<input v-model="form.tags" placeholder="用顿号分隔" /></label></fieldset><div class="import-detail__actions"><button type="submit" class="btn btn--ghost" :disabled="working || !dirty || !canSelect(active)">保存修改</button><button type="button" class="btn btn--ghost" :disabled="working || !canSelect(active)" @click="review([active.id])">Agent 复查此项</button></div></form>
            <p class="import-note">{{ active.message }}</p><details class="import-log"><summary>此项识别日志<span v-if="active.tokens"> · {{ active.tokens.toLocaleString() }} tokens</span></summary><pre>{{ active.log || '尚无日志' }}</pre></details>
          </template><p v-else class="import-empty">选择左侧条目核对资料。</p>
        </section>
      </div>
      <footer><div><strong>已选 {{ selected.length }} 项</strong><button v-if="batch" :disabled="working || dirty" @click="session.refresh"><RefreshCw :size="13" />重新检查目录</button><button v-if="batch" :disabled="working" @click="session.discard">丢弃本批预览</button></div><button class="btn btn--ghost" :disabled="working || !selected.length" @click="review(selected.map(row => row.id))">Agent 复查所选</button><button class="btn btn--primary" :disabled="working || !selected.length" @click="confirm">确认录入 {{ selected.length }} 项</button></footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.import-panel{width:min(1080px,calc(100vw - 32px));height:min(800px,calc(100dvh - 40px));margin:auto;padding:0;border:1px solid var(--divider);border-radius:12px;background:var(--bg-main);color:var(--text-main);box-shadow:var(--shadow-pop);display:flex;flex-direction:column;overflow:hidden}
.import-panel::backdrop{background:rgb(0 0 0 / .58)}header{display:flex;align-items:start;justify-content:space-between;gap:16px;padding:20px 22px 12px}h2{font-size:18px;font-weight:600}header p,.import-note{font-size:12px;line-height:1.6;color:var(--text-sub)}header p{margin-top:5px}header button{padding:5px;color:var(--text-sub)}.import-tools{display:flex;align-items:center;gap:12px;padding:0 22px}.import-tools>select{flex:1;min-width:100px}.agent-toggle{display:flex;align-items:center;gap:7px;font-size:12px;white-space:nowrap}.import-panel>.import-note{margin:9px 22px 12px}.import-panel input,.import-panel select,.import-panel textarea{border:1px solid var(--divider);background:var(--bg-card);border-radius:5px;padding:7px 9px;color:var(--text-main);font:inherit;min-width:0}.import-panel select{font-size:12px}.import-panel input[type=checkbox]{accent-color:var(--accent);width:16px;height:16px;flex:none}.import-body{flex:1;display:grid;grid-template-columns:minmax(260px,.9fr) minmax(300px,1.1fr);min-height:0;border-block:1px solid var(--divider)}.import-list{display:flex;flex-direction:column;border-right:1px solid var(--divider);min-height:0;overflow:hidden}.import-list__tools{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px 5px}.import-list__tools button{font-size:12px;color:var(--text-sub)}.import-list>.import-note{padding:0 14px 8px;font-size:11px}.import-list ul{list-style:none;margin:0;padding:0;overflow:auto}.import-list li{display:flex;align-items:start;gap:10px;padding:12px 14px;border-top:1px solid var(--divider)}.import-list li>input{margin-top:3px}.import-list li>button{flex:1;min-width:0;display:grid;gap:5px;text-align:left;color:var(--text-main);font-size:13px}.import-list li small{font-size:11px;color:var(--text-sub)}.import-list li .state-review,.import-list li .state-failed{color:var(--warning)}.import-list li.active{background:var(--hover-surface);box-shadow:inset 3px 0 var(--accent)}.entry-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.import-detail{padding:18px 20px;overflow:auto;min-width:0}.import-detail__heading{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:12px}.import-detail h3{font-size:14px}.import-detail__heading span{font-size:11px;color:var(--text-sub)}fieldset{border:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:12px}fieldset label{display:grid;gap:6px;font-size:12px;color:var(--text-sub)}fieldset label:first-child,fieldset label:nth-child(4),fieldset label:nth-child(5){grid-column:1 / -1}textarea{resize:vertical;min-height:90px;line-height:1.6!important}.import-detail__actions{display:flex;gap:8px;justify-content:flex-end;margin:12px 0}.import-log{margin-top:14px;font-size:12px;color:var(--text-sub)}.import-log summary{cursor:pointer}.import-log pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;font-size:11px;padding:12px;background:var(--bg-card);border-radius:6px;margin-top:10px}.import-empty{padding:36px 20px;text-align:center;color:var(--text-sub);font-size:13px}.import-error{margin:0 22px 10px;color:var(--danger);font-size:12px;line-height:1.6}.import-progress{display:flex;align-items:center;gap:8px;padding:9px 22px;color:var(--text-sub);font-size:12px}.import-progress span{flex:1;min-width:0;overflow-wrap:anywhere}.import-progress button{text-decoration:underline}footer{display:flex;align-items:center;gap:10px;padding:14px 20px}footer>div{flex:1;display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:12px}footer>div button{display:flex;align-items:center;gap:4px;color:var(--text-sub);font-size:11px}.import-panel button:disabled,.import-panel fieldset:disabled{opacity:.55}.import-panel :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--accent);outline-offset:2px}.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:760px){.import-tools{flex-wrap:wrap}.import-body{grid-template-columns:minmax(210px,.8fr) minmax(230px,1fr)}footer{flex-wrap:wrap}footer>div{flex-basis:100%}}@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
