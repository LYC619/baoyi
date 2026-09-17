import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type { Episode, VideoCounts, VideoFilterType, VideoItem, VideoLibraryFilters, VideoQuery, WatchStatus } from '@/types'
import { useToast } from '@/composables/useToast'
import { createLatestGuard, errorMessage, isLocalPosterPath, plain } from '@/utils'

/** 侧边栏一次只选一样东西。同游戏那边的 GameSelection */
export type VideoSelection =
  | { kind: 'group'; value: 'all' | 'archived'; type?: 'hentai' }
  | { kind: 'type'; value: VideoFilterType }
  | { kind: 'status'; value: WatchStatus }
  | { kind: 'category'; value: string }
  | { kind: 'tag'; value: string; category?: string; type?: 'hentai' }
  | { kind: 'collection'; value: string; type?: 'hentai' }

/**
 * 四态的说法。
 *
 * 「想看」而不是「未观看」：这一格是用户主动往里放东西的地方（收藏了准备看的），
 * 说成「未观看」就变成了一句关于事实的陈述，而事实用不着一个格子来装。
 * 「弃」留着的理由见 types 里 WatchStatus 的注释 —— 它和「在看」是两件事。
 */
export const WATCH_STATUS_LABEL: Record<WatchStatus, string> = {
  unwatched: '想看',
  watching: '在看',
  watched: '看完',
  dropped: '弃'
}

export const VIDEO_TYPE_LABEL: Record<VideoFilterType, string> = {
  movie: '电影',
  series: '剧集',
  hentai: '里番'
}


const EMPTY_COUNTS: VideoCounts = {
  all: 0,
  archived: 0,
  type: { movie: 0, series: 0 },
  status: { unwatched: 0, watching: 0, watched: 0, dropped: 0 },
  categories: [],
  tags: [],
  hanime_tags: []
}

