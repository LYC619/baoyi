<script setup lang="ts">
import {computed,ref} from 'vue'
import {useRouter} from 'vue-router'
import {useComicIngest} from '@/composables/useComicIngest'
import type {ComicJobView,ComicProxy,ComicLogEntry} from '@/types/comic-ingest'
const props=defineProps<{filter?:'attention'|'all';jobId?:string}>(),ingest=useComicIngest(),router=useRouter(),busy=ref(''),error=ref('')
const shown=computed(()=>ingest.jobs.value.filter(j=>(!props.jobId||j.id===props.jobId)&&(props.filter!=='attention'||j.status!=='success')))
const statuses={queued:'排队中',running:'正在下载',paused:'已暂停',success:'已入库',failed:'需要处理',cancelled:'已停止',interrupted:'上次中断'}
const phases={resolving:'读取目录',downloading:'下载页面',verifying:'核验图片',prepared:'准备保存',placed:'已落盘，待登记',indexing:'登记入库',done:'已入库'}
const proxyJob=ref(''),mode=ref<ComicProxy['mode']>('system'),custom=ref('127.0.0.1:7890')
const logJob=ref(''),entries=ref<ComicLogEntry[]>([])
async function logs(job:ComicJobView){if(logJob.value===job.id){logJob.value='';return}try{entries.value=await window.baoyi.comic.logs(job.id);logJob.value=job.id}catch(e){error.value=(e as Error).message}}
async function changeProxy(job:ComicJobView){proxyJob.value=job.id;try{const value=await window.baoyi.comic.defaults();mode.value=value.proxy.mode;if(value.proxy.mode==='custom')custom.value=value.proxy.url}catch{}}
async function action(job:ComicJobView,kind:'pause'|'cancel'|'retry'|'dismiss'|'clean'|'proxy'){
  if(busy.value)return
  if(kind==='clean'&&!window.confirm(`停止“${job.name}”并清理暂存？将删除已下载的临时图片文件，此操作不可撤销。`))return
  busy.value=job.id;error.value=''
  try{if(kind==='retry'||kind==='proxy'){await window.baoyi.comic.retry(job.id,kind==='proxy'?(mode.value==='custom'?{mode:'custom',url:custom.value}:{mode:mode.value}):undefined);proxyJob.value=''}else if(kind==='clean')await window.baoyi.comic.clean(job.id);else if(kind==='dismiss')await window.baoyi.comic.dismiss(job.id);else await window.baoyi.comic.stop(job.id,kind==='cancel');await ingest.refresh()}catch(e){error.value=(e as Error).message}finally{busy.value=''}
}
</script>
<template><section v-if="shown.length||ingest.error.value" class="comic-jobs"><h3 v-if="!jobId">漫画摄入 · JM</h3><p v-if="error||ingest.error.value" class="im-error" role="alert">{{error||ingest.error.value}}</p><article v-for="job in shown" :key="job.id"><header><strong>{{job.name}}</strong><span>{{job.status==='running'?phases[job.phase]:statuses[job.status]}}</span></header><p>{{job.processed}} / {{job.total}} 页 · {{job.selectedChapters.length}} 章</p><progress :value="job.processed" :max="job.total||1"/><p v-if="job.current">{{job.current}}</p><p v-if="job.error" class="im-error">{{job.error}}</p><p v-if="job.requiresRevalidation">此任务来自备份，请重新解析作品并核对存放位置。</p><p v-if="job.retryNotBefore>Date.now()">可重试时间：{{new Date(job.retryNotBefore).toLocaleTimeString()}}</p><footer>
  <button v-if="job.resourceId" class="im-button" @click="router.push({name:'image-detail',params:{id:job.resourceId}})">打开作品</button>
  <button v-if="['queued','running'].includes(job.status)" class="im-button" :disabled="busy===job.id" @click="action(job,'pause')">{{busy===job.id?'正在完成当前保存…':'暂停'}}</button>
  <button v-if="!['queued','running','success'].includes(job.status)&&!job.requiresRevalidation" class="im-button" :disabled="busy===job.id||job.retryNotBefore>Date.now()" @click="action(job,'retry')">{{['placed','indexing'].includes(job.phase)?'重试登记':job.status==='paused'?'继续下载':'重试剩余页'}}</button>
  <button v-if="job.requiresRevalidation&&job.status!=='success'" class="im-button" @click="ingest.show(job.workId,job)">重新核验</button>
  <button v-if="!['queued','running','success'].includes(job.status)&&!job.requiresRevalidation" class="im-button" :disabled="!!busy" @click="changeProxy(job)">更换连接方式</button>
  <button v-if="['queued','running','paused'].includes(job.status)" class="im-button" :disabled="busy===job.id" @click="action(job,'cancel')">停止</button>
  <button v-else class="im-button" :disabled="busy===job.id" @click="action(job,'dismiss')">移除记录</button>
  <button v-if="job.status!=='success'&&!job.requiresRevalidation" class="im-button" :disabled="!!busy" @click="action(job,'clean')">停止并清理暂存</button>
  <button class="im-button" @click="logs(job)">{{logJob===job.id?'收起记录':'查看过程'}}</button>
  </footer><form v-if="proxyJob===job.id" class="comic-retry" @submit.prevent="action(job,'proxy')"><label>连接方式<select v-model="mode" aria-label="重试连接方式"><option value="system">跟随系统代理</option><option value="custom">指定代理</option><option value="builtin">使用当前内置代理</option></select></label><label v-if="mode==='custom'">代理地址<input v-model="custom" aria-label="重试代理地址" placeholder="127.0.0.1:7890"/></label><button class="im-button" :disabled="!!busy||job.retryNotBefore>Date.now()">保存并重试</button><button type="button" class="im-button" @click="proxyJob=''">取消</button></form><div v-if="logJob===job.id" class="comic-log"><p v-if="!entries.length">此任务没有本机过程记录。</p><p v-for="(entry,index) in entries" :key="index">{{new Date(entry.at).toLocaleString()}} · {{statuses[entry.status]}} · {{phases[entry.phase]}} · {{entry.processed}} / {{entry.total}} 页<span v-if="entry.errorCode"> · {{entry.errorCode}}</span></p></div></article></section></template>
<style scoped>
.comic-jobs{font-size:12px}.comic-jobs h3{font-weight:500;color:var(--text-sub);font-size:13px}.comic-jobs article{border:1px solid var(--divider);border-radius:8px;background:var(--bg-card);padding:16px;margin:12px 0}.comic-jobs header{display:flex;justify-content:space-between;gap:15px}.comic-jobs strong{font-size:14px;overflow-wrap:anywhere}.comic-jobs header span{white-space:nowrap;color:var(--text-sub)}.comic-jobs p{color:var(--text-sub);line-height:1.7}.comic-jobs progress{width:100%;height:5px;accent-color:var(--accent)}.comic-jobs footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.comic-jobs .im-error{color:var(--danger)}
.comic-retry{display:flex;align-items:end;flex-wrap:wrap;gap:8px;margin-top:12px}.comic-retry label{display:grid;gap:6px}.comic-retry input,.comic-retry select{max-width:220px;padding:8px;color:var(--text-main);background:var(--bg-main);border:1px solid var(--divider);border-radius:5px}
.comic-log{max-height:240px;overflow:auto;border-top:1px solid var(--divider);margin-top:12px}.comic-log p{font-size:11px;margin:5px 0}
</style>
