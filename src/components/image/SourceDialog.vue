<script setup lang="ts">
import {nextTick,onMounted,onBeforeUnmount,ref,watch} from 'vue'
import './image.css'
import {X} from 'lucide-vue-next'
import {useComicIngest} from '@/composables/useComicIngest'
import PicaSourceBrowser from './PicaSourceBrowser.vue'
import JmSourceBrowser from './JmSourceBrowser.vue'
import ComicDownloadList from './ComicDownloadList.vue'
const ingest=useComicIngest(),dialog=ref<HTMLElement>(),tasks=ref(false),visited=ref(new Set([ingest.provider.value]))
const previous=document.activeElement as HTMLElement|null
watch(ingest.provider,provider=>{visited.value.add(provider);tasks.value=false})
function close(){ingest.open.value=false}
function keys(event:KeyboardEvent){
  if(event.key==='Escape'){event.stopPropagation();close()}
  if(event.key==='Tab'){
    const nodes=[...dialog.value!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el=>el.getClientRects().length),first=nodes[0],last=nodes.at(-1)
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
  }
}
onMounted(async()=>{await nextTick();dialog.value?.querySelector<HTMLButtonElement>('button')?.focus()})
onBeforeUnmount(()=>{void window.baoyi.comic.cancelBrowse().catch(() => { /* best-effort */ });previous?.isConnected&&previous.focus()})
</script>
<template><Teleport to="body"><div class="im-overlay" @click.self="close"><section ref="dialog" class="im-dialog source-hub" role="dialog" aria-modal="true" :aria-label="$t('在线漫画')" @keydown="keys">
  <header><div><h2>{{ $t("在线漫画") }}</h2><p>{{ $t("浏览来源，选好章节，保存到自己的书架。") }}</p></div><button class="im-icon" :aria-label="$t('关闭在线漫画')" @click="close"><X :size="20"/></button></header>
  <nav class="hub-nav" :aria-label="$t('漫画来源')"><button class="im-button" :class="{'im-primary':!tasks&&ingest.provider.value==='pica'}" :aria-pressed="!tasks&&ingest.provider.value==='pica'" @click="ingest.provider.value='pica';tasks=false">{{ $t("哔咔 Pica") }}</button><button class="im-button" :class="{'im-primary':!tasks&&ingest.provider.value==='jm'}" :aria-pressed="!tasks&&ingest.provider.value==='jm'" @click="ingest.provider.value='jm';tasks=false">JM</button><button class="im-button hub-tasks" :aria-pressed="tasks" @click="tasks=!tasks">{{tasks?$t('返回发现'):$t('下载任务与记录')}}</button></nav>
  <div class="hub-body"><PicaSourceBrowser v-if="visited.has('pica')" v-show="!tasks&&ingest.provider.value==='pica'" :active="!tasks&&ingest.provider.value==='pica'"/><JmSourceBrowser v-if="visited.has('jm')" v-show="!tasks&&ingest.provider.value==='jm'" :active="!tasks&&ingest.provider.value==='jm'" @tasks="tasks=true"/><ComicDownloadList v-if="tasks"/></div>
</section></div></Teleport></template>
<style scoped>.source-hub{width:min(1000px,calc(100vw - 40px));max-height:calc(100vh - 90px);display:flex;flex-direction:column;overflow:hidden}.source-hub>header{flex-shrink:0}.source-hub header p{font-size:12px;color:var(--text-sub);margin:6px 0 0}.hub-nav{display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--divider);padding-bottom:16px;flex-shrink:0}.hub-tasks{margin-left:auto}.hub-body{min-height:0;overflow:auto;padding-top:20px;scrollbar-gutter:stable}@media(max-width:800px){.source-hub{width:calc(100vw - 20px)}.hub-nav{gap:5px}}</style>
