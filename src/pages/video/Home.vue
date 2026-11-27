<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import LibraryToolbarMenu from '@/components/library/LibraryToolbarMenu.vue'
/**
 * 影视库首页：海报墙 + 侧边栏。
 *
 * 海报与紧凑列表共用筛选范围，整理选择也只作用于当前可见作品。
 *
 * 多一个「补海报」的按钮，游戏那边没有。原因是海报的来路和封面不同：扫描
 * 只把 TMDB 的相对路径记下来，真正下载留到用户看得见海报墙的时候。做成按钮
 * 而不是进页面自动跑，是因为那是一串没人按过的网络请求 —— 用户配的反代、
 * 按流量计费的网络，都不该由一次「打开影视库」来花。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRefs, watch } from 'vue'
import { useRouter } from 'vue-router'
import { CheckSquare, CircleAlert, FolderPlus, ImageDown, Link, List, Search, X } from 'lucide-vue-next'
import AudioLibrary from '@/components/video/AudioLibrary.vue'
import {useMusic} from '@/composables/useMusic'
import {useVideoUpdates} from '@/composables/useVideoUpdates'
import Sidebar from '@/components/video/Sidebar.vue'
import VideoBulkPanel from '@/components/video/VideoBulkPanel.vue'
import VideoRemovalDialog from '@/components/video/VideoRemovalDialog.vue'
import VideoLayoutDialog from '@/components/video/VideoLayoutDialog.vue'
import type { VideoWorkContent } from '@/types/video-workflow'
import VideoCard from '@/components/video/VideoCard.vue'
import DownloadPanel from '@/components/video/DownloadPanel.vue'
import OrganizePanel from '@/components/video/OrganizePanel.vue'
import VideoFilters from '@/components/video/VideoFilters.vue'
import type { VideoItem, VideoQuery } from '@/types'
import { recallScroll, rememberScroll } from '@/composables/useModules'
import { useToast } from '@/composables/useToast'
import { reidentifyVideo, useMediaScan } from '@/composables/useMediaScan'
import { useVideoImport } from '@/composables/useVideoImport'
import { useFileDrop } from '@/composables/useFileDrop'
import DropZoneOverlay from '@/components/ui/DropZoneOverlay.vue'
import { useVideoAgentOrganize } from '@/composables/useVideoAgentOrganize'
import { rangeSelection } from '@/utils/range-selection'
import { useVideoWorkflow, videoLibraryView, videoJobRetryStages } from '@/composables/useVideoWorkflow'
import { useVideoStore } from '@/stores/video'
import { useSettingsStore } from '@/stores/settings'
import { debounce, errorMessage, shortenPath } from '@/utils'
import { zhSearchKey } from '@/utils/zh'

const router = useRouter()
const videoUpdates=useVideoUpdates()
const music=useMusic()
const audioView=ref<'cards'|'list'>(localStorage.getItem('baoyi.audio.view')==='cards'?'cards':'list')
watch(audioView,value=>localStorage.setItem('baoyi.audio.view',value))
const store = useVideoStore()
const settings = useSettingsStore()
// 海报墙格子宽度：拖的时候只改本地值（即时生效），松手才写设置
const cardSize = ref(settings.settings.video_card_size || 150)
watch(() => settings.settings.video_card_size, size => { if (size) cardSize.value = size })
const { toast, success, error } = useToast()

const content = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
function onSearchShortcut(e: KeyboardEvent): void {
  if (e.isComposing || document.querySelector?.('dialog[open]')) return
  if (e.key === 'Escape' && searchInput.value && document.activeElement === searchInput.value) {
    e.preventDefault()
    clearKeyword()
    searchInput.value.blur()
  }
}

const operation = useMediaScan('video')
const videoImport = useVideoImport()
const videoAgent = useVideoAgentOrganize()
const preparing = ref(false)
const scanning = computed(() => preparing.value || operation.running.value)
const progress = operation.progress
let pageDisposed = false
const { compact, pendingOnly, issue } = toRefs(videoLibraryView)
const workflow = useVideoWorkflow()
const privateHidden = computed(() => !workflow.privacyReady.value || workflow.hideHentai.value)
const visibleItems = computed(() => store.currentItems.filter(item => !privateHidden.value || item.category !== '里番'))
const issueLabels: Record<string, string> = { get poster() { return tr('待补海报') }, get files() { return tr('文件失联') }, get metadata() { return tr('资料待补齐') }, get 'metadata:description'() { return tr('缺简介') }, get 'metadata:poster'() { return tr('缺封面') }, get 'metadata:review'() { return tr('未经识别确认') }, get download() { return tr('下载待处理') }, get review() { return tr('归属待确认') } }
function pendingReasons(item: VideoItem): string[] {
  const reasons = [...(item.pending_reasons ?? [])]
  if (store.missingPosters?.includes(item.id) && !reasons.includes('poster')) reasons.push('poster')
  if ((item.missing_files ?? 0) > 0 && !reasons.includes('files')) reasons.push('files')
  if (workflow.jobs.value.some(job => job.resourceId === item.id && videoJobRetryStages(job).length)) reasons.unshift('download')
  return [...new Set(reasons)]
}
const pendingItems = computed(() => visibleItems.value.filter(item => pendingReasons(item).length))
const shownItems = computed(() => pendingOnly.value ? pendingItems.value.filter(item => issue.value === 'any' || pendingReasons(item).includes(issue.value)) : visibleItems.value)
const missingPosterIds = computed(() => store.missingPosters.filter(id => visibleItems.value.some(item => item.id === id)))
const audioScope = computed(() => store.inAudioScope)
const seriesScope = computed(() => !audioScope.value && (store.inHentaiScope || (store.selection.kind === 'group' && store.selection.value === 'all') || (store.selection.kind === 'type' && store.selection.value === 'series') || (store.selection.kind === 'category' && ['剧集','里番'].includes(store.selection.value))))
const scopedUpdateRows = computed(() => store.queryPending ? [] : videoUpdates.state.value.rows.filter(row => shownItems.value.some(item => item.id === row.id)))
const scopedUpdateCount = computed(() => scopedUpdateRows.value.filter(row => row.newEpisodes > 0 || row.missingFiles > 0).length)
function showUpdateResults(){if(store.queryPending)return;videoUpdates.show(shownItems.value.map(item=>item.id))}
watch(()=>store.activeKey,()=>{videoUpdates.open.value=false})
onBeforeUnmount(()=>{videoUpdates.open.value=false})
const selecting = ref(false)
const selectedIds = ref<string[]>([])
const bulkOpen = ref(false)
const bulkBusy = ref(false)
const removing = ref(false)
const importing = computed(() => !!videoImport.busy.value)
// 手动展开和搜索自动展开分开记：自动展开只在有搜索 / 标签条件时存在，条件一清就整组收回；
// 之前混在一个集合里，清空搜索后 expanded[id] 仍是 true，watcher 再跑一遍等于永远收不回（B2）
const userExpanded = ref<Record<string, boolean>>({}), autoExpanded = ref<Record<string, boolean>>({})
const expandedEpisodes = ref<Record<string, VideoWorkContent[]>>({})
const expanded = computed<Record<string, boolean>>(() => ({ ...autoExpanded.value, ...userExpanded.value }))
async function loadEpisodes(id: string, run?: number): Promise<VideoWorkContent[]> {
  try {
    const contents = (await window.baoyi.video.library(id)).contents
    if (run === undefined || run === expandRun) expandedEpisodes.value[id] = contents
    return contents
  } catch (e) {
    if (run === undefined || run === expandRun) error(errorMessage(e))
    return []
  }
}
async function toggleCollection(id: string) {
  const next = !expanded.value[id]
  userExpanded.value[id] = next
  if (!next) delete autoExpanded.value[id]
  if (next && !expandedEpisodes.value[id]) await loadEpisodes(id)
}
function matchingEpisodes(id: string, episodes = expandedEpisodes.value[id] || []): VideoWorkContent[] {
  const tag = store.selection.kind === 'tag' ? store.selection.value : ''
  const keyword = zhSearchKey(store.keyword.trim())
  return episodes.filter(e => (!tag || e.tags?.includes(tag)) && (!keyword || zhSearchKey([e.title,e.original_title,...e.tags || []].join(' ')).includes(keyword)))
}
const searching = computed(() => store.selection.kind === 'tag' || !!store.keyword.trim())
let expandRun = 0
watch(() => [shownItems.value, store.queryPending], async () => {
  // 关键词连着改时等 store 防抖查询稳定后再读单集，晚到的一轮直接作废
  const run = ++expandRun
  if (store.queryPending) return
  expandedEpisodes.value = {}
  autoExpanded.value = {}
  for (const item of shownItems.value) {
    if (item.episode_total <= 1 || (!userExpanded.value[item.id] && !searching.value)) continue
    const episodes = await loadEpisodes(item.id, run)
    if (run !== expandRun) return
    // 只有单集真的命中条件才自动展开；作品自身匹配而单集不匹配的，展开也只是一行空态
    if (!userExpanded.value[item.id] && matchingEpisodes(item.id, episodes).length) autoExpanded.value[item.id] = true
  }
})
const selectedWorks = computed(() => selectedIds.value.map(id => shownItems.value.find(item => item.id === id)).filter((item): item is VideoItem => !!item))
const organizeMode = ref<'organize' | ''>('')
// 统一移动：选择态就只动选中的，否则动当前范围里的全部作品
const layoutIds = ref<string[] | null>(null)
const organizeWorks = ref<VideoItem[]>([])
const organizeTrigger = ref<HTMLElement | null>(null)
const organizeReturnFocus = ref<HTMLElement | null>(null)
watch(() => shownItems.value.map(item => item.id), ids => { selectedIds.value = selectedIds.value.filter(id => ids.includes(id)) }, { flush: 'sync' })
watch(privateHidden, hidden => {
  if (hidden) organizeWorks.value = organizeWorks.value.filter(item => item.category !== '里番')
}, { flush: 'sync' })
const selectionAnchor = ref('')
watch(() => [store.querySignature, pendingOnly.value, issue.value, privateHidden.value], () => {
  selectedIds.value = []
  selectionAnchor.value = ''
  if (!bulkBusy.value) { removing.value = false; layoutIds.value = null; organizeMode.value = '' }
}, { flush: 'sync' })
function selectAll(): void {
  if (!store.queryPending && !bulkBusy.value) selectedIds.value = shownItems.value.map(item => item.id)
}
function requestRemoval(): void {
  if (!store.queryPending && !bulkBusy.value && selectedWorks.value.length) removing.value = true
}
function requestLayout(): void {
  if (store.queryPending || bulkBusy.value || scanning.value) return
  const works = selecting.value ? selectedWorks.value : shownItems.value
  if (works.length) layoutIds.value = works.map(item => item.id)
}
function requestAgent(): void {
  if (store.queryPending || bulkBusy.value) return
  const works = selecting.value ? selectedWorks.value : shownItems.value
  if (works.length) videoAgent.show([...works])
}
function selectReview(): void {
  if (store.queryPending || bulkBusy.value) return
  toggleSelecting(); bulkOpen.value = true
  selectedIds.value = shownItems.value.filter(item => item.needs_review).map(item => item.id)
}
function toggleSelecting(): void { if (bulkBusy.value) return; bulkOpen.value = false; selecting.value = !selecting.value; selectedIds.value = []; selectionAnchor.value = '' }
function selectWork(id: string, event?: MouseEvent): void {
  if (store.queryPending || bulkBusy.value || !shownItems.value.some(item => item.id === id)) return
  selectedIds.value = rangeSelection(shownItems.value.map(item => item.id), selectedIds.value, id, selectionAnchor.value, event?.shiftKey)
  if (!event?.shiftKey || !selectionAnchor.value) selectionAnchor.value = id
}
function organize(mode: 'organize'): void {
  if (store.queryPending || bulkBusy.value || !selectedWorks.value.length) return
  organizeWorks.value = [...selectedWorks.value]
  organizeReturnFocus.value = organizeTrigger.value
  organizeMode.value = mode
}
function selectionKey(event: KeyboardEvent): void {
  if (!selecting.value || bulkBusy.value || organizeMode.value || removing.value || layoutIds.value || event.defaultPrevented) return
  const target = event.target as HTMLElement
  if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '') || target?.closest('[role="dialog"]')) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); selectAll(); return }
  if (event.key !== 'Escape') return
  event.preventDefault()
  selecting.value = false
  selectedIds.value = []
  organizeTrigger.value?.focus()
}
function clearLibraryFilters() { store.keyword = ''; pendingOnly.value = false; issue.value = 'any'; store.setFilters({ publishedFrom: '', publishedTo: '', status: '', local: '' }) }
const checkedVideoCount = computed(() => shownItems.value.every(item => typeof item.available_files === 'number')
  ? shownItems.value.reduce((sum, item) => sum + (item.available_files ?? 0), 0) : null)
const heading = computed(() => privateHidden.value && store.inHentaiScope ? tr('影视库') : store.heading)
const reviewingSelected = ref(false)
let unlistenLibrary: (() => void) | undefined
let libraryDirty = false
let libraryRefreshTimer: ReturnType<typeof setTimeout> | undefined
function requestLibraryRefresh(): void {
  libraryDirty = true
  if (pageDisposed || document.hidden || libraryRefreshTimer) return
  libraryRefreshTimer = setTimeout(() => {
    libraryRefreshTimer = undefined
    if (pageDisposed || document.hidden || !libraryDirty) return
    libraryDirty = false
    void store.reload()
  }, 150)
}
function resumeLibraryRefresh(): void { if (!document.hidden && libraryDirty) requestLibraryRefresh() }
watch(() => store.activeKey, () => { pendingOnly.value = false })

function itemStatus(item: VideoItem): string {
  const active = workflow.jobs.value.find(job => job.resourceId === item.id && (job.status === 'running' || job.status === 'queued'))
  if (active) return active.status === 'queued' ? tr("已排队") : tr("下载处理中")
  // 角标写具体的那几条（缺简介、未经识别确认…），多条用「、」连；"资料待补齐"这个大类只在没有细分时兜底
  const reasons = pendingReasons(item)
  const specific = reasons.filter(reason => reason !== 'metadata' || !reasons.some(other => other.startsWith('metadata:')))
  return specific.map(reason => issueLabels[reason] || reason).join('、')
}
function recentContent(item: VideoItem): string {
  const job = workflow.jobs.value.find(job => job.resourceId === item.id && job.items.some(value => value.transfer === 'complete'))
  return job?.items.filter(value => value.transfer === 'complete').at(-1)?.title || ''
}
function addFromLink(): void { if (store.inHentaiScope && !privateHidden.value) workflow.open.value = true }
function togglePending(): void { pendingOnly.value = !pendingOnly.value }

const SORTS: Array<{ value: NonNullable<VideoQuery['sort']>; label: string }> = [
  { value: 'published', get label() { return tr("最近发布") } },
  { value: 'published-asc', get label() { return tr("最早发布") } },
  { value: 'added', get label() { return tr("最近加入") } },
  { value: 'updated', get label() { return tr("最近更新") } },
  { value: 'year', get label() { return tr("按年份") } },
  { value: 'rating', get label() { return tr("按评分") } },
  { value: 'name', get label() { return tr("按名称") } }
]

async function reviewSelected(): Promise<void> {
  if (store.queryPending || bulkBusy.value || scanning.value || reviewingSelected.value || !selectedWorks.value.length) return
  const batch = [...selectedWorks.value]
  reviewingSelected.value = true
  bulkBusy.value = true
  let updated = 0, failed = 0
  try {
    const ready = await window.baoyi.video.readiness(true)
    if (!ready.ok) { toast(ready.message); return }
    for (const item of batch) {
      if (privateHidden.value && item.category === '里番') break
      try { if (await reidentifyVideo(item, false)) updated++ }
      catch { failed++ }
      if (operation.stopping.value) break
    }
    await store.reload()
    toast((operation.stopping.value ? tr('复查已停止：{p0} 部已更新', { p0: updated }) : tr('复查完成：{p0} 部已更新', { p0: updated })) + (failed ? tr("，{p0} 部失败，详见任务日志", {p0: (failed)}) : ''))
  } catch (cause) { error(errorMessage(cause)) }
  finally { reviewingSelected.value = false; bulkBusy.value = false }
}
onMounted(async () => {
  if (store.selection.kind === 'status' || (store.selection.kind === 'category' && ['其他', '其他分类'].includes(store.selection.value))) store.select({ kind: 'group', value: 'all' })
  unlistenLibrary = window.baoyi.video.onLibraryChanged?.(requestLibraryRefresh)
  document.addEventListener('visibilitychange', resumeLibraryRefresh)
  window.addEventListener?.('keydown', onSearchShortcut)
  void workflow.refresh()
  await store.reload()
  if (pageDisposed) return
  await nextTick()
  // 内容还没渲染时容器高度是 0，这时候设 scrollTop 会被浏览器吞掉
  if (content.value) content.value.scrollTop = recallScroll('video')
})

onBeforeUnmount(() => {
  if (content.value) rememberScroll('video', content.value.scrollTop)
  pageDisposed = true
  unlistenLibrary?.()
  if (libraryRefreshTimer) clearTimeout(libraryRefreshTimer)
  document.removeEventListener('visibilitychange', resumeLibraryRefresh)
  window.removeEventListener?.('keydown', onSearchShortcut)
})

const busyText = computed(() => {
  const p = progress.value
  if (operation.stopping.value && operation.running.value) return tr("正在停止，等待当前任务收尾…")
  if (!p) return tr("准备中")
  if (p.phase === 'done') return tr("正在刷新资源库…")
  if (p.phase === 'scanning') return tr("正在扫描 {p0}", {p0: (shortenPath(p.current, 40))})
  if (p.total <= 0) return tr("正在识别 · 已处理 {p0} 项，总数待确定", {p0: (p.processed)})
  return tr("识别 {p0}/{p1}　{p2}", {p0: (Math.min(p.processed + 1, p.total)), p1: (p.total), p2: (p.log || shortenPath(p.current, 32))})
})

const busyPercent = computed(() => {
  const p = progress.value
  // 扫描阶段的总数要扫完才知道，这时候画一根瞎跳的进度条不如画一根空的
  if (!p || p.phase === 'scanning' || p.total === 0) return 0
  return Math.max(0, Math.min(100, Math.round((p.processed / p.total) * 100)))
})

const onKeyword = debounce(() => void store.load(), 220)

function clearKeyword(): void {
  store.keyword = ''
  void store.load()
}

function open(id: string, edit = false): void {
  void router.push({ name: 'video-detail', params: { id }, ...(edit ? { query: { edit: '1' } } : {}) })
}
function openAudio(item:VideoItem,episode?:string){void router.push({name:'video-detail',params:{id:item.id},query:episode?{track:episode}:{}})}

function cancelScan(): void {
  try { operation.cancel() }
  catch (err) { error(tr("停止扫描失败：") + errorMessage(err)) }
}

const { dragging: dropActive, dropHandlers } = useFileDrop(async (paths) => {
  if (scanning.value || importing.value || videoImport.open.value) return
  await videoImport.begin(paths)
}, { disabled: () => scanning.value || importing.value || videoImport.open.value })

async function importBundle(): Promise<void> {
  if (scanning.value || importing.value) return
  await videoImport.begin()
}

/* ------------------------------ 补海报 ------------------------------ */

