<script setup lang="ts">
import { systemMessage, tr } from "../../i18n/index.ts"

import { latestOnly, STALE } from '@/composables/latestOnly'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { isWindowsGameEntry } from '@/utils/game-entry'
import GameProjectRecord from '@/components/game/GameProjectRecord.vue'
import GameCover from '@/components/game/GameCover.vue'
import GameNotes from '@/components/game/GameNotes.vue'
import GameTools from '@/components/game/GameTools.vue'
import GameDocs from '@/components/game/GameDocs.vue'
import GameSavesTab from '@/components/game/GameSavesTab.vue'
import GameFilesCoverTab from '@/components/game/GameFilesCoverTab.vue'
import ResourceBacklinksPanel from '@/components/workspace/ResourceBacklinksPanel.vue'
import Sidebar from '@/components/game/Sidebar.vue'
import LibraryToolbarMenu from '@/components/library/LibraryToolbarMenu.vue'
import type { GameNote, GameLaunchOptions } from '@/types/game-workspace'
import {
  ArrowLeft,
  BadgeCheck,
  BookOpen,
  ExternalLink,
  FileText,
  FolderOpen,
  Image,
  Play,
  Save,
  StickyNote,
  Unlink,
  Wrench,
} from 'lucide-vue-next'
import DetailTabs from '@/components/ui/DetailTabs.vue'
import EditableField from '@/components/ui/EditableField.vue'
import { confirmDialog } from '@/composables/useDialog'
import { useResourceDetail } from '@/composables/useResourceDetail'
import { useToast } from '@/composables/useToast'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { PLAY_STATUS_LABEL, useGameStore } from '@/stores/game'
import { useSettingsStore } from '@/stores/settings'
import type {
  CoverCandidate,
  GameCoverDiagnostic,
  GameItem,
  SaveBackup,
  SavePath,
} from '@/types'
import {
  coverUrl,
  errorMessage,
  formatBytes,
  formatDate,
  formatDateTime,
  formatPlaytime,
  formatRelative,
  gameTitle,
} from '@/utils'

const props = defineProps<{ id: string }>()
const item = ref<GameItem | null>(null)
const router = useRouter()
const route = useRoute()
const tabIds = ['overview', 'trainer', 'guide', 'saves', 'files', 'notes']
const activeTab = ref(tabIds.includes(String(route.query.tab)) ? String(route.query.tab) : 'overview')
const scrollRoot = ref<HTMLElement>()
const tabRoot = ref<HTMLElement>()
const scrolled = ref(false)
const notesPanel = ref<InstanceType<typeof GameNotes>>()
const gameNotes = ref<GameNote[]>([])
const categories = ref<string[]>([])
const categoryOpen = ref(false)
const guideVisited = ref(activeTab.value === 'guide')
const closeCategoryDropdown = () => setTimeout(() => { categoryOpen.value = false }, 140)

const trainers = computed(() => item.value?.linked_files.filter((f) => f.type === 'trainer') || [])
const executableTrainers = computed(() => trainers.value.filter((f) => f.role !== 'usage' && /\.(exe|cmd|bat|lnk)$/i.test(f.path)))
const selectedTrainers = ref<string[]>([])
watch(executableTrainers, (list) => {
  const defaults = list.filter((f) => f.launch_with_game).map((f) => f.path)
  selectedTrainers.value = defaults.length ? defaults : list.length === 1 ? [list[0].path] : []
}, { immediate: true })
function toggleSelectedTrainer(target: string, checked: boolean): void {
  selectedTrainers.value = checked ? [...new Set([...selectedTrainers.value, target])] : selectedTrainers.value.filter((p) => p !== target)
}
const guides = computed(() => item.value?.linked_files.filter((f) => f.type === 'guide') || [])
const report = computed(() => guides.value.find((f) => f.project) || guides.value.find((f) => f.role === 'report'))
const reportPath = ref('')
const restoreTargets = ref<Record<string, string>>({})
const projectSections = computed(() => (report.value?.note || '').split('\n\n').filter(Boolean))

function readReport() {
  reportPath.value = report.value?.path || ''
  activeTab.value = 'guide'
}

const entries = computed(() =>
  item.value
    ? [
        { path: item.value.path, label: item.value.file_name },
        ...item.value.linked_files.filter(
          (f) => f.role === 'launcher' && f.type !== 'trainer' && f.path !== item.value?.path
        ),
      ]
    : []
)

const backups = ref<SaveBackup[]>([])
const detailTabs = computed(() => [
  { id: 'overview', label: tr('简介'), icon: FileText },
  { id: 'trainer', label: tr('工具与修改器'), icon: Wrench, count: trainers.value.length },
  { id: 'guide', label: tr('攻略与说明'), icon: BookOpen, count: guides.value.length },
  {
    id: 'saves',
    label: tr('存档与备份'),
    icon: Save,
    dot: !!item.value?.save_paths.length && !backups.value.length,
  },
  { id: 'files', label: tr('文件与封面'), icon: Image, count: entries.value.length },
  { id: 'notes', label: tr('笔记'), icon: StickyNote, count: gameNotes.value.length },
])

async function leaveNotes() {
  return (await notesPanel.value?.flush()) ?? true
}
onBeforeRouteLeave(leaveNotes)
onBeforeRouteUpdate(leaveNotes)

watch(activeTab, (tab) => {
  if (tab === 'guide') guideVisited.value = true
  if (scrollRoot.value && tabRoot.value) {
    const top = tabRoot.value.offsetTop - 52
    if (scrollRoot.value.scrollTop > top) scrollRoot.value.scrollTop = top
  }
  void router.replace({ query: { ...route.query, tab } })
})
watch(
  () => route.query.tab,
  (tab) => {
    activeTab.value = tabIds.includes(String(tab)) ? String(tab) : 'overview'
  }
)

