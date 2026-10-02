<script setup lang="ts">
/**
 * 游戏详情页。
 *
 * 和软件详情页的分工不同：软件那页的重心是「我为什么留着它」（为什么选它 /
 * 使用场景 / 淘汰的同类），游戏这页的重心是「它在磁盘上的哪些地方」——
 * 主程序、存档、关联文件。存档那一块尤其要能看能改：Step 5 的备份直接吃它，
 * 识别时模型漏了或者认错了，用户得有地方纠正，而不是等备份备了个空目录。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import DetailTabs from '@/components/ui/DetailTabs.vue'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BadgeCheck,
  ExternalLink,
  FilePlus,
  FolderOpen,
  FolderPlus,
  HardDriveDownload,
  History,
  Image,
  ImageOff,
  Link2,
  Loader2,
  Play,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Unlink,
  X
} from 'lucide-vue-next'
import EditableField from '@/components/ui/EditableField.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import { useToast } from '@/composables/useToast'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { PLAY_STATUS_LABEL, useGameStore } from '@/stores/game'
import { useSettingsStore } from '@/stores/settings'
import type {
  CoverCandidate,
  GameCoverDiagnostic,
  GameItem,
  LinkedFile,
  PlayStatus,
  SaveBackup,
  SavePath
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
  LINK_TYPE_LABEL
} from '@/utils'

const props = defineProps<{ id: string }>()

const router = useRouter()
const route = useRoute()
const detailTabs = [{"id":"overview","label":"简介"},{"id":"saves","label":"存档与备份"},{"id":"files","label":"文件与封面"},{"id":"notes","label":"笔记"}]
const activeTab = ref(detailTabs.some(tab=>tab.id===route.query.tab) ? String(route.query.tab) : 'overview')
watch(activeTab, tab=>{ void router.replace({query:{...route.query,tab}}) })
watch(()=>route.query.tab,tab=>{activeTab.value=detailTabs.some(t=>t.id===tab)?String(tab):'overview'})
watch(()=>props.id,()=>{activeTab.value='overview'})
const store = useGameStore()
const settings = useSettingsStore()
const { success, error, toast } = useToast()
const tasks = useTaskCenter()

const item = ref<GameItem | null>(null)
const loading = ref(true)
const relocating = ref(false)
async function relocate(mode: 'directory' | 'file' = 'directory') {
  relocating.value = true
  try { const updated = await window.baoyi.game.relocate(props.id, mode); if (updated) {item.value = updated; await store.reload(); success('路径已更新，游玩记录与存档信息已保留')} }
  catch (cause) {error(errorMessage(cause))}
  finally {relocating.value = false}
}
let loadSequence = 0
let coverSearchSequence = 0
let coverChoiceSequence = 0

const STATUSES: PlayStatus[] = ['unplayed', 'playing', 'completed', 'shelved']

async function load(): Promise<void> {
  const sequence = ++loadSequence
  const selectedId = props.id
  closeCoverHits()
  coverChoiceSequence++
  coverPicking.value = ''
  loading.value = true
  try {
    const result = await window.baoyi.game.get(selectedId)
    if (sequence === loadSequence) item.value = result
  } catch (err) {
    if (sequence !== loadSequence) return
    error(`读取游戏失败：${errorMessage(err)}`)
    item.value = null
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function loadAll(): Promise<void> {
  await load()
  await loadBackups()
}

onMounted(loadAll)
watch(() => props.id, loadAll)

const title = computed(() => (item.value ? gameTitle(item.value) : ''))
const initial = computed(() => title.value.trim().charAt(0).toUpperCase() || '?')

const hue = computed(() => {
  let h = 0
  for (const ch of title.value) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
})

/* ---------------------------- 封面 ---------------------------- */

/** 同 GameCard：走 baoyi://cover/，updated_at 当版本号破缓存 */
const cover = computed(() =>
  item.value ? coverUrl(item.value.cover_path, item.value.updated_at) : ''
)
const brokenCover = ref(false)
const landscapeCover = ref(false)
watch(cover, () => { brokenCover.value = false; landscapeCover.value = false })
function coverLoaded(event: Event): void {
  const image = event.target as HTMLImageElement
  landscapeCover.value = image.naturalWidth > image.naturalHeight
}

/**
 * 换封面。主进程把图拷进 userData 再落库，所以这里拿回来的条目是最终形态，
 * 不用自己再 load 一次。
 *
 * 和「搜封面」并列：搜不到、连不上、或者搜出来的都不满意时，这条路一定走得通。
 * 所以搜索失败的提示里总是指回这里，不让用户卡在一个只会失败的按钮上。
 */
async function pickCover(): Promise<void> {
  if (!item.value) return
  const selectedId = item.value.id
  const sequence = ++coverChoiceSequence
  closeCoverHits()
  coverPicking.value = ''
  try {
    const r = await window.baoyi.game.pickCover(selectedId)
    if (r?.ok) void store.load()
    if (!r || item.value?.id !== selectedId || sequence !== coverChoiceSequence) return
    if (!r.ok) { coverMiss.value = r.message; error(r.message); return }
    if (r.item) item.value = r.item
    success(r.message)
  } catch (err) {
    if (sequence === coverChoiceSequence && item.value?.id === selectedId) {
      coverMiss.value = `更换封面失败：${errorMessage(err)}`
      error(coverMiss.value)
    }
  }
}

async function clearCover(): Promise<void> {
  if (!item.value?.cover_path) return
  if (!window.confirm('撤掉这张封面？\n\n会退回首字占位。你原来那张图不受影响，删掉的是抱一自己存的那份拷贝。')) {
    return
  }
  const selectedId = item.value.id
  const sequence = ++coverChoiceSequence
  closeCoverHits()
  coverPicking.value = ''
  try {
    const updated = await window.baoyi.game.clearCover(selectedId)
    if (updated && item.value?.id === selectedId && sequence === coverChoiceSequence) item.value = updated
    void store.load()
  } catch (err) {
    if (sequence === coverChoiceSequence) error(`移除封面失败：${errorMessage(err)}`)
  }
}

/* ---------------------------- 搜封面 ---------------------------- */

const coverSearching = ref(false)
const coverPicking = ref('')
const coverHits = ref<CoverCandidate[]>([])
const coverQuery = ref('')
const coverDiagnostics = ref<GameCoverDiagnostic[]>([])
const brokenPreviews = ref(new Set<string>())
const COVER_SOURCE_LABEL = { local: '本地图片', official: '官方', steam: 'Steam', search: '图片搜索' }
const COVER_STAGE_LABEL = { identity: '身份', lookup: '查找', network: '网络', decode: '解码', cache: '缓存', write: '保存' }
/** 搜过一轮但一张都没有时显示的那句话。跟 toast 分开 —— 面板里要一直看得见 */
const coverMiss = ref('')

