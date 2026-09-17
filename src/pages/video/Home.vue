<script setup lang="ts">
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
import { CircleAlert, FolderPlus, ImageDown, Link, List, Search, Settings, X } from 'lucide-vue-next'
import Sidebar from '@/components/video/Sidebar.vue'
import VideoBulkPanel from '@/components/video/VideoBulkPanel.vue'
import VideoRemovalDialog from '@/components/video/VideoRemovalDialog.vue'
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
import { useVideoAgentOrganize } from '@/composables/useVideoAgentOrganize'
import { rangeSelection } from '@/utils/range-selection'
import { useVideoWorkflow, videoLibraryView, videoJobRetryStages } from '@/composables/useVideoWorkflow'
import { useVideoStore } from '@/stores/video'
import { debounce, errorMessage, shortenPath } from '@/utils'

const router = useRouter()
const store = useVideoStore()
const { toast, success, error } = useToast()

const content = ref<HTMLElement | null>(null)

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
const visibleItems = computed(() => store.items.filter(item => !privateHidden.value || item.category !== '里番'))
const issueLabels: Record<string, string> = { poster: '待补海报', files: '文件失联', metadata: '资料待补齐', download: '下载待处理', review: '归属待确认' }
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
const selecting = ref(false)
const selectedIds = ref<string[]>([])
const bulkOpen = ref(false)
const removing = ref(false)
const importing = computed(() => !!videoImport.busy.value)
// 手动展开和搜索自动展开分开记：自动展开只在有搜索 / 标签条件时存在，条件一清就整组收回；
// 之前混在一个集合里，清空搜索后 expanded[id] 仍是 true，watcher 再跑一遍等于永远收不回（B2）
const userExpanded = ref<Record<string, boolean>>({}), autoExpanded = ref<Record<string, boolean>>({})
const expandedEpisodes = ref<Record<string, VideoWorkContent[]>>({})
const expanded = computed<Record<string, boolean>>(() => ({ ...autoExpanded.value, ...userExpanded.value }))
async function loadEpisodes(id: string): Promise<VideoWorkContent[]> {
  try { return expandedEpisodes.value[id] = (await window.baoyi.video.library(id)).contents } catch (e) { error(errorMessage(e)); return [] }
}
async function toggleCollection(id: string) {
  const next = !expanded.value[id]
  userExpanded.value[id] = next
  if (!next) delete autoExpanded.value[id]
  if (next && !expandedEpisodes.value[id]) await loadEpisodes(id)
}
function matchingEpisodes(id: string, episodes = expandedEpisodes.value[id] || []): VideoWorkContent[] {
  const tag = store.selection.kind === 'tag' ? store.selection.value : ''
  const keyword = store.keyword.trim().toLocaleLowerCase()
  return episodes.filter(e => (!tag || e.tags?.includes(tag)) && (!keyword || [e.title,e.original_title,...e.tags || []].join(' ').toLocaleLowerCase().includes(keyword)))
}
const searching = computed(() => store.selection.kind === 'tag' || !!store.keyword.trim())
let expandRun = 0
watch(() => [shownItems.value, store.selection, store.keyword], async () => {
  // 关键词连着改时前一轮还在等 IPC，等它回来条件已经不是它算的那个了 —— 晚到的一轮直接作废
  const run = ++expandRun
  expandedEpisodes.value = {}
  autoExpanded.value = {}
  for (const item of shownItems.value) {
    if (item.episode_total <= 1 || (!userExpanded.value[item.id] && !searching.value)) continue
    const episodes = await loadEpisodes(item.id)
    if (run !== expandRun) return
    // 只有单集真的命中条件才自动展开；作品自身匹配而单集不匹配的，展开也只是一行空态
    if (!userExpanded.value[item.id] && matchingEpisodes(item.id, episodes).length) autoExpanded.value[item.id] = true
  }
})
const selectedWorks = computed(() => selectedIds.value.map(id => shownItems.value.find(item => item.id === id)).filter((item): item is VideoItem => !!item))
const organizeMode = ref<'organize' | 'history' | ''>('')
const organizeWorks = ref<VideoItem[]>([])
const organizeTrigger = ref<HTMLElement | null>(null)
const organizeReturnFocus = ref<HTMLElement | null>(null)
watch(() => shownItems.value.map(item => item.id), ids => { selectedIds.value = selectedIds.value.filter(id => ids.includes(id)) }, { flush: 'sync' })
watch(privateHidden, hidden => {
  if (hidden) organizeWorks.value = organizeWorks.value.filter(item => item.category !== '里番')
}, { flush: 'sync' })
const selectionAnchor = ref('')
function toggleSelecting(): void { bulkOpen.value = false; selecting.value = !selecting.value; selectedIds.value = []; selectionAnchor.value = '' }
function selectWork(id: string, event?: MouseEvent): void {
  if (!shownItems.value.some(item => item.id === id)) return
  selectedIds.value = rangeSelection(shownItems.value.map(item => item.id), selectedIds.value, id, selectionAnchor.value, event?.shiftKey)
  if (!event?.shiftKey || !selectionAnchor.value) selectionAnchor.value = id
}
function organize(mode: 'organize' | 'history'): void {
  if (mode === 'organize' && !selectedWorks.value.length) return
  organizeWorks.value = mode === 'organize' ? [...selectedWorks.value] : []
  organizeReturnFocus.value = mode === 'organize' ? organizeTrigger.value : document.activeElement as HTMLElement | null
  organizeMode.value = mode
}
function selectionKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !selecting.value || organizeMode.value) return
  event.preventDefault()
  selecting.value = false
  selectedIds.value = []
  organizeTrigger.value?.focus()
}
const checkedVideoCount = computed(() => shownItems.value.every(item => typeof item.available_files === 'number')
  ? shownItems.value.reduce((sum, item) => sum + (item.available_files ?? 0), 0) : null)
