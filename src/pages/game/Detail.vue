<script setup lang="ts">
import { latestOnly, STALE } from '@/composables/latestOnly'
/**
 * 游戏详情页。
 *
 * 和软件详情页的分工不同：软件那页的重心是「我为什么留着它」（为什么选它 /
 * 使用场景 / 淘汰的同类），游戏这页的重心是「它在磁盘上的哪些地方」——
 * 主程序、存档、关联文件。存档那一块尤其要能看能改：Step 5 的备份直接吃它，
 * 识别时模型漏了或者认错了，用户得有地方纠正，而不是等备份备了个空目录。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import {isWindowsGameEntry} from '@/utils/game-entry'
import GameProjectRecord from '@/components/game/GameProjectRecord.vue'
import {projectOf} from '@/utils/game-project'
import GameCover from '@/components/game/GameCover.vue'
import GameNotes from '@/components/game/GameNotes.vue'
import GameTools from '@/components/game/GameTools.vue'
import GameDocs from '@/components/game/GameDocs.vue'
import Sidebar from '@/components/game/Sidebar.vue'
import LibraryToolbarMenu from '@/components/library/LibraryToolbarMenu.vue'
import type {GameNote,GameLaunchOptions} from '@/types/game-workspace'
import {BookOpen,Wrench,FileText,StickyNote} from 'lucide-vue-next'
import DetailTabs from '@/components/ui/DetailTabs.vue'
import GameResources from '@/components/game/GameResources.vue'
import {
  ArrowLeft,
  BadgeCheck,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  HardDriveDownload,
  History,
  Image,
  ImageOff,
  Loader2,
  Play,
  RotateCcw,
  Save,
  Trash2,
  Unlink,
  X
} from 'lucide-vue-next'
import EditableField from '@/components/ui/EditableField.vue'
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
  gameTitle
} from '@/utils'

const props = defineProps<{ id: string }>()
const item = ref<GameItem | null>(null)

const router = useRouter()
const route = useRoute()
const tabIds=['overview','trainer','guide','saves','files','notes']
const activeTab=ref(tabIds.includes(String(route.query.tab))?String(route.query.tab):'overview')
const scrollRoot=ref<HTMLElement>(),tabRoot=ref<HTMLElement>(),scrolled=ref(false),notesPanel=ref<InstanceType<typeof GameNotes>>()
const gameNotes=ref<GameNote[]>([]),categories=ref<string[]>([])
const trainers=computed(()=>item.value?.linked_files.filter(f=>f.type==='trainer')||[])
const guides=computed(()=>item.value?.linked_files.filter(f=>f.type==='guide')||[])
const report = computed(()=>guides.value.find(f=>f.project)||guides.value.find(f=>f.role==='report'))
const reportPath=ref(''),restoreTargets=ref<Record<string,string>>({})
const projectSections=computed(()=>(report.value?.note||'').split('\n\n').filter(Boolean))
function readReport(){reportPath.value=report.value?.path||'';activeTab.value='guide'}
const entries=computed(()=>item.value?[{path:item.value.path,label:item.value.file_name},...item.value.linked_files.filter(f=>f.role==='launcher'&&f.type!=='trainer'&&f.path!==item.value?.path)]:[])
const detailTabs=computed(()=>[{id:'overview',label:'简介',icon:FileText},{id:'trainer',label:'工具与修改器',icon:Wrench,count:trainers.value.length},{id:'guide',label:'攻略与说明',icon:BookOpen,count:guides.value.length},{id:'saves',label:'存档与备份',icon:Save,dot:!!item.value?.save_paths.length&&!backups.value.length},{id:'files',label:'文件与封面',icon:Image,count:entries.value.length},{id:'notes',label:'笔记',icon:StickyNote,count:gameNotes.value.length}])
async function leaveNotes(){return await notesPanel.value?.flush()??true}
onBeforeRouteLeave(leaveNotes);onBeforeRouteUpdate(leaveNotes)
watch(activeTab,(tab)=>{if(scrollRoot.value&&tabRoot.value){const top=tabRoot.value.offsetTop-52;if(scrollRoot.value.scrollTop>top)scrollRoot.value.scrollTop=top}void router.replace({query:{...route.query,tab}})})
watch(()=>route.query.tab,tab=>{activeTab.value=tabIds.includes(String(tab))?String(tab):'overview'})
const heroWide=computed(()=>!item.value?.cover_path&&!!item.value?.background_path)
const heroBackground=computed(()=>item.value?coverUrl(item.value.background_path||item.value.cover_path,item.value.updated_at):'')
const coverInfo=ref<Record<string,string>>({}),coverBroken=ref(false)
watch(()=>[item.value?.id,item.value?.cover_path,item.value?.background_path],()=>{coverBroken.value=false})
function focusCover(event:MouseEvent){const r=(event.currentTarget as HTMLElement).getBoundingClientRect();void save({cover_focus:Math.round(100*(event.clientX-r.left)/r.width)+','+Math.round(100*(event.clientY-r.top)/r.height)})}
async function defaultEntry(target:string){try{const result=await window.baoyi.game.defaultEntry(props.id,target);if(result)resourcesUpdated(result)}catch(e){error(errorMessage(e))}}
async function recheck(){await store.reload();const result=await window.baoyi.game.get(props.id);if(result)item.value=result}
const store = useGameStore()
const settings = useSettingsStore()
const { success, error, toast } = useToast()
const tasks = useTaskCenter()


const loading = ref(true)
const relocating = ref(false)
async function relocate(mode: 'directory' | 'file' = 'directory') {
  relocating.value = true
  try { const updated = await window.baoyi.game.relocate(props.id, mode); if (updated) {item.value = updated; await store.reload(); success('路径已更新，游玩记录与存档信息已保留')} }
  catch (cause) {error(errorMessage(cause))}
  finally {relocating.value = false}
}
const readGame = latestOnly(() => window.baoyi.game.get(props.id))
type CoverResult = { ok: boolean; message: string; item: GameItem | null }
const chooseCover = latestOnly((action: () => Promise<CoverResult | null>) => action())
const findCovers = latestOnly((action: () => ReturnType<typeof window.baoyi.game.searchCovers> | Promise<null>) => action())


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
    categories.value = (await window.baoyi.categories.list('game')).map(c => c.name)
  } catch (e) { error(errorMessage(e)) }
  await refreshRunning()
}

onMounted(()=>{void loadAll();void store.refreshCounts()})

const title = computed(() => (item.value ? gameTitle(item.value) : ''))
/**
 * 换封面。主进程把图拷进 userData 再落库，所以这里拿回来的条目是最终形态，
 * 不用自己再 load 一次。
 *
 * 和「搜封面」并列：搜不到、连不上、或者搜出来的都不满意时，这条路一定走得通。
 * 所以搜索失败的提示里总是指回这里，不让用户卡在一个只会失败的按钮上。
 */
