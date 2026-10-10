<script setup lang="ts">
import LibraryToolbarMenu from '@/components/library/LibraryToolbarMenu.vue'
/**
 * 游戏库首页：封面墙 + 侧边栏。
 *
 * 只有网格一种排布，没有软件那边的「网格 / 列表」切换 —— 游戏靠封面认，
 * 一行文字的列表把唯一的识别线索扔了。规划书 Step 1 里推迟到这一步的
 * 「每个模块各记一份 view_mode」也因此不用做：只有一种视图，没什么可记的。
 */
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { FilePlus, FolderPlus, Image, ListChecks, Search, Settings, X } from 'lucide-vue-next'
import GameCard from '@/components/game/GameCard.vue'
import LibraryBulkPanel from '@/components/library/LibraryBulkPanel.vue'
import { useLibrarySelection } from '@/composables/useLibrarySelection'
import Sidebar from '@/components/game/Sidebar.vue'
import type { GameQuery } from '@/types'
import { recallScroll, rememberScroll } from '@/composables/useModules'
import { useToast } from '@/composables/useToast'
import { useMediaScan } from '@/composables/useMediaScan'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useSettingsStore } from '@/stores/settings'
import { useGameStore } from '@/stores/game'
import { debounce, errorMessage, shortenPath } from '@/utils'
import { useLibraryView } from '@/composables/useLibraryView'
import { libraryBlocks } from '@/utils/library-grouping'

const router = useRouter()
const store = useGameStore()
const settings = useSettingsStore()
const { toast, success, error } = useToast()

const content = ref<HTMLElement | null>(null)
const { grouping, cardSize } = useLibraryView('game')
const blocks = computed(() => libraryBlocks(store.items, grouping.value, item => ['其他','未分类'].includes(item.category) ? '' : item.category, item => item.source_dir, settings.settings.game_scan_dirs))
const unavailable = computed(() => store.items.filter(item=>item.path_state && item.path_state !== 'present'))

const operation = useMediaScan('game')
const tasks = useTaskCenter()
const preparing = ref(false)
const fillingCovers = ref(false)
const coverSummary = ref('')
const registering = ref(false)
const bulkBusy = ref(false), savedCategories = ref<string[]>([])
const selection = useLibrarySelection(() => store.items, () => bulkBusy.value || coversBusy.value)
const { selecting, selectedIds } = selection
const bulkTrigger = ref<HTMLButtonElement>()
watch(selecting, async active => { if (!active) { await nextTick(); bulkTrigger.value?.focus() } })
const bulkItems = computed(() => store.items.map(item => ({ id: item.id, name: item.name_zh || item.name_en || item.file_name })))
const bulkCategories = computed(() => [...new Set([...savedCategories.value, ...store.items.map(item => item.category), '其他'])])
const filtered = computed(() => !!store.keyword.trim() || store.selection.kind !== 'group' || store.selection.value !== 'all')
function clearFilters() { store.keyword = ''; store.select({ kind: 'group', value: 'all' }) }
async function bulkCompleted(failedIds: string[]) { selectedIds.value = new Set(failedIds); await store.reload() }
const coverScope = computed(() => store.items.filter(game => !selecting.value || selectedIds.value.has(game.id)).map(game => game.id))
const coversBusy = computed(() => fillingCovers.value || tasks.runningTasks.value.some(task => task.kind === 'game-scan' && task.title === '批量补齐游戏封面'))
const scanning = computed(() => preparing.value || operation.running.value)
const progress = operation.progress
let pageDisposed = false

const SORTS: Array<{ value: NonNullable<GameQuery['sort']>; label: string }> = [
  { value: 'played', label: '最近游玩' },
  { value: 'added', label: '最近加入' },
  { value: 'playtime', label: '游玩时长' },
  { value: 'name', label: '按名称' }
]

let offSession: (() => void) | null = null
let focusedAt=0
function refreshOnFocus(){if(Date.now()-focusedAt>2000){focusedAt=Date.now();void store.load()}}

