<script setup lang="ts">
import { latestOnly, STALE } from '@/composables/latestOnly'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-vue-next'
import DownloadPanel from '@/components/video/DownloadPanel.vue'
import VideoSourceDialog from '@/components/video/VideoSourceDialog.vue'
import VideoRemovalDialog from '@/components/video/VideoRemovalDialog.vue'
import VideoItems from '@/components/video/VideoItems.vue'
import AudioDetail from '@/components/video/AudioDetail.vue'
import VideoDetailHero from '@/components/video/VideoDetailHero.vue'
import VideoEpisodeReadingPanel from '@/components/video/VideoEpisodeReadingPanel.vue'
import VideoFilesInfoTab from '@/components/video/VideoFilesInfoTab.vue'
import ResourceBacklinksPanel from '@/components/workspace/ResourceBacklinksPanel.vue'
import OrganizePanel from '@/components/video/OrganizePanel.vue'
import CollectionNameDialog from '@/components/video/CollectionNameDialog.vue'
import EpisodeArtworkDialog from '@/components/video/EpisodeArtworkDialog.vue'
import { confirmDialog } from '@/composables/useDialog'
import { useVideoWorkflow } from '@/composables/useVideoWorkflow'
import { useResourceDetail } from '@/composables/useResourceDetail'
import { useToast } from '@/composables/useToast'
import { reidentifyVideo, useMediaScan } from '@/composables/useMediaScan'
import { useVideoStore } from '@/stores/video'
import type { Episode, VideoItem, WatchStatus } from '@/types'
import type { VideoWorkContent, VideoWorkLibrary } from '@/types/video-workflow'
import { registeredVideoContent } from '@/utils/video-content'
import { errorMessage, videoTitle } from '@/utils'

const HENTAI_CATEGORY = '里番'

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
const sourceOpen = ref(false)
const removalEpisode = ref('')
const removalWork = ref(false)
const selectedEpisodeId = ref('')
let readingScopeInitialized = false

const selectedEpisode = computed(
  () => library.value?.contents.find((episode) => episode.id === selectedEpisodeId.value) ?? null
)
const detailTabs = computed(() => [
  { id: 'contents' as const, label: '作品内容', count: library.value?.contents.length || 0 },
  { id: 'description' as const, label: '剧情简介' },
  { id: 'notes' as const, label: '个人笔记' },
  { id: 'files' as const, label: '文件与资料' },
])

watch(
  () => router.currentRoute?.value.query.tab,
  (value) => {
    activeTab.value = detailTabs.value.find((t) => t.id === value)?.id || 'contents'
  },
  { immediate: true }
)
watch(activeTab, (value) => {
  if (router.currentRoute?.value && router.currentRoute.value.query.tab !== value) {
    void router.replace({ query: { ...router.currentRoute.value.query, tab: value } })
  }
})

function showEpisode(episode: VideoWorkContent): void {
  selectedEpisodeId.value = episode.id
  activeTab.value = 'description'
  void nextTick(() => document.getElementById('video-tab-description')?.focus({ preventScroll: true }))
}

function tabKeydown(event: KeyboardEvent): void {
  const index = detailTabs.value.findIndex((tab) => tab.id === activeTab.value)
  const target =
    event.key === 'ArrowRight'
      ? (index + 1) % detailTabs.value.length
      : event.key === 'ArrowLeft'
        ? (index + detailTabs.value.length - 1) % detailTabs.value.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? detailTabs.value.length - 1
            : -1
  if (target < 0) return
  event.preventDefault()
  activeTab.value = detailTabs.value[target].id
  void nextTick(() => document.getElementById('video-tab-' + activeTab.value)?.focus())
}

const busyEpisode = ref('')
async function scrapeSelected(): Promise<void> {
  if (!selectedEpisode.value?.source_url) {
    sourceOpen.value = true
    return
  }
  busyEpisode.value = selectedEpisode.value.id
  try {
    const result = await window.baoyi.video.scrapeEpisode(props.id, selectedEpisode.value.id)
    await refreshLibrary()
    success(result.warnings.length ? '资料已更新；' + result.warnings[0] : '已更新本集资料与图片')
  } catch (e) {
    error(errorMessage(e))
  } finally {
    busyEpisode.value = ''
  }
}

