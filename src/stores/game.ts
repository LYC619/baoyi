import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type { GameCounts, GameItem, GameQuery, PlayStatus } from '@/types'
import { useToast } from '@/composables/useToast'
import { createLatestGuard, errorMessage, plain } from '@/utils'

/** 侧边栏一次只选一样东西：一个虚拟分组、一个分类、或一个标签 */
export type GameSelection =
  | { kind: 'group'; value: 'all' | 'archived' }
  | { kind: 'status'; value: PlayStatus }
  | { kind: 'category'; value: string }
  | { kind: 'tag'; value: string }

export const PLAY_STATUS_LABEL: Record<PlayStatus, string> = {
  unplayed: '想玩',
  playing: '在玩',
  completed: '通关',
  shelved: '搁置'
}

const EMPTY_COUNTS: GameCounts = {
  all: 0,
  archived: 0,
  status: { unplayed: 0, playing: 0, completed: 0, shelved: 0 },
  categories: [],
  tags: []
}

export const useGameStore = defineStore('game', () => {
  const items = ref<GameItem[]>([])
  const counts = ref<GameCounts>({ ...EMPTY_COUNTS })
  const loading = ref(false)

  // 快慢两个查询并发时，晚到的旧响应不许覆盖新结果。同 software store
  const loadRounds = createLatestGuard()
  const countsRounds = createLatestGuard()
  const { error: toastError } = useToast()

  const keyword = ref('')
  const sort = ref<NonNullable<GameQuery['sort']>>('played')
  const selection = reactive<GameSelection>({ kind: 'group', value: 'all' })

  const activeKey = computed(() => `${selection.kind}:${selection.value}`)

  const heading = computed(() => {
    if (selection.kind === 'category') return selection.value
    if (selection.kind === 'tag') return `# ${selection.value}`
    if (selection.kind === 'status') return PLAY_STATUS_LABEL[selection.value]
    return selection.value === 'archived' ? '已归档' : '全部游戏'
  })

  function buildQuery(): GameQuery {
    const q: GameQuery = { keyword: keyword.value.trim() || undefined, sort: sort.value }
    if (selection.kind === 'group') q.group = selection.value
    if (selection.kind === 'status') q.status = selection.value
    if (selection.kind === 'category') q.category = selection.value
    if (selection.kind === 'tag') q.tag = selection.value
    return q
  }

  async function load(): Promise<void> {
    const round = loadRounds.begin()
    loading.value = true
    try {
      const next = await window.baoyi.game.list(buildQuery())
      if (loadRounds.isCurrent(round)) items.value = next
    } catch (err) {
      // 失败时保留旧列表，比清空再显示「游戏库是空的」诚实
      if (loadRounds.isCurrent(round)) toastError(`读取游戏列表失败：${errorMessage(err)}`)
    } finally {
      if (loadRounds.isCurrent(round)) loading.value = false
    }
  }

  async function refreshCounts(): Promise<void> {
    const round = countsRounds.begin()
    try {
      const next = await window.baoyi.game.counts()
      if (countsRounds.isCurrent(round)) counts.value = next
    } catch (err) {
      if (countsRounds.isCurrent(round)) toastError(`读取统计失败：${errorMessage(err)}`)
    }
  }

  async function reload(): Promise<void> {
    await Promise.all([load(), refreshCounts()])
  }

  function select(next: GameSelection): void {
    Object.assign(selection, next)
    void load()
  }

  async function update(id: string, patch: Partial<GameItem>): Promise<GameItem | null> {
    const updated = await window.baoyi.game.update(id, plain(patch))
    if (updated) {
      const i = items.value.findIndex((x) => x.id === id)
      if (i >= 0) items.value[i] = updated
    }
    // 改状态 / 分类 / 标签 / 归档都会动侧边栏的数字
    void refreshCounts()
    return updated
  }

  async function remove(id: string): Promise<void> {
    await window.baoyi.game.remove(id)
    items.value = items.value.filter((x) => x.id !== id)
    void refreshCounts()
  }

  return {
    items,
    counts,
    loading,
    keyword,
    sort,
    selection,
    activeKey,
    heading,
    load,
    reload,
    refreshCounts,
    select,
    update,
    remove
  }
})
