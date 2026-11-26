<script setup lang="ts">
import EditableField from '@/components/ui/EditableField.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import type { SoftwareItem } from '@/types'

defineProps<{
  item: SoftwareItem
}>()

const emit = defineEmits<{
  (e: 'save', patch: Partial<SoftwareItem>): void
  (e: 'commit-alternatives', raw: string): void
}>()
</script>

<template>
  <div
    id="software-panel-notes"
    role="tabpanel"
    aria-labelledby="software-tab-notes"
    tabindex="0"
    class="detail-panel detail-panel--notes"
  >
    <section class="panel">
      <h2 class="sec-title">{{ $t("为什么选它") }}</h2>
      <EditableField
        :model-value="item.why_choose"
        multiline
        :placeholder="$t('同类里为什么留下这一个')"
        @commit="emit('save', { why_choose: $event })"
      />
    </section>
    <section class="panel">
      <h2 class="sec-title">{{ $t("使用场景") }}</h2>
      <EditableField
        :model-value="item.use_cases"
        multiline
        :placeholder="$t('什么时候会打开它')"
        @commit="emit('save', { use_cases: $event })"
      />
    </section>
    <section class="panel">
      <h2 class="sec-title">{{ $t("个人笔记") }}</h2>
      <EditableField
        :model-value="item.notes"
        multiline
        :placeholder="$t('快捷键、配置位置、踩过的坑…')"
        @commit="emit('save', { notes: $event })"
      />
    </section>
    <section class="panel">
      <h2 class="sec-title">{{ $t("替代的同类") }}</h2>
      <div v-if="item.alternatives.length" class="tag-row">
        <TagBadge v-for="a in item.alternatives" :key="a" :label="a" tone="muted" />
      </div>
      <EditableField
        :model-value="item.alternatives.join('、')"
        :placeholder="$t('被它替代掉的软件')"
        @commit="emit('commit-alternatives', $event)"
      />
    </section>
  </div>
</template>

<style scoped>
.sec-title {
  font-size: var(--fs-tag);
  font-weight: 500;
  letter-spacing: 0.5px;
  color: var(--text-faint);
  margin-bottom: 10px;
}
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
</style>