const filling = ref(false)

/**
 * 把当前这一屏缺海报的补上。
 *
 * 只管当前列表，不是整库：用户看着哪一屏就补哪一屏，这样等待和收益在同一个
 * 视野里。整库补齐是一次不知道要跑多久的活，而它的结果用户当场看不到。
 */
async function fillPosters(): Promise<void> {
  const ids = missingPosterIds.value
  if (ids.length === 0) {
    toast(tr("这一屏的海报都齐了"))
    return
  }
  filling.value = true
  try {
    await store.fillPosters(ids)
    // 补完再数一次：还缺的就是三条来路都没找着的那些，得让用户知道剩下要手动来
    const left = missingPosterIds.value.length
    if (left === 0) success(tr("补齐了 {p0} 张海报", {p0: (ids.length)}))
    else if (left < ids.length) toast(tr("补上 {p0} 张，还有 {p1} 张没找到", {p0: (ids.length - left), p1: (left)}))
    else toast(tr("一张也没补上。检查一下 TMDB 配置，或者在详情页手动选图"))
  } finally {
    filling.value = false
  }
}

/* ------------------------------ 加影视 ------------------------------ */

/**
 * 首轮只读取本地资料；资料不足的条目在待处理中提供 Agent 复查。
 *
 * 可用性判断问主进程要，不在这儿照抄一遍条件 —— 两处各写一份，改了一处
 * 就会出现「界面说能扫，扫下去没识别」。
 */