async function searchCovers(): Promise<void> {
  activeTab.value = 'files'
  if (!item.value || coverSearching.value) return
  const selectedId = item.value.id
  const sequence = ++coverSearchSequence
  coverSearching.value = true
  coverMiss.value = ''
  coverHits.value = []
  coverDiagnostics.value = []
  brokenPreviews.value = new Set()
  const taskId = tasks.start('game-scan', `查找游戏封面：${title.value}`, { total: 1, current: title.value })
  try {
    const r = await window.baoyi.game.searchCovers(selectedId)
    for (const diagnostic of r.diagnostics || []) tasks.log(taskId, diagnostic.status === 'failed' ? 'warn' : 'info', `${COVER_SOURCE_LABEL[diagnostic.source]} · ${COVER_STAGE_LABEL[diagnostic.stage]}：${diagnostic.message}`)
    tasks.update(taskId, { processed: 1, percent: 100 })
    tasks.finish(taskId, r.ok ? 'success' : 'failed', r.ok ? `找到 ${r.candidates.filter(candidate => candidate.status === 'ready').length} 张可用封面` : r.message)
    if (item.value?.id !== selectedId || sequence !== coverSearchSequence) return
    coverQuery.value = r.query
    coverHits.value = r.candidates
    coverDiagnostics.value = r.diagnostics || []
    if (!r.ok) {
      // 搜不到不是异常，是一个要说清原因的正常结果 —— 面板里留着，
      // 用户才看得到「改个名字再搜」或者「手动选一张」这两条下一步
      coverMiss.value = r.message
      return
    }
    if (r.message) toast(r.message)
  } catch (err: any) {
    tasks.finish(taskId, 'failed', `搜索出错：${err?.message ?? '未知错误'}`)
    if (sequence === coverSearchSequence && item.value?.id === selectedId) coverMiss.value = `搜索出错：${err?.message ?? '未知错误'}`
  } finally {
    if (sequence === coverSearchSequence) coverSearching.value = false
  }
}

async function useCover(url: string): Promise<void> {
  if (!item.value || coverPicking.value || brokenPreviews.value.has(url) || coverHits.value.find(c => c.url === url)?.status === 'failed') return
  const selectedId = item.value.id
  const sequence = ++coverChoiceSequence
  coverPicking.value = url
  const taskId = tasks.start('game-scan', `设置游戏封面：${title.value}`, { total: 1, current: title.value })
  try {
    const r = await window.baoyi.game.setCoverFromUrl(selectedId, url)
    tasks.update(taskId, { processed: 1, percent: 100 })
    tasks.finish(taskId, r.ok ? 'success' : 'failed', r.message || (r.ok ? '封面已设置' : '设置封面失败'))
    if (r.ok) void store.load()
    if (item.value?.id !== selectedId || sequence !== coverChoiceSequence) return
    if (!r.ok) {
      coverMiss.value = r.message
      error(r.message)
      return
    }
    if (r.item) item.value = r.item
    closeCoverHits()
    success(r.message)
  } catch (err) {
    tasks.finish(taskId, 'failed', `设置封面失败：${errorMessage(err)}`)
    if (sequence === coverChoiceSequence && item.value?.id === selectedId) {
      coverMiss.value = `设置封面失败：${errorMessage(err)}`
      error(coverMiss.value)
    }
  } finally {
    if (sequence === coverChoiceSequence) coverPicking.value = ''
  }
}

async function recoverCover(): Promise<void> {
  if (!item.value || coverPicking.value) return
  const selectedId = item.value.id
  const sequence = ++coverChoiceSequence
  closeCoverHits()
  coverPicking.value = 'recover'
  const taskId = tasks.start('game-scan', `恢复游戏封面：${title.value}`, { total: 1, current: title.value })
  try {
    const result = await window.baoyi.game.rebuildCovers([selectedId])
    const message = result.failed ? '封面恢复失败，可重试搜索或选择本地图' : result.updated ? '封面已恢复' : '封面未更改，已保留当前选择'
    tasks.update(taskId, { processed: result.processed, total: result.processed, percent: 100 })
    tasks.finish(taskId, result.failed ? 'failed' : 'success', message)
    const updated = await window.baoyi.game.get(selectedId)
    void store.load()
    if (sequence !== coverChoiceSequence || item.value?.id !== selectedId) return
    if (updated) item.value = updated
    coverMiss.value = result.failed ? (updated?.cover_detail || message) : ''
    if (result.updated) { brokenCover.value = false; success(message) }
  } catch (err) {
    const message = `恢复封面失败：${errorMessage(err)}`
    tasks.finish(taskId, 'failed', message)
    if (sequence === coverChoiceSequence && item.value?.id === selectedId) coverMiss.value = message
  } finally {
    if (sequence === coverChoiceSequence) coverPicking.value = ''
  }
}

function previewFailed(candidate: CoverCandidate): void {
  const next = new Set(brokenPreviews.value)
  next.add(candidate.url)
  brokenPreviews.value = next
  coverDiagnostics.value.push({ source: candidate.source, stage: 'cache', status: 'failed', message: '本地预览无法显示，请重新搜索封面', route: 'baoyi 本地预览', url: candidate.url })
}

function closeCoverHits(): void {
  coverSearchSequence++
  coverSearching.value = false
  coverHits.value = []
  coverMiss.value = ''
  coverQuery.value = ''
  coverDiagnostics.value = []
}

onBeforeUnmount(() => { loadSequence++; coverChoiceSequence++; closeCoverHits() })

/** 走 store 而不是直接调 IPC：卡片墙和侧边栏计数要跟着一起更新 */
async function save(patch: Partial<GameItem>): Promise<void> {
  if (!item.value) return
  const selectedId = item.value.id
  if (Object.keys(patch).some(key => key.startsWith('identity_') || key === 'name_zh' || key === 'name_en')) {
    closeCoverHits()
    coverChoiceSequence++
    coverPicking.value = ''
  }
  try {
    const updated = await store.update(selectedId, patch)
    if (updated && item.value?.id === selectedId) item.value = updated
  } catch (err) {
    error(`保存失败：${errorMessage(err)}`)
  }
}

function commitTags(raw: string): void {
  // 中英文逗号、顿号都认 —— 用户不该为了分隔符去猜我们想要哪一个
  const tags = [...new Set(raw.split(/[,，、]/).map((t) => t.trim()).filter(Boolean))].slice(0, 8)
  void save({ tags })
}

/* ---------------------------- 存档路径 ---------------------------- */

