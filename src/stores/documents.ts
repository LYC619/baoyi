import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { workspace } from '@/utils/workspace-api'
import type {
  DocumentItem,
  DocumentCategory,
  DocumentCustomGroup,
  DocumentSubmodule,
  DocumentProjectReference,
} from '@/types/workspace'

export const useDocumentsStore = defineStore('documents', () => {
  const items = ref<DocumentItem[]>([]),
    search = ref(''),
    searchAll = ref(false),
    submodule = ref<DocumentSubmodule>('reading'),
    type = ref(''),
    state = ref(''),
    tag = ref(''),
    sort = ref('updated'),
    view = ref<'list' | 'grid' | 'insights'>('grid'),
    favorite = ref(false),
    sourceDir = ref(''),
    collapsed = ref<string[]>([]),
    customGroupId = ref(''),
    groupBy = ref<'none' | 'category' | 'source' | 'custom' | 'tag'>('none'),
    cardSize = ref(160),
    selected = ref(''),
    error = ref('')

  const categories = ref<DocumentCategory[]>([])
  const customGroups = ref<DocumentCustomGroup[]>([])
  const projectReferences = ref<DocumentProjectReference[]>([])

  interface SubmoduleMemory {
    search: string
    searchAll: boolean
    favorite: boolean
    sourceDir: string
    collapsed: string[]
    type: string
    state: string
    tag: string
    sort: string
    view: 'list' | 'grid' | 'insights'
    customGroupId: string
    groupBy: 'none' | 'category' | 'source' | 'custom' | 'tag'
    cardSize: number
    scroll: number
  }

  const memory: Record<DocumentSubmodule, SubmoduleMemory> = {
    reading: { search: '', searchAll: false, favorite: false, sourceDir: '', collapsed: [], type: '', state: '', tag: '', sort: 'updated', view: 'grid', customGroupId: '', groupBy: 'none', cardSize: 190, scroll: 0 },
    archive: { search: '', searchAll: false, favorite: false, sourceDir: '', collapsed: [], type: '', state: '', tag: '', sort: 'updated', view: 'list', customGroupId: '', groupBy: 'none', cardSize: 190, scroll: 0 },
  }
  const memoryKey = 'baoyi.document.views.v1'
  try {
    const saved = JSON.parse(localStorage.getItem(memoryKey) || 'null')
    if (saved) {
      for (const key of ['reading', 'archive'] as const) {
        const value = saved.memory?.[key]
        if (value && ['list', 'grid', 'insights'].includes(value.view) && ['none', 'category', 'source', 'custom', 'tag'].includes(value.groupBy)) memory[key] = { ...memory[key], ...value }
      }
      if (saved.submodule === 'archive') submodule.value = 'archive'
    }
  } catch { /* 偏好缺失或无法解析时使用当前默认视图。 */ }
  function persist() {
    try { localStorage.setItem(memoryKey, JSON.stringify({ submodule: submodule.value, memory })) } catch (cause) { useToast().error(errorMessage(cause)) }
  }

  const currentCategories = computed(() =>
    categories.value.filter(c => c.submodule === submodule.value)
  )

  const currentCustomGroups = computed(() =>
    customGroups.value.filter(g => {
      if (g.submodule !== submodule.value) return false
      if (type.value && g.categoryId && g.categoryId !== type.value) return false
      return true
    })
  )

  function saveCurrentMemory(scrollOffset?: number) {
    const cur = submodule.value
    memory[cur] = {
      type: type.value,
      search: search.value,
      searchAll: searchAll.value,
      favorite: favorite.value,
      sourceDir: sourceDir.value,
      collapsed: [...collapsed.value],
      state: state.value,
      tag: tag.value,
      sort: sort.value,
      view: view.value,
      customGroupId: customGroupId.value,
      groupBy: groupBy.value,
      cardSize: cardSize.value,
      scroll: scrollOffset ?? memory[cur].scroll,
    }
    persist()
  }

  function switchSubmodule(target: DocumentSubmodule, currentScroll = 0) {
    if (target === submodule.value) { resetFilters(); validateFilters(); persist(); return }
    saveCurrentMemory(currentScroll)
    submodule.value = target
    restoreMemory(target)
    // 切换阅读与资料时保留各自已选筛选，仅在同分栏再次点击时清空筛选回到全部
    validateFilters()
    persist()
  }
  function restoreMemory(target: DocumentSubmodule) {
    const restored = memory[target]
    search.value = restored.search
    searchAll.value = restored.searchAll
    favorite.value = restored.favorite
    sourceDir.value = restored.sourceDir
    collapsed.value = [...restored.collapsed]
    type.value = restored.type
    // State is now an editable tag; discard the old hidden state-only filter.
    state.value = ''
    tag.value = restored.tag
    sort.value = restored.sort
    view.value = restored.view
    customGroupId.value = restored.customGroupId
    groupBy.value = restored.groupBy
    cardSize.value = restored.cardSize
  }
  restoreMemory(submodule.value)
  watch([type, state, tag, search, searchAll, favorite, sourceDir, sort, view, customGroupId, groupBy, cardSize, collapsed], () => saveCurrentMemory(), { deep: true })
  function resetFilters() {
    type.value = ''; state.value = ''; tag.value = ''; search.value = ''; searchAll.value = false; favorite.value = false; sourceDir.value = ''; customGroupId.value = ''
  }
  function validateFilters() {
    for (const key of ['reading', 'archive'] as const) {
      if (memory[key].type && !categories.value.some(c => c.id === memory[key].type && c.submodule === key)) memory[key].type = ''
      if (memory[key].customGroupId && !customGroups.value.some(g => g.id === memory[key].customGroupId && g.submodule === key)) memory[key].customGroupId = ''
    }
    if (type.value && !currentCategories.value.some(c => c.id === type.value)) type.value = ''
    if (customGroupId.value && !currentCustomGroups.value.some(g => g.id === customGroupId.value)) customGroupId.value = ''
  }
  function toggleSection(key: string) {
    collapsed.value = collapsed.value.includes(key) ? collapsed.value.filter(k => k !== key) : [...collapsed.value, key]
  }

  function getSavedScroll(sub: DocumentSubmodule): number {
    return memory[sub]?.scroll || 0
  }

  function setSavedScroll(sub: DocumentSubmodule, offset: number) {
    if (memory[sub]) memory[sub].scroll = offset
  }

  let revision = 0
  async function refresh() {
    const run = ++revision
    try {
      const [value, types, groups] = await Promise.all([
        workspace.documents.list(),
        workspace.documents.categories(),
        workspace.documents.customGroups(),
      ])
      const references: DocumentProjectReference[] = []
      for (let start = 0; start < value.length; start += 500) {
        references.push(
          ...(await workspace.links.projectReferences(
            value.slice(start, start + 500).map((i) => i.id),
          )),
        )
        if (run !== revision) return
      }
      if (run === revision) {
        items.value = value
        categories.value = types
        customGroups.value = groups
        validateFilters()
        projectReferences.value = references
        if (type.value && !types.some((c) => c.id === type.value))
          type.value = ''
        if (customGroupId.value && !groups.some((g) => g.id === customGroupId.value))
          customGroupId.value = ''
        if (selected.value && !value.some((i) => i.id === selected.value))
          selected.value = ''
        error.value = ''
      }
    } catch (e) {
      if (run === revision) error.value = errorMessage(e)
    }
  }

  async function moveToSubmodule(id: string, targetSubmodule: DocumentSubmodule, targetCategoryId?: string) {
    await workspace.documents.moveToSubmodule(id, targetSubmodule, targetCategoryId)
    await refresh()
  }

  async function saveCustomGroup(input: { id?: string; submodule: DocumentSubmodule; categoryId?: string; name: string; sortOrder?: number }) {
    const res = await workspace.documents.saveCustomGroup(input)
    await refresh()
    return res
  }

  async function removeCustomGroup(id: string) {
    await workspace.documents.removeCustomGroup(id)
    await refresh()
  }

  workspace.onChanged(() => void refresh())
  window.baoyi.project.onChanged(() => void refresh())

  return {
    items,
    categories,
    currentCategories,
    customGroups,
    currentCustomGroups,
    projectReferences,
    submodule,
    search,
    searchAll,
    type,
    state,
    tag,
    sort,
    view,
    favorite,
    sourceDir,
    collapsed,
    resetFilters,
    toggleSection,
    customGroupId,
    groupBy,
    cardSize,
    selected,
    error,
    refresh,
    switchSubmodule,
    saveCurrentMemory,
    getSavedScroll,
    setSavedScroll,
    moveToSubmodule,
    saveCustomGroup,
    removeCustomGroup,
  }
})
