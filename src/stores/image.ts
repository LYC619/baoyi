import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ImageGroup, ImageItem, ImageQuery } from '@/types/image'

export const useImageStore = defineStore('image', () => {
  const items = ref<ImageItem[]>([]), groups = ref<ImageGroup[]>([]), loading = ref(false), error = ref('')
  const query = ref<ImageQuery>({ type: 'comic', sort: 'updated' })
  let subscribed = false, revision = 0
  const count = computed(() => items.value.length)
  async function refresh(): Promise<void> {
    if (!window.baoyi?.image) return
    if (!subscribed) { subscribed = true; window.baoyi.image.onChanged(() => { void refresh() }) }
    const token = ++revision; loading.value = true
    try {
      const next = await window.baoyi.image.list()
      const types = await window.baoyi.image.groups()
      if (token !== revision) return
      items.value = next; groups.value = types; error.value = ''
    } catch (cause) { if (token === revision) error.value = (cause as Error).message }
    finally { if (token === revision) loading.value = false }
  }
  const shown = computed(() => {
    const q = query.value, needle = q.search?.trim().toLocaleLowerCase()
    return items.value.filter(i => (!q.type || i.type === q.type) && (!q.groupId || i.groupId === q.groupId) && (!q.favorite || i.favorite)
      && (!q.publication || i.publication === q.publication) && (!q.tag || i.tags.includes(q.tag)) && (!q.sourceDir || i.sourceDir===q.sourceDir)
      && (!needle || `${i.name} ${i.description} ${i.tags.join(' ')}`.toLocaleLowerCase().includes(needle)))
      .sort((a,b) => q.sort === 'name' ? a.name.localeCompare(b.name,'zh-CN',{ numeric:true }) : q.sort === 'read' ? (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0) : b.updatedAt-a.updatedAt)
  })
  return { items, groups, loading, error, count, query, shown, refresh }
})
