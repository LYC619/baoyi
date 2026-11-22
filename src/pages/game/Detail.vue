<script setup lang="ts">
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

const trainers = computed(() => item.value?.linked_files.filter((f) => f.type === 'trainer') || [])
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
  { id: 'overview', label: '简介', icon: FileText },
  { id: 'trainer', label: '工具与修改器', icon: Wrench, count: trainers.value.length },
  { id: 'guide', label: '攻略与说明', icon: BookOpen, count: guides.value.length },
  {
    id: 'saves',
    label: '存档与备份',
    icon: Save,
    dot: !!item.value?.save_paths.length && !backups.value.length,
  },
  { id: 'files', label: '文件与封面', icon: Image, count: entries.value.length },
  { id: 'notes', label: '笔记', icon: StickyNote, count: gameNotes.value.length },
])

async function leaveNotes() {
  return (await notesPanel.value?.flush()) ?? true
}
onBeforeRouteLeave(leaveNotes)
onBeforeRouteUpdate(leaveNotes)

watch(activeTab, (tab) => {
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
      success('路径已更新，游玩记录与存档信息已保留')
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

async function load(): Promise<void> {
  closeCoverHits()
  void chooseCover(async () => null)
  coverPicking.value = ''
  loading.value = true
  try {
    const result = await readGame()
    if (result === STALE) return
    item.value = result
  } catch (err) {
    error(`读取游戏失败：${errorMessage(err)}`)
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
    coverMiss.value = `更换封面失败：${errorMessage(err)}`
    error(coverMiss.value)
  }
}

async function clearCover(): Promise<void> {
  if (!item.value?.cover_path) return
  const ok = await confirmDialog({
    title: '恢复默认封面？',
    message: '将移除抱一保存的封面副本并恢复自动构图，你原有的本地图片文件不会受影响。',
    confirmText: '恢复默认',
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
    error(`移除封面失败：${errorMessage(err)}`)
  }
}

const coverSearching = ref(false)
const coverPicking = ref('')
const coverHits = ref<CoverCandidate[]>([])
const coverQuery = ref('')
const coverDiagnostics = ref<GameCoverDiagnostic[]>([])
const brokenPreviews = ref(new Set<string>())
const COVER_SOURCE_LABEL = { local: '本地图片', official: '官方', steam: 'Steam', search: '图片搜索' }
const COVER_STAGE_LABEL = { identity: '名称核对', lookup: '检索', network: '网络', decode: '解析', cache: '缓存', write: '保存' }
const coverMiss = ref('')

async function searchCovers(): Promise<void> {
  activeTab.value = 'files'
  if (!item.value || coverSearching.value) return
  coverSearching.value = true
  coverMiss.value = ''
  coverHits.value = []
  coverDiagnostics.value = []
  brokenPreviews.value = new Set()
  const taskId = tasks.start('game-scan', `查找游戏封面：${title.value}`, { total: 1, current: title.value })
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
            ? `找到 ${result.candidates.filter((candidate) => candidate.status === 'ready').length} 张可用封面`
            : result.message
        )
        return result
      } catch (err) {
        tasks.finish(taskId, 'failed', `搜索出错：${errorMessage(err)}`)
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
    coverMiss.value = `搜索出错：${errorMessage(err)}`
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
  const taskId = tasks.start('game-scan', `设置游戏封面：${title.value}`, { total: 1, current: title.value })
  try {
    const r = await chooseCover(async () => {
      try {
        const result = await window.baoyi.game.setCoverFromUrl(props.id, url)
        tasks.update(taskId, { processed: 1, percent: 100 })
        tasks.finish(
          taskId,
          result.ok ? 'success' : 'failed',
          result.message || (result.ok ? '封面已设置' : '设置封面失败')
        )
        if (result.ok) void store.load()
        return result
      } catch (err) {
        tasks.finish(taskId, 'failed', `设置封面失败：${errorMessage(err)}`)
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
    coverMiss.value = `设置封面失败：${errorMessage(err)}`
    error(coverMiss.value)
  }
  coverPicking.value = ''
}

async function recoverCover(): Promise<void> {
  if (!item.value || coverPicking.value) return
  closeCoverHits()
  coverPicking.value = 'recover'
  const taskId = tasks.start('game-scan', `恢复游戏封面：${title.value}`, { total: 1, current: title.value })
  try {
    const result = await chooseCover(async () => {
      try {
        const rebuilt = await window.baoyi.game.rebuildCovers([props.id])
        const message = rebuilt.failed
          ? '封面恢复未成功，可重新搜索或选择本地图片'
          : rebuilt.updated
            ? '封面已恢复'
            : '封面未更改，已保留当前选择'
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
        tasks.finish(taskId, 'failed', `恢复封面失败：${errorMessage(err)}`)
        throw err
      }
    })
    if (result === STALE || !result) return
    if (result.item) item.value = result.item
    coverMiss.value = result.ok ? '' : result.message
    if (result.ok && result.message) success(result.message)
  } catch (err) {
    coverMiss.value = `恢复封面失败：${errorMessage(err)}`
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
    message: '本地预览无法显示，请重新搜索封面',
    route: '本地预览缓存',
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

function removeSavePath(path: string): void {
  if (!item.value) return
  void save({ save_paths: item.value.save_paths.filter((s) => s.path !== path) })
}

async function addSavePath(): Promise<void> {
  if (!item.value) return
  const check = await window.baoyi.game.pickSavePath()
  if (!check) return

  const already = item.value.save_paths.some((s) => s.path.toLowerCase() === check.path.toLowerCase())
  if (already) {
    toast('这条路径已经登记过了')
    return
  }
  if (!check.exists) {
    error(`无法读取该目录：${check.path}`)
    return
  }
  if (check.files === 0) {
    const ok = await confirmDialog({
      title: '目录当前为空，仍要登记吗？',
      message: `${check.path}\n\n如果游戏尚未产生存档，可以先登记此路径；在目录内出现真实存档前不会生成空备份。`,
      confirmText: '仍然登记',
    })
    if (!ok) return
  }

  const next: SavePath[] = [
    ...item.value.save_paths,
    { path: check.path, verified_at: check.files > 0 ? Date.now() : 0 },
  ]
  await save({ save_paths: next })
  success(check.files > 0 ? `已登记，检测到 ${check.files} 个文件` : '已登记存档路径')
}

const verifying = ref('')
async function verifySavePath(target: string): Promise<void> {
  if (!item.value) return
  verifying.value = target
  try {
    const check = await window.baoyi.game.verifySavePath(item.value.id, target)
    if (!check.exists) {
      error('未找到该目录，存档可能已被移动或所在磁盘未连接')
    } else if (check.files === 0) {
      toast('目录存在，但当前暂无存档文件')
    } else {
      success(`路径正常，共 ${check.files} 个文件（${formatBytes(check.bytes)}）`)
      store.clearStale(props.id)
      await load()
    }
  } catch (err) {
    error(`验证失败：${errorMessage(err)}`)
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
  typeof confirmDialog === 'function'
    ? confirmDialog({ title: titleText, message: messageText, confirmText })
    : Promise.resolve(window.confirm(messageText))
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
    error(`读取备份列表失败：${errorMessage(err)}`)
  }
}

async function refreshBackups(): Promise<void> {
  await Promise.all([loadBackups(), store.refreshCounts()])
}

async function backupSave(target: string): Promise<void> {
  if (!item.value) return
  const id = item.value.id
  const signal = beginSaveAction()
  backingUp.value = target
  try {
    const scope = await window.baoyi.game.previewBackup(id, target)
    if (signal.aborted) return
    if (
      !(await askSaveConfirm(
        '确认备份存档',
        `备份范围：${target}\n${scope.files} 个文件，共 ${formatBytes(scope.bytes)}\n仅备份此条已登记路径；其他目录及设备内部存档请分别备份。`
      ))
    ) {
      return
    }
    const r = await window.baoyi.game.backupSave(id, target)
    if (signal.aborted) return
    if (!r.ok) {
      error(r.message)
      return
    }
    await refreshBackups()
    if (signal.aborted) return
    success(`${r.message}，共 ${formatBytes(r.backup?.size_bytes ?? 0)}`)
    await pruneOver(r.over)
  } catch (err) {
    if (!signal.aborted) error(`备份未完成：${errorMessage(err)}`)
  } finally {
    if (!signal.aborted) backingUp.value = ''
  }
}

/** 超出保留上限时提醒用户确认清理 */
async function pruneOver(over: SaveBackup[]): Promise<void> {
  if (over.length === 0) return
  const lines = over.map((b) => `· ${formatDateTime(b.created_at)}　${formatBytes(b.size_bytes)}`).join('\n')
  const ok = await confirmDialog({
    title: `备份超出保留上限（${settings.settings.save_backup_keep} 份）`,
    message: `是否清理最早的 ${over.length} 份旧备份？\n${lines}\n\n清理后对应备份文件将从磁盘删除；选择保留也不影响当前备份。`,
    confirmText: '清理旧备份',
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
  if (done > 0) success(`已清理 ${done} 份旧备份`)
  if (failed.length > 0) error(`${failed.length} 份未能清理：${failed[0]}`)
}

async function restore(b: SaveBackup): Promise<void> {
  const signal = beginSaveAction()
  restoring.value = b.id
  try {
    const p = await window.baoyi.game.previewRestore(b.id, restoreTargets.value[b.id] || b.save_path)
    if (signal.aborted) return
    const lines = [
      ['新增', p.added],
      ['替换', p.changed],
      ['移出当前目录', p.removed],
    ] as const
    const detail = lines
      .map(([label, files]) => `${label} ${files.length}：${files.slice(0, 8).join('、')}${files.length > 8 ? '…' : ''}`)
      .join('\n')
    if (
      !(await askSaveConfirm(
        `还原「${formatDateTime(b.created_at)}」存档备份`,
        `目标：${p.target}\n${detail}\n保持相同 ${p.unchanged} 个文件\n\n还原前会先自动备份当前存档，请确认游戏已关闭。`,
        '确认还原'
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
    if (!signal.aborted) error(`还原未完成：${errorMessage(err)}`)
  } finally {
    if (!signal.aborted) restoring.value = ''
  }
}

async function dropBackup(b: SaveBackup): Promise<void> {
  const ok = await confirmDialog({
    title: `删除「${formatDateTime(b.created_at)}」这份备份？`,
    message: `${b.backup_dir}\n\n备份文件将从本地磁盘删除且无法恢复。`,
    confirmText: '删除备份',
    tone: 'danger',
  })
  if (!ok) return
  try {
    const r = await window.baoyi.game.deleteBackup(b.id)
    await refreshBackups()
    if (r.ok) success(r.message)
    else error(r.message)
  } catch (err) {
    error(`删除失败：${errorMessage(err)}`)
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
    await refreshRunning()
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
    if (e.status_changed) toast(`状态已更新为「${PLAY_STATUS_LABEL[e.play_status]}」`)
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
    title: `从游戏库移除「${title.value}」？`,
    message: '仅移除抱一中的库记录，本地游戏文件与已有存档备份均会保留。',
    confirmText: '移除记录',
    tone: 'danger',
  })
  if (!ok) return
  await store.remove(item.value.id)
  success('已从游戏库移除')
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
      <div v-if="loading" class="detail__state">载入中…</div>
      <div v-else-if="!item" class="detail__state">
        <p>这条记录不存在或已被移除。</p>
        <button type="button" class="btn btn--ghost" @click="router.push({ name: 'game-home' })">
          返回游戏库
        </button>
      </div>

      <template v-else>
        <header class="head" :class="{ 'head--scrolled': scrolled }">
          <button type="button" class="btn btn--subtle" @click="router.push({ name: 'game-home' })">
            <ArrowLeft :size="14" />游戏库
          </button>
          <span class="breadcrumb-sep" :class="{ visible: scrolled }">/</span>
          <span class="breadcrumb-title" :class="{ visible: scrolled }">{{ title }}</span>
          <div class="head__actions">
            <button type="button" class="btn btn--ghost" @click="reveal">
              <FolderOpen :size="14" />打开文件夹
            </button>
            <button
              type="button"
              class="btn btn--ghost btn--icon"
              :disabled="!item.official_url"
              aria-label="官网"
              @click="openOfficial"
            >
              <ExternalLink :size="14" />
            </button>
            <LibraryToolbarMenu icon="more" label="游戏操作">
              <button type="button" @click="toggleArchive">
                {{ item.is_archived ? '取消归档' : '归档' }}
              </button>
              <button type="button" @click="copyPath(item.path)">复制路径</button>
              <button type="button" @click="removeItem">从库里移除</button>
            </LibraryToolbarMenu>
            <div class="split-launch">
              <button
                type="button"
                class="btn btn--primary"
                :disabled="launchDisabled()"
                :title="
                  !isWindowsGameEntry(item.path)
                    ? '安装包请在对应设备使用'
                    : pathUnavailable
                      ? '请先重新定位游戏程序'
                      : '启动游戏'
                "
                @click="launch()"
              >
                <Play :size="14" />{{
                  !isWindowsGameEntry(item.path) ? '安卓资料' : running ? '正在运行' : '启动'
                }}
              </button>
              <LibraryToolbarMenu icon="chevron" label="选择启动方式">
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
                  v-for="tool in trainers.filter((f) => f.role !== 'usage' && /\.(exe|cmd|bat|lnk)$/i.test(f.path))"
                  :key="tool.path"
                  type="button"
                  :disabled="launchDisabled()"
                  @click="launch({ trainers: [tool.path] })"
                >
                  连同 {{ tool.label }} 启动
                </button>
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
              <button type="button" class="manage-cover btn btn--ghost" @click="activeTab = 'files'">
                管理封面
              </button>
            </div>

            <div class="hero__text">
              <input
                class="hero__name"
                :value="item.name_zh"
                placeholder="游戏名"
                aria-label="游戏名"
                @change="save({ name_zh: ($event.target as HTMLInputElement).value.trim() })"
              />
              <input
                class="hero__en"
                :value="item.name_en"
                placeholder="原名 / 英文名"
                aria-label="原名"
                @change="save({ name_en: ($event.target as HTMLInputElement).value.trim() })"
              />
              <input
                class="hero__summary"
                :value="item.summary"
                placeholder="一句话说明"
                aria-label="一句话说明"
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
                    item.identity_confirmed ? item.identity_name || item.name_en || title : '名称待确认 · 点击确认'
                  }}
                </button>
              </div>
              <div class="hero-stats">
                <div>
                  <small>游玩时长</small><b>{{ formatPlaytime(item.total_playtime_sec) }}</b>
                </div>
                <div>
                  <small>上次游玩</small><b>{{ item.last_played_at ? formatRelative(item.last_played_at) : '未玩过' }}</b>
                </div>
                <div>
                  <small>启动次数</small><b>{{ item.use_count || '未启动' }}</b>
                </div>
                <div>
                  <small>存档备份</small><b>{{ backups.length }} 份</b>
                </div>
              </div>
            </div>

            <aside class="hero-meta">
              <h3>归类</h3>
              <label>
                分类
                <input
                  :value="item.category"
                  list="game-categories"
                  aria-label="游戏分类"
                  @change="save({ category: ($event.target as HTMLInputElement).value.trim() })"
                />
                <datalist id="game-categories">
                  <option v-for="c in categories" :key="c" :value="c" />
                </datalist>
              </label>
              <div class="hero-tags">
                <span>标签</span>
                <div>
                  <button
                    v-for="t in item.tags"
                    :key="t"
                    type="button"
                    :aria-label="'删除标签 ' + t"
                    @click="save({ tags: item.tags.filter((v) => v !== t) })"
                  >
                    {{ t }} ×
                  </button>
                  <input
                    aria-label="添加游戏标签"
                    placeholder="+ 添加"
                    @keydown.enter="
                      !$event.isComposing &&
                        commitTags([...item.tags, ($event.target as HTMLInputElement).value].join('、'));
                      !$event.isComposing && (($event.target as HTMLInputElement).value = '')
                    "
                  />
                </div>
              </div>
              <h3>记录</h3>
              <dl class="facts">
                <dt>加入</dt>
                <dd>{{ formatDate(item.created_at) }}</dd>
                <dt>目录</dt>
                <dd class="truncate" :title="item.source_dir">{{ item.source_dir.split(/[\\/]/).pop() }}</dd>
                <dt>入口</dt>
                <dd class="truncate" :title="item.path">{{ item.file_name }}</dd>
              </dl>
            </aside>
          </section>

          <div v-if="item.path_state && item.path_state !== 'present'" class="path-warning" role="alert">
            <Unlink :size="16" />
            <span>
              {{
                item.path_state === 'offline'
                  ? '游戏所在磁盘离线，请先连接磁盘。'
                  : '程序路径不可用，可能已被移动或改名。'
              }}
            </span>
            <button type="button" class="btn btn--ghost" @click="recheck">重新检查</button>
            <button type="button" class="btn btn--primary" :disabled="relocating" @click="relocate()">
              重新定位
            </button>
          </div>

          <div ref="tabRoot" class="game-tabs">
            <DetailTabs v-model="activeTab" :tabs="detailTabs" prefix="game" label="游戏详情" />
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
                <span><Wrench :size="14" />修改器</span>
                <b>{{ trainers.length }} 个</b>
                <small>{{
                  trainers
                    .flatMap((t) => t.features || [])
                    .slice(0, 3)
                    .map((f) => f.label)
                    .join(' · ') || '功能与用法'
                }}</small>
              </button>
              <button type="button" @click="activeTab = 'guide'">
                <span><BookOpen :size="14" />攻略与说明</span>
                <b>{{ guides.length }} 份</b>
                <small>
                  {{ guides.find((f) => f.read_progress)?.label || '本地攻略与资料'
                  }}{{
                    guides.some((f) => f.read_progress)
                      ? ' · 读到 ' + Math.round((guides.find((f) => f.read_progress)?.read_progress || 0) * 100) + '%'
                      : ''
                  }}
                </small>
              </button>
              <button type="button" @click="activeTab = 'saves'">
                <span><Save :size="14" />存档备份</span>
                <b>{{ backups.length }} 份</b>
                <small>{{
                  backups[0]
                    ? '最新 ' + formatDateTime(backups[0].created_at)
                    : item.save_paths.length
                      ? '有存档，尚未备份'
                      : '尚未指定存档'
                }}</small>
              </button>
              <button type="button" @click="activeTab = 'notes'">
                <span><StickyNote :size="14" />笔记</span>
                <b>{{ gameNotes.length }} 条</b>
                <small>{{
                  gameNotes.slice().sort((a, b) => b.updated_at - a.updated_at)[0]?.title || '记下你的游玩进度'
                }}</small>
              </button>
            </div>

            <GameProjectRecord :key="item.id" :game="item" @read="reportPath = $event; activeTab = 'guide'" />

            <ResourceBacklinksPanel :resource-id="item.id" />

            <section class="panel description-panel">
              <h2 class="sec-title">我的简介与补充 <small>失焦自动保存</small></h2>
              <p v-if="report" class="description-hint">
                这里保留你的编辑和早期介绍；最新修复情况见上方状态及使用导航。
              </p>
              <EditableField
                :model-value="item.description"
                multiline
                placeholder="讲的是什么、玩法是什么样的"
                @commit="save({ description: $event })"
              />
            </section>

            <section v-if="report" class="panel project-record" aria-label="精修工作记录">
              <div class="project-record__head">
                <h2 class="sec-title">精修工作记录</h2>
                <button type="button" class="btn btn--ghost" @click="readReport">阅读完整精修记录</button>
              </div>
              <details class="project-record__details">
                <summary>展开工作摘要与历史说明</summary>
                <div class="project-record__sections">
                  <p v-for="(section, i) in projectSections" :key="i">{{ section }}</p>
                  <p v-if="!projectSections.length">完整工作内容与验证范围见精修记录。</p>
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
              v-if="activeTab === 'guide'"
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
.path-warning {
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
