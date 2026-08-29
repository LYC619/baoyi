<script setup lang="ts">
/**
 * 游戏库首页：封面墙 + 侧边栏。
 *
 * 只有网格一种排布，没有软件那边的「网格 / 列表」切换 —— 游戏靠封面认，
 * 一行文字的列表把唯一的识别线索扔了。规划书 Step 1 里推迟到这一步的
 * 「每个模块各记一份 view_mode」也因此不用做：只有一种视图，没什么可记的。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { FolderPlus, Search, Settings, X } from 'lucide-vue-next'
import GameCard from '@/components/game/GameCard.vue'
import Sidebar from '@/components/game/Sidebar.vue'
import type { GameQuery, GameScanProgress } from '@/types'
import { recallScroll, rememberScroll } from '@/composables/useModules'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import { useGameStore } from '@/stores/game'
import { debounce, errorMessage, shortenPath } from '@/utils'

const router = useRouter()
const store = useGameStore()
const settings = useSettingsStore()
const { toast, success, error } = useToast()

const content = ref<HTMLElement | null>(null)

const scanning = ref(false)
const progress = ref<GameScanProgress | null>(null)
let unsubscribe: (() => void) | null = null

const SORTS: Array<{ value: NonNullable<GameQuery['sort']>; label: string }> = [
  { value: 'played', label: '最近游玩' },
  { value: 'added', label: '最近加入' },
  { value: 'playtime', label: '游玩时长' },
  { value: 'name', label: '按名称' }
]

let offSession: (() => void) | null = null

onMounted(async () => {
  unsubscribe = window.baoyi.game.onProgress((p) => (progress.value = p))
  // 在封面墙上也订阅：用户可能从详情页启动完就退回来，等游戏关掉时人在这一屏。
  // 不订阅的话卡片上的时长要等到下一次开库才更新
  offSession = window.baoyi.game.onSession(() => void store.reload())
  await store.reload()
  await nextTick()
  // 内容还没渲染时容器高度是 0，这时候设 scrollTop 会被浏览器吞掉
  if (content.value) content.value.scrollTop = recallScroll('game')
})

onBeforeUnmount(() => {
  if (content.value) rememberScroll('game', content.value.scrollTop)
  unsubscribe?.()
  offSession?.()
})

const busyText = computed(() => {
  const p = progress.value
  if (!p) return '准备中'
  if (p.phase === 'scanning') return `正在扫描 ${shortenPath(p.current, 40)}`
  return `识别 ${p.processed + 1}/${p.total}　${p.log || shortenPath(p.current, 32)}`
})

const busyPercent = computed(() => {
  const p = progress.value
  // 扫描阶段的总数要扫完才知道，这时候画一根瞎跳的进度条不如画一根空的
  if (!p || p.phase === 'scanning' || p.total === 0) return 0
  return Math.round((p.processed / p.total) * 100)
})

const onKeyword = debounce(() => void store.load(), 220)

function clearKeyword(): void {
  store.keyword = ''
  void store.load()
}

function open(id: string): void {
  void router.push({ name: 'game-detail', params: { id } })
}

const cancelScan = (): void => window.baoyi.game.cancel()

/**
 * 加游戏：选目录 → 扫 → 逐个交给 agent 识别 → 直接落库。
 *
 * 没有 AI 就不要往下走。扫描本身能跑，但扫出来的候选没人识别，
 * 结果是「点了加游戏，什么也没发生」—— 那比明说一句更让人困惑。
 */
async function addGames(): Promise<void> {
  if (!settings.settings.ai.enabled || !settings.settings.ai.api_key) {
    toast('游戏识别要用 AI，先去设置里填好 API Key')
    void router.push({ name: 'settings', query: { tab: 'ai' } })
    return
  }

  const dirs = await window.baoyi.game.pickDirectories()
  if (dirs.length === 0) return

  scanning.value = true
  progress.value = null
  try {
    const r = await window.baoyi.game.scan(dirs)
    await store.reload()

    if (r.candidates === 0) {
      toast('这些目录里没找到游戏（没有可执行文件，或者只是一层收纳目录）')
    } else if (r.registered > 0) {
      success(
        `识别出 ${r.registered} 个游戏` +
          (r.skipped > 0 ? `，跳过 ${r.skipped} 个` : '') +
          (r.failed > 0 ? `，${r.failed} 个失败` : '')
      )
    } else {
      // 扫到了却一个都没进库，得说清楚是「都不是游戏」还是「跑挂了」
      error(
        r.failed > 0
          ? `${r.candidates} 个目录全部识别失败，检查一下 AI 配置`
          : `扫到 ${r.candidates} 个目录，但 AI 认为都不是游戏`
      )
    }
  } catch (err) {
    error(`扫描没能跑起来：${errorMessage(err)}`)
  } finally {
    scanning.value = false
    progress.value = null
  }
}

const emptyHint = computed(() => {
  if (store.keyword.trim()) return { title: '没有匹配的游戏', desc: '换个关键词，或清空搜索' }
  if (store.selection.kind === 'status')
    return { title: `「${store.heading}」里还没有游戏`, desc: '在详情页可以改游玩状态' }
  if (store.counts.all === 0)
    return { title: '游戏库还是空的', desc: '点右上角「加游戏」，指一个游戏目录给它' }
  return { title: '这里还没有内容', desc: '换个分类看看' }
})
</script>

<template>
  <div class="home">
    <Sidebar />

    <main class="home__main">
      <header class="toolbar">
        <div class="toolbar__title">
          <h1>{{ store.heading }}</h1>
          <span class="toolbar__count">{{ store.items.length }}</span>
        </div>

        <div class="search">
          <Search :size="15" class="search__icon" />
          <input
            v-model="store.keyword"
            class="search__input"
            type="text"
            placeholder="搜索游戏名、简介、标签"
            @input="onKeyword"
          />
          <button v-if="store.keyword" class="search__clear" title="清空" @click="clearKeyword">
            <X :size="14" />
          </button>
        </div>

        <div class="toolbar__actions">
          <select v-model="store.sort" class="select" @change="store.load()">
            <option v-for="o in SORTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>

          <button class="btn btn--primary" :disabled="scanning" @click="addGames">
            <FolderPlus :size="15" />
            加游戏
          </button>

          <button class="btn btn--subtle" title="设置" @click="router.push({ name: 'settings' })">
            <Settings :size="16" />
          </button>
        </div>
      </header>

      <Transition name="fade">
        <div v-if="scanning" class="progress">
          <div class="progress__bar"><i :style="{ width: `${busyPercent}%` }" /></div>
          <span class="progress__text truncate">{{ busyText }}</span>
          <button class="btn btn--subtle" @click="cancelScan">停止</button>
        </div>
      </Transition>

      <section ref="content" class="home__content">
        <div v-if="store.items.length > 0" class="wall">
          <GameCard v-for="g in store.items" :key="g.id" :item="g" @open="open" />
        </div>
        <div v-else-if="!store.loading" class="empty">
          <h2>{{ emptyHint.title }}</h2>
          <p>{{ emptyHint.desc }}</p>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
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

/* 封面墙。150px 一格，1080p 下一行大约八张，够扫又不至于小到看不清名字 */
.wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 18px 14px;
  align-content: start;
}

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
</style>