const heading = computed(() => privateHidden.value && store.inHentaiScope ? '影视库' : store.heading)
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
  if (active) return active.status === 'queued' ? '已排队' : '下载处理中'
  const reason = pendingReasons(item)[0]
  return reason ? issueLabels[reason] || reason : ''
}
function recentContent(item: VideoItem): string {
  const job = workflow.jobs.value.find(job => job.resourceId === item.id && job.items.some(value => value.transfer === 'complete'))
  return job?.items.filter(value => value.transfer === 'complete').at(-1)?.title || ''
}
function addFromLink(): void { workflow.open.value = true }
function togglePending(): void { pendingOnly.value = !pendingOnly.value }

const SORTS: Array<{ value: NonNullable<VideoQuery['sort']>; label: string }> = [
  { value: 'published', label: '最近发布' },
  { value: 'published-asc', label: '最早发布' },
  { value: 'added', label: '最近加入' },
  { value: 'updated', label: '最近更新' },
  { value: 'year', label: '按年份' },
  { value: 'rating', label: '按评分' },
  { value: 'name', label: '按名称' }
]

async function reviewSelected(): Promise<void> {
  if (scanning.value || reviewingSelected.value || !selectedWorks.value.length) return
  reviewingSelected.value = true
  let updated = 0, failed = 0
  try {
    const ready = await window.baoyi.video.readiness(true)
    if (!ready.ok) { toast(ready.message); return }
    for (const item of [...selectedWorks.value]) {
      if (privateHidden.value && item.category === '里番') break
      try { if (await reidentifyVideo(item, false)) updated++ }
      catch { failed++ }
      if (operation.stopping.value) break
    }
    await store.reload()
    toast(`复查${operation.stopping.value ? '已停止' : '完成'}：${updated} 部已更新` + (failed ? `，${failed} 部失败，详见任务日志` : ''))
  } catch (cause) { error(errorMessage(cause)) }
  finally { reviewingSelected.value = false }
}
async function openHanime(): Promise<void> {
  try { await window.baoyi.hanimeBrowser.open() }
  catch (cause) { error(errorMessage(cause)) }
}

