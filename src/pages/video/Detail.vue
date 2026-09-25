<script setup lang="ts">
/**
 * 影视详情页。
 *
 * 重心和另两个品类都不同：软件那页答的是「我为什么留着它」，游戏那页答的是
 * 「它在磁盘上的哪些地方」，这一页答的是「我看到哪儿了，还缺什么」。
 * 所以季集表是主角 —— 它同时承担两件事：追进度，和暴露缺集。
 *
 * 缺集要露面，不能只列手上有的文件。TMDB 说这季 16 集而用户手里 8 个，
 * 那 8 个空位是这一页最有用的信息之一（见 types 里 Episode.path 的注释）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  Clapperboard,
  Download,
  ExternalLink,
  FolderOpen,
  Image,
  ImageDown,
  ImageOff,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  Star,
  Subtitles,
  Trash2
} from 'lucide-vue-next'
import EditableField from '@/components/ui/EditableField.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import DownloadPanel from '@/components/video/DownloadPanel.vue'
import VideoSourceDialog from '@/components/video/VideoSourceDialog.vue'
import VideoRemovalDialog from '@/components/video/VideoRemovalDialog.vue'
import VideoItems from '@/components/video/VideoItems.vue'
import VideoArtwork from '@/components/video/VideoArtwork.vue'
import VideoScopeSwitch from '@/components/video/VideoScopeSwitch.vue'
import OrganizePanel from '@/components/video/OrganizePanel.vue'
import CollectionNameDialog from '@/components/video/CollectionNameDialog.vue'
import EpisodeArtworkDialog from '@/components/video/EpisodeArtworkDialog.vue'
import { useVideoWorkflow } from '@/composables/useVideoWorkflow'
import { useToast } from '@/composables/useToast'
import { reidentifyVideo, useMediaScan } from '@/composables/useMediaScan'
import { WATCH_STATUS_LABEL, VIDEO_TYPE_LABEL, useVideoStore } from '@/stores/video'
import type { Episode, MediaTrack, VideoItem, WatchStatus } from '@/types'
import type { VideoWorkContent, VideoWorkLibrary } from '@/types/video-workflow'
import { videoDateLabel, videoEpisodeLabel, registeredVideoContent } from '@/utils/video-content'
const HENTAI_CATEGORY = '里番'
import {
  errorMessage,
  formatBytes,
  formatDate,
  formatDuration,
  formatPosition,
  formatRelative,
  posterUrl,
  PROTECTED_FIELD_LABEL,
  videoTitle
} from '@/utils'

const props = defineProps<{ id: string }>()

const router = useRouter()
const store = useVideoStore()
const { success, error, toast } = useToast()

const item = ref<VideoItem | null>(null)
const episodes = ref<Episode[]>([])
const loading = ref(true)
const library = ref<VideoWorkLibrary | null>(null)
const checking = ref(false)
const editing = ref(false)
const activeTab = ref<'contents' | 'description' | 'notes' | 'files'>('contents')
const sourceOpen = ref(false), episodeEditing = ref(false), removalEpisode = ref(''), removalWork = ref(false)
const selectedEpisodeId = ref('')
let readingScopeInitialized = false
const selectedEpisode = computed(() => library.value?.contents.find(episode => episode.id === selectedEpisodeId.value) ?? null)
const singleEpisode = computed(() => library.value?.contents.length === 1 ? library.value.contents[0] : null)
const publicationRange = computed(() => {
  const dates = (library.value?.contents || []).map(e => videoDateLabel(e.published_at || e.air_date)).filter(Boolean).sort()
  const first = dates[0] || videoDateLabel(item.value?.published_start), last = dates.at(-1) || videoDateLabel(item.value?.published_end)
  return { first, last, collection: (library.value?.contents.length || item.value?.episode_total || 0) > 1 }
})
const detailTabs = computed(() => [
  { id: 'contents' as const, label: '作品内容', count: library.value?.contents.length || 0 },
  { id: 'description' as const, label: '剧情简介' },
  { id: 'notes' as const, label: '个人笔记' },
  { id: 'files' as const, label: '文件与资料' }
])
const visibleTags = computed(() => [...new Set([...(item.value?.tags ?? []), ...(item.value?.hanime_tags ?? [])])].filter(tag => tag.trim() && !/^(add|remove)$/i.test(tag.trim())))
const tagsElement = ref<HTMLElement | null>(null)
const tagsExpanded = ref(false)
const tagsOverflow = ref(false)
const tagsHeight = ref(80)
const tagVisibleCount = ref(Infinity)
let tagsObserver: ResizeObserver | undefined
function measureTags(): void {
  const element = tagsElement.value
  if (!element) return
  const boxes = Array.from(element.children).map(child => (child as HTMLElement).getBoundingClientRect())
  const rows = [...new Set(boxes.map(box => Math.round(box.top)))].sort((a, b) => a - b)
  tagsOverflow.value = rows.length > 3
  tagVisibleCount.value = rows.length > 3 ? boxes.filter(box => Math.round(box.top) < rows[3]).length : boxes.length
  if (rows.length >= 3) tagsHeight.value = Math.ceil(Math.max(...boxes.filter(box => Math.round(box.top) === rows[2]).map(box => box.bottom)) - element.getBoundingClientRect().top)
}
watch(tagsElement, element => {
  tagsObserver?.disconnect()
  if (element) { tagsObserver = new ResizeObserver(measureTags); tagsObserver.observe(element); void nextTick(measureTags) }
})
watch(visibleTags, () => { tagsExpanded.value = false; void nextTick(measureTags) })
function showEpisode(episode: VideoWorkContent): void {
  selectedEpisodeId.value = episode.id
  activeTab.value = 'description'
  void nextTick(() => document.getElementById('video-tab-description')?.focus({ preventScroll: true }))
}
function tabKeydown(event: KeyboardEvent): void {
  const index = detailTabs.value.findIndex(tab => tab.id === activeTab.value)
  const target = event.key === 'ArrowRight' ? (index + 1) % detailTabs.value.length
    : event.key === 'ArrowLeft' ? (index + detailTabs.value.length - 1) % detailTabs.value.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.value.length - 1 : -1
  if (target < 0) return
  event.preventDefault()
  activeTab.value = detailTabs.value[target].id
  void nextTick(() => document.getElementById('video-tab-' + activeTab.value)?.focus())
}
async function scrapeSelected(): Promise<void> {
  if (!selectedEpisode.value?.source_url) { sourceOpen.value = true; return }
  busyEpisode.value = selectedEpisode.value.id
  try { const result = await window.baoyi.video.scrapeEpisode(props.id, selectedEpisode.value.id); await refreshLibrary(); success(result.warnings.length ? '资料已更新；' + result.warnings[0] : '已更新这一集的资料与图片') }
  catch (e) { error(errorMessage(e)) } finally { busyEpisode.value = '' }
}
async function pickEpisodeImage(role: 'poster' | 'thumbnail'): Promise<void> {
  if (!selectedEpisode.value) return
  try { if (await window.baoyi.video.pickEpisodeArtwork(selectedEpisode.value.id, role)) await refreshLibrary() }
  catch (e) { error(errorMessage(e)) }
}
async function saveEpisode(patch: Partial<Episode>): Promise<void> {
  if (!selectedEpisode.value || busyEpisode.value) return
  const episodeId = selectedEpisode.value.id, resourceId = props.id
  busyEpisode.value = episodeId
  try {
    const result = await window.baoyi.video.updateEpisode(episodeId, patch)
    if (resourceId !== props.id) return
    if (result.episode && library.value) {
      const index = library.value.contents.findIndex(episode => episode.id === episodeId)
      if (index >= 0) Object.assign(library.value.contents[index], result.episode)
    }
    store.merge(result.item)
    success('已保存这一集的资料')
  } catch (cause) { error('保存单集资料失败：' + errorMessage(cause)) }
  finally { busyEpisode.value = '' }
}
const loadError = ref('')
const moreMenu = ref<HTMLDetailsElement | null>(null)
const downloadFlow = computed(() => useVideoWorkflow(props.id))
const itemHidden = computed(() => item.value?.category === HENTAI_CATEGORY
  && (!downloadFlow.value.privacyReady.value || downloadFlow.value.hideHentai.value))
const organizeMode = ref<'relocate' | 'history' | ''>('')
const renameOpen = ref(false)
const episodeArtworkOpen = ref(false)
/** 单集里有图可选（封面或预览图任一）才显示「从单集选」 */
const episodeArtworkAvailable = computed(() => !!library.value?.contents.some(episode => episode.poster_path || episode.thumbnail_path))
const organizeReturnFocus = ref<HTMLElement | null>(null)
watch(itemHidden, hidden => {
  if (hidden) { organizeMode.value = ''; renameOpen.value = false; downloadFlow.value.reset() }
}, { flush: 'sync' })
let loadRound = 0
let unlistenLibrary: (() => void) | undefined

