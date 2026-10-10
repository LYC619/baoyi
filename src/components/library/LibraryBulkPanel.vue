<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useBulkOperation, type BulkItem } from '@/composables/useBulkOperation'
import { useToast } from '@/composables/useToast'

const props = defineProps<{ kind: 'software' | 'game' | 'project'; items: BulkItem[]; ids: string[]; categories: string[]; pending?: boolean }>()
const emit = defineEmits<{ all: []; clear: []; close: []; refresh: []; busy: [value: boolean]; completed: [failedIds: string[]] }>()
const operation = useBulkOperation()
const { busy, processed, total, succeeded, failures } = operation
const action = ref('category'), value = ref(''), confirming = ref(false), lastLabel = ref('')
const { toast } = useToast()
const actions = computed(() => [
  { value: 'category', label: '修改分类' }, { value: 'tags', label: '添加标签' },
  ...(props.kind === 'project' ? [{ value: 'group', label: '修改分组' }, { value: 'state', label: '修改状态' }, { value: 'pin', label: '置顶' }, { value: 'unpin', label: '取消置顶' }] : [{ value: 'archive', label: '归档' }, { value: 'restore', label: '恢复到库' }]),
  { value: 'remove', label: '移出资料库' }
])
const label = computed(() => actions.value.find(item => item.value === action.value)?.label || '')
const needsValue = computed(() => ['category', 'tags', 'state'].includes(action.value))
const canRun = computed(() => props.ids.length > 0 && (!needsValue.value || !!value.value.trim()) && (action.value !== 'tags' || value.value.split(/[,，]/).some(tag => tag.trim())))
watch(action, () => { value.value = ''; confirming.value = false })
watch(() => [props.pending, props.ids.join('\0')], () => { confirming.value = false })
watch(busy, value => emit('busy', value), { flush: 'sync' })
onBeforeRouteLeave(() => { if (busy.value) { toast('正在保存所选项目，请稍后再离开'); return false } return true })

async function apply() {
  if (busy.value || props.pending || !canRun.value) return
  if (action.value === 'remove' && !confirming.value) { confirming.value = true; return }
  confirming.value = false
  const chosen = new Set(props.ids), batch = props.items.filter(item => chosen.has(item.id))
  const mode = action.value, text = value.value.trim()
  lastLabel.value = label.value
  await operation.run(batch, async item => {
    // Read current data before appending tags so a stale card never erases newer tags.
    const api = window.baoyi[props.kind]
    if (mode === 'remove') { await api.remove(item.id); return }
    const current = await api.get(item.id)
    if (!current) throw new Error('条目已不存在，请刷新资料库')
    const patch: Record<string, unknown> = {}
    if (mode === 'category') patch.category = text
    if (mode === 'tags') patch.tags = [...new Set([...current.tags, ...text.split(/[,，]/).map(tag => tag.trim()).filter(Boolean)])]
    if (mode === 'archive' || mode === 'restore') patch.is_archived = mode === 'archive'
    if (mode === 'group') patch.group = text
    if (mode === 'state') patch.state = text
    if (mode === 'pin' || mode === 'unpin') patch.pinned = mode === 'pin'
    const updated = await api.update(item.id, patch)
    if (!updated) throw new Error('条目未保存，请刷新后重试')
  })
  emit('completed', failures.value.map(item => item.id))
}
</script>

