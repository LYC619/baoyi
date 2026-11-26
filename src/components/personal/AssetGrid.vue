<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { locale as appLocale } from '../../i18n/index.ts'

import { computed } from "vue";
import { Backpack } from "lucide-vue-next";
import type { PersonalRecord } from "@/types/workspace";
import { assetAnnualCosts, filterAssets, formatAssetPrice, matchesExpiry, isReminding, isSnoozed, CURRENCY_SYMBOLS } from "@/utils/personal-assets";
import { usePersonalView } from "@/composables/usePersonalView";
import { daysUntil, dueText } from "@/utils/personal-view";

const props = defineProps<{
  records: PersonalRecord[];
  categories: string[];
  today: string;
  remindDays: number;
}>();
const emit = defineEmits<{ select: [record: PersonalRecord] }>();
const view = usePersonalView("assets", { query: "", category: "", sort: "expiry", status: "all" });

const categories = computed(() => [
  ...new Set([
    ...props.categories,
    ...props.records.map((r) => String(r.data.category || tr("其他"))),
  ]),
]);

const filtered = computed(() =>
  filterAssets(props.records, view.query, view.category, view.sort).filter((r) =>
    matchesExpiry(r, view.status, props.today, props.remindDays),
  ),
);

const snoozedCount = computed(() => props.records.filter((r) => isSnoozed(r, props.today)).length);
const annual = computed(() => assetAnnualCosts(props.records));
const days = (r: PersonalRecord) => daysUntil(r.data.expiresOn, props.today);
const expiry = (r: PersonalRecord) => days(r) === null ? tr("未设置到期日") : dueText(r.data.expiresOn, props.today);
const snoozedDate = (r: PersonalRecord) => {
  const [, month, day] = String(r.data.snoozedUntil).split('-');
  return tr("{p0} 月 {p1} 日", {p0: (Number(month)), p1: (Number(day))});
};

function monthlyEquivalent(r: PersonalRecord): string {
  if (r.data.cycle !== 'yearly' || typeof r.data.cost !== 'number' || !Number.isFinite(r.data.cost) || r.data.cost <= 0) return '';
  const code = String(r.data.currency || '').toUpperCase();
  const sym = CURRENCY_SYMBOLS[code] || '';
  const monthly = (r.data.cost / 12).toLocaleString(appLocale.value, { maximumFractionDigits: 1 });
  return tr("约 {p0}{p1}{p2}/月", {p0: (sym), p1: (monthly), p2: (!sym && code ? ' ' + code : '')});
}

function reset() { view.query = ''; view.category = ''; view.status = 'all'; view.sort = 'expiry' }

