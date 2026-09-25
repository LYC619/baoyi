import { computed, ref } from 'vue'
import type { ImageDownloadJob } from '@/types/image'
const jobs=ref<ImageDownloadJob[]>([])
let initialized=false,scheduled:ReturnType<typeof setTimeout>|undefined
async function refresh(){if(typeof window==='undefined'||!window.baoyi?.image?.jobs)return;try{jobs.value=await window.baoyi.image.jobs()}catch{/* Local browsing remains usable if queue metadata cannot be loaded. */}}
export function useImageDownloads(){
  if(!initialized&&typeof window!=='undefined'&&typeof window.baoyi?.image?.jobs==='function'){initialized=true;void refresh();window.baoyi.image.onChanged(()=>{clearTimeout(scheduled);scheduled=setTimeout(()=>{void refresh()},100)})}
  const active=computed(()=>jobs.value.filter(j=>j.status==='running'||j.status==='queued'))
  const attention=computed(()=>jobs.value.filter(j=>['failed','cancelled','interrupted'].includes(j.status)))
  return {jobs,active,attention,refresh}
}
