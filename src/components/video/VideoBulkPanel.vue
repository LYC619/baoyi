<script setup lang="ts">
import { ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useToast } from '@/composables/useToast'
import { errorMessage, plain } from '@/utils'
const props = defineProps<{ ids: string[]; groups: string[]; pending?: boolean }>()
const emit = defineEmits<{ changed: []; remove: []; busy: [value: boolean] }>()
const action = ref<'group' | 'add' | 'remove' | 'delete'>('add')
const group = ref(''), tags = ref(''), busy = ref(false), message = ref('')
const split = () => tags.value.split(/[、,，\n]/).map(t => t.trim()).filter(Boolean)
watch(busy, value => emit('busy', value), { flush: 'sync' })
const { toast } = useToast()
onBeforeRouteLeave(() => { if (busy.value) { toast('正在保存所选作品，请稍后再离开'); return false } return true })
async function save(action: 'group' | 'add' | 'remove') {
  if (props.pending || busy.value || !props.ids.length || (action !== 'group' && !split().length)) return
  busy.value = true; message.value = ''
  try { const count = await window.baoyi.video.bulkUpdate(plain(props.ids), action === 'group' ? { collection: group.value } : action === 'add' ? { addTags: split() } : { removeTags: split() }); message.value = `已更新 ${count} 部作品`; emit('changed') }
  catch (e) { message.value = errorMessage(e) } finally { busy.value = false }
}
function requestRemove() { if (!props.pending && !busy.value && props.ids.length) emit('remove') }
</script>
<template><section class="bulk-panel" :class="{'bulk-panel--empty':!ids.length && !message}" aria-label="批量管理">
  <form v-if="ids.length" @submit.prevent="action === 'delete' ? requestRemove() : save(action)">
    <fieldset :disabled="pending || busy">
      <label>操作<select v-model="action" aria-label="影视批量操作"><option value="group">设置分组</option><option value="add">加标签</option><option value="remove">移除标签</option><option value="delete">删除所选…</option></select></label>
      <label v-if="action === 'group'">收藏分组<input v-model="group" class="input" list="bulk-group-options" placeholder="留空可清空分组" maxlength="80" /><datalist id="bulk-group-options"><option v-for="g in groups" :key="g" :value="g" /></datalist></label>
      <label v-if="action === 'add' || action === 'remove'">作品标签<input v-model="tags" class="input" placeholder="用顿号或逗号分隔" /></label>
      <button class="btn btn--subtle" type="submit" :disabled="pending || busy || !ids.length || ((action === 'add' || action === 'remove') && !split().length)">{{busy ? '正在保存…' : action === 'group' ? '设置分组' : action === 'add' ? '加标签' : action === 'remove' ? '移除标签' : '删除所选…'}}</button>
    </fieldset>
  </form><p v-if="message" role="status">{{ message }}</p>
</section></template>
<style scoped>
.bulk-panel{padding:4px 20px 10px;border-bottom:1px solid var(--card-border)}.bulk-panel.bulk-panel--empty{padding:0;border:0}fieldset{border:0;padding:0;margin:0;display:flex;align-items:center;flex-wrap:wrap;gap:8px}label{display:flex;align-items:center;gap:6px;font-size:12px}input{width:180px;min-width:0}select{height:34px;background:var(--bg-card);color:var(--text-main);border:1px solid var(--divider);border-radius:5px;padding:0 8px}p{margin:6px 0 0;font-size:12px;color:var(--text-muted)}
</style>
