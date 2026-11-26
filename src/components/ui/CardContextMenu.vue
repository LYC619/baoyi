<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

export interface ContextMenuItem {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  separatorBefore?: boolean
  onSelect: () => void | Promise<void>
}

defineProps<{
  label: string
  items: ContextMenuItem[]
}>()

const anchor = ref<HTMLElement>()
const popover = ref<HTMLElement>()
const group = ref<HTMLElement>()
let priorFocus: HTMLElement | null = null
let openedFromKeyboard = false

function clampToViewport() {
  const el = popover.value
  const pt = anchor.value
  if (!el || !pt || CSS.supports('position-area: block-end')) return
  const rect = el.getBoundingClientRect()
  const baseX = parseFloat(pt.style.left || '0')
  const baseY = parseFloat(pt.style.top || '0')
  const maxX = Math.max(8, window.innerWidth - rect.width - 8)
  const maxY = Math.max(8, window.innerHeight - rect.height - 8)
  const x = baseX + rect.width > window.innerWidth - 8 ? Math.max(8, baseX - rect.width) : Math.min(baseX, maxX)
  const y = baseY + rect.height > window.innerHeight - 8 ? Math.max(8, baseY - rect.height) : Math.min(baseY, maxY)
  el.style.left = `${x}px`
  el.style.top = `${y}px`
}

async function openAt(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  const el = popover.value
  const pt = anchor.value
  if (!el || !pt) return
  priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  openedFromKeyboard = event.button === 0 && event.clientX === 0 && event.clientY === 0
  let x = event.clientX
  let y = event.clientY
  if (openedFromKeyboard && priorFocus) {
    const r = priorFocus.getBoundingClientRect()
    x = r.left + 12
    y = r.bottom + 4
  }
  pt.style.left = `${x}px`
  pt.style.top = `${y}px`
  if (el.matches(':popover-open')) el.hidePopover()
  ;(el as HTMLElement & { showPopover: (opts?: { source?: HTMLElement }) => void }).showPopover({ source: pt })
  await nextTick()
  syncFocusGroupFallback()
  clampToViewport()
  if (openedFromKeyboard) {
    group.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }
}

function closeMenu(fromPointer = false) {
  const el = popover.value
  if (!el?.matches(':popover-open')) return
  if (priorFocus && document.contains(priorFocus)) {
    priorFocus.focus({ preventScroll: true, ...(fromPointer ? ({ focusVisible: false } as FocusOptions) : {}) })
  }
  el.hidePopover()
}

function selectItem(item: ContextMenuItem, event: MouseEvent) {
  if (item.disabled) return
  const fromPointer = event.detail > 0
  closeMenu(fromPointer)
  void item.onSelect()
}

function onPointerMove(event: PointerEvent) {
  const btn = (event.target as HTMLElement)?.closest('button')
  if (btn && !btn.disabled && group.value?.contains(btn)) {
    btn.focus({ preventScroll: true, ...({ focusVisible: false } as FocusOptions) })
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    event.preventDefault()
    closeMenu(false)
    return
  }
  if (event.key === 'Tab') {
    closeMenu(false)
    return
  }
  if (!group.value) return
  if ('focusGroup' in HTMLElement.prototype && !['Home', 'End'].includes(event.key)) return
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const buttons = [...group.value.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  if (!buttons.length) return
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  let next = 0
  if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = buttons.length - 1
  else if (current < 0) next = event.key === 'ArrowUp' ? buttons.length - 1 : 0
  else next = (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
  event.preventDefault()
  event.stopPropagation()
  buttons[next]?.focus({ preventScroll: true })
}

function syncFocusGroupFallback() {
  const el = group.value
  if (!el || 'focusGroup' in HTMLElement.prototype) return
  el.setAttribute('role', 'menu')
  el.querySelectorAll('button:not([role])').forEach((btn) => btn.setAttribute('role', 'menuitem'))
}

function onFocusIn(event: FocusEvent) {
  if (!popover.value?.matches(':popover-open')) return
  const target = event.target as Node | null
  if (target && !popover.value.contains(target)) {
    popover.value.hidePopover()
  }
}

onMounted(() => {
  syncFocusGroupFallback()
  document.addEventListener('focusin', onFocusIn)
})

onBeforeUnmount(() => {
  document.removeEventListener('focusin', onFocusIn)
})

defineExpose({ openAt, closeMenu })
</script>

<template>
  <span ref="anchor" class="ctx-anchor" aria-hidden="true" />
  <div ref="popover" class="ctx-popover" popover="auto" @keydown="onKeydown" @pointermove="onPointerMove">
    <div ref="group" class="ctx-menu" v-bind="{ focusgroup: 'menu nomemory' }" :aria-label="label">
      <template v-for="item in items" :key="item.id">
        <hr v-if="item.separatorBefore" class="ctx-sep" />
        <button
          type="button"
          class="ctx-item"
          :class="{ 'ctx-item--danger': item.danger }"
          :disabled="item.disabled"
          :role="item.checked !== undefined ? 'menuitemcheckbox' : undefined"
          :aria-checked="item.checked !== undefined ? item.checked : undefined"
          @click="selectItem(item, $event)"
        >
          <span class="ctx-label">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ctx-anchor {
  position: fixed;
  width: 0;
  height: 0;
  pointer-events: none;
}
.ctx-popover {
  padding: 5px;
  min-width: 168px;
  max-width: 240px;
  border-radius: var(--radius-card);
  border: 1px solid var(--divider-strong);
  background: var(--bg-elevated);
  color: var(--text-main);
  box-shadow: var(--shadow-pop);
}
@supports (position-area: block-end) {
  .ctx-popover {
    inset: auto;
    margin: 0;
    position-area: block-end span-inline-end;
    position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;
  }
}
@supports not (position-area: block-end) {
  .ctx-popover {
    position: fixed;
    inset: auto;
    margin: 0;
  }
}
.ctx-menu {
  --menu-icon-size: 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ctx-sep {
  border: 0;
  border-top: 1px solid var(--divider);
  margin: 4px 2px;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding: 4px 10px 4px 8px;
  border-radius: 6px;
  font-size: var(--fs-body);
  color: var(--text-main);
  text-align: left;
}
.ctx-item::before {
  content: '';
  flex: none;
  inline-size: var(--menu-icon-size);
  text-align: center;
  color: var(--accent);
  font-size: 12px;
}
.ctx-item[aria-checked='true']::before {
  content: '✓';
}
.ctx-item:hover:not(:disabled),
.ctx-item:focus-visible:not(:disabled) {
  background: var(--hover-surface);
  outline: none;
}
.ctx-item--danger {
  color: var(--danger);
}
.ctx-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ctx-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
