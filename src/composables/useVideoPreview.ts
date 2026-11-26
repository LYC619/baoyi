
import { tr } from '../i18n/index.ts'
import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'
import {ref} from 'vue'
import type {VideoPreviewSelection,VideoPreviewSession} from '@/types/video-preview'
const selection=ref<VideoPreviewSelection|null>(null),session=ref<VideoPreviewSession|null>(null),visible=ref(false),busy=ref(false),error=ref(''),startAt=ref(0)
let generation=0,opener:HTMLElement|null=null,initialized=false
const recent=new Map<string,string>()
export function recentVideoAsset(id:string,episodeId=''){return recent.get(id+'|'+episodeId)||''}
function initialize(){if(initialized)return;initialized=true;window.baoyi.video.preview.onClosed(close);window.baoyi.video.onLibraryChanged(async()=>{
  const current=selection.value,own=generation;if(!visible.value||!current)return
  try{const next=await window.baoyi.video.preview.choices(current.resourceId);if(own===generation&&session.value&&!next.assets.some(asset=>asset.key===session.value!.asset.key))close()}catch (cause) { if (own === generation) { close(); useToast().error(errorMessage(cause)) } }
})}
async function release(){const current=session.value;session.value=null;if(current)await window.baoyi.video.preview.release(current.token).catch(() => { /* best-effort */ })}
async function choose(key:string){
  if(!selection.value)return
  const own=++generation,id=selection.value.resourceId;busy.value=true;error.value='';await release()
  try{const next=await window.baoyi.video.preview.open(id,key);if(own!==generation){await window.baoyi.video.preview.release(next.token);return}session.value=next;recent.set(id+'|',key);recent.set(id+'|'+next.asset.episodeId,key)}
  catch(e){if(own===generation)error.value=errorMessage(e)}finally{if(own===generation)busy.value=false}
}
async function open(id:string,episodeId='',seconds=0,assetKey=''){
  opener=document.activeElement instanceof HTMLElement?document.activeElement:null
  const own=++generation;visible.value=true;busy.value=true;error.value='';selection.value=null;startAt.value=seconds;await release()
  try{
    const next=await window.baoyi.video.preview.choices(id,episodeId);if(own!==generation)return
    selection.value=next
    if(!next.assets.length)error.value=tr("没有可试看的本地视频；请在详情中检查文件位置。")
    else if(assetKey&&next.assets.some(asset=>asset.key===assetKey))await choose(assetKey)
    else if(next.assets.length===1)await choose(next.assets[0].key)
  }catch(e){if(own===generation)error.value=errorMessage(e)}finally{if(own===generation)busy.value=false}
}
function close(){generation++;visible.value=false;selection.value=null;error.value='';busy.value=false;void release();const target=opener;opener=null;queueMicrotask(()=>target?.isConnected&&target.focus())}
export function useVideoPreview(){initialize();return {selection,session,visible,busy,error,startAt,open,choose,close}}
