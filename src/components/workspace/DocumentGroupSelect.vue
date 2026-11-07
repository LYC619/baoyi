<script setup lang="ts">
import { ref, computed } from 'vue'
import { workspace } from '@/utils/workspace-api'
import type { DocumentCustomGroup, DocumentSubmodule } from '@/types/workspace'
const props = defineProps<{ modelValue: string; submodule: DocumentSubmodule; categoryId?: string; groups: DocumentCustomGroup[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value:string]; created: [] }>()
const creating = ref(false), name = ref(''), busy = ref(false), error = ref('')
const groups = computed(() => props.groups.filter(g => props.categoryId ? (g.categoryId === props.categoryId) : (g.submodule === props.submodule)))
function change(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (value === '__new__') { creating.value = true; (event.target as HTMLSelectElement).value = props.modelValue }
  else emit('update:modelValue', value)
}
async function create() {
  if (!name.value.trim() || busy.value) return
  busy.value = true; error.value = ''
  try {
    const group = await workspace.documents.saveCustomGroup({submodule:props.submodule,categoryId:props.categoryId,name:name.value.trim()})
    emit('created'); emit('update:modelValue',group.id); creating.value = false; name.value = ''
  } catch(e) { error.value = (e as Error).message } finally { busy.value = false }
}
</script>
<template>
  <div class="document-group-field">
    <select :value="modelValue" aria-label="设置自定义分组" :disabled="disabled || busy" @change="change">
      <option value="">无分组</option>
      <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
      <option value="__new__">＋ 新建分组…</option>
    </select>
    <form v-if="creating" class="new-group" @submit.prevent="create">
      <input v-model="name" aria-label="新分组名称" placeholder="新分组名称" maxlength="120" :disabled="busy" />
      <button class="ws-button" :disabled="busy || !name.trim()">新建</button>
      <button type="button" class="ws-icon" aria-label="取消新建分组" :disabled="busy" @click="creating = false">×</button>
    </form>
    <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
select{width:100%}.new-group{display:flex;gap:5px;margin-top:6px}.new-group input{min-width:0;flex:1}
</style>
