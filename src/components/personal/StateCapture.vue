<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { errorMessage } from '@/utils'
import { nextTick, ref } from "vue";
import { workspace, localDate } from "@/utils/workspace-api";
import type { PersonalRecord } from "@/types/workspace";

defineProps<{ metrics: PersonalRecord[] }>();

const name = ref(""),
  metricId = ref(""),
  unit = ref(""),
  value = ref<number | string>(""),
  note = ref(""),
  date = ref(localDate()),
  valueInput = ref<HTMLInputElement>(),
  busy = ref(false),
  error = ref("");

function pickMetric(metric: PersonalRecord) {
  name.value = metric.name;
  unit.value = String(metric.data.unit || "");
  metricId.value = metric.id;
  error.value = "";
  void nextTick(() => valueInput.value?.focus());
}

async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (typeof value.value !== "number") throw new Error(tr('请输入数值'));
    await workspace.personal.captureState(
      name.value,
      unit.value,
      value.value,
      date.value,
      metricId.value || undefined,
      note.value,
    );
    value.value = "";
    note.value = "";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <form class="state-capture" @submit.prevent="save">
    <div v-if="metrics.length" class="ws-toolbar">
      <button
        v-for="metric in metrics"
        :key="metric.id"
        type="button"
        class="ws-button"
        :class="{ 'is-picked': metricId === metric.id }"
        @click="pickMetric(metric)"
      >
        {{ metric.name }}{{ metric.data.unit ? " · " + metric.data.unit : "" }}
      </button>
    </div>
    <div class="ws-toolbar">
      <input
        v-model="name"
        @input="metricId = ''"
        :aria-label="$t('快捷状态名称')"
        :placeholder="$t('指标名称，例如体重')"
        required
        maxlength="300"
      /><input
        v-model="unit"
        @input="metricId = ''"
        :aria-label="$t('快捷状态单位')"
        :placeholder="$t('单位，例如 kg')"
        maxlength="50"
      /><input
        ref="valueInput"
        v-model.number="value"
        :aria-label="$t('快捷状态数值')"
        type="number"
        step="any"
        required
        :placeholder="$t('数值')"
      /><input
        v-model="date"
        :aria-label="$t('快捷状态日期')"
        type="date"
        required
      /><input
        v-model="note"
        :aria-label="$t('快捷状态备注')"
        :placeholder="$t('备注（可选）')"
        maxlength="500"
      /><button class="ws-button primary" :disabled="busy">{{ $t("记录状态") }}</button>
    </div>
    <p v-if="error" class="ws-error" role="alert">{{ $systemMessage(error) }}</p>
  </form>
</template>
<style scoped>
.state-capture > .ws-toolbar > input {
  flex: 1;
  min-width: 105px;
}
.state-capture .is-picked {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--active-surface);
}
.state-capture {
  margin-bottom: 24px;
}
</style>