/** 「想看」排第一：这一列是从没看过往看完走的顺序，和侧栏那组的排序理由不同 */
const STATUSES: WatchStatus[] = ['unwatched', 'watching', 'watched', 'dropped']

async function load(): Promise<void> {
  const id = props.id
  const round = ++loadRound
  loading.value = true
  checking.value = false
  loadError.value = ''
  library.value = null
  try {
    const next = await window.baoyi.video.get(id)
    if (round !== loadRound) return
    const content = next ? await window.baoyi.video.library(id) : null
    if (round !== loadRound) return
    // Library normalization may repair a legacy directory record and episode counts.
    const normalized = content?.contents.length ? await window.baoyi.video.get(id) : next
    if (round !== loadRound) return
    item.value = normalized
    library.value = content
    episodes.value = content?.contents ?? []
  } catch (err) {
    if (round !== loadRound) return
    error(`读取影视条目失败：${errorMessage(err)}`)
    loadError.value = '读取影视条目失败：' + errorMessage(err)
    item.value = null
    episodes.value = []
  } finally {
    if (round === loadRound) loading.value = false
  }
}

async function refreshLibrary(): Promise<void> {
  const id = props.id
  const round = ++loadRound
  checking.value = true
  try {
    const content = await window.baoyi.video.library(id)
    const next = await window.baoyi.video.get(id)
    if (id !== props.id || round !== loadRound) return
    item.value = next
    library.value = content
    episodes.value = content.contents
    store.merge(next)
    void store.refreshCounts()
  } catch (err) { if (round === loadRound) error('检查文件失败：' + errorMessage(err)) }
  finally { if (round === loadRound) { checking.value = false; loading.value = false } }
}
const lastCheck = ref('')
async function checkFiles(): Promise<void> {
  if (checking.value) return
  checking.value = true
  const id = props.id, round = ++loadRound
  try {
    const result = await window.baoyi.video.syncFiles(id)
    const next = await window.baoyi.video.get(id)
    if (id !== props.id || round !== loadRound) return
    library.value = result.library; episodes.value = result.library.contents; item.value = next
    lastCheck.value = result.message
    store.merge(next); void store.reload()
    if (result.warnings.length) toast(result.message + '；' + result.warnings[0])
    else success(result.message)
  } catch (cause) { if (id === props.id) { lastCheck.value = '检查未完成：' + errorMessage(cause); error(lastCheck.value) } }
  finally { if (id === props.id && round === loadRound) checking.value = false }
}
function openDownload(): void {
  if (!item.value?.hanime_id) { sourceOpen.value = true; return }
  const flow = downloadFlow.value
  flow.open.value = true
  if (!flow.draft.value) void flow.prepare()
}
function openOrganize(mode: 'relocate' | 'history'): void {
  if (!item.value || itemHidden.value) return
  organizeReturnFocus.value = moreMenu.value?.querySelector('summary') ?? null
  if (moreMenu.value) moreMenu.value.open = false
  organizeMode.value = mode
}
function closeMore(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !moreMenu.value?.open) return
  event.preventDefault()
  event.stopPropagation()
  moreMenu.value.open = false
  moreMenu.value.querySelector('summary')?.focus()
}
async function markWatched(content: VideoWorkContent | null, status: WatchStatus): Promise<void> {
  if (content) await setEpisodeStatus(content, status)
  else await save({ watch_status: status })
  await refreshLibrary()
}
onMounted(() => {
  editing.value = router.currentRoute?.value.query.edit === '1'
  void load()
  unlistenLibrary = window.baoyi.video.onLibraryChanged(id => { if (id === props.id) void refreshLibrary() })
})
onBeforeUnmount(() => { loadRound++; unlistenLibrary?.(); tagsObserver?.disconnect() })
watch(() => router.currentRoute?.value.query.edit, value => { editing.value = value === '1' })
watch(() => props.id, () => {
  organizeMode.value = ''
  renameOpen.value = false
  activeTab.value = 'contents'
  selectedEpisodeId.value = ''
  readingScopeInitialized = false
  lastCheck.value = ''
  tagsExpanded.value = false
  editing.value = router.currentRoute?.value.query.edit === '1'
  if (moreMenu.value) moreMenu.value.open = false
  void load()
})
watch(() => library.value?.contents, contents => {
  if (!contents) return
  const registered = contents.filter(registeredVideoContent)
  if (registered.length !== contents.length) {
    library.value = { ...library.value!, contents: registered }; episodes.value = registered
    return
  }
  if (selectedEpisodeId.value && !contents.some(episode => episode.id === selectedEpisodeId.value)) selectedEpisodeId.value = ''
  if (readingScopeInitialized) return
  readingScopeInitialized = true
  const requestedEpisode = router.currentRoute.value.query.episode
  if (!selectedEpisodeId.value && typeof requestedEpisode === 'string' && contents.some(e => e.id === requestedEpisode)) { selectedEpisodeId.value = requestedEpisode; activeTab.value = 'description' }
  if (!selectedEpisodeId.value && contents.length === 1) selectedEpisodeId.value = contents[0].id
})

const title = computed(() => (item.value ? videoTitle(item.value) : ''))
const initial = computed(() => title.value.trim().charAt(0).toUpperCase() || '?')

const hue = computed(() => {
  let h = 0
  for (const ch of title.value) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
})

const isSeries = computed(() => item.value?.video_type === 'series')

/** 「2019」或者「2019 – 2022」。还在播的剧只显示起点 */
const yearText = computed(() => {
  const v = item.value
  if (!v || !v.year) return ''
  if (v.end_year && v.end_year !== v.year) return `${v.year} – ${v.end_year}`
  return String(v.year)
})

/* ---------------------------- 海报 ---------------------------- */

const poster = computed(() =>
  item.value ? posterUrl(item.value.poster_path, item.value.updated_at) : ''
)
const posterFailed = ref(false)
watch(poster, () => { posterFailed.value = false })

const posterBusy = ref(false)
const videoScan = useMediaScan('video')
const refreshingIdentify = ref(false)
const reidentifying = computed(() => refreshingIdentify.value || videoScan.running.value)

/**
 * 三条来路依次试。判断在主进程里，这儿只负责把结果说清楚 ——
 * 「同目录找到了」和「从 TMDB 下的」对用户是两件事，消息由那边给。
 */
async function fetchPoster(): Promise<void> {
  if (!item.value || posterBusy.value) return
  posterBusy.value = true
  try {
    const r = await window.baoyi.video.fetchPoster(item.value.id)
    if (r.item) item.value = r.item
    store.merge(r.item)
    if (r.ok) success(r.message)
    else error(r.message)
  } catch (err) {
    error(`找海报失败：${errorMessage(err)}`)
  } finally {
    posterBusy.value = false
  }
}

async function pickPoster(): Promise<void> {
  if (!item.value) return
  const r = await window.baoyi.video.pickPoster(item.value.id)
  if (!r) return
  if (!r.ok) {
    error(r.message)
    return
  }
  if (r.item) item.value = r.item
  store.merge(r.item)
  success(r.message)
}

async function clearPoster(): Promise<void> {
  if (!item.value?.poster_path) return
  const ok = window.confirm(
    '撤掉这张海报？\n\n' +
      '会退回首字占位。你原来那张图不受影响，删掉的是抱一自己存的那份拷贝。'
  )
  if (!ok) return
  const updated = await window.baoyi.video.clearPoster(item.value.id)
  if (updated) item.value = updated
  store.merge(updated)
}

async function reidentify(forceHentai: boolean): Promise<void> {
  if (!item.value || reidentifying.value) return
  const target = item.value
  refreshingIdentify.value = true
  try {
    const updated = await reidentifyVideo(target, forceHentai)
    if (updated) {
      // 等待 IPC 时可以切换条目；旧结果只入库，不覆盖当前详情。
      if (item.value?.id === target.id) item.value = updated
      store.merge(updated)
      success(forceHentai ? '里番刮削完成' : '重新识别完成')
    } else {
      toast('重新识别已停止，已完成的结果保留')
    }
  } catch (err) {
    error('识别失败：' + errorMessage(err))
  } finally {
    refreshingIdentify.value = false
  }
}

/* ---------------------------- 保存 ---------------------------- */

/**
 * 点一个标签 = 回海报墙，只看挂着这个标签的作品。
 *
 * 顺序要紧：先 `select` 再 `push`。反过来的话海报墙会先用上一次的筛选条件
 * 渲染一帧，然后跳变 —— 用户看到的是「点了标签，先闪一下全部，再筛好」。
 *
 * 这条路对里番和普通片一视同仁 —— 站方标签（巨乳、女教師）和 TMDB 题材词
 * （悬疑、科幻）在库里是同一张标签表，没有理由让它们的点击行为不一样。
 */
