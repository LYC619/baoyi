import {computed,ref,watch} from 'vue'
import {useSettingsStore} from '@/stores/settings'
import type {ComicJobView} from '@/types/comic-ingest'
const jobs=ref<ComicJobView[]>([]),open=ref(false),request=ref(''),recovery=ref<ComicJobView|null>(null),showRecords=ref(false),error=ref('')
const provider=ref<'pica'|'jm'>('pica')
try{if(localStorage.getItem('baoyi.comic.source')==='jm')provider.value='jm'}catch{}
watch(provider,value=>{try{localStorage.setItem('baoyi.comic.source',value)}catch{}})
let initialized=false,generation=0,timer:ReturnType<typeof setTimeout>|undefined
export function useComicIngest(){
  const settings=useSettingsStore(),visible=computed(()=>settings.loaded&&!settings.settings.hide_hentai)
  async function refresh(){
    const stamp=++generation;if(!visible.value){jobs.value=[];return}
    try{const value=await window.baoyi.comic.jobs();if(stamp===generation&&visible.value){jobs.value=value;error.value=''}}catch(e){if(stamp===generation)error.value=(e as Error).message}
  }
  if(!initialized&&window.baoyi?.comic){
    initialized=true;watch(visible,show=>{generation++;jobs.value=[];open.value=false;request.value='';recovery.value=null;if(show)void refresh()},{immediate:true})
    const schedule=()=>{if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh()},150)}
    window.baoyi.image.onJobsChanged(schedule);window.baoyi.image.onChanged(schedule)
  }
  const active=computed(()=>jobs.value.filter(j=>['queued','running'].includes(j.status))),attention=computed(()=>jobs.value.filter(j=>!['queued','running','success'].includes(j.status)))
  function show(input='',job:ComicJobView|null=null){request.value=input;recovery.value=job;if(input||job)provider.value='jm';open.value=true}
  return {jobs,open,provider,request,recovery,error,showRecords,active,attention,visible,refresh,show}
}
