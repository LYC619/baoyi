<script setup lang="ts">
import { Sparkles } from 'lucide-vue-next'
import { useArchiveAssistant } from '@/composables/useArchiveAssistant'
const assistant = useArchiveAssistant()
function open(text?: string) { void assistant.show(text) }
defineExpose({ open })
</script>
<template>
  <button type="button" class="personal-assistant-trigger" :aria-expanded="assistant.open.value" @click="open()">
    <Sparkles :size="15" />{{ assistant.busy.value ? '归档助理 · 处理中' : '与归档助理对话' }}
  </button>
</template>
<style scoped>
.personal-assistant-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 11px;
  margin-top: auto;
  border: 1px solid var(--divider);
  border-radius: 7px;
  font-size: 12px;
  color: var(--text-sub);
  background: var(--bg-card);
  text-align: left;
}
.personal-assistant-trigger:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