function filterByTag(tag: string): void {
  store.select({
    kind: 'tag',
    value: tag,
    ...(item.value?.category === HENTAI_CATEGORY ? { type: 'hentai' as const } : {})
  })
  void router.push({ name: 'video-home' })
}

/** 走 store 而不是直接调 IPC：海报墙和侧边栏计数要跟着一起更新 */
async function changeType(value: string): Promise<void> {
  if (!item.value) return
  if (value === 'hentai') await save({ category: HENTAI_CATEGORY })
  else if (value === 'movie' || value === 'series') await save({ video_type: value, ...(item.value.category === HENTAI_CATEGORY ? { category: '其他' } : {}) })
}

async function save(patch: Partial<VideoItem>): Promise<void> {
  if (!item.value) return
  try {
    const updated = await store.update(item.value.id, patch)
    if (updated) item.value = updated
  } catch (err) {
    error(`保存失败：${errorMessage(err)}`)
  }
}

function commitTags(raw: string): void {
  // 中英文逗号、顿号都认，同游戏那边
  const tags = [
    ...new Set(
      raw
        .split(/[,，、]/)
        .map((t) => t.trim())
        .filter(Boolean)
    )
  ].slice(0, 8)
  void save({ tags })
}

function toggleArchive(): void {
  if (!item.value) return
  void save({ is_archived: !item.value.is_archived })
}

/* ------------------------- 改过的字段 ------------------------- */

/**
 * 用户改过、因而重扫时会被保留的字段。
 *
 * 兜底成裸字段名而不是丢掉：真漏了标签的时候，显示 `douban_rating` 也比
 * 那一行凭空消失好 —— 后者会让用户以为保护没生效。自检里有一条盯着别漏。
 */
const editedFields = computed(() =>
  (item.value?.user_edited ?? []).map((field) => ({
    field,
    label: PROTECTED_FIELD_LABEL[field] ?? field
  }))
)

/** 传空数组 = 全撤。不改值，只改「下次重扫要不要写这一栏」 */
async function unprotect(fields: string[]): Promise<void> {
  if (!item.value) return
  try {
    const updated = await store.restoreScraped(item.value.id, fields)
    if (updated) item.value = updated
  } catch (err) {
    error(`取消保留失败：${errorMessage(err)}`)
  }
}

const busyEpisode = ref('')

/**
 * 改一集的观看状态。
 *
 * 条目那一行跟着回来 —— 标完最后一集，整部剧会自动变成「看完」，
 * 而那句「3/12 集」和侧栏计数都长在条目上。分两趟拿的话中间会闪一个矛盾的数。
 */
async function setEpisodeStatus(e: Episode, status: WatchStatus): Promise<void> {
  if (busyEpisode.value) return
  busyEpisode.value = e.id
  try {
    const r = await window.baoyi.video.updateEpisode(e.id, { watch_status: status })
    if (r.episode) {
      const i = episodes.value.findIndex((x) => x.id === e.id)
      // These objects also belong to library.contents; IPC returns only episode fields.
      if (i >= 0) Object.assign(episodes.value[i], r.episode)
    }
    if (r.item) item.value = r.item
    store.merge(r.item)
    // 一集的状态变化会挪动整部剧在侧栏的位置
    void store.refreshCounts()
  } catch (err) {
    error(`改这一集失败：${errorMessage(err)}`)
  } finally {
    busyEpisode.value = ''
  }
}

/* ---------------------------- 杂项 ---------------------------- */

const trackText = (t: MediaTrack): string =>
  [t.label || t.language || '未知', t.codec].filter(Boolean).join(' · ')

async function reveal(): Promise<void> {
  if (!item.value) return
  await window.baoyi.video.revealInFolder(item.value.id)
}

/* ---------------------------- 播放 ---------------------------- */

const playing = ref(false)
const hasVideo = (content: VideoWorkContent) => content.assets.some(asset => asset.role === 'video' && asset.state === 'present')
// 正在看哪一集的简介，顶部「播放」就开哪一集（实测第三轮）：之前只按观看进度挑，看着第二集简介想播放
// 得先切回「作品内容」页。没选集（作品简介）或选中的那集没文件时才按进度挑
const resumeContent = computed(() => {
  if (selectedEpisode.value && hasVideo(selectedEpisode.value)) return selectedEpisode.value
  const available = library.value?.contents.filter(hasVideo) ?? []
  return available.find(content => content.position_sec > 0 && content.watch_status !== 'watched')
    ?? available.find(content => content.watch_status !== 'watched' && content.watch_status !== 'dropped') ?? available[0]
})
const resumeAsset = computed(() => {
  const content = resumeContent.value
  if (content) return content.assets.find(asset => asset.role === 'video' && asset.path === content.path && asset.state === 'present') ?? content.assets.find(asset => asset.role === 'video' && asset.state === 'present')
  return library.value?.assets.find(asset => asset.role === 'video' && asset.path === item.value?.path && asset.state === 'present')
    ?? library.value?.assets.find(asset => asset.role === 'video' && asset.state === 'present')
})
const playable = computed(() => !!resumeAsset.value)
const presentCount = computed(() => library.value?.assets.filter(asset => asset.role === 'video' && asset.state === 'present').length ?? 0)
const playLabel = computed(() => (library.value?.contents.length ?? 0) > 1 && resumeContent.value
  ? '播放 ' + (resumeContent.value.display_label || resumeContent.value.title || '内容') : '播放')
const playHint = computed(() => resumeAsset.value ? '用系统播放器打开：' + resumeAsset.value.path : '没有可用文件，可检查磁盘或重新定位文件')
async function play(): Promise<void> {
  if (!resumeAsset.value || playing.value) return
  playing.value = true
  try {
    const outcome = await window.baoyi.video.playAsset(resumeAsset.value.id)
    if (!outcome.ok) error(outcome.message || '无法打开文件')
    store.merge(outcome.item)
    await refreshLibrary()
  } catch (cause) { error(errorMessage(cause)) }
  finally { playing.value = false }
}
/* ---------------------------- 字幕 ---------------------------- */

/**
 * 内嵌轨和外挂文件分开列。
 *
 * 这个区别对用户是有行动含义的：外挂字幕能换、能删、能自己改时间轴，
 * 内嵌的做不到（得重新封装）。混在一行里显示的话，「字幕不对」的时候
 * 用户不知道自己是不是有救。判据是 `path` 非空 / `index === -1`，
 * 见 types 里 MediaTrack 的注释。
 */
const embeddedSubs = computed(() => (item.value?.subtitle_tracks ?? []).filter((t) => !t.path))
const externalSubs = computed(() => (item.value?.subtitle_tracks ?? []).filter((t) => !!t.path))

async function revealSub(target: string): Promise<void> {
  if (!item.value) return
  const ok = await window.baoyi.video.revealSubtitle(item.value.id, target)
  if (!ok) error('这个字幕文件不在了')
}

function openUrl(url: string): void {
  if (url) window.open(url, '_blank')
}

const tmdbUrl = computed(() => {
  const v = item.value
  if (!v?.tmdb_id) return ''
  return `https://www.themoviedb.org/${v.video_type === 'series' ? 'tv' : 'movie'}/${v.tmdb_id}`
})

const doubanUrl = computed(() =>
  item.value?.douban_id ? `https://movie.douban.com/subject/${item.value.douban_id}/` : ''
)
/**
 * hanime 条目页。和上面两个同一个写法：只存 id，地址从 id 拼。
 *
 * 那个按钮只在有 id 时才出现（不是 disabled 着摆在那儿）—— 普通片库里
 * 每部片旁边挂一个永远点不动的「hanime」按钮，是在给绝大多数用户添一个
 * 他不需要也不想看见的东西。TMDB 和豆瓣不同：那两个对任何片子都可能有条目，
 * 灰着摆在那儿表示「还没匹配上」，是有意义的状态。
 */
const hanimeUrl = computed(() =>
  item.value?.hanime_id ? `https://hanime1.me/watch?v=${item.value.hanime_id}` : ''
)

function removeItem(): void { removalWork.value = true }
async function afterRemoval(): Promise<void> {
  await store.reload()
  if (removalWork.value || !await window.baoyi.video.get(props.id)) {
    success('已从库里移除'); void router.push({ name: 'video-home' }); return
  }
  await refreshLibrary()
}

function copyPath(path: string): void {
  void window.baoyi.app.copyText(path)
  toast('路径已复制')
}
</script>