const emptyHint = computed(() => {
  if (pendingOnly.value) return { title: tr('当前范围暂无这类待处理作品'), desc: tr('可切换问题类型或返回全部作品。') }
  if (store.hasFilters) return { title: tr('没有符合筛选条件的影视'), desc: tr('调整发布时间或状态，或在筛选中清空条件。') }
  if (store.keyword.trim()) return { title: tr('没有匹配的影视'), desc: tr('换个关键词，或清空搜索') }
  if (store.selection.kind === 'status')
    return { title: tr('「{p0}」里还没有影视', {p0: store.heading}), desc: tr('在详情页可以改观看状态') }
  if (store.selection.kind === 'type')
    return { title: tr('还没有{p0}', {p0: store.heading}), desc: tr('换一格看看，或者点右上角加影视') }
  if (store.counts.all === 0)
    return { title: tr('影视库还是空的'), desc: tr('扫描本地目录，或导入视频、课程和音频资源。') }
  return { title: tr('这里还没有内容'), desc: tr('换个分类看看') }
})
</script>

<template>
  <div class="home" :style="{ '--card-min': cardSize + 'px' }" v-on="dropHandlers" @keydown="selectionKey">
    <DropZoneOverlay :active="dropActive" :title="$t('松开以预览导入影视与音频')" :hint="$t('支持拖入视频、音频文件或作品文件夹，确认后再正式入库')" />
    <Sidebar :pending-active="pendingOnly" :pending-count="pendingItems.length" :private-hidden="privateHidden" @pending="togglePending" />

    <main class="home__main">
      <header class="toolbar">
        <div class="toolbar__title">
          <h1>{{ heading }}</h1>
          <span class="toolbar__count">{{ shownItems.length }} {{ audioScope ? $t('项音频') : $t('部作品') }}</span>
        </div>

        <div class="library-search">
        <div class="search">
          <Search :size="15" class="search__icon" />
          <input
            ref="searchInput"
            v-model="store.keyword"
            class="search__input"
            type="text"
            :placeholder="$t('搜索作品、内容标题或文件名')"
            :aria-label="$t('搜索作品、内容标题或文件名')"
            @input="onKeyword"
          />
          <kbd v-if="!store.keyword" class="search__kbd">Ctrl K</kbd>
          <button v-if="store.keyword" class="search__clear" :title="$t('清空搜索')" :aria-label="$t('清空搜索')" @click="clearKeyword">
            <X :size="14" />
          </button>
        </div>
        <VideoFilters :model-value="store.filters" @update:model-value="store.setFilters" />
        </div>

        <div class="toolbar__actions">
          <button ref="organizeTrigger" type="button" class="btn btn--ghost" :disabled="bulkBusy" :aria-pressed="selecting" @click="toggleSelecting(); bulkOpen = selecting"><CheckSquare :size="15"/>{{ selecting ? $t('退出批量管理') : $t('批量管理') }}</button>
          <select v-model="store.sort" class="select" :aria-label="$t('作品排序')" @change="store.load()">
            <option v-for="o in SORTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>



          <button v-if="audioScope" class="btn btn--primary" @click="music.open.value=true"><Search :size="15"/>{{ $t("找音乐") }}</button>
          <button v-if="!audioScope" class="btn btn--primary" :title="$t('切换来源，浏览海报墙并选择观看或保存')" @click="router.push({ name: 'video-discover' })"><Link :size="15" />{{ $t("找视频") }}</button>
          <button v-if="store.inHentaiScope && !privateHidden" class="btn btn--ghost" :title="$t('粘贴 Hanime 视频页链接，或到站内挑好再下载')" @click="addFromLink">{{ $t("从 Hanime 添加") }}</button>

          <button class="btn btn--subtle" :title="audioScope ? $t('导入专辑、播客或有声书目录') : $t('导入视频目录或抱一资源包')" :disabled="scanning || importing" @click="importBundle">
            <FolderPlus :size="15" /> {{ importing ? $t('导入中…') : audioScope ? $t('导入音频') : $t('导入目录') }}
          </button>



          <LibraryToolbarMenu :label="$t('视图')">
          <template v-if="audioScope"><button class="btn btn--subtle" :aria-pressed="audioView==='cards'" @click="audioView='cards'">{{ $t("音频卡片视图") }}</button><button class="btn btn--subtle" :aria-pressed="audioView==='list'" @click="audioView='list'">{{ $t("音频曲目列表") }}</button></template>
          <button v-if="!audioScope" class="btn btn--subtle" :title="compact ? $t('海报视图') : $t('紧凑列表')" :aria-label="compact ? $t('海报视图') : $t('紧凑列表')" :aria-pressed="compact" @click="compact = !compact">
            <List :size="16" />
          </button>
