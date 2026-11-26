<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useToast } from '@/composables/useToast'
import { ArrowLeft, ArrowRight, ListChecks, X, Heart, Check } from 'lucide-vue-next'
import type { ImageGroup, ImageItem, ImageType } from '@/types/image'
import ImageCover from './ImageCover.vue'
import { vMasonry } from '@/composables/masonry'
import ImageBulkPanel from './ImageBulkPanel.vue'
import { imageShelfEntries, type ImageShelfEntry } from '@/utils/image-shelf'
import { libraryBlocks, type LibraryGrouping } from '@/utils/library-grouping'
const props = defineProps<{ items: ImageItem[]; groups: ImageGroup[]; type: ImageType; layout: string; queryKey: string; page: number; grouping?:LibraryGrouping; cardSize?:number; roots?:string[]; heading?:string; pending?:boolean; autoSelect?:boolean }>()
const emit = defineEmits<{ open: [item: ImageItem]; collection:[id:string]; 'update:page': [page: number]; 'auto-select-consumed': [] }>()
const selecting = ref(false), selected = ref(new Set<string>()), busy = ref(false), notice = ref(''), shelf = ref<HTMLElement>()
watch(() => props.autoSelect, v => { if (v) { selecting.value = true; selected.value = new Set(); emit('auto-select-consumed') } }, { immediate: true })
const { toast } = useToast()
const selectionTrigger = ref<HTMLButtonElement>()
function toggleSelecting() {
  if (busy.value) return
  selecting.value = !selecting.value
  selected.value = new Set()
  notice.value = ''
  if (!selecting.value) selectionTrigger.value?.focus()
}
onBeforeRouteLeave(() => { if (busy.value) { toast(tr("正在处理所选内容，请稍后再离开")); return false } return true })
function keys(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  if (!selecting.value || busy.value || event.defaultPrevented || target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '')) return
  if (event.key === 'Escape') { event.preventDefault(); toggleSelecting() }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); if (props.pending) return; if (props.items.length <= 5000) selected.value = new Set(props.items.map(item => item.id)); else notice.value = tr("一次最多选择 5000 项") }
}
const entries=computed(()=>imageShelfEntries(props.items))
const pageCount = computed(() => Math.max(1, Math.ceil(entries.value.length / 60)))
const current = computed(() => Math.min(pageCount.value, Math.max(1, props.page)))
const shownEntries=computed(()=>entries.value.slice((current.value-1)*60,current.value*60))
const shown = computed(() => shownEntries.value.flatMap(entry=>entry.members))
const blocks=computed(()=>libraryBlocks(shownEntries.value,props.grouping||'none',entry=>props.groups.find(g=>g.id===entry.item.groupId)?.name||tr("未分类"),entry=>entry.item.path,props.roots||[]))
function toggleEntry(entry:ImageShelfEntry){if(props.pending||busy.value)return;const next=new Set(selected.value),all=entry.members.every(item=>next.has(item.id));for(const item of entry.members){if(all)next.delete(item.id);else next.add(item.id)}if(next.size>5000){notice.value=tr("一次最多选择 5000 项");return}selected.value=next}
function openEntry(entry:ImageShelfEntry){if(selecting.value)toggleEntry(entry);else if(entry.item.collectionId)emit('collection',entry.item.collectionId);else emit('open',entry.item)}
const allPage = computed(() => shown.value.length > 0 && shown.value.every(item => selected.value.has(item.id)))
const partialPage = computed(() => !allPage.value && shown.value.some(item => selected.value.has(item.id)))
watch(() => props.queryKey, () => { selected.value = new Set(); notice.value = ''; emit('update:page', 1) })
watch(() => props.items, items => { const available = new Set(items.map(i => i.id)); selected.value = new Set([...selected.value].filter(id => available.has(id))); if (props.page > pageCount.value) emit('update:page', pageCount.value) })
function selectPage() {
  if (busy.value) return
  const next = new Set(selected.value)
  if (!allPage.value && next.size + shown.value.filter(item => !next.has(item.id)).length > 5000) { notice.value = tr("一次最多选择 5000 项"); return }
  for (const item of shown.value) { if (allPage.value) next.delete(item.id); else next.add(item.id) }
  selected.value = next; notice.value = ''
}
function changePage(value: number) { emit('update:page', value); shelf.value?.scrollIntoView({ block: 'start' }) }
function finish(count: number) { selected.value = new Set(); notice.value = tr("已更新 {p0} 项", {p0: (count)}) }
</script>
<template>
  <div ref="shelf" class="image-shelf-view" @keydown="keys">
    <div class="shelf-controls">
      <h2 v-if="heading">{{heading}}</h2><span v-if="!selecting" class="shelf-count">{{items.length}} {{type==='comic'?$t('部作品'):$t('个相册')}}</span>
      <button ref="selectionTrigger" class="im-button" :aria-label="$t('批量整理')" :title="selecting?$t('退出批量整理'):$t('批量整理')" :aria-pressed="selecting" :disabled="busy" @click="toggleSelecting"><X v-if="selecting" :size="18" /><ListChecks v-else :size="18" />{{selecting?$t('退出批量整理'):$t('批量整理')}}</button>
      <template v-if="selecting"><label><input type="checkbox" :aria-label="$t('选择当前页')" :checked="allPage" :indeterminate="partialPage" :disabled="pending||busy||!shown.length" @change="selectPage" />{{ $t("当前页") }}</label><button class="im-button" :aria-label="$t('全选筛选结果')" :disabled="pending||busy||!items.length||items.length>5000" @click="selected=new Set(items.map(i=>i.id));notice=''">{{ $t("全选结果") }}</button><button v-if="selected.size" class="im-button" :disabled="busy" @click="selected=new Set()">{{ $t("清空选择") }}</button><output :aria-label="$t('所选数量')">{{ $t("已选 {p0} / {p1}", {p0: (selected.size), p1: (items.length)}) }}</output></template>
      <p v-if="notice" role="status">{{ notice }}</p>
      <nav v-if="pageCount>1" :aria-label="$t('书架分页')"><button class="im-icon" :aria-label="$t('上一页书架')" :title="$t('上一页')" :disabled="current===1||busy" @click="changePage(current-1)"><ArrowLeft :size="18" /></button><output :aria-label="$t('书架页码')">{{ current }} / {{ pageCount }}</output><button class="im-icon" :aria-label="$t('下一页书架')" :title="$t('下一页')" :disabled="current===pageCount||busy" @click="changePage(current+1)"><ArrowRight :size="18" /></button></nav>
    </div>
    <p v-if="selecting && pending" role="status" class="shelf-pending">{{ $t("当前结果尚未就绪，刷新后可继续操作。") }}</p>
    <ImageBulkPanel v-if="selecting" :pending="pending" :ids="[...selected]" :groups="groups" :type="type" @applied="finish" @busy="busy=$event" />
    <section v-for="block in blocks" :key="block.key" class="shelf-group"><h3 v-if="block.name">{{block.name}} <small>{{block.items.length}}</small></h3>
    <div class="image-shelf" :class="{'image-shelf--list':layout==='list','image-shelf--photo':type!=='comic'}" :style="{'--photo-size':(cardSize||220)+'px',...(cardSize&&layout!=='list'&&layout!=='adaptive'?{gridTemplateColumns:`repeat(auto-fill,minmax(min(100%,${cardSize}px),1fr))`}:{})}" :data-layout="layout">
      <article v-for="entry in block.items" :key="entry.id" v-masonry="layout==='adaptive'" class="image-card" :class="{selected:entry.members.every(item=>selected.has(item.id))}">
        <label v-if="selecting" class="shelf-select"><input type="checkbox" :aria-label="$t('选择 {p0}', {p0: entry.name})" :checked="entry.members.every(item=>selected.has(item.id))" :disabled="pending||busy" @change="toggleEntry(entry)" /></label>
        <button class="image-card__open" :disabled="busy||(selecting&&pending)" @click="openEntry(entry)"><ImageCover :page-id="entry.item.coverPageId" :revision="entry.item.type!=='comic'?entry.item.updatedAt:undefined" :name="entry.name" :photo="entry.item.type!=='comic'" :shape="type!=='comic'?layout:undefined"/><div class="image-card__info"><strong>{{entry.name}}</strong><p v-if="entry.item.authors?.length" class="image-card__authors">{{entry.item.authors.join("、")}}</p><p><template v-if="entry.item.collectionId">{{ $t("合集 · {p0} 册 ·", {p0: (entry.members.length)}) }}</template><template v-else-if="entry.item.type==='comic'">{{ $t("{p0} 章 ·", {p0: (entry.item.chapterCount)}) }}</template>{{entry.members.reduce((n,i)=>n+i.pageCount,0)}} {{type==='comic'?$t('页'):$t('张')}}<Heart v-if="entry.item.favorite" :size="13"/></p><span v-if="type==='comic' && entry.members.every(item=>item.read)" class="shelf-read"><Check :size="12"/>{{ $t("已读") }}</span></div></button>
      </article>
    </div></section>
    <nav v-if="pageCount>1" class="shelf-bottom" :aria-label="$t('底部书架分页')"><button class="im-icon" :aria-label="$t('上一页书架底部')" :title="$t('上一页')" :disabled="current===1||busy" @click="changePage(current-1)"><ArrowLeft :size="18" /></button><output>{{ current }} / {{ pageCount }}</output><button class="im-icon" :aria-label="$t('下一页书架底部')" :title="$t('下一页')" :disabled="current===pageCount||busy" @click="changePage(current+1)"><ArrowRight :size="18" /></button></nav>
  </div>
