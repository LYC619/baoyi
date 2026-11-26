<script setup lang="ts">
import { locale, tr } from "../../i18n/index.ts"

import {isWindowsGameEntry} from '@/utils/game-entry'
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
import { FilePlus, FolderPlus, Image, ListChecks, Search, X, AlertTriangle, Play } from 'lucide-vue-next'
import GameCover from '@/components/game/GameCover.vue'
import GameCard from '@/components/game/GameCard.vue'
import ProjectImportDialog from '@/components/game/ProjectImportDialog.vue'
import type { GameProjectPreview } from '@/types/game-project'
import LibraryBulkPanel from '@/components/library/LibraryBulkPanel.vue'
import { useLibrarySelection } from '@/composables/useLibrarySelection'
import Sidebar from '@/components/game/Sidebar.vue'
import CardContextMenu, { type ContextMenuItem } from '@/components/ui/CardContextMenu.vue'
import { confirmDialog } from '@/composables/useDialog'
import type { GameItem, GameQuery } from '@/types'

import { recallScroll, rememberScroll } from '@/composables/useModules'
import { useToast } from '@/composables/useToast'
import { useMediaScan } from '@/composables/useMediaScan'
import { useFileDrop } from '@/composables/useFileDrop'
import DropZoneOverlay from '@/components/ui/DropZoneOverlay.vue'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useSettingsStore } from '@/stores/settings'
import { useGameStore } from '@/stores/game'
import { debounce, errorMessage, shortenPath, gameTitle, formatRelative } from '@/utils'
import { useLibraryView } from '@/composables/useLibraryView'
import { libraryBlocks } from '@/utils/library-grouping'

const router = useRouter()
const store = useGameStore()
const settings = useSettingsStore()
const { toast, success, error } = useToast()

const content = ref<HTMLElement | null>(null)
const searchInput=ref<HTMLInputElement>(),pathDismissed=ref(false)
const resumeGame=computed(()=>store.selection.kind==='group'&&store.selection.value==='all'&&!store.keyword.trim()&&store.sort==='played'&&!selecting.value?store.items.find(g=>isWindowsGameEntry(g.path)&&g.play_status==='playing'&&g.last_played_at>0):undefined)
function searchKey(e:KeyboardEvent){if(e.isComposing||document.querySelector?.('dialog[open]'))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();searchInput.value?.focus()}}
const launching=ref(false)
async function resumeLaunch(withTools=false){if(!resumeGame.value||launching.value)return;launching.value=true;try{const allTools=resumeGame.value.linked_files.filter(f=>f.type==='trainer'&&f.role!=='usage'&&/\.(exe|bat|cmd|lnk)$/i.test(f.path));const preferred=allTools.filter(f=>f.launch_with_game);const trainers=(preferred.length?preferred:allTools).map(f=>f.path);const result=await window.baoyi.game.launch(resumeGame.value.id,withTools?{trainers}:{});if(result.ok){toast(result.message);void store.reload()}else error(result.message)}catch(cause){error(errorMessage(cause))}finally{launching.value=false}}
onMounted(()=>window.addEventListener('keydown',searchKey));onBeforeUnmount(()=>window.removeEventListener('keydown',searchKey))
const { grouping, cardSize,coverShape } = useLibraryView('game')
const blocks = computed(() => {
  const raw = libraryBlocks(store.items, grouping.value, item => ['其他','未分类'].includes(item.category) ? '' : item.category, item => item.source_dir, settings.settings.game_scan_dirs)
  if (grouping.value !== 'category' || !savedCategories.value.length) return raw
  const order = new Map(savedCategories.value.map((name, idx) => ['category:' + name, idx]))
  return [...raw].sort((a, b) => {
    const oa = order.get(a.key) ?? (a.key === 'unclassified' ? 999999 : 99999)
    const ob = order.get(b.key) ?? (b.key === 'unclassified' ? 999999 : 99999)
    return oa !== ob ? oa - ob : a.name.localeCompare(b.name, locale.value, { numeric: true })
  })
})
const unavailable = computed(() => store.items.filter(item=>item.path_state && item.path_state !== 'present'))

