<script setup lang="ts">
import { computed, ref } from "vue";
const props = defineProps<{
  values: Array<{ id: string; date: string; value: number }>;
  unit: string;
  label: string;
}>();
const active = ref("");
const rows = computed(() =>
  [...props.values].sort((a, b) => a.date.localeCompare(b.date)).slice(-30),
);
const range = computed(() => {
  const values = rows.value.map((r) => r.value);
  const min = Math.min(...values),
    max = Math.max(...values);
  return min === max ? { min: min - 0.5, max: max + 0.5, span: 1 } : { min, max, span: max - min };
});
const dots = computed(() =>
  rows.value.map((r, i) => ({
    ...r,
    x: rows.value.length === 1 ? 310 : 60 + (i * 500) / (rows.value.length - 1),
    y:
      range.value.max === range.value.min
        ? 75
        : 125 - ((r.value - range.value.min) * 100) / range.value.span,
  })),
);
const selected = computed(
  () => dots.value.find((d) => d.id === active.value) || dots.value.at(-1),
);
const average = computed(() =>
  rows.value.length
    ? rows.value.reduce((sum, r) => sum + r.value, 0) / rows.value.length
    : 0,
);
</script>
<template>
  <div v-if="rows.length" class="metric-trend">
    <svg
      viewBox="0 0 600 165"
      role="img"
      :aria-label="label + $t('的最近记录趋势')"
      @mouseleave="active = ''"
    >
      <template v-for="(y, i) in [25, 75, 125]" :key="y">
        <line
          x1="60"
          :y1="y"
          x2="560"
          :y2="y"
          stroke="var(--divider)"
          stroke-dasharray="4 4"
        />
        <text x="53" :y="y + 4" text-anchor="end">
          {{ (range.max - (i * (range.max - range.min)) / 2).toLocaleString($locale, { maximumSignificantDigits: 4 }) }}
        </text>
      </template>
      <polyline
        v-if="dots.length > 1"
        :points="dots.map((d) => `${d.x},${d.y}`).join(' ')"
        fill="none"
        stroke="var(--accent)"
        stroke-width="2"
      />
      <circle
        v-for="dot in dots"
        :key="dot.id"
        :cx="dot.x"
        :cy="dot.y"
        :r="active === dot.id ? 6 : 4"
        fill="var(--accent)"
        tabindex="0"
        :aria-label="dot.date + ' ' + dot.value + ' ' + unit"
        @mouseenter="active = dot.id"
        @mouseleave="active = ''"
        @focus="active = dot.id"
        @blur="active = ''"
      />
      <text x="60" y="155">{{ rows[0].date }}</text>
      <text x="560" y="155" text-anchor="end">{{ rows.at(-1)?.date }}</text>
    </svg>
    <p aria-live="polite">
      {{ selected?.date }} · <strong>{{ selected?.value }} {{ unit }}</strong>
      <span>{{ $t("平均 {p0} {p1} · {p2}", {p0: (average.toFixed(2)), p1: (unit), p2: (active ? $t('悬停查看') : $t('最近一次记录'))}) }}</span>
    </p>
  </div>
  <p v-else class="ws-muted">{{ $t("暂无数值记录") }}</p>
</template>
<style scoped>
.metric-trend svg {
  width: 100%;
  max-height: 220px;
  display: block;
}
.metric-trend text {
  font: 11px var(--font-ui);
  fill: var(--text-sub);
}
.metric-trend p {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-sub);
}
.metric-trend p span {
  margin-left: auto;
}
.metric-trend strong {
  color: var(--accent);
}
circle {
  cursor: pointer;
}
</style>