const heroWide = computed(() => !item.value?.cover_path && !!item.value?.background_path)
const heroBackground = computed(() =>
  item.value ? coverUrl(item.value.background_path || item.value.cover_path, item.value.updated_at) : ''
)
const coverBroken = ref(false)
watch(
  () => [item.value?.id, item.value?.cover_path, item.value?.background_path],
  () => {
    coverBroken.value = false
  }
)

async function defaultEntry(target: string) {
  try {
    const result = await window.baoyi.game.defaultEntry(props.id, target)
    if (result) resourcesUpdated(result)
  } catch (e) {
    error(errorMessage(e))
  }
}

async function recheck() {
  await store.reload()
  const result = await window.baoyi.game.get(props.id)
  if (result) item.value = result
}

const store = useGameStore()
const settings = useSettingsStore()
const { success, error, toast } = useToast()
const tasks = useTaskCenter()

const loading = ref(true)
const relocating = ref(false)
async function relocate(mode: 'directory' | 'file' = 'directory') {
  relocating.value = true
  try {
    const updated = await window.baoyi.game.relocate(props.id, mode)
    if (updated) {
      item.value = updated
      await store.reload()
      success(tr("路径已更新，游玩记录与存档信息已保留"))
    }
  } catch (cause) {
    error(errorMessage(cause))
  } finally {
    relocating.value = false
  }
}

const readGame = latestOnly(() => window.baoyi.game.get(props.id))
type CoverResult = { ok: boolean; message: string; item: GameItem | null }
const chooseCover = latestOnly((action: () => Promise<CoverResult | null>) => action())
const findCovers = latestOnly((action: () => ReturnType<typeof window.baoyi.game.searchCovers> | Promise<null>) =>
  action()
)

const loadError = ref('')

async function load(): Promise<void> {
  closeCoverHits()
  void chooseCover(async () => null)
  coverPicking.value = ''
  loading.value = true
  loadError.value = ''
  try {
    const result = await readGame()
    if (result === STALE) return
    item.value = result
  } catch (err) {
    const msg = errorMessage(err)
    loadError.value = msg
    error(tr("读取游戏失败：{p0}", {p0: (msg)}))
    item.value = null
  }
  loading.value = false
}

async function loadAll(): Promise<void> {
  await load()
  await loadBackups()
  try {
    gameNotes.value = await window.baoyi.game.notes.list(props.id)
    categories.value = (await window.baoyi.categories.list('game')).map((c) => c.name)
  } catch (e) {
    error(errorMessage(e))
  }
  await refreshRunning()
}

onMounted(() => {
  void loadAll()
  void store.refreshCounts()
})

const title = computed(() => (item.value ? gameTitle(item.value) : ''))

async function background(clear = false) {
  const id = props.id
  try {
    const r = await (clear ? window.baoyi.game.clearBackground : window.baoyi.game.pickBackground)(id)
    if (r) resourcesUpdated(r)
  } catch (e) {
    error(errorMessage(e))
  }
}

async function pickCover(): Promise<void> {
  if (!item.value) return
  closeCoverHits()
  coverPicking.value = ''
  try {
    const r = await chooseCover(async () => {
      const result = await window.baoyi.game.pickCover(props.id)
      if (result?.ok) void store.load()
      return result
    })
    if (r === STALE || !r) return
    if (!r.ok) {
      coverMiss.value = r.message
      error(r.message)
      return
    }
    if (r.item) item.value = r.item
    success(r.message)
  } catch (err) {
    coverMiss.value = tr("更换封面失败：{p0}", {p0: (errorMessage(err))})
    error(coverMiss.value)
  }
}

async function clearCover(): Promise<void> {
  if (!item.value?.cover_path) return
  const ok = await confirmDialog({
    title: tr('恢复默认封面？'),
    message: tr("将移除抱一保存的封面副本并恢复自动构图，你原有的本地图片文件不会受影响。"),
    confirmText: tr('恢复默认'),
  })
  if (!ok) return
  closeCoverHits()
  coverPicking.value = ''
  try {
    const result = await chooseCover(async () => {
      const updated = await window.baoyi.game.clearCover(props.id)
      void store.load()
      return { item: updated, ok: true, message: '' }
    })
    if (result !== STALE && result?.item) item.value = result.item
  } catch (err) {
    error(tr("移除封面失败：{p0}", {p0: (errorMessage(err))}))
  }
}

const coverSearching = ref(false)
const coverPicking = ref('')
const coverHits = ref<CoverCandidate[]>([])
const coverQuery = ref('')
const coverDiagnostics = ref<GameCoverDiagnostic[]>([])
const brokenPreviews = ref(new Set<string>())
const COVER_SOURCE_LABEL = { get local() { return tr('本地图片') }, get official() { return tr('官方') }, steam: 'Steam', get search() { return tr('图片搜索') } }
const COVER_STAGE_LABEL = { get identity() { return tr('名称核对') }, get lookup() { return tr('检索') }, get network() { return tr('网络') }, get decode() { return tr('解析') }, get cache() { return tr('缓存') }, get write() { return tr('保存') } }
const coverMiss = ref('')

async function searchCovers(): Promise<void> {
  activeTab.value = 'files'
  if (!item.value || coverSearching.value) return
  coverSearching.value = true
  coverMiss.value = ''
  coverHits.value = []
  coverDiagnostics.value = []
  brokenPreviews.value = new Set()
  const taskId = tasks.start('game-scan', tr("查找游戏封面：{p0}", {p0: (title.value)}), { total: 1, current: title.value })
  try {
    const r = await findCovers(async () => {
      try {
        const result = await window.baoyi.game.searchCovers(props.id)
        for (const diagnostic of result.diagnostics || []) {
          tasks.log(
            taskId,
            diagnostic.status === 'failed' ? 'warn' : 'info',
            `${COVER_SOURCE_LABEL[diagnostic.source]} · ${COVER_STAGE_LABEL[diagnostic.stage]}：${diagnostic.message}`
          )
        }
        tasks.update(taskId, { processed: 1, percent: 100 })
        tasks.finish(
          taskId,
          result.ok ? 'success' : 'failed',
          result.ok
            ? tr("找到 {p0} 张可用封面", {p0: (result.candidates.filter((candidate) => candidate.status === 'ready').length)})
            : result.message
        )
        return result
      } catch (err) {
        tasks.finish(taskId, 'failed', tr("搜索出错：{p0}", {p0: (errorMessage(err))}))
        throw err
      }
    })
    if (r === STALE || !r) return
    coverQuery.value = r.query
    coverHits.value = r.candidates
    coverDiagnostics.value = r.diagnostics || []
    if (!r.ok) coverMiss.value = r.message
    else if (r.message) toast(r.message)
  } catch (err) {
    coverMiss.value = tr("搜索出错：{p0}", {p0: (errorMessage(err))})
  }
  coverSearching.value = false
}

