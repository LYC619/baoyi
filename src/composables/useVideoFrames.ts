import {ref,onBeforeUnmount} from 'vue'
import type {VideoFrameState} from '@/types/video-preview'
const receivers=new Map<string,(value:VideoFrameState)=>void>(),closers=new Set<()=>void>()
let initialized=false,stopHover:(()=>void)|null=null
export function claimVideoHover(stop:()=>void){if(stopHover&&stopHover!==stop)stopHover();stopHover=stop}
export function releaseVideoHover(stop:()=>void){if(stopHover===stop)stopHover=null}
export function useVideoFrames(){
  const state=ref<VideoFrameState|null>(null),error=ref(''),busy=ref(false);let generation=0
  function stop(){generation++;const id=state.value?.id;if(id){receivers.delete(id);void window.baoyi.video.preview.releaseFrames(id).catch(()=>{})}state.value=null;error.value='';busy.value=false}
  async function start(token:string,retry=false){
    stop();const own=generation;busy.value=true
    try{
      const value=await window.baoyi.video.preview.frames(token,retry)
      if(own!==generation){await window.baoyi.video.preview.releaseFrames(value.id);return}
      state.value=value;receivers.set(value.id,next=>{if(own===generation)state.value=next})
    }catch(e){if(own===generation)error.value=(e as Error).message}finally{if(own===generation)busy.value=false}
  }
  if(!initialized){initialized=true;window.baoyi.video.preview.onFrames(value=>receivers.get(value.id)?.(value));window.baoyi.video.preview.onClosed(()=>{for(const close of closers)close();stopHover?.()})}
  closers.add(stop);onBeforeUnmount(()=>{stop();closers.delete(stop)})
  return {state,error,busy,start,stop}
}
