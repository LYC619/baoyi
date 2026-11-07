<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {useRoute,useRouter} from 'vue-router'
import {Bot,Check} from 'lucide-vue-next'
import DetailTabs from '@/components/ui/DetailTabs.vue'
import ProjectTimeline from '@/components/workspace/ProjectTimeline.vue'
import ProjectRepositoryPanel from './ProjectRepositoryPanel.vue'
import ProjectWorkspace from './ProjectWorkspace.vue'
import ProjectNotes from './ProjectNotes.vue'
import {useProjectLaunch} from '@/composables/useProjectLaunch'
const launcher=useProjectLaunch()
import {useArchiveAssistant} from '@/composables/useArchiveAssistant'
const archiveAssistant=useArchiveAssistant(),legacy=ref(false)
import type {ProjectItem,ProjectSession,ProjectSessionSummary,ProjectMessage} from '@/types/project'
const props=defineProps<{item:ProjectItem}>(),emit=defineEmits<{updated:[]}>(),router=useRouter(),route=useRoute(),tab=ref('overview')
const tabs=[{id:'timeline',label:'项目日志'},{id:'overview',label:'工作区概览'},{id:'notes',label:'项目便签'},{id:'chat',label:'归档助理'},{id:'entries',label:'项目入口'},{id:'info',label:'项目资料'}]
const defaultTab=ref('timeline')
watch(()=>route.query.tab,value=>{tab.value=tabs.some(t=>t.id===value)?String(value):defaultTab.value},{immediate:true})
void window.baoyi.project.preferences().then(value=>{defaultTab.value=value.defaultTab||'timeline';if(!disposed&&!route.query.tab&&!route.query.session)tab.value=defaultTab.value}).catch(()=>{})
const error=ref(''),sessions=ref<ProjectSessionSummary[]>([]),session=ref<ProjectSession|null>(null),selected=ref(''),messages=ref<HTMLElement>()
const repositoryBusy=ref(false),selecting=ref(false)
const busy=computed(()=>selecting.value||repositoryBusy.value||session.value?.status==='running')
let disposed=false
let sessionsRun=0,selectionRun=0
async function syncRoute(value:string) {
  if(disposed || route.params.id!==props.item.id)return
  const id=value==='chat'?session.value?.id:undefined
  if(route.query.tab===value && route.query.session===id)return
  await router.replace({query:{...route.query,tab:value,session:id}})
}
async function changeTab(value:string) {
  selectionRun++;selecting.value=false;selected.value=session.value?.id||''
  tab.value=value
  try{await syncRoute(value)}catch(e){if(!disposed)error.value=(e as Error).message}
}
async function acceptSession(value:ProjectSession|null,openChat=false) {
  if(!value || value.projectId!==props.item.id)throw new Error('此对话不存在或不属于当前项目')
  session.value=value;selected.value=value.id
  if(openChat)tab.value='chat'
  if(tab.value==='chat')await syncRoute('chat')
}
async function loadSessions() {
  const run=++sessionsRun,result=await window.baoyi.project.sessions(props.item.id)
  if(disposed||run!==sessionsRun)return
  sessions.value=result
  if(!session.value&&!selected.value&&!route.query.session&&!selecting.value&&result.length){
    const target=result[0].id,selection=++selectionRun
    selected.value=target;selecting.value=true
    try{
      const loaded=await window.baoyi.project.session(target)
      if(!disposed&&selection===selectionRun&&selected.value===target&&run===sessionsRun)await acceptSession(loaded)
    }finally{if(!disposed&&selection===selectionRun)selecting.value=false}
  }
}
watch(()=>props.item.id,async()=>{session.value=null;selected.value='';try{await loadSessions()}catch(e){if(!disposed)error.value=(e as Error).message}},{immediate:true})
async function switchSession() {
  const run=++selectionRun,target=selected.value;selecting.value=true;error.value=''
  try{
    const result=await window.baoyi.project.session(target)
    if(!disposed&&run===selectionRun&&selected.value===target)await acceptSession(result,true)
  }catch(e){if(!disposed&&run===selectionRun){selected.value=session.value?.id||'';error.value=(e as Error).message}}
  finally{if(!disposed&&run===selectionRun)selecting.value=false}
}
watch(()=>route.query.session,async value=>{
  if(typeof value==='string'&&value&&session.value?.id===value&&selected.value===value){
    tab.value='chat'
    try{await syncRoute('chat')}catch(e){if(!disposed)error.value=(e as Error).message}
    return
  }
  const run=++selectionRun
  if(typeof value!=='string'||!value){selecting.value=false;selected.value=session.value?.id||'';return}
  legacy.value=true;selecting.value=true;error.value=''
  try{
    const target=await window.baoyi.project.session(value)
    if(disposed||run!==selectionRun||route.query.session!==value)return
    await acceptSession(target,true)
    if(!disposed&&run===selectionRun)await loadSessions()
  }catch(e){if(!disposed&&run===selectionRun){selected.value=session.value?.id||'';error.value=(e as Error).message}}
  finally{if(!disposed&&run===selectionRun)selecting.value=false}
},{immediate:true})
async function apply(message:ProjectMessage){if(!session.value)return;error.value='';try{session.value=await window.baoyi.project.applyProposal(session.value.id,message.id);emit('updated')}catch(e){error.value=(e as Error).message}}
const notes=ref<InstanceType<typeof ProjectNotes>>()
async function projectKey(event:KeyboardEvent){
  if(event.defaultPrevented||event.isComposing||document.querySelector('dialog[open],[role="dialog"]')||!event.ctrlKey||!event.shiftKey||event.altKey)return
  if(event.code==='KeyL'){event.preventDefault();launcher.open(props.item)}
  else if(event.code==='KeyM'){event.preventDefault();await changeTab('notes');await nextTick();notes.value?.focusNext()}
}
onMounted(()=>document.addEventListener('keydown',projectKey))
onBeforeUnmount(()=>document.removeEventListener('keydown',projectKey))
const labels:Record<string,string>={name:'名称',summary:'简介',category:'分类',source:'来源',state:'状态',group:'分组',tags:'标签',notes:'备注'}
const display=(value:unknown)=>Array.isArray(value)?value.join('、'):String(value||'（空）')
const unsubscribe=window.baoyi.project.onSession(value=>{if(value.projectId!==props.item.id||value.id!==selected.value)return;session.value=value;void nextTick(()=>{if(messages.value)messages.value.scrollTop=messages.value.scrollHeight})})
onBeforeUnmount(()=>{disposed=true;sessionsRun++;selectionRun++;unsubscribe()})
</script>
<template><section class="project-workbench"><div class="project-launch-toolbar"><button class="pj-button" @click="launcher.open(item)">启动项目</button><button v-if="launcher.last(item.id)" class="pj-button" @click="launcher.rerun(item)">重跑上次 · {{launcher.last(item.id)?.profileName}}</button></div><DetailTabs :model-value="tab" :tabs="tabs" prefix="project" label="项目详情" @update:model-value="changeTab"/><p v-if="error" class="pj-error" role="alert">{{error}}</p>
<div v-show="tab==='timeline'" id="project-panel-timeline" role="tabpanel" aria-labelledby="project-tab-timeline"><ProjectTimeline :id="item.id"/></div>
<div v-show="tab==='notes'" id="project-panel-notes" role="tabpanel" aria-labelledby="project-tab-notes"><ProjectNotes ref="notes" :key="item.id" :item="item"/></div>
<div v-show="tab==='overview'" id="project-panel-overview" role="tabpanel" aria-labelledby="project-tab-overview"><ProjectWorkspace :id="item.id" :path="item.path" @ask="archiveAssistant.show($event,[item.id])"/></div>
<div v-show="tab==='chat'" id="project-panel-chat" role="tabpanel" aria-labelledby="project-tab-chat" class="project-chat"><section class="archive-intro"><Bot :size="28"/><h3>把这个项目交给归档助理</h3><p>带上当前项目，查找文件、理解资料、完善分类与标签，也能关联其他收藏。</p><button class="pj-button pj-primary" @click="archiveAssistant.show(undefined,[item.id])">打开归档助理</button><button class="pj-button" @click="legacy=!legacy">{{legacy?'收起旧对话':'查看升级前的项目对话'}}</button></section><div v-show="legacy"><div class="chat-toolbar"><select v-model="selected" aria-label="项目对话" :disabled="busy" @change="switchSession"><option v-if="!sessions.length" value="">新对话</option><option v-for="s in sessions" :key="s.id" :value="s.id">{{s.title}}</option></select><button v-if="session" class="pj-button" @click="archiveAssistant.show(`请先用 archive_history 读取升级前的项目会话 ${session.id}，kind 为 project，再结合当前资料继续处理尚未完成的归档事项。`,[item.id])">交给归档助理继续</button><span v-if="session?.tokens">{{session.tokens}} tokens</span></div><ProjectRepositoryPanel v-if="session" :session="session" :busy="busy" @updated="session=$event" @working="repositoryBusy=$event"/><div ref="messages" class="chat-messages" aria-live="polite"><div v-if="!session?.messages.length" class="chat-welcome"><p>这里保留升级前的项目对话，新任务可从上方打开归档助理。</p></div><article v-for="message in session?.messages||[]" :key="message.id" class="chat-message" :class="message.role"><span class="chat-author">{{message.role==='user'?'你':'抱一助手'}}</span><details v-if="message.events.length" class="chat-trace"><summary>处理过程 · {{message.events.length}} 条记录</summary><div v-for="(event,i) in message.events" :key="i" :class="{'trace-error':event.error}"><strong>{{event.label}}</strong><pre>{{event.detail}}</pre></div></details><p class="chat-text">{{message.text||'正在查看项目…'}}</p><section v-if="message.proposal" class="chat-proposal"><h4>项目资料建议</h4><div v-for="(value,key) in message.proposal.patch" :key="key"><strong>{{labels[key]||key}}</strong><span class="proposal-before">{{display(message.proposal.before[key])}}</span><span>{{display(value)}}</span></div><button class="pj-button pj-primary" :disabled="busy||message.proposal.applied" @click="apply(message)"><Check :size="15"/>{{message.proposal.applied?'已应用':'应用资料建议'}}</button></section></article><p v-if="session?.error" class="chat-error" role="status">{{session.error}}</p></div></div></div><div v-show="tab==='entries'" id="project-panel-entries" role="tabpanel" aria-labelledby="project-tab-entries" class="workbench-content"><slot name="entries"/></div><div v-show="tab==='info'" id="project-panel-info" role="tabpanel" aria-labelledby="project-tab-info" class="workbench-content"><slot name="info"/></div></section></template>
<style scoped>
.project-launch-toolbar{display:flex;gap:10px;padding:16px 24px 0;flex-wrap:wrap}
.archive-intro{padding:38px 28px;border-bottom:1px solid var(--divider)}.archive-intro>svg{color:var(--accent)}.archive-intro h3{font-size:21px;font-weight:500}.archive-intro p{color:var(--text-sub);font-size:13px;line-height:1.9}.archive-intro button{margin:12px 12px 0 0}