function removeSavePath(path: string): void {
  if (!item.value) return
  void save({ save_paths: item.value.save_paths.filter((s) => s.path !== path) })
}

/**
 * 加一条存档路径：选目录 → 主进程当场探测 → 落库。
 *
 * 空目录不直接拒绝，问一句就收下 —— 「存在但一个文件都没有」是个有意义的
 * 中间状态：游戏还没存过档，路径本身完全可能是对的。备份那一层照样会拒绝
 * 空目录，所以收下它不会导致「备份了一个空文件夹」那个后果。
 */
async function addSavePath(): Promise<void> {
  if (!item.value) return
  const check = await window.baoyi.game.pickSavePath()
  if (!check) return

  const already = item.value.save_paths.some(
    (s) => s.path.toLowerCase() === check.path.toLowerCase()
  )
  if (already) {
    toast('这条路径已经记下了')
    return
  }

  if (!check.exists) {
    error(`这个目录读不到：${check.path}`)
    return
  }
  if (check.files === 0) {
    const ok = window.confirm(
      `${check.path}\n\n这个目录现在一个文件都没有。` +
        `如果游戏还没存过档，路径可能是对的，记下来没问题；` +
        `但在它真的有存档之前，备份会拒绝执行。\n\n仍然记下这条路径吗？`
    )
    if (!ok) return
  }

  // verified_at 只在「确实看到文件」时才盖章，和 tools.ts 的 acceptSavePaths 同一个标准
  const next: SavePath[] = [
    ...item.value.save_paths,
    { path: check.path, verified_at: check.files > 0 ? Date.now() : 0 }
  ]
  await save({ save_paths: next })
  success(check.files > 0 ? `已记下，看到 ${check.files} 个文件` : '已记下这条路径')
}

const verifying = ref('')

/**
 * 这条路径在开库那次体检里是不是没找到。
 *
 * 名单是进库时算的一份快照，不会自己更新 —— 所以手动验过之后要把它撤掉（见下），
 * 否则用户明明验成功了，标签还挂着「路径失效」，那就成了一句不成立的话。
 */
function isStale(target: string): boolean {
  return (store.staleSaves.get(props.id) ?? []).includes(target)
}

/** 重新验一条。主进程验过了会自己把 verified_at 往前推，这里只负责把话说清楚 */
async function verifySavePath(target: string): Promise<void> {
  if (!item.value) return
  verifying.value = target
  try {
    const check = await window.baoyi.game.verifySavePath(item.value.id, target)
    if (!check.exists) {
      error('这个目录已经不在了。存档可能被挪走了，或者游戏卸载过')
    } else if (check.files === 0) {
      toast('目录还在，但里面一个文件都没有')
    } else {
      success(`还在，${check.files} 个文件，共 ${formatBytes(check.bytes)}`)
      // 验到了就撤掉失效标记。撤的是整条游戏的记录而不是这一条路径：
      // 一个游戏通常只有一两条存档路径，为了精确到单条去改数组不值得
      store.clearStale(props.id)
      await load()
    }
  } catch (err) {
    error(`验证失败：${errorMessage(err)}`)
  } finally {
    verifying.value = ''
  }
}

/* ---------------------------- 存档备份 ---------------------------- */

const backups = ref<SaveBackup[]>([])
/** 正在备份的那条存档路径，同时用来禁按钮 */
const backingUp = ref('')
const restoring = ref('')

async function loadBackups(): Promise<void> {
  if (!item.value) {
    backups.value = []
    return
  }
  try {
    backups.value = await window.baoyi.game.backups(item.value.id)
  } catch (err) {
    error(`读取备份列表失败：${errorMessage(err)}`)
  }
}

/**
 * 备份一条存档路径。
 *
 * 不给进度条：存档通常是几 MB，复制在一眨眼之间。按钮转起来 + 完成时一句话
 * 就够了，为它铺一条进度通道属于空转。真遇到几个 GB 的（RPG Maker 带截图、
 * 模拟器即时存档），转圈也不会让人以为界面死了。
 */
async function backupSave(target: string): Promise<void> {
  if (!item.value) return
  backingUp.value = target
  try {
    const r = await window.baoyi.game.backupSave(item.value.id, target)
    if (!r.ok) {
      error(r.message)
      return
    }
    await loadBackups()
    success(`${r.message}，共 ${formatBytes(r.backup?.size_bytes ?? 0)}`)
    await pruneOver(r.over)
  } catch (err) {
    error(`备份没能跑起来：${errorMessage(err)}`)
  } finally {
    backingUp.value = ''
  }
}

/**
 * 超出保留上限时问一句，问完才删。
 *
 * 主进程只**算出**哪几份超额，删不删在这里问 —— 备份的意义就是「我改主意时还
 * 有退路」，让程序自己决定哪份退路可以扔掉，等于把这个意义抽掉一半。所以文案里
 * 逐条列出时间和体量，用户拿这些才判断得出「最早那份是不是恰好是我想留的通关存档」。
 * 拒绝也不算失败：上限只是提醒的阈值，不是必须清到的水位。
 */
async function pruneOver(over: SaveBackup[]): Promise<void> {
  if (over.length === 0) return
  const lines = over
    .map((b) => `　· ${formatDateTime(b.created_at)}　${formatBytes(b.size_bytes)}`)
    .join('\n')
  const ok = window.confirm(
    `这条存档的备份超过了保留上限（${settings.settings.save_backup_keep} 份）。\n\n` +
      `删掉最早的 ${over.length} 份？\n${lines}\n\n` +
      `磁盘上的拷贝会被删掉，删了就找不回来了。\n` +
      `不删也没关系，下次备份还会再问一次；不想再被问可以在设置里把上限改成 0。`
  )
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
  await loadBackups()
  if (done > 0) success(`已清理 ${done} 份旧备份`)
  // 一条条报会刷屏，但也不能只说「部分失败」——第一条原因通常就是全部原因
  if (failed.length > 0) error(`${failed.length} 份没删掉：${failed[0]}`)
}

/**
 * 还原一份备份。
 *
 * 确认文案里要写明「当前存档会先自动备份一份」—— 那是这个操作敢做的全部理由，
 * 用户看到它才知道点下去不是一条单行道。
 */
async function restore(b: SaveBackup): Promise<void> {
  const when = formatDateTime(b.created_at)
  const ok = window.confirm(
    `用「${when}」这份备份覆盖当前存档？\n\n` +
      `目标：${b.save_path}\n` +
      `这份备份：${b.file_count} 个文件，${formatBytes(b.size_bytes)}\n\n` +
      `当前存档会先自动备份一份，还原错了可以再还原回来。\n` +
      `游戏正在运行时请先关掉它，否则文件会被占用。`
  )
  if (!ok) return

  restoring.value = b.id
  try {
    const r = await window.baoyi.game.restoreBackup(b.id)
    await loadBackups()
    if (r.ok) success(r.message)
    else error(r.message)
  } catch (err) {
    error(`还原没能跑起来：${errorMessage(err)}`)
  } finally {
    restoring.value = ''
  }
}