onMounted(async () => {
  window.addEventListener('focus',refreshOnFocus)
  // 在封面墙上也订阅：用户可能从详情页启动完就退回来，等游戏关掉时人在这一屏。
  // 不订阅的话卡片上的时长要等到下一次开库才更新
  offSession = window.baoyi.game.onSession(() => void store.reload())
  await store.reload()
  try { savedCategories.value = (await window.baoyi.categories.list('game')).map(category => category.name) } catch (err) { error(errorMessage(err)) }
  await nextTick()
  // 内容还没渲染时容器高度是 0，这时候设 scrollTop 会被浏览器吞掉
  if (content.value) content.value.scrollTop = recallScroll('game')
})

onBeforeUnmount(() => {
  window.removeEventListener('focus',refreshOnFocus)
  if (content.value) rememberScroll('game', content.value.scrollTop)
  pageDisposed = true
  offSession?.()
})

const busyText = computed(() => {
  const p = progress.value
  if (operation.stopping.value && operation.running.value) return '正在停止，等待当前 agent 收尾…'
  if (!p) return '准备中'
  if (p.phase === 'done') return '正在刷新资源库…'
  if (p.phase === 'scanning') return `正在扫描 ${shortenPath(p.current, 40)}`
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

function open(id: string): void {
  void router.push({ name: 'game-detail', params: { id } })
}

function cancelScan(): void {
  try { operation.cancel() }
  catch (err) { error('停止扫描失败：' + errorMessage(err)) }
}

function toggleSelected(id: string): void {
  selection.toggle(id)
}

function toggleSelection(): void {
  selection.toggleMode()
}

async function addManualGame(): Promise<void> {
  if (registering.value) return
  registering.value = true
  try {
    const result = await window.baoyi.game.addManual()
    if (!result) return
    if (!result.ok) { if (!pageDisposed) error(result.message); return }
    await store.reload()
    if (!pageDisposed) {
      success(result.message)
      if (result.item) open(result.item.id)
    }
  } catch (err) {
    if (!pageDisposed) error('登记游戏失败：' + errorMessage(err))
  } finally { registering.value = false }
}

async function fillMissingCovers(): Promise<void> {
  if (coversBusy.value || coverScope.value.length === 0) return
  const ids = [...coverScope.value]
  fillingCovers.value = true
  coverSummary.value = `正在检查 ${ids.length} 个游戏的封面`
  const taskId = tasks.start('game-scan', '批量补齐游戏封面', { total: ids.length })
  let off: (() => void) | undefined
  try {
    off = window.baoyi.game.onCoverProgress((p) => {
      const message = p.current ? `${p.current}：${p.message}` : p.message
      coverSummary.value = message
      tasks.update(taskId, { processed: p.processed, total: p.total, current: p.current, message: p.message }, { level: p.message.includes('失败') ? 'warn' : 'info', message })
    })
    const result = await window.baoyi.game.rebuildCovers(ids)
    const skipped = Math.max(0, result.processed - result.updated - result.failed)
    const message = result.processed === 0 ? '当前范围的封面已齐全'
      : `${result.failed && result.updated ? '部分完成' : '处理结束'}：已处理 ${result.processed} 个，补齐 ${result.updated} 个${result.failed ? `，失败 ${result.failed} 个` : ''}${skipped ? `，跳过 ${skipped} 个（保留较新的选择）` : ''}`
    coverSummary.value = message
    tasks.update(taskId, { processed: result.processed, total: result.processed, percent: 100, current: '', message })
    tasks.finish(taskId, result.failed ? 'failed' : 'success', message)
    await store.reload()
    if (!pageDisposed) toast(message)
  } catch (err) {
    coverSummary.value = `封面补齐失败：${errorMessage(err)}`
    tasks.finish(taskId, 'failed', '封面补齐失败', errorMessage(err))
  } finally {
    off?.()
    fillingCovers.value = false
  }
}

/**
 * 加游戏：选目录 → 扫 → 逐个交给 agent 识别 → 直接落库。
 *
 * 没有 AI 就不要往下走。扫描本身能跑，但扫出来的候选没人识别，
 * 结果是「点了加游戏，什么也没发生」—— 那比明说一句更让人困惑。
 */
async function addGames(): Promise<void> {
  if (scanning.value) return
  preparing.value = true
  let started = false
  const recordAttempt = (status: 'failed' | 'cancelled', message: string): void => {
    const id = tasks.start('game-scan', '游戏扫描预检')
    tasks.finish(id, status, message, status === 'failed' ? message : undefined)
  }
  try {
    if (!settings.settings.ai.enabled || !settings.settings.ai.api_key.trim()) {
      const message = '游戏识别要用 AI，先去设置里填好 API Key'
      recordAttempt('failed', message)
      toast(message)
      void router.push({ name: 'settings', query: { tab: 'ai' } })
      return
    }
    const dirs = await window.baoyi.game.pickDirectories()
    if (pageDisposed || dirs.length === 0) {
      recordAttempt('cancelled', pageDisposed ? '已离开页面，未启动扫描' : '未选择目录，未启动扫描')
      return
    }
    started = true
    const r = await operation.run(dirs)
    const stopped = operation.stopping.value
    await store.reload()
    if (stopped) {
      toast('扫描已停止：已注册 ' + r.registered + ' 个，已完成的结果已保留')
    } else if (r.candidates === 0) {
      toast('这些目录里没找到游戏（没有可执行文件，或者只是一层收纳目录）')
    } else if (r.registered > 0) {
      const message = '识别出 ' + r.registered + ' 个游戏' +
        (r.skipped > 0 ? '，跳过 ' + r.skipped + ' 个' : '') +
        (r.failed > 0 ? '，' + r.failed + ' 个失败' : '')
      if (r.failed > 0) toast(message)
      else success(message)
    } else if (r.failed > 0) {
      error('扫描到 ' + r.candidates + ' 个候选，但没有注册成功，' + r.failed + ' 个识别失败，请查看识别日志')
    } else {
      toast('扫描到 ' + r.candidates + ' 个候选，全部跳过；可到识别日志查看原因')
    }
  } catch (err) {
    if (!started) recordAttempt('failed', errorMessage(err))
    error('扫描没能完成：' + errorMessage(err))
  } finally {
    preparing.value = false
  }
}

const emptyHint = computed(() => {
  if (store.keyword.trim()) return { title: '没有匹配的游戏', desc: '换个关键词，或清空搜索' }
  if (store.selection.kind === 'status')
    return { title: `「${store.heading}」里还没有游戏`, desc: '在详情页可以改游玩状态' }
  if (store.counts.all === 0)
    return { title: '游戏库还是空的', desc: '点右上角「加游戏」，选择本地启动程序；也可用 AI 扫描整个目录' }
  return { title: '这里还没有内容', desc: '换个分类看看' }
})
</script>

<template>
  <div class="home" @keydown="selection.key">
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
            aria-label="搜索游戏"
            placeholder="搜索游戏名、简介、标签"
            @input="onKeyword"
          />
          <button v-if="store.keyword" class="search__clear" title="清空" @click="clearKeyword">
            <X :size="14" />
          </button>
        </div>

        <div class="toolbar__actions">


          <select v-model="store.sort" class="select" aria-label="游戏排序" @change="store.load()">
            <option v-for="o in SORTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>

          <button class="btn btn--primary" :disabled="registering" @click="addManualGame">
            <FilePlus :size="15" />
            {{ registering ? '登记中' : '加游戏' }}
          </button>





          <button ref="bulkTrigger" v-if="!selecting" class="btn btn--ghost" :aria-pressed="selecting" :disabled="store.items.length === 0 || store.loading || coversBusy" @click="toggleSelection">
            <ListChecks :size="15" />
            批量管理
          </button>

          <LibraryToolbarMenu label="视图">
          <select v-model="grouping" class="select" aria-label="游戏分组"><option value="none">不分组</option><option value="category">按分类分组</option><option value="directory">按一级文件夹分组</option></select>
          <label class="card-size">卡片大小<input v-model.number="cardSize" type="range" min="110" max="260" step="10" aria-label="游戏卡片大小"/></label>
          </LibraryToolbarMenu>
          <LibraryToolbarMenu label="更多">
          <button class="btn btn--ghost" :disabled="scanning" title="扫描目录并由 AI 识别游戏" @click="addGames">
            <FolderPlus :size="15" />
            AI 扫描
          </button>
          <button class="btn btn--ghost" :disabled="bulkBusy || coversBusy || coverScope.length === 0" :title="selecting ? '只补齐当前筛选中已选择游戏的缺失封面' : '为当前筛选列表补齐缺失封面'" @click="fillMissingCovers">
            <Image :size="15" />
            {{ coversBusy ? '补图中' : `补齐封面（${coverScope.length}）` }}
          </button>
          </LibraryToolbarMenu>
          <button class="btn btn--subtle" title="设置" @click="router.push({ name: 'settings' })">
            <Settings :size="16" />
          </button>
        </div>
      </header>

      <LibraryBulkPanel v-if="selecting" kind="game" :pending="store.queryPending" :items="bulkItems" :ids="[...selectedIds]" :categories="bulkCategories" @all="selection.selectAll" @clear="selection.clear" @close="selection.toggleMode" @busy="bulkBusy = $event" @completed="bulkCompleted" @refresh="store.reload" />

      <Transition name="fade">
        <div v-if="scanning" class="progress">
          <div class="progress__bar"><i :style="{ width: `${busyPercent}%` }" /></div>
          <span class="progress__text truncate">{{ busyText }}</span>
          <button class="btn btn--subtle" :disabled="!operation.running.value || operation.stopping.value || progress?.phase === 'done'" @click="cancelScan">停止</button>
        </div>
      </Transition>

      <p v-if="coverSummary" class="cover-summary" role="status">{{ coverSummary }}</p>
      <p v-if="unavailable.length" class="cover-summary" role="status">{{unavailable.length}} 个游戏的程序路径不可用，进入详情可重新定位文件夹。<button class="btn btn--subtle" @click="store.reload()">重新检查</button></p>

      <section ref="content" class="home__content">
        <template v-if="store.items.length > 0"><section v-for="block in blocks" :key="block.key" class="game-group"><h2 v-if="block.name">{{block.name}} <small>{{block.items.length}}</small></h2><div class="wall" :style="{gridTemplateColumns:`repeat(auto-fill, minmax(${cardSize}px, 1fr))`}">
          <GameCard v-for="g in block.items" :key="g.id" :item="g" :selectable="selecting" :selected="selectedIds.has(g.id)" :locked="bulkBusy || coversBusy || store.queryPending" @open="open" @select="toggleSelected" />
        </div></section></template>
        <div v-else-if="!store.loading" class="empty">
          <h2>{{ emptyHint.title }}</h2>
          <p>{{ emptyHint.desc }}</p>
          <button v-if="filtered" class="btn btn--ghost" @click="clearFilters">清空筛选</button>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.card-size{display:flex;align-items:center;gap:7px;color:var(--text-sub);font-size:12px}.card-size input{width:90px;accent-color:var(--accent)}.game-group{margin-bottom:26px}.game-group h2{font-size:17px;font-weight:500;margin-bottom:14px}.game-group small{font-size:12px;color:var(--text-faint);margin-left:7px}
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
  flex-wrap: wrap;
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
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

.cover-summary { margin: 0 20px 12px; color: var(--text-sub); font-size: var(--fs-tag); overflow-wrap: anywhere; }

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
