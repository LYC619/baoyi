<script setup lang="ts">
import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'
import {computed,nextTick,onBeforeUnmount,onMounted,ref,watch,type Directive} from 'vue'
import {useComicIngest} from '@/composables/useComicIngest'
import {useImageStore} from '@/stores/image'
import type {ComicBrowseQuery,ComicBrowseWork,ComicProxy} from '@/types/comic-ingest'
import ComicIngestDialog from './ComicIngestDialog.vue'
const props=defineProps<{active:boolean}>(),emit=defineEmits<{tasks:[]}>(),ingest=useComicIngest()
let imageStore:ReturnType<typeof useImageStore>|null=null;try{imageStore=useImageStore()}catch{imageStore=null}
const ownedJmIds=computed(()=>new Set((imageStore?.items||[]).filter(i=>i.source==='jm'&&i.sourceId).map(i=>i.sourceId.replace(/^jm/i,''))))
const mode=ref<'ranking'|'search'|'direct'>('ranking'),period=ref<NonNullable<ComicBrowseQuery['period']>>('day'),scope=ref<NonNullable<ComicBrowseQuery['scope']>>('all'),query=ref(''),page=ref(1),pages=ref(0),results=ref<ComicBrowseWork[]>([]),covers=ref<Record<string,string>>({}),proxyMode=ref<ComicProxy['mode']>('system'),custom=ref('127.0.0.1:7890'),busy=ref(false),error=ref(''),detail=ref(ingest.request.value),parsed=ref(!!ingest.request.value||!!ingest.recovery.value)
const ready=ref(false)
let generation=0,disposed=false
const proxy=computed<ComicProxy>(()=>proxyMode.value==='custom'?{mode:'custom',url:custom.value}:{mode:proxyMode.value})
// Observe the cards inside their scroll container; only prefetch a nearby row.
const visibleCovers=new Set<string>(),attempted=new Set<string>(),coverQueue=new Set<string>()
let loadingCovers=0
const observer=new IntersectionObserver(entries=>{
  for(const entry of entries){const id=(entry.target as HTMLElement).dataset.coverId!;if(entry.isIntersecting)visibleCovers.add(id);else {visibleCovers.delete(id);coverQueue.delete(id)}}
  queueVisibleCovers()
},{rootMargin:'180px 0px'})
const vCover:Directive<HTMLElement,string>={
  mounted(element,{value}){element.dataset.coverId=value;observer.observe(element)},
  unmounted(element){const id=element.dataset.coverId!;visibleCovers.delete(id);coverQueue.delete(id);observer.unobserve(element)}
}
function queueVisibleCovers(){
  if(!props.active||parsed.value||disposed)return
  for(const id of visibleCovers)if(!covers.value[id]&&!attempted.has(id))coverQueue.add(id)
  pumpCovers()
}
function pumpCovers(){
  while(loadingCovers<3&&coverQueue.size&&props.active&&!parsed.value&&!disposed){
    const id=coverQueue.values().next().value!,own=generation;coverQueue.delete(id);attempted.add(id);loadingCovers++
    void window.baoyi.comic.cover(id,proxy.value).then(cover=>{if(own===generation&&!disposed&&props.active&&cover)covers.value[id]=cover}).catch(cause => useToast().error(errorMessage(cause))).finally(()=>{loadingCovers--;pumpCovers()})
  }
}
function cancelCovers(){generation++;coverQueue.clear();attempted.clear();busy.value=false;void window.baoyi.comic.cancelBrowse()}
async function browse(at=1){
  cancelCovers();const own=generation;busy.value=true;error.value='';results.value=[];covers.value={};pages.value=0
  try{await window.baoyi.comic.cancelBrowse();if(own!==generation||disposed)return;const response=await window.baoyi.comic.browse({mode:mode.value==='search'?'search':'ranking',page:at,period:period.value,scope:scope.value,query:query.value.trim()},proxy.value);if(own!==generation||disposed||!props.active)return;results.value=response.items;page.value=response.page;pages.value=response.pages;await nextTick();queueVisibleCovers()}catch(cause){if(own===generation&&!disposed)error.value=errorMessage(cause)}finally{if(own===generation)busy.value=false}
}
function open(id:string){cancelCovers();detail.value=id;parsed.value=true}
async function back(){parsed.value=false;detail.value='';ingest.request.value='';ingest.recovery.value=null;await nextBrowse();await nextTick();queueVisibleCovers()}
function switchMode(next:typeof mode.value){cancelCovers();mode.value=next;results.value=[];covers.value={};pages.value=0;page.value=1;error.value='';if(next==='ranking')void browse()}
async function nextBrowse(){if(ready.value&&props.active&&mode.value!=='direct'&&!results.value.length)await browse(page.value)}
watch([ingest.request,ingest.recovery],([value,recovery])=>{if(value||recovery){detail.value=value;parsed.value=true}})
watch(()=>props.active,async active=>{if(!active)cancelCovers();else {if(!parsed.value&&!results.value.length)await nextBrowse();await nextTick();queueVisibleCovers()}})
onMounted(async()=>{try{const defaults=await window.baoyi.comic.defaults();proxyMode.value=defaults.proxy.mode;if(defaults.proxy.mode==='custom')custom.value=defaults.proxy.url}catch (cause) { useToast().error(errorMessage(cause)) }ready.value=true;if(!disposed&&!parsed.value)await nextBrowse()})
onBeforeUnmount(()=>{disposed=true;cancelCovers();observer.disconnect()})
</script>
<template><section class="jm-browser">
  <p v-if="!ready" role="status">{{ $t("正在载入连接设置…") }}</p><ComicIngestDialog v-else-if="parsed" :key="detail+':'+(ingest.recovery.value?.id||'')" embedded :active="active" :request="detail" :initial-proxy="proxy" @close="back" @tasks="emit('tasks')"/>
  <template v-else>
    <details class="jm-connection"><summary>{{ $t("连接设置") }}</summary><label>{{ $t("连接方式") }}<select v-model="proxyMode"><option value="system">{{ $t("跟随系统代理") }}</option><option value="custom">{{ $t("指定代理") }}</option><option value="builtin">{{ $t("使用当前内置代理") }}</option></select></label><label v-if="proxyMode==='custom'">{{ $t("代理地址") }}<input v-model="custom" placeholder="127.0.0.1:7890"/></label><p>{{ $t("修改后用于下一次浏览、解析或下载。") }}</p></details>
    <nav class="source-tabs"><button class="im-button" :aria-pressed="mode==='ranking'" @click="switchMode('ranking')">{{ $t("排行榜") }}</button><button class="im-button" :aria-pressed="mode==='search'" @click="switchMode('search')">{{ $t("搜索") }}</button><button class="im-button" :aria-pressed="mode==='direct'" @click="switchMode('direct')">{{ $t("编号 / 链接") }}</button></nav>
    <form v-if="mode==='search'" class="jm-search" @submit.prevent="browse()"><select v-model="scope" :aria-label="$t('JM 搜索范围')"><option value="all">{{ $t("综合") }}</option><option value="author">{{ $t("作者") }}</option><option value="tag">{{ $t("标签") }}</option></select><input v-model="query" :aria-label="$t('搜索 JM')" :placeholder="$t('漫画名称、作者或标签')" maxlength="200"/><button class="im-button im-primary" :disabled="busy||!query.trim()">{{ $t("搜索作品") }}</button></form>
    <form v-else-if="mode==='direct'" class="jm-search" @submit.prevent="open(query)"><input v-model="query" :aria-label="$t('JM 编号或链接')" :placeholder="$t('作品编号或链接')"/><button class="im-button im-primary" :disabled="!query.trim()">{{ $t("打开作品") }}</button></form>
    <label v-else class="jm-period">{{ $t("榜单周期") }}<select v-model="period" :aria-label="$t('JM 榜单周期')" @change="browse()"><option value="day">{{ $t("日榜") }}</option><option value="week">{{ $t("周榜") }}</option><option value="month">{{ $t("月榜") }}</option><option value="all">{{ $t("总榜") }}</option></select></label>
    <p v-if="busy" role="status">{{ $t("正在连接 JM…") }}</p><p v-if="error" class="im-error" role="alert">{{$systemMessage(error)}} <button class="im-button" @click="browse(page)">{{ $t("重试") }}</button></p>
    <template v-if="mode!=='direct'"><div class="jm-results"><button v-for="work in results" :key="work.id" v-cover="work.id" class="jm-work" @click="open(work.id)"><div class="jm-cover"><img v-if="covers[work.id]" :src="covers[work.id]" decoding="async" :alt="work.title+$t('封面')"/><span v-else>{{work.title.charAt(0)}}</span><em v-if="ownedJmIds.has(String(work.id).replace(/^jm/i,''))" class="jm-owned">{{ $t("已入库") }}</em></div><strong>{{work.title}}</strong><small>JM {{work.id}}</small><span>{{work.tags.slice(0,3).join(' · ')}}</span></button></div><p v-if="!busy&&!error&&!results.length" class="jm-empty">{{mode==='search'?$t('输入关键词后搜索作品。'):$t('当前榜单暂无作品。')}}</p><footer v-if="pages"><button class="im-button" :disabled="busy||page<=1" @click="browse(page-1)">{{ $t("上一页") }}</button><span>{{page}} / {{pages}}</span><button class="im-button" :disabled="busy||page>=pages" @click="browse(page+1)">{{ $t("下一页") }}</button></footer></template>
  </template>
