import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Category } from '@/types'

export const useCategoriesStore = defineStore('categories', () => {
  const list = ref<Category[]>([])

  async function load(): Promise<void> {
    list.value = await window.baoyi.categories.list()
  }

  async function upsert(category: Category): Promise<void> {
    list.value = await window.baoyi.categories.upsert(category)
  }

  async function remove(id: string): Promise<void> {
    list.value = await window.baoyi.categories.remove(id)
  }

  /** 按分类名取图标，找不到就用通用图标 */
  function iconOf(name: string): string {
    return list.value.find((c) => c.name === name)?.icon || 'box'
  }

  return { list, load, upsert, remove, iconOf }
})