async function dropBackup(b: SaveBackup): Promise<void> {
  const ok = window.confirm(
    `删除「${formatDateTime(b.created_at)}」这份备份？\n\n` +
      `${b.backup_dir}\n\n磁盘上的这份拷贝会被删掉，删了就找不回来了。`
  )
  if (!ok) return
  try {
    const r = await window.baoyi.game.deleteBackup(b.id)
    await loadBackups()
    if (r.ok) success(r.message)
    else error(r.message)
  } catch (err) {
    error(`删除失败：${errorMessage(err)}`)
  }
}

const openBackup = (b: SaveBackup): Promise<void> => window.baoyi.game.openBackup(b.id)

/* ---------------------------- 关联文件 ---------------------------- */

/**
 * 关联文件：攻略、修改器、MOD 目录、模拟器。
 *
 * 识别时 agent 会往里填游戏目录内的那些，这里补的是用户自己管的那一半 ——
 * 而用户的攻略十有八九**不在**游戏目录里（`D:\资料\攻略`），所以加的时候走的是
 * 另一道边界（见 service.ts 的 addGameLinks），不受识别沙箱约束。
 */
const LINK_TYPES: Array<LinkedFile['type']> = ['guide', 'trainer', 'mod', 'emulator', 'other']

async function addLinks(kind: 'file' | 'dir'): Promise<void> {
  if (!item.value) return
  try {
    const updated = await window.baoyi.game.pickLinks(item.value.id, kind)
    if (!updated) return
    const before = item.value.linked_files.length
    item.value = updated
    const added = updated.linked_files.length - before
    // 一条没加上通常是「选中的这些已经在名单里了」，说清楚比静默好
    if (added > 0) success(`已关联 ${added} 个${kind === 'dir' ? '文件夹' : '文件'}`)
    else toast('这些已经在关联列表里了')
  } catch (err) {
    error(`关联失败：${errorMessage(err)}`)
  }
}

/** 打开一条。打不开的类型（没有关联程序）由主进程把系统那句话原样带回来 */
async function openLink(f: LinkedFile): Promise<void> {
  if (!item.value) return
  const r = await window.baoyi.game.openLink(item.value.id, f.path)
  if (!r.ok) error(r.message)
}

async function revealLink(f: LinkedFile): Promise<void> {
  if (!item.value) return
  const r = await window.baoyi.game.revealLink(item.value.id, f.path)
  if (!r.ok) error(r.message)
}

/** 只解除关联，不动磁盘上的文件 —— 那是用户自己的东西，我们没有删它的道理 */
function removeLink(f: LinkedFile): void {
  if (!item.value) return
  void save({ linked_files: item.value.linked_files.filter((x) => x.path !== f.path) })
}

function relabelLink(f: LinkedFile, raw: string): void {
  if (!item.value) return
  const label = raw.trim().slice(0, 20) || f.path.split(/[\\/]/).pop() || f.label
  if (label === f.label) return
  void save({
    linked_files: item.value.linked_files.map((x) => (x.path === f.path ? { ...x, label } : x))
  })
}

function retypeLink(f: LinkedFile, type: LinkedFile['type']): void {
  if (!item.value) return
  void save({
    linked_files: item.value.linked_files.map((x) => (x.path === f.path ? { ...x, type } : x))
  })
}

function toggleArchive(): void {
  if (!item.value) return
  void save({ is_archived: !item.value.is_archived })
}

/* ---------------------------- 启动与时长 ---------------------------- */

/**
 * 这个游戏此刻在不在跑。向主进程问，而不是自己记一个 ——
 * 从详情页退出去再进来，页面状态没了，但游戏还在跑。
 */
const running = ref(false)

async function refreshRunning(): Promise<void> {
  if (!item.value) return
  running.value = await window.baoyi.game.running(item.value.id)
}

async function launch(): Promise<void> {
  if (!item.value) return
  const r = await window.baoyi.game.launch(item.value.id)
  if (!r.ok) {
    error(r.message)
    return
  }
  toast(r.message)
  await refreshRunning()
}

/**
 * 一段游玩结束。
 *
 * 只处理这一页正在看的那个游戏 —— 事件是广播的，别的游戏结束了不该让这一页刷新。
 * 时长和状态都在主进程写完了，这里重读一次而不是自己算：算重了就是两份账。
 */
let offSession: (() => void) | null = null
onMounted(() => {
  // 失效名单平时是开库时算的，但直接落在详情页上（模块记忆恢复的路径、或者从
  // 别处跳进来）时封面墙的 onMounted 没跑过 —— 真机上验出来就是这个：路径明明
  // 不在了，这一页还挂着「2026-08-28 验证过」。所以没跑过就自己补一次。
  if (!store.staleChecked) void store.checkSavePaths()

  offSession = window.baoyi.game.onSession((e) => {
    if (e.id !== props.id) return
    running.value = false
    void load()
    // 没计入的那次要说明白为什么，所以用 toast 而不是 success —— 它不是一件成事
    if (e.counted) success(e.message)
    else toast(e.message)
    if (e.status_changed) toast(`状态跟着改成了「${PLAY_STATUS_LABEL[e.play_status]}」`)
  })
  void refreshRunning()
})
onBeforeUnmount(() => offSession?.())

async function reveal(): Promise<void> {
  if (!item.value) return
  await window.baoyi.game.revealInFolder(item.value.id)
}

function openOfficial(): void {
  if (item.value?.official_url) window.open(item.value.official_url, '_blank')
}

async function removeItem(): Promise<void> {
  if (!item.value) return
  if (!window.confirm(`确定把「${title.value}」从库里移除吗？\n磁盘上的游戏文件和已有的存档备份都不会被删。`)) {
    return
  }
  await store.remove(item.value.id)
  success('已从库里移除')
  void router.push({ name: 'game-home' })
}

function copyPath(path: string): void {
  void window.baoyi.app.copyText(path)
  toast('路径已复制')
}
</script>

