import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type { MasteryLevel, SidebarCounts, SoftwareItem, SoftwareQuery, VirtualGroup } from '@/types'
import { plain } from '@/utils'
import { useSettingsStore } from './settings'

export type Selection = { kind: 'group' | 'category' | 'tag'; value: string }

const EMPTY_COUNTS: SidebarCounts = {
  all: 0,
  archived: 0,
  unused: 0,
  pending: 0,
  pending_units: 0,
  pending_confirm: 0,
  portable: 0,
  categories: [],
  tags: []
}

export const useSoftwareStore = defineStore('software', () => {
  const items = ref<SoftwareItem[]>([])
  const counts = ref<SidebarCounts>({ ...EMPTY_COUNTS })
  const loading = ref(false)

  const keyword = ref('')
  const mastery = ref<MasteryLevel | ''>('')
  const sort = ref<NonNullable<SoftwareQuery['sort']>>('recent')
  const selection = reactive<Selection>({ kind: 'group', value: 'all' })

  const activeKey = computed(() => `${selection.kind}:${selection.value}`)

  /** 还需要 AI 跑一遍的总量：待识别目录 + 待补全条目 */
  const todo = computed(() => counts.value.pending_units + counts.value.pending)

  const heading = computed(() => {
    if (selection.kind === 'category') return selection.value
    if (selection.kind === 'tag') return `# ${selection.value}`
    return { all: '全部', archived: '已归档', unused: '长期未用', pending: '待识别', portable: '绿色软件' }[
      selection.value as VirtualGroup
    ]
  })

  function buildQuery(): SoftwareQuery {
    const settings = useSettingsStore()
    const q: SoftwareQuery = {
      keyword: keyword.value.trim() || undefined,
      mastery: mastery.value || undefined,
      sort: sort.value,
      unused_days: settings.settings.unused_days
    }
    if (selection.kind === 'group') q.group = selection.value as VirtualGroup
    if (selection.kind === 'category') q.category = selection.value
    if (selection.kind === 'tag') q.tag = selection.value
    return q
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      items.value = await window.baoyi.software.list(buildQuery())
    } finally {
      loading.value = false
    }
  }

  async function refreshCounts(): Promise<void> {
    const settings = useSettingsStore()
    counts.value = await window.baoyi.software.counts(settings.settings.unused_days)
  }

  async function reload(): Promise<void> {
    await Promise.all([load(), refreshCounts()])
  }

  function select(next: Selection): void {
    Object.assign(selection, next)
    void load()
  }

  async function update(id: string, patch: Partial<SoftwareItem>): Promise<SoftwareItem | null> {
    const updated = await window.baoyi.software.update(id, plain(patch))
    if (updated) {
      const i = items.value.findIndex((x) => x.id === id)
      if (i >= 0) items.value[i] = updated
    }
    // 归档 / 改分类 / 改标签都会影响侧边栏计数
    void refreshCounts()
    return updated
  }

  async function remove(id: string): Promise<void> {
    await window.baoyi.software.remove(id)
    items.value = items.value.filter((x) => x.id !== id)
    void refreshCounts()
  }

  async function launch(id: string, launcherPath?: string): Promise<boolean> {
    const ok = await window.baoyi.software.launch(id, launcherPath)
    if (ok) {
      const item = items.value.find((x) => x.id === id)
      if (item) {
        item.last_used_at = Date.now()
        item.use_count += 1
      }
      void refreshCounts()
    }
    return ok
  }

  async function addManual(): Promise<SoftwareItem[]> {
    const added = await window.baoyi.software.addManual()
    if (added.length > 0) await reload()
    return added
  }

  return {
    items,
    counts,
    loading,
    keyword,
    mastery,
    sort,
    selection,
    activeKey,
    heading,
    todo,
    load,
    reload,
    refreshCounts,
    select,
    update,
    remove,
    launch,
    addManual
  }
})
