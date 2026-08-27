import { computed } from 'vue'
import type { MasteryLevel, SoftwareQuery } from '@/types'
import { useSettingsStore } from '@/stores/settings'
import { useSoftwareStore } from '@/stores/software'
import { MASTERY_META, MASTERY_ORDER } from '@/utils'

export const SORT_OPTIONS: Array<{ value: NonNullable<SoftwareQuery['sort']>; label: string }> = [
  { value: 'recent', label: '最近使用' },
  { value: 'count', label: '使用最多' },
  { value: 'name', label: '名称' },
  { value: 'added', label: '最近添加' }
]

export const MASTERY_OPTIONS = MASTERY_ORDER.map((value) => ({
  value,
  label: MASTERY_META[value].label
}))

export function useFilter() {
  const store = useSoftwareStore()
  const settings = useSettingsStore()

  const viewMode = computed(() => settings.settings.view_mode)
  const groupByCategory = computed(() => settings.settings.group_by_category)

  function setMastery(value: MasteryLevel | ''): void {
    store.mastery = store.mastery === value ? '' : value
    void store.load()
  }

  function setSort(value: NonNullable<SoftwareQuery['sort']>): void {
    store.sort = value
    void store.load()
  }

  async function setViewMode(value: 'grid' | 'list'): Promise<void> {
    await settings.patch({ view_mode: value })
  }

  /** 分组只改排布，不改查询 —— 卡片还是那一批，不用重新 load */
  async function toggleGroupByCategory(): Promise<void> {
    await settings.patch({ group_by_category: !settings.settings.group_by_category })
  }

  const hasActiveFilter = computed(
    () => Boolean(store.mastery) || Boolean(store.keyword.trim())
  )

  function resetFilters(): void {
    store.mastery = ''
    store.keyword = ''
    void store.load()
  }

  return {
    viewMode,
    setViewMode,
    groupByCategory,
    toggleGroupByCategory,
    setMastery,
    setSort,
    resetFilters,
    hasActiveFilter,
    sortOptions: SORT_OPTIONS,
    masteryOptions: MASTERY_OPTIONS
  }
}
