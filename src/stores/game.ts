import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type { GameCounts, GameItem, GameQuery, PlayStatus, SaveStatus } from '@/types'
import { useToast } from '@/composables/useToast'
import { createLatestGuard, errorMessage, plain } from '@/utils'
import {projectOf,PROJECT_FILTERS} from '@/utils/game-project'
import type {GameProjectCheck} from '@/types/game-project'

/** 侧边栏一次只选一样东西：一个虚拟分组、一个分类、或一个标签 */
export type GameSelection =
  | {kind:'project';value:keyof typeof PROJECT_FILTERS}
  | { kind: 'path'; value:'unavailable' }
  | { kind: 'platform'; value: 'windows' | 'android' }
  | { kind: 'uncategorized'; value: 'uncategorized' }
  | { kind: 'group'; value: 'all' | 'archived' }
  | { kind: 'status'; value: PlayStatus }
  | { kind: 'save'; value: SaveStatus }
  | { kind: 'category'; value: string }
  | { kind: 'tag'; value: string }

export const PLAY_STATUS_LABEL: Record<PlayStatus, string> = {
  unplayed: '想玩',
  playing: '在玩',
  completed: '通关',
  shelved: '搁置'
}

/**
 * 「未发现存档」而不是「无存档」：抱一只能说自己没找到，不能替用户断言游戏
 * 真的不存盘。差别落在用户会不会去手动补一条路径上。
 */
export const SAVE_STATUS_LABEL: Record<SaveStatus, string> = {
  unbacked: '未备份',
  backed: '已备份',
  none: '未发现存档'
}

const EMPTY_COUNTS: GameCounts = {
  all: 0,
  archived: 0,
  status: { unplayed: 0, playing: 0, completed: 0, shelved: 0 },
  save: { unbacked: 0, backed: 0, none: 0 },
  categories: [],
  tags: []
}

