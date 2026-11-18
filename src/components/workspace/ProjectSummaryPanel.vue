<script setup lang="ts">
import { errorMessage } from '@/utils'
import {ref,computed,watch,onBeforeUnmount} from 'vue'
import {useRoute,useRouter} from 'vue-router'
import {Sparkles} from 'lucide-vue-next'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import {workspace,plain} from '@/utils/workspace-api'
import type {SummaryKind,ProjectSummary} from '@/types/workspace'
import type {ProjectSession} from '@/types/project'
const props=defineProps<{projectId:string;kind:SummaryKind;groupKey:string}>(),route=useRoute(),router=useRouter()
const summary=ref<ProjectSummary>(),session=ref<ProjectSession|null>(null),editing=ref<{title:string;body:string}|null>(null),busy=ref(false),error=ref(''),notice=ref('')
const running=computed(()=>session.value?.status==='running')
let revision=0
async function load(){const run=++revision;try{const rows=await window.baoyi.project.summaries(props.projectId);if(run===revision)summary.value=rows.find(s=>s.kind===props.kind&&s.key===props.groupKey)}catch(e){if(run===revision)error.value=errorMessage(e)}}
async function restoreSession(){const projectId=props.projectId,kind=props.kind,key=props.groupKey;try{await load();const run=revision,rows=await window.baoyi.project.sessions(projectId),latest=rows.find(s=>s.summary?.kind===kind&&s.summary.key===key);if(!latest)return;const saved=await window.baoyi.project.session(latest.id);if(run===revision&&props.projectId===projectId&&props.kind===kind&&props.groupKey===key)session.value=saved}catch(e){if(props.projectId===projectId&&props.kind===kind&&props.groupKey===key)error.value=errorMessage(e)}}
watch(()=>[props.projectId,props.kind,props.groupKey],()=>{summary.value=undefined;session.value=null;error.value='';void restoreSession()},{immediate:true})
const off=workspace.onChanged(()=>void load()),offSession=window.baoyi.project.onSession(value=>{if(value.id===session.value?.id){session.value=value;if(value.status!=='running')void load()}})
onBeforeUnmount(()=>{revision++;off();offSession()})
async function action(fn:()=>Promise<unknown>){if(busy.value)return;busy.value=true;error.value='';try{await fn();await load()}catch(e){error.value=errorMessage(e)}finally{busy.value=false}}
async function generate(){await action(async()=>{session.value=await window.baoyi.project.summarize(props.projectId,props.kind,props.groupKey)})}
function openSession(){const id=session.value?.id||summary.value?.sessionId;if(id)void router.replace({query:{...route.query,tab:'chat',session:id}})}
async function save(){if(summary.value&&editing.value)await action(async()=>{await window.baoyi.project.editSummary(props.projectId,summary.value!.id,plain(editing.value!));editing.value=null})}
async function undo(){if(summary.value)await action(async()=>{notice.value=(await window.baoyi.project.undoSummary(props.projectId,summary.value!.id)).reason;session.value=null})}
async function resume(){if(session.value)await action(async()=>{session.value=await window.baoyi.project.sendMessage(session.value!.id,'继续上次分组摘要任务，按保存的来源续读位置完成读取并保存摘要。')})}
async function stop(){if(session.value)await action(()=>window.baoyi.project.cancelMessage(session.value!.id))}
</script>
<template>
  <section class="timeline-summary">
    <header><Sparkles :size="15"/><strong>{{summary?'已生成摘要':'当前为分组回看'}}</strong><span v-if="summary?.revised" class="ws-badge">已人工修订</span><span v-else-if="summary" class="ws-badge">AI 生成</span><span v-if="running" class="ws-muted">正在读取原始记录…</span><span class="ws-spacer"/><button v-if="running" class="ws-button" @click="stop">停止</button><button v-else-if="!summary?.revised" class="ws-button" :disabled="busy" @click="generate">{{summary?'重新生成摘要':'生成本组摘要'}}</button></header>
    <p v-if="error||session?.error" class="ws-error" role="alert">{{error||session?.error}}<button v-if="session&&session.status!=='running'" class="ws-button" @click="resume">继续摘要</button></p>
    <p v-if="summary?.stale" class="ws-muted">原始记录已变化；下方摘要保留生成时的来源，尚未同步新内容。</p><p v-if="notice" class="ws-muted">{{notice}}</p>
    <template v-if="summary"><h4>{{summary.title}}</h4><p class="ws-pre timeline-summary-body">{{summary.body}}</p><details><summary>原始记录来源 · {{summary.sources.length}} 条</summary><article v-for="source in summary.sources" :key="source.id"><button class="summary-source" @click="router.replace({query:{...route.query,event:source.id}})">{{source.title}} ↗</button><p class="ws-pre">{{source.body}}</p><small v-if="source.evidence.length">{{source.evidence.join(' · ')}}</small></article></details><footer><button class="ws-button" @click="editing={title:summary.title,body:summary.body}">编辑摘要</button><button v-if="!summary.revised" class="ws-button" :disabled="busy||running" @click="undo">撤销摘要</button></footer></template>
    <button v-if="session||summary" class="ws-button" @click="openSession">查看摘要会话</button>
    <ProjectDialog v-if="editing" title="编辑摘要" :busy="busy" @close="editing=null"><form id="summary-form" class="ws ws-form" @submit.prevent="save"><label>摘要标题<input v-model="editing.title" required maxlength="300"/></label><label>摘要内容<textarea v-model="editing.body" maxlength="50000" rows="9"/></label><p class="ws-muted">保存后标为人工修订，后续生成不会覆盖。</p><p v-if="error" class="ws-error">{{error}}</p></form><template #footer><button class="ws-button primary" form="summary-form" type="submit" :disabled="busy">保存摘要</button></template></ProjectDialog>
  </section>
</template>
<style scoped>
.timeline-summary{margin:0 0 20px;padding:14px 16px;background:var(--ws-tint);border:1px solid var(--divider);border-radius:6px}.timeline-summary>header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--accent);font-size:12px}.timeline-summary strong{font-weight:500}.timeline-summary h4{font-size:15px;font-weight:500;margin:14px 0 5px}.timeline-summary-body{font-size:13px;line-height:1.9}.timeline-summary .ws-button{font-size:11px;padding:5px 8px}.timeline-summary details{font-size:12px;margin:12px 0;color:var(--text-sub)}.timeline-summary summary{cursor:pointer}.timeline-summary details article{padding:10px;border-left:2px solid var(--divider);margin:10px 0;max-height:230px;overflow:auto}.summary-source{color:var(--accent);text-align:left}.timeline-summary footer{display:inline-flex;gap:7px;margin-right:7px}
</style>