export const useVideoStore = defineStore('video', () => {
  const items = ref<VideoItem[]>([])
  const counts = ref<VideoCounts>({ ...EMPTY_COUNTS })
  const loading = ref(false)
  const brokenPosters = ref(new Set<string>())

  // 快慢两个查询并发时，晚到的旧响应不许覆盖新结果。同 game / software store
  const loadRounds = createLatestGuard()
  const countsRounds = createLatestGuard()
  let loadPending = false, countsPending = false
  let loadingRequest: Promise<void> | null = null, countsRequest: Promise<void> | null = null
  const { error: toastError } = useToast()

  const keyword = ref('')
  const sort = ref<NonNullable<VideoQuery['sort']>>('added')
  const filters = reactive<VideoLibraryFilters>({ publishedFrom:'',publishedTo:'',status:'',local:'' })
  const hasFilters = computed(() => Object.values(filters).some(Boolean))
  const selection = reactive<VideoSelection>({ kind: 'group', value: 'all' })

  const activeKey = computed(() => `${selection.kind}:${selection.value}`)
  const inHentaiScope = computed(() =>
    (selection.kind === 'type' && selection.value === 'hentai') ||
    ((selection.kind === 'tag' || selection.kind === 'collection' || selection.kind === 'group') && (selection.type === 'hentai' || ('category' in selection && selection.category === '里番')))
  )

  const heading = computed(() => {
    if (selection.kind === 'collection') return selection.value || '未设置收藏分组'
    if (selection.kind === 'category') return selection.value === '其他' ? '其他分类' : selection.value
    if (selection.kind === 'tag') return `# ${selection.value}`
    if (selection.kind === 'status') return WATCH_STATUS_LABEL[selection.value]
    if (selection.kind === 'type') return VIDEO_TYPE_LABEL[selection.value]
    return selection.value === 'archived' ? '已归档' : '全部影视'
  })

  function buildQuery(): VideoQuery {
    const q: VideoQuery = { keyword: keyword.value.trim() || undefined, sort: sort.value }
    if (selection.kind === 'group') q.group = selection.value
    if (selection.kind === 'type') q.type = selection.value
    if (selection.kind === 'status') q.status = selection.value
    if (selection.kind === 'category') q.category = selection.value
    if (selection.kind === 'collection') q.collection = selection.value
    if (inHentaiScope.value) q.type = 'hentai'
    if (selection.kind === 'tag') {
      q.tag = selection.value
      if (selection.category && selection.category !== '里番') q.category = selection.category
    }
    if (filters.publishedFrom) q.publishedFrom = filters.publishedFrom
    if (filters.publishedTo) q.publishedTo = filters.publishedTo
    if (filters.status) q.status = filters.status
    if (filters.local) q.local = filters.local
    return q
  }
  function setFilters(value: VideoLibraryFilters): void { Object.assign(filters, value); void load() }

  function load(): Promise<void> {
    loadRounds.begin()
    loadPending = true
    loading.value = true
    // A burst shares one request. Changes during that request need only one later read.
    if (!loadingRequest) loadingRequest = Promise.resolve().then(async () => {
      try {
        while (loadPending) {
          loadPending = false
          const round = loadRounds.begin()
          try {
            const next = await window.baoyi.video.list(buildQuery())
            if (loadRounds.isCurrent(round)) items.value = next
          } catch (err) {
            if (loadRounds.isCurrent(round)) toastError(`读取影视列表失败：${errorMessage(err)}`)
          }
        }
      } finally { loading.value = false; loadingRequest = null }
    })
    return loadingRequest
  }

  function refreshCounts(): Promise<void> {
    countsRounds.begin()
    countsPending = true
    if (!countsRequest) countsRequest = Promise.resolve().then(async () => {
      try {
        while (countsPending) {
          countsPending = false
          const round = countsRounds.begin()
          try {
            const next = await window.baoyi.video.counts()
            if (countsRounds.isCurrent(round)) {
              counts.value = next
              if (next.hentai_visible === false && inHentaiScope.value) select({ kind: 'group', value: 'all' })
            }
          } catch (err) {
            if (countsRounds.isCurrent(round)) toastError(`读取统计失败：${errorMessage(err)}`)
          }
        }
      } finally { countsRequest = null }
    })
    return countsRequest
  }

  async function reload(): Promise<void> {
    await Promise.all([load(), refreshCounts()])
  }

  function select(next: VideoSelection): void {
    if (next.kind === 'status') filters.status = ''
    for (const key of Object.keys(selection)) {
      if (!(key in next)) delete (selection as Record<string, unknown>)[key]
    }
    Object.assign(selection, next)
    void load()
  }

  /** 把一条更新过的条目并回列表。海报、观看状态那些都从各自的入口回来 */
  function merge(updated: VideoItem | null): VideoItem | null {
    if (!updated) return null
    brokenPosters.value.delete(updated.id)
    const i = items.value.findIndex((x) => x.id === updated.id)
    if (i >= 0) items.value[i] = updated
    return updated
  }

  async function update(id: string, patch: Partial<VideoItem>): Promise<VideoItem | null> {
    const updated = merge(await window.baoyi.video.update(id, plain(patch)))
    // 改观看状态 / 分类 / 标签 / 归档都会动侧边栏的数字
    void refreshCounts()
    return updated
  }

  /**
   * 撤掉字段保护，让它们下次重扫时重新跟着刮削走。传空数组 = 全撤。
   *
   * 不刷新计数：这个动作不改任何值，只改「下次重扫要不要写这一栏」，
   * 侧栏那些数字一个都不会变。
   */
  async function restoreScraped(id: string, fields: string[] = []): Promise<VideoItem | null> {
    return merge(await window.baoyi.video.restoreScraped(id, plain(fields)))
  }

  async function remove(id: string): Promise<void> {
    await window.baoyi.video.remove(id)
    items.value = items.value.filter((x) => x.id !== id)
    void refreshCounts()
  }

  /**
   * 交给系统默认播放器。剧集会自己挑「该接着看的那一集」。
   *
   * 失败要弹出来，这一条和 `fillPosters` 那个静默失败刚好相反：那是顺手补齐，
   * 用户没按任何按钮；这是他刚点了播放，没反应就必须给个说法。
   *
   * 打开成功会把状态从「未看」抬到「在看」，所以要刷计数 —— 侧栏「在看」
   * 那一格是唯一有行动含义的一格。
   */
  async function play(id: string): Promise<boolean> {
    const r = await window.baoyi.video.play(id)
    if (!r.ok) {
      toastError(r.message || '打不开这个文件')
      return false
    }
    merge(r.item)
    void refreshCounts()
    return true
  }

  /** 同上，指定某一集。返回改过的那一集，让详情页把它并回自己那份列表 */
  async function playEpisode(episodeId: string): Promise<Episode | null> {
    const r = await window.baoyi.video.playEpisode(episodeId)
    if (!r.ok) {
      toastError(r.message || '打不开这个文件')
      return null
    }
    merge(r.item)
    void refreshCounts()
    return r.episode
  }

  /**
   * 给一批条目补海报。海报墙进来时跑一次。
   *
   * 串行而不是并发：这些请求多半要走用户配的反代，十几路并发打上去很容易被限速，
   * 而且失败一张和失败一片在界面上是两种体验。慢一点没关系 —— 每张下完就并回
   * 列表，用户看到的是海报一张张浮出来，而不是等一屏全好了才动。
   *
   * 静默失败是刻意的：这是一次顺手的补齐，用户没按任何按钮。连不上 TMDB
   * 就该继续显示首字占位，不该弹一串红字挡在他和他的片库之间。
   */
  async function fillPosters(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        const r = await window.baoyi.video.fetchPoster(id)
        if (r.ok) merge(r.item)
      } catch {
        /* 单张失败不打断后面的 */
      }
    }
  }

  /**
   * 缺海报的那些。
   *
   * 判据不是「poster_path 为空」而是「不是本机文件」—— 刮削阶段这一列存的是
   * TMDB 的相对路径，非空但显示不出来。漏掉这一类的话，刚扫完的片库会一片
   * 首字占位，而补海报那个动作以为自己没事可做。
   */
  const missingPosters = computed(() =>
    items.value.filter((x) => !isLocalPosterPath(x.poster_path) || brokenPosters.value.has(x.id)).map((x) => x.id)
  )

  return {
    items,
    counts,
    loading,
    keyword,
    sort,
    filters,
    hasFilters,
    setFilters,
    selection,
    activeKey,
    heading,
    missingPosters,
    markPosterMissing: (id: string) => { brokenPosters.value.add(id) },
    inHentaiScope,
    load,
    reload,
    refreshCounts,
    select,
    merge,
    update,
    restoreScraped,
    remove,
    play,
    playEpisode,
    fillPosters
  }
})