async function useCover(url: string): Promise<void> {
  if (
    !item.value ||
    coverPicking.value ||
    brokenPreviews.value.has(url) ||
    coverHits.value.find((c) => c.url === url)?.status === 'failed'
  ) {
    return
  }
  coverPicking.value = url
  const taskId = tasks.start('game-scan', tr("设置游戏封面：{p0}", {p0: (title.value)}), { total: 1, current: title.value })
  try {
    const r = await chooseCover(async () => {
      try {
        const result = await window.baoyi.game.setCoverFromUrl(props.id, url)
        tasks.update(taskId, { processed: 1, percent: 100 })
        tasks.finish(
          taskId,
          result.ok ? 'success' : 'failed',
          result.message || (result.ok ? tr("封面已设置") : tr("设置封面失败"))
        )
        if (result.ok) void store.load()
        return result
      } catch (err) {
        tasks.finish(taskId, 'failed', tr("设置封面失败：{p0}", {p0: (errorMessage(err))}))
        throw err
      }
    })
    if (r === STALE || !r) return
    if (!r.ok) {
      coverMiss.value = r.message
      error(r.message)
    } else {
      if (r.item) item.value = r.item
      closeCoverHits()
      success(r.message)
    }
  } catch (err) {
    coverMiss.value = tr("设置封面失败：{p0}", {p0: (errorMessage(err))})
    error(coverMiss.value)
  }
  coverPicking.value = ''
}

async function recoverCover(): Promise<void> {
  if (!item.value || coverPicking.value) return
  closeCoverHits()
  coverPicking.value = 'recover'
  const taskId = tasks.start('game-scan', tr("恢复游戏封面：{p0}", {p0: (title.value)}), { total: 1, current: title.value })
  try {
    const result = await chooseCover(async () => {
      try {
        const rebuilt = await window.baoyi.game.rebuildCovers([props.id])
        const message = rebuilt.failed
          ? tr('封面恢复未成功，可重新搜索或选择本地图片')
          : rebuilt.updated
            ? tr('封面已恢复')
            : tr('封面未更改，已保留当前选择')
        tasks.update(taskId, { processed: rebuilt.processed, total: rebuilt.processed, percent: 100 })
        tasks.finish(taskId, rebuilt.failed ? 'failed' : 'success', message)
        const updated = await window.baoyi.game.get(props.id)
        void store.load()
        return {
          item: updated,
          ok: !rebuilt.failed,
          message: rebuilt.failed ? updated?.cover_detail || message : rebuilt.updated ? message : '',
        }
      } catch (err) {
        tasks.finish(taskId, 'failed', tr("恢复封面失败：{p0}", {p0: (errorMessage(err))}))
        throw err
      }
    })
    if (result === STALE || !result) return
    if (result.item) item.value = result.item
    coverMiss.value = result.ok ? '' : result.message
    if (result.ok && result.message) success(result.message)
  } catch (err) {
    coverMiss.value = tr("恢复封面失败：{p0}", {p0: (errorMessage(err))})
  }
  coverPicking.value = ''
}

function previewFailed(candidate: CoverCandidate): void {
  const next = new Set(brokenPreviews.value)
  next.add(candidate.url)
  brokenPreviews.value = next
  coverDiagnostics.value.push({
    source: candidate.source,
    stage: 'cache',
    status: 'failed',
    message: tr("本地预览无法显示，请重新搜索封面"),
    route: tr("本地预览缓存"),
    url: candidate.url,
  })
}

function closeCoverHits(): void {
  void findCovers(async () => null)
  coverSearching.value = false
  coverHits.value = []
  coverMiss.value = ''
  coverQuery.value = ''
  coverDiagnostics.value = []
}

onBeforeUnmount(() => {
  void chooseCover(async () => null)
  closeCoverHits()
})

const { save, commitTags, toggleArchive, reveal, copyPath } = useResourceDetail({
  item,
  reveal: (id) => window.baoyi.game.revealInFolder(id),
  async update(current, patch) {
    if (Object.keys(patch).some((key) => key.startsWith('identity_') || key === 'name_zh' || key === 'name_en')) {
      closeCoverHits()
      void chooseCover(async () => null)
      coverPicking.value = ''
    }
    return store.update(current.id, patch)
  },
})

async function removeSavePath(path: string): Promise<void> {
  if (!item.value) return
  const ok = await confirmDialog({ title: tr('移除这条存档路径？'), message: tr("{p0}\n\n仅从当前游戏记录中移除这条路径，本地存档文件和已有备份记录都会保留。", {p0: (path)}), confirmText: tr('移除路径'), tone: 'danger' })
  if (!ok || !item.value) return
  void save({ save_paths: item.value.save_paths.filter((s) => s.path !== path) })
}

