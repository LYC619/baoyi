<script setup lang="ts">
import type { SoftwareItem } from '@/types'
import AppCard from './AppCard.vue'

withDefaults(
  defineProps<{
    items: SoftwareItem[]
    view?: 'grid' | 'list'
    unusedDays?: number
    selectable?: boolean
    selectedIds?: Set<string>
    locked?: boolean
  }>(),
  { view: 'grid', unusedDays: 60 }
)

defineEmits<{
  (e: 'open', id: string): void
  (e: 'launch', id: string): void
  (e: 'select', id: string): void
}>()
</script>

<template>
  <div class="grid" :class="`grid--${view}`">
    <AppCard
      v-for="(item, i) in items"
      :key="item.id"
      class="card-in"
      :style="{ '--i': Math.min(i, 20) }"
      :item="item"
      :view="view"
      :unused-days="unusedDays"
      :selectable="selectable"
      :selected="selectedIds?.has(item.id)"
      :locked="locked"
      @open="$emit('open', $event)"
      @launch="$emit('launch', $event)"
      @select="$emit('select', $event)"
    />
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  gap: var(--gap-card);
  align-content: start;
}

.grid--grid {
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}

.grid--list {
  grid-template-columns: 1fr;
  gap: 8px;
}
</style>
