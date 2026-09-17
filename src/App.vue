<script setup lang="ts">
import { RouterView } from 'vue-router'
import TitleBar from '@/components/TitleBar.vue'
import ToastHost from '@/components/ui/ToastHost.vue'
import VideoImportPanel from '@/components/video/VideoImportPanel.vue'
import AgentOrganizePanel from '@/components/video/AgentOrganizePanel.vue'
import { useVideoAgentOrganize } from '@/composables/useVideoAgentOrganize'
import { useVideoImport } from '@/composables/useVideoImport'
import { useVideoWorkflow } from '@/composables/useVideoWorkflow'
import { watch } from 'vue'
const videoImport = useVideoImport(), workflow = useVideoWorkflow()
const videoAgent = useVideoAgentOrganize()
watch(workflow.hideHentai, hidden => { videoImport.setPrivacy(hidden); if (hidden) videoAgent.hide() })
</script>

<template>
  <div class="app">
    <TitleBar />
    <RouterView v-slot="{ Component }">
      <Transition name="page" mode="out-in">
        <component :is="Component" class="app__view" />
      </Transition>
    </RouterView>
    <ToastHost />
    <VideoImportPanel v-if="videoImport.open.value" />
    <AgentOrganizePanel v-if="videoAgent.open.value" />
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
}
</style>
