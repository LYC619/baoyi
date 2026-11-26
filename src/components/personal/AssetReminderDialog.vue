<script setup lang="ts">
import { computed, ref } from 'vue'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import { workspace } from '@/utils/workspace-api'
import { renewalDate } from '@/utils/personal-assets'
import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'
import type { PersonalRecord } from '@/types/workspace'

const props = defineProps<{ record: PersonalRecord; mode: 'renew' | 'snooze'; today: string }>()
const emit = defineEmits<{ close: []; saved: [record: PersonalRecord] }>()
const to = ref(renewalDate(props.record)), cost = ref<number | ''>(typeof props.record.data.cost === 'number' ? props.record.data.cost : '')
const currency = ref(String(props.record.data.currency || 'CNY')), duration = ref('7'), customDate = ref(''), busy = ref(false)
const until = computed(() => {
  if (duration.value === 'custom') return customDate.value
  const date = new Date(props.today + 'T00:00:00Z')
  date.setUTCDate(date.getUTCDate() + Number(duration.value))
  return date.toISOString().slice(0, 10)
})
async function save() {
  if (busy.value) return
  busy.value = true
  try {
    const record = props.mode === 'renew'
      ? await workspace.personal.renew(props.record.id, { to: to.value, ...(cost.value === '' ? {} : { cost: cost.value, currency: currency.value }) })
      : await workspace.personal.snooze(props.record.id, until.value)
    emit('saved', record); emit('close')
  } catch (cause) { useToast().error(errorMessage(cause)) }
  finally { busy.value = false }
}
</script>

<template>
  <ProjectDialog :title="mode === 'renew' ? $t('已续费') : $t('暂缓提醒')" :busy="busy" @close="emit('close')">
    <form id="asset-reminder-form" class="ws ws-form" @submit.prevent="save">
      <p>{{ record.name }}</p>
      <template v-if="mode === 'renew'">
        <p class="ws-muted">{{ $t("原到期日：{p0}", {p0: (record.data.expiresOn || $t('未设置'))}) }}</p>
        <label>{{ $t("新到期日") }}<input v-model="to" type="date" required /></label>
        <label>{{ $t("本次费用") }}<input v-model.number="cost" type="number" min="0" max="1000000000" step="any" :placeholder="$t('未填写')" /></label>
        <label>{{ $t("币种") }}<input v-model="currency" maxlength="3" :required="cost !== ''" placeholder="CNY / USD" /></label>
      </template>
      <template v-else>
        <label>{{ $t("暂缓时长") }}<select v-model="duration" :aria-label="$t('暂缓时长')"><option value="7">{{ $t("7 天") }}</option><option value="30">{{ $t("30 天") }}</option><option value="custom">{{ $t("到指定日期") }}</option></select></label>
        <label v-if="duration === 'custom'">{{ $t("暂缓至") }}<input v-model="customDate" type="date" required :min="today" /></label>
        <p class="ws-muted">{{ $t("{p0}这项仍会显示在背包里。", {p0: (until ? $t('暂缓至 ') + until + $t('，当天恢复提醒。') : $t('请选择晚于今天的日期。'))}) }}</p>
      </template>
    </form>
    <template #footer><button class="ws-button" :disabled="busy" @click="emit('close')">{{ $t("取消") }}</button><button class="ws-button primary" form="asset-reminder-form" type="submit" :disabled="busy">{{ busy ? $t('正在保存…') : mode === 'renew' ? $t('确认续费') : $t('确认暂缓') }}</button></template>
  </ProjectDialog>
</template>
