import { onBeforeUnmount, onMounted, ref } from 'vue'

export interface UseFileDropOptions {
  disabled?: () => boolean
}

function hasDroppedFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  return !!types && Array.from(types).includes('Files')
}

export function extractDroppedPaths(event: DragEvent): string[] {
  const files = event.dataTransfer?.files
  if (!files || files.length === 0) return []
  const resolver = window.baoyi?.app?.pathForFile
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const raw =
      typeof resolver === 'function'
        ? resolver(file)
        : ((file as File & { path?: string }).path ?? '')
    const normalized = raw.trim()
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

export function useFileDrop(
  onDropPaths: (paths: string[]) => void | Promise<void>,
  options: UseFileDropOptions = {}
) {
  const dragging = ref(false)
  let depth = 0

  function isDisabled(): boolean {
    if (options.disabled?.()) return true
    if (
      typeof document !== 'undefined' &&
      document.querySelector('dialog[open], [role="dialog"], .im-overlay, .pj-dialog-backdrop, .image-reader')
    ) {
      return true
    }
    return false
  }

  function reset(): void {
    depth = 0
    dragging.value = false
  }

  function onDragEnter(event: DragEvent): void {
    if (!hasDroppedFiles(event) || isDisabled()) return
    event.preventDefault()
    depth++
    dragging.value = true
  }

  function onDragOver(event: DragEvent): void {
    if (!hasDroppedFiles(event) || isDisabled()) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    dragging.value = true
  }

  function onDragLeave(event: DragEvent): void {
    if (!dragging.value) return
    event.preventDefault()
    const cur = event.currentTarget as HTMLElement | null
    const rel = event.relatedTarget as Node | null
    if (!rel || (cur && !cur.contains(rel))) {
      reset()
      return
    }
    depth = Math.max(0, depth - 1)
    if (depth === 0) dragging.value = false
  }

  function onDrop(event: DragEvent): void {
    if (!hasDroppedFiles(event)) return
    const disabled = isDisabled()
    reset()
    if (disabled) return
    event.preventDefault()
    const paths = extractDroppedPaths(event)
    if (paths.length > 0) {
      void onDropPaths(paths)
    }
  }

  onMounted(() => {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('blur', reset)
      window.addEventListener('dragend', reset)
    }
  })

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('blur', reset)
      window.removeEventListener('dragend', reset)
    }
  })

  return {
    dragging,
    dropHandlers: {
      dragenter: onDragEnter,
      dragover: onDragOver,
      dragleave: onDragLeave,
      drop: onDrop
    }
  }
}