const operation = useMediaScan('game')
const tasks = useTaskCenter()
const preparing = ref(false)
const fillingCovers = ref(false)
const coverSummary = ref('')
const registering = ref(false)
const projectPreview = ref<GameProjectPreview|null>(null), previewingProjects = ref(false)
async function previewProjects() {
  previewingProjects.value=true
  try { const result=await window.baoyi.game.previewProjects(); if(!pageDisposed)projectPreview.value=result }
  catch(cause){error(errorMessage(cause))}finally{previewingProjects.value=false}
}
async function projectsImported(message:string){projectPreview.value=null;success(message);await store.checkProjects()}
async function restoreProjectArtwork(){try{const count=await window.baoyi.game.restoreProjectArtwork();if(count){success(tr("已恢复 {p0} 款游戏的图片", {p0: (count)}));await store.checkProjects()}else{toast(tr("当前没有可恢复的项目图片"))}}catch(cause){error(errorMessage(cause))}}
const bulkBusy = ref(false), savedCategories = ref<string[]>([])
const selection = useLibrarySelection(() => store.items, () => bulkBusy.value || coversBusy.value)
const { selecting, selectedIds } = selection
const bulkTrigger = ref<HTMLButtonElement>()
watch(selecting, async active => { if (!active) { await nextTick(); bulkTrigger.value?.focus() } })
watch(() => store.activeKey, () => { if (content.value) content.value.scrollTop = 0 })

const ctxMenu = ref<InstanceType<typeof CardContextMenu>>()
const ctxItem = ref<GameItem | null>(null)
const ctxMenuItems = computed<ContextMenuItem[]>(() => {
  const g = ctxItem.value
  if (!g) return []
  const gTitle = gameTitle(g)
  const canLaunch = isWindowsGameEntry(g.path) && (!g.path_state || g.path_state === 'present')
  const catChoices = bulkCategories.value.slice(0, 7)
  return [
    {
      id: 'launch',
      label: isWindowsGameEntry(g.path) ? tr("启动游戏") : tr("打开安装包目录"),
      disabled: !isWindowsGameEntry(g.path) ? g.path_state !== undefined && g.path_state !== 'present' : !canLaunch,
      onSelect: async () => {
        if (!isWindowsGameEntry(g.path)) {
          try { await window.baoyi.game.revealInFolder(g.id) } catch (e) { error(errorMessage(e)) }
          return
        }
        try {
          const r = await window.baoyi.game.launch(g.id)
          if (r.ok) { toast(r.message); void store.reload() } else error(r.message)
        } catch (e) { error(errorMessage(e)) }
      }
    },
    {
      id: 'reveal',
      label: tr('打开所在文件夹'),
      onSelect: async () => {
        try { await window.baoyi.game.revealInFolder(g.id) } catch (e) { error(errorMessage(e)) }
      }
    },
    {
      id: 'detail',
      label: tr('查看详情'),
      onSelect: () => open(g.id)
    },
    ...catChoices.map((cat, idx) => ({
      id: `cat:${cat}`,
      label: tr('分类：{p0}', {p0: cat}),
      checked: (g.category || '其他') === cat,
      separatorBefore: idx === 0,
      onSelect: async () => {
        if (g.category === cat) return
        try {
          await store.update(g.id, { category: cat })
          await store.reload()
          success(tr("已归入「{p0}」", {p0: (cat)}))
        } catch (e) { error(errorMessage(e)) }
      }
    })),
    {
      id: 'archive',
      label: g.is_archived ? tr("取消归档") : tr("归档"),
      separatorBefore: true,
      onSelect: async () => {
        try {
          await store.update(g.id, { is_archived: !g.is_archived })
          await store.reload()
          toast(g.is_archived ? tr("已取消归档") : tr("已归档"))
        } catch (e) { error(errorMessage(e)) }
      }
    },
    {
      id: 'remove',
      label: tr('从库里移除'),
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog({
          title: tr('从游戏库移除「{p0}」？', {p0: gTitle}),
          message: tr("仅移除抱一中的库记录，本地游戏文件与已有存档备份均会保留。"),
          confirmText: tr('移除记录'),
          tone: 'danger'
        })
        if (!ok) return
        try {
          await store.remove(g.id)
          success(tr("已从游戏库移除"))
        } catch (e) { error(errorMessage(e)) }
      }
    }
  ]
})
function openCardContext(g: GameItem, event: MouseEvent): void {
  ctxItem.value = g
  void nextTick(() => ctxMenu.value?.openAt(event))
}
const bulkItems = computed(() => store.items.map(item => ({ id: item.id, name: item.name_zh || item.name_en || item.file_name })))
const bulkCategories = computed(() => [...new Set([...savedCategories.value, ...store.items.map(item => item.category), '其他'])])
const filtered = computed(() => !!store.keyword.trim() || store.selection.kind !== 'group' || store.selection.value !== 'all')
function clearFilters() { store.keyword = ''; store.select({ kind: 'group', value: 'all' }) }
async function bulkCompleted(failedIds: string[]) { selectedIds.value = new Set(failedIds); await store.reload() }
const coverScope = computed(() => store.items.filter(game => !selecting.value || selectedIds.value.has(game.id)).map(game => game.id))
const coversBusy = computed(() => fillingCovers.value || tasks.runningTasks.value.some(task => task.kind === 'game-scan'))
const scanning = computed(() => preparing.value || operation.running.value)
const progress = operation.progress
let pageDisposed = false

