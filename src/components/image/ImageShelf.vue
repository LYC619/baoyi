<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, ListChecks, X, Heart, Check } from 'lucide-vue-next'
import type { ImageGroup, ImageItem, ImageType } from '@/types/image'
import ImageCover from './ImageCover.vue'
import ImageBulkPanel from './ImageBulkPanel.vue'
const props = defineProps<{ items: ImageItem[]; groups: ImageGroup[]; type: ImageType; layout: string; queryKey: string; page: number }>()
const emit = defineEmits<{ open: [item: ImageItem]; 'update:page': [page: number] }>()
const selecting = ref(false), selected = ref(new Set<string>()), busy = ref(false), notice = ref(''), shelf = ref<HTMLElement>()
const pageCount = computed(() => Math.max(1, Math.ceil(props.items.length / 60)))
const current = computed(() => Math.min(pageCount.value, Math.max(1, props.page)))
const shown = computed(() => props.items.slice((current.value - 1) * 60, current.value * 60))
const allPage = computed(() => shown.value.length > 0 && shown.value.every(item => selected.value.has(item.id)))
const partialPage = computed(() => !allPage.value && shown.value.some(item => selected.value.has(item.id)))
watch(() => props.queryKey, () => { selected.value = new Set(); notice.value = ''; emit('update:page', 1) })
watch(() => props.items, items => { const available = new Set(items.map(i => i.id)); selected.value = new Set([...selected.value].filter(id => available.has(id))); if (props.page > pageCount.value) emit('update:page', pageCount.value) })
function toggle(id: string) { const next = new Set(selected.value); if (next.has(id)) next.delete(id); else if (next.size < 5000) next.add(id); else { notice.value = '一次最多选择 5000 项'; return } selected.value = next; notice.value = '' }
function selectPage() {
  const next = new Set(selected.value)
  if (!allPage.value && next.size + shown.value.filter(item => !next.has(item.id)).length > 5000) { notice.value = '一次最多选择 5000 项'; return }
  for (const item of shown.value) { if (allPage.value) next.delete(item.id); else next.add(item.id) }
  selected.value = next; notice.value = ''
}
function changePage(value: number) { emit('update:page', value); shelf.value?.scrollIntoView({ block: 'start' }) }
function finish(count: number) { selected.value = new Set(); notice.value = `已更新 ${count} 项` }
</script>
<template>
  <div ref="shelf" class="image-shelf-view">
    <div class="shelf-controls">
      <button class="im-icon" aria-label="批量整理" :title="selecting?'退出批量整理':'批量整理'" :aria-pressed="selecting" :disabled="busy" @click="selecting=!selecting;selected=new Set();notice=''"><X v-if="selecting" :size="18" /><ListChecks v-else :size="18" /></button>
      <template v-if="selecting"><label><input type="checkbox" aria-label="选择当前页" :checked="allPage" :indeterminate="partialPage" :disabled="busy||!shown.length" @change="selectPage" />当前页</label><button class="im-button" aria-label="全选筛选结果" :disabled="busy||!items.length||items.length>5000" @click="selected=new Set(items.map(i=>i.id));notice=''">全选结果</button><output aria-label="所选数量">已选 {{ selected.size }} / {{ items.length }}</output></template>
      <p v-if="notice" role="status">{{ notice }}</p>
      <nav v-if="pageCount>1" aria-label="书架分页"><button class="im-icon" aria-label="上一页书架" title="上一页" :disabled="current===1||busy" @click="changePage(current-1)"><ArrowLeft :size="18" /></button><output aria-label="书架页码">{{ current }} / {{ pageCount }}</output><button class="im-icon" aria-label="下一页书架" title="下一页" :disabled="current===pageCount||busy" @click="changePage(current+1)"><ArrowRight :size="18" /></button></nav>
    </div>
    <ImageBulkPanel v-if="selecting" :ids="[...selected]" :groups="groups" :type="type" @applied="finish" @busy="busy=$event" />
    <div class="image-shelf" :class="{'image-shelf--list':layout==='list','image-shelf--photo':type==='photo'}">
      <article v-for="item in shown" :key="item.id" class="image-card" :class="{selected:selected.has(item.id)}">
        <label v-if="selecting" class="shelf-select"><input type="checkbox" :aria-label="`选择 ${item.name}`" :checked="selected.has(item.id)" :disabled="busy" @change="toggle(item.id)" /></label>
        <button class="image-card__open" :disabled="busy" @click="selecting?toggle(item.id):emit('open',item)"><ImageCover :page-id="item.coverPageId" :name="item.name" :photo="item.type==='photo'" /><div class="image-card__info"><strong>{{ item.name }}</strong><p><template v-if="item.type==='comic'">{{ item.chapterCount }} 章 · </template>{{ item.pageCount }} 页 <template v-if="item.publication!=='unknown'">· {{ item.publication==='completed'?'完结':'连载中' }}</template><Heart v-if="item.favorite" :size="13" /></p><span v-if="item.read" class="shelf-read"><Check :size="12" />已读</span></div></button>
      </article>
    </div>
    <nav v-if="pageCount>1" class="shelf-bottom" aria-label="底部书架分页"><button class="im-icon" aria-label="上一页书架底部" title="上一页" :disabled="current===1||busy" @click="changePage(current-1)"><ArrowLeft :size="18" /></button><output>{{ current }} / {{ pageCount }}</output><button class="im-icon" aria-label="下一页书架底部" title="下一页" :disabled="current===pageCount||busy" @click="changePage(current+1)"><ArrowRight :size="18" /></button></nav>
  </div>