<template>
  <div class="detail">
    <div v-if="loading" class="detail__state">载入中…</div>
    <div v-else-if="!item || itemHidden" class="detail__state">
      <p role="status">{{ itemHidden ? '当前作品已隐藏。' : loadError || '这条记录不存在、已被移除或当前不可见。' }}</p>
      <button v-if="loadError" class="btn btn--ghost" @click="load">重新加载</button>
      <button class="btn btn--ghost" @click="router.push({ name: 'video-home' })">
        返回影视库
      </button>
    </div>

    <template v-else>
      <header class="head">
        <button class="btn btn--subtle" @click="router.push({ name: 'video-home' })">
          <ArrowLeft :size="16" />
          返回影视库
        </button>

        <div class="head__actions">
          <!--
            播放交给系统默认播放器。拿不到播放进度是明说的取舍（外部播放器
            不回报任何东西，见 v0.7-进度.md），不是没做完 —— 所以按钮上
            那句 title 直说「开哪一集」，不暗示它会跟着进度走
          -->
          <!-- detail__play 不带样式，是给真机验证脚本的抓手：按 .btn--primary
               选会在页面上多一个主按钮的那天悄悄选错 -->
          <button
            class="btn btn--primary detail__play"
            :disabled="playing || !playable"
            :title="playHint"
            @click="play"
          >
            <Play :size="14" />
            {{ playing ? '正在打开…' : playLabel }}
          </button>
          <button class="btn btn--ghost" @click="reveal">
            <FolderOpen :size="14" />
            打开所在文件夹
          </button>
          <button class="btn btn--ghost" @click="openDownload"><Download :size="14" />下载 / 补齐内容</button>
          <details ref="moreMenu" class="head__more" @keydown="closeMore">
            <summary class="btn btn--ghost" aria-label="更多作品操作"><MoreHorizontal :size="16" />更多</summary>
            <div class="head__moreMenu">
          <button class="btn btn--ghost" @click="openOrganize('relocate')"><FolderOpen :size="14" />目录管理 / 重新绑定</button>
          <button v-if="library?.directory" class="btn btn--ghost" @click="renameOpen = true; moreMenu && (moreMenu.open = false)"><Pencil :size="14" />修改合集名称</button>
          <button
            class="btn btn--ghost"
            :disabled="!tmdbUrl"
            :title="tmdbUrl || '没有 TMDB 条目'"
            @click="openUrl(tmdbUrl)"
          >
            <ExternalLink :size="14" />
            TMDB
          </button>
          <button
            class="btn btn--ghost"
            :disabled="!doubanUrl"
            :title="doubanUrl || '没匹配到豆瓣条目'"
            @click="openUrl(doubanUrl)"
          >
            <ExternalLink :size="14" />
            豆瓣
          </button>
          <button v-if="hanimeUrl" class="btn btn--ghost" :title="hanimeUrl" @click="openUrl(hanimeUrl)">
            <ExternalLink :size="14" />
            hanime
          </button>
          <button
            v-if="item.official_url && item.official_url !== hanimeUrl"
            class="btn btn--ghost"
            :title="item.official_url"
            @click="openUrl(item.official_url)"
          >
            <ExternalLink :size="14" />
            来源
          </button>
          <button class="btn btn--ghost" :disabled="reidentifying" @click="reidentify(false)">
            <component :is="reidentifying ? Loader2 : RefreshCw" :size="14" :class="{ spin: reidentifying }" />
            重新识别
          </button>
          <button
            class="btn btn--ghost"
            :disabled="reidentifying"
            title="强制按里番刮削（即使文件名不像）"
            @click="reidentify(true)"
          >
            <component :is="reidentifying ? Loader2 : RefreshCw" :size="14" :class="{ spin: reidentifying }" />
            按里番刮削
          </button>
          <button class="btn btn--ghost" @click="toggleArchive">
            <component :is="item.is_archived ? ArchiveRestore : Archive" :size="14" />
            {{ item.is_archived ? '取消归档' : '归档' }}
          </button>
          <button class="btn btn--danger" @click="removeItem">
            <Trash2 :size="14" />
            移除
          </button>
            </div>
          </details>
        </div>
      </header>

      <VideoSourceDialog v-if="sourceOpen" :item="item" :episodes="library?.contents || []" :episode-id="selectedEpisodeId" @close="sourceOpen = false" @changed="refreshLibrary" />
      <VideoRemovalDialog v-if="removalEpisode || removalWork" :resource-ids="[item.id]" :episode-id="removalEpisode || undefined" @close="removalEpisode = ''; removalWork = false" @changed="afterRemoval" />
      <CollectionNameDialog v-if="renameOpen" :item="item" @close="renameOpen = false" @changed="refreshLibrary" />
      <EpisodeArtworkDialog v-if="episodeArtworkOpen" :item="item" :episodes="library?.contents || []" :without-season="item.category === HENTAI_CATEGORY" @close="episodeArtworkOpen = false" @changed="refreshLibrary" />
      <div class="body">
        <!-- ------------------------------ 主列 ------------------------------ -->
        <div class="col col--main">
          <section class="hero panel">
            <!-- 海报区自己是那几个按钮的入口，悬停才显形，同游戏详情页 -->
            <div class="hero__poster" :style="{ '--hue': hue }">
              <img v-if="poster && !posterFailed" :src="poster" :alt="title" class="hero__img"
                @error="posterFailed = true; store.markPosterMissing(item.id)" />
              <span v-else class="hero__initial">{{ initial }}</span>

              <div class="hero__posterActs">
                <button
                  class="hero__posterBtn"
                  :disabled="posterBusy"
                  title="按顺序找：同目录的海报图 → 刮削时记下的 TMDB 图"
                  @click="fetchPoster"
                >
                  <Loader2 v-if="posterBusy" :size="13" class="spin" />
                  <ImageDown v-else :size="13" />
                  {{ posterBusy ? '找着' : '找海报' }}
                </button>
                <button
                  class="hero__posterBtn"
                  :title="item.poster_path ? '换一张海报' : '选一张海报图'"
                  @click="pickPoster"
                >
                  <Image :size="13" />
                  {{ item.poster_path ? '换' : '选图' }}
                </button>
                <button
                  v-if="item.poster_path"
                  class="hero__posterBtn"
                  title="撤掉海报，退回首字占位"
                  aria-label="撤掉海报"
                  @click="clearPoster"
                >
                  <ImageOff :size="13" />
                </button>
                <button
                  v-if="episodeArtworkAvailable"
                  class="hero__posterBtn hero__posterBtn--wide"
                  title="从这部作品的单集封面 / 预览图里挑一张当作品封面"
                  @click="episodeArtworkOpen = true"
                >
                  <Clapperboard :size="13" />
                  从单集选
                </button>
              </div>
            </div>

            <div class="hero__text">
              <template v-if="editing">
              <textarea
                class="hero__name"
                aria-label="片名"
                rows="2"
                :value="item.name_zh"
                placeholder="片名"
                @change="save({ name_zh: ($event.target as HTMLTextAreaElement).value.trim() })"
              />
              <input
                class="hero__en"
                aria-label="原名 / 英文名"
                :value="item.name_en"
                placeholder="原名 / 英文名"
                @change="save({ name_en: ($event.target as HTMLInputElement).value.trim() })"
              />
              </template>
              <template v-else>
                <div class="hero__title-line"><h1 class="hero__title">{{ title }}</h1><span class="hero__badge"><Clapperboard :size="12" />{{ item.category === HENTAI_CATEGORY ? '里番' : VIDEO_TYPE_LABEL[item.video_type] }}</span></div>
                <p v-if="item.name_en && item.name_en !== title" class="hero__original">{{ item.name_en }}</p>
              </template>

              <div class="hero__meta">
                <span v-if="yearText">{{ yearText }}</span>
                <span v-if="singleEpisode?.air_date">发行 {{ videoDateLabel(singleEpisode.air_date) }}</span>
                <span v-if="singleEpisode?.published_at">站点发布日期 {{ videoDateLabel(singleEpisode.published_at) }}</span>
                <span v-if="publicationRange.collection" class="hero__publication">发布时间：最早 {{ publicationRange.first || '未知' }} · 最晚 {{ publicationRange.last || '未知' }}</span>
                <span v-else-if="!singleEpisode?.published_at && !singleEpisode?.air_date" class="hero__publication">发布时间：{{ publicationRange.first || '未知' }}</span>
                <span v-if="item.resolution">{{ item.resolution }}</span>
                <span>{{ presentCount }} 个视频文件可用</span>
                <span v-if="!isSeries && item.duration_sec > 0">
                  {{ formatDuration(item.duration_sec) }}
                </span>
                <!-- 两个评分并列且各自标出处：合成一个数就没法诚实说它是哪儿来的 -->
                <span v-if="item.rating > 0" class="hero__rating" title="TMDB 评分">
                  <Star :size="11" />
                  {{ item.rating.toFixed(1) }}
                </span>
                <span v-if="item.douban_rating > 0" class="hero__rating" title="豆瓣评分（搜索摘要里的快照，可能不是最新）">
                  豆 {{ item.douban_rating.toFixed(1) }}
                </span>
              </div>

              <input
                v-if="editing"
                class="hero__summary"
                aria-label="一句话说明"
                :value="item.summary"
                placeholder="一句话说明"
                @change="save({ summary: ($event.target as HTMLInputElement).value.trim() })"
              />
              <p v-else-if="item.summary" class="hero__summary-text">{{ item.summary }}</p>

              <div class="statuses" role="group" aria-label="作品观看状态">
                <button
                  v-for="s in STATUSES"
                  :key="s"
                  class="chip"
                  :class="{ on: item.watch_status === s }"
                  :aria-pressed="item.watch_status === s"
                  @click="save({ watch_status: s })"
                >
                  {{ WATCH_STATUS_LABEL[s] }}
                </button>
                <button class="btn btn--subtle hero__edit" type="button" :aria-pressed="editing" @click="editing = !editing"><Check v-if="editing" :size="13" /><Pencil v-else :size="13" />{{ editing ? '完成编辑' : '编辑资料' }}</button>
              </div>
              <button v-if="library?.directory?.path || item.path" class="hero__location" type="button" :title="'复制作品位置：' + (library?.directory?.path || item.path)" @click="copyPath(library?.directory?.path || item.path)"><FolderOpen :size="12" /><span>{{ library?.directory?.path || item.path }}</span></button>
            </div>
            <aside class="hero__facts" aria-label="作品信息">
              <span v-if="item.category && item.category !== HENTAI_CATEGORY" class="hero__category">{{ item.category }}</span>
              <label v-if="editing" class="hero__field">类型<select class="input" aria-label="视频类型" :value="item.category === HENTAI_CATEGORY ? 'hentai' : item.video_type" @change="changeType(($event.target as HTMLSelectElement).value)"><option value="movie">电影</option><option value="series">剧集</option><option value="hentai">里番</option></select></label>
              <label v-if="editing && item.category !== HENTAI_CATEGORY" class="hero__field">分类<input class="input" :value="item.category" list="video-category-options" aria-label="视频分类" @change="save({ category: ($event.target as HTMLInputElement).value.trim() })" /></label>
              <datalist id="video-category-options"><option v-for="name in ['华语', '欧美', '日韩', '动画', '纪录片', '综艺', '其他']" :key="name" :value="name" /></datalist>
              <div class="hero__tag-heading">作品标签<span v-if="(library?.contents.length || 0) > 1"> · 各集标签独立保存</span></div>
              <div v-if="visibleTags.length" class="hero__tag-area">
                <div id="video-work-tags" ref="tagsElement" class="tags hero__tags" :style="{ maxHeight: tagsExpanded ? 'none' : tagsHeight + 'px' }"><TagBadge v-for="(tag, index) in visibleTags" :key="tag" :label="tag" clickable :inert="!tagsExpanded && index >= tagVisibleCount" :aria-hidden="!tagsExpanded && index >= tagVisibleCount ? true : undefined" :title="`看所有「${tag}」的作品`" @click="filterByTag(tag)" /></div>
                <button v-if="tagsOverflow" class="hero__tags-more" type="button" :aria-expanded="tagsExpanded" aria-controls="video-work-tags" :aria-label="tagsExpanded ? '收起标签' : '展开全部标签'" @click="tagsExpanded = !tagsExpanded">{{ tagsExpanded ? '收起' : '...' }}</button>
              </div>
              <p v-else class="hero__empty-tags">暂无标签</p>
              <EditableField v-if="editing" :model-value="item.tags.join('、')" placeholder="用「、」隔开，最多 8 个" @commit="commitTags" />
              <p v-if="library?.contents.length" class="hero__progress">已看 {{ library.contents.filter(episode => episode.watch_status === 'watched').length }} / {{ library.contents.length }} 集</p>
            </aside>
          </section>

          <nav class="detail-tabs no-select" role="tablist" aria-label="影视详情" @keydown="tabKeydown">
            <button v-for="tab in detailTabs" :id="'video-tab-' + tab.id" :key="tab.id" type="button" role="tab" :aria-selected="activeTab === tab.id" :aria-controls="'video-panel-' + tab.id" :tabindex="activeTab === tab.id ? 0 : -1" @click="activeTab = tab.id">{{ tab.label }}<span v-if="tab.count">{{ tab.count }}</span></button>
          </nav>
          <div id="video-panel-contents" v-show="activeTab === 'contents'" role="tabpanel" aria-labelledby="video-tab-contents" tabindex="0">
            <VideoItems :item="item" :library="library" :checking="checking" :check-message="lastCheck" :marking="!!busyEpisode" :selected-id="selectedEpisodeId" @select="showEpisode" @remove="removalEpisode = $event.id" @check="checkFiles" @changed="refreshLibrary" @watched="markWatched" />
          </div>

          <section id="video-panel-description" v-show="activeTab === 'description'" class="panel episode-reading" role="tabpanel" aria-labelledby="video-tab-description" tabindex="0">
            <header class="episode-reading__head">
              <div><h2>{{ selectedEpisode ? videoEpisodeLabel(selectedEpisode, item.category === '里番') : '作品简介' }}</h2><p>{{ selectedEpisode ? '这一集的故事与资料' : '整部作品的介绍' }}</p></div>
              <VideoScopeSwitch v-if="library?.contents.length" v-model="selectedEpisodeId" :episodes="library.contents" :without-season="item.category === '里番'" />
            </header>
            <template v-if="selectedEpisode">
              <div class="episode-actions"><button class="btn btn--primary" :disabled="playing || !hasVideo(selectedEpisode)" :title="playHint" @click="play"><Play :size="13" />{{ playing ? '正在打开…' : '播放这一集' }}</button><button class="btn btn--subtle" @click="episodeEditing = !episodeEditing">{{ episodeEditing ? '完成单集编辑' : '编辑这一集' }}</button><button class="btn btn--subtle" :disabled="!!busyEpisode" @click="scrapeSelected">{{ busyEpisode ? '正在刮削…' : '单集刮削' }}</button><button class="btn btn--ghost" @click="sourceOpen = true">更改来源</button><button class="btn btn--ghost" @click="pickEpisodeImage('poster')">选择封面</button><button class="btn btn--ghost" @click="pickEpisodeImage('thumbnail')">选择预览图</button><button class="btn btn--ghost" @click="removalEpisode = selectedEpisode.id">移除 / 移出合集…</button></div>
              <div class="episode-summary" :class="{ 'episode-summary--text-only': !selectedEpisode.poster_path && !selectedEpisode.thumbnail_path }">
              <VideoArtwork :poster="selectedEpisode.poster_path" :thumbnail="selectedEpisode.thumbnail_path" />
              <div class="episode-copy">
              <label v-if="episodeEditing">单集标题<input class="input" :value="selectedEpisode.title" @change="saveEpisode({ title: ($event.target as HTMLInputElement).value.trim() })" /></label>
              <div class="episode-reading__title"><h3>{{ selectedEpisode.original_title || selectedEpisode.title }}</h3><p v-if="selectedEpisode.original_title && selectedEpisode.original_title !== selectedEpisode.title">{{ selectedEpisode.title }}</p></div>
              <dl v-if="selectedEpisode.air_date || selectedEpisode.published_at || selectedEpisode.studio || selectedEpisode.duration_sec" class="episode-facts" aria-label="单集基本资料">
                <div v-if="selectedEpisode.air_date"><dt>发行日期</dt><dd>{{ videoDateLabel(selectedEpisode.air_date) }}</dd></div>
                <div v-if="selectedEpisode.published_at"><dt>站点发布日期</dt><dd>{{ videoDateLabel(selectedEpisode.published_at) }}</dd></div>
                <div v-if="selectedEpisode.studio"><dt>厂牌 / 作者</dt><dd>{{ selectedEpisode.studio }}</dd></div>
                <div v-if="selectedEpisode.duration_sec"><dt>片长</dt><dd>{{ formatDuration(selectedEpisode.duration_sec) }}</dd></div>
              </dl>
              <label v-if="editing || episodeEditing" class="episode-reading__original">原名<input class="input" :value="selectedEpisode.original_title || ''" aria-label="单集原名" @change="saveEpisode({ original_title: ($event.target as HTMLInputElement).value.trim() })" /></label>
              <EditableField v-if="editing || episodeEditing" :key="'description-' + selectedEpisode.id" :model-value="selectedEpisode.description || ''" multiline placeholder="这一集讲的是什么" @commit="saveEpisode({ description: $event })" />
              <p v-else class="read-text">{{ selectedEpisode.description || '这一集暂无简介，可在编辑资料中补充。' }}</p>
              <details v-if="selectedEpisode.original_description && selectedEpisode.original_description !== selectedEpisode.description" class="original-description"><summary>查看这一集的原文</summary><p>{{ selectedEpisode.original_description }}</p></details>
              <button v-if="selectedEpisode.source_url" class="btn btn--subtle episode-reading__source" type="button" @click="openUrl(selectedEpisode.source_url)"><ExternalLink :size="13" />这一集的来源</button>
              </div>
              </div>
              <div class="tags episode-tags"><TagBadge v-for="tag in selectedEpisode.tags || []" :key="tag" :label="tag" clickable @click="filterByTag(tag)" /></div>
              <EditableField v-if="episodeEditing" :key="'tags-' + selectedEpisode.id" :model-value="(selectedEpisode.tags || []).join('、')" placeholder="单集标签，用顿号分隔" @commit="saveEpisode({ tags: $event.split(/[、,，]/).map(t => t.trim()).filter(Boolean) })" />
            </template>
            <template v-else>
              <div class="episode-summary" :class="{ 'episode-summary--text-only': !item.poster_path && !item.thumbnail_path }">
              <VideoArtwork :poster="item.poster_path" :thumbnail="item.thumbnail_path" />
              <div class="episode-copy">
              <div class="episode-reading__title"><h3>{{ title }}</h3><p v-if="item.name_en && item.name_en !== title">{{ item.name_en }}</p></div>
              <EditableField v-if="editing" :model-value="item.description" multiline placeholder="整部作品讲的是什么" @commit="save({ description: $event })" />
              <p v-else class="read-text">{{ item.description || (library?.contents.length ? '暂无整部作品简介。可以切换集数，查看各集的独立介绍。' : '尚无简介，可在编辑资料中补充。') }}</p>
              <details v-if="item.original_description" class="original-description"><summary>查看日文原文</summary><p>{{ item.original_description }}</p></details>
              </div></div>
            </template>
          </section>

          <section id="video-panel-notes" v-show="activeTab === 'notes'" class="panel episode-reading" role="tabpanel" aria-labelledby="video-tab-notes" tabindex="0">
            <header class="episode-reading__head">
              <div><h2>{{ selectedEpisode ? videoEpisodeLabel(selectedEpisode, item.category === '里番') + ' · 笔记' : '作品笔记' }}</h2><p>{{ selectedEpisode ? selectedEpisode.original_title || selectedEpisode.title : '记录观看感受、版本偏好或待办事项' }}</p></div>
              <VideoScopeSwitch v-if="library?.contents.length" v-model="selectedEpisodeId" :episodes="library.contents" :without-season="item.category === '里番'" notes />
            </header>
            <EditableField v-if="editing" :key="'notes-' + selectedEpisodeId" :model-value="selectedEpisode ? selectedEpisode.notes || '' : item.notes" multiline placeholder="看到哪儿了、哪个版本、想说的话…" @commit="selectedEpisode ? saveEpisode({ notes: $event }) : save({ notes: $event })" />
            <p v-else class="read-text">{{ (selectedEpisode ? selectedEpisode.notes : item.notes) || '暂无笔记' }}</p>
          </section>

        <section id="video-panel-files" v-show="activeTab === 'files'" role="tabpanel" aria-labelledby="video-tab-files" tabindex="0">
          <div class="detail-info-grid">
          <section class="panel">
            <h2 class="sec-title">作品目录</h2>
            <p class="read-text mono">{{ library?.directory?.path || item.path }}</p>
            <div class="file-management-actions"><button class="btn btn--ghost" type="button" @click="reveal"><FolderOpen :size="13" />打开目录</button><button class="btn btn--ghost" type="button" @click="openOrganize('relocate')">管理目录</button><button class="btn btn--subtle" type="button" @click="openOrganize('history')">整理记录</button></div>
          </section>

          <section class="panel">
            <h2 class="sec-title">收藏分组</h2>
            <input class="input" :value="item.collection_name || ''" aria-label="视频分组" maxlength="80"
              list="video-collection-options" placeholder="未分组"
              @change="save({ collection_name: ($event.target as HTMLInputElement).value.trim() })" />
            <p class="panel__note">收藏分组用于筛选作品，不改变文件位置。</p>
            <button class="btn btn--subtle" @click="sourceOpen = true">搜索 / 绑定来源</button>
            <datalist id="video-collection-options">
              <option v-for="group in (item.category === HENTAI_CATEGORY ? store.counts.hentai_collections : store.counts.collections) || []"
                :key="group.name" :value="group.name" />
            </datalist>
            <button v-if="item.collection_name" type="button" class="btn btn--ghost"
              @click="store.select({ kind: 'collection', value: item.collection_name, ...(item.category === HENTAI_CATEGORY ? { type: 'hentai' as const } : {}) }); router.push({ name: 'video-home' })">
              <FolderOpen :size="14" /> 查看分组
            </button>
          </section>

          <!--
            改过的字段。只在真有改动时出现 —— 没改过任何东西的条目上，
            这一格是纯噪音。

            文案说的是「重扫时保留」而不是「已锁定」：用户要知道的是
            这个标记在什么时候起作用，而它只在重扫那一刻起作用。
          -->
          <section v-if="editedFields.length > 0" class="panel">
            <h2 class="sec-title">改过的字段</h2>
            <p class="panel__note">
              重扫时这几栏保持你改的值，不会被刮削覆盖。
            </p>
            <ul class="edited">
              <li v-for="f in editedFields" :key="f.field" class="edited__row">
                <span class="edited__name">{{ f.label }}</span>
                <button
                  class="edited__undo"
                  title="以后这一栏听刮削的（下次重扫才会变，不是现在）"
                  @click="unprotect([f.field])"
                >
                  取消保留
                </button>
              </li>
            </ul>
            <button
              v-if="editedFields.length > 1"
              class="edited__all"
              @click="unprotect([])"
            >
              全部取消保留
            </button>
          </section>

          <section class="panel">
            <h2 class="sec-title">观看</h2>
            <dl class="facts">
              <dt>状态</dt>
              <dd>{{ WATCH_STATUS_LABEL[item.watch_status] }}</dd>
              <template v-if="isSeries">
                <dt>进度</dt>
                <dd>
                  已看 {{ item.episode_watched }} 项 · 已发现 {{ item.episode_total }} 项
                </dd>
              </template>
              <template v-else-if="item.position_sec > 0">
                <dt>播到</dt>
                <dd>{{ formatPosition(item.position_sec) }}</dd>
              </template>
              <dt>上次观看</dt>
              <dd>{{ item.last_watched_at ? formatRelative(item.last_watched_at) : '没看过' }}</dd>
              <dt>加入</dt>
              <dd>{{ formatDate(item.created_at) }}</dd>
            </dl>
          </section>

          <!--
            这一块全是本地事实（文件名解析 + 容器元数据），不是模型猜的。
            读不出来的就不出现 —— 一行「未知」比没有这一行更让人以为哪里出错了。
          -->
          <section class="panel">
            <h2 class="sec-title">规格</h2>
            <dl class="facts">
              <template v-if="item.video_codec">
                <dt>编码</dt>
                <dd>{{ item.video_codec }}</dd>
              </template>
              <template v-if="item.source">
                <dt>片源</dt>
                <dd>{{ item.source }}</dd>
              </template>
              <template v-if="item.release_group">
                <dt>压制组</dt>
                <dd>{{ item.release_group }}</dd>
              </template>
              <template v-if="item.audio_tracks.length > 0">
                <dt>音轨</dt>
                <dd>{{ item.audio_tracks.map(trackText).join('，') }}</dd>
              </template>
              <!-- 内嵌轨在这儿一行带过。外挂字幕单独一块，理由见下面那一节 -->
              <template v-if="embeddedSubs.length > 0">
                <dt>内嵌字幕</dt>
                <dd>{{ embeddedSubs.map(trackText).join('，') }}</dd>
              </template>
              <dt>{{ isSeries ? '目录' : '文件' }}</dt>
              <dd>
                <button
                  class="mono truncate link"
                  :title="`${item.path}（点击复制）`"
                  @click="copyPath(item.path)"
                >
                  {{ item.file_name }}
                </button>
              </dd>
              <template v-if="item.file_size > 0">
                <dt>大小</dt>
                <dd>{{ formatBytes(item.file_size) }}</dd>
              </template>
            </dl>
          </section>

          <!--
            外挂字幕单独一块，不和内嵌轨混在「规格」那一行里。
            区别对用户有行动含义：外挂的能换、能删、能自己调时间轴，内嵌的做不到。
            所以每一条给一个「打开所在位置」—— 字幕对不上的时候，用户要做的事
            就是去那个目录里换一个文件，而字幕常常不和视频在同一层（Subs/ 子目录）。
          -->
          <section v-if="externalSubs.length > 0" class="panel">
            <h2 class="sec-title">
              外挂字幕
              <span class="sec-title__count">{{ externalSubs.length }}</span>
            </h2>
            <ul class="subs">
              <li v-for="sub in externalSubs" :key="sub.path" class="sub">
                <Subtitles :size="13" class="sub__icon" />
                <span class="sub__label truncate" :title="sub.path">
                  {{ sub.label || sub.language || '字幕' }}
                </span>
                <span v-if="sub.codec" class="sub__codec mono">{{ sub.codec }}</span>
                <button class="sub__act" title="在资源管理器里选中" @click="revealSub(sub.path)">
                  <FolderOpen :size="12" />
                </button>
              </li>
            </ul>
          </section>
          </div>
        </section>
        </div>
      </div>
    </template>
    <DownloadPanel v-if="downloadFlow.open.value && !itemHidden" :key="id" :id="id" @close="downloadFlow.open.value = false" />
    <OrganizePanel v-if="organizeMode && item && !itemHidden" :key="id" :mode="organizeMode" :resource-id="id" :works="[item]" :directory="library?.directory" :return-focus="organizeReturnFocus" @close="organizeMode = ''" @changed="refreshLibrary" />
  </div>