async function addSavePath(): Promise<void> {
  if (!item.value) return
  const check = await window.baoyi.game.pickSavePath()
  if (!check) return

  const already = item.value.save_paths.some((s) => s.path.toLowerCase() === check.path.toLowerCase())
  if (already) {
    toast(tr("这条路径已经登记过了"))
    return
  }
  if (!check.exists) {
    error(tr("无法读取该目录：{p0}", {p0: (check.path)}))
    return
  }
  if (check.files === 0) {
    const ok = await confirmDialog({
      title: tr('目录当前为空，仍要登记吗？'),
      message: tr("{p0}\n\n如果游戏尚未产生存档，可以先登记此路径；在目录内出现真实存档前不会生成空备份。", {p0: (check.path)}),
      confirmText: tr('仍然登记'),
    })
    if (!ok) return
  }

  const next: SavePath[] = [
    ...item.value.save_paths,
    { path: check.path, verified_at: check.files > 0 ? Date.now() : 0 },
  ]
  await save({ save_paths: next })
  success(check.files > 0 ? tr("已登记，检测到 {p0} 个文件", {p0: (check.files)}) : tr("已登记存档路径"))
}

const verifying = ref('')
async function verifySavePath(target: string): Promise<void> {
  if (!item.value) return
  verifying.value = target
  try {
    const check = await window.baoyi.game.verifySavePath(item.value.id, target)
    if (!check.exists) {
      error(tr("未找到该目录，存档可能已被移动或所在磁盘未连接"))
    } else if (check.files === 0) {
      toast(tr("目录存在，但当前暂无存档文件"))
    } else {
      success(tr("路径正常，共 {p0} 个文件（{p1}）", {p0: (check.files), p1: (formatBytes(check.bytes))}))
      store.clearStale(props.id)
      await load()
    }
  } catch (err) {
    error(tr("验证失败：{p0}", {p0: (errorMessage(err))}))
  } finally {
    verifying.value = ''
  }
}

const readBackups = latestOnly(() => window.baoyi.game.backups(props.id))
const backingUp = ref('')
const restoring = ref('')
let saveAction: AbortController | undefined
function beginSaveAction(): AbortSignal {
  saveAction?.abort()
  saveAction = new AbortController()
  backingUp.value = ''
  restoring.value = ''
  return saveAction.signal
}
const askSaveConfirm = (titleText: string, messageText: string, confirmText?: string): Promise<boolean> =>
  confirmDialog({ title: titleText, message: messageText, confirmText })
onBeforeUnmount(() => saveAction?.abort())

async function loadBackups(): Promise<void> {
  if (!item.value) {
    backups.value = []
    return
  }
  try {
    const rows = await readBackups()
    if (rows !== STALE) backups.value = rows
  } catch (err) {
    error(tr("读取备份列表失败：{p0}", {p0: (errorMessage(err))}))
  }
}

async function refreshBackups(): Promise<void> {
  await Promise.all([loadBackups(), store.refreshCounts()])
}

async function backupSave(target: string, note?: string): Promise<void> {
  if (!item.value) return
  const id = item.value.id
  const signal = beginSaveAction()
  backingUp.value = target
  try {
    const scope = await window.baoyi.game.previewBackup(id, target)
    if (signal.aborted) return
    if (
      !(await askSaveConfirm(
        tr("确认备份存档"),
        tr("备份范围：{p0}\n{p1} 个文件，共 {p2}\n仅备份此条已登记路径；其他目录及设备内部存档请分别备份。", {p0: (target), p1: (scope.files), p2: (formatBytes(scope.bytes))})
      ))
    ) {
      return
    }
    const r = await window.baoyi.game.backupSave(id, target, note)
    if (signal.aborted) return
    if (!r.ok) {
      error(r.message)
      return
    }
    await refreshBackups()
    if (signal.aborted) return
    success(tr("{p0}，共 {p1}", {p0: (r.message), p1: (formatBytes(r.backup?.size_bytes ?? 0))}))
    await pruneOver(r.over)
  } catch (err) {
    if (!signal.aborted) error(tr("备份未完成：{p0}", {p0: (errorMessage(err))}))
  } finally {
    if (!signal.aborted) backingUp.value = ''
  }
}

/** 超出保留上限时提醒用户确认清理 */
async function pruneOver(over: SaveBackup[]): Promise<void> {
  if (over.length === 0) return
  const lines = over.map((b) => `· ${formatDateTime(b.created_at)}　${formatBytes(b.size_bytes)}`).join('\n')
  const ok = await confirmDialog({
    title: tr('备份超出保留上限（{p0} 份）', {p0: settings.settings.save_backup_keep}),
    message: tr("是否清理最早的 {p0} 份旧备份？\n{p1}\n\n清理后对应备份文件将从磁盘删除；选择保留也不影响当前备份。", {p0: (over.length), p1: (lines)}),
    confirmText: tr('清理旧备份'),
    tone: 'danger',
  })
  if (!ok) return

  let done = 0
  const failed: string[] = []
  for (const b of over) {
    try {
      const r = await window.baoyi.game.deleteBackup(b.id)
      if (r.ok) done++
      else failed.push(r.message)
    } catch (err) {
      failed.push(errorMessage(err))
    }
  }
  await refreshBackups()
  if (done > 0) success(tr("已清理 {p0} 份旧备份", {p0: (done)}))
  if (failed.length > 0) error(tr("{p0} 份未能清理：{p1}", {p0: (failed.length), p1: (systemMessage(failed[0]))}))
}

async function restore(b: SaveBackup): Promise<void> {
  const signal = beginSaveAction()
  restoring.value = b.id
  try {
    const p = await window.baoyi.game.previewRestore(b.id, restoreTargets.value[b.id] || b.save_path)
    if (signal.aborted) return
    const lines = [
      [tr("新增"), p.added],
      [tr("替换"), p.changed],
      [tr("移出当前目录"), p.removed],
    ] as const
    const detail = lines
      .map(([label, files]) => `${label} ${files.length}：${files.slice(0, 8).join('、')}${files.length > 8 ? '…' : ''}`)
      .join('\n')
    if (
      !(await askSaveConfirm(
        tr("还原「{p0}」存档备份", {p0: (formatDateTime(b.created_at))}),
        tr("目标：{p0}\n{p1}\n保持相同 {p2} 个文件\n\n还原前会先自动备份当前存档，请确认游戏已关闭。", {p0: (p.target), p1: (detail), p2: (p.unchanged)}),
        tr("确认还原")
      ))
    ) {
      return
    }
    const r = await window.baoyi.game.restoreBackup(b.id, p.target, p.expected)
    if (signal.aborted) return
    await refreshBackups()
    if (signal.aborted) return
    if (r.ok) success(r.message)
    else error(r.message)
  } catch (err) {
    if (!signal.aborted) error(tr("还原未完成：{p0}", {p0: (errorMessage(err))}))
  } finally {
    if (!signal.aborted) restoring.value = ''
  }
}

