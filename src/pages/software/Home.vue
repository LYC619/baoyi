<script setup lang="ts">
import { confirmDialog } from '@/composables/useDialog'
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  ChevronRight,
  ClipboardCheck,
  FileBarChart,
  FolderSearch,
  FolderTree,
  LayoutGrid,
  List,
  Plus,
  Rows3,
  Sparkles,
  Timer
} from 'lucide-vue-next'
import CardGrid from '@/components/software/CardGrid.vue'
import LibraryBulkPanel from '@/components/library/LibraryBulkPanel.vue'
import { useLibrarySelection } from '@/composables/useLibrarySelection'
import ReportDialog from '@/components/identify/ReportDialog.vue'
import SearchBar from '@/components/software/SearchBar.vue'
import Sidebar from '@/components/software/Sidebar.vue'
import CardContextMenu, { type ContextMenuItem } from '@/components/ui/CardContextMenu.vue'
import type { AIResult, IdentifyReport, SoftwareItem, SoftwareQuery } from '@/types'
import { useAI } from '@/composables/useAI'
import { useFilter } from '@/composables/useFilter'
import { recallScroll, rememberScroll } from '@/composables/useModules'
import { useScan } from '@/composables/useScan'
import { useFileDrop } from '@/composables/useFileDrop'
import DropZoneOverlay from '@/components/ui/DropZoneOverlay.vue'
import { SOFTWARE_EXTENSIONS, isMobilePackage } from '@/utils/software-package'
import { useToast } from '@/composables/useToast'
import { useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'
import { useSoftwareStore } from '@/stores/software'
import { displayName, errorMessage } from '@/utils'
import { previewSoftwareCategoryChanges, categoryMoveConfirmation } from '@/utils/softwareCategory'

const router = useRouter()
const store = useSoftwareStore()
const settings = useSettingsStore()
const categories = useCategoriesStore()
const { toast, success, error } = useToast()
const {
  viewMode,
  setViewMode,
  groupByCategory,
  toggleGroupByCategory,
  setMastery,
  setSort,
  masteryOptions,
  sortOptions
} = useFilter()
const ai = useAI()
const scan = useScan()
const bulkBusy = ref(false)
const selection = useLibrarySelection(() => store.items, () => bulkBusy.value)
const { selecting, selectedIds } = selection
const bulkTrigger = ref<HTMLButtonElement>()
watch(selecting, async active => { if (!active) { await nextTick(); bulkTrigger.value?.focus() } })
watch(() => store.activeKey, () => { if (content.value) content.value.scrollTop = 0 })

const ctxMenu = ref<InstanceType<typeof CardContextMenu>>()
const ctxItem = ref<SoftwareItem | null>(null)
const ctxMenuItems = computed<ContextMenuItem[]>(() => {
  const s = ctxItem.value
  if (!s) return []
  const sName = displayName(s, settings.settings.title_lang)
  const catChoices = bulkCategories.value.slice(0, 7)
  return [
    {
      id: 'launch',
      label: isMobilePackage(s.exe_path) ? '定位安装包' : '启动',
      onSelect: () => launch(s.id)
    },
    {
      id: 'reveal',
      label: '打开所在文件夹',
      onSelect: async () => {
        try { await window.baoyi.software.revealInFolder(s.id) } catch (e) { error(errorMessage(e)) }
      }
    },
    {
      id: 'detail',
      label: '查看详情',
      onSelect: () => open(s.id)
    },
    ...catChoices.map((cat, idx) => ({
      id: `cat:${cat}`,
      label: `分类：${cat}`,
      checked: s.category === cat,
      separatorBefore: idx === 0,
      onSelect: async () => {
        if (s.category === cat) return
        try {
          const moves = await previewSoftwareCategoryChanges([s.id], cat)
          if (moves.length) {
            const ok = await confirmDialog({
              title: '同步整理目录分类',
              message: categoryMoveConfirmation(moves),
              confirmText: '确认迁移'
            })
            if (!ok) return
            const p = moves[0].preview
            const res = await window.baoyi.organize.relocate(s.id, p.category, p.folder, p.from)
            if (!res.ok) throw new Error(res.message)
          } else {
            await store.update(s.id, { category: cat })
          }
          await store.reload()
          success(`已归入「${cat}」`)
        } catch (e) { error(errorMessage(e)) }
      }
    })),
    {
      id: 'archive',
      label: s.is_archived ? '取消归档' : '归档',
      separatorBefore: true,
      onSelect: async () => {
        try {
          await store.update(s.id, { is_archived: !s.is_archived })
          await store.reload()
          toast(s.is_archived ? '已取消归档' : '已归档')
        } catch (e) { error(errorMessage(e)) }
      }
    },
    {
      id: 'remove',
      label: '从库里移除',
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog({
          title: `从软件库移除「${sName}」？`,
          message: s.link_target ? '整理目录中的链接会一并清理，真实软件文件保留不动。' : '仅移除抱一中的库记录，不会删除本地软件文件。',
          confirmText: '移除记录',
          tone: 'danger'
        })
        if (!ok) return
        try {
          const res = await store.remove(s.id)
          if (!res.ok) error(res.message)
          else success(res.message)
        } catch (e) { error(errorMessage(e)) }
      }
    }
  ]
})
function openCardContext(s: SoftwareItem, event: MouseEvent): void {
  ctxItem.value = s
  void nextTick(() => ctxMenu.value?.openAt(event))
}
const bulkItems = computed(() => store.items.map(item => ({ id: item.id, name: item.name_zh || item.name_en || item.file_name })))
const bulkCategories = computed(() => [...new Set([...categories.list.map(item => item.name), ...store.items.map(item => item.category)])].filter(Boolean))
const filtered = computed(() => !!store.keyword.trim() || !!store.mastery || store.selection.kind !== 'group' || store.selection.value !== 'all')
function clearFilters() { store.keyword = ''; store.mastery = ''; store.select({ kind: 'group', value: 'all' }) }
async function bulkCompleted(failedIds: string[]) { selectedIds.value = new Set(failedIds); await store.reload() }

