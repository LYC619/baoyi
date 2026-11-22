<script setup lang="ts">
import { confirmDialog } from '@/composables/useDialog'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { FolderOpen, Leaf, Link2, Loader2 } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'
import SoftwareTypeSelect from './SoftwareTypeSelect.vue'
import type { OrganizedEntry, RelocatePreview, SoftwareItem } from '@/types'

const props = defineProps<{ entries: OrganizedEntry[]; categories: string[]; busy: boolean }>()
const emit = defineEmits<{ refresh: [id: string]; busy: [value: boolean] }>()
const router = useRouter()
const { success, error } = useToast()
const keyword = ref(''), editing = ref(''), category = ref(''), folder = ref('')
const preview = ref<RelocatePreview | null>(null), working = ref(false)
type SoftwareKind = 'portable' | 'linked' | 'installed' | 'unknown'
const kind = ref<'all' | SoftwareKind>('all')
const kinds: Array<{ value: 'all' | SoftwareKind; label: string }> = [
  { value: 'all', label: '全部' }, { value: 'portable', label: '绿色软件' },
  { value: 'linked', label: '链接软件' }, { value: 'installed', label: '安装版' }, { value: 'unknown', label: '类型待确认' }
]
function kindOf(e: OrganizedEntry): SoftwareKind { return e.is_link ? 'linked' : e.is_portable === true ? 'portable' : e.is_portable === false ? 'installed' : 'unknown' }
const counts = computed(() => Object.fromEntries(kinds.map(k => [k.value, props.entries.filter(e => k.value === 'all' || kindOf(e) === k.value).length])))
const visible = computed(() => props.entries.filter(e => (kind.value === 'all' || kindOf(e) === kind.value) && `${e.name} ${e.folder_category} ${e.dir}`.toLowerCase().includes(keyword.value.trim().toLowerCase())))
watch([category, folder], () => { preview.value = null })
watch(working, value => emit('busy', value), { flush: 'sync' })

function edit(e: OrganizedEntry) {
  editing.value = e.software_id; category.value = e.folder_category || e.category; folder.value = e.folder; preview.value = null
}
async function previewMove(e: OrganizedEntry) {
  if (working.value || props.busy) return
  working.value = true
  try { preview.value = await window.baoyi.organize.previewRelocate(e.software_id, category.value, folder.value) }
  catch (cause) { error(errorMessage(cause)) }
  finally { working.value = false }
}
async function apply(e: OrganizedEntry, action: 'relocate' | 'materialize' | 'unlink') {
  if (working.value || props.busy) return
  if (action === 'materialize' && !(await confirmDialog({ title: `将「${e.name}」转为实体目录？`, message: `真实文件将从 ${e.link_target} 移至 ${e.dir}。原位置不再保留文件，依赖原路径的外部快捷方式可能失效。`, confirmText: '转为实体' }))) return
  if (action === 'unlink' && !(await confirmDialog({ title: `移除「${e.name}」的目录链接？`, message: `仅删除整理目录中的链接入口（${e.dir}），真实文件保留在原位置，库记录将指回原路径。`, confirmText: '移除链接' }))) return
  const p = preview.value
  if (action === 'relocate' && (!p?.ok || !(await confirmDialog({ title: `确认重新归置「${e.name}」？`, message: `从：${p.from}\n到：${p.to}\n${p.is_link ? '仅改变链接位置，真实文件不动。' : '将移动整个软件文件夹。'}${p.warning ? '\n' + p.warning : ''}`, confirmText: '确认归置' })))) return
  working.value = true
  try {
    const result = action === 'relocate'
      ? await window.baoyi.organize.relocate(e.software_id, p!.category, p!.folder, p!.from)
      : await window.baoyi.organize[action](e.software_id)
    if (!result.ok) { error(result.message); return }
    success(result.message); editing.value = ''; preview.value = null
  } catch (cause) { error(errorMessage(cause)) }
  finally { working.value = false; emit('refresh', e.software_id) }
}
async function reveal(id: string) {
  try { await window.baoyi.software.revealInFolder(id) } catch (cause) { error(errorMessage(cause)) }
}
function typeUpdated(item: SoftwareItem): void {
  if (editing.value === item.id) preview.value = null
  emit('refresh', item.id)
}
</script>