async function dropBackup(b: SaveBackup): Promise<void> {
  const ok = await confirmDialog({
    title: tr('删除「{p0}」这份备份？', {p0: formatDateTime(b.created_at)}),
    message: tr("{p0}\n\n备份文件将从本地磁盘删除且无法恢复。", {p0: (b.backup_dir)}),
    confirmText: tr('删除备份'),
    tone: 'danger',
  })
  if (!ok) return
  try {
    const r = await window.baoyi.game.deleteBackup(b.id)
    await refreshBackups()
    if (r.ok) success(r.message)
    else error(r.message)
  } catch (err) {
    error(tr("删除失败：{p0}", {p0: (errorMessage(err))}))
  }
}

async function openBackup(b: SaveBackup): Promise<void> {
  try {
    await window.baoyi.game.openBackup(b.id)
  } catch (err) {
    error(errorMessage(err))
  }
}

function updateRestoreTarget(backupId: string, target: string | undefined) {
  if (target) restoreTargets.value[backupId] = target
  else delete restoreTargets.value[backupId]
}

function resourcesUpdated(updated: GameItem): void {
  if (item.value?.id === updated.id) item.value = updated
  void store.load()
}

const running = ref(false)
const pathUnavailable = computed(() => !!item.value?.path_state && item.value.path_state !== 'present')
function launchDisabled(entry = item.value?.path): boolean {
  return !entry || !isWindowsGameEntry(entry) || running.value || (entry === item.value?.path && pathUnavailable.value)
}

async function refreshRunning(): Promise<void> {
  if (!item.value) return
  running.value = await window.baoyi.game.running(item.value.id)
}

async function launch(options: GameLaunchOptions = {}): Promise<void> {
  if (!item.value) return
  try {
    const r = await window.baoyi.game.launch(item.value.id, options)
    if (!r.ok) {
      error(r.message)
      return
    }
    toast(r.message)
    await Promise.all([load(), refreshRunning()])
    void store.reload()
  } catch (e) {
    error(errorMessage(e))
  }
}

let offSession: (() => void) | null = null
onMounted(() => {
  if (!store.staleChecked) void store.checkSavePaths()
  offSession = window.baoyi.game.onSession((e) => {
    if (e.id !== props.id) return
    running.value = false
    void load()
    if (e.counted) success(e.message)
    else toast(e.message)
    if (e.status_changed) toast(tr("状态已更新为「{p0}」", {p0: (PLAY_STATUS_LABEL[e.play_status])}))
  })
  void refreshRunning()
})
onBeforeUnmount(() => offSession?.())

function openOfficial(): void {
  if (item.value?.official_url) void window.baoyi.app.openUrl(item.value.official_url).catch((err) => error(errorMessage(err)))
}

async function removeItem(): Promise<void> {
  if (!item.value) return
  const ok = await confirmDialog({
    title: tr('从游戏库移除「{p0}」？', {p0: title.value}),
    message: tr("仅移除抱一中的库记录，本地游戏文件与已有存档备份均会保留。"),
    confirmText: tr('移除记录'),
    tone: 'danger',
  })
  if (!ok) return
  await store.remove(item.value.id)
  success(tr("已从游戏库移除"))
  void router.push({ name: 'game-home' })
}
</script>