const addMenuOpen = ref(false)

/** 卡片墙的滚动容器。切到游戏库再切回来时，要回到当时那一屏 */
const content = ref<HTMLElement | null>(null)

/** 刚跑完那一轮的汇总报告。识别结束后主页上那条入口就是它 */
const report = ref<IdentifyReport | null>(null)
const reportOpen = ref(false)

const busy = computed(() => scan.running.value || ai.running.value || bulkBusy.value)
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
  void restoreList()
  // 分组展示要按 categories.sort_order 排，还要拿每个分类的图标
  void categories.load()
  document.addEventListener('click', closeAddMenu)
})
onBeforeUnmount(() => {
  if (content.value) rememberScroll('software', content.value.scrollTop)
  document.removeEventListener('click', closeAddMenu)
})

/**
 * 先把列表读回来再回到上次那一屏 —— 内容还没渲染时容器高度是 0，
 * 这时候设 scrollTop 会被浏览器直接吞掉，表现成「记忆没生效」。
 */
async function restoreList(): Promise<void> {
  await store.reload()
  await nextTick()
  if (content.value) content.value.scrollTop = recallScroll('software')
}

function closeAddMenu(): void {
  addMenuOpen.value = false
}

/**
 * 按分类切成区块。
 *
 * 排序照 categories.sort_order —— 侧边栏和这里是同一个顺序，用户建立起的
 * 空间记忆才对得上。空分类不出现：一个「0」的标题只是噪音。
 * 分类表里没有的分类名（老条目、AI 提过还没建的）兜在最后，不然它们会消失。
 */
const categoryBlocks = computed(() => {
  const byName = new Map<string, typeof store.items>()
  for (const item of store.items) {
    const key = item.category || '其他'
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key)!.push(item)
  }

  const blocks: Array<{ name: string; items: typeof store.items }> = []
  for (const c of categories.list) {
    const items = byName.get(c.name)
    if (!items?.length) continue
    blocks.push({ name: c.name, items })
    byName.delete(c.name)
  }
  for (const [name, items] of byName) blocks.push({ name, items })
  return blocks
})

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
  const dirs = settings.settings.software_scan_dirs
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

  const ok = await confirmDialog({
    title: result.added > 0 ? `发现 ${result.added} 个新目录` : '仍有待识别目录',
    message: `当前共 ${result.pending} 个目录等待识别，是否现在开始识别？`,
    confirmText: '开始识别'
  })
  if (!ok) {
    toast(`已记录 ${result.pending} 个待识别目录，随时可到设置里处理`)
    return
  }
  await completeAi()
}

