import { errorMessage } from '@/utils'
import {computed,effectScope,ref,watch} from 'vue'
import {useSettingsStore} from '@/stores/settings'
import type {VideoUpdateState} from '@/types/video-updates'
const state=ref<VideoUpdateState>({running:false,checked:0,total:0,rows:[],finishedAt:0,cancelled:false}),open=ref(false),error=ref('')
const scope = effectScope(true)
let initialized=false,revision=0
const scopeIds=ref<string[]|undefined>()
async function refresh(){const own=++revision;try{const value=await window.baoyi.video.updateCheckStatus();if(own===revision)state.value=value}catch(e){if(own===revision)error.value=errorMessage(e)}}
export function useVideoUpdates(){
  const settings=useSettingsStore()
  if(!initialized&&window.baoyi.video.onUpdateCheck)scope.run(()=>{initialized=true;window.baoyi.video.onUpdateCheck(()=>void refresh());watch(()=>settings.settings.hide_hentai,hidden=>{revision++;state.value.rows=[];if(hidden)void window.baoyi.video.cancelUpdateCheck();void refresh()});void refresh()})
  async function start(ids?:string[],startup=false){error.value='';if(!startup){scopeIds.value=ids;open.value=true}try{await window.baoyi.video.checkLibraryUpdates(ids,startup);await refresh()}catch(e){error.value=errorMessage(e)}}
  async function cancel(){try{await window.baoyi.video.cancelUpdateCheck();await refresh()}catch(e){error.value=errorMessage(e)}}
  const rows=computed(()=>state.value.rows.filter(row=>!scopeIds.value||scopeIds.value.includes(row.id)))
  function show(ids?:string[]){scopeIds.value=ids;open.value=true;void refresh()}
  return {state,open,error,start,cancel,refresh,show,rows,attention:computed(()=>rows.value.filter(row=>row.newEpisodes>0||row.missingFiles>0).length)}
}