<template>
  <div class="detail">
    <div v-if="loading" class="detail__state">载入中…</div>
    <div v-else-if="!item" class="detail__state">
      <p>这条记录不存在或已被移除。</p>
      <button class="btn btn--ghost" @click="router.push({ name: 'game-home' })">返回封面墙</button>
    </div>

    <template v-else>
      <header class="head">
        <button class="btn btn--subtle" @click="router.back()">
          <ArrowLeft :size="16" />
          返回
        </button>

        <div class="head__actions">
          <!-- 启动放在第一个、用主色：详情页上其他都是管理动作，只有这个是「去玩」 -->
          <button class="btn btn--primary" :disabled="running" @click="launch">
            <component :is="running ? Loader2 : Play" :size="14" :class="{ spin: running }" />
            {{ running ? '正在运行' : '启动' }}
          </button>
          <button class="btn btn--ghost" @click="reveal">
            <FolderOpen :size="14" />
            打开所在文件夹
          </button>
          <button
            class="btn btn--ghost"
            :disabled="!item.official_url"
            :title="item.official_url || '暂无官网'"
            @click="openOfficial"
          >
            <ExternalLink :size="14" />
            官网
          </button>
          <button class="btn btn--ghost" @click="toggleArchive">
            <component :is="item.is_archived ? ArchiveRestore : Archive" :size="14" />
            {{ item.is_archived ? '取消归档' : '归档' }}
          </button>
          <button class="btn btn--danger" @click="removeItem">
            <Trash2 :size="14" />
            移除
          </button>
        </div>
      </header>

      <div v-if="item.path_state && item.path_state !== 'present'" class="path-warning" role="alert">{{item.path_state==='offline'?'游戏所在磁盘离线，请先连接磁盘。':'主程序已找不到，可能是文件夹改名或移动。'}}<button class="btn btn--primary" :disabled="relocating" @click="relocate()">重新定位文件夹</button></div>

      <div class="body detail-body">
<section class="hero panel">
            <!--
              封面本身就是那几个按钮的入口，藏在别处等于没有。
              悬停才显形，不占静态视觉重量。「搜封面」排在最前 —— 它是不用离开
              应用就能完成的那条路，手动选图要开系统对话框
            -->
            <div class="hero__cover" :class="{ 'hero__cover--landscape': landscapeCover }" :style="{ '--hue': hue }">
              <img v-if="cover && !brokenCover" :src="cover" :alt="title" class="hero__img" @load="coverLoaded" @error="brokenCover = true" />
              <span v-else class="hero__initial">{{ initial }}</span>

              <div class="hero__coverActs">
                <button
                  class="hero__coverBtn"
                  :disabled="coverSearching"
                  title="先检查本地图片，再按封面关键词搜索"
                  @click="searchCovers"
                >
                  <Loader2 v-if="coverSearching" :size="13" class="spin" />
                  <Search v-else :size="13" />
                  {{ coverSearching ? '搜索中' : '搜封面' }}
                </button>
                <button class="hero__coverBtn" :title="item.cover_path ? '换一张封面' : '选一张封面图'" @click="pickCover">
                  <Image :size="13" />
                  {{ item.cover_path ? '换封面' : '加封面' }}
                </button>
                <button v-if="item.cover_path" class="hero__coverBtn" title="撤掉封面，退回首字占位" @click="clearCover">
                  <ImageOff :size="13" />
                </button>
              </div>
            </div>

            <div class="hero__text">
              <input
                class="hero__name"
                :value="item.name_zh"
                placeholder="游戏名"
                @change="save({ name_zh: ($event.target as HTMLInputElement).value.trim() })"
              />
              <input
                class="hero__en"
                :value="item.name_en"
                placeholder="原名 / 英文名"
                @change="save({ name_en: ($event.target as HTMLInputElement).value.trim() })"
              />
              <input
                class="hero__summary"
                :value="item.summary"
                placeholder="一句话说明"
                @change="save({ summary: ($event.target as HTMLInputElement).value.trim() })"
              />

              <div class="identity-row">
                <label class="identity-row__label" for="game-identity">游戏身份</label>
                <input
                  id="game-identity"
                  class="identity-row__input"
                  :value="item.identity_name || item.name_en || item.name_zh"
                  placeholder="确认游戏身份"
                  @change="save({ identity_name: ($event.target as HTMLInputElement).value.trim() })"
                />
                <label class="identity-row__confirm">
                  <input
                    type="checkbox"
                    :checked="item.identity_confirmed"
                    @change="save({ identity_confirmed: ($event.target as HTMLInputElement).checked })"
                  />
                  已确认
                </label>
              </div>
              <div class="identity-row">
                <label class="identity-row__label" for="game-cover-query">封面关键词</label>
                <input
                  id="game-cover-query"
                  class="identity-row__query"
                  :value="item.identity_query"
                  :placeholder="item.identity_name || item.name_en || item.name_zh || '填写实际游戏名称'"
                  title="单独用于查找封面；留空时使用游戏身份和名称"
                  @change="save({ identity_query: ($event.target as HTMLInputElement).value.trim() })"
                />
              </div>
              <p class="identity-row__hint">封面关键词可单独调整。启动入口：{{ item.file_name }}。</p>
              <p v-if="!item.identity_confirmed" class="identity-row__hint">请确认实际游戏身份，通用启动器名称需要补充游戏信息。</p>
              <div v-if="brokenCover || (!item.cover_path && item.cover_source_url)" class="cover-recovery">
                <span>封面缓存不可用，可从上次来源恢复。</span>
                <button class="btn btn--ghost" :disabled="!!coverPicking" @click="recoverCover">{{ coverPicking === 'recover' ? '恢复中' : '恢复封面' }}</button>
              </div>

              <div class="statuses">
                <button
                  v-for="s in STATUSES"
                  :key="s"
                  class="chip"
                  :class="{ on: item.play_status === s }"
                  @click="save({ play_status: s })"
                >
                  {{ PLAY_STATUS_LABEL[s] }}
                </button>
              </div>
            </div>
          </section>
<DetailTabs v-model="activeTab" :tabs="detailTabs" prefix="game" label="游戏详情"/>
<div id="game-panel-overview" v-show="activeTab === 'overview'" role="tabpanel" aria-labelledby="game-tab-overview" tabindex="0" class="detail-panel detail-panel--overview">
<section class="panel">
            <h2 class="sec-title">简介</h2>
            <EditableField
              :model-value="item.description"
              multiline
              placeholder="讲的是什么、玩法是什么样的"
              @commit="save({ description: $event })"
            />
          </section>
<section class="panel">
            <h2 class="sec-title">分类</h2>
            <input
              class="input"
              :value="item.category"
              placeholder="RPG / 动作 / 策略…"
              @change="save({ category: ($event.target as HTMLInputElement).value.trim() })"
            />
          </section>