const softwareExtSet = new Set(SOFTWARE_EXTENSIONS.map((ext) => ext.toLowerCase()))
const { dragging: dropActive, dropHandlers } = useFileDrop(async (paths) => {
  if (busy.value) return
  try {
    const stats = await window.baoyi.app.statPaths(paths)
    const exeFiles: string[] = []
    const folders: string[] = []
    const unsupported: string[] = []
    for (const entry of stats) {
      if (entry.kind === 'directory') {
        folders.push(entry.path)
      } else if (entry.kind === 'file') {
        const m = /\.([a-z0-9]+)$/i.exec(entry.path)
        if (m && softwareExtSet.has(m[1].toLowerCase())) exeFiles.push(entry.path)
        else unsupported.push(entry.path.split(/[\\/]/).pop() || entry.path)
      } else if (entry.kind === 'symlink') {
        unsupported.push((entry.path.split(/[\\/]/).pop() || entry.path) + '（链接）')
      }
    }
    if (unsupported.length > 0 && exeFiles.length === 0 && folders.length === 0) {
      toast('软件库支持拖入可执行程序、安装包或解压后的软件文件夹')
      return
    }
    if (exeFiles.length > 0) {
      const added = await store.addManual(exeFiles)
      if (added.length > 0) {
        success(`已添加 ${added.length} 个程序`)
        await completeAi(added.map((a) => a.id))
      }
    }
    if (folders.length > 0) {
      const result = await scan.run(folders, true)
      await store.reload()
      if (result.pending > 0) {
        const ok = await confirmDialog({
          title: result.added > 0 ? `发现 ${result.added} 个新目录` : '仍有待识别目录',
          message: `当前共 ${result.pending} 个目录等待识别，是否现在开始识别？`,
          confirmText: '开始识别'
        })
        if (ok) await completeAi()
      } else if (result.found === 0) {
        toast('未在拖入的文件夹中发现可执行程序')
      } else {
        toast(`已完成目录扫描（共检查 ${result.found} 个程序，此前均已收录）`)
      }
    }
  } catch (err) {
    error(errorMessage(err))
  }
}, { disabled: () => busy.value })

async function addManual(): Promise<void> {
  const added = await store.addManual()
  if (added.length === 0) return
  success(`已添加 ${added.length} 个程序`)
  await completeAi(added.map((a) => a.id))
}

/**
 * ids 有值 = 用户点名重新识别某几条，结果直接落库；
 * 不传 = 跑整批待识别目录，结果先进暂存区等确认。两种情况该说的话不一样。
 */
async function completeAi(ids?: string[]): Promise<void> {
  if (!settings.settings.ai.enabled || !settings.settings.ai.api_key) {
    toast('未配置 AI，可在设置里填写 API Key 后手动识别')
    return
  }
  let result: AIResult
  try {
    result = await ai.complete(ids)
  } catch (err) {
    // 卡片墙上这个按钮是识别的主入口，抛错时不说话等同于「点了没反应」
    error(`识别没能跑起来：${errorMessage(err)}`)
    return
  }
  await Promise.all([store.reload(), loadReport(result.report_id)])

  if (result.failed > 0) {
    error(`识别完成：${result.registered} 个成功，${result.failed} 个失败（可看报告）`)
    return
  }
  if (result.registered === 0) return

  if (ids) {
    success(`已识别并更新 ${result.registered} 个软件`)
  } else {
    success(`识别出 ${result.registered} 个软件，去确认面板过目后收录`)
  }
}

/**
 * 报告入口做成页面上的一条提示，而不是 toast 里的链接 ——
 * toast 2.6 秒就消失，而识别常常要跑好几分钟，用户很可能正好没在看屏幕。
 */
