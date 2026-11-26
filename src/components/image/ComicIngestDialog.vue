<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'
import {computed,nextTick,onMounted,onUnmounted,ref,watch} from 'vue'
import {useRouter} from 'vue-router'
import {X,Download,FolderOpen,Loader2,BookOpen} from 'lucide-vue-next'
import {useComicIngest} from '@/composables/useComicIngest'
import {useImageStore} from '@/stores/image'
import type {ComicIngestPreview,ComicProxy} from '@/types/comic-ingest'
const props=withDefaults(defineProps<{embedded?:boolean;active?:boolean;request?:string;initialProxy?:ComicProxy}>(),{embedded:false,active:true,request:''}),emit=defineEmits<{close:[];tasks:[]}>()
const ingest=useComicIngest(),store=useImageStore(),router=useRouter()
const input=ref(props.request||ingest.request.value),mode=ref<ComicProxy['mode']>('system'),custom=ref('127.0.0.1:7890'),busy=ref(false),saving=ref(false),error=ref(''),preview=ref<ComicIngestPreview|null>(null),selected=ref<string[]>([]),directory=ref(''),group=ref(''),root=ref(''),targetLocked=ref(false),message=ref(''),dialog=ref<HTMLElement>(),field=ref<HTMLInputElement>()
const recovery=ingest.recovery.value
const available=computed(()=>preview.value?.catalog.chapters.filter(c=>recovery?recovery.selectedChapters.includes(c.id):!preview.value!.existingChapters.includes(c.id))||[])
const pages=computed(()=>available.value.filter(c=>selected.value.includes(c.id)).reduce((n,c)=>n+c.pageIds.length,0))
let generation=0,resolvedProxy='';const previous=document.activeElement as HTMLElement|null
async function chooseRoot(){try{const value=await window.baoyi.image.chooseDownloadRoot('jm',root.value);if(value)root.value=value}catch(cause){error.value=errorMessage(cause)}}
const proxy=():ComicProxy=>mode.value==='custom'?{mode:'custom',url:custom.value}:{mode:mode.value}
async function resolve(){
  if(busy.value||saving.value)return;const stamp=++generation,connection=proxy();busy.value=true;error.value='';preview.value=null
  try{const value=await window.baoyi.comic.preview(input.value,connection);if(stamp!==generation)return;preview.value=value;resolvedProxy=JSON.stringify(connection);directory.value=recovery?.directory||value.directory;selected.value=available.value.map(c=>c.id);const target=await window.baoyi.image.downloadTarget('jm',value.catalog.workId,group.value||null);if(stamp!==generation)return;root.value=recovery?.root||target.root;targetLocked.value=target.locked&&!recovery;if(target.locked)group.value=target.groupId||''}catch(e){if(stamp===generation)error.value=errorMessage(e)}finally{if(stamp===generation)busy.value=false}
}
async function close(){if(saving.value)return;generation++;if(props.embedded)emit('close');else ingest.open.value=false;await window.baoyi.comic.cancelPreview().catch(() => { /* best-effort */ })}
async function start(){
  if(!preview.value||saving.value||busy.value)return;if(!root.value){error.value=tr("请先选择漫画存放根目录");return;}saving.value=true;error.value=''
  const stamp=generation
  try{
    const connection=proxy()
    if(JSON.stringify(connection)!==resolvedProxy){
      // The existing API binds the download proxy to its preview token.
      // Refresh only when downloading, preserving the user's chapter selection.
      const refreshed=await window.baoyi.comic.preview(input.value,connection)
      if(stamp!==generation)return
      preview.value=refreshed
      resolvedProxy=JSON.stringify(connection)
      const valid=new Set(available.value.map(c=>c.id))
      if(selected.value.some(id=>!valid.has(id))){selected.value=selected.value.filter(id=>valid.has(id));throw new Error(tr('作品目录已变化，请核对所选章节后再下载'))}
    }
    const id=recovery?await window.baoyi.comic.revalidate(recovery.id,preview.value.token,root.value):await window.baoyi.comic.start(preview.value.token,[...selected.value],directory.value,group.value||null,root.value)
    if(id){await ingest.refresh();if(stamp!==generation)return;message.value=tr("已加入下载队列，完成后自动出现在漫画书架。");preview.value=null;selected.value=[];if(props.embedded&&props.active)emit('tasks');else if(!props.embedded){ingest.open.value=false;await nextTick();ingest.showRecords.value=true}}
  }catch(e){if(stamp===generation)error.value=errorMessage(e)}finally{saving.value=false}
}
function keys(event:KeyboardEvent){
  if(event.key==='Escape'){event.stopPropagation();void close()}
  if(event.key==='Tab'){
    const nodes=[...dialog.value!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el=>el.getClientRects().length)
    const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
  }
}
watch(input,()=>{generation++;preview.value=null;selected.value=[];error.value='';busy.value=false})
watch(()=>props.active,active=>{if(!active&&busy.value){generation++;busy.value=false;preview.value=null;void window.baoyi.comic.cancelPreview().catch(() => { /* best-effort */ })}})
onMounted(async()=>{field.value?.focus();const stamp=generation;try{const defaults=props.initialProxy?{proxy:props.initialProxy}:await window.baoyi.comic.defaults();if(stamp===generation&&!busy.value&&!preview.value){mode.value=defaults.proxy.mode;if(defaults.proxy.mode==='custom')custom.value=defaults.proxy.url}}catch (cause) { useToast().error(errorMessage(cause)) }if(props.embedded&&input.value&&stamp===generation)await resolve()})
onUnmounted(()=>{generation++;void window.baoyi.comic.cancelPreview().catch(() => { /* best-effort */ });previous?.focus()})
</script>
<template><Teleport to="body" :disabled="embedded"><div :class="embedded?'comic-embedded':'comic-shade'" @click.self="close"><section ref="dialog" :role="embedded?undefined:'dialog'" :aria-modal="embedded?undefined:true" aria-labelledby="comic-title" class="comic-dialog" @keydown="keys">
  <header><div><p>{{ $t("在线下载") }}</p><h2 id="comic-title">{{recovery?$t('核验并继续原任务'):$t('从 JM 添加作品')}}</h2></div><button class="im-button" :aria-label="embedded?$t('返回 JM 列表'):$t('关闭在线下载')" :disabled="saving" @click="close"><X :size="20"/></button></header>
  <div class="comic-body"><form @submit.prevent="resolve"><label class="im-field">{{ $t("作品编号或链接") }}<input ref="field" v-model="input" :disabled="busy||saving" :placeholder="$t('数字 ID、JM 编号或作品链接')"/></label>
    <div class="comic-proxy"><label class="im-field">{{ $t("连接方式") }}<select v-model="mode" :disabled="busy||saving"><option value="system">{{ $t("跟随系统代理") }}</option><option value="custom">{{ $t("指定代理") }}</option><option value="builtin">{{ $t("使用当前内置代理") }}</option></select></label><label v-if="mode==='custom'" class="im-field">{{ $t("代理地址") }}<input v-model="custom" :disabled="busy||saving" placeholder="127.0.0.1:7890"/></label></div>
    <p class="comic-hint">{{mode==='builtin'?$t('沿用设置中的代理；设置为空时直连。'):$t('仅用于在线漫画下载，会自动记住最近成功的连接方式。支持 HTTP 与 SOCKS5。')}}</p>
    <p v-if="recovery" class="comic-hint">{{ $t("重新读取来源后，选择原存放根目录。已保存的页面通过核验后继续使用。") }}</p>
    <button class="im-button im-primary" :disabled="!input.trim()||busy||saving"><Loader2 v-if="busy" class="spin" :size="17"/>{{busy?$t('正在读取作品与章节…'):$t('解析作品')}}</button>
  </form><p v-if="error" class="im-error" role="alert">{{$systemMessage(error)}}</p>
  <p v-if="message" role="status">{{message}}</p><section v-if="preview" class="comic-preview"><div class="comic-target"><label>{{ $t("存放根目录") }}<output>{{root||$t('请先选择存放位置')}}</output></label><button class="im-button" :disabled="saving||targetLocked" @click="chooseRoot">{{ $t("更改") }}</button><small v-if="targetLocked">{{ $t("补章沿用原位置") }}</small></div><img v-if="preview.catalog.cover" class="comic-cover" :src="preview.catalog.cover" :alt="$t('作品封面')"/><h3>{{preview.catalog.name}}</h3><p class="comic-hint">{{ $t("{p0} · {p1} 章", {p0: (preview.catalog.authors.join('、')||$t('未知作者')), p1: (preview.catalog.chapters.length)}) }}</p><p v-if="preview.catalog.description" class="comic-description">{{preview.catalog.description}}</p>
    <button v-if="preview.existingId" class="im-button" @click="ingest.open.value=false;router.push({name:'image-detail',params:{id:preview.existingId}})"><BookOpen :size="16"/>{{ $t("打开已有作品") }}</button>
    <div class="comic-selection"><strong>{{recovery?$t('原任务所选章节'):preview.existingId?$t('补齐缺失章节'):$t('选择保存章节')}}</strong><button v-if="!recovery" class="im-button" :disabled="saving" @click="selected=selected.length===available.length?[]:available.map(c=>c.id)">{{selected.length===available.length?$t('取消全选'):$t('全选')}}</button></div>
    <p v-if="!available.length" class="comic-hint">{{ $t("当前章节均已保存，可以直接开始阅读。") }}</p><div v-else class="comic-chapters"><label v-for="chapter in available" :key="chapter.id"><input v-model="selected" :value="chapter.id" type="checkbox" :disabled="saving||!!recovery"/><span>{{chapter.title||$t('第 {p0} 章', { p0: chapter.order })}}</span><small>{{ $t("{p0} 页", {p0: (chapter.pageIds.length)}) }}</small></label></div>
    <label class="im-field">{{ $t("存放目录名") }}<input v-model="directory" :disabled="saving||!!preview.existingId||!!recovery" maxlength="150"/></label><label v-if="!preview.existingId&&!recovery" class="im-field">{{ $t("归入分类") }}<select v-model="group" :disabled="saving"><option value="">{{ $t("未分类") }}</option><option v-for="item in store.groups.filter(g=>g.type==='comic'&&!g.hidden)" :key="item.id" :value="item.id">{{item.name}}</option></select></label>
  </section></div>
  <footer><p>{{ $t("{p0} 章 · {p1} 页", {p0: (selected.length), p1: (pages)}) }}<span>{{ $t("完成后自动出现在漫画书架") }}</span></p><button class="im-button im-primary" :disabled="!preview||!selected.length||!root||saving||busy" @click="start"><FolderOpen v-if="!saving" :size="17"/><Download v-else :size="17"/>{{saving?$t('正在核验并加入任务…'):recovery?$t('核验并继续'):$t('加入下载')}}</button></footer>