</template>

<style scoped>
.episode-facts { display: flex; flex-wrap: wrap; gap: 12px 28px; margin-block: 16px; font-size: var(--fs-body); }
.episode-facts > div { display: flex; flex-wrap: wrap; gap: 8px; }
.episode-facts dt { color: var(--text-sub); }
.episode-facts dd { margin: 0; color: var(--text-main); overflow-wrap: anywhere; }
.episode-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.episode-summary { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: start; gap: 22px; }
.episode-summary--text-only { grid-template-columns: minmax(0, 1fr); }
.episode-copy { min-width: 0; }
.episode-tags { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--divider); }
@media (max-width: 720px) { .episode-summary { grid-template-columns: minmax(0, 1fr); } }
.detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.detail__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--text-sub);
}

.head {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-main);
  border-bottom: 1px solid var(--divider);
}

.head__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-wrap: nowrap;
  justify-content: flex-end;
}

.body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  padding: 12px 16px 24px;
  align-items: start;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--text-sub);
}

.sec-title__count {
  margin-left: auto;
  font-size: var(--fs-tag);
  font-weight: 400;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* ------------------------------- 头部卡片 ------------------------------- */
.hero {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr) minmax(180px, 23%);
  gap: 16px;
  align-items: start;
  padding: 16px;
}

