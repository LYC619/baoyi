<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { confirmDialog } from '@/composables/useDialog'
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useBulkOperation, type BulkItem } from '@/composables/useBulkOperation'
import { useToast } from '@/composables/useToast'
import {
  previewSoftwareCategoryChanges,
  categoryMoveConfirmation,
  type SoftwareCategoryMove,
} from '@/utils/softwareCategory'
import { errorMessage } from '@/utils'

const props = defineProps<{
  kind: 'software' | 'game' | 'project'
  items: BulkItem[]
  ids: string[]
  categories: string[]
  pending?: boolean
}>()
const emit = defineEmits<{
  all: []
  clear: []
  close: []
  refresh: []
  busy: [value: boolean]
  completed: [failedIds: string[]]
}>()

const operation = useBulkOperation()
const { processed, total, succeeded, failures } = operation
const preparing = ref(false)
const busy = computed(() => preparing.value || operation.busy.value)
const action = ref('category')
const value = ref('')
const confirming = ref(false)
const lastLabel = ref('')
const { toast } = useToast()

const actions = computed(() => [
  { value: 'category', label: tr('修改分类') },
  { value: 'tags', label: tr('添加标签') },
  { value: 'remove-tags', label: tr('移除标签') },
  ...(props.kind === 'game' ? [{ value: 'play_status', label: tr('修改游玩状态') }] : []),
  ...(props.kind === 'project'
    ? [
        { value: 'group', label: tr('修改分组') },
        { value: 'state', label: tr('修改状态') },
        { value: 'pin', label: tr('置顶') },
        { value: 'unpin', label: tr('取消置顶') },
      ]
    : [
        { value: 'archive', label: tr('归档') },
        { value: 'restore', label: tr('恢复到库') },
      ]),
  { value: 'remove', label: tr('移出资料库') },
])

const label = computed(() => actions.value.find((item) => item.value === action.value)?.label || '')
const needsValue = computed(() => ['category', 'tags', 'remove-tags', 'state', 'play_status'].includes(action.value))
const canRun = computed(
  () =>
    props.ids.length > 0 &&
    (!needsValue.value || !!value.value.trim()) &&
    (!['tags', 'remove-tags'].includes(action.value) ||
      value.value.split(/[,，、]/).some((tag) => tag.trim()))
)

watch(action, () => {
  value.value = ''
  confirming.value = false
})
watch(
  () => [props.pending, props.ids.join('\0')],
  () => {
    confirming.value = false
  }
)
watch(busy, (v) => emit('busy', v), { flush: 'sync' })
onBeforeRouteLeave(() => {
  if (busy.value) {
    toast(tr("正在保存所选项目，请稍后再离开"))
    return false
  }
  return true
})

async function apply() {
  if (busy.value || props.pending || !canRun.value) return
  if (action.value === 'remove' && !confirming.value) {
    confirming.value = true
    return
  }
  confirming.value = false
  const chosen = new Set(props.ids)
  const batch = props.items.filter((item) => chosen.has(item.id))
  const mode = action.value
  const text = value.value.trim()
  let moves: SoftwareCategoryMove[] = []
  if (props.kind === 'software' && mode === 'category') {
    preparing.value = true
    try {
      moves = await previewSoftwareCategoryChanges(
        batch.map((item) => item.id),
        text
      )
      if (
        moves.length &&
        !(await confirmDialog({
          title: tr('确认同步调整整理目录？'),
          message: categoryMoveConfirmation(moves),
          confirmText: tr('确认调整'),
        }))
      ) {
        return
      }
    } catch (cause) {
      toast(errorMessage(cause))
      return
    } finally {
      preparing.value = false
    }
  }
  lastLabel.value = label.value
  await operation.run(batch, async (item) => {
    const api = window.baoyi[props.kind]
    if (mode === 'remove') {
      const result = await api.remove(item.id)
      if (result && 'ok' in result && !result.ok) throw new Error(result.message)
      return
    }
    const current = await api.get(item.id)
    if (!current) throw new Error(tr('条目已不存在，请刷新资料库'))
    const move = moves.find((m) => m.id === item.id)
    if (move) {
      const p = move.preview
      const result = await window.baoyi.organize.relocate(item.id, p.category, p.folder, p.from)
      if (!result.ok) throw new Error(result.message)
      return
    }
    const patch: Record<string, unknown> = {}
    if (mode === 'category') patch.category = text
    if (mode === 'tags') {
      patch.tags = [
        ...new Set([
          ...current.tags,
          ...text
            .split(/[,，、]/)
            .map((tag) => tag.trim())
            .filter(Boolean),
        ]),
      ]
    }
    if (mode === 'remove-tags') {
      const drop = new Set(
        text
          .split(/[,，、]/)
          .map((tag) => tag.trim())
          .filter(Boolean)
      )
      patch.tags = current.tags.filter((tag: string) => !drop.has(tag))
    }
    if (mode === 'play_status') patch.play_status = text
    if (mode === 'archive' || mode === 'restore') patch.is_archived = mode === 'archive'
    if (mode === 'group') patch.group = text
    if (mode === 'state') patch.state = text
    if (mode === 'pin' || mode === 'unpin') patch.pinned = mode === 'pin'
    const updated = await api.update(item.id, patch)
    if (!updated) throw new Error(tr('条目未保存，请刷新后重试'))
  })
  emit(
    'completed',
    failures.value.map((item) => item.id)
  )
}
</script>