</section></div></Teleport></template>
<style scoped>
.comic-embedded .comic-dialog{width:100%;height:auto;box-shadow:none;background:transparent}.comic-embedded .comic-dialog header{padding:0 0 16px}.comic-embedded .comic-body{padding:18px 0;overflow:visible}.comic-embedded .comic-dialog footer{position:sticky;bottom:0;background:var(--bg-main);padding:14px 0}.comic-target{display:flex;gap:12px;align-items:center;clear:both;border:1px solid var(--divider);border-radius:8px;padding:12px;margin-bottom:18px}.comic-target label{flex:1;min-width:0;font-size:12px;color:var(--text-sub)}.comic-target output{display:block;margin-top:5px;color:var(--text-main);overflow-wrap:anywhere}.comic-embedded .comic-chapters{max-height:none;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;border:0}.comic-embedded .comic-chapters label{border:1px solid var(--divider);border-radius:7px;padding:10px}.comic-embedded .comic-chapters span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@media(max-width:900px){.comic-embedded .comic-chapters{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:700px){.comic-embedded .comic-chapters{grid-template-columns:repeat(2,minmax(0,1fr))}}

.comic-dialog .im-field input,.comic-dialog .im-field select{display:block;width:100%;box-sizing:border-box;min-height:38px;padding:8px 10px;border:1px solid var(--divider);border-radius:6px;background:var(--bg-card);color:var(--text-main);font:inherit}.comic-dialog input:focus,.comic-dialog select:focus{outline:2px solid var(--accent);outline-offset:2px}.comic-dialog .im-field{margin:0 0 16px}.comic-dialog input:disabled,.comic-dialog select:disabled{opacity:.65}
.comic-cover{float:left;width:90px;max-height:120px;object-fit:contain;margin:0 16px 16px 0;border-radius:5px}.comic-selection{clear:both}
.comic-shade{position:fixed;inset:0;background:#0008;z-index:1100;display:flex;justify-content:flex-end}.comic-dialog{width:min(620px,100vw);height:100%;background:var(--bg-main);color:var(--text-main);display:flex;flex-direction:column;box-shadow:-12px 0 48px #0003}.comic-dialog header,.comic-dialog footer{padding:22px 26px;display:flex;justify-content:space-between;align-items:center;gap:18px;border-bottom:1px solid var(--divider)}.comic-dialog header p{color:var(--text-sub);font-size:12px;margin:0 0 6px}.comic-dialog h2{margin:0;font-size:21px}.comic-body{padding:24px 26px;overflow:auto;flex:1}.comic-proxy{display:flex;gap:14px}.comic-proxy>label{flex:1;min-width:0}.comic-hint{font-size:12px;color:var(--text-sub);line-height:1.7}.comic-preview{border-top:1px solid var(--divider);margin-top:24px;padding-top:18px}.comic-preview h3{font-size:18px;line-height:1.6;margin:0;overflow-wrap:anywhere}.comic-description{font-size:13px;line-height:1.8;white-space:pre-wrap;max-height:130px;overflow:auto}.comic-selection{display:flex;justify-content:space-between;align-items:center;margin-top:18px;font-size:13px}.comic-chapters{max-height:260px;overflow:auto;margin:12px 0 20px;border:1px solid var(--divider);border-radius:8px}.comic-chapters label{padding:12px;display:flex;align-items:center;gap:10px;font-size:13px}.comic-chapters label+label{border-top:1px solid var(--divider)}.comic-chapters span{flex:1}.comic-chapters small{color:var(--text-sub)}.comic-dialog footer{border-top:1px solid var(--divider);border-bottom:0}.comic-dialog footer p{margin:0;font-size:13px}.comic-dialog footer span{display:block;margin-top:5px;color:var(--text-sub);font-size:11px}.spin{animation:comic-spin 1s linear infinite}@keyframes comic-spin{to{transform:rotate(360deg)}}
</style>