<section class="panel">
            <h2 class="sec-title">标签</h2>
            <div v-if="item.tags.length > 0" class="tags">
              <TagBadge v-for="t in item.tags" :key="t" :label="t" />
            </div>
            <EditableField
              :model-value="item.tags.join('、')"
              placeholder="用「、」隔开，最多 8 个"
              @commit="commitTags"
            />
          </section>
<section class="panel">
            <h2 class="sec-title">游玩</h2>
            <dl class="facts">
              <dt>时长</dt>
              <dd>{{ formatPlaytime(item.total_playtime_sec) }}</dd>
              <dt>上次游玩</dt>
              <dd>{{ item.last_played_at ? formatRelative(item.last_played_at) : '未玩过' }}</dd>
              <dt>加入</dt>
              <dd>{{ formatDate(item.created_at) }}</dd>
            </dl>
          </section>
</div>
<div id="game-panel-saves" v-show="activeTab === 'saves'" role="tabpanel" aria-labelledby="game-tab-saves" tabindex="0" class="detail-panel detail-panel--saves">
<section class="panel">
            <h2 class="sec-title">
              <HardDriveDownload :size="14" />
              存档位置
              <button class="sec-title__act" @click="addSavePath">
                <FolderPlus :size="13" />
                添加
              </button>
            </h2>

            <ul v-if="item.save_paths.length > 0" class="paths">
              <li v-for="s in item.save_paths" :key="s.path" class="path">
                <button class="path__text mono truncate" :title="`${s.path}（点击复制）`" @click="copyPath(s.path)">
                  {{ s.path }}
                </button>
                <!-- 失效盖过验证时间：那个时间戳说的是过去某一刻它在，
                     而这条说的是现在它不在，后者是用户此刻要知道的那句 -->
                <span v-if="isStale(s.path)" class="path__note path__note--stale" title="开库时检查发现这个位置不存在了。可能是移动或卸载了游戏，也可能是所在的盘没接上">
                  <Unlink :size="11" />
                  路径失效
                </span>
                <span v-else class="path__note">
                  {{ s.verified_at ? `${formatDate(s.verified_at)} 验证过` : '未验证' }}
                </span>
                <button
                  class="path__act"
                  title="重新看一眼它还在不在"
                  :disabled="verifying === s.path"
                  @click="verifySavePath(s.path)"
                >
                  <component :is="verifying === s.path ? Loader2 : BadgeCheck" :size="13" :class="{ spin: verifying === s.path }" />
                </button>
                <!-- 一条存档路径可能是目录也可能是单个 .sav，文案不能替它认定形状 -->
                <button
                  class="path__act"
                  title="现在备份这份存档"
                  :disabled="backingUp === s.path"
                  @click="backupSave(s.path)"
                >
                  <component :is="backingUp === s.path ? Loader2 : Save" :size="13" :class="{ spin: backingUp === s.path }" />
                </button>
                <button class="path__del" title="这条不对，删掉" @click="removeSavePath(s.path)">
                  <Trash2 :size="13" />
                </button>
              </li>
            </ul>
            <p v-else class="hint">
              识别时没能找到存档目录。点「添加」指一个 —— 选完会当场看一眼里面有什么，
              确认是存档再记下来。有了它才谈得上备份。
            </p>
            <p v-if="item.save_paths.length > 0" class="hint">
              备份放在设置 › 数据管理里指定的目录，一次备一份，不会覆盖上一份。
              超过那里设的保留上限时会问一句要不要清掉最早的几份。
            </p>
          </section>
<section v-if="backups.length > 0" class="panel">
            <h2 class="sec-title">
              <History :size="14" />
              存档备份
              <span class="sec-title__count">{{ backups.length }}</span>
            </h2>
            <ul class="backups">
              <li v-for="b in backups" :key="b.id" class="backup">
                <div class="backup__main">
                  <button
                    class="backup__when"
                    :title="`${b.backup_dir}（点击在资源管理器里打开）`"
                    @click="openBackup(b)"
                  >
                    {{ formatDateTime(b.created_at) }}
                  </button>
                  <span class="backup__meta">
                    {{ b.file_count }} 个文件　{{ formatBytes(b.size_bytes) }}
                  </span>
                  <span class="backup__from mono truncate" :title="b.save_path">{{ b.save_path }}</span>
                </div>
                <div class="backup__acts">
                  <button
                    class="btn btn--ghost btn--tiny"
                    :disabled="restoring === b.id"
                    @click="restore(b)"
                  >
                    <component :is="restoring === b.id ? Loader2 : RotateCcw" :size="13" :class="{ spin: restoring === b.id }" />
                    还原
                  </button>
                  <button class="path__del" title="删掉这份备份" @click="dropBackup(b)">
                    <Trash2 :size="13" />
                  </button>
                </div>
              </li>
            </ul>
          </section>
</div>
<div id="game-panel-files" v-show="activeTab === 'files'" role="tabpanel" aria-labelledby="game-tab-files" tabindex="0" class="detail-panel detail-panel--files">
<section v-if="coverHits.length > 0 || coverMiss || coverDiagnostics.length" class="panel">
            <h2 class="sec-title">
              <Image :size="14" />
              候选封面
              <span v-if="coverQuery" class="sec-title__note">按「{{ coverQuery }}」搜的</span>
              <button class="sec-title__act" title="收起" @click="closeCoverHits">
                <X :size="13" />
                收起
              </button>
            </h2>

            <p v-if="coverMiss" class="hint">
              {{ coverMiss }}
            </p>

            <div v-if="coverHits.length > 0" class="covers">
              <button
                v-for="c in coverHits"
                :key="c.url"
                class="coverPick"
                :class="{ 'coverPick--busy': coverPicking === c.url, 'coverPick--failed': c.status === 'failed' || brokenPreviews.has(c.url) }"
                :style="{ '--candidate-ratio': c.width && c.height ? `${c.width} / ${c.height}` : '2 / 3' }"
                :disabled="!!coverPicking || c.status === 'failed' || brokenPreviews.has(c.url)"
                :title="`${c.title || c.label}\n${c.message || c.label}\n${c.route || ''}\n${c.url}`"
                @click="useCover(c.url)"
              >
                <!-- 预览图已经由主进程缓存到 baoyi://，CSP 只允许 self/data/baoyi。 -->
                <img
                  v-if="c.preview_url && !brokenPreviews.has(c.url)"
                  :src="c.preview_url"
                  :alt="c.label"
                  class="coverPick__img"
                  @error="previewFailed(c)"
                />
                <span v-else class="coverPick__placeholder" role="img" :aria-label="`${c.label}预览不可用`">
                  <ImageOff :size="20" />
                  <small>预览不可用</small>
                </span>
                <span class="coverPick__label">{{ c.title || c.label }}</span>
                <span class="coverPick__meta">{{ COVER_SOURCE_LABEL[c.source] }} · {{ c.status === 'failed' || brokenPreviews.has(c.url) ? '不可用' : '可用' }}</span>
                <span v-if="c.width && c.height" class="coverPick__meta">{{ c.width }} × {{ c.height }}<template v-if="c.bytes"> · {{ formatBytes(c.bytes) }}</template></span>
                <span v-if="c.message" class="coverPick__meta coverPick__error">{{ c.stage ? COVER_STAGE_LABEL[c.stage] + '：' : '' }}{{ c.message }}</span>
                <span v-if="coverPicking === c.url" class="coverPick__busy">
                  <Loader2 :size="18" class="spin" />
                </span>
              </button>
            </div>
            <details v-if="coverDiagnostics.length" class="coverDiagnostics">
              <summary>查询过程与网络路径</summary>
              <ul>
                <li v-for="(entry, index) in coverDiagnostics" :key="index" :class="{ 'coverDiagnostics__failed': entry.status === 'failed' }">
                  <span>{{ COVER_SOURCE_LABEL[entry.source] }} · {{ COVER_STAGE_LABEL[entry.stage] }}：{{ entry.message }}</span>
                  <small v-if="entry.route">{{ entry.route }}</small>
                </li>
              </ul>
            </details>
          </section>
