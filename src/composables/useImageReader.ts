import { nextTick, shallowRef } from 'vue'
import type { ImageItem, ImagePage } from '@/types/image'
import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'

export interface ImageReaderSession {
  item: ImageItem
  pages: ImagePage[]
  startId: string
  siblings: ImageItem[]
}

const session = shallowRef<ImageReaderSession | null>(null)
let trigger: HTMLElement | null = null
let switching = false

export function useImageReader() {
  return {
    session,
    open(item: ImageItem, pages: ImagePage[], startId = '', siblings: ImageItem[] = []) {
      if (!pages.length) return
      if (!session.value) trigger = document.activeElement as HTMLElement | null
      session.value = { item, pages, startId, siblings }
    },
    async switchSibling(delta: -1 | 1): Promise<boolean> {
      const cur = session.value
      if (!cur || !cur.siblings.length || switching) return false
      const idx = cur.siblings.findIndex(s => s.id === cur.item.id)
      const nextItem = idx >= 0 ? cur.siblings[idx + delta] : undefined
      if (!nextItem) return false
      switching = true
      try {
        const fresh = (await window.baoyi.image.get(nextItem.id)) || nextItem
        const nextPages = await window.baoyi.image.pages(fresh.id)
        if (!nextPages.length) return false
        const targetStart = delta < 0 ? nextPages.at(-1)!.id : nextPages[0].id
        session.value = { item: fresh, pages: nextPages, startId: targetStart, siblings: cur.siblings }
        return true
      } catch (cause) {
        useToast().error(errorMessage(cause))
        return false
      } finally {
        switching = false
      }
    },
    async close() {
      session.value = null
      await nextTick()
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
      trigger = null
    },
  }
}
