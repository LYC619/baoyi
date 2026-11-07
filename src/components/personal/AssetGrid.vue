<script setup lang="ts">
import { computed } from "vue";
import { Backpack } from "lucide-vue-next";
import type { PersonalRecord } from "@/types/workspace";
import { assetAnnualCosts, filterAssets, matchesExpiry } from "@/utils/personal-assets";
import { usePersonalView } from "@/composables/usePersonalView";
import { daysUntil, dueText } from "@/utils/personal-view";
const props = defineProps<{
  records: PersonalRecord[];
  categories: string[];
  today: string;
  remindDays: number;
}>();
const emit = defineEmits<{ select: [record: PersonalRecord] }>();
const view = usePersonalView("assets", {query:"", category:"", sort:"expiry", status:"all"});
const categories = computed(() => [
  ...new Set([
    ...props.categories,
    ...props.records.map((r) => String(r.data.category || "其他")),
  ]),
]);
const filtered = computed(() =>
  filterAssets(props.records, view.query, view.category, view.sort).filter(r => matchesExpiry(r, view.status, props.today, props.remindDays)),
);
const annual = computed(() => assetAnnualCosts(props.records));
const days = (r: PersonalRecord) => daysUntil(r.data.expiresOn, props.today);
const expiry = (r: PersonalRecord) => days(r) === null ? '未设置到期日' : dueText(r.data.expiresOn, props.today);
function reset() { view.query=''; view.category=''; view.status='all'; view.sort='expiry' }
const cycles: Record<string, string> = {
  once: "一次性",
  monthly: "每月",
  yearly: "每年",
  other: "其他周期",
};
</script>
<template>
  <section class="asset-browser">
    <div class="asset-summary">
      <span
        ><strong>{{ records.length }}</strong> 项资产</span
      >
      <span
        ><strong>{{
          records.filter((r) => days(r) !== null && days(r)! <= remindDays).length
        }}</strong>
        项已到期 / {{ remindDays }} 天内到期</span
      >
      <span v-for="(cost, currency) in annual.totals" :key="currency"
        >按当前周期折算年费
        <strong
          >{{ cost.toLocaleString(undefined, { maximumFractionDigits: 2 }) }}
          {{ currency }}</strong
        ></span
      >
      <small v-if="annual.omitted"
        >{{ annual.omitted }} 项费用或周期未明确，未计入年费</small
      >
    </div>
    <div class="ws-toolbar">
      <input
        v-model="view.query"
        aria-label="搜索背包"
        placeholder="搜索名称、用途或提供方"
      />
      <select v-model="view.category" aria-label="筛选背包类别">
        <option value="">全部类别</option>
        <option v-for="item in categories" :key="item">{{ item }}</option>
      </select>
      <select v-model="view.status" aria-label="背包到期筛选">
        <option value="all">全部到期状态</option><option value="overdue">已到期</option>
        <option value="soon">{{ remindDays }} 天内到期</option><option value="undated">未设到期日</option>
      </select>
      <select v-model="view.sort" aria-label="背包排序">
        <option value="expiry">到期时间</option>
        <option value="name">名称</option>
        <option value="cost">折算年费（按币种分组）</option>
      </select>
    </div>
    <div class="ws-toolbar"><small class="ws-muted" role="status">显示 {{ filtered.length }} / {{ records.length }} 项 · 汇总为全部资产，买断和未知周期不折算年费</small><button v-if="view.query || view.category || view.status !== 'all'" class="ws-button" @click="reset">清除筛选</button></div>
    <div class="asset-grid">
      <button
        v-for="record in filtered"
        :key="record.id"
        class="asset-card"
        @click="emit('select', record)"
      >
        <span class="asset-category"
          ><Backpack :size="18" />{{ record.data.category || "其他" }}</span
        >
        <h3>{{ record.name }}</h3>
        <p>{{ record.data.provider || record.body || "尚未补充用途" }}</p>
        <strong
          >{{
            typeof record.data.cost === "number"
              ? `${record.data.cost} ${record.data.currency || ""}`
              : "费用未填写"
          }}
          <small v-if="record.data.cycle"
            >/ {{ cycles[String(record.data.cycle)] }}</small
          ></strong
        >
        <span
          class="asset-expiry"
          :class="{
            urgent: days(record) !== null && days(record)! <= Math.min(10, remindDays),
            soon:
              days(record) !== null &&
              days(record)! > Math.min(10, remindDays) &&
              days(record)! <= remindDays,
          }"
          >{{ expiry(record) }}</span
        >
      </button>
    </div>
    <p v-if="!filtered.length" class="ws-empty">
      {{
        records.length
          ? "没有符合条件的资产，试试其他分类或关键词。"
          : "用个人助手记下一项资产，也可以手动添加。"
      }}
    </p>
  </section>
</template>
<style scoped>
.asset-summary {
  display: flex;
  gap: 16px 24px;
  flex-wrap: wrap;
  padding: 18px;
  background: var(--ws-tint);
  border-radius: 8px;
  font-size: 12px;
}
.asset-summary strong {
  font-size: 17px;
  color: var(--accent);
}
.asset-summary small {
  flex-basis: 100%;
  color: var(--text-sub);
}
.ws-toolbar input {
  flex: 1;
  min-width: 180px;
}
.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}
.asset-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 20px;
  border: 1px solid var(--divider);
  border-radius: 9px;
  background: var(--ws-paper);
  color: var(--text-main);
  text-align: left;
  min-width: 0;
}
.asset-card:hover {
  border-color: var(--accent);
}
.asset-card h3 {
  margin: 0;
  overflow-wrap: anywhere;
}
.asset-card p {
  font-size: 12px;
  color: var(--text-sub);
  margin: 0;
  overflow-wrap: anywhere;
}
.asset-card strong {
  margin-top: auto;
  font-size: 13px;
}
.asset-card small {
  font-weight: 400;
}
.asset-category {
  display: flex;
  gap: 8px;
  color: var(--accent);
  font-size: 12px;
}
.asset-expiry {
  font-size: 12px;
  color: var(--text-sub);
}
.urgent {
  color: var(--danger);
}
.soon {
  color: var(--warning);
}
</style>
