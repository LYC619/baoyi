<script setup lang="ts">
import MetricTrend from "./MetricTrend.vue";
import { computed, ref, watch } from "vue";
import type { PersonalRecord } from "@/types/workspace";
const props = defineProps<{
    metric: PersonalRecord;
    records: PersonalRecord[];
  }>(),
  emit = defineEmits<{
    edit: [record: PersonalRecord];
    remove: [record: PersonalRecord];
  }>();
const rows = computed(() =>
  props.records
    .filter((r) => r.data.metricId === props.metric.id)
    .sort(
      (a, b) =>
        String(a.data.date).localeCompare(String(b.data.date)) ||
        a.createdAt - b.createdAt,
    ),
);
const recent = computed(() => rows.value.slice(-30));
const page = ref(1), pageSize = 10;
const pages = computed(() => Math.max(1, Math.ceil(rows.value.length / pageSize)));
const visible = computed(() => [...rows.value].reverse().slice((page.value-1)*pageSize,page.value*pageSize));
watch(pages, value => { page.value=Math.min(page.value,value) });
const latest = computed(() => rows.value.at(-1));
</script>
<template>
  <section class="state-history">
    <header class="ws-section-head">
      <h3>
        {{ metric.name }} <span class="ws-muted">{{ metric.data.unit }}</span>
      </h3>
      <span class="ws-muted">最近 {{ recent.length }} 条记录</span>
    </header>
    <p v-if="latest" class="ws-muted">最近一次 · {{ latest.data.date }} <strong>{{ latest.data.value }} {{ metric.data.unit }}</strong></p>
    <p v-else class="ws-muted">还没有记录，在上方选择此指标并填入数值。</p>
    <MetricTrend
      :values="
        recent.map((r) => ({
          id: r.id,
          date: String(r.data.date),
          value: Number(r.data.value),
        }))
      "
      :unit="String(metric.data.unit || '')"
      :label="metric.name"
    />
    <div class="state-rows">
      <article v-for="record in visible" :key="record.id">
        <span>{{ record.data.date }}</span
        ><strong>{{ record.data.value }} {{ metric.data.unit }}</strong
        ><span class="state-note">{{ record.body }}</span
        ><button class="ws-button" @click="emit('edit', record)">编辑</button
        ><button
          class="ws-icon"
          aria-label="删除状态记录"
          @click="emit('remove', record)"
        >
          ×
        </button>
      </article>
    </div>
    <nav v-if="rows.length > pageSize" class="ws-toolbar" :aria-label="metric.name + '历史分页'"><button class="ws-button" :disabled="page === 1" @click="page--">上一页</button><span>{{ page }} / {{ pages }} 页 · 共 {{ rows.length }} 条</span><button class="ws-button" :disabled="page === pages" @click="page++">下一页</button></nav>
  </section>
</template>
<style scoped>
.state-chart {
  max-width: 700px;
}
.state-chart svg {
  width: 100%;
  max-height: 220px;
  display: block;
}
.state-chart text {
  font: 11px var(--font-ui);
  fill: var(--text-sub);
}
.state-chart p {
  font-size: 12px;
}
.state-rows {
  margin-top: 20px;
}
.state-rows article {
  display: flex;
  gap: 15px;
  align-items: center;
  flex-wrap: wrap;
  padding: 12px 0;
  border-top: 1px solid var(--divider);
  font-size: 12px;
}
.state-rows strong {
  font-size: 14px;
}
.state-note {
  flex: 1;
  color: var(--text-sub);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.state-rows .ws-button {
  font-size: 11px;
  padding: 5px 8px;
}
</style>