.registration-status{display:flex;align-items:center;gap:10px;margin-top:18px;padding:12px 14px;background:var(--active-surface);border-radius:8px;color:var(--text-sub);font-size:12px}.registration-status>span{flex:1}.project-workbench>.detail-tabs{padding:0 20px}.workbench-content{padding:24px}.project-workbench{margin:20px 0;background:var(--bg-card);border:1px solid var(--divider);border-radius:12px;overflow:hidden}.workbench-tabs{display:flex;align-items:center;border-bottom:1px solid var(--divider);padding:0 22px;gap:24px}.workbench-tabs>button{display:flex;align-items:center;gap:8px;padding:17px 0;color:var(--text-sub);border-bottom:2px solid transparent;font-size:14px}.workbench-tabs>button.active{color:var(--accent);border-bottom-color:var(--accent)}.workbench-tabs>.workbench-settings{margin-left:auto;font-size:12px}.working-dot{width:6px;height:6px;background:var(--accent);border-radius:50%}.workspace-overview{padding:24px}.workspace-title{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.workspace-title>div{margin-right:auto}.workspace-title h2{font-size:19px;margin:0 0 6px}.workspace-title p,.workspace-grid p{font-size:12px;color:var(--text-sub);line-height:1.8}.workspace-grid{display:grid;grid-template-columns:1fr 1.1fr;gap:30px;margin-top:18px}.workspace-grid h3{display:flex;align-items:center;gap:8px;font-size:13px;margin:0 0 16px}.workspace-grid h3 span{color:var(--text-faint);font-weight:400}.workspace-files ul{list-style:none;padding:0;margin:0;max-height:340px;overflow:auto}.workspace-files li{display:flex;align-items:center;gap:9px;padding:7px 0;color:var(--text-sub);font-size:12px;overflow-wrap:anywhere}.workspace-git{padding-bottom:20px}.workspace-git>strong{font-size:13px;color:var(--accent)}.workspace-git pre{font-size:11px;white-space:pre-wrap;max-height:140px;overflow:auto;color:var(--text-sub)}.workspace-scripts{max-height:280px;overflow:auto;border-top:1px solid var(--divider);padding-top:18px}.workspace-scripts>div{display:flex;gap:12px;font-size:12px;margin:10px 0}.workspace-scripts strong{min-width:60px;font-weight:500}.workspace-scripts code{overflow-wrap:anywhere;color:var(--text-sub)}.project-chat{max-width:1000px;margin:auto}.chat-toolbar{display:flex;align-items:center;gap:12px;padding:16px 22px;border-bottom:1px solid var(--divider)}.chat-toolbar select{flex:1;min-width:0;max-width:500px}.chat-toolbar>span{margin-left:auto;font-size:11px;color:var(--text-faint)}.chat-messages{height:450px;overflow:auto;padding:24px}.chat-welcome{text-align:center;padding:48px 10px;color:var(--text-sub)}.chat-welcome h3{color:var(--text-main);font-size:20px;font-weight:500}.chat-welcome p{font-size:13px}.chat-welcome>div{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:24px}.chat-welcome button{border:1px solid var(--divider);padding:9px 14px;border-radius:7px;font-size:12px}.chat-message{margin:0 0 24px}.chat-message.user{background:var(--hover-surface);border-radius:8px;padding:14px 18px;margin-left:48px}.chat-author{font-size:11px;color:var(--text-faint)}.chat-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.85;margin:7px 0}.chat-trace{margin-top:10px;border:1px solid var(--divider);border-radius:7px;font-size:12px;color:var(--text-sub)}.chat-trace summary{cursor:pointer;padding:10px}.chat-trace>div{padding:10px;border-top:1px solid var(--divider)}.chat-trace pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;font-size:11px}.trace-error,.chat-error{color:var(--danger)}.chat-proposal{padding:18px;background:var(--active-surface);border-radius:8px}.chat-proposal h4{margin:0 0 14px;font-size:13px}.chat-proposal>div{display:grid;grid-template-columns:60px 1fr 1fr;gap:14px;padding:10px 0;font-size:12px;border-top:1px solid var(--divider);white-space:pre-wrap;overflow-wrap:anywhere}.proposal-before{color:var(--text-faint)}.chat-proposal button{margin-top:14px}.chat-composer{border-top:1px solid var(--divider);padding:16px 22px}.chat-composer textarea{width:100%;min-height:76px;max-height:220px;resize:vertical;background:transparent;border:0;outline:0;font:inherit;font-size:14px;line-height:1.7}.chat-composer>div{display:flex;justify-content:space-between;align-items:center}.chat-composer>div>span{font-size:11px;color:var(--text-faint)}@media(max-width:1100px){.workspace-grid{gap:18px}.workspace-title .pj-button{font-size:12px}.chat-proposal>div{grid-template-columns:50px 1fr 1fr}}
@media(max-width:800px){.workspace-grid{grid-template-columns:minmax(0,1fr)}.workspace-overview{padding:16px}.registration-status{display:flex;align-items:center;gap:10px;margin-top:18px;padding:12px 14px;background:var(--active-surface);border-radius:8px;color:var(--text-sub);font-size:12px}.registration-status>span{flex:1}.project-workbench>.detail-tabs{padding:0 20px}.workbench-content{padding:16px}.chat-toolbar{flex-wrap:wrap}.chat-messages{height:360px}}
</style>