const SORTS: Array<{ value: NonNullable<GameQuery['sort']>; label: string }> = [
  { value: 'played', get label() { return tr("最近游玩") } },
  { value: 'added', get label() { return tr("最近加入") } },
  { value: 'playtime', get label() { return tr("游玩时长") } },
  { value: 'name', get label() { return tr("按名称") } }
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
  if (operation.stopping.value && operation.running.value) return tr("正在停止，等待当前识别步骤收尾…")
  if (!p) return tr("准备中")
  if (p.phase === 'done') return tr("正在刷新资源库…")
  if (p.phase === 'scanning') return tr("正在扫描 {p0}", {p0: (shortenPath(p.current, 40))})
  return tr("识别 {p0}/{p1}　{p2}", {p0: (Math.min(p.processed + 1, p.total)), p1: (p.total), p2: (p.log || shortenPath(p.current, 32))})
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

function open(id: string,tab?:string): void {
  void router.push({ name: 'game-detail', params: { id },query:tab?{tab}:{} })
}

function cancelScan(): void {
  try { operation.cancel() }
  catch (err) { error(tr("停止扫描失败：") + errorMessage(err)) }
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
    if (!pageDisposed) error(tr("登记游戏失败：") + errorMessage(err))
  } finally { registering.value = false }
}

