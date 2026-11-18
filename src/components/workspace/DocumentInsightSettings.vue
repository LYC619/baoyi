<script setup lang="ts">
import { errorMessage } from '@/utils'
import {ref} from 'vue'
import type {DocumentInsightCleanup} from '@/types/document-insight'
import {useArchiveAssistant} from '@/composables/useArchiveAssistant'
const error=ref(''),message=ref(''),busy=ref(false),cleanup=ref<DocumentInsightCleanup|null>(null)
async function maintain(kind:'preview'|'cleanup'|'cache'){
  busy.value=true;error.value='';message.value=''
  try{
    if(kind==='preview')cleanup.value=await window.baoyi.archive.insights.cleanupPreview()
    else if(kind==='cleanup'&&cleanup.value){const count=await window.baoyi.archive.insights.cleanup(cleanup.value.token);cleanup.value=null;message.value=`已清理 ${count} 份生成稿，人工修订保留`}
    else if(kind==='cache'){await window.baoyi.archive.insights.clearCache();message.value='已清除本次来源核验缓存；下次查看会重新核对原文'}
  }catch(e){error.value=errorMessage(e)}finally{busy.value=false}
}
</script>
<template>
  <details class="ws-card insight-settings"><summary>精读速览</summary>
    <p>精读已改为归档助理的“文档精读”方法。按你的问题读取原文并给出引用，不再按分类自动生成或在导入后启动。</p>
    <p class="ws-muted">以前的精读结果、人工修订与提炼会话继续保留。旧自动触发设置已停用。</p>
    <button class="ws-button" @click="useArchiveAssistant().loadMethod('document-deep-reader')">在归档助理中使用文档精读</button>
      <details class="insight-maintenance"><summary>精读数据维护</summary><p>正文没有持久提取缓存；来源核验缓存只在本次运行内保存。清理生成稿不会删除原文件、人工修订或提炼会话。</p><div><button class="ws-button" :disabled="busy" @click="maintain('cache')">清除来源核验缓存</button> <button class="ws-button" :disabled="busy" @click="maintain('preview')">预览生成稿清理</button></div><div v-if="cleanup" role="status"><p>将删除 {{cleanup.generated}} 份生成稿，保留 {{cleanup.edited}} 份人工修订。此操作无法撤销；需要留存时请先导出资料库备份。</p><button class="ws-button" :disabled="busy||!cleanup.generated" @click="maintain('cleanup')">确认删除生成稿</button> <button class="ws-button" :disabled="busy" @click="cleanup=null">取消</button></div></details>

    <p v-if="error" class="ws-error" role="alert">{{error}}</p><p v-if="message" role="status">{{message}}</p>
  </details>
</template>
<style scoped>.insight-settings{font-size:13px;line-height:1.8}.insight-settings summary{cursor:pointer;font-weight:600}.insight-settings>label{display:flex;align-items:center;gap:12px;margin:14px 0}.insight-settings fieldset{border:1px solid var(--divider);display:flex;flex-wrap:wrap;gap:12px}.insight-settings fieldset label{display:flex;align-items:center;gap:5px}</style>