<template>
  <section class="library-bulk" aria-label="批量管理" :aria-busy="busy">
    <header>
      <strong aria-live="polite" title="仅包含当前搜索与筛选结果；勾选卡片开始，Esc 可退出">已选 {{ ids.length }} / {{ items.length }} 项</strong>
      <button class="btn btn--subtle" :disabled="busy || pending || !items.length" @click="emit('all')">全选当前结果</button>
      <button v-if="ids.length" class="btn btn--subtle" :disabled="busy || !ids.length" @click="emit('clear')">清空选择</button>
      <button class="btn btn--subtle bulk-close" :disabled="busy" @click="emit('close')">退出批量管理</button>
    </header>
    <form v-if="ids.length || busy" @submit.prevent="apply">
      <fieldset :disabled="busy || pending">
        <label>操作<select v-model="action" aria-label="批量操作"><option v-for="option in actions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
        <label v-if="action === 'category'">目标分类<select v-model="value" aria-label="批量分类"><option value="" disabled>选择分类</option><option v-for="category in categories" :key="category" :value="category">{{ category }}</option></select></label>
        <label v-if="action === 'tags'" class="bulk-value">新增标签<input v-model="value" aria-label="批量标签" placeholder="多个标签用逗号分隔" maxlength="500" /></label>
        <label v-if="action === 'group'" class="bulk-value">分组名称<input v-model="value" aria-label="批量分组" placeholder="留空可取消分组" maxlength="100" /></label>
        <label v-if="action === 'state'">目标状态<select v-model="value" aria-label="批量状态"><option value="" disabled>选择状态</option><option value="active">使用中</option><option value="maintaining">维护中</option><option value="paused">已暂停</option><option value="archived">已归档</option></select></label>
        <button v-if="!confirming" class="btn" :class="action === 'remove' ? 'bulk-danger' : 'btn--primary'" type="submit" :disabled="!canRun">{{ busy ? `处理中 ${processed} / ${total}` : `${label}所选 ${ids.length} 项` }}</button>
      </fieldset>
      <div v-if="confirming" class="bulk-confirm" role="alert">
        <span>将 {{ ids.length }} 项移出资料库。原文件保留，库内资料需要重新导入。确认继续？</span>
        <button class="btn bulk-danger" type="submit" :disabled="busy || pending">确认移出 {{ ids.length }} 项</button>
        <button class="btn btn--subtle" type="button" @click="confirming = false">取消</button>
      </div>
    </form>
    <p v-if="pending" role="status">当前筛选结果尚未就绪，更新后可继续操作。<button class="btn btn--subtle" :disabled="busy" @click="emit('refresh')">刷新结果</button></p>

    <p v-if="total" role="status">{{ busy ? `正在${lastLabel}：${processed} / ${total}` : `${lastLabel}结束：成功 ${succeeded} 项${failures.length ? `，失败 ${failures.length} 项；失败项已保留选择，可重试` : ''}` }}</p>
    <details v-if="failures.length" open class="bulk-errors"><summary>未完成的项目</summary><ul><li v-for="item in failures" :key="item.id"><strong>{{ item.name }}</strong>：{{ item.message }}</li></ul></details>
  </section>
</template>

<style scoped>
.library-bulk{flex:none;max-height:42vh;overflow:auto;margin:0 20px 12px;padding:8px 12px;background:var(--bg-card);border:1px solid var(--divider);border-radius:var(--radius-card);color:var(--text-main)}
header,fieldset,.bulk-confirm{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px}header{margin-bottom:0}form{margin-top:8px}header strong{font-size:13px;font-weight:500}.bulk-close{margin-left:auto}fieldset{align-items:center;border:0;padding:0;min-width:0;margin:0}
label{display:flex;flex-direction:row;align-items:center;gap:6px;font-size:12px;color:var(--text-sub);min-width:0}.bulk-value{flex:1;min-width:150px;max-width:330px}input,select{max-width:100%;height:34px;border:1px solid var(--divider);border-radius:var(--radius-input);padding:0 9px;background:var(--bg-main);color:var(--text-main)}
label select,label input{min-width:0}p{font-size:12px;line-height:1.6;margin:10px 0 0}.bulk-hint{color:var(--text-sub)}.bulk-danger{color:var(--danger);border:1px solid var(--danger)}.bulk-confirm{margin-top:12px;font-size:13px;line-height:1.6}.bulk-confirm span{flex-basis:100%}.bulk-errors{color:var(--danger);font-size:12px;line-height:1.7;margin-top:10px}.bulk-errors ul{padding-left:20px;overflow-wrap:anywhere}button:disabled{cursor:not-allowed;opacity:.5}
@media(max-width:1100px){.library-bulk{margin-left:12px;margin-right:12px;padding:10px}header{gap:6px}header .btn{padding:0 8px}}
</style>