</section></template>
<style scoped>.jm-connection{font-size:12px;color:var(--text-sub);margin-bottom:16px}.jm-connection summary{cursor:pointer}.jm-connection label{display:inline-flex;gap:10px;align-items:center;margin:12px 16px 0 0}.source-tabs,.jm-search{display:flex;gap:10px;margin-bottom:18px;align-items:center}.jm-search input{flex:1;min-width:0}.jm-period{display:flex;gap:12px;align-items:center;margin-bottom:20px;font-size:12px}.jm-browser input,.jm-browser select{padding:9px;border:1px solid var(--divider);border-radius:6px;color:var(--text-main);background:var(--bg-card)}.jm-results{display:grid;grid-template-columns:repeat(auto-fill,minmax(135px,1fr));gap:22px 18px}.jm-work{display:flex;flex-direction:column;gap:6px;text-align:left;min-width:0}.jm-cover{position:relative;width:100%;aspect-ratio:3/4;display:grid;place-items:center;background:var(--hover-surface);border-radius:7px;overflow:hidden;font-size:30px;color:var(--text-sub)}.jm-owned{position:absolute;top:6px;right:6px;padding:2px 6px;border-radius:4px;font-style:normal;font-size:10px;background:var(--bg-card);color:var(--accent-ink,var(--accent));border:1px solid var(--divider)}.jm-cover img{width:100%;height:100%;object-fit:cover}.jm-work strong{font-size:13px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.jm-work small,.jm-work>span{font-size:11px;color:var(--text-sub)}.jm-browser footer{display:flex;justify-content:center;align-items:center;gap:18px;margin-top:24px;font-size:12px}.jm-empty{padding:35px;color:var(--text-sub);text-align:center;font-size:13px}</style>
