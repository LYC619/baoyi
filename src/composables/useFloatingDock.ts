import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue'

const entries = reactive(new Map<string, { height: number; width: number; order: number }>())
export const drawerWidth = ref(0)
export const footerHeight = ref(0)
export const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1280)

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    viewportWidth.value = window.innerWidth
  })
}

export function useDockBoundary(element: Ref<HTMLElement | undefined>, kind: 'drawer' | 'footer', visible: () => boolean) {
  let observer: ResizeObserver | undefined
  const size = kind === 'drawer' ? drawerWidth : footerHeight
  watch(
    [element, visible],
    ([node, shown]) => {
      observer?.disconnect()
      size.value = 0
      if (node && shown) {
        const measure = () => {
          size.value = kind === 'drawer' ? node.getBoundingClientRect().width : node.getBoundingClientRect().height
        }
        observer = new ResizeObserver(measure)
        observer.observe(node)
        measure()
      }
    },
    { flush: 'post', immediate: true }
  )
  onBeforeUnmount(() => {
    observer?.disconnect()
    size.value = 0
  })
  return computed(() => (kind === 'drawer' ? { bottom: footerHeight.value + 'px' } : {}))
}

export function useFloatingDock(id: string, element: Ref<HTMLElement | undefined>, active: () => boolean, order: number) {
  let observer: ResizeObserver | undefined
  const resize = () => (viewportWidth.value = window.innerWidth)
  resize()
  window.addEventListener('resize', resize)
  watch(
    [element, active],
    ([node, shown]) => {
      observer?.disconnect()
      entries.delete(id)
      if (node && shown) {
        const measure = () => {
          const box = node.getBoundingClientRect()
          entries.set(id, { width: box.width, height: box.height, order })
        }
        observer = new ResizeObserver(measure)
        observer.observe(node)
        measure()
      }
    },
    { flush: 'post', immediate: true }
  )
  onBeforeUnmount(() => {
    observer?.disconnect()
    entries.delete(id)
    window.removeEventListener('resize', resize)
  })
  return computed(() => {
    const own = entries.get(id)
    const offset = [...entries.values()]
      .filter((entry) => entry.order < order)
      .reduce((sum, entry) => sum + entry.height + 10, 0)
    const fits = viewportWidth.value - drawerWidth.value - 48 >= (own?.width || 300)
    return {
      '--dock-right': drawerWidth.value + 24 + 'px',
      '--dock-bottom': footerHeight.value + 20 + offset + 'px',
      visibility: fits ? ('visible' as const) : ('hidden' as const)
    }
  })
}
