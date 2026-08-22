import { ref } from 'vue'

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'error'
}

const toasts = ref<Toast[]>([])
let seq = 0

export function useToast() {
  function push(text: string, tone: Toast['tone'] = 'info', duration = 2600): void {
    const id = ++seq
    toasts.value.push({ id, text, tone })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, duration)
  }

  return {
    toasts,
    toast: push,
    success: (text: string) => push(text, 'success'),
    error: (text: string) => push(text, 'error', 3600)
  }
}
