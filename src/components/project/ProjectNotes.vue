<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'
import { computed,onBeforeUnmount,ref,shallowRef,shallowReactive,watch } from 'vue'
import { onBeforeRouteLeave,onBeforeRouteUpdate,useRoute,useRouter } from 'vue-router'
import { Copy,FileText,Plus,RefreshCw,Save,X } from 'lucide-vue-next'
import ProjectHandoff from './ProjectHandoff.vue'
import { ProjectNotesSession } from '@/utils/project-notes'
import type { ProjectItem,ProjectRuleStatus } from '@/types/project'
import type { ProjectRule } from '@/types/workspace'

const route=useRoute(),router=useRouter(),handoff=ref(false)
const props=defineProps<{item:ProjectItem}>(),tick=ref(0),editor=shallowRef<ProjectNotesSession>()
const nextInput=ref<HTMLTextAreaElement>(),ruleStates=ref<ProjectRuleStatus[]>([]),copied=ref(false)
let ruleRequest=0
const ruleType=ref<'path'|'entry'>('path'),ruleValue=ref(''),ruleLabel=ref(''),localError=ref(''),details=ref(false)
const state=computed(()=>{void tick.value;return editor.value!})
const status=computed(()=>state.value.saving?tr("正在保存…"):state.value.error?tr("保存未完成"):state.value.loading?tr("正在载入…"):state.value.dirty?tr("尚未保存"):state.value.loaded?tr("已保存到本机"):tr("尚未载入"))
watch(()=>props.item.id,id=>{
  editor.value?.dispose();ruleValue.value='';ruleLabel.value='';localError.value=''
  editor.value=shallowReactive(new ProjectNotesSession(id,window.baoyi.workspace.timeline,()=>tick.value++))
  void editor.value.load()
},{immediate:true})
watch(()=>[props.item.id,state.value.saved.revision],async()=>{
  const run=++ruleRequest,id=props.item.id;ruleStates.value=[]
  try{const value=await window.baoyi.project.rules(id);if(run===ruleRequest)ruleStates.value=value}catch (cause) { useToast().error(errorMessage(cause)) }
},{immediate:true})
function ruleState(rule:ProjectRule){return ruleStates.value.find(value=>value.key===rule.type+':'+rule.value)}
async function copyPrompt(){try{await window.baoyi.app.copyText(state.value.value.prompt);copied.value=true}catch(e){localError.value=errorMessage(e)}}
function focusNext(){nextInput.value?.focus()}
function edit(field:'current'|'next'|'prompt',event:Event){state.value.edit({[field]:(event.target as HTMLTextAreaElement).value})}
function addRule(){
  const value=ruleValue.value.trim(),entry=props.item.entries.find(e=>e.id===value)
  const label=ruleLabel.value.trim()||(ruleType.value==='entry'?entry?.label:value)
  if(!value||!label){localError.value=tr("填写规则文件路径，或选择一个已有入口");return}
  if(state.value.value.rules.length>=20){localError.value=tr("最多保留 20 个规则链接");return}
  localError.value='';state.value.edit({rules:[...state.value.value.rules,{type:ruleType.value,value,label}]})
  ruleValue.value='';ruleLabel.value=''
}
function removeRule(index:number){state.value.edit({rules:state.value.value.rules.filter((_,i)=>i!==index)})}
async function openRule(rule:ProjectRule){
  try{if(rule.type==='path')await window.baoyi.project.openFile(props.item.id,rule.value);else await window.baoyi.project.open(props.item.id,rule.value)}
  catch(error){localError.value=errorMessage(error)}
}
const flush=()=>state.value.flush()
async function openHandoff(){if(await flush())handoff.value=true}
async function closeHandoff(){handoff.value=false;if(route.query.handoff)await router.replace({query:{...route.query,handoff:undefined}})}
watch(()=>[state.value.loaded,route.query.handoff],()=>{if(state.value.loaded&&route.query.handoff==='1')void openHandoff()},{immediate:true})
function saveOnBlur(){if(!state.value.error)void flush()}
onBeforeRouteLeave(flush);onBeforeRouteUpdate(flush)
const unsubscribe=window.baoyi.workspace.onChanged(()=>void editor.value?.load())
function unloading(event:BeforeUnloadEvent){if(editor.value?.dirty){event.preventDefault();event.returnValue='';void editor.value.flush()}}
window.addEventListener('beforeunload',unloading)
onBeforeUnmount(()=>{ruleRequest++;unsubscribe();window.removeEventListener('beforeunload',unloading);editor.value?.dispose()})
defineExpose({flush,focusNext})
</script>