async function loadReport(id: string): Promise<void> {
  report.value = id
    ? (await window.baoyi.logs.reports()).find((r) => r.id === id) ?? null
    : null
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
  <div class="home" v-on="dropHandlers" @keydown="selection.key">
    <DropZoneOverlay :active="dropActive" title="松开以加入软件库" hint="支持直接拖入程序安装包（.exe / .msi / .apk 等）或软件文件夹" />
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

          <button ref="bulkTrigger" v-if="!selecting" class="btn btn--ghost" :disabled="busy || !store.items.length || store.loading" @click="selection.toggleMode">批量管理</button>
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
                <button
                  title="按分类把软件归置到整理目录下。会先出方案给你过目"
                  @click="addMenuOpen = false; router.push({ name: 'organize' })"
                >
                  <FolderTree :size="15" />
                  整理到目标目录
                </button>
              </div>
            </Transition>
          </div>


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

          <button
            class="btn btn--subtle btn--toggle"
            :class="{ on: groupByCategory }"
            :title="groupByCategory ? '取消分类分组，回到平铺' : '按分类分组展示'"
            @click="toggleGroupByCategory"
          >
            <Rows3 :size="15" />
          </button>

          <select class="select" :value="store.sort" @change="onSortChange">
            <option v-for="o in sortOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
      </div>


      <LibraryBulkPanel v-if="selecting" kind="software" :pending="store.queryPending" :items="bulkItems" :ids="[...selectedIds]" :categories="bulkCategories" @all="selection.selectAll" @clear="selection.clear" @close="selection.toggleMode" @busy="bulkBusy = $event" @completed="bulkCompleted" @refresh="store.reload" />

      <Transition name="fade">
        <div v-if="scan.running.value || ai.running.value" class="progress">
          <div class="progress__bar"><i :style="{ width: `${busyPercent}%` }" /></div>
          <span class="progress__text truncate">{{ busyText }}</span>
        </div>
      </Transition>

      <!--
        识别完的条目不直接进库，先停在暂存区。这条提示是它唯一的入口 ——
        没有它，用户根本不知道刚才那轮识别的结果去哪了。
      -->
      <button
        v-if="store.counts.pending_confirm > 0"
        class="notice notice--action"
        @click="router.push({ name: 'confirm' })"
      >
        <ClipboardCheck :size="15" />
        <span>
          有 {{ store.counts.pending_confirm }} 个新识别的软件待确认，点这里过目后收录。
        </span>
        <ChevronRight :size="15" class="notice__go" />
      </button>

      <!-- 刚跑完那一轮的整体情况。识别要跑好几分钟，用户很可能没盯着屏幕 -->
      <button v-if="report" class="notice notice--action" @click="reportOpen = true">
        <FileBarChart :size="15" />
        <span>
          本轮识别报告：处理 {{ report.processed }} 个目录，成功 {{ report.registered }}、
          跳过 {{ report.skipped }}、失败 {{ report.failed }}。点这里看详情。
        </span>
        <ChevronRight :size="15" class="notice__go" />
      </button>

      <div
        v-if="store.selection.value === 'unused' && store.items.length > 0"
        class="notice"
      >
        <Timer :size="15" />
        <span>
          以下 {{ store.items.length }} 个软件超过 {{ settings.settings.unused_days }}
          天没有动静了 —— 抱一没记到启动，它们目录里的配置文件也没被改过。留不留，值得再看一眼。
        </span>
      </div>

      <div v-if="store.keyword.trim() && (store.selection.kind !== 'group' || store.selection.value !== 'all')" class="kw-hint" role="status">
        <span>当前同时按关键词「{{ store.keyword.trim() }}」过滤</span>
        <button type="button" class="btn btn--subtle" @click="store.keyword = ''; store.load()">清空关键词</button>
      </div>
      <section ref="content" class="home__content">
        <template v-if="store.items.length > 0">
          <!-- 分组模式：一个分类一个区块，区块内部照旧用当前的网格 / 列表排布 -->
          <template v-if="groupByCategory">
            <section v-for="block in categoryBlocks" :key="block.name" class="block">
              <h2 class="block__head">
                <component :is="categories.iconComponent(block.name)" :size="15" />
                <span>{{ block.name }}</span>
                <span class="block__n">{{ block.items.length }}</span>
              </h2>
              <CardGrid
                :items="block.items"
                :view="viewMode"
                :unused-days="settings.settings.unused_days"
                :selectable="selecting" :selected-ids="selectedIds" :locked="bulkBusy || store.queryPending" @select="selection.toggle"
                @open="open"
                @launch="launch"
                @context="openCardContext"
              />
            </section>
          </template>

          <CardGrid
            v-else
            :items="store.items"
            :view="viewMode"
            :unused-days="settings.settings.unused_days"
            :selectable="selecting" :selected-ids="selectedIds" :locked="bulkBusy || store.queryPending" @select="selection.toggle"
            @open="open"
            @launch="launch"
            @context="openCardContext"
          />
        </template>
        <div v-else-if="!store.loading" class="empty">
          <h2>{{ emptyHint.title }}</h2>
          <p>{{ emptyHint.desc }}</p>
          <button v-if="filtered" class="btn btn--ghost" @click="clearFilters">清空筛选</button>
        </div>
      </section>
    </main>

    <CardContextMenu ref="ctxMenu" label="软件卡片操作" :items="ctxMenuItems" />
    <ReportDialog v-if="report && reportOpen" :report="report" @close="reportOpen = false" />
  </div>
</template>

<style scoped>
.kw-hint { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 20px 10px; padding: 6px 12px; border-radius: var(--radius-input); background: var(--active-surface); color: var(--accent); font-size: 12px; }

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
  flex-wrap: wrap;
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

/* 分组开关：按下去要看得出来它是「开着的」，不然用户不知道当前是哪种排布 */
.btn--toggle {
  width: 28px;
  height: 26px;
  padding: 0;
}
.btn--toggle.on {
  background: var(--active-surface);
  color: var(--accent);
}

/* ------------------------------ 分类区块 ------------------------------ */
.block {
  margin-bottom: 22px;
}

.block__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--divider);
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--text-sub);
}

.block__n {
  font-size: var(--fs-tag);
  font-weight: 400;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
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

/* 可点的那条走强调色，并且要看得出来它是个入口 */
.notice--action {
  width: calc(100% - 40px);
  text-align: left;
  background: var(--active-surface);
  color: var(--accent);
  transition: filter var(--t-fast) ease;
}
.notice--action:hover {
  filter: brightness(1.2);
}

.notice--action span {
  flex: 1;
  min-width: 0;
}

.notice__go {
  flex: none;
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