<section class="panel">
            <h2 class="sec-title">
              <Link2 :size="14" />
              关联文件
              <span v-if="item.linked_files.length > 0" class="sec-title__count">
                {{ item.linked_files.length }}
              </span>
              <button class="sec-title__act" title="关联一个文件：攻略、修改器、存档修改工具…" @click="addLinks('file')">
                <FilePlus :size="13" />
                加文件
              </button>
              <button class="sec-title__act sec-title__act--tight" title="关联一个文件夹：MOD、整合包…" @click="addLinks('dir')">
                <FolderPlus :size="13" />
                加文件夹
              </button>
            </h2>

            <ul v-if="item.linked_files.length > 0" class="links">
              <li v-for="f in item.linked_files" :key="f.path" class="link-row">
                <div class="link-row__main">
                  <input
                    class="link-row__label"
                    :value="f.label"
                    placeholder="给它起个名字"
                    title="改个好认的名字"
                    @change="relabelLink(f, ($event.target as HTMLInputElement).value)"
                  />
                  <select
                    class="link-row__type"
                    :value="f.type"
                    title="类型只影响这里显示的词，不影响打开方式"
                    @change="retypeLink(f, ($event.target as HTMLSelectElement).value as LinkedFile['type'])"
                  >
                    <option v-for="t in LINK_TYPES" :key="t" :value="t">{{ LINK_TYPE_LABEL[t] }}</option>
                  </select>
                  <button
                    class="link-row__path mono truncate"
                    :title="`${f.path}（点击复制）`"
                    @click="copyPath(f.path)"
                  >
                    {{ f.path }}
                  </button>
                </div>
                <div class="link-row__acts">
                  <button class="path__act" title="打开它" @click="openLink(f)">
                    <ExternalLink :size="13" />
                  </button>
                  <button class="path__act" title="在资源管理器里选中它" @click="revealLink(f)">
                    <FolderOpen :size="13" />
                  </button>
                  <button class="path__del" title="解除关联（不会删磁盘上的文件）" @click="removeLink(f)">
                    <Trash2 :size="13" />
                  </button>
                </div>
              </li>
            </ul>
            <p v-else class="hint">
              把攻略、修改器、MOD 目录挂在这儿，下次找它们不用再翻硬盘。
              解除关联只是把这条记录去掉，不会删你的文件。
            </p>
          </section>
<section class="panel">
            <h2 class="sec-title">文件</h2>
            <div class="row"><button class="btn btn--ghost" :disabled="relocating" @click="relocate()">重新定位文件夹</button><button class="btn btn--subtle" :disabled="relocating" @click="relocate('file')">更换主程序</button></div>
            <dl class="facts">
              <dt>主程序</dt>
              <dd>
                <button class="mono truncate link" :title="`${item.path}（点击复制）`" @click="copyPath(item.path)">
                  {{ item.file_name }}
                </button>
              </dd>
              <dt>大小</dt>
              <dd>{{ formatBytes(item.file_size) }}</dd>
              <dt>目录</dt>
              <dd>
                <button class="mono truncate link" :title="`${item.source_dir}（点击复制）`" @click="copyPath(item.source_dir)">
                  {{ item.source_dir }}
                </button>
              </dd>
            </dl>
          </section>
</div>
<div id="game-panel-notes" v-show="activeTab === 'notes'" role="tabpanel" aria-labelledby="game-tab-notes" tabindex="0" class="detail-panel detail-panel--notes">
<section class="panel">
            <h2 class="sec-title">个人笔记</h2>
            <EditableField
              :model-value="item.notes"
              multiline
              placeholder="进度、卡在哪、装了哪些 MOD…"
              @commit="save({ notes: $event })"
            />
          </section>
</div>
</div>
    </template>
  </div>
</template>

<style scoped>
.path-warning{display:flex;align-items:center;gap:12px;padding:14px 24px;color:var(--warning,#d8a35d);background:var(--bg-card)}
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
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr);
  gap: 16px;
  padding: 20px 24px 32px;
  align-items: start;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
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

/* 小节标题右侧的动作，比 .btn 轻一档 —— 它是标题的一部分，不该抢注意力 */
.sec-title__act {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: var(--fs-tag);
  font-weight: 400;
  color: var(--text-faint);
}
.sec-title__act:hover {
  color: var(--accent);
}

.sec-title__count {
  margin-left: auto;
  font-size: var(--fs-tag);
  font-weight: 400;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* 标题里的补充说明（「按 xxx 搜的」）—— 用户得知道搜的是哪个名字才知道怎么改 */
.sec-title__note {
  font-size: var(--fs-tag);
  font-weight: 400;
  color: var(--text-faint);
}

/* ------------------------------- 候选封面 ------------------------------- */

/*
  2:3 的格子，和封面墙一致 —— 用户在这儿看到的比例就是采用之后看到的比例。
  auto-fill + minmax 让它跟着面板宽度自己决定一行放几个
*/
.covers {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 10px;
  align-items: start;
}

.coverPick {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-sunken);
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
}
.coverPick:hover:not(:disabled) {
  border-color: var(--accent);
  transform: translateY(-2px);
}
.coverPick:disabled {
  cursor: default;
}

.coverPick__img {
  width: 100%;
  aspect-ratio: var(--candidate-ratio, 2 / 3);
  object-fit: contain;
  display: block;
  /* 加载失败的候选留一块空位而不是破图icon —— 破图比空位更像是应用坏了 */
  background: var(--bg-raised);
}

.coverPick__placeholder {
  width: 100%;
  aspect-ratio: 2 / 3;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 6px;
  color: var(--text-faint);
  background: var(--bg-raised);
  font-size: var(--fs-tag);
}

.coverPick__label {
  padding: 0 7px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  text-align: left;
  overflow-wrap: anywhere;
}
.coverPick__meta { padding: 0 7px 5px; text-align: left; font-size: var(--fs-tag); color: var(--text-faint); overflow-wrap: anywhere; }
.coverPick__error, .coverDiagnostics__failed { color: var(--danger); }
.coverPick--failed { opacity: 0.75; }
.coverDiagnostics { margin-top: 14px; color: var(--text-sub); font-size: var(--fs-tag); }
.coverDiagnostics summary { cursor: pointer; }
.coverDiagnostics ul { display: grid; gap: 7px; padding-left: 18px; margin-top: 10px; }
.coverDiagnostics li small { display: block; color: var(--text-faint); overflow-wrap: anywhere; }
.cover-recovery { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; color: var(--text-sub); font-size: var(--fs-tag); }

.coverPick__busy {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 45%);
  color: #fff;
}