async function background(clear=false){const id=props.id;try{const r=await(clear?window.baoyi.game.clearBackground:window.baoyi.game.pickBackground)(id);if(r)resourcesUpdated(r)}catch(e){error(errorMessage(e))}}

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
    if (!r.ok) { coverMiss.value = r.message; error(r.message); return }
    if (r.item) item.value = r.item
    success(r.message)
  } catch (err) {
    coverMiss.value = `更换封面失败：${errorMessage(err)}`
    error(coverMiss.value)
  }
}

async function clearCover(): Promise<void> {
  if (!item.value?.cover_path) return
  if (!window.confirm('撤掉这张封面？\n\n会退回自动构图或程序化封面。你原来那张图不受影响，删掉的是抱一自己存的那份拷贝。')) return
  closeCoverHits()
  coverPicking.value = ''
  try {
    const result = await chooseCover(async () => {
      const updated = await window.baoyi.game.clearCover(props.id)
      void store.load()
      return { item: updated, ok: true, message: '' }
    })
    if (result !== STALE && result?.item) item.value = result.item
  } catch (err) { error(`移除封面失败：${errorMessage(err)}`) }
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
        for (const diagnostic of result.diagnostics || []) tasks.log(taskId, diagnostic.status === 'failed' ? 'warn' : 'info', `${COVER_SOURCE_LABEL[diagnostic.source]} · ${COVER_STAGE_LABEL[diagnostic.stage]}：${diagnostic.message}`)
        tasks.update(taskId, { processed: 1, percent: 100 })
        tasks.finish(taskId, result.ok ? 'success' : 'failed', result.ok ? `找到 ${result.candidates.filter(candidate => candidate.status === 'ready').length} 张可用封面` : result.message)
        return result
      } catch (err) { tasks.finish(taskId, 'failed', `搜索出错：${errorMessage(err)}`); throw err }
    })
    if (r === STALE || !r) return
    coverQuery.value = r.query
    coverHits.value = r.candidates
    coverDiagnostics.value = r.diagnostics || []
    if (!r.ok) coverMiss.value = r.message
    else if (r.message) toast(r.message)
  } catch (err) { coverMiss.value = `搜索出错：${errorMessage(err)}` }
  coverSearching.value = false
}