<template>
  <section class="project-notes" :aria-label="$t('项目便签')" @compositionstart="state.composition(true)" @compositionend="state.composition(false)" @keydown.ctrl.enter.prevent.stop="flush">
    <header><div><FileText :size="17"/><h3>{{ $t("接着上次继续") }}</h3></div><span role="status" :class="{failed:state.error}">{{status}}<small v-if="state.saved.updatedAt" class="saved-time"> · {{new Date(state.saved.updatedAt).toLocaleString($locale)}}</small></span><button class="pj-icon" :aria-label="$t('保存项目便签')" :disabled="state.saving||!state.dirty" @click="flush"><Save :size="16"/></button></header>
    <div class="note-grid">
      <label>{{ $t("当前情况") }}<textarea :value="state.value.current" :disabled="!state.loaded" maxlength="4000" :placeholder="$t('上次做到哪里，有什么值得记住？')" @input="edit('current',$event)" @blur="saveOnBlur"/></label>
      <label>{{ $t("下一步") }}<textarea ref="nextInput" :value="state.value.next" :disabled="!state.loaded" maxlength="2000" :placeholder="$t('下次打开时，从哪一步开始？')" @input="edit('next',$event)" @blur="saveOnBlur"/></label>
    </div>
    <button class="more" :aria-expanded="details" @click="details=!details">{{ $t("{p0}关键 Prompt 与规则", {p0: (details?$t('收起'):$t('展开'))}) }}<span v-if="state.value.rules.length">{{ $t("· {p0} 个链接", {p0: (state.value.rules.length)}) }}</span></button>
    <div v-if="details" class="note-details">
      <label>{{ $t("关键 Prompt") }}<span>{{state.value.prompt.length}} / 8000</span><textarea class="prompt" :value="state.value.prompt" :disabled="!state.loaded" maxlength="8000" :placeholder="$t('保留可复用的要求、背景和交接提示词。')" @input="edit('prompt',$event)" @blur="saveOnBlur"/></label>
      <button class="pj-button" :disabled="!state.value.prompt" @click="copyPrompt"><Copy :size="14"/>{{copied?$t('已复制 Prompt'):$t('复制 Prompt')}}</button><h4>{{ $t("规则与参考") }}</h4>
      <ul v-if="state.value.rules.length"><li v-for="(rule,index) in state.value.rules" :key="index"><button class="rule-link" @click="openRule(rule)">{{rule.label}}<small>{{rule.type==='path'?rule.value:$t('项目入口')}} · {{ruleState(rule)?.message||$t('待检查')}}</small></button><button class="pj-icon" :aria-label="$t('移除规则 ')+rule.label" @click="removeRule(index)"><X :size="14"/></button></li></ul>
      <form class="rule-form" @submit.prevent="addRule"><select v-model="ruleType" :aria-label="$t('规则链接类型')" @change="ruleValue=''"><option value="path">{{ $t("项目内文件") }}</option><option value="entry">{{ $t("已有入口") }}</option></select><input v-if="ruleType==='path'" v-model="ruleValue" :aria-label="$t('规则相对路径')" :placeholder="$t('如 AGENTS.md 或 docs/规范.md')" maxlength="2048"/><select v-else v-model="ruleValue" :aria-label="$t('选择规则入口')"><option value="">{{ $t("选择入口") }}</option><option v-for="entry in item.entries.filter(e=>e.type!=='command')" :key="entry.id" :value="entry.id">{{entry.label}}</option></select><input v-model="ruleLabel" :aria-label="$t('规则显示名称')" :placeholder="$t('显示名称（可选）')" maxlength="160"/><button class="pj-button" :disabled="!state.loaded" type="submit"><Plus :size="14"/>{{ $t("添加") }}</button></form>
    </div>
    <p v-if="localError" class="pj-error" role="alert">{{localError}}</p>
    <section v-if="state.error" class="note-error" role="alert"><p>{{$systemMessage(state.error)}}</p><button class="pj-button" @click="state.loaded?flush():state.load()"><RefreshCw :size="14"/>{{ $t("重试") }}</button><button v-if="state.loaded" class="pj-button" @click="state.compare()">{{ $t("比较最新内容") }}</button>
      <div v-if="state.latest" class="note-compare"><h4>{{ $t("当前保存的版本") }}</h4><pre>{{ $t("当前情况：{p0} 下一步：{p1} 关键 Prompt：{p2} 规则：{p3}", {p0: (state.latest.current), p1: (state.latest.next), p2: (state.latest.prompt), p3: (state.latest.rules.map(r=>r.label+' ('+r.value+')').join('\n'))}) }}</pre><p>{{ $t("上方编辑区仍保留你的输入。选择要保存的版本后再继续。") }}</p><button class="pj-button" @click="state.useLatest()">{{ $t("采用已保存版本") }}</button><button class="pj-button pj-primary" @click="state.keepMine()">{{ $t("保留我的内容并保存") }}</button></div>
    </section>
    <div class="handoff-entry"><button class="pj-button" :disabled="!state.loaded" @click="openHandoff">{{ $t("生成下一步 Prompt") }}</button></div>
    <ProjectHandoff v-if="handoff" :id="item.id" @close="closeHandoff"/>
  </section>
