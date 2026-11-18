import type { Ref } from 'vue'
import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'

/** Native file actions shared by detail pages and individual video assets. */
export function useResourcePaths<A extends unknown[]>(options: {
  reveal: (...args: A) => Promise<void | boolean>
  copied?: string
  copyTone?: 'toast' | 'success'
  copyErrorPrefix?: string
}) {
  const toast = useToast()
  async function copyPath(path: string): Promise<void> {
    try {
      await window.baoyi.app.copyText(path)
      toast[options.copyTone ?? 'toast'](options.copied ?? '路径已复制')
    } catch (cause) {
      toast.error((options.copyErrorPrefix ?? '复制失败：') + errorMessage(cause))
    }
  }
  async function reveal(...args: A): Promise<void> {
    try {
      if (await options.reveal(...args) === false) toast.error('文件位置不可用，请检查磁盘是否在线')
    } catch (cause) {
      toast.error(errorMessage(cause))
    }
  }
  return { copyPath, reveal }
}

interface Resource { id: string; tags: string[]; is_archived: boolean }
export function useResourceDetail<T extends Resource>(options: {
  item: Ref<T | null>
  update: (item: T, patch: Partial<T>) => Promise<T | null>
  reveal: (id: string) => Promise<void | boolean>
  parseTags?: (raw: string) => string[]
  archivedMessage?: (archived: boolean) => string
}) {
  const { item } = options
  const { success, error } = useToast()
  const paths = useResourcePaths({ reveal: options.reveal })
  async function save(patch: Partial<T>): Promise<T | null> {
    if (!item.value) return null
    try {
      const updated = await options.update(item.value, patch)
      if (updated) item.value = updated
      return updated
    } catch (cause) {
      error(`保存失败：${errorMessage(cause)}`)
      return null
    }
  }
  function commitTags(raw: string): void {
    const tags = options.parseTags ? options.parseTags(raw)
      : [...new Set(raw.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean))].slice(0, 8)
    void save({ tags } as Partial<T>)
  }
  async function toggleArchive(): Promise<void> {
    if (!item.value) return
    const archived = !item.value.is_archived
    if (await save({ is_archived: archived } as Partial<T>) && options.archivedMessage) {
      success(options.archivedMessage(archived))
    }
  }
  async function reveal(): Promise<void> {
    if (item.value) await paths.reveal(item.value.id)
  }
  return { save, commitTags, toggleArchive, reveal, copyPath: paths.copyPath }
}