</template>
<style scoped>
.shelf-pending{font-size:12px;color:var(--text-sub);margin:0 0 8px}.shelf-controls h2{font-size:18px;margin:0}.shelf-count{font-size:12px;color:var(--text-sub)}.shelf-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px;min-height:36px}.shelf-controls>label{display:flex;align-items:center;gap:7px;color:var(--text-sub);white-space:nowrap}.shelf-controls output{font-size:12px;color:var(--text-sub);font-variant-numeric:tabular-nums}.shelf-controls>p{margin:0;color:var(--success);font-size:12px}.shelf-controls nav{margin-left:auto}.shelf-controls nav,.shelf-bottom{display:flex;align-items:center;gap:12px}.shelf-controls nav output,.shelf-bottom output{min-width:60px;text-align:center;font-variant-numeric:tabular-nums}.shelf-bottom{justify-content:center;margin-top:24px}.shelf-controls .im-icon,.shelf-bottom .im-icon{width:34px;height:34px}.shelf-controls [aria-pressed=true]{background:var(--active-surface);color:var(--accent)}.image-shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:20px}.image-shelf--photo{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}.image-card{position:relative;display:block;min-width:0;background:var(--bg-card);border:1px solid var(--divider);border-radius:7px;overflow:hidden;color:var(--text-main);transition:transform .15s,box-shadow .15s}.image-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-card-hover)}.image-card.selected{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.image-card__open{display:block;width:100%;text-align:left;color:inherit}.image-card__info{padding:12px;position:relative;min-height:74px}.image-card strong{font-size:14px;font-weight:500;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.image-card p{display:flex;align-items:center;flex-wrap:wrap;gap:4px;color:var(--text-sub);font-size:11px;margin:8px 0 0}.image-card p svg{margin-left:auto;color:var(--accent)}.shelf-select{position:absolute;top:8px;left:8px;z-index:2;width:26px;height:26px;border-radius:4px;display:flex;align-items:center;justify-content:center;background:var(--bg-card)}.shelf-select input{margin:0;width:17px;height:17px}.shelf-read{display:inline-flex;align-items:center;gap:3px;position:absolute;bottom:calc(100% + 7px);right:7px;background:var(--bg-card);color:var(--text-sub);padding:3px 5px;border-radius:4px;font-size:10px}.image-shelf--list{grid-template-columns:1fr}.image-shelf--list .image-card__open{display:flex;align-items:center;gap:13px}.image-shelf--list .image-cover{width:62px}.image-shelf--list .image-card__info{flex:1;min-width:0;padding-right:65px}.image-shelf--list .shelf-read{bottom:12px;right:12px}@media(min-width:1650px){.image-shelf:not(.image-shelf--list):not(.image-shelf--photo){grid-template-columns:repeat(auto-fill,minmax(195px,1fr))}}@media(max-width:1100px){.image-shelf{gap:16px;grid-template-columns:repeat(auto-fill,minmax(145px,1fr))}.image-shelf--list{grid-template-columns:1fr}.image-shelf--photo{grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}.shelf-controls{gap:8px}}
</style>

<style scoped>.shelf-group{margin-bottom:26px}.shelf-group h3{font-size:16px;font-weight:500;margin:0 0 14px}.shelf-group small{color:var(--text-faint);font-size:12px;margin-left:8px}</style>

<style scoped>.image-shelf[data-layout=adaptive]{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--photo-size)),1fr));grid-auto-rows:4px;grid-auto-flow:row dense;gap:0 16px;align-items:start}.image-shelf--photo .image-card__info{min-height:65px}.shelf-group{min-width:0}</style>
