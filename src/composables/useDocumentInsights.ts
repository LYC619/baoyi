import {computed,ref} from 'vue'
import type {DocumentInsightPreview,DocumentInsightRun,DocumentInsightRange} from '@/types/document-insight'
const runs=ref<DocumentInsightRun[]>([]),preview=ref<DocumentInsightPreview|null>(null),error=ref(''),busy=ref(false)
let initialized=false,revision=0
const active=computed(()=>runs.value.filter(run=>['queued','running'].includes(run.status)))
async function refresh(){const own=++revision;try{const next=await window.baoyi.archive.insights.list();if(own===revision)runs.value=next}catch(e){if(own===revision)error.value=(e as Error).message}}
function initialize(){if(initialized)return;initialized=true;window.baoyi.archive.insights.onChanged(()=>void refresh());window.baoyi.workspace.onChanged(()=>void refresh());void refresh()}
async function open(ids:string[],range?:DocumentInsightRange){error.value='';busy.value=true;try{preview.value=await window.baoyi.archive.insights.preview(ids,range);return true}catch(e){error.value=(e as Error).message;return false}finally{busy.value=false}}
async function confirm(force=false){if(!preview.value||busy.value)return;busy.value=true;error.value='';try{await window.baoyi.archive.insights.start(preview.value.token,force);preview.value=null;await refresh()}catch(e){error.value=(e as Error).message;preview.value=null}finally{busy.value=false}}
async function cancel(id:string){try{await window.baoyi.archive.insights.cancel(id);await refresh()}catch(e){error.value=(e as Error).message}}
export function useDocumentInsights(){return {runs,preview,error,busy,active,initialize,refresh,open,confirm,cancel}}