onMounted(async () => {
  unlistenLibrary = window.baoyi.video.onLibraryChanged?.(requestLibraryRefresh)
  document.addEventListener('visibilitychange', resumeLibraryRefresh)
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
})

const busyText = computed(() => {
  const p = progress.value
  if (operation.stopping.value && operation.running.value) return '正在停止，等待当前任务收尾…'
  if (!p) return '准备中'
  if (p.phase === 'done') return '正在刷新资源库…'
  if (p.phase === 'scanning') return `正在扫描 ${shortenPath(p.current, 40)}`
  if (p.total <= 0) return `正在识别 · 已处理 ${p.processed} 项，总数待确定`
  return `识别 ${Math.min(p.processed + 1, p.total)}/${p.total}　${p.log || shortenPath(p.current, 32)}`
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

function cancelScan(): void {
  try { operation.cancel() }
  catch (err) { error('停止扫描失败：' + errorMessage(err)) }
}

async function importBundle(): Promise<void> {
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
    toast('这一屏的海报都齐了')
    return
  }
  filling.value = true
  try {
    await store.fillPosters(ids)
    // 补完再数一次：还缺的就是三条来路都没找着的那些，得让用户知道剩下要手动来
    const left = missingPosterIds.value.length
    if (left === 0) success(`补齐了 ${ids.length} 张海报`)
    else if (left < ids.length) toast(`补上 ${ids.length - left} 张，还有 ${left} 张没找到`)
    else toast('一张也没补上。检查一下 TMDB 配置，或者在详情页手动选图')
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
async function addVideos(): Promise<void> {
  if (!scanning.value) await videoImport.begin()
}

const emptyHint = computed(() => {
  if (pendingOnly.value) return { title: '当前范围暂无这类待处理作品', desc: '可切换问题类型或返回全部作品。' }
  if (store.hasFilters) return { title: '没有符合筛选条件的影视', desc: '调整发布时间或状态，或在筛选中清空条件。' }
  if (store.keyword.trim()) return { title: '没有匹配的影视', desc: '换个关键词，或清空搜索' }
  if (store.selection.kind === 'status')
    return { title: `「${store.heading}」里还没有影视`, desc: '在详情页可以改观看状态' }
  if (store.selection.kind === 'type')
    return { title: `还没有${store.heading}`, desc: '换一格看看，或者点右上角加影视' }
  if (store.counts.all === 0)
    return { title: '影视库还是空的', desc: '从链接添加作品，或扫描本地目录、导入资源包。' }
  return { title: '这里还没有内容', desc: '换个分类看看' }
})
</script>

<template>
  <div class="home" @keydown="selectionKey">
    <Sidebar :pending-active="pendingOnly" :pending-count="pendingItems.length" :private-hidden="privateHidden" @pending="togglePending" />

    <main class="home__main">
      <header class="toolbar">
        <div class="toolbar__title">
          <h1>{{ heading }}</h1>
          <span class="toolbar__count">{{ shownItems.length }} 部作品</span>
        </div>

        <div class="library-search">
        <button v-if="store.inHentaiScope && !privateHidden" class="btn btn--ghost hanime-entry" type="button" @click="openHanime">打开 Hanime</button>
        <div class="search">
          <Search :size="15" class="search__icon" />
          <input
            v-model="store.keyword"
            class="search__input"
            type="text"
            placeholder="搜索作品、内容标题或文件名"
            aria-label="搜索作品、内容标题或文件名"
            @input="onKeyword"
          />
          <button v-if="store.keyword" class="search__clear" title="清空搜索" aria-label="清空搜索" @click="clearKeyword">
            <X :size="14" />
          </button>
        </div>
        <VideoFilters :model-value="store.filters" @update:model-value="store.setFilters" />
        </div>

        <div class="toolbar__actions">
          <select v-model="store.sort" class="select" aria-label="作品排序" @change="store.load()">
            <option v-for="o in SORTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>

          <!-- 都齐了就不出现：一个按下去只会说「无事可做」的按钮不如不在 -->
          <button
            v-if="missingPosterIds.length > 0"
            class="btn btn--subtle"
            :disabled="filling"
            :title="`补 ${missingPosterIds.length} 张海报`"
            @click="fillPosters"
          >
            <ImageDown :size="15" />
            {{ filling ? '补海报…' : `补海报 ${missingPosterIds.length}` }}
          </button>

          <button class="btn btn--primary" @click="addFromLink"><Link :size="15" />从链接添加</button>
          <button class="btn btn--ghost" :disabled="scanning" @click="addVideos">
            <FolderPlus :size="15" />
            扫描本地
          </button>
          <button class="btn btn--subtle" title="导入视频目录或抱一资源包" :disabled="scanning || importing" @click="importBundle">
            <FolderPlus :size="15" /> {{ importing ? '导入中…' : '导入目录' }}
          </button>
          <button class="btn btn--subtle" @click="videoImport.show()">导入确认<template v-if="videoImport.pendingCount.value"> {{ videoImport.pendingCount.value }}</template></button>
          <button class="btn btn--subtle" :title="compact ? '海报视图' : '紧凑列表'" :aria-label="compact ? '海报视图' : '紧凑列表'" :aria-pressed="compact" @click="compact = !compact">
            <List :size="16" />
          </button>

          <button class="btn btn--subtle" title="设置" aria-label="设置" @click="router.push({ name: 'settings' })">
            <Settings :size="16" />
          </button>
        </div>
      </header>

      <div class="library-summary">
        <template v-if="selecting">
          <span role="status">已选 {{ selectedWorks.length }} 部作品</span>
          <span>Shift 点击可连选</span>
          <button type="button" class="selection-action" @click="selectedIds = shownItems.map(item => item.id)">全选当前范围</button>
          <button type="button" class="selection-action" :disabled="!selectedWorks.length" @click="selectedIds = []">清空选择</button>
        </template>
        <span v-else>{{ checkedVideoCount === null ? '视频文件数待检查' : `当前范围已有 ${checkedVideoCount} 个视频文件` }}</span>
        <template v-if="pendingOnly && !selecting">
          <CircleAlert :size="13" /><span>待处理</span>
          <select v-model="issue" class="select" aria-label="待处理问题类型"><option value="any">全部问题</option><option v-for="(label, key) in issueLabels" :key="key" :value="key">{{ label }}</option></select>
          <button type="button" @click="pendingOnly = false">返回全部作品</button>
        </template>
        <div class="library-summary__actions">
          <button v-if="selecting && bulkOpen" type="button" class="btn btn--ghost" :disabled="scanning || reviewingSelected || !selectedWorks.length" @click="reviewSelected">{{ reviewingSelected ? '正在复查…' : 'Agent 复查所选' }}</button>
          <button v-if="pendingOnly && !selecting" type="button" @click="toggleSelecting(); bulkOpen = true; selectedIds = shownItems.filter(item => item.needs_review).map(item => item.id)">选择待复查作品</button>
          <button v-if="selecting && !bulkOpen" type="button" class="btn btn--ghost" :disabled="!selectedWorks.length" @click="organize('organize')">下一步</button>
          <button type="button" :disabled="!shownItems.length" @click="videoAgent.show(selecting ? selectedWorks : shownItems)">Agent 整理</button>
          <button ref="organizeTrigger" type="button" :aria-pressed="selecting" @click="toggleSelecting">{{ selecting ? (bulkOpen ? '退出批量管理' : '取消选择') : '创建合集' }}</button>
          <button v-if="!selecting" type="button" @click="toggleSelecting(); bulkOpen = true">批量管理</button>
          <button v-if="!selecting" type="button" @click="organize('history')">整理记录</button>
        </div>
      </div>

      <VideoBulkPanel v-if="selecting && bulkOpen" :ids="selectedIds" :groups="[...(store.counts.collections || []), ...(store.inHentaiScope ? store.counts.hentai_collections || [] : [])].map(g => g.name)" @changed="store.reload" @remove="removing = true" />
      <Transition name="fade">
        <div v-if="scanning" class="progress">
          <div class="progress__bar"><i :style="{ width: `${busyPercent}%` }" /></div>
          <span class="progress__text truncate">{{ busyText }}</span>
          <button class="btn btn--subtle" :disabled="!operation.running.value || operation.stopping.value || progress?.phase === 'done'" @click="cancelScan">停止</button>
        </div>
      </Transition>

      <section ref="content" class="home__content" :aria-busy="store.loading">
        <div v-if="shownItems.length > 0" :class="compact ? 'list' : 'wall'">
          <div v-for="v in shownItems" :key="v.id" class="work-group">
            <div class="work-card">
              <VideoCard :item="v" :status="itemStatus(v)" :recent="recentContent(v)" :selectable="selecting" :selected="selectedIds.includes(v.id)" @select="selectWork" @open="open" @poster-error="store.markPosterMissing" />
              <button v-if="v.episode_total > 1 && !selecting" class="collection-expand" :aria-expanded="!!expanded[v.id]" :aria-controls="'collection-' + v.id" @click="toggleCollection(v.id)">{{ expanded[v.id] ? '收起单集' : '展开 ' + v.episode_total + ' 集' }}</button>
            </div>
            <div v-if="expanded[v.id] && !selecting" :id="'collection-' + v.id" class="collection-episodes" role="group" :aria-label="(v.name_zh || v.file_name) + '的单集'">
              <VideoCard v-for="ep in matchingEpisodes(v.id)" :key="ep.id" :item="v" :episode="ep" @open="router.push({ name: 'video-detail', params: { id: v.id }, query: { episode: ep.id } })" />
              <p v-if="!matchingEpisodes(v.id).length" class="collection-empty">当前条件未命中单集；作品本身的资料匹配。</p>
            </div>
          </div>
        </div>
        <div v-else-if="!store.loading" class="empty">
          <h2>{{ emptyHint.title }}</h2>
          <p>{{ emptyHint.desc }}</p>
        </div>
      </section>
    </main>
    <VideoRemovalDialog v-if="removing" :resource-ids="selectedIds" @close="removing = false" @changed="selectedIds = []; store.reload()" />
    <DownloadPanel v-if="workflow.open.value" @close="workflow.open.value = false" />
    <OrganizePanel v-if="organizeMode" :mode="organizeMode" :works="organizeWorks" :return-focus="organizeReturnFocus" @close="organizeMode = ''" @changed="store.reload" />
  </div>
</template>

<style scoped>
.work-group, .work-card { min-width: 0; }
.wall .work-group, .wall .collection-episodes { display: contents; }
.collection-expand { width: 100%; padding: 9px; color: var(--text-sub); font-size: 12px; }
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
.hanime-entry { flex:none; white-space:nowrap; }

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
  outline: none;
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
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 18px 14px;
  align-content: start;
}

.list { display: flex; flex-direction: column; gap: 2px; }
.list .work-card :deep(.card) { display: grid; grid-template-columns: 56px minmax(0, 1fr); align-items: center; gap: 12px; padding: 8px 10px; border-bottom: 1px solid var(--divider); }
.list .work-card :deep(.card__poster) { width: 56px; aspect-ratio: 2 / 3; border-radius: 4px; }
.list .work-card :deep(.card__initial) { font-size: 20px; }
.list .work-card :deep(.card__name), .list .work-card :deep(.card__meta) { min-width: 0; min-height: 0; }
.list .collection-episodes { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 18px 14px; padding-block: 14px; }

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
