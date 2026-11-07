<script setup lang="ts">
import { RouterView } from 'vue-router'
import AudioMiniPlayer from '@/components/video/AudioMiniPlayer.vue'
import {useAudioStore} from '@/stores/audio'
import TitleBar from '@/components/TitleBar.vue'
import SourceDialog from '@/components/image/SourceDialog.vue'
import {useComicIngest} from '@/composables/useComicIngest'
import ProjectLauncher from '@/components/project/ProjectLauncher.vue'
import DocumentInsightConsent from '@/components/workspace/DocumentInsightConsent.vue'
import VideoPreviewDrawer from '@/components/video/VideoPreviewDrawer.vue'
import {useVideoPreview} from '@/composables/useVideoPreview'
import {activeModule} from '@/composables/useModules'
import ReturnToSource from '@/components/workspace/ReturnToSource.vue'
import ToastHost from '@/components/ui/ToastHost.vue'
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
import {useArchiveAssistant} from '@/composables/useArchiveAssistant'
const audio=useAudioStore()
const archiveAssistant=useArchiveAssistant()
const comicIngest=useComicIngest()
const videoPreview=useVideoPreview()
watch(activeModule,()=>videoPreview.close())
const videoImport = useVideoImport(), workflow = useVideoWorkflow()
const videoAgent = useVideoAgentOrganize()
const imageReader = useImageReader()
const images = useImageStore()
watch(()=>images.items,items=>{const current=imageReader.session.value;if(current&&!items.some(item=>item.id===current.item.id))void imageReader.close()})
watch(workflow.hideHentai, hidden => { videoImport.setPrivacy(hidden); if (hidden) {videoAgent.hide();audio.close()}archiveAssistant.privacyReset();videoPreview.close() })
</script>

<template>
  <div class="app">
    <TitleBar />
    <ReturnToSource />
    <RouterView v-slot="{ Component }">
      <Transition name="page" mode="out-in">
        <component :is="Component" class="app__view" />
      </Transition>
    </RouterView>
    <AudioMiniPlayer />
    <ToastHost />
    <SourceDialog v-if="comicIngest.open.value&&comicIngest.visible.value"/>
    <ProjectLauncher />
    <DocumentInsightConsent />
    <VideoPreviewDrawer v-if="videoPreview.visible.value" />
    <ArchiveAssistantPanel />
    <VideoImportPanel v-if="videoImport.open.value" />
    <AgentOrganizePanel v-if="videoAgent.open.value" />
    <ImageReader v-if="imageReader.session.value" :key="imageReader.session.value.item.id + ':' + imageReader.session.value.startId" v-bind="imageReader.session.value" @close="imageReader.close" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-main);
}

.app__view {
  flex: 1;
  min-height: 0;
  border-bottom: 1px solid var(--divider);
}
</style>
