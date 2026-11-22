import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'
import {computed,effectScope,ref,watch} from 'vue'
import {useSettingsStore} from '@/stores/settings'
import type {ComicJobView} from '@/types/comic-ingest'
const jobs=ref<ComicJobView[]>([]),open=ref(false),request=ref(''),recovery=ref<ComicJobView|null>(null),showRecords=ref(false),error=ref('')
const provider=ref<'pica'|'jm'>('pica')
try{if(localStorage.getItem('baoyi.comic.source')==='jm')provider.value='jm'}catch { /* 无法读取上次来源时使用哔咔。 */ }
const scope = effectScope(true)
scope.run(() => watch(provider,value=>{try{localStorage.setItem('baoyi.comic.source',value)}catch (cause) { useToast().error(errorMessage(cause)) }}))
let initialized=false,generation=0,timer:ReturnType<typeof setTimeout>|undefined
let refreshing:Promise<void>|undefined,pending=false
function reconcile(value:ComicJobView[]){
  const previous=new Map(jobs.value.map(job=>[job.id,job]))
  const next=value.map(job=>{
    const current=previous.get(job.id);if(!current)return job
    for(const key of Object.keys(job) as Array<keyof ComicJobView>){
      const before=current[key],after=job[key]
      if(Array.isArray(before)&&Array.isArray(after)&&before.length===after.length&&before.every((item,index)=>item===after[index]))continue
      if(before!==after)Object.assign(current,{[key]:after})
    }
    return current
  })
  if(next.length!==jobs.value.length||next.some((job,index)=>job!==jobs.value[index]))jobs.value=next
}
export function useComicIngest(){
  const settings=useSettingsStore(),visible=computed(()=>settings.loaded&&!settings.settings.hide_hentai)
  async function refresh(){
    pending=true;if(refreshing)return refreshing
    refreshing=(async()=>{
      while(pending){
        pending=false;const stamp=generation;if(!visible.value){jobs.value=[];continue}
        try{const value=await window.baoyi.comic.jobs();if(stamp===generation&&visible.value){reconcile(value);error.value=''}}catch(e){if(stamp===generation&&visible.value)error.value=errorMessage(e)}
      }
    })().finally(()=>{refreshing=undefined;if(pending)void refresh()})
    return refreshing
  }
  if(!initialized&&window.baoyi?.comic) scope.run(() => {
    initialized=true;watch(visible,show=>{generation++;jobs.value=[];open.value=false;request.value='';recovery.value=null;if(show)void refresh()},{immediate:true})
    const schedule=()=>{if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh()},150)}
    window.baoyi.image.onJobsChanged(schedule);window.baoyi.image.onChanged(schedule)
  })
  const active=computed(()=>jobs.value.filter(j=>['queued','running'].includes(j.status))),attention=computed(()=>jobs.value.filter(j=>!['queued','running','success'].includes(j.status)))
  function show(input='',job:ComicJobView|null=null){request.value=input;recovery.value=job;if(input||job)provider.value='jm';open.value=true}
  return {jobs,open,provider,request,recovery,error,showRecords,active,attention,visible,refresh,show}
}
