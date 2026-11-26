<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { footerHeight } from '@/composables/useFloatingDock'
import { useToast } from '@/composables/useToast'

const { toasts, dismiss, pause, resume } = useToast()
const hostEl = ref<HTMLElement | null>(null)
let lastMaxId = 0

function tryResume(id: number, cardEl: HTMLElement | null): void {
  if (cardEl && (cardEl.matches(':hover') || cardEl.contains(document.activeElement))) return
  resume(id)
}

function onToastMouseLeave(id: number, event: MouseEvent): void {
  tryResume(id, event.currentTarget as HTMLElement | null)
}

function onToastFocusOut(id: number, event: FocusEvent): void {
  const current = event.currentTarget as HTMLElement | null
  const next = event.relatedTarget as Node | null
  if (current && next && current.contains(next)) return
  tryResume(id, current)
}

function syncHideWhenEmpty(): void {
  if (toasts.value.length > 0) return
  const el = hostEl.value as (HTMLElement & { hidePopover?: () => void }) | null
  if (el && typeof el.hidePopover === 'function' && el.matches(':popover-open')) {
    try {
      el.hidePopover()
    } catch {
      /* best-effort */
    }
  }
}

watch(
  () => toasts.value.map((t) => t.id).join(','),
  async () => {
    await nextTick()
    const el = hostEl.value as (HTMLElement & {
      showPopover?: () => void
      hidePopover?: () => void
    }) | null
    if (!el || typeof el.showPopover !== 'function' || typeof el.hidePopover !== 'function') return
    if (toasts.value.length === 0) {
      // Fallback if CSS transitions are disabled; otherwise @after-leave hides cleanly
      if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        syncHideWhenEmpty()
      } else {
        setTimeout(syncHideWhenEmpty, 220)
      }
      return
    }
    const maxId = Math.max(...toasts.value.map((t) => t.id))
    const addedNew = maxId > lastMaxId
    lastMaxId = maxId
    try {
      const hasOpenModal = typeof document !== 'undefined' && !!document.querySelector('dialog[open]')
      if (addedNew && hasOpenModal && el.matches(':popover-open')) {
        el.hidePopover()
      }
      if (!el.matches(':popover-open')) {
        el.showPopover()
      }
    } catch {
      /* best-effort */
    }
  },
  { immediate: true }
)
</script>

<template>
  <div
    ref="hostEl"
    popover="manual"
    role="region"
    :aria-label="$t('系统提示')"
    class="toast-host"
    :style="{ bottom: (footerHeight + 20) + 'px' }"
  >
    <TransitionGroup name="fade" @after-leave="syncHideWhenEmpty">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="`toast--${t.tone}`"
        @mouseenter="pause(t.id)"
        @mouseleave="onToastMouseLeave(t.id, $event)"
        @focusin="pause(t.id)"
        @focusout="onToastFocusOut(t.id, $event)"
      >
        <span class="toast__text" :role="t.tone === 'error' ? 'alert' : 'status'">{{ $systemMessage(t.text) }}</span>
        <button
          type="button"
          class="toast__close"
          :aria-label="$t('关闭提示')"
          @click="dismiss(t.id)"
        >
          <X :size="13" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  inset: auto 0 20px 0;
  margin: 0 auto;
  width: fit-content;
  max-width: calc(100vw - 32px);
  padding: 0;
  border: 0;
  background: transparent;
  overflow: visible;
  z-index: 200;
  pointer-events: none;
}

.toast-host:popover-open {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.toast {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px 9px 16px;
  border-radius: var(--radius-btn);
  background: var(--bg-elevated);
  border: 1px solid var(--divider-strong);
  box-shadow: var(--shadow-pop);
  font-size: var(--fs-body);
  color: var(--text-main);
  max-width: 540px;
  pointer-events: auto;
}

.toast__text {
  min-inline-size: 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.toast__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  color: var(--text-faint);
  background: transparent;
  border: 0;
  cursor: pointer;
}

.toast__close:hover,
.toast__close:focus-visible {
  color: var(--text-main);
  background: var(--hover-surface);
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
