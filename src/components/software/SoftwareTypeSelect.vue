<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useSoftwareStore } from '@/stores/software'
import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'
import type { SoftwareItem } from '@/types'

const props = withDefaults(defineProps<{ id: string; modelValue: boolean | null; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ updated: [item: SoftwareItem]; busy: [value: boolean] }>()
const store = useSoftwareStore()
const { success, error, toast } = useToast()
const saving = ref(false)
const valueOf = (value: boolean | null) => value === null ? 'unknown' : value ? 'portable' : 'installed'
const draft = ref(valueOf(props.modelValue))
watch(() => [props.id, props.modelValue], () => { draft.value = valueOf(props.modelValue) })
onBeforeRouteLeave(() => { if (saving.value) { toast(tr("正在保存软件类型，请稍后再离开")); return false } return true })

async function change(): Promise<void> {
  const next = draft.value
  if (saving.value || props.disabled || !['portable', 'installed', 'unknown'].includes(next)) {
    draft.value = valueOf(props.modelValue)
    return
  }
  if (next === valueOf(props.modelValue)) return
  const id = props.id
  let saved: SoftwareItem | null = null
  saving.value = true
  emit('busy', true)
  try {
    saved = await store.update(id, { is_portable: next === 'unknown' ? null : next === 'portable' })
    if (!saved) throw new Error(tr('软件记录已不存在'))
    if (props.id === id) {
      draft.value = valueOf(saved.is_portable)
      success(saved.is_portable === null ? tr('软件类型已设为待确认') : saved.is_portable ? tr('软件类型已设为绿色版') : tr('软件类型已设为安装版'))
    }
  } catch (cause) {
    draft.value = valueOf(props.modelValue)
    error(tr("保存软件类型失败：{p0}", {p0: (errorMessage(cause))}))
  } finally {
    saving.value = false
    emit('busy', false)
  }
  if (saved && props.id === id) emit('updated', saved)
}
</script>

<template>
  <div class="software-type-control">
    <label>
      <span>{{ $t("软件类型") }}</span>
      <select v-model="draft" class="input" :aria-label="$t('软件类型')" :disabled="disabled || saving" :aria-busy="saving"
        :title="$t('绿色版通常解压即可运行，安装版通常需要安装程序。设置类型只更新记录，不会移动软件或改变链接。')" @change="change">
        <option value="unknown">{{ $t("待确认") }}</option>
        <option value="portable">{{ $t("绿色版") }}</option>
        <option value="installed">{{ $t("安装版") }}</option>
      </select>
    </label>
    <span v-if="saving" class="saving" role="status">{{ $t("保存中…") }}</span>
  </div>
</template>

<style scoped>
.software-type-control,.software-type-control label{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.software-type-control{font-size:var(--fs-tag);color:var(--text-sub)}
.software-type-control select{width:auto;min-width:100px}.saving{font-size:11px}
</style>