/* ------------------------------- 头部卡片 ------------------------------- */
.hero {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  padding: 20px;
}

.hero__cover {
  position: relative;
  flex: none;
  width: 96px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-card);
  overflow: hidden;
  display: grid;
  place-items: center;
  background: linear-gradient(
    155deg,
    hsl(var(--hue) 26% 26%),
    hsl(calc(var(--hue) + 28) 22% 15%)
  );
}

.hero__initial {
  font-family: var(--font-display);
  font-size: 34px;
  color: rgb(255 255 255 / 0.82);
}

.hero__img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.hero__cover--landscape { width: min(220px, 35%); aspect-ratio: 16 / 9; }

/* 悬停才出现：封面区平时该是封面，不是一块按钮面板 */
.hero__coverActs {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 5px 4px;
  background: rgb(0 0 0 / 0.62);
  backdrop-filter: blur(4px);
  opacity: 0;
  transition: opacity var(--t-fast) ease;
}
.hero__cover:hover .hero__coverActs,
.hero__coverActs:focus-within {
  opacity: 1;
}

.hero__coverBtn {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: var(--fs-tag);
  color: rgb(255 255 255 / 0.86);
}
.hero__coverBtn:hover {
  color: #fff;
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

.identity-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: var(--fs-tag);
}
.identity-row__label { color: var(--text-faint); flex: none; }
.identity-row__input {
  min-width: 0;
  flex: 1;
  color: var(--text-main);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--divider);
  padding: 3px 0;
}
.identity-row__query {
  flex: 1;
  min-width: 80px;
  color: var(--text-sub);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--divider);
  padding: 3px 0;
}
.identity-row__confirm { display: inline-flex; align-items: center; gap: 4px; color: var(--text-sub); white-space: nowrap; }
.identity-row__hint { margin: 4px 0 0; color: var(--text-faint); font-size: var(--fs-tag); }
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

/* ------------------------------- 路径列表 ------------------------------- */
.paths {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.path {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-input);
  background: var(--hover-surface);
}

.path__text {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: var(--fs-tag);
  color: var(--text-sub);
}
.path__text:hover {
  color: var(--text-main);
}

.path__note {
  flex: none;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

/* 用警示色但不做背景块：这是一句提示，不是一条错误 —— 路径失效很可能只是
   移动硬盘没接上，把它渲染成红底会让人以为数据丢了 */
.path__note--stale {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--warning);
}

.path__act {
  flex: none;
  color: var(--text-faint);
}
.path__act:hover:not(:disabled) {
  color: var(--accent);
}
.path__act:disabled {
  color: var(--text-faint);
  cursor: default;
}

.path__del {
  flex: none;
  color: var(--text-faint);
}
.path__del:hover {
  color: var(--danger);
}

/* ------------------------------- 关联文件 ------------------------------- */
.links {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.link-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-input);
  background: var(--hover-surface);
}

.link-row__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 标签可以直接改：这一列是用户认这条记录的依据，改它比改类型常见得多 */
.link-row__label {
  flex: none;
  width: 116px;
  background: none;
  border: 1px solid transparent;
  border-radius: 5px;
  outline: none;
  padding: 2px 5px;
  color: var(--text-main);
  font-size: var(--fs-tag);
}
.link-row__label:hover {
  border-color: var(--divider);
}
.link-row__label:focus {
  border-color: var(--accent);
}

.link-row__type {
  flex: none;
  height: 22px;
  padding: 0 4px;
  border-radius: var(--radius-tag);
  background: var(--bg-card);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  font-size: var(--fs-tag);
  outline: none;
}

.link-row__path {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}
.link-row__path:hover {
  color: var(--text-sub);
}

.link-row__acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 两个「加」并排时，第二个不再自己吃掉 margin-left: auto */
.sec-title__act--tight {
  margin-left: 0;
}

/* ------------------------------- 备份列表 ------------------------------- */
.backups {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.backup {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-radius: var(--radius-input);
  background: var(--hover-surface);
}

.backup__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.backup__when {
  font-size: var(--fs-body);
  color: var(--text-main);
  font-variant-numeric: tabular-nums;
}
.backup__when:hover {
  color: var(--accent);
}

.backup__meta {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* 存档路径在第二行：一个游戏可以有好几条，列表上只看时间分不出备的是哪一条 */
.backup__from {
  flex-basis: 100%;
  min-width: 0;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.backup__acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn--tiny {
  height: 24px;
  padding: 0 8px;
  font-size: var(--fs-tag);
}

/* 转圈。备份和还原都是几百毫秒到几秒，没有它就看不出点没点上 */
.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.hint {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  line-height: 1.7;
}

/* ------------------------------- 侧列 ------------------------------- */
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
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
}

.link {
  max-width: 100%;
  text-align: left;
  color: var(--text-sub);
}
.link:hover {
  color: var(--accent);
}
</style>

<style scoped>
.detail-body{display:flex;flex-direction:column;gap:18px;max-width:1280px;width:100%;margin:0 auto}.detail-body>.hero{width:100%}.detail-body>.detail-tabs{width:100%}.detail-panel{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;width:100%;align-items:start}.detail-panel--overview>.panel:first-child{grid-column:1/-1}.detail-panel--saves,.detail-panel--files{grid-template-columns:minmax(0,1fr)}@media(max-width:800px){.detail-panel{grid-template-columns:minmax(0,1fr)}}
</style>
