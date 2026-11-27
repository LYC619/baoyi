<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { confirmDialog } from '@/composables/useDialog'
import { errorMessage } from '@/utils'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X, ArrowUp, ArrowDown, BookOpen } from 'lucide-vue-next'
import { useImageStore } from '@/stores/image'
import type { ImageItem } from '@/types/image'
import ImageCover from './ImageCover.vue'
const props=defineProps<{id:string}>(),emit=defineEmits<{close:[];open:[item:ImageItem]}>(),store=useImageStore()
const collection=computed(()=>store.collections.find(c=>c.id===props.id)),name=ref(''),busy=ref(false),error=ref('')
const members=computed(()=>collection.value?.members.map(id=>store.items.find(i=>i.id===id)).filter((i):i is ImageItem=>!!i)||[])
watch(collection,c=>{name.value=c?.name||''},{immediate:true})
async function save(ids=collection.value?.members||[]){busy.value=true;error.value='';try{await window.baoyi.image.saveCollection(name.value,ids,props.id);await store.refresh()}catch(cause){error.value=errorMessage(cause)}finally{busy.value=false}}
async function move(id:string,delta:number){const ids=[...(collection.value?.members||[])],i=ids.indexOf(id),j=i+delta;if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];await save(ids)}
async function removeMember(id:string){const ids=collection.value?.members.filter(value=>value!==id)||[];if(ids.length)await save(ids);else await dissolve()}
async function dissolve(){if(!(await confirmDialog({ title: tr('拆分此合集？'), message: tr("仅解除合集归组，每册漫画记录与本地原文件均会保留。"), confirmText: tr('拆分合集') })))return;busy.value=true;try{await window.baoyi.image.removeCollection(props.id);await store.refresh();emit('close')}catch(cause){error.value=errorMessage(cause)}finally{busy.value=false}}
function onEscape(e: KeyboardEvent) { if (!e.defaultPrevented && !document.querySelector('dialog[open]') && e.key === 'Escape' && !busy.value) { e.preventDefault(); e.stopPropagation(); emit('close') } }
onMounted(() => document.addEventListener('keydown', onEscape))
onBeforeUnmount(() => document.removeEventListener('keydown', onEscape))
</script>
<template><Teleport to="body"><div class="im-overlay" @click.self="emit('close')"><section class="im-dialog collection-dialog" role="dialog" aria-modal="true" :aria-label="$t('漫画合集')"><header><div><h2>{{collection?.name||$t('合集')}}</h2><p>{{ $t("{p0} 册 · 每册保留独立阅读进度和原文件", {p0: (members.length)}) }}</p></div><button class="im-icon" :aria-label="$t('关闭合集')" @click="emit('close')"><X :size="20"/></button></header><form class="collection-name" @submit.prevent="save()"><input v-model="name" :aria-label="$t('合集名称')" maxlength="200"/><button class="im-button" :disabled="busy||!name.trim()">{{ $t("保存名称") }}</button></form><div class="collection-members"><article v-for="(item,index) in members" :key="item.id"><button class="collection-open" @click="emit('open',item)"><ImageCover :page-id="item.coverPageId" :name="item.name"/><span><strong>{{item.name}}</strong><small>{{ $t("{p0} 页 · {p1}", {p0: (item.pageCount), p1: (item.progress?$t('读到第 ')+(item.progress.ordinal+1)+$t(' 页'):$t('未读'))}) }}</small></span><BookOpen :size="18"/></button><div><button class="im-icon" :disabled="busy||index===0" :aria-label="$t('上移 ')+item.name" @click="move(item.id,-1)"><ArrowUp :size="16"/></button><button class="im-icon" :disabled="busy||index===members.length-1" :aria-label="$t('下移 ')+item.name" @click="move(item.id,1)"><ArrowDown :size="16"/></button><button class="im-button" :disabled="busy" @click="removeMember(item.id)">{{ $t("移出合集") }}</button></div></article></div><p v-if="error" class="im-error" role="alert">{{$systemMessage(error)}}</p><footer><button class="im-button" :disabled="busy" @click="dissolve">{{ $t("拆分合集，保留漫画") }}</button></footer></section></div></Teleport></template>
<style scoped>.collection-dialog{width:760px}.collection-name{display:flex;gap:10px;margin-bottom:18px}.collection-name input{flex:1;min-width:0}.collection-members{display:grid;gap:10px}.collection-members article{padding:9px;border:1px solid var(--divider);border-radius:7px}.collection-open{display:flex;width:100%;gap:14px;text-align:left;align-items:center;color:var(--text-main)}.collection-open>.image-cover{width:64px;flex:none}.collection-open>span{flex:1;min-width:0}.collection-open strong{display:block;overflow-wrap:anywhere;font-size:14px}.collection-open small{display:block;margin-top:9px;color:var(--text-sub)}.collection-members article>div{display:flex;justify-content:flex-end;gap:8px;margin-top:5px}</style>