async function pickEpisodeImage(role: 'poster' | 'thumbnail'): Promise<void> {
  if (!selectedEpisode.value) return
  try {
    if (await window.baoyi.video.pickEpisodeArtwork(selectedEpisode.value.id, role)) {
      await refreshLibrary()
    }
  } catch (e) {
    error(errorMessage(e))
  }
}

async function saveEpisode(patch: Partial<Episode>): Promise<void> {
  if (!selectedEpisode.value || busyEpisode.value) return
  const episodeId = selectedEpisode.value.id
  busyEpisode.value = episodeId
  try {
    const result = await window.baoyi.video.updateEpisode(episodeId, patch)
    if (result.episode && library.value) {
      const index = library.value.contents.findIndex((episode) => episode.id === episodeId)
      if (index >= 0) Object.assign(library.value.contents[index], result.episode)
    }
    store.merge(result.item)
    success('已保存单集资料')
  } catch (cause) {
    error('保存单集资料失败：' + errorMessage(cause))
  } finally {
    busyEpisode.value = ''
  }
}

const loadError = ref('')
const moreMenu = ref<HTMLDetailsElement | null>(null)
const downloadFlow = computed(() => useVideoWorkflow(props.id))
const itemHidden = computed(
  () =>
    item.value?.category === HENTAI_CATEGORY &&
    (!downloadFlow.value.privacyReady.value || downloadFlow.value.hideHentai.value)
)
const organizeMode = ref<'relocate' | 'history' | ''>('')
const renameOpen = ref(false)
const episodeArtworkOpen = ref(false)
const episodeArtworkAvailable = computed(
  () => !!library.value?.contents.some((episode) => episode.poster_path || episode.thumbnail_path)
)
const organizeReturnFocus = ref<HTMLElement | null>(null)

watch(
  itemHidden,
  (hidden) => {
    if (hidden) {
      organizeMode.value = ''
      renameOpen.value = false
      downloadFlow.value.reset()
    }
  },
  { flush: 'sync' }
)

const readDetail = latestOnly(async (mode: 'load' | 'refresh' | 'check') => {
  const id = props.id
  if (mode === 'check') {
    const sync = await window.baoyi.video.syncFiles(id)
    return { item: await window.baoyi.video.get(id), library: sync.library, sync }
  }
  const initial = mode === 'load' ? await window.baoyi.video.get(id) : null
  const content = mode === 'refresh' || initial ? await window.baoyi.video.library(id) : null
  const loadedItem = mode === 'refresh' || content?.contents.length ? await window.baoyi.video.get(id) : initial
  return { item: loadedItem, library: content, sync: null }
})

let unlistenLibrary: (() => void) | undefined

async function load(): Promise<void> {
  loading.value = true
  checking.value = false
  loadError.value = ''
  library.value = null
  try {
    const result = await readDetail('load')
    if (result === STALE) return
    item.value = result.item
    library.value = result.library
    episodes.value = result.library?.contents ?? []
  } catch (err) {
    error(`读取影视条目失败：${errorMessage(err)}`)
    loadError.value = '读取影视条目失败：' + errorMessage(err)
    item.value = null
    episodes.value = []
  }
  loading.value = false
}

async function refreshLibrary(): Promise<void> {
  checking.value = true
  try {
    const result = await readDetail('refresh')
    if (result === STALE) return
    item.value = result.item
    library.value = result.library
    episodes.value = result.library!.contents
    store.merge(result.item)
    void store.refreshCounts()
  } catch (err) {
    error('检查文件失败：' + errorMessage(err))
  }
  checking.value = false
  loading.value = false
}

