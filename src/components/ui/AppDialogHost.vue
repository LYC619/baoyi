<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { settleActiveDialog, setDialogHostMounted, useDialog } from '@/composables/useDialog'

const { activeDialog } = useDialog()
const dialogEl = ref<HTMLDialogElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const cancelBtnEl = ref<HTMLButtonElement | null>(null)
const confirmBtnEl = ref<HTMLButtonElement | null>(null)
const draftValue = ref('')

onMounted(() => {
  setDialogHostMounted(true)
})

onBeforeUnmount(() => {
  setDialogHostMounted(false)
})

let pendingProgrammaticCloses = 0

watch(
  () => activeDialog.value?.id,
  async (id) => {
    const el = dialogEl.value
    if (!id) {
      if (el?.open) {
        pendingProgrammaticCloses++
        el.close()
      }
      return
    }
    const state = activeDialog.value!
    draftValue.value = state.inputValue
    await nextTick()
    if (activeDialog.value?.id !== id) return
    const target = dialogEl.value
    if (target && !target.open) {
      target.returnValue = ''
      target.showModal()
    }
    if (state.kind === 'prompt') {
      inputEl.value?.select()
    }
  }
)

function onNativeClose() {
  const el = dialogEl.value
  const rv = el?.returnValue ?? ''
  if (el) el.returnValue = ''
  if (pendingProgrammaticCloses > 0) {
    pendingProgrammaticCloses--
    return
  }
  if (!activeDialog.value) return
  if (rv === 'confirm') {
    settleActiveDialog(true, draftValue.value)
  } else {
    settleActiveDialog(false)
  }
}

function submitForm() {
  if (!activeDialog.value) return
  const val = draftValue.value
  const el = dialogEl.value
  if (el?.open) {
    pendingProgrammaticCloses++
    el.close('confirm')
  }
  settleActiveDialog(true, val)
}

function cancelDialog() {
  if (!activeDialog.value) return
  const el = dialogEl.value
  if (el?.open) {
    pendingProgrammaticCloses++
    el.close('cancel')
  }
  settleActiveDialog(false)
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="app-dialog"
    :aria-labelledby="activeDialog ? `app-dialog-title-${activeDialog.id}` : undefined"
    @close="onNativeClose"
  >
    <form v-if="activeDialog" method="dialog" class="app-dialog__form" @submit.prevent="submitForm">
      <h2 :id="`app-dialog-title-${activeDialog.id}`" class="app-dialog__title">
        {{ $systemMessage(activeDialog.title) }}
      </h2>
      <p v-if="activeDialog.message" class="app-dialog__message">
        {{ $systemMessage(activeDialog.message) }}
      </p>
      <input
        v-if="activeDialog.kind === 'prompt'"
        ref="inputEl"
        v-model="draftValue"
        type="text"
        class="input app-dialog__input"
        :autofocus="true"
        :placeholder="$systemMessage(activeDialog.placeholder)"
        :aria-label="$systemMessage(activeDialog.title)"
      />
      <div class="app-dialog__actions">
        <button
          ref="cancelBtnEl"
          type="button"
          class="btn btn--ghost"
          data-dialog-cancel
          :autofocus="activeDialog.kind === 'confirm' && activeDialog.tone === 'danger' ? true : undefined"
          @click="cancelDialog"
        >
          {{ $systemMessage(activeDialog.cancelText) }}
        </button>
        <button
          ref="confirmBtnEl"
          type="submit"
          class="btn"
          data-dialog-confirm
          :class="activeDialog.tone === 'danger' ? 'btn--danger' : 'btn--primary'"
          :autofocus="activeDialog.kind === 'confirm' && activeDialog.tone !== 'danger' ? true : undefined"
        >
          {{ $systemMessage(activeDialog.confirmText) }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.app-dialog {
  padding: 0;
  border: 1px solid var(--divider-strong);
  border-radius: var(--radius-card);
  background: var(--bg-elevated);
  color: var(--text-main);
  box-shadow: var(--shadow-pop);
  width: min(440px, calc(100vw - 32px));
  max-width: 440px;
  margin: auto;
}

.app-dialog:modal {
  overscroll-behavior: contain;
}

.app-dialog::backdrop {
  background: var(--overlay);
  overflow: hidden;
  overscroll-behavior: contain;
}

.app-dialog[open] {
  display: block;
}

.app-dialog__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 22px 18px;
}

.app-dialog__title {
  margin: 0;
  font-size: var(--fs-h3);
  font-weight: 600;
  color: var(--text-main);
  line-height: 1.45;
}

.app-dialog__message {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--text-sub);
  line-height: 1.65;
  white-space: pre-line;
}

.app-dialog__input {
  width: 100%;
  margin-top: 2px;
}

.app-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
</style>
