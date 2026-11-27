<script setup lang="ts">
import { errorMessage } from '@/utils'
import {ref,watch,onBeforeUnmount,computed} from 'vue'
import {useRouter} from 'vue-router'
import {useDocumentInsights} from '@/composables/useDocumentInsights'
import {useArchiveAssistant} from '@/composables/useArchiveAssistant'
import type {DocumentInsightDetail,DocumentInsightContent} from '@/types/document-insight'
const props=defineProps<{id:string;categories:Array<{id:string;name:string}>}>(),emit=defineEmits<{updated:[]}>()
const queue=useDocumentInsights(),router=useRouter(),data=ref<DocumentInsightDetail|null>(null),error=ref(''),editing=ref(false),saving=ref(false),draft=ref<DocumentInsightContent|null>(null),tagText=ref(''),actionId=ref('')
let generation=0
const note=computed(()=>data.value?.active),run=computed(()=>queue.runs.value.find(run=>run.documentId===props.id)),running=computed(()=>run.value&&['queued','running'].includes(run.value.status))
async function load(){const own=++generation,id=props.id;try{const next=await window.baoyi.archive.insights.detail(id);if(own===generation)data.value=next}catch(e){if(own===generation)error.value=errorMessage(e)}}
watch(()=>props.id,()=>{editing.value=false;data.value=null;error.value='';actionId.value='';void load()},{immediate:true})
const unsubscribe=window.baoyi.archive.insights.onChanged(()=>{if(!editing.value)void load()});onBeforeUnmount(()=>{generation++;unsubscribe()})
function edit(){if(!note.value)return;const {coreValue,keyConclusions,suggestedCategoryId,suggestedTags,evidence,limitations}=JSON.parse(JSON.stringify(note.value));draft.value={coreValue,keyConclusions,suggestedCategoryId,suggestedTags,evidence,limitations};tagText.value=suggestedTags.join('，');editing.value=true}
async function action(fn:()=>Promise<unknown>){if(saving.value)return;saving.value=true;error.value='';try{await fn();await load();emit('updated')}catch(e){error.value=errorMessage(e)}finally{saving.value=false}}
async function save(){const content=draft.value;if(!content||!note.value)return;content.suggestedTags=tagText.value.split(/[,，]/).map(value=>value.trim()).filter(Boolean);await action(async()=>{await window.baoyi.archive.insights.edit(props.id,note.value!.revision,JSON.parse(JSON.stringify(content)));editing.value=false})}
async function adopt(){await action(async()=>{const result=await window.baoyi.archive.insights.adopt(props.id,note.value!.revision);actionId.value=result.actionId})}
async function undo(){await action(async()=>{const result=await window.baoyi.archive.undo(actionId.value);if(!result.undone)throw new Error(result.reason);actionId.value=''})}
function source(evidence:NonNullable<typeof note.value>['evidence'][number]){void router.push({path:'/document/'+props.id,query:{page:String(evidence.page||1),insight:note.value!.id,evidence:evidence.id}})}
async function activate(versionId:string){await action(()=>window.baoyi.archive.insights.activate(props.id,versionId,note.value!.revision))}
async function history(){if(note.value?.sessionId){const assistant=useArchiveAssistant();await assistant.show();await assistant.load(note.value.sessionId)}}
</script>
<template>
  <section class="insight-panel" :aria-label="$t('资料精读速览')">
    <header><h3>{{ $t("精读速览") }}</h3><span v-if="note?.userEdited" class="ws-badge">{{ $t("人工修订") }}</span><span v-else-if="note" class="ws-badge">{{ $t("已生成") }}</span></header>
    <p v-if="running" role="status">{{run?.phase}} <button class="ws-button" @click="queue.cancel(run!.id)">{{ $t("停止") }}</button></p>
    <p v-else-if="run&&['failed','interrupted','cancelled'].includes(run.status)" class="ws-error">{{run.error||$t('精读已停止，已有笔记保留')}}</p>
    <div v-if="editing&&draft" @keydown.ctrl.enter.prevent="save">
      <label>{{ $t("核心价值") }}<textarea v-model="draft.coreValue" :aria-label="$t('编辑核心价值')" rows="3" maxlength="120"/></label>
      <label v-for="(item,index) in draft.keyConclusions" :key="index">{{ $t("结论 {p0}", {p0: (index+1)}) }}<textarea v-if="item.status==='supported'" v-model="item.text" :aria-label="$t('编辑结论 ')+(index+1)" rows="2" maxlength="180"/><small v-else>{{ $t("证据不足") }}</small></label>
      <label>{{ $t("建议标签") }}<input v-model="tagText" :aria-label="$t('编辑精读标签')" :placeholder="$t('逗号分隔')"/></label>
      <div class="insight-actions"><button class="ws-button primary" :disabled="saving" @click="save">{{ $t("保存修订") }}</button><button class="ws-button" :disabled="saving" @click="editing=false;load()">{{ $t("取消编辑") }}</button></div>
    </div>
    <template v-else-if="note">
      <p class="insight-value">{{note.coreValue}}</p>
      <ol><li v-for="(conclusion,index) in note.keyConclusions" :key="index">{{conclusion.text||$t('证据不足')}}</li></ol>
      <p class="insight-tags">{{categories.find(category=>category.id===note?.suggestedCategoryId)?.name||$t('暂无分类建议')}} <span v-for="tag in note.suggestedTags" :key="tag">#{{tag}}</span></p>
      <div class="insight-actions"><button class="ws-button" @click="edit">{{ $t("编辑并保存") }}</button><button class="ws-button" :disabled="saving" @click="adopt">{{ $t("采用分类与标签") }}</button><button v-if="actionId" class="ws-button" :disabled="saving" @click="undo">{{ $t("撤销采用") }}</button></div>
      <details><summary>{{ $t("原文证据与覆盖范围") }}</summary>
        <p>{{ $t("{p0} · {p1} 字符", {p0: (note.coverage.complete?$t('完整文字提取'):$t('局部精读')), p1: (note.coverage.characters.toLocaleString($locale))}) }}<span v-if="note.coverage.totalPages">{{ $t("· {p0} / {p1} 页", {p0: (note.coverage.pages.length), p1: (note.coverage.totalPages)}) }}</span></p>
        <p v-for="reason in note.coverage.reasons" :key="reason" class="ws-muted">{{reason}}</p>
        <button v-for="evidence in note.evidence" :key="evidence.id" class="insight-quote" @click="source(evidence)"><small>{{evidence.page?$t('第 {p0} 页', { p0: evidence.page }):$t('第 {p0} 行', { p0: evidence.startLine || 1 })}}</small><q>{{evidence.quote}}</q></button>
        <p v-for="limitation in note.limitations" :key="limitation">{{limitation}}</p>
      </details>
      <small class="ws-muted">{{data?.sourceMessage}} · {{new Date(note.generatedAt).toLocaleString($locale)}} · {{note.model}}</small>
      <button class="insight-history" @click="history">{{ $t("查看提炼会话") }}</button>
      <details v-if="data&&data.history.length>1"><summary>{{ $t("版本记录（{p0}）", {p0: (data.history.length)}) }}</summary><div v-for="version in data.history" :key="version.id" class="insight-version"><span>v{{version.revision}} · {{version.userEdited?$t('人工修订'):$t('生成稿')}}</span><button class="ws-button" :disabled="version.active||saving" @click="activate(version.id)">{{version.active?$t('当前'):$t('设为当前')}}</button></div></details>
    </template>
    <p v-else class="ws-muted">{{ $t("在归档助理中按你的问题研读原文，保留可核对的引用。旧精读版本可在这里查看和编辑。") }}</p>
    <button v-if="!editing" class="ws-button" :disabled="!!running||queue.busy.value" @click="queue.open([id])">{{ $t("在归档助理中精读") }}</button>
    <p v-if="error||queue.error.value" class="ws-error" role="alert">{{error||queue.error.value}}</p>
  </section>
</template>
<style scoped>
.insight-panel{border-top:1px solid var(--divider);padding-top:18px;min-width:0;font-size:12px;line-height:1.8}.insight-panel header{display:flex;gap:8px;align-items:center}.insight-panel h3{font-size:15px;margin:0}.insight-value{font-size:14px;font-weight:550}.insight-panel ol{padding-left:20px}.insight-panel li{margin:8px 0}.insight-tags span{display:inline-block;margin-left:5px;color:var(--accent)}.insight-actions{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.insight-panel details{padding:10px 0}.insight-panel summary{cursor:pointer}.insight-quote{display:block;width:100%;text-align:left;padding:9px;margin:8px 0;background:var(--hover-surface);border:1px solid var(--divider);color:var(--text-main);border-radius:5px;cursor:pointer}.insight-quote small{display:block;color:var(--text-muted)}.insight-panel label{display:block;margin:10px 0}.insight-panel textarea,.insight-panel input{width:100%;box-sizing:border-box}.insight-version{display:flex;justify-content:space-between;gap:8px;padding:6px 0}.insight-history{display:block;background:transparent;border:0;padding:6px 0;color:var(--accent);cursor:pointer}.insight-panel small{overflow-wrap:anywhere}
</style>