/* 比游戏封面宽一点：影视海报上常有中文片名，96px 下那行字糊成一团 */
.hero__poster {
  position: relative;
  flex: none;
  width: 84px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-card);
  overflow: hidden;
  display: grid;
  place-items: center;
  background: linear-gradient(
    155deg,
    hsl(var(--hue) 26% 26%),
    hsl(calc(var(--hue) + 28) 22% 15%)
  );
}

.hero__initial {
  font-family: var(--font-display);
  font-size: 40px;
  color: rgb(255 255 255 / 0.82);
}

.hero__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero__posterActs {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 4px;
  background: rgb(0 0 0 / 0.62);
  backdrop-filter: blur(4px);
  opacity: 1;
  transition: opacity var(--t-fast) ease;
}
.hero__poster:hover .hero__posterActs,
.hero__posterActs:focus-within {
  opacity: 1;
}

.hero__posterBtn {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: var(--fs-tag);
  color: rgb(255 255 255 / 0.86);
}
.hero__posterBtn:hover {
  color: #fff;
}

.hero__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hero__name,
.hero__en,
.hero__summary {
  width: 100%;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  outline: none;
  padding: 3px 6px;
  margin-left: -6px;
  color: inherit;
  transition: border-color var(--t-fast) ease;
}
.hero__name:hover,
.hero__en:hover,
.hero__summary:hover {
  border-color: var(--divider);
}
.hero__name:focus,
.hero__en:focus,
.hero__summary:focus {
  border-color: var(--accent);
}