const lastCheck = ref('')
async function checkFiles(): Promise<void> {
  if (checking.value) return
  checking.value = true
  try {
    const result = await readDetail('check')
    if (result === STALE) return
    library.value = result.library
    episodes.value = result.library!.contents
    item.value = result.item
    const sync = result.sync!
    lastCheck.value = sync.message
    store.merge(result.item)
    void store.reload()
    if (sync.warnings.length) toast(sync.message + '；' + sync.warnings[0])
    else success(sync.message)
  } catch (cause) {
    lastCheck.value = '检查未完成：' + errorMessage(cause)
    error(lastCheck.value)
  }
  checking.value = false
}

function openDownload(): void {
  if (!item.value?.hanime_id) {
    sourceOpen.value = true
    return
  }
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
  unlistenLibrary = window.baoyi.video.onLibraryChanged((id) => {
    if (!id || id === props.id) void refreshLibrary()
  })
})
onBeforeUnmount(() => unlistenLibrary?.())

watch(
  () => router.currentRoute?.value.query.edit,
  (value) => {
    editing.value = value === '1'
  }
)
watch(
  () => library.value?.contents,
  (contents) => {
    if (!contents) return
    const registered = contents.filter(registeredVideoContent)
    if (registered.length !== contents.length) {
      library.value = { ...library.value!, contents: registered }
      episodes.value = registered
      return
    }
    if (selectedEpisodeId.value && !contents.some((episode) => episode.id === selectedEpisodeId.value)) {
      selectedEpisodeId.value = ''
    }
    if (readingScopeInitialized) return
    readingScopeInitialized = true
    const requestedEpisode = router.currentRoute?.value.query.episode
    if (
      !selectedEpisodeId.value &&
      typeof requestedEpisode === 'string' &&
      contents.some((e) => e.id === requestedEpisode)
    ) {
      selectedEpisodeId.value = requestedEpisode
      activeTab.value = 'description'
    }
    if (!selectedEpisodeId.value && contents.length === 1) selectedEpisodeId.value = contents[0].id
  }
)

const title = computed(() => (item.value ? videoTitle(item.value) : ''))
const posterBusy = ref(false)
const videoScan = useMediaScan('video')
const refreshingIdentify = ref(false)
const reidentifying = computed(() => refreshingIdentify.value || videoScan.running.value)

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
    error(`查找海报失败：${errorMessage(err)}`)
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
  const ok = await confirmDialog({
    title: '恢复默认海报占位？',
    message: '将移除抱一保存的海报副本并恢复首字占位，你原有的本地图片不受影响。',
    confirmText: '移除海报',
  })
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
      if (item.value?.id === target.id) item.value = updated
      store.merge(updated)
      success(forceHentai ? '里番资料匹配完成' : '重新识别完成')
    } else {
      toast('重新识别已停止，已完成的结果已保留')
    }
  } catch (err) {
    error('识别失败：' + errorMessage(err))
  } finally {
    refreshingIdentify.value = false
  }
}

function filterByTag(tag: string): void {
  store.select({
    kind: 'tag',
    value: tag,
    ...(item.value?.category === HENTAI_CATEGORY ? { type: 'hentai' as const } : {}),
  })
  void router.push({ name: 'video-home' })
}

async function changeType(value: string): Promise<void> {
  if (!item.value) return
  if (value === 'hentai') await save({ category: HENTAI_CATEGORY, media_kind: 'video' })
  else if (value === 'other' || value === 'audio') {
    await save({ media_kind: value, ...(item.value.category === HENTAI_CATEGORY ? { category: '其他' } : {}) })
  } else if (value === 'movie' || value === 'series') {
    await save({
      video_type: value,
      media_kind: 'video',
      ...(item.value.category === HENTAI_CATEGORY ? { category: '其他' } : {}),
    })
  }
}

const { save, commitTags, toggleArchive, reveal, copyPath } = useResourceDetail({
  item,
  reveal: (id) => window.baoyi.video.revealInFolder(id),
  update: (current, patch) => store.update(current.id, patch),
})

