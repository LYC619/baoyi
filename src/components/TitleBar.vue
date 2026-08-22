<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Copy, Minus, Square, X } from 'lucide-vue-next'
import BaoyiLogo from './BaoyiLogo.vue'

const maximized = ref(false)
let unsubscribe: (() => void) | null = null

onMounted(async () => {
  maximized.value = await window.baoyi.win.isMaximized()
  unsubscribe = window.baoyi.win.onMaximizeChange((v) => (maximized.value = v))
})

onUnmounted(() => unsubscribe?.())

const minimize = () => window.baoyi.win.minimize()
const toggleMaximize = () => window.baoyi.win.toggleMaximize()
const close = () => window.baoyi.win.close()
</script>

<template>
  <header class="titlebar">
    <div class="titlebar__brand">
      <BaoyiLogo :size="22" />
      <span class="titlebar__name">抱一</span>
      <span class="titlebar__slogan">知止而后得</span>
    </div>

    <div class="titlebar__controls">
      <button class="ctl" title="最小化" @click="minimize">
        <Minus :size="15" />
      </button>
      <button class="ctl" :title="maximized ? '还原' : '最大化'" @click="toggleMaximize">
        <Copy v-if="maximized" :size="13" />
        <Square v-else :size="12" />
      </button>
      <button class="ctl ctl--close" title="关闭" @click="close">
        <X :size="15" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: var(--titlebar-h);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: 16px;
  background: var(--bg-side);
  border-bottom: 1px solid var(--divider);
  -webkit-app-region: drag;
}

.titlebar__brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.titlebar__name {
  font-family: var(--font-serif);
  font-size: 15px;
  letter-spacing: 2px;
  color: var(--text-main);
}

.titlebar__slogan {
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-faint);
  margin-left: 4px;
}

.titlebar__controls {
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
}

.ctl {
  width: 44px;
  display: grid;
  place-items: center;
  color: var(--text-sub);
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease;
}
.ctl:hover {
  background: var(--hover-surface);
  color: var(--text-main);
}
.ctl--close:hover {
  background: #e81123;
  color: #fff;
}
</style>
