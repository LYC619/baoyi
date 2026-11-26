<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { computed, ref } from "vue";
import type { PersonalRecord } from "@/types/workspace";
import { usePersonalView } from "@/composables/usePersonalView";
import ResourceLinks from "@/components/workspace/ResourceLinks.vue";
const props = defineProps<{ records: PersonalRecord[] }>();
const emit = defineEmits<{
  edit: [record: PersonalRecord];
  remove: [record: PersonalRecord];
}>();
const selected = ref("");
const view = usePersonalView('experience', { query: '', category: '' });
const categories = computed(() => [...new Set(props.records.map((r) => String(r.data.category || tr("经历"))))]);
const filtered = computed(() => props.records.filter((r) => (!view.category || (r.data.category || tr("经历")) === view.category) && [r.name, r.body, r.data.organization].join(' ').toLocaleLowerCase().includes(view.query.trim().toLocaleLowerCase())));
const groups = computed(() => {
  const years = new Map<string, PersonalRecord[]>();
  for (const row of [...filtered.value].sort((a, b) =>
    String(b.data.date || "").localeCompare(String(a.data.date || "")),
  )) {
    const year = String(row.data.date || "").slice(0, 4) || tr("日期未填写");
    years.set(year, [...(years.get(year) || []), row]);
  }
  return [...years];
});
function metaLine(row: PersonalRecord): string {
  return [row.data.date, row.data.organization].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');
}
</script>
<template>
  <section class="experience-timeline">
    <div class="ws-toolbar"><input v-model="view.query" :aria-label="$t('搜索经历')" :placeholder="$t('搜索名称、经过或颁发机构')" /><select v-model="view.category" :aria-label="$t('经历类型')"><option value="">{{ $t("全部类型") }}</option><option v-for="category in categories" :key="category">{{ category }}</option></select><button v-if="view.query || view.category" class="ws-button" @click="view.query='';view.category=''">{{ $t("清除筛选") }}</button></div>
    <p class="ws-muted" role="status">{{ $t("显示 {p0} / {p1} 条经历", {p0: (filtered.length), p1: (records.length)}) }}</p>
    <section v-for="[year, rows] in groups" :key="year">
      <h2>{{ year }}</h2>
      <article v-for="row in rows" :key="row.id" class="ws-panel">
        <header class="ws-section-head">
          <div>
            <span class="ws-badge">{{ row.data.category || $t('经历') }}</span>
            <h3>{{ row.name }}</h3>
            <small v-if="metaLine(row)" class="ws-muted">{{ metaLine(row) }}</small>
          </div>
          <button class="ws-button" @click="emit('edit', row)">{{ $t("编辑") }}</button>
        </header>
        <p class="ws-pre">{{ row.body }}</p>
        <button
          class="ws-button"
          @click="selected = selected === row.id ? '' : row.id"
        >{{ $t("凭证与相关项目") }}</button
        ><button class="ws-button danger" @click="emit('remove', row)">{{ $t("删除") }}</button
        ><ResourceLinks
          v-if="selected === row.id"
          owner="experience"
          :id="row.id"
          :title="$t('凭证与相关项目')"
        />
      </article>
    </section>
    <p v-if="!filtered.length" class="ws-empty">
      {{ records.length ? $t('没有符合条件的经历，试试其他关键词或类型。') : $t('记下一次经历，也可以让归档助理从已有凭证中整理。') }}
    </p>
  </section>
</template>
<style scoped>
.experience-timeline > section {
  border-left: 2px solid var(--divider);
  padding-left: 24px;
  margin-bottom: 32px;
}
.experience-timeline article {
  margin: 14px 0;
}
.experience-timeline h3 {
  margin-top: 10px;
}
.experience-timeline article > .ws-button {
  margin-right: 10px;
}
</style>