async function unprotect(fields: string[]): Promise<void> {
  if (!item.value) return
  try {
    const updated = await store.restoreScraped(item.value.id, fields)
    if (updated) item.value = updated
  } catch (err) {
    error(`取消保留失败：${errorMessage(err)}`)
  }
}

async function setEpisodeStatus(e: Episode, status: WatchStatus): Promise<void> {
  if (busyEpisode.value) return
  busyEpisode.value = e.id
  try {
    const r = await window.baoyi.video.updateEpisode(e.id, { watch_status: status })
    if (r.episode) {
      const i = episodes.value.findIndex((x) => x.id === e.id)
      if (i >= 0) Object.assign(episodes.value[i], r.episode)
    }
    if (r.item) item.value = r.item
    store.merge(r.item)
    void store.refreshCounts()
  } catch (err) {
    error(`更新单集状态失败：${errorMessage(err)}`)
  } finally {
    busyEpisode.value = ''
  }
}

const playing = ref(false)
const hasVideo = (content: VideoWorkContent) =>
  content.assets.some((asset) => asset.role === 'video' && asset.state === 'present')

const resumeContent = computed(() => {
  if (selectedEpisode.value && hasVideo(selectedEpisode.value)) return selectedEpisode.value
  const available = library.value?.contents.filter(hasVideo) ?? []
  return (
    available.find((content) => content.position_sec > 0 && content.watch_status !== 'watched') ??
    available.find((content) => content.watch_status !== 'watched' && content.watch_status !== 'dropped') ??
    available[0]
  )
})
const resumeAsset = computed(() => {
  const content = resumeContent.value
  if (content) {
    return (
      content.assets.find((asset) => asset.role === 'video' && asset.path === content.path && asset.state === 'present') ??
      content.assets.find((asset) => asset.role === 'video' && asset.state === 'present')
    )
  }
  return (
    library.value?.assets.find(
      (asset) => asset.role === 'video' && asset.path === item.value?.path && asset.state === 'present'
    ) ?? library.value?.assets.find((asset) => asset.role === 'video' && asset.state === 'present')
  )
})
const playable = computed(() => !!resumeAsset.value)
const presentCount = computed(
  () => library.value?.assets.filter((asset) => asset.role === 'video' && asset.state === 'present').length ?? 0
)
const playLabel = computed(() =>
  (library.value?.contents.length ?? 0) > 1 && resumeContent.value
    ? '播放 ' + (resumeContent.value.display_label || resumeContent.value.title || '内容')
    : '播放'
)
const playHint = computed(() =>
  resumeAsset.value ? '用系统播放器打开：' + resumeAsset.value.path : '没有可用文件，请检查磁盘连接或重新定位文件'
)

async function play(): Promise<void> {
  if (!resumeAsset.value || playing.value) return
  playing.value = true
  try {
    const outcome = await window.baoyi.video.playAsset(resumeAsset.value.id)
    if (!outcome.ok) error(outcome.message || '无法打开视频文件')
    store.merge(outcome.item)
    await refreshLibrary()
  } catch (cause) {
    error(errorMessage(cause))
  } finally {
    playing.value = false
  }
}

async function revealSub(target: string): Promise<void> {
  if (!item.value) return
  const ok = await window.baoyi.video.revealSubtitle(item.value.id, target)
  if (!ok) error('未找到该字幕文件')
}

function openUrl(url: string): void {
  if (url) void window.baoyi.app.openUrl(url).catch((err) => error(errorMessage(err)))
}

const tmdbUrl = computed(() => {
  const v = item.value
  if (!v?.tmdb_id) return ''
  return `https://www.themoviedb.org/${v.video_type === 'series' ? 'tv' : 'movie'}/${v.tmdb_id}`
})
const doubanUrl = computed(() => (item.value?.douban_id ? `https://movie.douban.com/subject/${item.value.douban_id}/` : ''))
const hanimeUrl = computed(() => (item.value?.hanime_id ? `https://hanime1.me/watch?v=${item.value.hanime_id}` : ''))

