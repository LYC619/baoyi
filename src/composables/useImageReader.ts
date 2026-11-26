import { nextTick, shallowRef } from 'vue'
import type { ImageItem, ImagePage } from '@/types/image'
import { latestOnly, STALE } from '@/composables/latestOnly'
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
let activeSwitch: Promise<unknown> | null = null

const loadSibling = latestOnly(async (nextItem: ImageItem | null) => {
  if (!nextItem) return null
  const fresh = (await window.baoyi.image.get(nextItem.id)) || nextItem
  const nextPages = await window.baoyi.image.pages(fresh.id)
  return { fresh, nextPages }
})

export function useImageReader() {
  return {
    session,
    open(item: ImageItem, pages: ImagePage[], startId = '', siblings: ImageItem[] = []) {
      if (!pages.length) return
      void loadSibling(null)
      activeSwitch = null
      if (!session.value) trigger = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
      session.value = { item, pages, startId, siblings }
    },
    async switchSibling(delta: -1 | 1): Promise<boolean> {
      const cur = session.value
      if (!cur || !cur.siblings.length || activeSwitch) return false
      const idx = cur.siblings.findIndex(s => s.id === cur.item.id)
      const nextItem = idx >= 0 ? cur.siblings[idx + delta] : undefined
      if (!nextItem) return false
      const task = loadSibling(nextItem)
      activeSwitch = task
      try {
        const result = await task
        if (result === STALE || !result || session.value !== cur) return false
        if (!result.nextPages.length) return false
        const targetStart = delta < 0 ? result.nextPages.at(-1)!.id : result.nextPages[0].id
        session.value = { item: result.fresh, pages: result.nextPages, startId: targetStart, siblings: cur.siblings }
        return true
      } catch (cause) {
        if (session.value === cur) useToast().error(errorMessage(cause))
        return false
      } finally {
        if (activeSwitch === task) activeSwitch = null
      }
    },
    async close() {
      void loadSibling(null)
      activeSwitch = null
      session.value = null
      await nextTick()
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
      trigger = null
    },
  }
}