</template>

<style scoped>
.handoff-entry{display:flex;justify-content:flex-end;margin-top:18px}
.handoff-entry{margin-top:12px}.project-notes{padding:20px 24px;border-bottom:1px solid var(--divider)}header,header>div{display:flex;align-items:center;gap:8px}header h3{font-size:14px;margin:0}header>span{margin-left:auto;font-size:11px;color:var(--text-faint)}.saved-time{font-size:10px}.note-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:14px}label{display:block;font-size:12px;color:var(--text-sub)}textarea{display:block;box-sizing:border-box;width:100%;min-height:92px;resize:vertical;margin-top:7px;padding:10px 12px;border:1px solid var(--divider);border-radius:7px;background:var(--bg-card);color:var(--text-main);font:inherit;font-size:13px;line-height:1.75}textarea:focus{outline:2px solid var(--accent);outline-offset:1px}.prompt{min-height:145px}.more{margin-top:12px;font-size:12px;color:var(--text-sub)}.note-details{margin-top:16px}.note-details label>span{float:right;color:var(--text-faint)}h4{font-size:12px;margin:16px 0 10px}ul{list-style:none;margin:0 0 12px;padding:0}li{display:flex;align-items:center;gap:10px;padding:6px 0}.rule-link{text-align:left;flex:1;color:var(--accent);font-size:13px}.rule-link small{display:block;color:var(--text-faint);overflow-wrap:anywhere;font-size:11px;margin-top:3px}.rule-form{display:flex;gap:8px;flex-wrap:wrap}.rule-form input{flex:1;min-width:150px}.rule-form select,.rule-form input{border:1px solid var(--divider);border-radius:5px;background:var(--bg-card);color:var(--text-main);padding:8px;font-size:12px}.note-error{padding:12px 0;font-size:12px;color:var(--danger)}.note-error .pj-button{margin:0 8px 6px 0}.note-compare pre{max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text-sub)}.failed{color:var(--danger)}@media(max-width:800px){.project-notes{padding:16px}.note-grid{grid-template-columns:1fr;gap:12px}}
</style>
