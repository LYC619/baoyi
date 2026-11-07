<script setup lang="ts">
import {computed,ref} from 'vue'
import {useImageDownloads} from '@/composables/useImageDownloads'
import {useComicIngest} from '@/composables/useComicIngest'
import ImageDownloadList from './ImageDownloadList.vue'
import ComicIngestList from './ComicIngestList.vue'
const props=defineProps<{filter?:'attention'|'all'}>(),pica=useImageDownloads(),jm=useComicIngest(),source=ref('all'),optionsBusy=ref(false),error=ref('')
const rows=computed(()=>[
  ...pica.jobs.value.map(job=>({id:job.id,provider:'pica',status:job.status,at:job.updatedAt})),
  ...jm.jobs.value.map(job=>({id:job.id,provider:'jm',status:job.status,at:job.updatedAt}))
].filter(job=>(source.value==='all'||job.provider===source.value)&&(props.filter!=='attention'||job.status!=='success')).sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id)))
async function setOption(event:Event,key:'concurrency'|'jobConcurrency'){
  optionsBusy.value=true;error.value=''
  try{await pica.setOptions({...pica.options.value,[key]:Number((event.target as HTMLInputElement).value)})}
  catch(cause){error.value=(cause as Error).message}
  finally{optionsBusy.value=false;(event.target as HTMLInputElement).value=String(pica.options.value[key]||1)}
}
</script>
<template><section class="comic-downloads" aria-label="漫画下载任务"><header><h3>漫画下载与记录</h3><select v-model="source" aria-label="下载来源"><option value="all">全部来源</option><option value="pica">哔咔</option><option value="jm">JM</option></select></header><details class="download-options"><summary>哔咔下载设置</summary><label>同时下载作品 <input aria-label="同时下载漫画数" type="number" min="1" max="4" :disabled="optionsBusy" :value="pica.options.value.jobConcurrency||3" @change="setOption($event,'jobConcurrency')"/></label><label>每部图片并发 <input aria-label="图片下载并发" type="number" min="1" max="3" :disabled="optionsBusy" :value="pica.options.value.concurrency" @change="setOption($event,'concurrency')"/></label></details><p v-if="error" role="alert">{{error}}</p><p v-if="!rows.length">当前没有下载任务。</p><div v-for="row in rows" :key="row.provider+':'+row.id" class="comic-task"><small>{{row.provider==='jm'?'JM':'哔咔'}}</small><ComicIngestList v-if="row.provider==='jm'" :job-id="row.id"/><ImageDownloadList v-else :job-id="row.id"/></div></section></template>
<style scoped>.download-options{margin:16px 0;font-size:12px;color:var(--text-sub)}.download-options label{display:inline-flex;align-items:center;gap:8px;margin:12px 18px 0 0}.download-options input{width:54px;padding:5px;background:var(--bg-card);color:var(--text-main);border:1px solid var(--divider);border-radius:4px}.comic-downloads>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.comic-downloads h3{font-size:14px;font-weight:500}.comic-downloads>p{font-size:12px;color:var(--text-sub);padding:24px 0}.comic-downloads select{padding:6px;border:1px solid var(--divider);border-radius:5px;background:var(--bg-card);color:var(--text-main)}.comic-task{position:relative;margin:14px 0}.comic-task>small{display:block;font-size:10px;color:var(--text-sub)}.comic-task :deep(.image-download-list),.comic-task :deep(.comic-jobs article){margin-top:6px}</style>