async function useCover(url: string): Promise<void> {
  if (!item.value || coverPicking.value || brokenPreviews.value.has(url) || coverHits.value.find(c => c.url === url)?.status === 'failed') return
  coverPicking.value = url
  const taskId = tasks.start('game-scan', `设置游戏封面：${title.value}`, { total: 1, current: title.value })
  try {
    const r = await chooseCover(async () => {
      try {
        const result = await window.baoyi.game.setCoverFromUrl(props.id, url)
        tasks.update(taskId, { processed: 1, percent: 100 })
        tasks.finish(taskId, result.ok ? 'success' : 'failed', result.message || (result.ok ? '封面已设置' : '设置封面失败'))
        if (result.ok) void store.load()
        return result
      } catch (err) { tasks.finish(taskId, 'failed', `设置封面失败：${errorMessage(err)}`); throw err }
    })
    if (r === STALE || !r) return
    if (!r.ok) { coverMiss.value = r.message; error(r.message) }
    else {
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
        const message = rebuilt.failed ? '封面恢复失败，可重试搜索或选择本地图' : rebuilt.updated ? '封面已恢复' : '封面未更改，已保留当前选择'
        tasks.update(taskId, { processed: rebuilt.processed, total: rebuilt.processed, percent: 100 })
        tasks.finish(taskId, rebuilt.failed ? 'failed' : 'success', message)
        const updated = await window.baoyi.game.get(props.id)
        void store.load()
        return { item: updated, ok: !rebuilt.failed, message: rebuilt.failed ? updated?.cover_detail || message : rebuilt.updated ? message : '' }
      } catch (err) { tasks.finish(taskId, 'failed', `恢复封面失败：${errorMessage(err)}`); throw err }
    })
    if (result === STALE || !result) return
    if (result.item) item.value = result.item
    coverMiss.value = result.ok ? '' : result.message
    if (result.ok && result.message) success(result.message)
  } catch (err) { coverMiss.value = `恢复封面失败：${errorMessage(err)}` }
  coverPicking.value = ''
}

function previewFailed(candidate: CoverCandidate): void {
  const next = new Set(brokenPreviews.value)
  next.add(candidate.url)
  brokenPreviews.value = next
  coverDiagnostics.value.push({ source: candidate.source, stage: 'cache', status: 'failed', message: '本地预览无法显示，请重新搜索封面', route: 'baoyi 本地预览', url: candidate.url })
}

function closeCoverHits(): void {
  void findCovers(async () => null)
  coverSearching.value = false
  coverHits.value = []
  coverMiss.value = ''
  coverQuery.value = ''
  coverDiagnostics.value = []
}

onBeforeUnmount(() => { void chooseCover(async () => null); closeCoverHits() })

/** 走 store 而不是直接调 IPC：卡片墙和侧边栏计数要跟着一起更新 */
const { save, commitTags, toggleArchive, reveal, copyPath } = useResourceDetail({
  item,
  reveal: id => window.baoyi.game.revealInFolder(id),
  async update(current, patch) {
    if (Object.keys(patch).some(key => key.startsWith('identity_') || key === 'name_zh' || key === 'name_en')) {
      closeCoverHits()
      void chooseCover(async () => null)
      coverPicking.value = ''
    }
    return store.update(current.id, patch)
  }
})

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
const readBackups = latestOnly(() => window.baoyi.game.backups(props.id))
/** 正在备份的那条存档路径，同时用来禁按钮 */
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
onBeforeUnmount(() => saveAction?.abort())