function removeItem(): void {
  removalWork.value = true
}
async function afterRemoval(): Promise<void> {
  await store.reload()
  if (removalWork.value || !(await window.baoyi.video.get(props.id))) {
    success('已从影视库移除')
    void router.push({ name: 'video-home' })
    return
  }
  await refreshLibrary()
}

function viewCollection(name: string): void {
  store.select({
    kind: 'collection',
    value: name,
    ...(item.value?.category === HENTAI_CATEGORY ? { type: 'hentai' as const } : {}),
  })
  void router.push({ name: 'video-home' })
}
</script>

<template>
  <div class="detail">
    <div v-if="loading" class="detail__state">载入中…</div>
    <div v-else-if="!item || itemHidden" class="detail__state">
      <p role="status">{{ itemHidden ? '当前作品已隐藏。' : loadError || '这条记录不存在、已被移除或当前不可见。' }}</p>
      <button v-if="loadError" type="button" class="btn btn--ghost" @click="load">重新加载</button>
      <button type="button" class="btn btn--ghost" @click="router.push({ name: 'video-home' })">返回影视库</button>
    </div>

    <AudioDetail
      v-else-if="item.media_kind === 'audio'"
      :key="item.id"
      :item="item"
      :library="library"
      @refresh="refreshLibrary"
    />

    <template v-else>
      <header class="head">
        <button type="button" class="btn btn--subtle" @click="router.push({ name: 'video-home' })">
          <ArrowLeft :size="16" />
          返回影视库
        </button>

        <div class="head__actions">
          <button
            type="button"
            class="btn btn--primary detail__play"
            :disabled="playing || !playable"
            :title="playHint"
            @click="play"
          >
            <Play :size="14" />
            {{ playing ? '正在打开…' : playLabel }}
          </button>
          <button type="button" class="btn btn--ghost" @click="reveal">
            <FolderOpen :size="14" />
            打开所在文件夹
          </button>
          <button type="button" class="btn btn--ghost" @click="openDownload">
            <Download :size="14" />下载 / 补齐内容
          </button>
          <details ref="moreMenu" class="head__more" @keydown="closeMore">
            <summary class="btn btn--ghost" aria-label="更多作品操作">
              <MoreHorizontal :size="16" />更多
            </summary>
            <div class="head__moreMenu">
              <button type="button" class="btn btn--ghost" @click="openOrganize('relocate')">
                <FolderOpen :size="14" />目录管理 / 重新绑定
              </button>
              <button
                v-if="library?.directory"
                type="button"
                class="btn btn--ghost"
                @click="renameOpen = true; moreMenu && (moreMenu.open = false)"
              >
                <Pencil :size="14" />修改合集名称
              </button>
              <button
                type="button"
                class="btn btn--ghost"
                :disabled="!tmdbUrl"
                :title="tmdbUrl || '暂无 TMDB 条目'"
                @click="openUrl(tmdbUrl)"
              >
                <ExternalLink :size="14" />
                TMDB
              </button>
              <button
                type="button"
                class="btn btn--ghost"
                :disabled="!doubanUrl"
                :title="doubanUrl || '暂无豆瓣条目'"
                @click="openUrl(doubanUrl)"
              >
                <ExternalLink :size="14" />
                豆瓣
              </button>
              <button v-if="hanimeUrl" type="button" class="btn btn--ghost" :title="hanimeUrl" @click="openUrl(hanimeUrl)">
                <ExternalLink :size="14" />
                Hanime
              </button>
              <button
                v-if="item.official_url && item.official_url !== hanimeUrl"
                type="button"
                class="btn btn--ghost"
                :title="item.official_url"
                @click="openUrl(item.official_url)"
              >
                <ExternalLink :size="14" />
                来源页面
              </button>
              <button type="button" class="btn btn--ghost" :disabled="reidentifying" @click="reidentify(false)">
                <component :is="reidentifying ? Loader2 : RefreshCw" :size="14" :class="{ spin: reidentifying }" />
                重新识别
              </button>
              <button
                type="button"
                class="btn btn--ghost"
                :disabled="reidentifying"
                title="按里番来源强制匹配资料"
                @click="reidentify(true)"
              >
                <component :is="reidentifying ? Loader2 : RefreshCw" :size="14" :class="{ spin: reidentifying }" />
                按里番匹配
              </button>
              <button type="button" class="btn btn--ghost" @click="toggleArchive">
                <component :is="item.is_archived ? ArchiveRestore : Archive" :size="14" />
                {{ item.is_archived ? '取消归档' : '归档' }}
              </button>
              <button type="button" class="btn btn--danger" @click="removeItem">
                <Trash2 :size="14" />
                移除
              </button>
            </div>
          </details>
        </div>
      </header>

      <VideoSourceDialog
        v-if="sourceOpen"
        :item="item"
        :episodes="library?.contents || []"
        :episode-id="selectedEpisodeId"
        @close="sourceOpen = false"
        @changed="refreshLibrary"
      />
      <VideoRemovalDialog
        v-if="removalEpisode || removalWork"
        :resource-ids="[item.id]"
        :episode-id="removalEpisode || undefined"
        @close="removalEpisode = ''; removalWork = false"
        @changed="afterRemoval"
      />
      <CollectionNameDialog
        v-if="renameOpen"
        :item="item"
        @close="renameOpen = false"
        @changed="refreshLibrary"
      />
      <EpisodeArtworkDialog
        v-if="episodeArtworkOpen"
        :item="item"
        :episodes="library?.contents || []"
        :without-season="item.category === HENTAI_CATEGORY"
        @close="episodeArtworkOpen = false"
        @changed="refreshLibrary"
      />

      <div class="body">
        <div class="col col--main">
          <VideoDetailHero
            :item="item"
            :library="library"
            :editing="editing"
            :poster-busy="posterBusy"
            :episode-artwork-available="episodeArtworkAvailable"
            :present-count="presentCount"
            @update:editing="(v) => (editing = v)"
            @save="save"
            @commit-tags="commitTags"
            @change-type="changeType"
            @filter-tag="filterByTag"
            @copy-path="copyPath"
            @fetch-poster="fetchPoster"
            @pick-poster="pickPoster"
            @clear-poster="clearPoster"
            @open-episode-artwork="episodeArtworkOpen = true"
            @poster-missing="store.markPosterMissing(item.id)"
          />

          <nav class="detail-tabs no-select" role="tablist" aria-label="影视详情" @keydown="tabKeydown">
            <button
              v-for="tab in detailTabs"
              :id="'video-tab-' + tab.id"
              :key="tab.id"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab.id"
              :aria-controls="'video-panel-' + tab.id"
              :tabindex="activeTab === tab.id ? 0 : -1"
              @click="activeTab = tab.id"
            >
              {{ tab.label }}<span v-if="tab.count">{{ tab.count }}</span>
            </button>
          </nav>

          <div
            id="video-panel-contents"
            v-show="activeTab === 'contents'"
            role="tabpanel"
            aria-labelledby="video-tab-contents"
            tabindex="0"
          >
            <VideoItems
              :item="item"
              :library="library"
              :checking="checking"
              :check-message="lastCheck"
              :marking="!!busyEpisode"
              :selected-id="selectedEpisodeId"
              @select="showEpisode"
              @remove="removalEpisode = $event.id"
              @check="checkFiles"
              @changed="refreshLibrary"
              @watched="markWatched"
            />
          </div>

          <VideoEpisodeReadingPanel
            v-show="activeTab === 'description'"
            mode="description"
            :item="item"
            :title="title"
            :library="library"
            :selected-episode="selectedEpisode"
            :selected-episode-id="selectedEpisodeId"
            :editing="editing"
            :playing="playing"
            :play-hint="playHint"
            :busy-episode="busyEpisode"
            @update:selected-episode-id="(id) => (selectedEpisodeId = id)"
            @play="play"
            @scrape-selected="scrapeSelected"
            @open-source="sourceOpen = true"
            @pick-episode-image="pickEpisodeImage"
            @remove-episode="(id) => (removalEpisode = id)"
            @save-episode="saveEpisode"
            @save-work="save"
            @filter-tag="filterByTag"
            @open-url="openUrl"
          />

          <VideoEpisodeReadingPanel
            v-show="activeTab === 'notes'"
            mode="notes"
            :item="item"
            :title="title"
            :library="library"
            :selected-episode="selectedEpisode"
            :selected-episode-id="selectedEpisodeId"
            :editing="editing"
            :playing="playing"
            :play-hint="playHint"
            :busy-episode="busyEpisode"
            @update:selected-episode-id="(id) => (selectedEpisodeId = id)"
            @play="play"
            @scrape-selected="scrapeSelected"
            @open-source="sourceOpen = true"
            @pick-episode-image="pickEpisodeImage"
            @remove-episode="(id) => (removalEpisode = id)"
            @save-episode="saveEpisode"
            @save-work="save"
            @filter-tag="filterByTag"
            @open-url="openUrl"
          />

          <VideoFilesInfoTab
            v-show="activeTab === 'files'"
            :item="item"
            :library="library"
            :collection-groups="
              (item.category === HENTAI_CATEGORY ? store.counts.hentai_collections : store.counts.collections) || []
            "
            @reveal="reveal"
            @open-organize="openOrganize"
            @save="save"
            @open-source="sourceOpen = true"
            @view-collection="viewCollection"
            @unprotect="unprotect"
            @copy-path="copyPath"
            @reveal-sub="revealSub"
          />

          <ResourceBacklinksPanel
            v-show="activeTab === 'description' || activeTab === 'files'"
            :resource-id="item.id"
            style="margin-top: 16px"
          />
        </div>
      </div>
    </template>

    <DownloadPanel
      v-if="downloadFlow.open.value && !itemHidden"
      :key="id"
      :id="id"
      @close="downloadFlow.open.value = false"
    />
    <OrganizePanel
      v-if="organizeMode && item && !itemHidden"
      :key="id"
      :mode="organizeMode"
      :resource-id="id"
      :works="[item]"
      :directory="library?.directory"
      :return-focus="organizeReturnFocus"
      @close="organizeMode = ''"
      @changed="refreshLibrary"
    />
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}
.detail :is(button, input, textarea, select, summary):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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
.detail__play {
  max-width: 230px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.head__more {
  position: relative;
  flex: none;
}
.head__more > summary {
  list-style: none;
  cursor: pointer;
}
.head__more > summary::-webkit-details-marker {
  display: none;
}
.head__moreMenu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  width: 210px;
  max-height: calc(100dvh - 110px);
  overflow-y: auto;
  padding: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--divider);
  border-radius: var(--radius-input);
  box-shadow: var(--shadow-pop);
}
.head__moreMenu .btn {
  justify-content: flex-start;
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
.detail-tabs {
  display: flex;
  align-items: center;
  gap: 24px;
  border-bottom: 1px solid var(--divider);
  padding: 0 4px;
}
.detail-tabs button {
  min-height: 42px;
  padding: 8px 2px;
  display: flex;
  align-items: center;
  gap: 7px;
  border-bottom: 2px solid transparent;
  color: var(--text-sub);
  font-size: 13px;
  white-space: nowrap;
}
.detail-tabs button[aria-selected='true'] {
  color: var(--text-main);
  border-bottom-color: var(--accent);
  font-weight: 600;
}
.detail-tabs button:hover {
  color: var(--text-main);
}
.detail-tabs span {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--hover-surface);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
[role='tabpanel'] {
  min-width: 0;
}
[role='tabpanel']:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.spin {
  animation: spin 900ms linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1060px) {
  .detail__play {
    max-width: 170px;
  }
}
@media (max-width: 720px) {
  .head {
    gap: 6px;
    padding: 8px 12px;
    align-items: flex-start;
  }
  .head__actions {
    flex-wrap: wrap;
    gap: 5px;
  }
  .body {
    padding: 10px 12px 20px;
  }
  .detail-tabs {
    gap: 16px;
  }
}
</style>
