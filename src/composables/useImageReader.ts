import { nextTick, shallowRef } from 'vue'
import type { ImageItem, ImagePage } from '@/types/image'

const session = shallowRef<{ item: ImageItem; pages: ImagePage[]; startId: string } | null>(null)
let trigger: HTMLElement | null = null
export function useImageReader() {
  return {
    session,
    open(item: ImageItem, pages: ImagePage[], startId = '') {
      if (!pages.length) return
      trigger = document.activeElement as HTMLElement | null
      session.value = { item, pages, startId }
    },
    async close() {
      session.value = null
      await nextTick()
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
      trigger = null
    },
  }
}