<label v-if="audioScope ? audioView==='cards' : !compact">{{ $t("卡片大小") }}<input v-model.number="cardSize" class="card-size" type="range" min="110" max="320" step="10" :title="$t('卡片大小')" :aria-label="$t('卡片大小')" @change="settings.patch({ video_card_size: cardSize })" /></label>
          </LibraryToolbarMenu>
          <LibraryToolbarMenu :label="$t('更多')">
          <button v-if="seriesScope && store.selection.kind==='group' && store.selection.value==='all'" :disabled="videoUpdates.state.value.running" @click="videoUpdates.start()">{{ $t("检查全部系列更新") }}</button>
          <button v-if="seriesScope" :disabled="store.queryPending || videoUpdates.state.value.running || !(selecting ? selectedWorks : shownItems).length" @click="videoUpdates.start((selecting ? selectedWorks : shownItems).map(item=>item.id))">{{selecting?$t('检查所选系列更新'):$t('检查当前范围系列更新')}}</button>
          <button v-if="seriesScope" :disabled="store.queryPending" @click="showUpdateResults">{{ $t("查看当前范围检查结果") }}</button>
          <!-- 都齐了就不出现：一个按下去只会说「无事可做」的按钮不如不在 -->
          <button
            v-if="!audioScope && missingPosterIds.length > 0"
            class="btn btn--subtle"
            :disabled="filling"
            :title="$t('补 {p0} 张海报', {p0: missingPosterIds.length})"
            @click="fillPosters"
          >
            <ImageDown :size="15" />
            {{ filling ? $t('补海报…') : $t('补海报 {p0}', {p0: missingPosterIds.length}) }}
          </button>
          <button v-if="!selecting || selectedWorks.length" type="button" :disabled="store.queryPending || bulkBusy || !(selecting ? selectedWorks : shownItems).length" @click="requestAgent">{{ $t("智能整理") }}</button>
          <button v-if="!selecting || selectedWorks.length" type="button" :disabled="store.queryPending || bulkBusy || scanning || !(selecting ? selectedWorks : shownItems).length" @click="requestLayout">{{ $t("统一移动") }}</button>
          </LibraryToolbarMenu>

        </div>
      </header>

      <div class="library-summary">
        <button v-if="seriesScope && scopedUpdateCount" class="btn btn--ghost" @click="showUpdateResults">{{ $t("{p0} 部作品有新集或文件缺失", {p0: (scopedUpdateCount)}) }}</button>
        <template v-if="selecting">
          <span role="status" :title="$t('Shift 点击可连选，仅操作当前结果')">{{ $t("已选 {p0} {p1}", {p0: (selectedWorks.length), p1: (audioScope ? $t('项音频') : $t('部作品'))}) }}</span>

          <button type="button" class="selection-action" :disabled="bulkBusy || store.queryPending" @click="selectAll">{{ $t("全选当前范围") }}</button>
          <button type="button" class="selection-action" :disabled="bulkBusy || !selectedWorks.length" @click="selectedIds = []">{{ $t("清空选择") }}</button>
        </template>
        <span v-else>{{ checkedVideoCount === null ? $t('媒体文件数待检查') : $t('当前范围已有 {p0} 个{p1}文件', {p0: checkedVideoCount, p1: audioScope ? $t('音频') : $t('视频')}) }}</span>
        <template v-if="pendingOnly && !selecting">
          <CircleAlert :size="13" /><span>{{ $t("待处理") }}</span>
          <select v-model="issue" class="select" :aria-label="$t('待处理问题类型')"><option value="any">{{ $t("全部问题") }}</option><option v-for="(label, key) in issueLabels" :key="key" :value="key">{{ label }}</option></select>
          <button type="button" @click="pendingOnly = false">{{ $t("返回全部作品") }}</button>
        </template>
        <div class="library-summary__actions">
          <button v-if="selecting && bulkOpen && selectedWorks.length" type="button" class="btn btn--ghost" :disabled="store.queryPending || bulkBusy || scanning || reviewingSelected || !selectedWorks.length" @click="reviewSelected">{{ reviewingSelected ? $t('正在复查…') : $t('智能复查所选') }}</button>
          <button v-if="pendingOnly && !selecting" type="button" :disabled="store.queryPending || bulkBusy" @click="selectReview">{{ $t("选择待复查作品") }}</button>
          <button v-if="selecting && selectedWorks.length" type="button" class="btn btn--ghost" :disabled="store.queryPending || bulkBusy || !selectedWorks.length" @click="organize('organize')">{{ audioScope ? $t('合并为专辑') : $t('创建合集') }}</button>


          <button v-if="!selecting && videoImport.pendingCount.value" type="button" class="import-pending" @click="videoImport.show()"><CircleAlert :size="13" />{{ $t("导入待确认 {p0}", {p0: (videoImport.pendingCount.value)}) }}</button>

        </div>
      </div>

      <p v-if="store.queryPending" class="query-status" role="status">{{ store.loadFailed ? $t('读取失败，刷新成功后可继续选择和操作。') : $t('正在更新查询结果，暂不可批量操作。') }} <button class="btn btn--ghost" :disabled="store.loading" @click="store.load()">{{ $t("刷新结果") }}</button></p>
      <VideoBulkPanel v-if="selecting && bulkOpen" :audio="audioScope" :ids="selectedWorks.map(item => item.id)" :pending="store.queryPending" :groups="(audioScope ? (store.counts.audio_collections || []) : [...(store.counts.collections || []), ...(store.inHentaiScope ? store.counts.hentai_collections || [] : [])]).map(g => g.name)" @busy="bulkBusy = $event" @changed="store.reload" @remove="requestRemoval" />
      <Transition name="fade">
        <div v-if="scanning" class="progress">
          <div class="progress__bar"><i :style="{ width: `${busyPercent}%` }" /></div>
          <span class="progress__text truncate">{{ busyText }}</span>
          <button class="btn btn--subtle" :disabled="!operation.running.value || operation.stopping.value || progress?.phase === 'done'" @click="cancelScan">{{ $t("停止") }}</button>
        </div>
      </Transition>

      <section ref="content" class="home__content" :aria-busy="store.loading">
        <AudioLibrary v-if="audioScope && (!store.queryPending || shownItems.length > 0)" :items="shownItems" :view="audioView" :selecting="selecting" :selected-ids="selectedIds" @open="openAudio" @select="selectWork"/><div v-else-if="shownItems.length > 0" :class="compact ? 'list' : 'wall'">
          <div v-for="v in shownItems" :key="v.id" class="work-group">
            <div class="work-card" :class="{ 'work-card--expanded': expanded[v.id] && !selecting }">
              <VideoCard :item="v" :show-published="store.sort === 'published' || store.sort === 'published-asc'" :status="itemStatus(v)" :recent="recentContent(v)" :selectable="selecting" :locked="store.queryPending || bulkBusy" :selected="selectedIds.includes(v.id)" @select="selectWork" @open="open" @poster-error="store.markPosterMissing" />
              <button v-if="v.episode_total > 1 && !selecting" class="collection-expand" :aria-expanded="!!expanded[v.id]" :aria-controls="'collection-' + v.id" @click="toggleCollection(v.id)">{{ expanded[v.id] ? $t('收起单集') : $t('展开 ') + v.episode_total + $t(' 集') }}</button>
            </div>
            <div v-if="expanded[v.id] && !selecting" :id="'collection-' + v.id" class="collection-episodes" role="group" :aria-label="(v.name_zh || v.file_name) + $t('的单集')"><p class="collection-episodes__title">{{ $t("《{p0}》共 {p1} 集", {p0: (v.name_zh || v.file_name), p1: (v.episode_total)}) }}</p>
              <VideoCard v-for="ep in matchingEpisodes(v.id)" :key="ep.id" :item="v" :episode="ep" @open="router.push({ name: 'video-detail', params: { id: v.id }, query: { episode: ep.id } })" />
              <p v-if="!matchingEpisodes(v.id).length" class="collection-empty">{{ $t("当前条件未命中单集；作品本身的资料匹配。") }}</p>
            </div>
          </div>
        </div>
        <div v-else-if="!store.queryPending" class="empty">
          <h2>{{ emptyHint.title }}</h2>
          <p>{{ emptyHint.desc }}</p>
          <button v-if="store.keyword || store.hasFilters || pendingOnly" class="btn btn--ghost" @click="clearLibraryFilters">{{ $t("清空筛选") }}</button>
        </div>
      </section>
    </main>
    <VideoRemovalDialog v-if="removing" :pending="store.queryPending" @busy="bulkBusy = $event" :resource-ids="selectedIds" @close="removing = false" @changed="selectedIds = []; store.reload()" />
    <DownloadPanel v-if="workflow.open.value" @close="workflow.open.value = false" />
    <VideoLayoutDialog v-if="layoutIds" :pending="store.queryPending" @busy="bulkBusy = $event" :ids="layoutIds" @close="layoutIds = null" @changed="store.reload" />
    <OrganizePanel v-if="organizeMode" :mode="organizeMode" :works="organizeWorks" :return-focus="organizeReturnFocus" @close="organizeMode = ''" @changed="store.reload" />
  </div>
