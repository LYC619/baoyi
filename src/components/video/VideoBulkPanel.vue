<script setup lang="ts">
import { ref } from 'vue'
import { errorMessage, plain } from '@/utils'
const props = defineProps<{ ids: string[]; groups: string[] }>()
const emit = defineEmits<{ changed: []; remove: [] }>()
const group = ref(''), tags = ref(''), busy = ref(false), message = ref('')
const split = () => tags.value.split(/[、,，\n]/).map(t => t.trim()).filter(Boolean)
async function save(action: 'group' | 'add' | 'remove') {
  busy.value = true; message.value = ''
  try { const count = await window.baoyi.video.bulkUpdate(plain(props.ids), action === 'group' ? { collection: group.value } : action === 'add' ? { addTags: split() } : { removeTags: split() }); message.value = `已更新 ${count} 部作品`; emit('changed') }
  catch (e) { message.value = errorMessage(e) } finally { busy.value = false }
}
</script>
<template><section class="bulk-panel" aria-label="批量管理">
  <label>收藏分组<input v-model="group" class="input" list="bulk-group-options" placeholder="留空可清空分组" maxlength="80" /><datalist id="bulk-group-options"><option v-for="g in groups" :key="g" :value="g" /></datalist></label><button class="btn btn--subtle" :disabled="busy || !ids.length" @click="save('group')">设置分组</button>
  <label>作品标签<input v-model="tags" class="input" placeholder="用顿号或逗号分隔" /></label><button class="btn btn--subtle" :disabled="busy || !ids.length || !split().length" @click="save('add')">加标签</button><button class="btn btn--subtle" :disabled="busy || !ids.length || !split().length" @click="save('remove')">移除标签</button>
  <button class="btn btn--ghost" :disabled="busy || !ids.length" @click="emit('remove')">删除所选…</button><p v-if="message" role="status">{{ message }}</p>
</section></template>
<style scoped>.bulk-panel{display:flex;align-items:flex-end;flex-wrap:wrap;gap:10px;padding:14px 20px;border-bottom:1px solid var(--card-border)}label{display:grid;gap:6px;font-size:12px}p{width:100%;color:var(--text-muted)}</style>
