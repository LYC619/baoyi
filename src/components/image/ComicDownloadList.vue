<script setup lang="ts">
import { errorMessage } from '@/utils'
import {computed,ref} from 'vue'
import {useComicDownloads} from '@/composables/useComicDownloads'
import {useToast} from '@/composables/useToast'
import ComicTaskRow from './ComicTaskRow.vue'
const props=defineProps<{filter?:'attention'|'all'}>(),downloads=useComicDownloads(),source=ref('all'),optionsBusy=ref(false),error=ref('')
const rows=computed(()=>downloads.rows.value.filter(job=>(source.value==='all'||job.provider===source.value)&&(props.filter!=='attention'||job.status!=='success')))
async function setOption(event:Event,key:'concurrency'|'jobConcurrency'){
  optionsBusy.value=true;error.value=''
  try{await downloads.setOptions({...downloads.options.value,[key]:Number((event.target as HTMLInputElement).value)})}
  catch(cause){error.value=errorMessage(cause);useToast().error(error.value)}
  finally{optionsBusy.value=false;(event.target as HTMLInputElement).value=String(downloads.options.value[key]||1)}
}
</script>
<template><section class="comic-downloads" :aria-label="$t('漫画下载任务')"><header><h3>{{ $t("漫画下载与记录") }}</h3><select v-model="source" :aria-label="$t('下载来源')"><option value="all">{{ $t("全部来源") }}</option><option value="pica">{{ $t("哔咔") }}</option><option value="jm">JM</option></select></header><details class="download-options"><summary>{{ $t("哔咔下载设置") }}</summary><label>{{ $t("同时下载作品") }}<input :aria-label="$t('同时下载漫画数')" type="number" min="1" max="4" :disabled="optionsBusy" :value="downloads.options.value.jobConcurrency||3" @change="setOption($event,'jobConcurrency')"/></label><label>{{ $t("每部图片并发") }}<input :aria-label="$t('图片下载并发')" type="number" min="1" max="3" :disabled="optionsBusy" :value="downloads.options.value.concurrency" @change="setOption($event,'concurrency')"/></label></details><p v-if="error||downloads.error.value" role="alert">{{error||downloads.error.value}}</p><p v-if="!rows.length">{{ $t("当前没有下载任务。") }}</p><ComicTaskRow v-for="row in rows" :key="row.provider+':'+row.id" :row="row" :run="downloads.run" :logs="downloads.logs" :concurrency="downloads.options.value.concurrency"/></section></template>
<style scoped>.download-options{margin:16px 0;font-size:12px;color:var(--text-sub)}.download-options label{display:inline-flex;align-items:center;gap:8px;margin:12px 18px 0 0}.download-options input{width:54px;padding:5px;background:var(--bg-card);color:var(--text-main);border:1px solid var(--divider);border-radius:4px}.comic-downloads>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.comic-downloads h3{font-size:14px;font-weight:500}.comic-downloads>p{font-size:12px;color:var(--text-sub);padding:24px 0}.comic-downloads select{padding:6px;border:1px solid var(--divider);border-radius:5px;background:var(--bg-card);color:var(--text-main)}</style>
