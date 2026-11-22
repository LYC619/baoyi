import { ref } from 'vue'

export interface ConfirmDialogOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  tone?: 'default' | 'danger'
}

export interface PromptDialogOptions {
  title: string
  message?: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
  cancelText?: string
}

export interface ActiveDialogState {
  id: number
  kind: 'confirm' | 'prompt'
  title: string
  message: string
  confirmText: string
  cancelText: string
  tone: 'default' | 'danger'
  inputValue: string
  placeholder: string
  resolve: (result: any) => void
}

const activeDialog = ref<ActiveDialogState | null>(null)
const queue: ActiveDialogState[] = []
let seq = 0
let hostMounted = false

const initialWindowConfirm =
  typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm : null

function pumpQueue(): void {
  if (!activeDialog.value && queue.length > 0) {
    activeDialog.value = queue.shift()!
  }
}

export function setDialogHostMounted(mounted: boolean): void {
  hostMounted = mounted
  if (!mounted) {
    if (activeDialog.value) {
      const current = activeDialog.value
      activeDialog.value = null
      current.resolve(current.kind === 'prompt' ? null : false)
    }
    while (queue.length > 0) {
      const item = queue.shift()!
      item.resolve(item.kind === 'prompt' ? null : false)
    }
  }
}

export function settleActiveDialog(confirmed: boolean, value?: string): void {
  const current = activeDialog.value
  if (!current) return
  activeDialog.value = null
  if (current.kind === 'prompt') {
    current.resolve(confirmed ? (value ?? current.inputValue) : null)
  } else {
    current.resolve(confirmed)
  }
  pumpQueue()
}

export function confirmDialog(options: string | ConfirmDialogOptions): Promise<boolean> {
  const normalized: ConfirmDialogOptions =
    typeof options === 'string' ? { title: '确认操作', message: options } : options
  const fallbackText = [normalized.title, normalized.message].filter(Boolean).join('\n\n')

  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    if (!hostMounted || (initialWindowConfirm && window.confirm !== initialWindowConfirm)) {
      return Promise.resolve(Boolean(window.confirm(fallbackText)))
    }
  } else if (!hostMounted) {
    const globalConfirm = (globalThis as { confirm?: (msg: string) => boolean }).confirm
    return Promise.resolve(typeof globalConfirm === 'function' ? Boolean(globalConfirm(fallbackText)) : false)
  }

  return new Promise<boolean>((resolve) => {
    queue.push({
      id: ++seq,
      kind: 'confirm',
      title: normalized.title,
      message: normalized.message ?? '',
      confirmText: normalized.confirmText ?? '确认',
      cancelText: normalized.cancelText ?? '取消',
      tone: normalized.tone ?? 'default',
      inputValue: '',
      placeholder: '',
      resolve
    })
    pumpQueue()
  })
}

export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
    if (!hostMounted) {
      return Promise.resolve(window.prompt(options.title, options.defaultValue ?? ''))
    }
  } else if (!hostMounted) {
    return Promise.resolve(null)
  }

  return new Promise<string | null>((resolve) => {
    queue.push({
      id: ++seq,
      kind: 'prompt',
      title: options.title,
      message: options.message ?? '',
      confirmText: options.confirmText ?? '确认',
      cancelText: options.cancelText ?? '取消',
      tone: 'default',
      inputValue: options.defaultValue ?? '',
      placeholder: options.placeholder ?? '',
      resolve
    })
    pumpQueue()
  })
}

export function useDialog() {
  return {
    activeDialog,
    confirmDialog,
    promptDialog
  }
}
