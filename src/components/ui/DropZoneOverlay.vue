<script setup lang="ts">
import { FolderInput } from 'lucide-vue-next'

defineProps<{
  active: boolean
  title: string
  hint?: string
}>()
</script>

<template>
  <Transition name="fade">
    <div v-if="active" class="drop-zone-overlay" role="status" aria-live="polite">
      <div class="drop-zone-overlay__card">
        <FolderInput :size="30" class="drop-zone-overlay__icon" />
        <strong class="drop-zone-overlay__title">{{ title }}</strong>
        <p v-if="hint" class="drop-zone-overlay__hint">{{ hint }}</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.drop-zone-overlay {
  position: fixed;
  inset: var(--titlebar-h, 40px) 12px 12px 12px;
  z-index: 90;
  display: grid;
  place-items: center;
  border-radius: var(--radius-card);
  border: 1.5px dashed var(--accent);
  background: color-mix(in srgb, var(--bg-main) 78%, transparent);
  backdrop-filter: blur(4px);
  pointer-events: none;
}

.drop-zone-overlay__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 32px;
  border-radius: var(--radius-card);
  background: var(--bg-elevated);
  border: 1px solid var(--divider-strong);
  box-shadow: var(--shadow-pop);
  text-align: center;
}

.drop-zone-overlay__icon {
  color: var(--accent);
}

.drop-zone-overlay__title {
  font-size: var(--fs-h3);
  font-weight: 600;
  color: var(--text-main);
}

.drop-zone-overlay__hint {
  margin: 0;
  font-size: var(--fs-tag);
  color: var(--text-sub);
  max-width: 340px;
  line-height: 1.6;
}
</style>
