<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'
import type { ImageBulkPatch, ImageGroup, ImageType } from '@/types/image'
import { useImageStore } from '@/stores/image'
const props = defineProps<{ ids: string[]; groups: ImageGroup[]; type: ImageType; pending?: boolean }>()
const emit = defineEmits<{ applied: [count: number]; busy: [value: boolean] }>()
const action = ref('tags')
const group = ref('unchanged'), read = ref('unchanged'), tagMode = ref('add'), tagText = ref(''), busy = ref(false), error = ref('')
const collectionName=ref(''),collectionId=ref(''),organizeByCategory=ref(true),store=useImageStore(),notice=ref('')
watch(() => props.type, () => { action.value = 'tags' }, { flush: 'sync' })
watch(action, () => { group.value = read.value = 'unchanged'; tagText.value = ''; tagMode.value = 'add' })
async function manage(action:'collection'|'move'){
  if(props.pending||busy.value||!props.ids.length)return;const ids=[...props.ids];busy.value=true;emit('busy',true);error.value='';notice.value=''
  try{
    if(action==='collection'){
      const existing=store.collections.find(c=>c.id===collectionId.value)
      await window.baoyi.image.saveCollection(existing?.name||collectionName.value,[...(existing?.members||[]),...ids],existing?.id)
      notice.value='已保存合集，原文件与阅读进度保留'
    }else{const result=await window.baoyi.image.move(ids,props.type==='comic'&&organizeByCategory.value);if(!result)return;notice.value=`已移动 ${result.moved} 项`;error.value=result.warnings.join('\n');if(result.warnings.length){await store.refresh();return}}
    await store.refresh();emit('applied',ids.length)
  }catch(cause){error.value=(cause as Error).message}finally{busy.value=false;emit('busy',false)}
}
const modified = computed(() => (props.type === 'comic' && group.value !== 'unchanged') || (props.type === 'comic' && read.value !== 'unchanged') || !!tagText.value.trim() || tagMode.value === 'replace')
async function apply() {
  if (props.pending || busy.value || !props.ids.length || !modified.value) return
  const patch: ImageBulkPatch = {}
  if (props.type === 'comic' && group.value !== 'unchanged') patch.groupId = group.value || null
  if (props.type === 'comic' && read.value !== 'unchanged') patch.read = read.value === 'read'
  if (tagText.value.trim() || tagMode.value === 'replace') patch.tags = { mode: tagMode.value as 'add' | 'remove' | 'replace', values: tagText.value.split(/[,，]/).map(t => t.trim()).filter(Boolean) }
  if (patch.tags?.mode === 'replace' && !confirm(`替换所选 ${props.ids.length} 项的全部标签？`)) return
  busy.value = true; emit('busy', true); error.value = ''
  try { const count = await window.baoyi.image.bulkUpdate([...props.ids], patch); emit('applied', count) }
  catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false; emit('busy', false) }
}
</script>
<template>
  <form class="image-bulk-panel" :class="{empty:!ids.length && !notice && !error}" @submit.prevent="action==='move'||action==='collection'?manage(action):apply()">
    <fieldset v-if="ids.length" :disabled="pending || busy">
      <label>操作<select v-model="action" aria-label="图片批量操作"><option value="tags">修改标签</option><option v-if="type==='comic'" value="category">修改分类</option><option v-if="type==='comic'" value="read">阅读状态</option><option v-if="type==='comic'" value="collection">加入合集</option><option value="move">整理和移动</option></select></label>
      <label v-if="action==='category'">分类<select v-model="group" aria-label="批量分类"><option value="unchanged">选择分类</option><option value="">未分类</option><option v-for="g in groups.filter(g=>!g.hidden)" :key="g.id" :value="g.id">{{g.name}}</option></select></label>
      <label v-if="action==='read'">阅读状态<select v-model="read" aria-label="批量已读状态"><option value="unchanged">选择状态</option><option value="read">已读</option><option value="unread">未读</option></select></label>
      <template v-if="action==='tags'"><select v-model="tagMode" aria-label="批量标签操作"><option value="add">添加标签</option><option value="remove">移除标签</option><option value="replace">替换全部标签</option></select><input v-model="tagText" class="bulk-tags" aria-label="批量标签" placeholder="标签，标签" /></template>
      <template v-if="action==='collection'"><select v-model="collectionId" aria-label="目标合集"><option value="">创建新合集</option><option v-for="c in store.collections" :key="c.id" :value="c.id">{{c.name}}</option></select><input v-if="!collectionId" v-model="collectionName" aria-label="新合集名称" placeholder="合集名称" maxlength="200"/></template>
      <label v-if="action==='move' && type==='comic'"><input v-model="organizeByCategory" type="checkbox"/>按分类建立文件夹</label>
      <button class="im-button im-primary" type="submit" :disabled="pending || busy || !ids.length || (action==='collection' ? !collectionId&&!collectionName.trim() : action==='move' ? false : !modified)"><Check :size="17"/>{{busy?'正在处理…':action==='move'?'整理和移动':action==='collection'?'保存合集':'应用到所选'}}</button>
    </fieldset>
    <p v-if="notice" role="status">{{notice}}</p><p v-if="error" class="im-error" role="alert">{{error}}</p>
  </form>
</template>
<style scoped>
.image-bulk-panel{padding:0 0 10px;border-bottom:1px solid var(--divider);margin-bottom:12px}.image-bulk-panel.empty{padding:0;border:0;margin:0}.image-bulk-panel fieldset{border:0;padding:0;margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}.image-bulk-panel label{display:flex;align-items:center;gap:6px;color:var(--text-sub);font-size:12px}.image-bulk-panel select,.image-bulk-panel input{min-width:0;max-width:190px;height:34px;padding:5px 8px}.image-bulk-panel input[type=checkbox]{width:16px;height:16px}.image-bulk-panel .bulk-tags{flex:1;min-width:100px}.image-bulk-panel p{font-size:12px;margin:8px 0 0}.image-bulk-panel button{white-space:nowrap}
</style>
