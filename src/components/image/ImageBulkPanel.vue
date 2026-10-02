<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check } from 'lucide-vue-next'
import type { ImageBulkPatch, ImageGroup, ImageType } from '@/types/image'
import { useImageStore } from '@/stores/image'
const props = defineProps<{ ids: string[]; groups: ImageGroup[]; type: ImageType }>()
const emit = defineEmits<{ applied: [count: number]; busy: [value: boolean] }>()
const group = ref('unchanged'), read = ref('unchanged'), tagMode = ref('add'), tagText = ref(''), busy = ref(false), error = ref('')
const collectionName=ref(''),collectionId=ref(''),organizeByCategory=ref(true),store=useImageStore(),notice=ref('')
async function manage(action:'collection'|'move'){
  busy.value=true;emit('busy',true);error.value='';notice.value=''
  try{
    if(action==='collection'){
      const existing=store.collections.find(c=>c.id===collectionId.value)
      await window.baoyi.image.saveCollection(existing?.name||collectionName.value,[...(existing?.members||[]),...props.ids],existing?.id)
      notice.value='已保存合集，原文件与阅读进度保留'
    }else{const result=await window.baoyi.image.move([...props.ids],organizeByCategory.value);if(!result)return;notice.value=`已移动 ${result.moved} 项`;error.value=result.warnings.join('\n')}
    await store.refresh();emit('applied',props.ids.length)
  }catch(cause){error.value=(cause as Error).message}finally{busy.value=false;emit('busy',false)}
}
const modified = computed(() => (props.type === 'comic' && group.value !== 'unchanged') || read.value !== 'unchanged' || !!tagText.value.trim() || tagMode.value === 'replace')
async function apply() {
  if (busy.value || !props.ids.length || !modified.value) return
  const patch: ImageBulkPatch = {}
  if (props.type === 'comic' && group.value !== 'unchanged') patch.groupId = group.value || null
  if (read.value !== 'unchanged') patch.read = read.value === 'read'
  if (tagText.value.trim() || tagMode.value === 'replace') patch.tags = { mode: tagMode.value as 'add' | 'remove' | 'replace', values: tagText.value.split(/[,，]/).map(t => t.trim()).filter(Boolean) }
  if (patch.tags?.mode === 'replace' && !confirm(`替换所选 ${props.ids.length} 项的全部标签？`)) return
  busy.value = true; emit('busy', true); error.value = ''
  try { const count = await window.baoyi.image.bulkUpdate([...props.ids], patch); emit('applied', count) }
  catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false; emit('busy', false) }
}
</script>
<template>
  <form class="image-bulk-panel" @submit.prevent="apply">
    <fieldset :disabled="busy">
      <label v-if="type==='comic'">分类<select v-model="group" aria-label="批量分类"><option value="unchanged">不修改分类</option><option value="">未分类</option><option v-for="g in groups.filter(g=>!g.hidden)" :key="g.id" :value="g.id">{{ g.name }}</option></select></label>
      <label>阅读状态<select v-model="read" aria-label="批量已读状态"><option value="unchanged">不修改已读</option><option value="read">已读</option><option value="unread">未读</option></select></label>
      <label>标签操作<select v-model="tagMode" aria-label="批量标签操作"><option value="add">添加标签</option><option value="remove">移除标签</option><option value="replace">替换全部标签</option></select></label>
      <label class="bulk-tags">标签<input v-model="tagText" aria-label="批量标签" placeholder="标签，标签" /></label>
      <button class="im-button im-primary" type="submit" :disabled="!ids.length||!modified"><Check :size="17" />{{ busy?'正在应用':'应用到所选' }}</button>
    </fieldset>
    <div class="bulk-management"><template v-if="type==='comic'"><select v-model="collectionId" aria-label="目标合集"><option value="">创建新合集</option><option v-for="c in store.collections" :key="c.id" :value="c.id">{{c.name}}</option></select><input v-if="!collectionId" v-model="collectionName" aria-label="新合集名称" placeholder="合集名称" maxlength="200"/><button type="button" class="im-button" :disabled="busy||!ids.length||(!collectionId&&!collectionName.trim())" @click="manage('collection')">{{collectionId?'加入合集':'合并为合集'}}</button></template><label><input v-model="organizeByCategory" type="checkbox"/>按分类建立文件夹</label><button type="button" class="im-button" :disabled="busy||!ids.length" @click="manage('move')">整理和移动</button></div><p v-if="notice" role="status">{{notice}}</p>
    <p v-if="error" class="im-error" role="alert">{{ error }}</p>
  </form>
</template>
<style scoped>
.bulk-management{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}.bulk-management>input{max-width:200px}.bulk-management label{display:flex;flex-direction:row;align-items:center;flex:none}.bulk-management label input{width:auto}
.image-bulk-panel{padding:12px 0 16px;border-bottom:1px solid var(--divider);margin-bottom:18px}.image-bulk-panel fieldset{border:0;padding:0;margin:0;display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;min-width:0}.image-bulk-panel label{display:flex;flex-direction:column;gap:7px;color:var(--text-sub);font-size:12px;min-width:115px;flex:1}.image-bulk-panel select,.image-bulk-panel input{width:100%}.image-bulk-panel .bulk-tags{flex:2;min-width:150px}.image-bulk-panel .im-error{margin-bottom:0}.image-bulk-panel button{min-width:120px}
</style>