export const useGameStore = defineStore('game', () => {
  const items = ref<GameItem[]>([])
  const projectChecks=ref<GameProjectCheck[]>([]),checkingProjects=ref(false)
  const projectCounts=ref<Record<keyof typeof PROJECT_FILTERS,number>>({all:0,issues:0,deferred:0,static:0,updated:0})
  const matchesProject=(g:GameItem,filter:keyof typeof PROJECT_FILTERS)=>{
    const p=projectOf(g);if(!p)return false
    if(filter==='issues')return p.issues.some(i=>i.status==='open')
    if(filter==='deferred')return p.issues.some(i=>i.status==='deferred')
    if(filter==='static')return p.facets.some(f=>f.label==='运行验证'&&f.state==='游玩时验证')
    if(filter==='updated')return projectChecks.value.some(c=>c.id===g.id&&c.state!=='current')
    return true
  }
  async function checkProjects(){checkingProjects.value=true;try{projectChecks.value=await window.baoyi.game.checkProjects();await reload()}catch(e){toastError(errorMessage(e))}finally{checkingProjects.value=false}}
  const unavailableCount=ref(0), androidCount=ref(0), windowsCount=ref(0)
  const counts = ref<GameCounts>({ ...EMPTY_COUNTS })
  const loading = ref(false)
  const loadedQuery = ref('')
  const queryPending = computed(() => loading.value || loadedQuery.value !== queryKey())

  // 快慢两个查询并发时，晚到的旧响应不许覆盖新结果。同 software store
  const loadRounds = createLatestGuard()
  const countsRounds = createLatestGuard()
  const { error: toastError } = useToast()

  const keyword = ref('')
  const sort = ref<NonNullable<GameQuery['sort']>>('played')
  const selection = reactive<GameSelection>({ kind: 'group', value: 'all' })

  const activeKey = computed(() => `${selection.kind}:${selection.value}`)

  const heading = computed(() => {
    if(selection.kind==='project')return PROJECT_FILTERS[selection.value]
    if (selection.kind === 'path') return '路径不可用'
    if (selection.kind === 'platform') return selection.value === 'android' ? '安卓游戏' : '电脑游戏'
    if (selection.kind === 'uncategorized') return '未分类'
    if (selection.kind === 'category') return selection.value
    if (selection.kind === 'tag') return `# ${selection.value}`
    if (selection.kind === 'status') return PLAY_STATUS_LABEL[selection.value]
    if (selection.kind === 'save') return SAVE_STATUS_LABEL[selection.value]
    return selection.value === 'archived' ? '已归档' : '全部游戏'
  })

  function buildQuery(): GameQuery {
    const q: GameQuery = { keyword: keyword.value.trim() || undefined, sort: sort.value }
    if (selection.kind === 'uncategorized') q.uncategorized = true
    if (selection.kind === 'group') q.group = selection.value
    if (selection.kind === 'status') q.status = selection.value
    if (selection.kind === 'save') q.save = selection.value
    if (selection.kind === 'category') q.category = selection.value
    if (selection.kind === 'tag') q.tag = selection.value
    return q
  }

  const queryKey=()=>JSON.stringify([buildQuery(),selection.kind,selection.value])

  async function load(): Promise<void> {
    const round = loadRounds.begin()
    loading.value = true
    const query = buildQuery(), selected = {...selection}, key = queryKey()
    try {
      const next = await window.baoyi.game.list(query)
      if (loadRounds.isCurrent(round)) { items.value = selected.kind==='project'?next.filter(g=>matchesProject(g,selected.value)):selected.kind==='path'?next.filter(item=>item.path_state&&item.path_state!=='present'):selected.kind==='platform'?next.filter(item=>selected.value==='android'?/\.apk$/i.test(item.path):!/\.apk$/i.test(item.path)):next; loadedQuery.value = key }
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
      const [next,all]=await Promise.all([window.baoyi.game.counts(),window.baoyi.game.list({group:'all'})])
      if(countsRounds.isCurrent(round))for(const key of Object.keys(PROJECT_FILTERS) as Array<keyof typeof PROJECT_FILTERS>)projectCounts.value[key]=all.filter(g=>matchesProject(g,key)).length
      if(countsRounds.isCurrent(round)){unavailableCount.value=all.filter(item=>item.path_state&&item.path_state!=='present').length;androidCount.value=all.filter(item=>/\.apk$/i.test(item.path)).length;windowsCount.value=all.length-androidCount.value}
      if (countsRounds.isCurrent(round)) counts.value = next
    } catch (err) {
      if (countsRounds.isCurrent(round)) toastError(`读取统计失败：${errorMessage(err)}`)
    }
  }

  /**
   * 存档路径失效的名单：id → 这次没找到的那几条路径。
   *
   * 只活在内存里，跟着这次会话消失 —— 主进程刻意不写库（见 checkAllSavePaths），
   * 渲染进程这边也就没有「持久化一份」的道理。外置硬盘插回来，重开一次库就干净了。
   */
  const staleSaves = ref(new Map<string, string[]>())
  const staleCount = computed(() => staleSaves.value.size)
  /**
   * 这次会话里体检跑过没有。
   *
   * 不能用 `staleSaves.size === 0` 代替：那个 0 有两种含义 —— 「还没查」和
   * 「查过了，每条都在」。详情页要靠这个区分决定自己该不该补一次，
   * 拿 size 判断会变成「一切正常时每次进详情页都重扫一遍全库」。
   */
  const staleChecked = ref(false)

  async function checkSavePaths(): Promise<void> {
    try {
      const alerts = await window.baoyi.game.checkSavePaths()
      staleSaves.value = new Map(alerts.map((a) => [a.id, a.missing]))
      staleChecked.value = true
    } catch (err) {
      // 这是一次顺手的体检，失败了不该拿一条红字挡在用户和他的游戏库之间。
      // 后果只是角标不出现，比「开库先看到一条报错」轻
      console.warn('存档路径检查失败', errorMessage(err))
    }
  }

  /** 备份/改路径之后单条刷掉角标，不必为一个游戏重扫全库 */
  function clearStale(id: string): void {
    if (!staleSaves.value.has(id)) return
    const next = new Map(staleSaves.value)
    next.delete(id)
    staleSaves.value = next
  }

  async function reload(): Promise<void> {
    await Promise.all([load(), refreshCounts(), checkSavePaths()])
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
    projectChecks,checkingProjects,projectCounts,checkProjects,
    unavailableCount,androidCount,windowsCount,
    items,
    counts,
    loading,
    queryPending,
    keyword,
    sort,
    selection,
    activeKey,
    heading,
    staleSaves,
    staleCount,
    staleChecked,
    load,
    reload,
    refreshCounts,
    checkSavePaths,
    clearStale,
    select,
    update,
    remove
  }
})
