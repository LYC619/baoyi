<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { SlidersHorizontal, X } from 'lucide-vue-next'
import type { VideoLibraryFilters } from '@/types'
const props = defineProps<{ modelValue: VideoLibraryFilters }>()
const emit = defineEmits<{ 'update:modelValue': [value: VideoLibraryFilters] }>()
const root = ref<HTMLElement | null>(null), open = ref(false)
const draft = reactive({ ...props.modelValue })
const count = computed(() => Number(!!(props.modelValue.publishedFrom || props.modelValue.publishedTo)) + Number(!!props.modelValue.status) + Number(!!props.modelValue.local))
async function toggle() { open.value = !open.value; if (open.value) { Object.assign(draft, props.modelValue); await nextTick(); root.value?.querySelector('input')?.focus() } }
function apply() { emit('update:modelValue', { ...draft }); open.value = false; root.value?.querySelector('button')?.focus() }
function clear() { Object.assign(draft, { publishedFrom:'',publishedTo:'',status:'',local:'' }); apply() }
function outside(e: PointerEvent) { if (open.value && !root.value?.contains(e.target as Node)) open.value = false }
onMounted(() => document.addEventListener('pointerdown', outside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside))
</script>
<template>
  <div ref="root" class="video-filters" @keydown.esc.stop="open = false">
    <button class="btn btn--ghost filter-trigger" type="button" :class="{ active: count }" :aria-expanded="open" aria-controls="video-filters-panel" @click="toggle"><SlidersHorizontal :size="15" />筛选<span v-if="count" class="filter-count">{{ count }}</span></button>
    <form v-if="open" id="video-filters-panel" class="filter-panel" aria-label="筛选影视" @submit.prevent="apply">
      <header><strong>筛选影视</strong><button class="btn btn--subtle" type="button" aria-label="关闭筛选" @click="open = false"><X :size="14" /></button></header>
      <fieldset><legend>发布时间</legend><div class="date-range"><label>开始日期<input v-model="draft.publishedFrom" type="date" :max="draft.publishedTo || undefined" /></label><span>—</span><label>结束日期<input v-model="draft.publishedTo" type="date" :min="draft.publishedFrom || undefined" /></label></div><p>合集任意一集在此期间发布即可匹配。</p></fieldset>
      <label>观看状态<select v-model="draft.status"><option value="">不限</option><option value="unwatched">想看</option><option value="watching">在看</option><option value="watched">看完</option><option value="dropped">弃</option></select></label>
      <label>本地内容<select v-model="draft.local"><option value="">不限</option><option value="available">有可用视频</option><option value="missing">文件失联</option><option value="none">无可用视频</option></select></label>
      <footer><button class="btn btn--ghost" type="button" @click="clear">清空筛选</button><button class="btn btn--primary" type="submit">应用筛选</button></footer>
    </form>
  </div>
</template>
<style scoped>
.video-filters { position: relative; flex: none; }
.filter-trigger.active { color: var(--accent); }
.filter-count { display: inline-grid; place-items: center; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 5px; background: var(--accent); color: #fff; font-size: 10px; }
.filter-panel { position: absolute; z-index: 40; top: calc(100% + 9px); right: 0; width: min(350px, calc(100vw - 40px)); padding: 16px; display: grid; gap: 17px; border: 1px solid var(--card-border); border-radius: 10px; background: var(--bg-card); box-shadow: 0 12px 36px #0003; }
header, footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
header strong { font-size: 14px; font-weight: 600; }
fieldset { border: 0; min-width: 0; padding: 0; }
legend { margin-bottom: 9px; font-size: 12px; }
label { display: grid; gap: 6px; color: var(--text-sub); font-size: 12px; }
input, select { min-width: 0; width: 100%; height: 32px; border: 1px solid var(--card-border); border-radius: var(--radius-input); padding: 0 8px; background: var(--bg-main); color: var(--text-main); font: inherit; }
.date-range { display: grid; grid-template-columns: minmax(0,1fr) auto minmax(0,1fr); gap: 8px; align-items: end; }
.date-range > span { padding-bottom: 8px; color: var(--text-faint); }
fieldset p { font-size: 11px; color: var(--text-faint); margin-top: 8px; line-height: 1.5; }
footer { padding-top: 4px; }
</style>