.hero__name {
  font-size: 21px;
  font-weight: 500;
}

.hero__en {
  font-size: var(--fs-body);
  color: var(--text-faint);
}

.hero__summary {
  font-size: var(--fs-body);
  color: var(--text-sub);
}

/* 年份、分辨率、评分挤在一行：它们各自都太短，单独占行会把标题和简介推远 */
.hero__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.hero__badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: var(--radius-tag);
  background: var(--hover-surface);
  color: var(--text-sub);
}

.hero__rating {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--warning);
}

.statuses {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.chip {
  height: 26px;
  padding: 0 12px;
  border-radius: var(--radius-tag);
  font-size: var(--fs-tag);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease,
    border-color var(--t-fast) ease;
}
.chip:hover {
  color: var(--text-main);
}
.chip.on {
  background: var(--active-surface);
  border-color: transparent;
  color: var(--accent);
}

/* ------------------------------- 季集表 ------------------------------- */
.season + .season {
  margin-top: 16px;
}

.season__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 4px 6px;
  border-bottom: 1px solid var(--divider);
}

.season__name {
  font-size: var(--fs-body);
  color: var(--text-main);
}

.season__meta {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.season__act {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}
.season__act:hover:not(:disabled) {
  color: var(--accent);
}
.season__act:disabled {
  cursor: default;
}

.eps {
  display: flex;
  flex-direction: column;
}

.ep {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 4px;
  border-radius: var(--radius-btn);
}
.ep:hover {
  background: var(--hover-surface);
}

/*
 * 看过的整行压暗，而不是给个勾就完事：追剧时用户扫的是「哪一行还亮着」，
 * 那一行就是接着看的地方。逐行找勾要慢得多。
 */
.ep--watched .ep__code,
.ep--watched .ep__title {
  color: var(--text-faint);
}

/* 缺文件的行不压暗 —— 它是要被看见的，不是已经处理完的 */
.ep--missing .ep__title {
  color: var(--text-faint);
}

.ep__check {
  flex: none;
  display: grid;
  place-items: center;
  width: 17px;
  height: 17px;
  border-radius: 4px;
  border: 1px solid var(--divider);
  color: var(--accent);
}
.ep__check:hover:not(:disabled) {
  border-color: var(--accent);
}
.ep__check:disabled {
  cursor: default;
  opacity: 0.45;
}

/*
 * 播放键平时是灰的，悬停整行才显形。
 *
 * 不常亮：一屏 40 行、每行一个亮着的三角，季集表就变成了一片图标而不是
 * 一份进度表。而这一行本来要传达的是「看到哪儿了」。
 */
.ep__play {
  flex: none;
  display: grid;
  place-items: center;
  width: 17px;
  height: 17px;
  border-radius: 4px;
  color: var(--text-faint);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.ep:hover .ep__play {
  opacity: 1;
}
.ep__play:hover:not(:disabled) {
  color: var(--accent);
  background: var(--hover-surface);
}
.ep__play:disabled {
  cursor: default;
  opacity: 0;
}

/* 刚点开的那一集留个记号：外部播放器不回报任何东西，这是界面上唯一
   能说明「刚才那一下确实开了」的痕迹 */
.ep--playing .ep__code {
  color: var(--accent);
}
.ep--playing .ep__play {
  opacity: 1;
  color: var(--accent);
}

.ep__code {
  flex: none;
  width: 52px;
  font-size: var(--fs-tag);
  color: var(--text-sub);
}

.ep__title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  color: var(--text-main);
  text-align: left;
}

/* 警示色不做背景块：缺集很可能只是还没下，把它渲染成红底像是数据坏了 */
.ep__missing {
  flex: none;
  font-size: var(--fs-tag);
  color: var(--warning);
}

.ep__pos,
.ep__dur {
  flex: none;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.ep__pos {
  color: var(--accent);
}

.ep__path {
  flex: none;
  max-width: 30%;
  text-align: right;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}
.ep__path:hover {
  color: var(--text-sub);
}

/* ------------------------------- 分卷 ------------------------------- */
.paths {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.path {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-input);
  background: var(--hover-surface);
}

.path__text {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: var(--fs-tag);
  color: var(--text-sub);
}
.path__text:hover {
  color: var(--text-main);
}

.path__note {
  flex: none;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.hint {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  line-height: 1.7;
}

/* ------------------------------- 侧列 ------------------------------- */
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.tags--hanime {
  padding-top: 8px;
  border-top: 1px solid var(--divider);
}

.original-description {
  margin-top: 12px;
  color: var(--text-sub);
  font-size: var(--fs-tag);
  line-height: 1.7;
}

.original-description summary {
  cursor: pointer;
  color: var(--text-faint);
}

.original-description summary:hover {
  color: var(--accent);
}

.original-description p {
  margin: 8px 0 0;
  white-space: pre-wrap;
}

.facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 7px 12px;
  font-size: var(--fs-tag);
}

.facts dt {
  color: var(--text-faint);
  white-space: nowrap;
}

.facts dd {
  min-width: 0;
  color: var(--text-sub);
}

.link {
  max-width: 100%;
  text-align: left;
  color: var(--text-sub);
}
.link:hover {
  color: var(--accent);
}

/* --------------------------- 外挂字幕 --------------------------- */
.subs {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sub {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  padding: 0 4px;
  border-radius: var(--radius-btn);
  font-size: var(--fs-tag);
}
.sub:hover {
  background: var(--hover-surface);
}

.sub__icon {
  flex: none;
  color: var(--text-faint);
}

.sub__label {
  flex: 1;
  min-width: 0;
  color: var(--text-sub);
}

.sub__codec {
  flex: none;
  color: var(--text-faint);
}

/* 同季集表里的播放键：悬停才显形，一列常亮的图标会把这一块变成图标墙 */
.sub__act {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--text-faint);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.sub:hover .sub__act {
  opacity: 1;
}
.sub__act:hover {
  color: var(--accent);
}

/* --------------------------- 改过的字段 --------------------------- */
.panel__note {
  margin: -2px 0 10px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  line-height: 1.6;
}

.edited {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.edited__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  font-size: var(--fs-tag);
}

.edited__name {
  color: var(--text-sub);
}

.edited__undo,
.edited__all {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  white-space: nowrap;
}

.edited__undo:hover,
.edited__all:hover {
  color: var(--accent);
}

.edited__all {
  margin-top: 8px;
  text-align: left;
}
.detail { --text-sub: color-mix(in srgb, var(--text-main) 70%, var(--bg-main)); --text-faint: var(--text-sub); }
.detail :is(button, input, textarea, select, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.detail__play { max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head__more { position: relative; flex: none; }
.head__more > summary { list-style: none; cursor: pointer; }
.head__more > summary::-webkit-details-marker { display: none; }
.head__moreMenu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 10; display: flex; flex-direction: column; align-items: stretch; gap: 5px; width: 210px; max-height: calc(100dvh - 110px); overflow-y: auto; padding: 10px; background: var(--bg-elevated); border: 1px solid var(--divider); border-radius: var(--radius-input); box-shadow: var(--shadow-pop); }
.head__moreMenu .btn { justify-content: flex-start; }
.hero__title { font-size: 19px; font-weight: 500; line-height: 1.45; overflow-wrap: anywhere; }
.hero__title-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.hero__title-line h1 { min-width: 0; }
.hero__title-line .hero__badge { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; white-space: nowrap; font-size: 11px; font-weight: 400; padding: 3px 7px; }
.hero__original, .hero__summary-text { font-size: var(--fs-tag); color: var(--text-sub); line-height: 1.5; overflow-wrap: anywhere; }
.hero__summary-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.hero__location { display: flex; gap: 6px; align-items: flex-start; text-align: left; color: var(--text-sub); font-size: 11px; line-height: 1.5; }
.hero__location svg { flex: none; margin-top: 2px; }
.hero__location span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.hero__edit { margin-left: auto; min-height: 28px; }
.hero__name { resize: vertical; min-height: 44px; font-size: 18px; line-height: 1.4; }
.hero__posterActs { display: grid; grid-template-columns: minmax(0, 1fr) 18px; gap: 2px; padding: 3px; }
.hero__posterBtn { justify-content: center; font-size: 10px; min-height: 22px; white-space: nowrap; }
.hero__posterBtn:first-child { grid-column: 1 / -1; }
.hero__posterBtn:nth-child(2):last-child { grid-column: 1 / -1; }
.hero__posterBtn--wide { grid-column: 1 / -1; }
.read-text { font-size: var(--fs-body); color: var(--text-sub); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.detail-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; align-items: start; }
.hero__facts { min-width: 0; border-left: 1px solid var(--divider); padding-left: 16px; display: flex; flex-direction: column; gap: 9px; }
.hero__classification { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.hero__badge { padding: 4px 8px; font-size: 12px; color: var(--text-main); }
.hero__category, .hero__tag-heading, .hero__empty-tags, .hero__progress { font-size: 11px; color: var(--text-sub); line-height: 1.6; }
.hero__tag-heading { margin-top: 3px; }
.hero__tags { margin: 0; gap: 5px; overflow: hidden; align-content: start; }
.hero__tag-area { min-width: 0; }
.hero__tags-more { color: var(--text-sub); margin-top: 3px; padding: 0 8px; min-width: 28px; min-height: 22px; border-radius: 4px; font-size: 12px; }
.hero__tags-more:hover { background: var(--hover-surface); color: var(--accent); }
.hero__progress { padding-top: 8px; border-top: 1px solid var(--divider); font-variant-numeric: tabular-nums; }
.hero__field { display: grid; gap: 5px; color: var(--text-sub); font-size: 11px; }
.detail-tabs { display: flex; align-items: center; gap: 24px; border-bottom: 1px solid var(--divider); padding: 0 4px; }
.detail-tabs button { min-height: 42px; padding: 8px 2px; display: flex; align-items: center; gap: 7px; border-bottom: 2px solid transparent; color: var(--text-sub); font-size: 13px; white-space: nowrap; }
.detail-tabs button[aria-selected='true'] { color: var(--text-main); border-bottom-color: var(--accent); font-weight: 600; }
.detail-tabs button:hover { color: var(--text-main); }
.detail-tabs span { padding: 1px 5px; border-radius: 4px; background: var(--hover-surface); font-size: 10px; font-variant-numeric: tabular-nums; }
[role='tabpanel'] { min-width: 0; }
[role='tabpanel']:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.episode-reading { min-height: 220px; padding: 20px 24px; }
.episode-reading__head { display: flex; justify-content: space-between; align-items: start; gap: 16px; margin-bottom: 22px; padding-bottom: 15px; border-bottom: 1px solid var(--divider); }
.episode-reading__head > div { min-width: 0; }
.episode-reading__head h2 { font-size: 15px; font-weight: 600; }
.episode-reading__head p { color: var(--text-sub); font-size: 12px; line-height: 1.6; margin-top: 5px; overflow-wrap: anywhere; }
.episode-reading__scope { display: grid; gap: 5px; flex: 0 1 320px; min-width: 140px; color: var(--text-sub); font-size: 11px; }
.episode-reading__scope select { width: 100%; min-width: 0; height: 34px; padding: 0 9px; border: 1px solid var(--divider); border-radius: var(--radius-input); background: var(--bg-main); color: var(--text-main); font-size: 12px; }
.episode-reading__title { margin-bottom: 16px; }
.episode-reading__title h3 { font-size: 17px; font-weight: 500; line-height: 1.6; overflow-wrap: anywhere; }
.episode-reading__title p { color: var(--text-sub); font-size: 12px; margin-top: 4px; }
.episode-reading .read-text { max-width: 76ch; line-height: 1.9; }
.episode-reading__source { margin-top: 20px; }
.episode-reading__original { display: grid; gap: 6px; margin-bottom: 14px; color: var(--text-sub); font-size: 12px; }
.file-management-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.statuses { flex-wrap: wrap; }
.chip.on { color: var(--text-main); }
.detail .btn--primary { background: #6652c8; color: #fff; }
:global([data-theme='light']) .detail { --danger: #b42332; --warning: #825800; }
@media (max-width: 1060px) { .hero { grid-template-columns: 70px minmax(0, 1fr) 180px; gap: 12px; padding: 12px; } .hero__poster { width: 70px; } .hero__facts { padding-left: 12px; } .hero__title { font-size: 17px; } .hero__text { gap: 5px; } .detail__play { max-width: 170px; } }
@media (max-width: 720px) { .head { gap: 6px; padding: 8px 12px; align-items: flex-start; } .head__actions { flex-wrap: wrap; gap: 5px; } .body { padding: 10px 12px 20px; } .hero { grid-template-columns: 70px minmax(0, 1fr); } .hero__facts { grid-column: 1 / -1; padding: 10px 0 0; border-left: 0; border-top: 1px solid var(--divider); } .detail-tabs { gap: 16px; } .episode-reading { padding: 16px; } .episode-reading__head { flex-wrap: wrap; } .episode-reading__scope { flex-basis: 100%; } }
</style>
