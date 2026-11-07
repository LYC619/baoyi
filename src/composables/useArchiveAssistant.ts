import {computed,ref} from 'vue'
import type {ArchiveAction,ArchiveMessage,ArchiveRun,ArchiveSession,ArchiveSource} from '@/types/archive'

export interface LiveBlock {key:string;role:'user'|'assistant'|'tool';text:string;name?:string;args?:any;result?:string;pending?:boolean}
const open=ref(false),wide=ref(false),draft=ref(''),error=ref(''),notice=ref(''),loading=ref(false),sending=ref(false)
const sessions=ref<ArchiveSession[]>([]),selected=ref(''),messages=ref<ArchiveMessage[]>([]),actions=ref<ArchiveAction[]>([]),context=ref<ArchiveSource[]>([])
const active=ref<ArchiveRun|null>(null),lastRun=ref<ArchiveRun|null>(null),live=ref<LiveBlock[]>([]),liveSession=ref('')
const configured=ref(false),model=ref(''),profileId=ref(''),profiles=ref<Array<{id:string;name:string;model:string}>>([])
const privacyRevision=ref(0)
let initialized=false,revision=0,listRevision=0,generation=0,liveRevision=0
let latestRun:ArchiveRun|null=null
const busy=computed(()=>!!active.value),visibleLive=computed(()=>liveSession.value===selected.value?live.value:[])
function init(){if(initialized)return;initialized=true
  window.baoyi.archive.onEvent(event=>{
    if(event.event==='run'){latestRun=event.run;active.value=['starting','running'].includes(event.run.status)?event.run:null;if(selected.value===event.sessionId)lastRun.value=event.run;return}
    if(event.event==='finished'){
      latestRun=event.run
      if(selected.value===event.previousSessionId||selected.value===event.sessionId){const previousLive=liveRevision;selected.value=event.sessionId;lastRun.value=event.run;void load(event.sessionId).then(ok=>{if(ok&&previousLive===liveRevision)live.value=[]})}
      active.value=null;void refreshSessions().catch(e=>{error.value=(e as Error).message});return
    }
    if(event.sessionId!==liveSession.value){liveSession.value=event.sessionId;live.value=[]}
    if(event.event==='delta'){const previous=live.value.at(-1);if(previous?.role==='assistant')previous.text+=event.text;else live.value.push({key:crypto.randomUUID(),role:'assistant',text:event.text})}
    if(event.event==='tool_start')live.value.push({key:event.callId,role:'tool',text:'',name:event.name,args:event.args,pending:true})
    if(event.event==='tool_end'){const block=live.value.find(x=>x.key===event.callId);if(block){block.pending=false;block.result=String(event.result)}}
  })
}
async function refreshSessions(query=''){const request=++listRevision;const result=await window.baoyi.archive.sessions(query);if(request===listRevision)sessions.value=result}
async function load(id:string){const request=++revision;loading.value=true;error.value='';try{const [state,audit]=await Promise.all([window.baoyi.archive.session(id),window.baoyi.archive.actions(id)]);if(request!==revision)return false;if(!state){error.value='这段对话已不可用';return false}selected.value=state.session.id;lastRun.value=state.lastRun;const current=active.value?.sessionId===id?active.value:null;messages.value=current&&liveSession.value===id?state.messages.filter(m=>m.timestamp<current.startedAt/1000):state.messages;actions.value=audit;return true}catch(e){if(request===revision)error.value=(e as Error).message;return false}finally{if(request===revision)loading.value=false}}
async function show(text?:string,ids:string[]=[]){
  init();open.value=true;if(text)draft.value=text;error.value='';const opening=generation
  try{const status=await window.baoyi.archive.status();if(opening!==generation)return;configured.value=status.configured;model.value=status.model;profiles.value=status.profiles;active.value=status.active
    if(ids.length){const sources=await Promise.all(ids.map(id=>window.baoyi.archive.source(id)));if(opening!==generation)return;context.value=sources}
    await refreshSessions();if(opening!==generation)return;if(!selected.value&&status.active)selected.value=status.active.sessionId
    if(selected.value)await load(selected.value)
  }catch(e){if(opening===generation)error.value=(e as Error).message}
}
function newSession(){revision++;loading.value=false;selected.value='';messages.value=[];actions.value=[];lastRun.value=null;error.value='';context.value=[]}
async function send(){
  const originalDraft=draft.value,text=originalDraft.trim();if(!text||sending.value)return;sending.value=true;error.value='';notice.value='';const sendingGeneration=generation
  try{
    if(active.value){if(selected.value!==active.value.sessionId)throw new Error('请先返回正在进行的对话，或停止后新建对话');const accepted=await window.baoyi.archive.steer(text);if(sendingGeneration!==generation)return;if(!accepted)throw new Error('当前步骤正在收尾，请稍后发送；输入已保留');live.value.push({key:crypto.randomUUID(),role:'user',text});notice.value='补充已送达当前任务';draft.value='';return}
    const request=++revision;liveRevision++
    const run=await window.baoyi.archive.send({sessionId:selected.value||undefined,text,contextIds:context.value.map(x=>x.id),profileId:profileId.value||undefined})
    if(sendingGeneration!==generation)return
    const current=latestRun?.startedAt===run.startedAt?latestRun:run
    active.value=['starting','running'].includes(current.status)?current:null
    if(liveSession.value!==current.sessionId){liveSession.value=current.sessionId;live.value=[]}
    live.value.unshift({key:crypto.randomUUID(),role:'user',text})
    if(draft.value===originalDraft)draft.value=''
    if(request===revision){
      selected.value=current.sessionId;lastRun.value=current
      if(!active.value){const previousLive=liveRevision;if(await load(current.sessionId)&&previousLive===liveRevision)live.value=[]}
    }
  }catch(e){if(sendingGeneration===generation)error.value=(e as Error).message}finally{sending.value=false}
}
async function stop(){error.value='';try{await window.baoyi.archive.cancel();notice.value='正在停止，已完成的整理会保留'}catch(e){error.value=(e as Error).message}}
async function undo(id:string){try{const result=await window.baoyi.archive.undo(id);notice.value=result.reason;actions.value=await window.baoyi.archive.actions(selected.value)}catch(e){error.value=(e as Error).message}}
function privacyReset(){generation++;privacyRevision.value=generation;revision++;listRevision++;liveRevision++;latestRun=null;loading.value=false;selected.value='';messages.value=[];live.value=[];sessions.value=[];context.value=[];actions.value=[];lastRun.value=null;active.value=null;draft.value='';notice.value='';error.value='';if(open.value)void show()}
export function useArchiveAssistant(){init();return {open,wide,draft,error,notice,loading,sending,sessions,selected,messages,actions,context,active,lastRun,visibleLive,busy,configured,model,profileId,profiles,privacyRevision,show,load,refreshSessions,newSession,send,stop,undo,privacyReset}}
