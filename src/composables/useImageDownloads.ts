import { computed, ref } from 'vue'
import type { ImageDownloadJob, ImageDownloadOptions } from '@/types/image'
const jobs=ref<ImageDownloadJob[]>([])
const options=ref<ImageDownloadOptions>({concurrency:2})
let initialized=false,scheduled:ReturnType<typeof setTimeout>|undefined
async function refresh(){if(typeof window==='undefined'||!window.baoyi?.image?.jobs)return;try{jobs.value=await window.baoyi.image.jobs()}catch{/* Local browsing remains usable if queue metadata cannot be loaded. */}}
export function useImageDownloads(){
  if(!initialized&&typeof window!=='undefined'&&typeof window.baoyi?.image?.jobs==='function'){
    initialized=true;void refresh()
    if(window.baoyi.image.downloadOptions)void window.baoyi.image.downloadOptions().then(value=>{options.value=value}).catch(()=>{})
    const schedule=()=>{if(!scheduled)scheduled=setTimeout(()=>{scheduled=undefined;void refresh()},100)}
    window.baoyi.image.onChanged(schedule)
    window.baoyi.image.onJobsChanged?.(schedule)
  }
  const active=computed(()=>jobs.value.filter(j=>j.status==='running'||j.status==='queued'))
  const attention=computed(()=>jobs.value.filter(j=>['paused','failed','cancelled','interrupted'].includes(j.status)))
  const setOptions=async(value:ImageDownloadOptions)=>{options.value=await window.baoyi.image.downloadOptions(value)}
  return {jobs,active,attention,options,setOptions,refresh}
}