<template>
  <section class="library-bulk" :aria-label="$t('批量管理')" :aria-busy="busy">
    <header>
      <strong aria-live="polite" :title="$t('仅包含当前搜索与筛选结果；勾选卡片开始，Esc 可退出')">{{ $t("已选 {p0} / {p1} 项", {p0: (ids.length), p1: (items.length)}) }}</strong>
      <button class="btn btn--subtle" :disabled="busy || pending || !items.length" @click="emit('all')">{{ $t("全选当前结果") }}</button>
      <button v-if="ids.length" class="btn btn--subtle" :disabled="busy || !ids.length" @click="emit('clear')">{{ $t("清空选择") }}</button>
      <button class="btn btn--subtle bulk-close" :disabled="busy" @click="emit('close')">{{ $t("退出批量管理") }}</button>
    </header>
    <form v-if="ids.length || busy" @submit.prevent="apply">
      <fieldset :disabled="busy || pending">
        <label>{{ $t("操作") }}<select v-model="action" :aria-label="$t('批量操作')">
            <option v-for="option in actions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label v-if="action === 'category'">{{ $t("目标分类") }}<select v-model="value" :aria-label="$t('批量分类')">
            <option value="" disabled>{{ $t("选择分类") }}</option>
            <option v-for="category in categories" :key="category" :value="category">{{ category }}</option>
          </select>
        </label>
        <label v-if="action === 'tags'" class="bulk-value">{{ $t("新增标签") }}<input v-model="value" :aria-label="$t('批量标签')" :placeholder="$t('多个标签用逗号分隔')" maxlength="500" />
        </label>
        <label v-if="action === 'remove-tags'" class="bulk-value">{{ $t("移除标签") }}<input v-model="value" :aria-label="$t('批量移除标签')" :placeholder="$t('多个标签用逗号分隔')" maxlength="500" />
        </label>
        <label v-if="action === 'play_status'">{{ $t("游玩状态") }}<select v-model="value" :aria-label="$t('批量游玩状态')">
            <option value="" disabled>{{ $t("选择状态") }}</option>
            <option value="playing">{{ $t("在玩") }}</option>
            <option value="unplayed">{{ $t("想玩") }}</option>
            <option value="completed">{{ $t("通关") }}</option>
            <option value="shelved">{{ $t("搁置") }}</option>
          </select>
        </label>
        <label v-if="action === 'group'" class="bulk-value">{{ $t("分组名称") }}<input v-model="value" :aria-label="$t('批量分组')" :placeholder="$t('留空可取消分组')" maxlength="100" />
        </label>
        <label v-if="action === 'state'">{{ $t("目标状态") }}<select v-model="value" :aria-label="$t('批量状态')">
            <option value="" disabled>{{ $t("选择状态") }}</option>
            <option value="active">{{ $t("使用中") }}</option>
            <option value="maintaining">{{ $t("维护中") }}</option>
            <option value="paused">{{ $t("已暂停") }}</option>
            <option value="archived">{{ $t("已归档") }}</option>
          </select>
        </label>
        <button
          v-if="!confirming"
          class="btn"
          :class="action === 'remove' ? 'bulk-danger' : 'btn--primary'"
          type="submit"
          :disabled="!canRun"
        >
          {{ busy ? $t('处理中 {p0} / {p1}', {p0: processed, p1: total}) : $t('{p0}所选 {p1} 项', {p0: label, p1: ids.length}) }}
        </button>
      </fieldset>
      <div v-if="confirming" class="bulk-confirm" role="alert">
        <span>{{ $t("将 {p0} 项移出资料库。原文件保留，库内资料需要重新导入。{p1}确认继续？", {p0: (ids.length), p1: (kind === 'software' ? $t('整理目录里属于它们的链接会一并删除。') : '')}) }}</span>
        <button class="btn bulk-danger" type="submit" :disabled="busy || pending">{{ $t("确认移出 {p0} 项", {p0: (ids.length)}) }}</button>
        <button class="btn btn--subtle" type="button" @click="confirming = false">{{ $t("取消") }}</button>
      </div>
    </form>
    <p v-if="pending" role="status">{{ $t("当前筛选结果尚未就绪，更新后可继续操作。") }}<button class="btn btn--subtle" :disabled="busy" @click="emit('refresh')">{{ $t("刷新结果") }}</button>
    </p>

    <p v-if="total" role="status">
      {{
        busy
          ? $t('正在{p0}：{p1} / {p2}', {p0: lastLabel, p1: processed, p2: total})
          : $t('{p0}结束：成功 {p1} 项{p2}', {p0: lastLabel, p1: succeeded, p2: failures.length ? $t('，失败 {p0} 项；失败项已保留选择，可重试', {p0: failures.length}) : ''})
      }}
    </p>
    <details v-if="failures.length" open class="bulk-errors">
      <summary>{{ $t("未完成的项目") }}</summary>
      <ul>
        <li v-for="item in failures" :key="item.id">
          <strong>{{ item.name }}</strong>：{{ $systemMessage(item.message) }}
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.library-bulk {
  flex: none;
  max-height: 42vh;
  overflow: auto;
  margin: 0 20px 12px;
  padding: 8px 12px;
  background: var(--bg-card);
  border: 1px solid var(--divider);
  border-radius: var(--radius-card);
  color: var(--text-main);
}
header,
fieldset,
.bulk-confirm {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}
header {
  margin-bottom: 0;
}
form {
  margin-top: 8px;
}
header strong {
  font-size: 13px;
  font-weight: 500;
}
.bulk-close {
  margin-left: auto;
}
fieldset {
  align-items: center;
  border: 0;
  padding: 0;
  min-width: 0;
  margin: 0;
}
label {
  display: flex;
  flex-direction:row;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-sub);
  min-width: 0;
}
.bulk-value {
  flex: 1;
  min-width: 150px;
  max-width: 330px;
}
input,
select {
  max-width: 100%;
  height: 34px;
  border: 1px solid var(--divider);
  border-radius: var(--radius-input);
  padding: 0 9px;
  background: var(--bg-main);
  color: var(--text-main);
}
label select,
label input {
  min-width: 0;
}
p {
  font-size: 12px;
  line-height: 1.6;
  margin: 10px 0 0;
}
.bulk-hint {
  color: var(--text-sub);
}
.bulk-danger {
  color: var(--danger);
  border: 1px solid var(--danger);
}
.bulk-confirm {
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.6;
}
.bulk-confirm span {
  flex-basis: 100%;
}
.bulk-errors {
  color: var(--danger);
  font-size: 12px;
  line-height: 1.7;
  margin-top: 10px;
}
.bulk-errors ul {
  padding-left: 20px;
  overflow-wrap: anywhere;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
@media (max-width: 1100px) {
  .library-bulk {
    margin-left: 12px;
    margin-right: 12px;
    padding: 10px;
  }
  header {
    gap: 6px;
  }
  header .btn {
    padding: 0 8px;
  }
}
</style>