</template>
<style scoped>
.shelf-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;min-height:36px}.shelf-controls>label{display:flex;align-items:center;gap:7px;color:var(--text-sub);white-space:nowrap}.shelf-controls output{font-size:12px;color:var(--text-sub);font-variant-numeric:tabular-nums}.shelf-controls>p{margin:0;color:var(--success);font-size:12px}.shelf-controls nav{margin-left:auto}.shelf-controls nav,.shelf-bottom{display:flex;align-items:center;gap:12px}.shelf-controls nav output,.shelf-bottom output{min-width:60px;text-align:center;font-variant-numeric:tabular-nums}.shelf-bottom{justify-content:center;margin-top:24px}.shelf-controls .im-icon,.shelf-bottom .im-icon{width:34px;height:34px}.shelf-controls [aria-pressed=true]{background:var(--active-surface);color:var(--accent)}.image-shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:20px}.image-shelf--photo{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}.image-card{position:relative;display:block;min-width:0;background:var(--bg-card);border:1px solid var(--divider);border-radius:7px;overflow:hidden;color:var(--text-main);transition:transform .15s,box-shadow .15s}.image-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-card-hover)}.image-card.selected{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.image-card__open{display:block;width:100%;text-align:left;color:inherit}.image-card__info{padding:12px;position:relative;min-height:74px}.image-card strong{font-size:14px;font-weight:500;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.image-card p{display:flex;align-items:center;flex-wrap:wrap;gap:4px;color:var(--text-sub);font-size:11px;margin:8px 0 0}.image-card p svg{margin-left:auto;color:var(--accent)}.shelf-select{position:absolute;top:8px;left:8px;z-index:2;width:26px;height:26px;border-radius:4px;display:flex;align-items:center;justify-content:center;background:var(--bg-card)}.shelf-select input{margin:0;width:17px;height:17px}.shelf-read{display:inline-flex;align-items:center;gap:3px;position:absolute;bottom:calc(100% + 7px);right:7px;background:var(--bg-card);color:var(--text-sub);padding:3px 5px;border-radius:4px;font-size:10px}.image-shelf--list{grid-template-columns:1fr}.image-shelf--list .image-card__open{display:flex;align-items:center;gap:13px}.image-shelf--list .image-cover{width:62px}.image-shelf--list .image-card__info{flex:1;min-width:0;padding-right:65px}.image-shelf--list .shelf-read{bottom:12px;right:12px}@media(min-width:1650px){.image-shelf:not(.image-shelf--list):not(.image-shelf--photo){grid-template-columns:repeat(auto-fill,minmax(195px,1fr))}}@media(max-width:1100px){.image-shelf{gap:16px;grid-template-columns:repeat(auto-fill,minmax(145px,1fr))}.image-shelf--list{grid-template-columns:1fr}.image-shelf--photo{grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}.shelf-controls{gap:8px}}
</style>
