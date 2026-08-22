<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  FolderSearch,
  LayoutGrid,
  List,
  Plus,
  Settings,
  Sparkles,
  Timer
} from 'lucide-vue-next'
import CardGrid from '@/components/CardGrid.vue'
import SearchBar from '@/components/SearchBar.vue'
import Sidebar from '@/components/Sidebar.vue'
import type { SoftwareQuery } from '@/types'
import { useAI } from '@/composables/useAI'
import { useFilter } from '@/composables/useFilter'
import { useScan } from '@/composables/useScan'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import { useSoftwareStore } from '@/stores/software'

const router = useRouter()
const store = useSoftwareStore()
const settings = useSettingsStore()
const { toast, success, error } = useToast()
const { viewMode, setViewMode, setMastery, setSort, masteryOptions, sortOptions } = useFilter()
const ai = useAI()
const scan = useScan()

const addMenuOpen = ref(false)

const busy = computed(() => scan.running.value || ai.running.value)
const busyText = computed(() => {
  if (scan.running.value) return scan.phaseLabel.value
  if (ai.running.value) {
    const p = ai.progress.value
    return p ? `AI 正在识别 ${p.processed}/${p.total}` : 'AI 正在识别'
  }
  return ''
})
const busyPercent = computed(() =>
  scan.running.value ? scan.percent.value : ai.percent.value
)

onMounted(() => {
  void store.reload()
  document.addEventListener('click', closeAddMenu)
})
onBeforeUnmount(() => document.removeEventListener('click', closeAddMenu))

function closeAddMenu(): void {
  addMenuOpen.value = false
}

function open(id: string): void {
  void router.push({ name: 'detail', params: { id } })
}

async function launch(id: string): Promise<void> {
  const ok = await store.launch(id)
  if (!ok) error('启动失败，文件可能已被移动或删除')
}

/**
 * 「重新扫描目录」：只负责扫描 + 汇报，不替用户按下识别那一步 ——
 * 识别是要花 token 的，得由用户点头。
 */
async function rescan(): Promise<void> {
  const dirs = settings.settings.scan_dirs
  if (dirs.length === 0) {
    toast('还没有配置扫描目录，先去设置里添加')
    void router.push({ name: 'settings', query: { tab: 'scan' } })
    return
  }

  const result = await scan.run(dirs)
  await store.reload()

  if (result.pending === 0) {
    toast(`未发现新软件（共扫描到 ${result.found} 个程序，目录都已处理过）`)
    return
  }

  const ok = window.confirm(
    result.added > 0
      ? `发现 ${result.added} 个新目录，当前共 ${result.pending} 个待识别。\n是否现在进入识别？`
      : `没有新增目录，但还有 ${result.pending} 个目录待识别。\n是否现在进入识别？`
  )
  if (!ok) {
    toast(`已记录 ${result.pending} 个待识别目录，随时可到设置里处理`)
    return
  }
  void router.push({ name: 'settings', query: { tab: 'scan', focus: 'pending' } })
}

async function addManual(): Promise<void> {
  const added = await store.addManual()
  if (added.length === 0) return
  success(`已添加 ${added.length} 个程序`)
  await completeAi(added.map((a) => a.id))
}

async function completeAi(ids?: string[]): Promise<void> {
  if (!settings.settings.ai.enabled || !settings.settings.ai.api_key) {
    toast('未配置 AI，可在设置里填写 API Key 后手动识别')
    return
  }
  const result = await ai.complete(ids)
  await store.reload()
  if (result.failed > 0) {
    error(`识别完成：注册 ${result.registered} 个，${result.failed} 个失败（可重试）`)
  } else if (result.registered > 0) {
    success(`AI 已识别并注册 ${result.registered} 个软件`)
  }
}

function onSortChange(e: Event): void {
  setSort((e.target as HTMLSelectElement).value as NonNullable<SoftwareQuery['sort']>)
}