<template>
  <div class="detail-shell">
    <Sidebar @selected="router.push({ name: 'game-home' })" />
    <div
      ref="scrollRoot"
      class="detail"
      @scroll="scrolled = ($event.target as HTMLElement).scrollTop > 140"
    >
      <div v-if="loading" class="detail__state">{{ $t("载入中…") }}</div>
      <div v-else-if="!item" class="detail__state">
        <p>{{ loadError || $t("这条记录不存在或已被移除。") }}</p>
        <div style="display: flex; gap: 8px; justify-content: center">
          <button v-if="loadError" type="button" class="btn btn--ghost" @click="loadAll">{{ $t("重新加载") }}</button>
          <button type="button" class="btn btn--ghost" @click="router.push({ name: 'game-home' })">{{ $t("返回游戏库") }}</button>
        </div>
      </div>

      <template v-else>
        <header class="head" :class="{ 'head--scrolled': scrolled }">
          <button type="button" class="btn btn--subtle" @click="router.push({ name: 'game-home' })">
            <ArrowLeft :size="14" />{{ $t("游戏库") }}</button>
          <span class="breadcrumb-sep" :class="{ visible: scrolled }">/</span>
          <span class="breadcrumb-title" :class="{ visible: scrolled }">{{ title }}</span>
          <div class="head__actions">

            <button type="button" :class="!isWindowsGameEntry(item.path) ? 'btn btn--primary' : 'btn btn--ghost'" @click="reveal">
              <FolderOpen :size="14" />{{ !isWindowsGameEntry(item.path) ? $t('打开安装包目录') : $t('打开文件夹') }}

            </button>
            <button
              type="button"
              class="btn btn--ghost btn--icon"
              :disabled="!item.official_url"
              :aria-label="$t('官网')"
              @click="openOfficial"
            >
              <ExternalLink :size="14" />
            </button>
            <LibraryToolbarMenu icon="more" :label="$t('游戏操作')">
              <button type="button" @click="toggleArchive">
                {{ item.is_archived ? $t('取消归档') : $t('归档') }}
              </button>
              <button type="button" @click="copyPath(item.path)">{{ $t("复制路径") }}</button>
              <button type="button" @click="removeItem">{{ $t("从库里移除") }}</button>
            </LibraryToolbarMenu>
            <div class="split-launch">
              <button
                type="button"
                class="btn btn--primary"
                :disabled="launchDisabled()"
                :title="
                  !isWindowsGameEntry(item.path)
                    ? $t('安装包请在对应设备使用')
                    : pathUnavailable
                      ? $t('请先重新定位游戏程序')
                      : $t('启动游戏')
                "
                @click="launch()"
              >
                <Play :size="14" />{{
                  !isWindowsGameEntry(item.path) ? $t('安卓资料') : running ? $t('正在运行') : $t('启动')
                }}
              </button>
              <LibraryToolbarMenu icon="chevron" :label="$t('选择启动方式')">
                <button
                  v-for="entry in entries"
                  :key="entry.path"
                  type="button"
                  :disabled="launchDisabled(entry.path)"
                  @click="launch({ entry: entry.path })"
                >
                  {{ entry.path === item.path ? '★ ' : '' }}{{ entry.label }}
                </button>
                <button
                  v-for="tool in executableTrainers"
                  :key="tool.path"
                  type="button"
                  :disabled="launchDisabled()"
                  @click="launch({ trainers: [tool.path] })"
                >{{ $t("连同 {p0} 启动", {p0: (tool.label)}) }}</button>
                <template v-if="executableTrainers.length > 1">
                  <div class="launch-trainer-group" @click.stop>
                    <small>{{ $t("勾选随游戏启动的修改器") }}</small>
                    <label v-for="tool in executableTrainers" :key="'chk:' + tool.path" class="launch-trainer-opt">
                      <input
                        type="checkbox"
                        :checked="selectedTrainers.includes(tool.path)"
                        @change="toggleSelectedTrainer(tool.path, ($event.target as HTMLInputElement).checked)"
                      />
                      <span>{{ tool.label }}</span>
                    </label>
                  </div>
                  <button
                    type="button"
                    :disabled="launchDisabled() || selectedTrainers.length === 0"
                    @click="launch({ trainers: [...selectedTrainers] })"
                  >{{ $t("启动游戏 + 已勾 {p0} 项", {p0: (selectedTrainers.length)}) }}</button>
                </template>
              </LibraryToolbarMenu>
            </div>
          </div>
        </header>

        <div class="body detail-body">
          <section class="hero">
            <div
              v-if="heroBackground"
              class="hero-backdrop"
              :style="{ backgroundImage: 'url(' + JSON.stringify(heroBackground) + ')' }"
            />
            <div class="hero-cover" :class="{ 'hero-cover--wide': heroWide }">
              <GameCover :item="item" :shape="heroWide ? 'wide' : 'vert'" @failed="coverBroken = true" />
              <button type="button" class="manage-cover btn btn--ghost" @click="activeTab = 'files'">{{ $t("管理封面") }}</button>
            </div>

            <div class="hero__text">
              <input
                class="hero__name"
                :value="item.name_zh"
                :placeholder="$t('游戏名')"
                :aria-label="$t('游戏名')"
                @change="save({ name_zh: ($event.target as HTMLInputElement).value.trim() })"
              />
              <input
                class="hero__en"
                :value="item.name_en"
                :placeholder="$t('原名 / 英文名')"
                :aria-label="$t('原名')"
                @change="save({ name_en: ($event.target as HTMLInputElement).value.trim() })"
              />
              <input
                class="hero__summary"
                :value="item.summary"
                :placeholder="$t('一句话说明')"
                :aria-label="$t('一句话说明')"
                @change="save({ summary: ($event.target as HTMLInputElement).value.trim() })"
              />
              <div class="hero-status">
                <div class="statuses">
                  <button
                    v-for="status in ['playing', 'unplayed', 'completed', 'shelved'] as const"
                    :key="status"
                    type="button"
                    :class="['chip', 'status-' + status, { on: item.play_status === status }]"
                    :aria-pressed="item.play_status === status"
                    @click="save({ play_status: status })"
                  >
                    <i />{{ PLAY_STATUS_LABEL[status] }}
                  </button>
                </div>
                <button
                  type="button"
                  class="identity-pill"
                  :class="{ 'identity-pill--pending': !item.identity_confirmed }"
                  @click="save({ identity_confirmed: !item.identity_confirmed })"
                >
                  <BadgeCheck :size="13" />{{
                    item.identity_confirmed ? item.identity_name || item.name_en || title : $t('名称待确认 · 点击确认')
                  }}
                </button>
              </div>
              <div class="hero-stats">
                <div>
                  <small>{{ $t("游玩时长") }}</small><b>{{ formatPlaytime(item.total_playtime_sec) }}</b>
                </div>
                <div>
                  <small>{{ $t("上次游玩") }}</small><b>{{ item.last_played_at ? formatRelative(item.last_played_at) : $t('未玩过') }}</b>
                </div>
                <div>
                  <small>{{ $t("启动次数") }}</small><b>{{ item.use_count || $t('未启动') }}</b>
                </div>
                <div>
                  <small>{{ $t("存档备份") }}</small><b>{{ $t("{p0} 份", {p0: (backups.length)}) }}</b>
                </div>
              </div>
            </div>

            <aside class="hero-meta">
              <h3>{{ $t("归类") }}</h3>
              <label class="cat-combo">{{ $t("分类") }}<input
                  :value="item.category"
                  autocomplete="off"
                  :aria-label="$t('游戏分类')"
                  @focus="categoryOpen = true"
                  @click="categoryOpen = true"
                  @blur="closeCategoryDropdown"
                  @change="save({ category: ($event.target as HTMLInputElement).value.trim() })"
                />
                <div v-if="categoryOpen && categories.length" class="cat-dropdown">
                  <button
                    v-for="c in categories"
                    :key="c"
                    type="button"
                    class="cat-option"
                    :class="{ active: item.category === c }"
                    @mousedown.prevent="save({ category: c }); categoryOpen = false"
                  >
                    {{ c }}
                  </button>
                </div>


              </label>
              <div class="hero-tags">
                <span>{{ $t("标签") }}</span>
                <div>
                  <button
                    v-for="t in item.tags"
                    :key="t"
                    type="button"
                    :aria-label="$t('删除标签 ') + t"
                    @click="save({ tags: item.tags.filter((v) => v !== t) })"
                  >
                    {{ t }} ×
                  </button>
                  <input
                    :aria-label="$t('添加游戏标签')"
                    :placeholder="$t('+ 添加')"
                    @keydown.enter="
                      !$event.isComposing &&
                        commitTags([...item.tags, ($event.target as HTMLInputElement).value].join('、'));
                      !$event.isComposing && (($event.target as HTMLInputElement).value = '')
                    "
                  />
                </div>
              </div>
              <h3>{{ $t("记录") }}</h3>
              <dl class="facts">
                <dt>{{ $t("加入") }}</dt>
                <dd>{{ formatDate(item.created_at) }}</dd>
                <dt>{{ $t("目录") }}</dt>
                <dd class="truncate" :title="item.source_dir">{{ item.source_dir.split(/[\\/]/).pop() }}</dd>
                <dt>{{ $t("入口") }}</dt>
                <dd class="truncate" :title="item.path">{{ item.file_name }}</dd>
              </dl>
            </aside>
          </section>

          <div v-if="item.path_state && item.path_state !== 'present'" class="path-warning" role="alert">
            <Unlink :size="16" />
            <span>
              {{
                item.path_state === 'offline'
                  ? $t('游戏所在磁盘离线，请先连接磁盘。')
                  : $t('程序路径不可用，可能已被移动或改名。')
              }}
            </span>
            <button type="button" class="btn btn--ghost" @click="recheck">{{ $t("重新检查") }}</button>
            <button type="button" class="btn btn--primary" :disabled="relocating" @click="relocate()">{{ $t("重新定位") }}</button>
          </div>

          <div ref="tabRoot" class="game-tabs">
            <DetailTabs v-model="activeTab" :tabs="detailTabs" prefix="game" :label="$t('游戏详情')" />
          </div>

          <div
            id="game-panel-overview"
            v-show="activeTab === 'overview'"
            role="tabpanel"
            aria-labelledby="game-tab-overview"
            tabindex="0"
            class="detail-panel detail-panel--overview"
          >
            <div class="quick-cards">
              <button type="button" @click="activeTab = 'trainer'">
                <span><Wrench :size="14" />{{ $t("修改器") }}</span>
                <b>{{ $t("{p0} 个", {p0: (trainers.length)}) }}</b>
                <small>{{
                  trainers
                    .flatMap((t) => t.features || [])
                    .slice(0, 3)
                    .map((f) => f.label)
                    .join(' · ') || $t('功能与用法')
                }}</small>
              </button>
              <button type="button" @click="activeTab = 'guide'">
                <span><BookOpen :size="14" />{{ $t("攻略与说明") }}</span>
                <b>{{ $t("{p0} 份", {p0: (guides.length)}) }}</b>
                <small>
                  {{ guides.find((f) => f.read_progress)?.label || $t('本地攻略与资料')
                  }}{{
                    guides.some((f) => f.read_progress)
                      ? $t(' · 读到 ') + Math.round((guides.find((f) => f.read_progress)?.read_progress || 0) * 100) + '%'
                      : ''
                  }}
                </small>
              </button>
              <button type="button" @click="activeTab = 'saves'">
                <span><Save :size="14" />{{ $t("存档备份") }}</span>
                <b>{{ $t("{p0} 份", {p0: (backups.length)}) }}</b>
                <small>{{
                  backups[0]
                    ? $t('最新 ') + formatDateTime(backups[0].created_at)
                    : item.save_paths.length
                      ? $t('有存档，尚未备份')
                      : $t('尚未指定存档')
                }}</small>
              </button>
              <button type="button" @click="activeTab = 'notes'">
                <span><StickyNote :size="14" />{{ $t("笔记") }}</span>
                <b>{{ $t("{p0} 条", {p0: (gameNotes.length)}) }}</b>
                <small>{{
                  gameNotes.slice().sort((a, b) => b.updated_at - a.updated_at)[0]?.title || $t('记下你的游玩进度')
                }}</small>
              </button>
            </div>

            <GameProjectRecord :key="item.id" :game="item" @read="reportPath = $event; activeTab = 'guide'" />

            <ResourceBacklinksPanel :resource-id="item.id" />

            <section class="panel description-panel">
              <h2 class="sec-title">{{ $t("我的简介与补充") }}<small>{{ $t("失焦自动保存") }}</small></h2>
              <p v-if="report" class="description-hint">{{ $t("这里保留你的编辑和早期介绍；最新修复情况见上方状态及使用导航。") }}</p>
              <EditableField
                :model-value="item.description"
                multiline
                :placeholder="$t('讲的是什么、玩法是什么样的')"
                @commit="save({ description: $event })"
              />
            </section>

            <section v-if="report" class="panel project-record" :aria-label="$t('精修工作记录')">
              <div class="project-record__head">
                <h2 class="sec-title">{{ $t("精修工作记录") }}</h2>
                <button type="button" class="btn btn--ghost" @click="readReport">{{ $t("阅读完整精修记录") }}</button>
              </div>
              <details class="project-record__details">
                <summary>{{ $t("展开工作摘要与历史说明") }}</summary>
                <div class="project-record__sections">
                  <p v-for="(section, i) in projectSections" :key="i">{{ section }}</p>
                  <p v-if="!projectSections.length">{{ $t("完整工作内容与验证范围见精修记录。") }}</p>
                </div>
              </details>
            </section>
          </div>

          <div
            id="game-panel-trainer"
            v-show="activeTab === 'trainer'"
            class="detail-resources"
            role="tabpanel"
            aria-labelledby="game-tab-trainer"
            tabindex="0"
          >
            <GameTools v-if="activeTab === 'trainer'" :key="item.id" :game="item" @updated="resourcesUpdated" />
          </div>

          <div
            id="game-panel-guide"
            v-show="activeTab === 'guide'"
            class="detail-resources"
            role="tabpanel"
            aria-labelledby="game-tab-guide"
            tabindex="0"
          >
            <GameDocs
              v-if="guideVisited || activeTab === 'guide'"
              :key="item.id"
              :game="item"
              :initial-path="reportPath"
              @updated="resourcesUpdated"
            />
          </div>

          <GameSavesTab
            v-show="activeTab === 'saves'"
            :item="item"
            :backups="backups"
            :stale-paths="store.staleSaves.get(props.id) ?? []"
            :verifying="verifying"
            :backing-up="backingUp"
            :restoring="restoring"
            :restore-targets="restoreTargets"
            @add-save-path="addSavePath"
            @copy-path="copyPath"
            @verify-save-path="verifySavePath"
            @backup-save="backupSave"
            @remove-save-path="removeSavePath"
            @open-backup="openBackup"
            @restore="restore"
            @drop-backup="dropBackup"
            @update-restore-target="updateRestoreTarget"
          />

          <GameFilesCoverTab
            v-show="activeTab === 'files'"
            :item="item"
            :title="title"
            :entries="entries"
            :launch-disabled-fn="launchDisabled"
            :cover-broken="coverBroken"
            :cover-searching="coverSearching"
            :cover-picking="coverPicking"
            :cover-hits="coverHits"
            :cover-query="coverQuery"
            :cover-miss="coverMiss"
            :cover-diagnostics="coverDiagnostics"
            :broken-previews="brokenPreviews"
            :relocating="relocating"
            @default-entry="defaultEntry"
            @launch-entry="(p) => launch({ entry: p })"
            @save="save"
            @search-covers="searchCovers"
            @pick-cover="pickCover"
            @pick-background="(c) => background(c)"
            @clear-cover="clearCover"
            @recover-cover="recoverCover"
            @close-cover-hits="closeCoverHits"
            @use-cover="useCover"
            @preview-failed="previewFailed"
            @resources-updated="resourcesUpdated"
            @relocate="relocate"
            @copy-path="copyPath"
          />

          <div
            id="game-panel-notes"
            v-show="activeTab === 'notes'"
            role="tabpanel"
            aria-labelledby="game-tab-notes"
            tabindex="0"
            class="detail-panel detail-panel--notes"
          >
            <GameNotes :key="item.id" ref="notesPanel" :game-id="item.id" @changed="gameNotes = $event" />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cat-combo { position: relative; }
