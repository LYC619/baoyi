<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { confirmDialog } from '@/composables/useDialog'
import { errorMessage } from '@/utils'
import { computed, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'
import type { ImageBulkPatch, ImageGroup, ImageType } from '@/types/image'
import { useImageStore } from '@/stores/image'
const props = defineProps<{ ids: string[]; groups: ImageGroup[]; type: ImageType; pending?: boolean }>()
const emit = defineEmits<{ applied: [count: number]; busy: [value: boolean] }>()
const action = ref('tags')
const group = ref('unchanged'), read = ref('unchanged'), tagMode = ref('add'), tagText = ref(''), busy = ref(false), error = ref('')
const collectionName=ref(''),collectionId=ref(''),organizeByCategory=ref(true),chooseTarget=ref(false),store=useImageStore(),notice=ref('')
watch(() => props.type, () => { action.value = 'tags' }, { flush: 'sync' })
watch(action, () => { group.value = read.value = 'unchanged'; tagText.value = ''; tagMode.value = 'add' })
async function manage(action:'collection'|'move'){
  if(props.pending||busy.value||!props.ids.length)return;const ids=[...props.ids];busy.value=true;emit('busy',true);error.value='';notice.value=''
  try{
    if(action==='collection'){
      const existing=store.collections.find(c=>c.id===collectionId.value)
      await window.baoyi.image.saveCollection(existing?.name||collectionName.value,[...(existing?.members||[]),...ids],existing?.id)
      notice.value=tr("已保存合集，原文件与阅读进度保留")
    }else{const result=await window.baoyi.image.move(ids,organizeByCategory.value,chooseTarget.value);if(!result)return;notice.value=tr("已移动 {p0} 项", {p0: (result.moved)});error.value=result.warnings.join('\n');if(result.warnings.length){await store.refresh();return}}
    await store.refresh();emit('applied',ids.length)
  }catch(cause){error.value=errorMessage(cause)}finally{busy.value=false;emit('busy',false)}
}
const modified = computed(() => (group.value !== 'unchanged') || (props.type === 'comic' && read.value !== 'unchanged') || !!tagText.value.trim() || tagMode.value === 'replace')
async function apply() {
  if (props.pending || busy.value || !props.ids.length || !modified.value) return
  const patch: ImageBulkPatch = {}
  if (group.value !== 'unchanged') patch.groupId = group.value || null
  if (props.type === 'comic' && read.value !== 'unchanged') patch.read = read.value === 'read'
  if (tagText.value.trim() || tagMode.value === 'replace') patch.tags = { mode: tagMode.value as 'add' | 'remove' | 'replace', values: tagText.value.split(/[,，]/).map(t => t.trim()).filter(Boolean) }
  if (patch.tags?.mode === 'replace' && !(await confirmDialog({ title: tr('替换所选 {p0} 项的全部标签？', {p0: props.ids.length}), message: tr("原有标签将被本次输入的标签覆盖。"), confirmText: tr('确认替换'), tone: 'danger' }))) return
  busy.value = true; emit('busy', true); error.value = ''
  try { const count = await window.baoyi.image.bulkUpdate([...props.ids], patch); emit('applied', count) }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false; emit('busy', false) }
}
</script>
<template>
  <form class="image-bulk-panel" :class="{empty:!ids.length && !notice && !error}" @submit.prevent="action==='move'||action==='collection'?manage(action):apply()">
    <fieldset v-if="ids.length" :disabled="pending || busy">
      <label>{{ $t("操作") }}<select v-model="action" :aria-label="$t('图片批量操作')"><option value="tags">{{ $t("修改标签") }}</option><option value="category">{{ $t("修改分类") }}</option><option v-if="type==='comic'" value="read">{{ $t("阅读状态") }}</option><option v-if="type==='comic'" value="collection">{{ $t("加入合集") }}</option><option value="move">{{ $t("整理和移动") }}</option></select></label>
      <label v-if="action==='category'">{{ $t("分类") }}<select v-model="group" :aria-label="$t('批量分类')"><option value="unchanged">{{ $t("选择分类") }}</option><option value="">{{ $t("未分类") }}</option><option v-for="g in groups.filter(g=>!g.hidden)" :key="g.id" :value="g.id">{{g.name}}</option></select></label>
      <label v-if="action==='read'">{{ $t("阅读状态") }}<select v-model="read" :aria-label="$t('批量已读状态')"><option value="unchanged">{{ $t("选择状态") }}</option><option value="read">{{ $t("已读") }}</option><option value="unread">{{ $t("未读") }}</option></select></label>
      <template v-if="action==='tags'"><select v-model="tagMode" :aria-label="$t('批量标签操作')"><option value="add">{{ $t("添加标签") }}</option><option value="remove">{{ $t("移除标签") }}</option><option value="replace">{{ $t("替换全部标签") }}</option></select><input v-model="tagText" class="bulk-tags" :aria-label="$t('批量标签')" :placeholder="$t('标签，标签')" /></template>
      <template v-if="action==='collection'"><select v-model="collectionId" :aria-label="$t('目标合集')"><option value="">{{ $t("创建新合集") }}</option><option v-for="c in store.collections" :key="c.id" :value="c.id">{{c.name}}</option></select><input v-if="!collectionId" v-model="collectionName" :aria-label="$t('新合集名称')" :placeholder="$t('合集名称')" maxlength="200"/></template>
      <template v-if="action==='move'"><label><input v-model="organizeByCategory" type="checkbox"/>{{ $t("按分类存放（沿用已记住的目录）") }}</label><label v-if="organizeByCategory"><input v-model="chooseTarget" type="checkbox"/>{{ $t("重新选择目标根目录") }}</label></template>
      <button class="im-button im-primary" type="submit" :disabled="pending || busy || !ids.length || (action==='collection' ? !collectionId&&!collectionName.trim() : action==='move' ? false : !modified)"><Check :size="17"/>{{busy?$t('正在处理…'):action==='move'?$t('整理和移动'):action==='collection'?$t('保存合集'):$t('应用到所选')}}</button>
    </fieldset>
    <p v-if="notice" role="status">{{notice}}</p><p v-if="error" class="im-error" role="alert">{{$systemMessage(error)}}</p>
  </form>
</template>
<style scoped>
.image-bulk-panel{padding:0 0 10px;border-bottom:1px solid var(--divider);margin-bottom:12px}.image-bulk-panel.empty{padding:0;border:0;margin:0}.image-bulk-panel fieldset{border:0;padding:0;margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}.image-bulk-panel label{display:flex;align-items:center;gap:6px;color:var(--text-sub);font-size:12px}.image-bulk-panel select,.image-bulk-panel input{min-width:0;max-width:190px;height:34px;padding:5px 8px}.image-bulk-panel input[type=checkbox]{width:16px;height:16px}.image-bulk-panel .bulk-tags{flex:1;min-width:100px}.image-bulk-panel p{font-size:12px;margin:8px 0 0}.image-bulk-panel button{white-space:nowrap}
</style>