</template>

<style scoped>
.query-status{flex:none;margin:0;padding:6px 20px;font-size:12px;color:var(--text-sub)}
.work-group, .work-card { min-width: 0; }
.wall .work-group { display: contents; }
.wall .collection-episodes { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; row-gap: 14px; padding-block: 12px 14px; margin-block: 2px 6px; border-block: 1px solid var(--divider); background: color-mix(in srgb, var(--bg-card) 68%, transparent); }
.collection-episodes__title { grid-column: 1 / -1; margin: 0; font-size: var(--fs-tag); color: var(--text-sub); }
.collection-expand { width: 100%; padding: 7px 9px; margin-top: 4px; border-radius: var(--radius-btn); color: var(--text-sub); font-size: 12px; transition: background var(--t-fast), color var(--t-fast); }
.collection-expand:hover, .work-card--expanded .collection-expand { background: var(--active-surface); color: var(--accent-ink, var(--accent)); }
.collection-empty { grid-column: 1 / -1; padding: 12px; color: var(--text-sub); font-size: var(--fs-tag); }
.home {
  display: flex;
  height: 100%;
  min-height: 0;
}

.home__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px 12px;
  flex-wrap: wrap;
}

.toolbar__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 120px;
}

.toolbar__title h1 {
  font-size: var(--fs-title);
  font-weight: 500;
  white-space: nowrap;
}