async function fillMissingCovers(): Promise<void> {
  if (coversBusy.value || coverScope.value.length === 0) return
  const ids = [...coverScope.value]
  fillingCovers.value = true
  coverSummary.value = tr("正在检查 {p0} 个游戏的封面", {p0: (ids.length)})
  const taskId = tasks.start('game-scan', tr("批量补齐游戏封面"), { total: ids.length })
  let off: (() => void) | undefined
  try {
    off = window.baoyi.game.onCoverProgress((p) => {
      const message = p.current ? `${p.current}：${p.message}` : p.message
      coverSummary.value = message
      tasks.update(taskId, { processed: p.processed, total: p.total, current: p.current, message: p.message }, { level: p.message.includes('失败') ? 'warn' : 'info', message })
    })
    const result = await window.baoyi.game.rebuildCovers(ids)
    const skipped = Math.max(0, result.processed - result.updated - result.failed)
    const message = result.processed === 0 ? tr('当前范围的封面已齐全')
      : tr('{p0}：已处理 {p1} 个，补齐 {p2} 个{p3}{p4}', {p0: result.failed && result.updated ? tr('部分完成') : tr('处理结束'), p1: result.processed, p2: result.updated, p3: result.failed ? tr('，失败 {p0} 个', {p0: result.failed}) : '', p4: skipped ? tr('，跳过 {p0} 个（保留较新的选择）', {p0: skipped}) : ''})
    coverSummary.value = message
    tasks.update(taskId, { processed: result.processed, total: result.processed, percent: 100, current: '', message })
    tasks.finish(taskId, result.failed ? 'failed' : 'success', message)
    await store.reload()
    if (!pageDisposed) toast(message)
  } catch (err) {
    coverSummary.value = tr("封面补齐失败：{p0}", {p0: (errorMessage(err))})
    tasks.finish(taskId, 'failed', tr("封面补齐失败"), errorMessage(err))
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
async function scanGameDirectories(dirs: string[]): Promise<void> {
  if (scanning.value || dirs.length === 0) return
  preparing.value = true
  let started = false
  const recordAttempt = (status: 'failed' | 'cancelled', message: string): void => {
    const id = tasks.start('game-scan', tr("游戏扫描预检"))
    tasks.finish(id, status, message, status === 'failed' ? message : undefined)
  }
  try {
    if (!settings.settings.ai.enabled || !settings.settings.ai.api_key.trim()) {
      const message = tr('扫描游戏文件夹需要先在设置中配置 AI 模型；也可直接拖入 .exe 启动文件手动登记')
      recordAttempt('failed', message)
      toast(message)
      void router.push({ name: 'settings', query: { tab: 'ai' } })
      return
    }
    started = true
    const r = await operation.run(dirs)
    const stopped = operation.stopping.value
    await store.reload()
    if (stopped) {
      toast(tr("扫描已停止：已收录 ") + r.registered + tr(" 个，已完成的结果已保留"))
    } else if (r.candidates === 0) {
      toast(tr("未在这些文件夹中发现可识别的游戏程序"))
    } else if (r.registered > 0) {
      const message = tr('识别出 ') + r.registered + tr(' 个游戏') + (r.skipped > 0 ? tr('，跳过 ') + r.skipped + tr(' 个') : '') + (r.failed > 0 ? '，' + r.failed + tr(' 个失败') : '')
      if (r.failed > 0) toast(message)
      else success(message)
    } else if (r.failed > 0) {
      error(tr("扫描到 ") + r.candidates + tr(" 个候选，但未能完成收录，请查看识别日志"))
    } else {
      toast(tr("扫描到 ") + r.candidates + tr(" 个候选，均已存在或已跳过"))
    }
  } catch (err) {
    if (!started) recordAttempt('failed', errorMessage(err))
    error(tr("扫描未能完成：") + errorMessage(err))
  } finally {
    preparing.value = false
  }
}

const { dragging: dropActive, dropHandlers } = useFileDrop(async (paths) => {
  if (scanning.value || registering.value) return
  try {
    const stats = await window.baoyi.app.statPaths(paths)
    const entries: string[] = []
    const folders: string[] = []
    const unsupported: string[] = []
    for (const entry of stats) {
      if (entry.kind === 'directory') {
        folders.push(entry.path)
      } else if (entry.kind === 'file' && /\.(exe|lnk|bat|cmd)$/i.test(entry.path)) {
        entries.push(entry.path)
      } else {
        unsupported.push(entry.path.split(/[\\/]/).pop() || entry.path)
      }
    }
    if (unsupported.length > 0 && entries.length === 0 && folders.length === 0) {
      toast(tr("游戏库支持直接拖入 .exe / .lnk / .bat / .cmd 启动文件，或拖入解压后的游戏文件夹"))
      return
    }
    if (entries.length > 0) {
      registering.value = true
      try {
        for (const file of entries) {
          const result = await window.baoyi.game.addManual(file)
          if (result && !result.ok) error(result.message)
          else if (result) success(result.message)
        }
        await store.reload()
      } catch (err) {
        error(tr("登记游戏失败：") + errorMessage(err))
      } finally {
        registering.value = false
      }
    }
    if (folders.length > 0) {
      await scanGameDirectories(folders)
    }
  } catch (err) {
    error(errorMessage(err))
  }
}, { disabled: () => scanning.value || registering.value })

async function addGames(): Promise<void> {
  if (scanning.value) return
  preparing.value = true
  let started = false
  const recordAttempt = (status: 'failed' | 'cancelled', message: string): void => {
    const id = tasks.start('game-scan', tr("游戏扫描预检"))
    tasks.finish(id, status, message, status === 'failed' ? message : undefined)
  }
  try {
    if (!settings.settings.ai.enabled || !settings.settings.ai.api_key.trim()) {
      const message = tr('游戏识别要用 AI，先去设置里填好 API Key')
      recordAttempt('failed', message)
      toast(message)
      void router.push({ name: 'settings', query: { tab: 'ai' } })
      return
    }
    const dirs = await window.baoyi.game.pickDirectories()
    if (pageDisposed || dirs.length === 0) {
      recordAttempt('cancelled', pageDisposed ? tr("已离开页面，未启动扫描") : tr("未选择目录，未启动扫描"))
      return
    }
    started = true
    const r = await operation.run(dirs)
    const stopped = operation.stopping.value
    await store.reload()
    if (stopped) {
      toast(tr("扫描已停止：已注册 ") + r.registered + tr(" 个，已完成的结果已保留"))
    } else if (r.candidates === 0) {
      toast(tr("这些目录里没找到游戏（没有可执行文件，或者只是一层收纳目录）"))
    } else if (r.registered > 0) {
      const message = tr('识别出 ') + r.registered + tr(' 个游戏') +
        (r.skipped > 0 ? tr('，跳过 ') + r.skipped + tr(' 个') : '') +
        (r.failed > 0 ? '，' + r.failed + tr(' 个失败') : '')
      if (r.failed > 0) toast(message)
      else success(message)
    } else if (r.failed > 0) {
      error(tr("扫描到 ") + r.candidates + tr(" 个候选，但没有注册成功，") + r.failed + tr(" 个识别失败，请查看识别日志"))
    } else {
      toast(tr("扫描到 ") + r.candidates + tr(" 个候选，全部跳过；可到识别日志查看原因"))
    }
  } catch (err) {
    if (!started) recordAttempt('failed', errorMessage(err))
    error(tr("扫描没能完成：") + errorMessage(err))
  } finally {
    preparing.value = false
  }
}

const emptyHint = computed(() => {
  if (store.keyword.trim()) return { title: tr('没有匹配的游戏'), desc: tr('换个关键词，或清空搜索') }
  if (store.selection.kind === 'status')
    return { title: tr('「{p0}」里还没有游戏', {p0: store.heading}), desc: tr('在详情页可以改游玩状态') }
  if (store.counts.all === 0)
    return { title: tr('游戏库还是空的'), desc: tr('点右上角「加游戏」，选择本地启动程序；也可用 AI 扫描整个目录') }
  return { title: tr('这里还没有内容'), desc: tr('换个分类看看') }
})
</script>

<template>
  <ProjectImportDialog v-if="projectPreview" :preview="projectPreview" @close="projectPreview=null" @completed="projectsImported"/>
  <div class="home" v-on="dropHandlers" @keydown="selection.key">
    <DropZoneOverlay :active="dropActive" :title="$t('松开以加入游戏库')" :hint="$t('支持拖入游戏启动文件（.exe / .lnk / .bat）直接登记，或拖入游戏目录扫描识别')" />
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
            ref="searchInput"
            v-model="store.keyword"
            class="search__input"
            type="text"
            :aria-label="$t('搜索游戏')"
            :placeholder="$t('搜索游戏名、简介、标签')"
            @input="onKeyword"
          />
          <kbd v-if="!store.keyword">Ctrl K</kbd>
          <button v-if="store.keyword" class="search__clear" :title="$t('清空')" @click="clearKeyword">
            <X :size="14" />
          </button>
        </div>

        <div class="toolbar__actions">


          <select v-model="store.sort" class="select" :aria-label="$t('游戏排序')" @change="store.load()">
            <option v-for="o in SORTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>







          <button style="order:2" ref="bulkTrigger" v-if="!selecting" class="btn btn--ghost" :aria-pressed="selecting" :disabled="store.items.length === 0 || store.loading || coversBusy" @click="toggleSelection">
            <ListChecks :size="15" />{{ $t("批量管理") }}</button>

          <LibraryToolbarMenu :label="$t('视图')">
          <div class="view-section"><span>{{ $t("封面形状") }}</span><div class="view-seg"><button :aria-pressed="coverShape==='portrait'" @click="coverShape='portrait'">{{ $t("竖版 2:3") }}</button><button :aria-pressed="coverShape==='landscape'" @click="coverShape='landscape'">{{ $t("横版 16:9") }}</button></div></div>
          <div class="view-section"><span>{{ $t("分组") }}</span><div class="view-seg"><button v-for="(label,key) in {none:$t('不分组'),category:$t('分类'),directory:$t('一级文件夹')}" :key="key" :aria-pressed="grouping===key" @click="grouping=key">{{label}}</button></div></div>
          <label class="card-size">{{ $t("卡片大小 {p0} px", {p0: (cardSize)}) }}<input v-model.number="cardSize" type="range" min="110" max="260" step="10" :aria-label="$t('游戏卡片大小')"/></label>
          </LibraryToolbarMenu>
          <LibraryToolbarMenu style="order:3" :label="$t('更多')">
          <button class="btn btn--ghost" :disabled="previewingProjects || scanning" @click="previewProjects"><FolderPlus :size="15"/>{{previewingProjects?$t('读取清单中…'):$t('从项目清单登记')}}</button>
          <button class="btn btn--ghost" :disabled="previewingProjects || scanning" @click="restoreProjectArtwork">{{ $t("撤销项目图片更新") }}</button>
          <button class="btn btn--ghost" :disabled="scanning" :title="$t('扫描目录并由 AI 识别游戏')" @click="addGames">
            <FolderPlus :size="15" />{{ $t("AI 扫描") }}</button>
          <button class="btn btn--ghost" :disabled="bulkBusy || coversBusy || coverScope.length === 0" :title="selecting ? $t('只补齐当前筛选中已选择游戏的缺失封面') : $t('为当前筛选列表补齐缺失封面')" @click="fillMissingCovers">
            <Image :size="15" />
            {{ coversBusy ? $t('补图中') : $t('补齐封面（{p0} 缺失）', {p0: store.items.filter(g=>!g.cover_path&&!g.background_path).length}) }}
          </button>
          <button class="btn btn--ghost" @click="store.reload()">{{ $t("重新检查路径") }}</button><button class="btn btn--ghost" @click="store.select({kind:'group',value:'archived'})">{{ $t("查看已归档") }}</button>
          </LibraryToolbarMenu><button style="order:4" class="btn btn--primary" :disabled="registering" @click="addManualGame"><FilePlus :size="15"/>{{registering?$t('登记中'):$t('加游戏')}}</button>

        </div>
      </header>

      <LibraryBulkPanel v-if="selecting" kind="game" :pending="store.queryPending" :items="bulkItems" :ids="[...selectedIds]" :categories="bulkCategories" @all="selection.selectAll" @clear="selection.clear" @close="selection.toggleMode" @busy="bulkBusy = $event" @completed="bulkCompleted" @refresh="store.reload" />

      <Transition name="fade">
        <div v-if="scanning" class="progress">
          <div class="progress__bar"><i :style="{ width: `${busyPercent}%` }" /></div>
          <span class="progress__text truncate">{{ busyText }}</span>
          <button class="btn btn--subtle" :disabled="!operation.running.value || operation.stopping.value || progress?.phase === 'done'" @click="cancelScan">{{ $t("停止") }}</button>
        </div>
      </Transition>

      <p v-if="coverSummary" class="cover-summary" role="status">{{ coverSummary }}</p>
      <div v-if="store.keyword.trim() && (store.selection.kind !== 'group' || store.selection.value !== 'all')" class="kw-hint" role="status">
        <span>{{ $t("当前同时按关键词「{p0}」过滤", {p0: (store.keyword.trim())}) }}</span>
        <button type="button" class="btn btn--subtle" @click="clearKeyword">{{ $t("清空关键词") }}</button>
      </div>
      <div v-if="unavailable.length&&!pathDismissed" class="path-alert" role="status"><AlertTriangle :size="16"/><p><strong>{{ $t("{p0} 个游戏", {p0: (unavailable.length)}) }}</strong>{{ $t("的程序路径不可用，重新定位后可继续启动。") }}</p><button class="btn btn--sm" @click="store.select({kind:'path',value:'unavailable'})">{{ $t("只看这些") }}</button><button class="btn btn--sm" @click="store.reload()">{{ $t("重新检查") }}</button><button class="btn btn--sm btn--icon" :aria-label="$t('关闭路径提示')" @click="pathDismissed=true"><X :size="14"/></button></div>

      <section ref="content" class="home__content">
        <div v-if="resumeGame" class="resume"><div class="resume__cover"><GameCover :item="resumeGame"/></div><div><small>{{ $t("继续游玩") }}</small><h2>{{gameTitle(resumeGame)}}</h2><p>{{formatRelative(resumeGame.last_played_at)}}</p></div><button v-if="resumeGame.linked_files.some(f=>f.type==='trainer'&&f.role!=='usage'&&/\.(exe|bat|cmd|lnk)$/i.test(f.path))" class="btn btn--subtle" :disabled="launching||!!resumeGame.path_state&&resumeGame.path_state!=='present'" @click="resumeLaunch(true)">{{ $t("连同修改器") }}</button><button class="btn btn--subtle" @click="open(resumeGame.id)">{{ $t("查看详情") }}</button><button class="btn btn--primary" :disabled="launching||!!resumeGame.path_state&&resumeGame.path_state!=='present'" @click="resumeLaunch()"><Play :size="15"/>{{ $t("启动") }}</button></div>
        <template v-if="store.items.length > 0"><section v-for="block in blocks" :key="block.key" class="game-group"><h2 v-if="block.name">{{block.name}} <small>{{block.items.length}}</small></h2><div class="wall" :style="{gridTemplateColumns:`repeat(auto-fill, minmax(${coverShape==='landscape'?Math.round(cardSize*1.55):cardSize}px, 1fr))`}">
          <GameCard v-for="g in block.items" :key="g.id" :item="g" :cover-shape="coverShape" :selectable="selecting" :selected="selectedIds.has(g.id)" :locked="bulkBusy || coversBusy || store.queryPending" @open="open" @select="toggleSelected" @context="openCardContext" />
        </div></section></template>
        <div v-else-if="!store.loading" class="empty">
          <h2>{{ emptyHint.title }}</h2>
          <p>{{ emptyHint.desc }}</p>
          <button v-if="filtered" class="btn btn--ghost" @click="clearFilters">{{ $t("清空筛选") }}</button>
        </div>
      </section>
    </main>
    <CardContextMenu ref="ctxMenu" :label="$t('游戏卡片操作')" :items="ctxMenuItems" />
  </div>
</template>

<style scoped>
.kw-hint { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 24px 10px; padding: 6px 12px; border-radius: var(--radius-input); background: var(--active-surface); color: var(--accent); font-size: 12px; }
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
.search kbd{position:absolute;right:10px;font:10px var(--font-mono);color:var(--text-faint);border:1px solid var(--divider);border-radius:4px;padding:2px 4px;pointer-events:none}.search__input{padding-right:58px;text-overflow:ellipsis}.toolbar{gap:14px;padding:18px 24px}.toolbar__title{min-width:90px}.toolbar__actions{gap:8px}.home__content{padding:8px 24px 30px}.wall{gap:24px 18px}.view-section{padding:8px;display:grid;gap:8px;font-size:11px;color:var(--text-faint)}.view-seg{display:flex;background:var(--hover-surface);padding:2px;border-radius:7px}.view-seg button{flex:1;padding:5px 8px;border-radius:5px;color:var(--text-sub)}.view-seg [aria-pressed=true]{background:var(--bg-card);color:var(--text-main);box-shadow:var(--shadow-card)}.path-alert{display:flex;align-items:center;gap:10px;margin:0 24px 10px;background:var(--warning-bg);color:var(--warning);padding:10px 14px;border-radius:8px;font-size:12px}.path-alert p{flex:1}.resume{display:flex;gap:18px;align-items:center;background:var(--bg-card);border-radius:12px;padding:16px 20px;margin-bottom:24px;border:1px solid var(--card-border)}.resume__cover{width:50px;flex:none}.resume>div:nth-child(2){flex:1}.resume small,.resume p{font-size:11px;color:var(--text-sub)}.resume h2{font-size:17px;margin:6px 0}
</style>
