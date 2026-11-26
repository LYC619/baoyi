import { ref } from 'vue'

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'error'
}

interface ToastTimerState {
  remaining: number
  startedAt: number
  timer: ReturnType<typeof setTimeout> | null
}

const toasts = ref<Toast[]>([])
const timers = new Map<number, ToastTimerState>()
let seq = 0

function scheduleDismiss(id: number): void {
  const state = timers.get(id)
  if (!state || state.timer) return
  state.startedAt = Date.now()
  state.timer = setTimeout(() => {
    dismissToast(id)
  }, Math.max(120, state.remaining))
}

export function dismissToast(id: number): void {
  const state = timers.get(id)
  if (state?.timer) clearTimeout(state.timer)
  timers.delete(id)
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

export function pauseToast(id: number): void {
  const state = timers.get(id)
  if (!state || !state.timer) return
  clearTimeout(state.timer)
  state.timer = null
  state.remaining = Math.max(600, state.remaining - (Date.now() - state.startedAt))
}

export function resumeToast(id: number): void {
  scheduleDismiss(id)
}

export function useToast() {
  function push(text: string, tone: Toast['tone'] = 'info', duration = 2600): void {
    const id = ++seq
    toasts.value.push({ id, text, tone })
    timers.set(id, {
      remaining: duration,
      startedAt: Date.now(),
      timer: null
    })
    scheduleDismiss(id)
  }

  return {
    toasts,
    toast: push,
    dismiss: dismissToast,
    pause: pauseToast,
    resume: resumeToast,
    success: (text: string) => push(text, 'success'),
    error: (text: string) => push(text, 'error', 3600)
  }
}