.toolbar__count {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.search {
  position: relative;
  flex: 1;
  max-width: 420px;
  display: flex;
  align-items: center;
}
.library-search { display:flex; align-items:center; gap:8px; flex:1; min-width:260px; }
.library-search .search { min-width:80px; max-width:none; }

.search__icon {
  position: absolute;
  left: 10px;
  color: var(--text-faint);
}

.search__input {
  width: 100%;
  height: 30px;
  padding: 0 30px 0 32px;
  border-radius: var(--radius-input);
  background: var(--bg-card);
  border: 1px solid var(--card-border);
  color: var(--text-main);
  font-size: var(--fs-body);
  text-overflow: ellipsis;
  outline: none;
}
.search__input:placeholder-shown {
  padding-right: 58px;
}
.search__input:focus {
  border-color: var(--accent);
}

.search__clear {
  position: absolute;
  right: 8px;
  color: var(--text-faint);
}
.search__clear:hover {
  color: var(--text-main);
}
.search__kbd {
  position: absolute;
  right: 10px;
  font: 10px var(--font-mono);
  color: var(--text-faint);
  border: 1px solid var(--divider);
  border-radius: 4px;
  padding: 2px 4px;
  pointer-events: none;
}


.toolbar__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

.select {
  height: 28px;
  padding: 0 6px;
  border-radius: var(--radius-tag);
  background: var(--bg-card);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  font-size: var(--fs-tag);
  outline: none;
}

.progress {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 20px 12px;
  padding: 10px 14px;
  border-radius: var(--radius-input);
  background: var(--bg-card);
  border: 1px solid var(--card-border);
}

.progress__bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--hover-surface);
  overflow: hidden;
}

