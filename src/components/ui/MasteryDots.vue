<script setup lang="ts">
import { computed } from 'vue'
import type { MasteryLevel } from '@/types'
import { MASTERY_META } from '@/utils'

const props = withDefaults(
  defineProps<{ level: MasteryLevel; showLabel?: boolean; size?: number }>(),
  { showLabel: true, size: 6 }
)

const meta = computed(() => MASTERY_META[props.level])
</script>

<template>
  <div class="mastery" :title="`掌握度：${meta.label}`">
    <span class="mastery__dots" :style="{ '--dot': `${size}px` }">
      <i v-for="n in 3" :key="n" :class="{ on: n <= meta.dots }" />
    </span>
    <span v-if="showLabel" class="mastery__label">{{ meta.label }}</span>
  </div>
</template>

<style scoped>
.mastery {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.mastery__dots {
  display: inline-flex;
  gap: 3px;
}

.mastery__dots i {
  width: var(--dot);
  height: var(--dot);
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-sub) 30%, transparent);
  transition: background var(--t-fast) ease;
}

.mastery__dots i.on {
  background: var(--success);
}

.mastery__label {
  font-size: var(--fs-tag);
  color: var(--text-sub);
}
</style>
