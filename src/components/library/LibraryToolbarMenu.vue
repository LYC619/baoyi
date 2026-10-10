<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

defineProps<{ label: string }>()
const id = useId(), open = ref(false)
const root = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>(), panel = ref<HTMLElement>()
function close(restoreFocus = true) {
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}
async function toggle() {
  if (open.value) { close(); return }
  open.value = true
  await nextTick()
  panel.value?.querySelector<HTMLElement>('button:not(:disabled), select, input')?.focus()
}
function outside(event: PointerEvent) {
  if (open.value && !root.value?.contains(event.target as Node)) close(false)
}
function action(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest('button')
  if (button && !button.disabled) close()
}
function key(event: KeyboardEvent) {
  if (open.value && event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close() }
}
function leave(event: FocusEvent) {
  if (event.relatedTarget && !root.value?.contains(event.relatedTarget as Node)) close(false)
}
onMounted(() => document.addEventListener('pointerdown', outside))
onUnmounted(() => document.removeEventListener('pointerdown', outside))
</script>

<template>
  <div ref="root" class="library-toolbar-menu" @focusout="leave" @keydown="key">
    <button ref="trigger" type="button" class="btn btn--subtle" :aria-expanded="open" :aria-controls="id" @click="toggle">{{label}}<ChevronDown :size="13"/></button>
    <div v-if="open" :id="id" ref="panel" class="toolbar-popover" role="group" :aria-label="label + '选项'" @click="action"><slot /></div>
  </div>
</template>

<style scoped>
.library-toolbar-menu{position:relative;flex:none}.toolbar-popover{position:absolute;right:0;top:calc(100% + 6px);z-index:30;display:flex;flex-direction:column;align-items:stretch;gap:10px;min-width:220px;max-width:calc(100vw - 32px);padding:12px;background:var(--bg-card);border:1px solid var(--divider);border-radius:8px;box-shadow:var(--shadow-pop);color:var(--text-main)}
.toolbar-popover :deep(label){display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px}.toolbar-popover :deep(button){justify-content:flex-start;text-align:left;white-space:normal}.toolbar-popover :deep(select){max-width:210px}.toolbar-popover :deep(input[type=range]){width:110px}.library-toolbar-menu :deep(:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
</style>