.cat-dropdown { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 25; max-height: 220px; overflow-y: auto; padding: 4px; border-radius: var(--radius-input); border: 1px solid var(--divider-strong); background: var(--bg-elevated); box-shadow: var(--shadow-pop); display: flex; flex-direction: column; gap: 2px; }
.cat-option { width: 100%; padding: 5px 8px; border-radius: 5px; font-size: var(--fs-tag); color: var(--text-main); text-align: left; }
.cat-option:hover, .cat-option.active { background: var(--hover-surface); color: var(--accent); }
.launch-trainer-group { display: flex; flex-direction: column; gap: 6px; padding: 6px 4px; border-top: 1px solid var(--divider); }
.launch-trainer-group > small { font-size: 11px; color: var(--text-faint); }
.launch-trainer-opt { display: flex; align-items: center; justify-content: flex-start !important; gap: 8px; font-size: 12px; color: var(--text-main); cursor: pointer; }
.launch-trainer-opt input { accent-color: var(--accent); }
.path-warning {
  display: flex;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 24px;
  color: var(--warning);
  background: var(--bg-card);
}
.detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}
.detail__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--text-sub);
}
.head {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 24px;
  background: var(--bg-main);
  border-bottom: 1px solid var(--divider);
}
.head__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.body {
  padding: 20px 24px 32px;
}
.sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--text-sub);
}
.hero {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  padding: 20px;
}
.hero__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hero__name,
.hero__en,
.hero__summary {
  width: 100%;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  outline: none;
  padding: 3px 6px;
  margin-left: -6px;
  color: inherit;
  transition: border-color var(--t-fast) ease;
}
.hero__name:hover,
.hero__en:hover,
.hero__summary:hover {
  border-color: var(--divider);
}
.hero__name:focus,
.hero__en:focus,
.hero__summary:focus {
  border-color: var(--accent);
}
.hero__name {
  font-size: 21px;
  font-weight: 500;
}
.hero__en {
  font-size: var(--fs-body);
  color: var(--text-faint);
}
.hero__summary {
  font-size: var(--fs-body);
  color: var(--text-sub);
}
.statuses {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.chip {
  height: 26px;
  padding: 0 12px;
  border-radius: var(--radius-tag);
  font-size: var(--fs-tag);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  transition: background var(--t-fast) ease, color var(--t-fast) ease, border-color var(--t-fast) ease;
}
.chip:hover {
  color: var(--text-main);
}
.chip.on {
  background: var(--active-surface);
  border-color: transparent;
  color: var(--accent);
}
.facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 7px 12px;
  font-size: var(--fs-tag);
}
.facts dt {
  color: var(--text-faint);
  white-space: nowrap;
}
.facts dd {
  min-width: 0;
  color: var(--text-sub);
  margin: 0;
}
.project-record {
  grid-column: 1 / -1;
}
.project-record__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.project-record__sections {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 24px;
}
.project-record__sections p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.9;
  margin: 0;
  padding: 12px 0;
  border-top: 1px solid var(--divider);
  color: var(--text-sub);
}
.project-record__sections p:first-child {
  grid-column: 1 / -1;
  color: var(--accent-ink);
}
@media (max-width: 1000px) {
  .project-record__sections {
    grid-template-columns: 1fr;
  }
}
</style>

<style scoped src="./detail-v21.css" />
