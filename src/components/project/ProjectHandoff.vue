<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { errorMessage } from '@/utils'
import {onBeforeUnmount,ref,watch} from 'vue'
import {Copy,Sparkles} from 'lucide-vue-next'
import ProjectDialog from './ProjectDialog.vue'
import type {ProjectHandoffPreview,ProjectHandoffResult} from '@/types/project-handoff'
import {useArchiveAssistant} from '@/composables/useArchiveAssistant'
const props=defineProps<{id:string}>(),emit=defineEmits<{close:[]}>(),api=window.baoyi.archive,assistant=useArchiveAssistant()
const preview=ref<ProjectHandoffPreview|null>(null),result=ref<ProjectHandoffResult|null>(null),includeRules=ref(false),remember=ref(false),busy=ref(false),loading=ref(false),error=ref(''),notice=ref(''),adopted=ref(false)
let revision=0,disposed=false
async function load(automatic=false){
  const run=++revision;loading.value=true;error.value='';preview.value=null
  try{const value=await api.projectHandoffPreview(props.id,automatic?undefined:includeRules.value);if(disposed||run!==revision)return;preview.value=value;includeRules.value=value.includeRules;if(automatic)remember.value=value.remembered;if(automatic&&value.remembered&&value.configured)await generate();return value}
  catch(e){if(!disposed&&run===revision)error.value=errorMessage(e)}
  finally{if(run===revision)loading.value=false}
}
async function generate(){
  if(!preview.value||busy.value)return;busy.value=true;error.value='';notice.value='';adopted.value=false;const run=revision
  try{const value=await api.projectHandoffGenerate({token:preview.value.token,stamp:preview.value.stamp,remember:remember.value});if(!disposed&&run===revision)result.value=value}
  catch(e){if(!disposed&&run===revision){error.value=errorMessage(e);preview.value=null}}
  finally{if(run===revision)busy.value=false}
}
async function adjustScope(){
  if(busy.value||loading.value)return
  result.value=null;notice.value='';adopted.value=false
  return await load()
}
async function regenerate(){
  const value=await adjustScope()
  // Generation consumes the previous preview token; always obtain a fresh one.
  if(value?.configured)await generate()
}
async function copy(text:string){try{await window.baoyi.app.copyText(text);notice.value=tr("已复制，可以继续使用")}catch(e){error.value=errorMessage(e)}}
async function adopt(){if(!result.value)return;try{await api.projectHandoffAdopt(props.id,result.value.contextRevision,result.value.prompt);adopted.value=true;notice.value=tr("已设为关键 Prompt")}catch(e){error.value=errorMessage(e)}}
async function history(){if(!result.value)return;await assistant.show();await assistant.load(result.value.sessionId);emit('close')}
async function stop(){try{await api.projectHandoffCancel(props.id)}catch(e){error.value=errorMessage(e)}}
watch(()=>props.id,()=>{result.value=null;preview.value=null;void load(true)},{immediate:true})
watch(assistant.privacyRevision,()=>emit('close'))
onBeforeUnmount(()=>{disposed=true;revision++;if(busy.value)void api.projectHandoffCancel(props.id)})
</script>
<template>
  <ProjectDialog :title="$t('生成下一步 Prompt')" wide @close="emit('close')">
    <p v-if="loading&&!busy" role="status">{{ $t("正在整理项目便签与 Git 状态…") }}</p>
    <p v-if="error" class="pj-error" role="alert">{{$systemMessage(error)}}</p><p v-if="notice" role="status">{{notice}}</p>
    <template v-if="result">
      <h3>{{result.goal}}</h3><div class="handoff-columns"><section><h4>{{ $t("已知事实") }}</h4><ul><li v-for="fact in result.facts" :key="fact">{{fact}}</li></ul></section><section><h4>{{ $t("约束") }}</h4><ul><li v-for="value in result.constraints" :key="value">{{value}}</li></ul></section></div>
      <h4>{{ $t("建议 Prompt") }}</h4><textarea :value="result.prompt" readonly :aria-label="$t('生成的下一步 Prompt')" rows="10"/>
      <h4>{{ $t("验收项") }}</h4><ul><li v-for="value in result.acceptance" :key="value">{{value}}</li></ul>
      <div class="handoff-actions"><button class="pj-button" @click="copy(result.prompt)"><Copy :size="14"/>{{ $t("复制 Prompt") }}</button><button class="pj-button pj-primary" :disabled="adopted" @click="adopt">{{adopted?$t('已采用'):$t('设为关键 Prompt')}}</button><button class="pj-button" @click="history">{{ $t("查看生成记录") }}</button><button class="pj-button" :disabled="busy||loading" @click="regenerate">{{ $t("重新生成") }}</button><button class="pj-button" :disabled="busy||loading" @click="adjustScope">{{ $t("返回调整范围") }}</button></div>
    </template>
    <template v-else-if="preview">
      <p class="handoff-lead">{{ $t("将项目名称、Git 分支与短状态、便签和规则链接发送给") }}<strong>{{preview.provider}}</strong>。</p>
      <p class="pj-muted">{{ $t("生成过程只读取这份快照。完整 Diff、日志和未跟踪文件正文不在范围内。快照及结果会保存在本机助理会话。") }}</p>
      <label class="handoff-check"><input v-model="includeRules" type="checkbox" :disabled="busy||loading" @change="load()"/>{{ $t("同时发送项目内规则文件正文（总计最多 12,000 字）") }}</label>
      <details><summary>{{ $t("核对实际发送内容") }}</summary><pre>{{JSON.stringify(preview.snapshot,null,2)}}</pre></details>
      <p v-for="warning in preview.snapshot.warnings" :key="warning" class="pj-muted">{{$systemMessage(warning)}}</p>
      <p v-for="rule in preview.snapshot.rules.filter(value=>value.warning||value.truncated)" :key="rule.path" class="pj-muted">{{rule.path}}：{{rule.warning||$t('只读取了部分文字')}}</p>
      <label class="handoff-check"><input v-model="remember" type="checkbox" :disabled="busy"/>{{ $t("记住此项目的发送范围；模型、规则或范围变化时重新预览") }}</label>
      <div class="handoff-actions"><button class="pj-button pj-primary" :disabled="busy||loading||!preview.configured" @click="generate"><Sparkles :size="15"/>{{busy?$t('正在生成…'):$t('生成 Prompt')}}</button><button v-if="busy" class="pj-button" @click="stop">{{ $t("停止生成") }}</button><button class="pj-button" @click="copy(preview.localPrompt)"><Copy :size="14"/>{{ $t("复制本地交接模板") }}</button></div>
      <p v-if="!preview.configured" class="pj-muted">{{ $t("尚未启用模型，可直接使用本地交接模板。") }}</p>
    </template>
    <button v-else-if="!loading&&!busy" class="pj-button" @click="load()">{{ $t("重新整理发送范围") }}</button>
  </ProjectDialog>
</template>
<style scoped>
.handoff-lead{font-size:14px;line-height:1.8}.handoff-check{display:flex;gap:9px;align-items:center;font-size:12px;margin:18px 0}.handoff-actions{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.handoff-columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}h3{font-size:17px}h4{font-size:13px;margin:18px 0 8px}ul{padding-left:20px;font-size:13px;line-height:1.8}textarea{box-sizing:border-box;width:100%;padding:12px;background:var(--bg-card);color:var(--text-main);border:1px solid var(--divider);border-radius:6px;resize:vertical;font:inherit;font-size:13px;line-height:1.8}details{font-size:12px;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;background:var(--hover-surface);padding:12px;font-size:11px}@media(max-width:800px){.handoff-columns{grid-template-columns:1fr;gap:0}}
</style>