.progress__bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 200ms ease;
}

.progress__text {
  flex: none;
  max-width: 40%;
  font-size: var(--fs-tag);
  color: var(--text-sub);
}

.home__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 20px 24px;
}

/* 海报墙。和游戏封面墙同一个格子尺寸 —— 两个库并排看时格子不该跳 */
.wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--card-min, 150px), 1fr));
  gap: 18px 14px;
  align-content: start;
}

.list { display: flex; flex-direction: column; gap: 2px; }
.list .work-card :deep(.card) { display: grid; grid-template-columns: 56px minmax(0, 1fr); align-items: center; gap: 12px; padding: 8px 10px; border-bottom: 1px solid var(--divider); }
.list .work-card :deep(.card__poster) { width: 56px; aspect-ratio: 2 / 3; border-radius: 4px; }
.list .work-card :deep(.card__initial) { font-size: 20px; }
.list .work-card :deep(.card__name), .list .work-card :deep(.card__meta) { min-width: 0; min-height: 0; }
.list .collection-episodes { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--card-min, 150px), 1fr)); gap: 18px 14px; padding-block: 14px; }
.card-size { width: 90px; accent-color: var(--accent); }

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  min-height: 280px;
  text-align: center;
}

.empty h2 {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 400;
  color: var(--text-sub);
}

