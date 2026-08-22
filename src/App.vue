<script setup lang="ts">
import { RouterView } from 'vue-router'
import TitleBar from '@/components/TitleBar.vue'
import ToastHost from '@/components/ToastHost.vue'
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