async function loadBackups(): Promise<void> {
  if (!item.value) { backups.value = []; return }
  try {
    const rows = await readBackups()
    if (rows !== STALE) backups.value = rows
  } catch (err) { error(`读取备份列表失败：${errorMessage(err)}`) }
}

async function refreshBackups(): Promise<void> {
  await Promise.all([loadBackups(), store.refreshCounts()])
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
  const id=item.value.id,signal=beginSaveAction()
  backingUp.value = target
  try {
    const scope = await window.baoyi.game.previewBackup(id,target)
    if(signal.aborted)return
    if(!window.confirm(`备份范围：${target}\n${scope.files} 个文件，${formatBytes(scope.bytes)}\n只包含这条已登记路径；其他目录及安卓设备内部存档需分别备份。`))return
    const r = await window.baoyi.game.backupSave(id, target)
    if(signal.aborted)return
    if (!r.ok) {
      error(r.message)
      return
    }
    await refreshBackups()
    if(signal.aborted)return
    success(`${r.message}，共 ${formatBytes(r.backup?.size_bytes ?? 0)}`)
    await pruneOver(r.over)
  } catch (err) {
    if(!signal.aborted)error(`备份没能跑起来：${errorMessage(err)}`)
  } finally {
    if(!signal.aborted)backingUp.value = ''
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
  await refreshBackups()
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
  const signal=beginSaveAction()
  restoring.value = b.id
  try {
    const p=await window.baoyi.game.previewRestore(b.id,restoreTargets.value[b.id]||b.save_path)
    if(signal.aborted)return
    const lines=[['新增',p.added],['替换',p.changed],['移出当前目录',p.removed]] as const
    const detail=lines.map(([label,files])=>`${label} ${files.length}：${files.slice(0,8).join('、')}${files.length>8?'…':''}`).join('\n')
    if(!window.confirm(`还原「${formatDateTime(b.created_at)}」\n目标：${p.target}\n${detail}\n保持相同 ${p.unchanged} 个文件\n\n当前存档先自动备份；确认时会再次核对内容。请关闭游戏后继续。`))return
    const r = await window.baoyi.game.restoreBackup(b.id,p.target,p.expected)
    if(signal.aborted)return
    await refreshBackups()
    if(signal.aborted)return
    if (r.ok) success(r.message)
    else error(r.message)
  } catch (err) {
    if(!signal.aborted)error(`还原没能跑起来：${errorMessage(err)}`)
  } finally {
    if(!signal.aborted)restoring.value = ''
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
    await refreshBackups()
    if (r.ok) success(r.message)
    else error(r.message)
  } catch (err) {
    error(`删除失败：${errorMessage(err)}`)
  }
}

const openBackup = (b: SaveBackup): Promise<void> => window.baoyi.game.openBackup(b.id)

function resourcesUpdated(updated: GameItem): void {
  if (item.value?.id === updated.id) item.value = updated
  void store.load()
}


/* ---------------------------- 启动与时长 ---------------------------- */

/**
 * 这个游戏此刻在不在跑。向主进程问，而不是自己记一个 ——
 * 从详情页退出去再进来，页面状态没了，但游戏还在跑。
 */
const running = ref(false)
const pathUnavailable = computed(() => !!item.value?.path_state && item.value.path_state !== 'present')
function launchDisabled(entry = item.value?.path): boolean {
  return !entry || !isWindowsGameEntry(entry) || running.value || (entry === item.value?.path && pathUnavailable.value)
}

async function refreshRunning(): Promise<void> {
  if (!item.value) return
  running.value = await window.baoyi.game.running(item.value.id)
}

async function launch(options:GameLaunchOptions={}): Promise<void> {
  if (!item.value) return
  try {
  const r = await window.baoyi.game.launch(item.value.id, options)
  if (!r.ok) {
    error(r.message)
    return
  }
  toast(r.message)
  await refreshRunning()
  } catch(e){error(errorMessage(e))}
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

</script>

<template>
  <div class="detail-shell"><Sidebar @selected="router.push({name:'game-home'})"/><div ref="scrollRoot" class="detail" @scroll="scrolled=($event.target as HTMLElement).scrollTop>140">
    <div v-if="loading" class="detail__state">载入中…</div>
    <div v-else-if="!item" class="detail__state">
      <p>这条记录不存在或已被移除。</p>
      <button class="btn btn--ghost" @click="router.push({ name: 'game-home' })">返回封面墙</button>
    </div>

    <template v-else>
      <header class="head" :class="{'head--scrolled':scrolled}">
        <button class="btn btn--subtle" @click="router.push({name:'game-home'})"><ArrowLeft :size="14"/>游戏库</button><span class="breadcrumb-sep" :class="{visible:scrolled}">/</span><span class="breadcrumb-title" :class="{visible:scrolled}">{{title}}</span>
        <div class="head__actions"><button class="btn btn--ghost" @click="reveal"><FolderOpen :size="14"/>打开文件夹</button><button class="btn btn--ghost btn--icon" :disabled="!item.official_url" aria-label="官网" @click="openOfficial"><ExternalLink :size="14"/></button><LibraryToolbarMenu icon="more" label="游戏操作"><button @click="toggleArchive">{{item.is_archived?'取消归档':'归档'}}</button><button @click="copyPath(item.path)">复制路径</button><button @click="removeItem">从库里移除</button></LibraryToolbarMenu><div class="split-launch"><button class="btn btn--primary" :disabled="launchDisabled()" :title="!isWindowsGameEntry(item.path)?'安装包请在对应设备使用':pathUnavailable?'请先重新定位游戏程序':'启动游戏'" @click="launch()"><Play :size="14"/>{{!isWindowsGameEntry(item.path)?'安卓资料':running?'正在运行':'启动'}}</button><LibraryToolbarMenu icon="chevron" label="选择启动方式"><button v-for="entry in entries" :key="entry.path" :disabled="launchDisabled(entry.path)" @click="launch({entry:entry.path})">{{entry.path===item.path?'★ ':''}}{{entry.label}}</button><button v-for="tool in trainers.filter(f=>f.role!=='usage'&&/\.(exe|cmd|bat|lnk)$/i.test(f.path))" :key="tool.path" :disabled="launchDisabled()" @click="launch({trainers:[tool.path]})">连同 {{tool.label}} 启动</button></LibraryToolbarMenu></div></div>
      </header>
      <div class="body detail-body">
        <section class="hero"><div v-if="heroBackground" class="hero-backdrop" :style="{backgroundImage:'url('+JSON.stringify(heroBackground)+')'}"/>
          <div class="hero-cover" :class="{'hero-cover--wide':heroWide}"><GameCover :item="item" :shape="heroWide?'wide':'vert'" @failed="coverBroken=true"/><button class="manage-cover btn btn--ghost" @click="activeTab='files'">管理封面</button></div>
          <div class="hero__text"><input class="hero__name" :value="item.name_zh" placeholder="游戏名" aria-label="游戏名" @change="save({name_zh:($event.target as HTMLInputElement).value.trim()})"/><input class="hero__en" :value="item.name_en" placeholder="原名 / 英文名" aria-label="原名" @change="save({name_en:($event.target as HTMLInputElement).value.trim()})"/><input class="hero__summary" :value="item.summary" placeholder="一句话说明" aria-label="一句话说明" @change="save({summary:($event.target as HTMLInputElement).value.trim()})"/>
            <div class="hero-status"><div class="statuses"><button v-for="status in (['playing','unplayed','completed','shelved'] as const)" :key="status" :class="['chip','status-'+status,{on:item.play_status===status}]" :aria-pressed="item.play_status===status" @click="save({play_status:status})"><i/>{{PLAY_STATUS_LABEL[status]}}</button></div><button class="identity-pill" :class="{'identity-pill--pending':!item.identity_confirmed}" @click="save({identity_confirmed:!item.identity_confirmed})"><BadgeCheck :size="13"/>{{item.identity_confirmed?(item.identity_name||item.name_en||title):'身份待确认 · 确认'}}</button></div>
            <div class="hero-stats"><div><small>游玩时长</small><b>{{formatPlaytime(item.total_playtime_sec)}}</b></div><div><small>上次游玩</small><b>{{item.last_played_at?formatRelative(item.last_played_at):'未玩过'}}</b></div><div><small>启动次数</small><b>{{item.use_count||'未启动'}}</b></div><div><small>存档备份</small><b>{{backups.length}} 份</b></div></div>
          </div>
          <aside class="hero-meta"><h3>归类</h3><label>分类<input :value="item.category" list="game-categories" aria-label="游戏分类" @change="save({category:($event.target as HTMLInputElement).value.trim()})"/><datalist id="game-categories"><option v-for="c in categories" :key="c" :value="c"/></datalist></label><div class="hero-tags"><span>标签</span><div><button v-for="t in item.tags" :key="t" :aria-label="'删除标签 '+t" @click="save({tags:item.tags.filter(v=>v!==t)})">{{t}} ×</button><input aria-label="添加游戏标签" placeholder="+ 添加" @keydown.enter="!$event.isComposing&&commitTags([...item.tags,($event.target as HTMLInputElement).value].join('、'));!$event.isComposing&&(($event.target as HTMLInputElement).value='')"/></div></div><h3>记录</h3><dl class="facts"><dt>加入</dt><dd>{{formatDate(item.created_at)}}</dd><dt>目录</dt><dd class="truncate" :title="item.source_dir">{{item.source_dir.split(/[\\/]/).pop()}}</dd><dt>入口</dt><dd class="truncate" :title="item.path">{{item.file_name}}</dd></dl></aside>
        </section>
        <div v-if="item.path_state&&item.path_state!=='present'" class="path-warning" role="alert"><Unlink :size="16"/><span>{{item.path_state==='offline'?'游戏所在磁盘离线，请先连接磁盘。':'程序路径不可用，可能已被移动或改名。'}}</span><button class="btn btn--ghost" @click="recheck">重新检查</button><button class="btn btn--primary" :disabled="relocating" @click="relocate()">重新定位</button></div>
        <div ref="tabRoot" class="game-tabs"><DetailTabs v-model="activeTab" :tabs="detailTabs" prefix="game" label="游戏详情"/></div>
        <div id="game-panel-overview" v-show="activeTab==='overview'" role="tabpanel" aria-labelledby="game-tab-overview" tabindex="0" class="detail-panel detail-panel--overview">
          <div class="quick-cards"><button @click="activeTab='trainer'"><span><Wrench :size="14"/>修改器</span><b>{{trainers.length}} 个</b><small>{{trainers.flatMap(t=>t.features||[]).slice(0,3).map(f=>f.label).join(' · ')||'功能与用法'}}</small></button><button @click="activeTab='guide'"><span><BookOpen :size="14"/>攻略与说明</span><b>{{guides.length}} 份</b><small>{{guides.find(f=>f.read_progress)?.label||'本地攻略与资料'}}{{guides.some(f=>f.read_progress)?' · 读到 '+Math.round((guides.find(f=>f.read_progress)?.read_progress||0)*100)+'%':''}}</small></button><button @click="activeTab='saves'"><span><Save :size="14"/>存档备份</span><b>{{backups.length}} 份</b><small>{{backups[0]?'最新 '+formatDateTime(backups[0].created_at):item.save_paths.length?'有存档，尚未备份':'尚未指定存档'}}</small></button><button @click="activeTab='notes'"><span><StickyNote :size="14"/>笔记</span><b>{{gameNotes.length}} 条</b><small>{{gameNotes.slice().sort((a,b)=>b.updated_at-a.updated_at)[0]?.title||'记下你的游玩进度'}}</small></button></div>
          <GameProjectRecord :key="item.id" :game="item" @read="reportPath=$event;activeTab='guide'"/>
          <section class="panel description-panel"><h2 class="sec-title">我的简介与补充 <small>失焦自动保存</small></h2><p v-if="report" class="description-hint">这里保留你的编辑和早期介绍；最新修复情况见上方状态及使用导航。</p><EditableField :model-value="item.description" multiline placeholder="讲的是什么、玩法是什么样的" @commit="save({description:$event})"/></section>
          <section v-if="report" class="panel project-record" aria-label="精修工作记录"><div class="project-record__head"><h2 class="sec-title">精修工作记录</h2><button class="btn btn--ghost" @click="readReport">阅读完整精修记录</button></div><details class="project-record__details"><summary>展开工作摘要与历史说明</summary><div class="project-record__sections"><p v-for="(section,i) in projectSections" :key="i">{{section}}</p><p v-if="!projectSections.length">完整工作内容与验证范围见精修记录。</p></div></details></section>
        </div>
        <div id="game-panel-trainer" v-show="activeTab==='trainer'" class="detail-resources" role="tabpanel" aria-labelledby="game-tab-trainer" tabindex="0"><GameTools v-if="activeTab==='trainer'" :key="item.id" :game="item" @updated="resourcesUpdated"/></div>
        <div id="game-panel-guide" v-show="activeTab==='guide'" class="detail-resources" role="tabpanel" aria-labelledby="game-tab-guide" tabindex="0"><GameDocs v-if="activeTab==='guide'" :key="item.id" :game="item" :initial-path="reportPath" @updated="resourcesUpdated"/></div>
<div id="game-panel-saves" v-show="activeTab === 'saves'" role="tabpanel" aria-labelledby="game-tab-saves" tabindex="0" class="detail-panel detail-panel--saves">
<section class="panel">
            <p v-if="projectOf(item)?.saveScope" class="save-scope">{{projectOf(item)?.saveScope}}</p><p class="save-scope">下方仅列你已指定的活跃存档位置；随附预设、测试档和安卓包中的文件不自动作为玩家存档。多目录、注册表或浏览器存储需按单作工具说明备份。</p><h2 class="sec-title">
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
                  class="btn btn--ghost btn--sm"
                  title="重新看一眼它还在不在"
                  :disabled="verifying === s.path"
                  @click="verifySavePath(s.path)"
                >
                  <component :is="verifying === s.path ? Loader2 : BadgeCheck" :size="13" :class="{ spin: verifying === s.path }" />重新验证
                </button>
                <!-- 一条存档路径可能是目录也可能是单个 .sav，文案不能替它认定形状 -->
                <button
                  class="btn btn--primary btn--sm"
                  title="现在备份这份存档"
                  :disabled="!!backingUp||!!restoring"
                  @click="backupSave(s.path)"
                >
                  <component :is="backingUp === s.path ? Loader2 : Save" :size="13" :class="{ spin: backingUp === s.path }" />立即备份
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
              备份放在右上角设置 › 游戏 › 存档与备份里指定的目录，一次备一份，不会覆盖上一份。
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
                  <label>还原到<select aria-label="还原目标" v-model="restoreTargets[b.id]" :disabled="!!backingUp||!!restoring"><option :value="undefined">原位置：{{b.save_path}}</option><option v-for="s in item.save_paths.filter(s=>s.path!==b.save_path)" :key="s.path" :value="s.path">{{s.path}}</option></select></label>
                  <button
                    class="btn btn--ghost btn--tiny"
                    :disabled="!!backingUp||!!restoring"
                    @click="restore(b)"
                  >
                    <component :is="restoring === b.id ? Loader2 : RotateCcw" :size="13" :class="{ spin: restoring === b.id }" />
                    还原
                  </button>
                  <button class="path__del" :disabled="!!backingUp||!!restoring" title="删掉这份备份" @click="dropBackup(b)">
                    <Trash2 :size="13" />
                  </button>
                </div>
              </li>
            </ul>
          </section>
</div>
<div id="game-panel-files" v-show="activeTab === 'files'" role="tabpanel" aria-labelledby="game-tab-files" tabindex="0" class="detail-panel detail-panel--files">
<section class="panel entry-panel"><h2 class="sec-title">{{isWindowsGameEntry(item.path)?'启动入口':'安装包与资源'}}</h2><p v-if="!isWindowsGameEntry(item.path)">打开顶部文件夹取用安装包；设备安装、导出与恢复范围见精修记录。</p><div v-for="entry in entries" :key="entry.path" class="entry-row"><div><b>{{entry.label}}</b><small class="mono" :title="entry.path">{{entry.path}}</small></div><span v-if="entry.path===item.path" class="default-badge">★ 默认</span><button v-else class="btn btn--subtle" @click="defaultEntry(entry.path)">设为默认</button><button class="btn btn--ghost btn--sm" :disabled="launchDisabled(entry.path)" @click="launch({entry:entry.path})">启动</button></div></section>
<section class="panel cover-panel"><h2 class="sec-title">封面 <small>点击图片设置裁切焦点</small></h2><div class="cover-pair"><div v-for="shape in (['vert','wide'] as const)" :key="shape"><button class="cover-preview" :class="'cover-preview--'+shape" :aria-label="'设置'+(shape==='vert'?'竖版':'横版')+'封面焦点'" @click="focusCover"><GameCover :item="item" :shape="shape" @loaded="coverInfo[shape]=$event.composed?'保留全图自动构图':$event.width+' × '+$event.height"/></button><small>{{shape==='vert'?'竖版':'横版'}} · {{item.cover_path||item.background_path?coverInfo[shape]||'加载中':'程序化占位'}}</small></div></div><div class="cover-provenance"><p>竖图来源：{{item.cover_source==='manual'?'手动选择的本地图片':item.cover_source?COVER_SOURCE_LABEL[item.cover_source]:'未记录'}}<span v-if="item.cover_source_url"> · {{item.cover_source_url}}</span></p><p>横图：{{item.background_path?'已保存的本地图片 · '+item.background_path:'未单独设置；可由竖图自动构图'}}</p><p v-if="item.cover_detail">{{item.cover_detail}}</p><p>来源标签记录获取方式，不代表已核实为游戏内截图。</p></div><label class="focus-control">横向焦点<input type="range" min="0" max="100" :value="(item.cover_focus||'50,35').split(',')[0]" @change="save({cover_focus:($event.target as HTMLInputElement).value+','+(item.cover_focus||'50,35').split(',')[1]})"/></label><label class="focus-control">纵向焦点<input type="range" min="0" max="100" :value="(item.cover_focus||'50,35').split(',')[1]" @change="save({cover_focus:(item.cover_focus||'50,35').split(',')[0]+','+($event.target as HTMLInputElement).value})"/></label><label class="cover-field">游戏身份<input :value="item.identity_name" placeholder="实际游戏名称" @change="save({identity_name:($event.target as HTMLInputElement).value.trim()})"/></label><label class="cover-field">封面关键词<input :value="item.identity_query" :placeholder="item.identity_name||title" @change="save({identity_query:($event.target as HTMLInputElement).value.trim()})"/></label><div class="cover-buttons"><button class="btn btn--ghost" :disabled="coverSearching" @click="searchCovers">{{coverSearching?'搜索中':'搜封面'}}</button><button class="btn btn--ghost" @click="pickCover">竖版图片</button><button class="btn btn--ghost" @click="background()">横版图片</button><button v-if="item.background_path" class="btn btn--subtle" @click="background(true)">清除横图</button><button class="btn btn--subtle" :disabled="!item.cover_path" @click="clearCover">恢复占位</button><button v-if="item.cover_source_url&&(coverBroken||!item.cover_path)" class="btn btn--subtle" @click="recoverCover">恢复缓存</button></div></section>
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
<section class="panel"><GameResources v-if="activeTab === 'files'" :game="item" kind="other" @updated="resourcesUpdated"/></section>
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
<div id="game-panel-notes" v-show="activeTab==='notes'" role="tabpanel" aria-labelledby="game-tab-notes" tabindex="0" class="detail-panel detail-panel--notes"><GameNotes :key="item.id" ref="notesPanel" :game-id="item.id" @changed="gameNotes=$event"/>
</div>
</div>
    </template>
  </div></div>
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

<style scoped src="./detail-v21.css"/>

<style scoped>
.project-record{grid-column:1/-1}.project-record__head{display:flex;align-items:center;justify-content:space-between;gap:12px}.project-record__sections{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px}.project-record__sections p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.9;margin:0;padding:12px 0;border-top:1px solid var(--divider);color:var(--text-sub)}.project-record__sections p:first-child{grid-column:1/-1;color:var(--accent-ink)}@media(max-width:1000px){.project-record__sections{grid-template-columns:1fr}}
</style>

<style scoped>.backup__acts{flex-wrap:wrap}.backup__acts label{display:flex;flex-direction:column;gap:4px;font-size:11px;max-width:240px}.backup__acts select{max-width:100%;background:var(--bg-main);color:var(--text-sub);border:1px solid var(--divider-strong);border-radius:4px;padding:4px}</style>

<style scoped>.cover-provenance{font-size:11px;line-height:1.8;color:var(--text-faint);overflow-wrap:anywhere}</style>
