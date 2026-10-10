<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowRight, Loader2, X } from 'lucide-vue-next'
import type { VideoLayoutPreview, VideoLayoutResult } from '@/types/video-organize'
import { errorMessage } from '@/utils'

const props = defineProps<{ ids: string[]; pending?: boolean }>()
const emit = defineEmits<{ close: []; changed: []; busy: [value: boolean] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const preview = ref<VideoLayoutPreview | null>(null)
const result = ref<VideoLayoutResult | null>(null)
const busy = ref(false), loading = ref(true), failure = ref('')
watch(busy, value => emit('busy', value), { flush: 'sync' })
const actionLabel = { 'move-directory': '移动整个目录', 'move-files': '搬文件进新目录', 'in-place': '已就位', skip: '这次不动' } as const
const summary = computed(() => {
  const entries = preview.value?.entries ?? []
  return { move: preview.value?.movable ?? 0, inPlace: entries.filter(e => e.action === 'in-place').length, skip: entries.filter(e => e.action === 'skip').length }
})
async function load(): Promise<void> {
  loading.value = true; failure.value = ''
  try { preview.value = await window.baoyi.videoOrganize.layoutPreview([...props.ids]) }
  catch (error) { failure.value = errorMessage(error) }
  finally { loading.value = false }
}
async function apply(): Promise<void> {
  if (props.pending || busy.value || !preview.value?.movable) return
  busy.value = true; failure.value = ''
  try { result.value = await window.baoyi.videoOrganize.layoutApply([...props.ids]); emit('changed') }
  catch (error) { failure.value = errorMessage(error) }
  finally { busy.value = false }
}
onMounted(() => { dialog.value?.showModal(); void load() })
onBeforeUnmount(() => dialog.value?.close())
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="layout" aria-labelledby="layout-title" @cancel.prevent="!busy && emit('close')" @click="($event.target === dialog && !busy) && emit('close')">
      <header>
        <div><h2 id="layout-title">统一移动</h2><p>把已入库的视频挪成「整理根目录 / 收藏分组 / 作品文件夹」；没有分组的直接放在根目录下。移动的是文件本身，观看记录和资料跟着走。</p></div>
        <button type="button" :disabled="busy" aria-label="关闭统一移动" @click="emit('close')"><X :size="18" /></button>
      </header>
      <p v-if="loading" class="layout__hint">正在核对每部作品的位置…</p>
      <p v-if="failure" class="layout__error" role="alert">{{ failure }}</p>
      <template v-if="preview && !result">
        <p class="layout__hint">整理根目录：<span class="mono">{{ preview.root }}</span>。要移动 {{ summary.move }} 部，已就位 {{ summary.inPlace }} 部，这次不动 {{ summary.skip }} 部。</p>
        <ul class="layout__list" aria-label="移动计划">
          <li v-for="entry in preview.entries" :key="entry.resourceId" :class="'layout__row--' + entry.action">
            <div class="layout__head"><strong>{{ entry.title }}</strong><span class="layout__tag">{{ actionLabel[entry.action] }}</span><span v-if="entry.group" class="layout__group">分组：{{ entry.group }}</span></div>
            <p v-if="entry.action === 'move-directory' || entry.action === 'move-files'" class="layout__path mono"><span>{{ entry.from }}</span><ArrowRight :size="13" /><span>{{ entry.to }}</span></p>
            <p v-if="entry.reason" class="layout__reason">{{ entry.reason }}</p>
          </li>
        </ul>
      </template>
      <template v-if="result">
        <p class="layout__hint">完成 {{ result.outcomes.filter(o => o.ok).length }} 部，{{ result.outcomes.filter(o => !o.ok).length }} 部未处理。移动记录：<span class="mono">{{ result.record }}</span></p>
        <ul class="layout__list" aria-label="移动结果">
          <li v-for="outcome in result.outcomes" :key="outcome.resourceId" :class="outcome.ok ? 'layout__row--ok' : 'layout__row--skip'"><div class="layout__head"><strong>{{ outcome.title }}</strong></div><p class="layout__reason">{{ outcome.message }}</p></li>
        </ul>
      </template>
      <footer>
        <button type="button" class="btn btn--ghost" :disabled="busy" @click="emit('close')">{{ result ? '关闭' : '取消' }}</button>
        <button v-if="!result" type="button" class="btn btn--primary" :disabled="pending || busy || loading || !preview?.movable" @click="apply"><Loader2 v-if="busy" class="spin" :size="14" />{{ busy ? '正在移动…' : `开始移动 ${summary.move} 部` }}</button>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.layout { width: min(760px, calc(100vw - 36px)); max-height: calc(100vh - 48px); margin: auto; border: 1px solid var(--divider); border-radius: 12px; background: var(--bg-elevated); color: var(--text-main); padding: 23px; box-shadow: var(--shadow-pop); display: flex; flex-direction: column; gap: 16px; }
.layout::backdrop { background: rgba(10, 10, 20, .55); }
.layout header { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
.layout header button { color: var(--text-sub); padding: 3px; }
.layout h2 { font-size: 17px; font-weight: 600; }
.layout header p, .layout__hint { margin-top: 7px; color: var(--text-sub); font-size: 12px; line-height: 1.7; }
.layout__list { list-style: none; margin: 0; padding: 0; overflow: auto; display: grid; gap: 8px; }
.layout__list li { padding: 10px 12px; border-radius: 7px; background: var(--bg-main); font-size: 12px; }
.layout__row--skip { opacity: .7; }
.layout__row--ok .layout__reason { color: var(--text-sub); }
.layout__head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.layout__head strong { font-weight: 500; overflow-wrap: anywhere; }
.layout__tag { padding: 1px 7px; border-radius: 999px; border: 1px solid var(--card-border); color: var(--text-sub); font-size: 11px; }
.layout__row--move-directory .layout__tag, .layout__row--move-files .layout__tag { color: var(--accent); border-color: var(--accent); }
.layout__group { color: var(--text-faint); }
.layout__path { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; color: var(--text-sub); overflow-wrap: anywhere; }
.layout__reason { margin-top: 5px; color: var(--text-sub); }
.layout__row--skip .layout__reason { color: var(--danger); }
.layout__error { color: var(--danger); font-size: 12px; }
.layout footer { display: flex; justify-content: flex-end; gap: 8px; }
.layout :is(button):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