.empty p {
  font-size: var(--fs-body);
  color: var(--text-faint);
}
.home { --text-faint: var(--text-sub); }
.library-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 20px 12px; font-size: var(--fs-tag); color: var(--text-sub); }
.library-summary button { margin-left: auto; color: var(--text-main); text-decoration: underline; }
.library-summary__actions { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.library-summary__actions button, .library-summary .selection-action { margin-left: 0; min-height: 28px; }
.library-summary__actions .import-pending { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); text-decoration: none; }
.library-summary button:disabled { opacity: .5; cursor: default; }
.scan-results { margin: 0 0 16px; padding: 12px; border: 1px solid var(--divider); border-radius: var(--radius-input); background: var(--bg-card); color: var(--text-sub); font-size: var(--fs-tag); }
.scan-results summary { cursor: pointer; color: var(--text-main); }
.scan-results > p { margin-top: 8px; line-height: 1.6; }
.scan-results ul { padding: 0; list-style: none; max-height: 260px; overflow-y: auto; }
.scan-results li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; padding: 10px 0; border-top: 1px solid var(--divider); overflow-wrap: anywhere; }
.scan-results li strong { color: var(--text-main); font-weight: 500; }
.scan-results__path { flex: 1; min-width: 0; font-family: var(--font-mono); }
.scan-results li p, .scan-results li small { flex-basis: 100%; line-height: 1.6; }
.scan-results li > div { display: flex; gap: 14px; }
.scan-results button { min-height: 28px; color: var(--text-main); text-decoration: underline; text-underline-offset: 3px; }
.home :is(button, input, select, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 1150px) {
  .library-search { order: 3; flex-basis: 100%; max-width: none; min-width:0; }
  .toolbar { gap: 10px; padding-inline: 16px; }
  .toolbar__title { min-width: 0; }
  .toolbar__title h1 { max-width: 130px; white-space: normal; overflow-wrap: anywhere; }
  .toolbar__actions { gap: 5px; flex-wrap: wrap; }
  .home__content { padding-inline: 16px; }
}
</style>
