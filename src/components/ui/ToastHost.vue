<script setup lang="ts">
import { useToast } from '@/composables/useToast'

const { toasts } = useToast()
</script>

<template>
  <div class="toast-host">
    <TransitionGroup name="fade">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="`toast--${t.tone}`">
        {{ t.text }}
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 100;
  pointer-events: none;
}

.toast {
  padding: 9px 16px;
  border-radius: var(--radius-btn);
  background: var(--bg-elevated);
  border: 1px solid var(--divider);
  box-shadow: var(--shadow-pop);
  font-size: var(--fs-body);
  color: var(--text-main);
  max-width: 520px;
}

.toast--success {
  border-color: color-mix(in srgb, var(--success) 40%, transparent);
  color: var(--success);
}

.toast--error {
  border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  color: var(--danger);
}
</style>
