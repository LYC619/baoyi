<script setup lang="ts">
import { computed } from 'vue'
import type { DocumentItem } from '@/types/workspace'
import { documentProgress } from '@/utils/document-library-view'
const props = defineProps<{ item: DocumentItem }>()
const progress = computed(() => documentProgress(props.item))
</script>
<template>
  <div v-if="item.readable" class="document-progress">
    <div v-if="progress !== null" class="progress-line">
      <div
        class="progress-track"
        role="progressbar"
        :aria-label="item.name + $t('阅读进度')"
        :aria-valuenow="progress"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <span :style="{ width: progress + '%' }" />
      </div>
      <span class="progress-value">{{
        progress === 100 ? '100%' : $t('约 ') + progress + '%'
      }}</span>
    </div>
    <span v-else class="progress-pending">{{ $t("进度待载入") }}</span>
    <small v-if="item.pageCount">{{ $t("第 {p0} / {p1} {p2}", {p0: (item.position.page), p1: (item.pageCount), p2: (item.format === 'pdf' ? $t('页') : item.type === 'novel' ? $t('章') : $t('段'))}) }}</small>
  </div>
</template>
<style scoped>
.document-progress {
  width: 100%;
  min-width: 0;
  font-size: 11px;
}
.progress-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.progress-track {
  flex: 1;
  min-width: 45px;
  height: 4px;
  background: var(--divider);
  border-radius: 4px;
  overflow: hidden;
}
.progress-track span {
  height: 100%;
  display: block;
  background: var(--accent);
  border-radius: 4px;
}
.progress-value {
  color: var(--text-sub);
  font-size: 10px;
  white-space: nowrap;
}
.document-progress small {
  display: block;
  margin-top: 5px;
  font-size: 11px;
  color: var(--text-sub);
}
.progress-pending {
  color: var(--text-sub);
}
</style>
