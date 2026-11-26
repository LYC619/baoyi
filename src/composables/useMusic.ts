
import { tr } from '../i18n/index.ts'
import { errorMessage } from '@/utils'
import { useToast } from '@/composables/useToast'
import {ref} from 'vue'
import type {MusicJob} from '@/types/music'
import {useTaskCenter} from './useTaskCenter'
const open=ref(false),jobs=ref<MusicJob[]>([])
let initialized=false
export function useMusic(){
  if(!initialized&&window.baoyi.music){initialized=true;const center=useTaskCenter(),mapped=new Map<string,string>()
    const sync=(rows:MusicJob[])=>{jobs.value=rows;for(const job of rows){let task=mapped.get(job.id);if(!task&&job.status==='running'){task=center.start('audio-download',tr("音乐：")+job.track.title);mapped.set(job.id,task)}if(task){if(job.status==='running')center.update(task,{processed:job.received,total:job.total,message:job.message});else{center.finish(task,job.status==='completed'?'success':job.status==='cancelled'?'cancelled':'failed',job.message);mapped.delete(job.id)}}}}
    window.baoyi.music.onChanged(sync);window.baoyi.video.onLibraryChanged(()=>{void window.baoyi.music.jobs().then(sync).catch(cause => useToast().error(errorMessage(cause)))});void window.baoyi.music.jobs().then(sync).catch(cause => useToast().error(errorMessage(cause)))
  }
  return {open,jobs}
}
