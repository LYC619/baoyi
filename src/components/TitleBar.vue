<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Copy, Minus, Square, X } from 'lucide-vue-next'
import BaoyiLogo from '@/components/ui/BaoyiLogo.vue'
import TaskCenter from '@/components/tasks/TaskCenter.vue'
import {
  MODULE_TABS,
  activeModule,
  moduleTarget,
  type ModuleKey
} from '@/composables/useModules'
import { useSoftwareStore } from '@/stores/software'
import { useGameStore } from '@/stores/game'
import { useVideoStore } from '@/stores/video'
import { useImageStore } from '@/stores/image'
import { useProjectStore } from '@/stores/project'

const route = useRoute()
const router = useRouter()
const software = useSoftwareStore()
const game = useGameStore()
const video = useVideoStore()
const images = useImageStore()
const projects = useProjectStore()

const maximized = ref(false)
let unsubscribe: (() => void) | null = null

onMounted(async () => {
  maximized.value = await window.baoyi.win.isMaximized()
  unsubscribe = window.baoyi.win.onMaximizeChange((v) => (maximized.value = v))
  // 顶栏一直在，游戏页和影视页却未必进过 —— 数字得自己去取一次，不能等那一页来喂
  void game.refreshCounts()
  void video.refreshCounts()
  void images.refresh()
  void projects.refresh()
})

onUnmounted(() => unsubscribe?.())

const minimize = () => window.baoyi.win.minimize()
const toggleMaximize = () => window.baoyi.win.toggleMaximize()
const close = () => window.baoyi.win.close()

/** 引导页还没进主界面，这时候摆两个模块 Tab 只会让人分神 */
const showTabs = computed(() => route.name !== 'onboarding')

/**
 * total 为 null = 「还没有这回事」，显示成「—」。三个模块现在都有真数字了，
 * 这条分支留着是给下一个模块用的 —— 新模块接进来时，库表建好之前报 0
 * 就是在替一个不存在的表撒谎。
 *
 * 游戏和影视的 pending 恒为 0：这两个品类识别直接落库，没有确认队列
 * （见 kinds/game/service.ts 和 kinds/video/service.ts 里同一段理由）。
 */
const stats = computed<Record<ModuleKey, { total: number | null; pending: number }>>(() => ({
  software: { total: software.counts.all, pending: software.counts.pending_confirm },
  game: { total: game.counts.all, pending: 0 },
  video: { total: video.counts.all, pending: 0 },
  image: { total: images.count, pending: 0 },
  project: { total: projects.items.length, pending: 0 }
}))

function go(key: ModuleKey): void {
  const tab = MODULE_TABS.find(tab => tab.key === key)!
  void router.push(key === activeModule.value ? { name: tab.home } : moduleTarget(key))
}
</script>

<template>
  <header class="titlebar">
    <div class="titlebar__brand">
      <BaoyiLogo :size="22" />
      <span class="titlebar__name">抱一</span>
    </div>

    <nav v-if="showTabs" class="tabs">
      <button
        v-for="tab in MODULE_TABS"
        :key="tab.key"
        class="tab"
        :class="{ 'tab--on': activeModule === tab.key }"
        :title="activeModule === tab.key ? `返回${tab.label}库首页` : `切换到${tab.label}库`"
        @click="go(tab.key)"
      >
        <span>{{ tab.label }}</span>
        <span class="tab__n">{{ stats[tab.key].total ?? '—' }}</span>
        <!-- 待办角标只挂在没亮的那个 Tab 上：亮着的模块，页面里已经有一条更详细的提示了 -->
        <span
          v-if="activeModule !== tab.key && stats[tab.key].pending > 0"
          class="tab__dot"
          :title="`${stats[tab.key].pending} 个待确认`"
        />
      </button>
    </nav>

    <TaskCenter />

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
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 2px;
  color: var(--text-main);
}

/* ------------------------------ 模块切换 ------------------------------ */
.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 18px;
  -webkit-app-region: no-drag;
}

.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: var(--radius-btn);
  font-size: var(--fs-body);
  color: var(--text-faint);
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease;
}
.tab:hover {
  color: var(--text-main);
  background: var(--hover-surface);
}
.tab--on {
  background: var(--active-surface);
  color: var(--accent);
}

.tab__n {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.tab--on .tab__n {
  color: var(--accent);
}

.tab__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
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
