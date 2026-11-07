<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import {useDocumentInsights} from '@/composables/useDocumentInsights'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
const insight=useDocumentInsights(),force=ref(false),custom=ref(false),from=ref(1),to=ref(15),start=ref(1)
const pdf=computed(()=>insight.preview.value?.items[0]?.format==='pdf')
watch(()=>insight.preview.value?.items.map(item=>item.id).join(','),()=>{force.value=false;custom.value=false;from.value=1;to.value=15;start.value=1})
async function confirm(){
  const current=insight.preview.value;if(!current)return
  const range=custom.value?(pdf.value?{fromPage:from.value,toPage:to.value}:{start:start.value-1}):undefined
  if(await insight.open(current.items.map(item=>item.id),range))await insight.confirm(force.value)
}
</script>
<template>
  <ProjectDialog v-if="insight.preview.value" title="精读所选资料" :busy="insight.busy.value" @close="insight.preview.value=null">
    <p>将所选资料的正文片段发送给 <strong>{{insight.preview.value.model || '尚未配置的模型'}}</strong>。</p>
    <small class="ws-muted">{{insight.preview.value.provider}}</small>
    <ul><li v-for="item in insight.preview.value.items" :key="item.id">{{item.name}} · {{item.format.toUpperCase()}} <span v-if="item.userEdited">（保留人工修订，生成新版本）</span><span v-if="!item.available">（来源暂不可用）</span></li></ul>
    <p>每份最多读取 {{insight.preview.value.maxChars.toLocaleString()}} 字符。超过 30 页的 PDF 读取前 15 页和后 10 页。实际覆盖范围和原文引文会保存在结果中。</p>
    <details v-if="insight.preview.value.items.length===1" class="insight-range"><summary>指定范围继续精读</summary><label><input v-model="custom" type="checkbox"/>本次使用指定范围</label><div v-if="custom"><template v-if="pdf"><label>从第 <input v-model.number="from" type="number" min="1" aria-label="精读起始页"/> 页</label><label>到第 <input v-model.number="to" type="number" :min="from" :max="from+79" aria-label="精读结束页"/> 页（最多 80 页）</label></template><label v-else>从第 <input v-model.number="start" type="number" min="1" aria-label="精读起始字符"/> 个字符继续</label><p>仍受上面的字符预算限制。本次结果单独存为新版本，可在版本记录切换。</p></div></details>
    <p>提炼会话会保留已发送的片段，可在归档助理历史中查看。生成不会修改分类、标签或已读状态。</p>
    <label class="insight-force"><input v-model="force" type="checkbox"/>来源未变化也重新生成</label>
    <p v-if="insight.error.value" class="ws-error" role="alert">{{insight.error.value}}</p>
    <template #footer><button class="pj-button" :disabled="insight.busy.value" @click="insight.preview.value=null">取消</button><button class="pj-button pj-primary" :disabled="insight.busy.value" @click="confirm">{{insight.preview.value.configured?'确认并开始精读':'加入待精读'}}</button></template>
  </ProjectDialog>
</template>
<style scoped>p,li{font-size:13px;line-height:1.9;overflow-wrap:anywhere}.insight-force{display:flex;align-items:center;gap:8px;font-size:13px;margin-top:18px}.insight-range{font-size:13px;line-height:2;margin:12px 0}.insight-range summary{cursor:pointer}.insight-range label{display:flex;gap:6px;align-items:center;margin:6px 0}.insight-range input[type=number]{width:90px}</style>
