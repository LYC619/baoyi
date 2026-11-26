<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { RouterView, useRouter } from 'vue-router'
import AudioMiniPlayer from '@/components/video/AudioMiniPlayer.vue'
import MusicSearchPanel from '@/components/video/MusicSearchPanel.vue'
import { useMusic } from '@/composables/useMusic'
import VideoUpdatesPanel from '@/components/video/VideoUpdatesPanel.vue'
import { useVideoUpdates } from '@/composables/useVideoUpdates'
import { useAudioStore } from '@/stores/audio'
import TitleBar from '@/components/TitleBar.vue'
import SourceDialog from '@/components/image/SourceDialog.vue'
import { useComicIngest } from '@/composables/useComicIngest'
import ProjectLauncher from '@/components/project/ProjectLauncher.vue'
import VideoPreviewDrawer from '@/components/video/VideoPreviewDrawer.vue'
import { useVideoPreview } from '@/composables/useVideoPreview'
import { activeModule } from '@/composables/useModules'
import ReturnToSource from '@/components/workspace/ReturnToSource.vue'
import ToastHost from '@/components/ui/ToastHost.vue'
import AppDialogHost from '@/components/ui/AppDialogHost.vue'
import GlobalSearchDialog from '@/components/ui/GlobalSearchDialog.vue'
import { useGlobalSearch } from '@/composables/useGlobalSearch'
import { drawerWidth, viewportWidth } from '@/composables/useFloatingDock'
import VideoImportPanel from '@/components/video/VideoImportPanel.vue'
import AgentOrganizePanel from '@/components/video/AgentOrganizePanel.vue'
import ImageReader from '@/components/image/ImageReader.vue'
import { useImageReader } from '@/composables/useImageReader'
import { useImageStore } from '@/stores/image'
import { useVideoAgentOrganize } from '@/composables/useVideoAgentOrganize'
import { useVideoImport } from '@/composables/useVideoImport'
import { useVideoWorkflow } from '@/composables/useVideoWorkflow'
import { watch } from 'vue'
import ArchiveAssistantPanel from '@/components/archive/ArchiveAssistantPanel.vue'
import { useArchiveAssistant } from '@/composables/useArchiveAssistant'

const router = useRouter()
const audio = useAudioStore()
const videoUpdates = useVideoUpdates()
const music = useMusic()
const globalSearch = useGlobalSearch()
const archiveAssistant = useArchiveAssistant()
const comicIngest = useComicIngest()
const videoPreview = useVideoPreview()
watch(activeModule, () => videoPreview.close())
const videoImport = useVideoImport()
const workflow = useVideoWorkflow()
const videoAgent = useVideoAgentOrganize()
const imageReader = useImageReader()
const images = useImageStore()

const splitRightPx = computed(() =>
  archiveAssistant.open.value && !archiveAssistant.wide.value && viewportWidth.value >= 1080 && drawerWidth.value > 0
    ? drawerWidth.value + 'px'
    : '0px'
)
const splitStyle = computed(() => (splitRightPx.value !== '0px' ? { marginRight: splitRightPx.value } : undefined))

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

function findVisiblePageSearch(): HTMLInputElement | null {
  const candidates = document.querySelectorAll<HTMLInputElement>(
    '.search__input, .pj-search input, input[aria-label*="搜索"], input[aria-label*="Search"], input[aria-label*="search"], .app__view input[type="search"]'
  )
  for (const el of candidates) {
    if (el.closest('.archive-panel, dialog, [popover]')) continue
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden') {
      return el
    }
  }
  return null
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  const mod = e.ctrlKey || e.metaKey
  const openModal = document.querySelector('dialog[open]')

  if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
    if (openModal && !globalSearch.open.value) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (globalSearch.open.value) globalSearch.closeGlobalSearch()
    else globalSearch.openGlobalSearch()
    return
  }

  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    if (globalSearch.open.value) {
      e.preventDefault()
      e.stopImmediatePropagation()
      globalSearch.closeGlobalSearch()
      return
    }
    if (openModal) return
    const pageSearch = findVisiblePageSearch()
    e.preventDefault()
    e.stopImmediatePropagation()
    if (pageSearch && document.activeElement !== pageSearch) {
      pageSearch.focus()
      pageSearch.select()
    } else {
      globalSearch.openGlobalSearch(pageSearch?.value || '')
    }
    return
  }

  if (openModal) return

  if (mod && !e.shiftKey && !e.altKey && e.key === ',') {
    e.preventDefault()
    void router.push({ name: 'settings', query: { module: activeModule.value, scope: 'module' } })
    return
  }

  if (!mod && !e.altKey && !e.shiftKey && e.key === '/' && !isEditableTarget(e.target)) {
    e.preventDefault()
    const pageSearch = findVisiblePageSearch()
    if (pageSearch) {
      pageSearch.focus()
      pageSearch.select()
    } else {
      globalSearch.openGlobalSearch()
    }
    return
  }

  if (e.altKey && !mod && !e.shiftKey && !isEditableTarget(e.target)) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      router.back()
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      router.forward()
    }
  }
}

let offNavigate: (() => void) | null = null

onMounted(() => {
  if (typeof window.baoyi.video.checkLibraryUpdates === 'function') {
    void videoUpdates.start(undefined, true)
  }
  window.addEventListener('keydown', onGlobalKeydown, true)
  offNavigate = window.baoyi.win.onNavigate?.((dir) => {
    if (document.querySelector('dialog[open]')) return
    if (dir === 'back') router.back()
    else if (dir === 'forward') router.forward()
  }) ?? null
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown, true)
  offNavigate?.()
})

watch(
  () => images.items,
  (items) => {
    const current = imageReader.session.value
    if (current && !items.some((item) => item.id === current.item.id)) void imageReader.close()
  }
)
watch(workflow.hideHentai, (hidden) => {
  videoImport.setPrivacy(hidden)
  if (hidden) {
    videoAgent.hide()
    audio.close()
  }
  archiveAssistant.privacyReset()
  videoPreview.close()
})
</script>

<template>
  <div class="app" :style="{ '--split-right': splitRightPx }">
    <TitleBar />
    <ReturnToSource :style="splitStyle" />
    <RouterView v-slot="{ Component, route }">
      <Transition name="page" mode="out-in">
        <component
          :is="Component"
          :key="route.meta.remountOnId ? String(route.params.id) : undefined"
          class="app__view"
          :style="splitStyle"
        />
      </Transition>
    </RouterView>
    <AudioMiniPlayer />
    <VideoUpdatesPanel />
    <MusicSearchPanel v-if="music.open.value" />
    <GlobalSearchDialog />
    <AppDialogHost /><ToastHost />
    <SourceDialog v-if="comicIngest.open.value && comicIngest.visible.value" />
    <ProjectLauncher />
    <VideoPreviewDrawer v-if="videoPreview.visible.value" />
    <ArchiveAssistantPanel />
    <VideoImportPanel v-if="videoImport.open.value" />
    <AgentOrganizePanel v-if="videoAgent.open.value" />
    <ImageReader
      v-if="imageReader.session.value"
      :key="imageReader.session.value.item.id + ':' + imageReader.session.value.startId"
      v-bind="imageReader.session.value"
      @close="imageReader.close"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-main);
}

.app__view,
.app > :deep(.home) {
  flex: 1;
  min-height: 0;
  border-bottom: 1px solid var(--divider);
  margin-right: var(--split-right, 0px);
}
</style>