const emptyHint = computed(() => {  if (store.keyword.trim()) return { title: '没有匹配的结果', desc: '换个关键词，或清空搜索' }
  if (store.selection.value === 'archived')
    return { title: '归档区是空的', desc: '在详情页把不再常用的软件归档到这里' }
  if (store.selection.value === 'unused')
    return { title: '没有长期未用的软件', desc: '当前每一个都还在你的手上' }
  if (store.counts.all === 0)
    return { title: '还没有收录任何软件', desc: '扫描一个目录，开始抱住那个「一」' }
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

        <SearchBar class="toolbar__search" />

        <div class="toolbar__actions">
          <div class="segmented">
            <button
              :class="{ on: viewMode === 'grid' }"
              title="网格视图"
              @click="setViewMode('grid')"
            >
              <LayoutGrid :size="15" />
            </button>
            <button
              :class="{ on: viewMode === 'list' }"
              title="列表视图"
              @click="setViewMode('list')"
            >
              <List :size="15" />
            </button>
          </div>

          <div class="add" @click.stop>
            <button class="btn btn--primary" :disabled="busy" @click="addMenuOpen = !addMenuOpen">
              <Plus :size="15" />
              新增
            </button>
            <Transition name="fade">
              <div v-if="addMenuOpen" class="menu">
                <button
                  title="扫描已配置的目录，发现新增软件后可进行 AI 识别"
                  @click="addMenuOpen = false; rescan()"
                >
                  <FolderSearch :size="15" />
                  重新扫描目录
                </button>
                <button @click="addMenuOpen = false; addManual()">
                  <Plus :size="15" />
                  手动添加路径
                </button>
              </div>
            </Transition>
          </div>

          <button class="btn btn--subtle" title="设置" @click="router.push({ name: 'settings' })">
            <Settings :size="16" />
          </button>
        </div>
      </header>

      <div class="subbar">
        <div class="chips">
          <button
            v-for="opt in masteryOptions"
            :key="opt.value"
            class="chip"
            :class="{ on: store.mastery === opt.value }"
            @click="setMastery(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>

        <div class="subbar__right">
          <button
            v-if="store.todo > 0"
            class="btn btn--ghost"
            :disabled="busy"
            @click="completeAi()"
          >
            <Sparkles :size="14" />
            识别 {{ store.todo }} 项
          </button>

          <select class="select" :value="store.sort" @change="onSortChange">
            <option v-for="o in sortOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
      </div>

      <Transition name="fade">
        <div v-if="busy" class="progress">
          <div class="progress__bar"><i :style="{ width: `${busyPercent}%` }" /></div>
          <span class="progress__text truncate">{{ busyText }}</span>
        </div>
      </Transition>

      <div
        v-if="store.selection.value === 'unused' && store.items.length > 0"
        class="notice"
      >
        <Timer :size="15" />
        <span>
          以下 {{ store.items.length }} 个软件超过 {{ settings.settings.unused_days }}
          天没有启动过。留不留，值得再看一眼。
        </span>
      </div>

      <section class="home__content">
        <CardGrid
          v-if="store.items.length > 0"
          :items="store.items"
          :view="viewMode"
          :unused-days="settings.settings.unused_days"
          @open="open"
          @launch="launch"
        />
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

/* ------------------------------ 顶部工具条 ------------------------------ */
.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px 10px;
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

.toolbar__search {
  flex: 1;
  max-width: 460px;
}

.toolbar__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

.segmented {
  display: flex;
  padding: 2px;
  border-radius: var(--radius-btn);
  background: var(--bg-card);
  border: 1px solid var(--card-border);
}

.segmented button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 28px;
  border-radius: 6px;
  color: var(--text-sub);
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease;
}
.segmented button:hover {
  color: var(--text-main);
}
.segmented button.on {
  background: var(--active-surface);
  color: var(--accent);
}

.add {
  position: relative;
}

.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  min-width: 168px;
  padding: 4px;
  border-radius: var(--radius-input);
  background: var(--bg-elevated);
  border: 1px solid var(--divider);
  box-shadow: var(--shadow-pop);
}

.menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border-radius: 6px;
  color: var(--text-sub);
  white-space: nowrap;
}
.menu button:hover {
  background: var(--hover-surface);
  color: var(--text-main);
}

/* ------------------------------ 筛选行 ------------------------------ */
.subbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px 12px;
}

.chips {
  display: flex;
  gap: 6px;
}

.chip {
  height: 24px;
  padding: 0 10px;
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

.subbar__right {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

.select {
  height: 26px;
  padding: 0 6px;
  border-radius: var(--radius-tag);
  background: var(--bg-card);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  font-size: var(--fs-tag);
  outline: none;
}

/* ------------------------------ 进度 / 提示 ------------------------------ */
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
  max-width: 46%;
  font-size: var(--fs-tag);
  color: var(--text-sub);
}

.notice {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 20px 12px;
  padding: 10px 14px;
  border-radius: var(--radius-input);
  background: var(--warning-bg);
  color: var(--warning);
  font-size: var(--fs-body);
}

/* ------------------------------ 内容区 ------------------------------ */
.home__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 20px 24px;
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
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 400;
  color: var(--text-sub);
}

.empty p {
  font-size: var(--fs-body);
  color: var(--text-faint);
}
</style>
