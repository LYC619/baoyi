<script setup lang="ts">
import {ref,onMounted} from 'vue'
import type {DocumentInsightPolicy,DocumentInsightCleanup} from '@/types/document-insight'
import {useDocumentsStore} from '@/stores/documents'
const store=useDocumentsStore(),value=ref<DocumentInsightPolicy|null>(null),error=ref(''),message=ref(''),busy=ref(false)
const cleanup=ref<DocumentInsightCleanup|null>(null)
onMounted(async()=>{try{value.value=await window.baoyi.archive.insights.policy()}catch(e){error.value=(e as Error).message}})
async function save(){
  if(!value.value||busy.value)return
  error.value='';message.value=''
  if(value.value.automatic&&!value.value.categories.length){error.value='请至少选择一个分类后再保存自动精读设置';return}
  busy.value=true
  try{value.value=await window.baoyi.archive.insights.savePolicy(JSON.parse(JSON.stringify(value.value)));message.value='已保存，仅对之后导入的资料生效'}catch(e){error.value=(e as Error).message}finally{busy.value=false}
}
async function maintain(kind:'preview'|'cleanup'|'cache'){
  busy.value=true;error.value='';message.value=''
  try{
    if(kind==='preview')cleanup.value=await window.baoyi.archive.insights.cleanupPreview()
    else if(kind==='cleanup'&&cleanup.value){const count=await window.baoyi.archive.insights.cleanup(cleanup.value.token);cleanup.value=null;message.value=`已清理 ${count} 份生成稿，人工修订保留`}
    else if(kind==='cache'){await window.baoyi.archive.insights.clearCache();message.value='已清除本次来源核验缓存；下次查看会重新核对原文'}
  }catch(e){error.value=(e as Error).message}finally{busy.value=false}
}
</script>
<template>
  <details class="ws-card insight-settings"><summary>精读速览</summary>
    <template v-if="value">
      <p>使用文库的模型配置：{{value.provider}}</p>
      <label>触发方式<select v-model="value.automatic"><option :value="false">手动（默认）</option><option :value="true">对所选分类自动生成</option></select></label>
      <fieldset v-if="value.automatic"><legend>仅新导入这些分类时</legend><label v-for="category in store.categories" :key="category.id"><input v-model="value.categories" type="checkbox" :value="category.id"/>{{category.name}}</label></fieldset>
      <label>每份读取预算<select v-model="value.maxChars"><option :value="12000">12,000 字符</option><option :value="24000">24,000 字符</option><option :value="48000">48,000 字符</option></select></label>
      <p>会向上述模型发送选定正文片段，每批最多 20 份。超过 30 页 PDF 读取前 15 页与后 10 页；人工修订保留为当前版本。服务商或模型变化后，自动精读暂停，需重新授权。</p>
      <p class="ws-muted">精读笔记和提炼会话会保留。提取正文仅在本次任务内使用，不生成持久全文缓存。</p>
      <button class="ws-button" :disabled="busy" @click="save">{{value.automatic?'授权并保存自动精读':'保存精读设置'}}</button>
      <details class="insight-maintenance"><summary>精读数据维护</summary><p>正文没有持久提取缓存；来源核验缓存只在本次运行内保存。清理生成稿不会删除原文件、人工修订或提炼会话。</p><div><button class="ws-button" :disabled="busy" @click="maintain('cache')">清除来源核验缓存</button> <button class="ws-button" :disabled="busy" @click="maintain('preview')">预览生成稿清理</button></div><div v-if="cleanup" role="status"><p>将删除 {{cleanup.generated}} 份生成稿，保留 {{cleanup.edited}} 份人工修订。此操作无法撤销；需要留存时请先导出资料库备份。</p><button class="ws-button" :disabled="busy||!cleanup.generated" @click="maintain('cleanup')">确认删除生成稿</button> <button class="ws-button" :disabled="busy" @click="cleanup=null">取消</button></div></details>
    </template>
    <p v-if="error" class="ws-error" role="alert">{{error}}</p><p v-if="message" role="status">{{message}}</p>
  </details>
</template>
<style scoped>.insight-settings{font-size:13px;line-height:1.8}.insight-settings summary{cursor:pointer;font-weight:600}.insight-settings>label{display:flex;align-items:center;gap:12px;margin:14px 0}.insight-settings fieldset{border:1px solid var(--divider);display:flex;flex-wrap:wrap;gap:12px}.insight-settings fieldset label{display:flex;align-items:center;gap:5px}</style>