<template>
  <section class="organized-list" aria-label="已整理的软件">
    <div class="organized-tools">
      <p>已整理的软件会一直保留在这里，包括归档条目。分类以所在文件夹为准。</p>
      <input v-model="keyword" class="input" aria-label="搜索已整理软件" placeholder="搜索软件、分类或路径" />
    </div>
    <div class="kind-filters" role="group" aria-label="软件类型筛选">
      <button v-for="k in kinds" :key="k.value" class="btn btn--ghost" :class="{ selected: kind === k.value }" :aria-pressed="kind === k.value" :disabled="busy || working" @click="kind = k.value">{{ k.label }} <span>{{ counts[k.value] }}</span></button>
    </div>
    <p v-if="!entries.length" class="empty">整理目录下还没有软件记录。可先整理软件，或把软件放进“分类 / 软件文件夹”后同步。</p>
    <p v-else-if="!visible.length" class="empty">没有匹配的软件。</p>
    <datalist id="organize-category-options"><option v-for="name in categories" :key="name" :value="name" /></datalist>
    <article v-for="e in visible" :key="e.software_id" class="organized-item panel" :class="{ 'organized-item--missing': !e.present || !e.target_ok || !e.exe_present }">
      <div class="item-heading">
        <Link2 v-if="e.is_link" :size="15" />
        <Leaf v-else-if="e.is_portable === true" :size="15" class="portable-icon" />
        <button class="item-title" :disabled="busy || working" @click="router.push({ name: 'detail', params: { id: e.software_id } })">{{ e.name }}</button>
        <span class="badge">{{ e.folder_category || '未放入分类文件夹' }}</span>
        <span class="badge" :class="'badge--' + kindOf(e)">{{ kinds.find(k => k.value === kindOf(e))?.label }}</span>
        <span v-if="e.is_archived" class="badge">已归档</span>
      </div>
      <p class="item-path mono">{{ e.dir }}</p>
      <p v-if="e.is_link" class="item-path">实际位置：<span class="mono">{{ e.link_target || '无法读取' }}</span></p>
      <p v-if="!e.present || !e.target_ok" class="warning" role="status">{{ !e.present ? '目录已不存在' : '链接目标已失效' }}。请修复路径，或进入详情移除记录。</p>
      <p v-else-if="!e.exe_present" class="warning" role="status">主程序已不存在，可能已卸载或更换安装位置。记录仍保留；重装到原路径后同步即可恢复，路径改变时请重新导入并核对旧记录。</p>
      <p v-if="e.category_mismatch" class="warning">库内分类为“{{ e.category }}”，同步后将跟随文件夹。</p>
      <div class="item-actions">
        <button class="btn btn--ghost" :disabled="busy || working || !e.present || !e.target_ok" :title="e.is_link ? '更改分类或文件夹位置，只移动链接入口，软件本体不动；操作后仍属于已整理。' : '更改分类或文件夹位置，会移动整个软件文件夹；操作后仍属于已整理。'" @click="edit(e)">更改整理位置</button>
        <button v-if="e.is_link" class="btn btn--ghost" :disabled="busy || working || !e.present || !e.target_ok" title="把软件本体从原位置搬到当前链接位置，操作后仍属于已整理。" @click="apply(e, 'materialize')">转为实体</button>
        <button v-if="e.is_link" class="btn btn--ghost" :disabled="busy || working || !e.present" title="只删除链接，记录指回原位置；原位置在整理目录外时回到待整理，真实文件保留。" @click="apply(e, 'unlink')">移除链接</button>
        <button class="btn btn--subtle" :disabled="busy || working || !e.present || !e.target_ok" @click="reveal(e.software_id)"><FolderOpen :size="14" />所在文件夹</button>
        <SoftwareTypeSelect :id="e.software_id" :model-value="e.is_portable" :disabled="busy || working" @busy="working = $event" @updated="typeUpdated" />
      </div>
      <form v-if="editing === e.software_id" class="relocate-form" @submit.prevent="previewMove(e)">
        <fieldset :disabled="busy || working">
          <label>目标分类<input v-model="category" class="input" list="organize-category-options" aria-label="重新归置目标分类" required maxlength="64" /></label>
          <label>文件夹名<input v-model="folder" class="input" aria-label="重新归置文件夹名" required maxlength="64" /></label>
          <button class="btn btn--ghost" type="submit"><Loader2 v-if="working" :size="14" class="spin" />预览位置</button>
          <button class="btn btn--subtle" type="button" @click="editing = ''">取消</button>
        </fieldset>
        <div v-if="preview" class="move-preview" role="status">
          <p>当前位置：<span class="mono">{{ preview.from }}</span></p>
          <p>目标位置：<span class="mono">{{ preview.to }}</span></p>
          <p v-if="!preview.ok" class="warning">{{ preview.message }}</p>
          <template v-else><p>{{ preview.is_link ? '只移动链接入口，真实文件保留原位。' : '将移动整个文件夹，并更新库内路径和分类。' }}</p><p v-if="preview.warning" class="warning">{{ preview.warning }}</p>
          <button class="btn btn--primary" type="button" :disabled="busy || working" @click="apply(e, 'relocate')">确认更改位置</button></template>
        </div>
      </form>
    </article>
  </section>
</template>

<style scoped>
.kind-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px}.kind-filters .selected{color:var(--accent);border-color:var(--accent);background:var(--hover-surface)}.kind-filters span{font-variant-numeric:tabular-nums;opacity:.7}.portable-icon,.badge--portable{color:var(--success)}.badge--linked{color:var(--accent)}
.organized-list{display:flex;flex-direction:column;gap:10px}.organized-tools{display:flex;align-items:center;gap:20px;justify-content:space-between;margin-bottom:4px}.organized-tools p,.empty{font-size:var(--fs-tag);color:var(--text-sub);line-height:1.8}.organized-tools input{width:250px;max-width:100%}.empty{padding:35px 10px;text-align:center}.organized-item{padding:14px 16px}.organized-item--missing{border-color:var(--warning)}.item-heading{display:flex;align-items:center;gap:9px;flex-wrap:wrap;color:var(--text-main)}.item-title{font-size:var(--fs-body);font-weight:500;text-align:left;overflow-wrap:anywhere}.item-title:hover{text-decoration:underline}.badge{font-size:11px;border:1px solid var(--divider);border-radius:4px;padding:2px 6px;color:var(--text-sub)}.item-path{margin:6px 0;font-size:11px;color:var(--text-faint);overflow-wrap:anywhere;line-height:1.6}.item-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.warning{font-size:12px;color:var(--warning);line-height:1.7;margin-top:6px}.relocate-form{border-top:1px solid var(--divider);margin-top:12px;padding-top:12px}fieldset{border:0;padding:0;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--text-sub);flex:1;min-width:140px}.move-preview{margin-top:12px;padding:12px;background:var(--bg-main);font-size:12px;line-height:1.8;overflow-wrap:anywhere}.move-preview button{margin-top:8px}button:disabled{opacity:.5;cursor:not-allowed}@media(max-width:900px){.organized-tools{align-items:stretch;flex-direction:column;gap:8px}.organized-tools input{width:100%}}
</style>
