import { computed,ref } from 'vue'
import type { ProjectItem,ProjectScript } from '@/types/project'
import type { ProjectLaunchInput,ProjectLaunchPreview,ProjectRun } from '@/types/project-launch'

const item=ref<ProjectItem|null>(null),seed=ref<ProjectLaunchInput|null>(null),runs=ref<ProjectRun[]>([]),preview=ref<ProjectLaunchPreview|null>(null),showRuns=ref(false),error=ref(''),busy=ref(false)
let subscribed=false
const active=computed(()=>runs.value.filter(r=>['starting','running','stopping'].includes(r.status)))
const api=()=>window.baoyi.project.launch
async function initialize(){
  if(subscribed)return;subscribed=true
  api().onRun(run=>{runs.value=[run,...runs.value.filter(r=>r.id!==run.id)].sort((a,b)=>b.startedAt-a.startedAt)})
  try{const loaded=await api().runs();const known=new Set(runs.value.map(r=>r.id));runs.value=[...runs.value,...loaded.filter(r=>!known.has(r.id))].sort((a,b)=>b.startedAt-a.startedAt)}catch(e){error.value=(e as Error).message}
}
function open(value:ProjectItem,script?:ProjectScript){
  item.value=value;error.value='';preview.value=null
  const parts=script?.runCommand?.split(' ')||[]
  seed.value=script?{name:script.name,kind:'script',command:parts.shift()||'',args:parts,cwd:script.cwd,source:'discovered',sourceRef:script.source,port:null,url:'',enabled:true}:null
}
async function openById(id:string,script?:ProjectScript){try{const value=await window.baoyi.project.get(id);if(value)open(value,script)}catch(e){error.value=(e as Error).message;showRuns.value=true}}
async function start(projectId:string,profileId:string){
  if(busy.value)return;busy.value=true;error.value=''
  try{
    const plan=await api().preview(projectId,profileId)
    if(plan.profile.kind==='preview'){await api().openPreview(projectId,profileId);return}
    if(plan.trusted){await api().start(projectId,profileId);item.value=null;showRuns.value=true}
    else preview.value=plan
  }catch(e){error.value=(e as Error).message;showRuns.value=!item.value}
  finally{busy.value=false}
}
async function confirm(remember:boolean){
  const plan=preview.value;if(!plan||busy.value)return;busy.value=true;error.value=''
  try{await api().start(plan.profile.projectId,plan.profile.id,{stamp:plan.stamp,remember});preview.value=null;item.value=null;showRuns.value=true}
  catch(e){error.value=(e as Error).message}
  finally{busy.value=false}
}
function last(id:string){return runs.value.find(run=>run.projectId===id)}
async function rerun(value:ProjectItem){const run=last(value.id);if(run)await start(value.id,run.profileId);else open(value)}
export function useProjectLaunch(){return {item,seed,runs,active,preview,showRuns,error,busy,initialize,open,openById,start,confirm,last,rerun}}