const cycles: Record<string, string> = {
  get once() { return tr("一次性") },
  get monthly() { return tr("每月") },
  get yearly() { return tr("每年") },
  get other() { return tr("其他周期") },
};
</script>
<template>
  <section class="asset-browser">
    <div class="asset-summary">
      <span><strong>{{ records.length }}</strong>{{ $t("项资产") }}</span>
      <span><strong>{{ records.filter((r) => isReminding(r, remindDays, today)).length }}</strong>{{ $t("项已到期 / {p0} 天内到期", {p0: (remindDays)}) }}</span>
      <span v-for="(cost, currency) in annual.totals" :key="currency">{{ $t("按当前周期折算年费") }}<strong>{{ CURRENCY_SYMBOLS[String(currency)] || '' }}{{ cost.toLocaleString($locale, { maximumFractionDigits: 2 }) }} {{ currency }}</strong>
        <em class="asset-summary-monthly">{{ $t("（约 {p0}{p1}/月）", {p0: (CURRENCY_SYMBOLS[String(currency)] || ''), p1: ((cost / 12).toLocaleString($locale, { maximumFractionDigits: 1 }))}) }}</em>
      </span>
      <button v-if="snoozedCount" type="button" class="ws-button asset-snooze-btn" @click="view.status = view.status === 'snoozed' ? 'all' : 'snoozed'">
        {{ view.status === 'snoozed' ? $t('返回全部资产') : $t('查看 {p0} 项已暂缓提醒', {p0: snoozedCount}) }}
      </button>
      <small v-if="annual.omitted">{{ $t("{p0} 项费用或周期未明确，未计入年费", {p0: (annual.omitted)}) }}</small>
    </div>
    <div class="ws-toolbar">
      <input
        v-model="view.query"
        :aria-label="$t('搜索背包')"
        :placeholder="$t('搜索名称、用途或提供方')"
      />
      <select v-model="view.category" :aria-label="$t('筛选背包类别')">
        <option value="">{{ $t("全部类别") }}</option>
        <option v-for="item in categories" :key="item">{{ item }}</option>
      </select>
      <select v-model="view.status" :aria-label="$t('背包到期筛选')">
        <option value="all">{{ $t("全部到期状态") }}</option>
        <option value="reminding">{{ $t("待处理到期（已到期 + {p0} 天内）", {p0: (remindDays)}) }}</option>
        <option value="overdue">{{ $t("已到期") }}</option>
        <option value="soon">{{ $t("{p0} 天内到期", {p0: (remindDays)}) }}</option>
        <option value="snoozed">{{ $t("已暂缓提醒") }}</option>
        <option value="undated">{{ $t("未设到期日") }}</option>
      </select>
      <select v-model="view.sort" :aria-label="$t('背包排序')">
        <option value="expiry">{{ $t("到期时间") }}</option>
        <option value="name">{{ $t("名称") }}</option>
        <option value="cost">{{ $t("折算年费（按币种分组）") }}</option>
      </select>
    </div>
    <div class="ws-toolbar">
      <small class="ws-muted" role="status">{{ $t("显示 {p0} / {p1} 项 · 汇总为全部资产，买断和未知周期不折算年费", {p0: (filtered.length), p1: (records.length)}) }}<template v-if="snoozedCount && ['reminding', 'overdue', 'soon'].includes(view.status)">{{ $t("· 另有 {p0} 项已暂缓提醒（可切到「已暂缓提醒」查看）", {p0: (snoozedCount)}) }}</template>
      </small>
      <button v-if="view.query || view.category || view.status !== 'all'" class="ws-button" @click="reset">{{ $t("清除筛选") }}</button>
    </div>
    <div class="asset-grid">
      <button
        v-for="record in filtered"
        :key="record.id"
        class="asset-card"
        @click="emit('select', record)"
      >
        <span class="asset-category"><Backpack :size="18" />{{ record.data.category || $t('其他') }}</span>
        <h3>{{ record.name }}</h3>
        <p>{{ record.data.provider || record.body || $t('尚未补充用途') }}</p>
        <strong>
          {{ formatAssetPrice(record.data.cost, record.data.currency) }}
          <small v-if="record.data.cycle">/ {{ cycles[String(record.data.cycle)] }}</small>
          <small v-if="monthlyEquivalent(record)" class="asset-monthly"> · {{ monthlyEquivalent(record) }}</small>
        </strong>
        <span
          class="asset-expiry"
          :class="{
            urgent: isReminding(record, Math.min(10, remindDays), today),
            soon:
              isReminding(record, remindDays, today) &&
              days(record)! > Math.min(10, remindDays) &&
              days(record)! <= remindDays,
          }"
        >{{ expiry(record) }}</span>
        <span v-if="isSnoozed(record, today)" class="asset-snoozed">{{ $t("已暂缓至 {p0}", {p0: (snoozedDate(record))}) }}</span>
      </button>
    </div>
    <p v-if="!filtered.length" class="ws-empty">
      {{
        records.length
          ? $t('没有符合条件的资产，试试其他分类或关键词。')
          : $t('用个人助手记下一项资产，也可以手动添加。')
      }}
    </p>
  </section>
</template>
<style scoped>
.asset-snoozed { color: var(--text-sub); font-size: 12px; }
.asset-summary-monthly { font-style: normal; color: var(--text-sub); margin-left: 4px; }
.asset-snooze-btn { padding: 4px 10px; font-size: 12px; }
.asset-monthly { color: var(--text-sub); }
.asset-summary {
  display: flex;
  gap: 16px 24px;
  align-items: center;
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
