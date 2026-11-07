<script setup lang="ts">
import { ref } from "vue";
import { workspace, localDate } from "@/utils/workspace-api";
import type { PersonalRecord } from "@/types/workspace";
defineProps<{ metrics: PersonalRecord[] }>();
const name = ref(""),
  metricId = ref(""),
  unit = ref(""),
  value = ref<number | string>(""),
  date = ref(localDate()),
  busy = ref(false),
  error = ref("");
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (typeof value.value !== "number") throw new Error("请输入数值");
    await workspace.personal.captureState(
      name.value,
      unit.value,
      value.value,
      date.value,
      metricId.value || undefined,
    );
    value.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <form class="state-capture" @submit.prevent="save">
    <div class="ws-toolbar">
      <button
        v-for="metric in metrics"
        :key="metric.id"
        type="button"
        class="ws-button"
        @click="
          name = metric.name;
          unit = String(metric.data.unit || '');
          metricId = metric.id;
        "
      >
        {{ metric.name }}{{ metric.data.unit ? " · " + metric.data.unit : "" }}
      </button>
    </div>
    <div class="ws-toolbar">
      <input
        v-model="name"
        @input="metricId = ''"
        aria-label="快捷状态名称"
        placeholder="指标名称，例如体重"
        required
        maxlength="300"
      /><input
        v-model="unit"
        @input="metricId = ''"
        aria-label="快捷状态单位"
        placeholder="单位，例如 kg"
        maxlength="50"
      /><input
        v-model.number="value"
        aria-label="快捷状态数值"
        type="number"
        step="any"
        required
        placeholder="数值"
      /><input
        v-model="date"
        aria-label="快捷状态日期"
        type="date"
        required
      /><button class="ws-button primary" :disabled="busy">记录状态</button>
    </div>
    <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
  </form>
</template>
<style scoped>
.state-capture > .ws-toolbar > input {
  flex: 1;
  min-width: 110px;
}
.state-capture {
  margin-bottom: 24px;
}
</style>
