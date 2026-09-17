<script setup lang="ts">
import { computed, onMounted, ref, version as vueVersion, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { activeModule, moduleTarget } from '@/composables/useModules'
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Github,
  Globe,
  Info,
  Loader2,
  Merge,
  Moon,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Sun,
  Tags,
  Telescope,
  Trash2
} from 'lucide-vue-next'
import BaoyiLogo from '@/components/ui/BaoyiLogo.vue'
import IdentifyLog from '@/components/identify/IdentifyLog.vue'
import ReportDialog from '@/components/identify/ReportDialog.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import { useAI } from '@/composables/useAI'
import { useScan } from '@/composables/useScan'
import { useMediaScan } from '@/composables/useMediaScan'
import { useVideoImport } from '@/composables/useVideoImport'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useToast } from '@/composables/useToast'
import { ICON_NAMES, useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'
import { useSoftwareStore } from '@/stores/software'
import { useGameStore } from '@/stores/game'
import { useVideoStore } from '@/stores/video'
import { errorMessage, formatBytes, plain, searchCalls, shortenPath } from '@/utils'
import type {
  AIConfig,
  AIProfile,
  AppInfo,
  Category,
  DataStats,
  IdentifyReport,
  OrganizePlan,
  ScanUnit,
  SearchCallRecord,
  SearchProvider,
  Tag,
  TitleLang,
  TmdbConfig
} from '@/types'
import { parseProxyInput, serializeProxyInput, type ProxyInput } from '../../electron/services/proxy-rules'

const route = useRoute()
const router = useRouter()
const settings = useSettingsStore()
const store = useSoftwareStore()
// 「隐藏里番」的开关要在设置页里当场让影视那边重查，所以这儿得拿到它的 store
const video = useVideoStore()
const game = useGameStore()
const catStore = useCategoriesStore()
const { success, error, toast } = useToast()
const scan = useScan()
const gameScan = useMediaScan('game')
const videoScan = useMediaScan('video')
const videoImport = useVideoImport()
const tasks = useTaskCenter()
const ai = useAI()

/* -------------------------------- 分页 -------------------------------- */

const ALL_TABS = [
  { id: 'scan', label: '扫描与识别', icon: Telescope, modules: ['software', 'game', 'video'] },
  { id: 'organize', label: '目录整理', icon: FolderTree, modules: ['software'] },
  { id: 'ai', label: 'AI 配置', icon: Bot, modules: ['software', 'game', 'video'] },
  { id: 'search', label: '搜索服务', icon: Globe, modules: ['game', 'video'] },
  { id: 'appearance', label: '外观', icon: Palette, modules: ['software', 'game', 'video'] },
  { id: 'taxonomy', label: '分类与标签', icon: Tags, modules: ['software', 'game', 'video'] },
  { id: 'logs', label: '识别日志', icon: ScrollText, modules: ['software', 'game', 'video'] },
  { id: 'data', label: '数据管理', icon: Database, modules: ['software', 'game', 'video'] },
  { id: 'about', label: '关于', icon: Info, modules: ['software', 'game', 'video'] }
] as const

// 根据当前模块过滤标签页
const TABS = computed(() =>
  ALL_TABS.filter((t) => (t.modules as readonly string[]).includes(activeModule.value))
)

type TabId = (typeof ALL_TABS)[number]['id']

function tabFromRoute(value: unknown): TabId {
  const id = String(Array.isArray(value) ? value[0] : (value ?? '')) as TabId
  const availableTabs = TABS.value
  return availableTabs.some((t) => t.id === id) ? id : availableTabs[0]?.id ?? 'scan'
}

// Tab 记在 query 上，刷新和后退都还停在原来那一页，也方便从别处直接跳到 ?tab=logs。
// 路由本身是 hash 模式，再叠一层 hash 容易读错，所以用 query 而不是 #logs
const tab = ref<TabId>(tabFromRoute(route.query.tab))
watch(
  () => route.query.tab,
  (v) => (tab.value = tabFromRoute(v))
)

function go(id: TabId): void {
  tab.value = id
  void router.replace({ name: 'settings', query: { tab: id } })
}

/**
 * 主页「重新扫描目录」发现待识别目录后会带着 ?focus=pending 跳过来，
 * 把「还剩多少要识别」顶到眼前。只是一次性的视觉引导：切走 Tab 或开始识别后就撤掉。
 */
const focusPending = ref(route.query.focus === 'pending')
watch(
  () => route.query.focus,
  (v) => (focusPending.value = v === 'pending')
)

/* ------------------------------- AI 配置 ------------------------------- */

const apiUrl = ref(settings.settings.ai.api_url)
const apiKey = ref(settings.settings.ai.api_key)
const model = ref(settings.settings.ai.model)
const enabled = ref(settings.settings.ai.enabled)
const unusedDays = ref(settings.settings.unused_days)

const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)
/**
 * 让 Key 明文可见。
 *
 * 不只是「方便核对」：Chromium 的 type=password 在 Windows 中文输入法下会吞掉
 * 候选框，粘贴之外的输入看着像卡死（用户报过一次「删掉 Key 之后就打不进字了」）。
 * 留一个出口，遇上就点开它。
 */
const keyVisible = ref(false)

/** 当前表单凑成的一份配置，测试、拉模型、存 profile 都用它 */
function currentAiConfig(): AIConfig {
  return {
    api_url: apiUrl.value.trim(),
    api_key: apiKey.value.trim(),
    model: model.value.trim(),
    enabled: enabled.value
  }
}

async function saveAi(): Promise<void> {
  const ai = currentAiConfig()
  // 选中某套配置时，保存同时更新那一套 —— 否则改完再切走一趟就白改了
  const profiles = settings.settings.ai_profiles.map((p) =>
    p.id === settings.settings.ai_profile_id ? { ...p, ...ai } : p
  )
  await settings.patch({ ai, ai_profiles: profiles })
  success(activeProfile.value ? `已保存到「${activeProfile.value.name}」` : 'AI 配置已保存')
}

async function testConnection(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await window.baoyi.ai.test({ ...currentAiConfig(), enabled: true })
  } finally {
    testing.value = false
  }
}

/* --------------------------- 接口配置的存与切 --------------------------- */

const profiles = computed(() => settings.settings.ai_profiles)
const activeProfile = computed(
  () => profiles.value.find((p) => p.id === settings.settings.ai_profile_id) ?? null
)

/** 表单和选中的那套是否已经不一致 —— 用来提示「记得保存」 */
const aiDirty = computed(() => {
  const p = activeProfile.value
  if (!p) return false
  const c = currentAiConfig()
  return p.api_url !== c.api_url || p.api_key !== c.api_key || p.model !== c.model
})

function fillForm(cfg: AIConfig): void {
  apiUrl.value = cfg.api_url
  apiKey.value = cfg.api_key
  model.value = cfg.model
  enabled.value = cfg.enabled
}

/** 换一套配置：铺回表单，同时落到 settings.ai —— 主进程读的就是那里 */
async function switchProfile(id: string): Promise<void> {
  const p = profiles.value.find((x) => x.id === id)
  if (!p) return
  const { id: _id, name, ...cfg } = p
  fillForm(cfg)
  profileName.value = name
  await settings.patch({ ai: cfg, ai_profile_id: id })
  testResult.value = null
  modelList.value = []
  success(`已切换到「${p.name}」`)
}

/**
 * 配置名单独一个输入框，不走 window.prompt —— Electron 里 prompt 是空实现，
 * 点了什么都不会发生，看起来就跟按钮坏了一样。
 */
const profileName = ref(activeProfile.value?.name ?? '')

/** 名字空着时拿域名兜一个，省得每次都要自己想 */
const namePlaceholder = computed(() => {
  try {
    return new URL(apiUrl.value.trim()).hostname.replace(/^api\./, '') || '配置名'
  } catch {
    return '配置名'
  }
})

const canRename = computed(
  () => !!activeProfile.value && !!profileName.value.trim() && profileName.value.trim() !== activeProfile.value.name
)

async function addProfile(): Promise<void> {
  const name = profileName.value.trim() || namePlaceholder.value
  if (name === '配置名') {
    error('先给这套配置起个名字')
    return
  }
  // ponytail: 时间戳做 id 就够 —— 存一套要点一次按钮，人手点不出同毫秒的两条。
  // 不用 crypto.randomUUID()：打包后渲染进程跑在 file:// 下，它算不算安全上下文
  // 随 Chromium 版本变，缺了就是静默炸在生产环境，而这里根本不需要那种强度。
  const profile: AIProfile = { id: `p${Date.now().toString(36)}`, name, ...currentAiConfig() }
  profileName.value = name
  await settings.patch({
    ai: currentAiConfig(),
    ai_profiles: [...profiles.value, profile],
    ai_profile_id: profile.id
  })
  success(`已存为「${name}」`)
}

async function renameProfile(): Promise<void> {
  const p = activeProfile.value
  if (!p || !canRename.value) return
  const name = profileName.value.trim()
  await settings.patch({
    ai_profiles: profiles.value.map((x) => (x.id === p.id ? { ...x, name } : x))
  })
  success(`已改名为「${name}」`)
}

/**
 * 删掉当前这套。只从列表里摘掉，**不动** settings.ai ——
 * 删配置不该顺手把正在用的接口也拔了，识别会立刻开始报 401。
 */
async function removeProfile(): Promise<void> {
  const p = activeProfile.value
  if (!p) return
  // confirm 在 Electron 里是能用的（prompt 才是空实现），删除这种不可逆操作值得拦一道
  if (!window.confirm(`删除配置「${p.name}」？\n\n当前填在表单里的接口不会被清掉。`)) return
  await settings.patch({
    ai_profiles: profiles.value.filter((x) => x.id !== p.id),
    ai_profile_id: ''
  })
  // 名字框留着已删掉的名字会让人以为没删干净
  profileName.value = ''
  success(`已删除「${p.name}」`)
}

/* ------------------------------ 模型列表 ------------------------------ */

const modelList = ref<string[]>([])
const modelsLoading = ref(false)

async function loadModels(): Promise<void> {
  modelsLoading.value = true
  try {
    const r = await window.baoyi.ai.models(currentAiConfig())
    modelList.value = r.models
    // 失败原因得说出来：中转站不实现 /models 是常事，静默清空只会让人以为 Key 废了
    if (!r.ok) error(r.message)
    else if (!r.models.includes(model.value.trim())) toast(`${r.message}，点开模型框挑一个`)
  } finally {
    modelsLoading.value = false
  }
}

/* ---------------------------- 网络搜索配置 ---------------------------- */

const PROVIDERS: Array<{ value: SearchProvider; label: string; hint: string }> = [
  {
    value: 'model_builtin',
    label: '不额外联网（默认）',
    hint: 'agent 只依据本地文件信息和模型自身知识判断。不消耗任何搜索额度。'
  },
  {
    value: 'tavily',
    label: 'Tavily',
    hint: '专为 agent 设计，返回结构化摘要。免费额度每月 1000 次。'
  },
  {
    value: 'exa',
    label: 'Exa',
    hint: '语义搜索，适合「这个 exe 是什么软件」这类模糊查询。'
  },
  {
    value: 'firecrawl',
    label: 'Firecrawl',
    hint: '搜索 + 网页抓取，能读进官网正文。免费额度每月 500 次。'
  },
  {
    value: 'bing',
    label: 'Bing Web Search',
    hint: '微软官方接口。注意该服务已进入退役流程，新账号可能申请不到 Key。'
  },
  {
    value: 'searxng',
    label: 'SearXNG（自建）',
    hint: '自建搜索聚合，完全免费。需要填写你的实例地址。'
  }
]

const searchProvider = ref<SearchProvider>(settings.settings.search.provider)
const searchKey = ref(settings.settings.search.api_key)
const searchEndpoint = ref(settings.settings.search.endpoint)
const searchEnabled = ref(settings.settings.search.enabled)
const searchTesting = ref(false)
const searchResult = ref<{ ok: boolean; message: string } | null>(null)
const searchLogOpen = ref(false)
const searchLog = ref<SearchCallRecord[]>([])

const providerHint = computed(
  () => PROVIDERS.find((p) => p.value === searchProvider.value)?.hint ?? ''
)
const needsKey = computed(
  () => searchProvider.value !== 'model_builtin' && searchProvider.value !== 'searxng'
)
const needsEndpoint = computed(
  () => searchProvider.value === 'searxng' || searchProvider.value === 'bing'
)

/** 一份搜索配置够不够真的发出一次搜索（不看 enabled）。和主进程 searchAvailable 同一条判据 */
function usable(cfg: { provider: SearchProvider; api_key: string; endpoint: string }): boolean {
  if (cfg.provider === 'model_builtin') return false
  if (cfg.provider === 'searxng') return cfg.endpoint.trim().length > 0
  return cfg.api_key.trim().length > 0
}

const searchUsable = computed(() =>
  usable({
    provider: searchProvider.value,
    api_key: searchKey.value,
    endpoint: searchEndpoint.value
  })
)

const switchHint = computed(() => {
  if (searchProvider.value === 'model_builtin') return '当前服务商本来就不联网，无需开关'
  if (searchUsable.value) return ''
  return searchProvider.value === 'searxng' ? '请先填入实例地址' : '请先填入 API Key'
})

function currentSearchConfig() {
  return {
    provider: searchProvider.value,
    api_key: searchKey.value.trim(),
    endpoint: searchEndpoint.value.trim(),
    // 配置不完整时不许它是开着的：开着但没 Key，agent 那边照样拿不到工具，
    // 而用户看着开关是开的，只会以为搜索在工作
    enabled: searchEnabled.value && searchUsable.value
  }
}

/**
 * 保存搜索配置。
 *
 * 从「配置不全」变成「配置齐了」时顺手把开关打开 —— 0.4 之前这两件事是分开的，
 * 于是出现过「Key 填了、开关没开」这种状态：主进程照 enabled 判断，不注册
 * web_search 工具，而提示词还在教模型去搜，白烧轮数，冷门软件（cc-gui、Kelivo）
 * 直接认不出来。用户填 Key 的意图就是要用搜索，没有第二种解释。
 *
 * 只在这个**跨越**上自动开，不是「只要 Key 有效就开」—— 后者会把用户刚刚
 * 主动关掉的开关又扳回去（开关本身是即时落盘的，见 toggleSearch）。
 */
async function saveSearch(): Promise<void> {
  const autoOn = !usable(settings.settings.search) && searchUsable.value && !searchEnabled.value
  if (autoOn) searchEnabled.value = true
  await settings.patch({ search: currentSearchConfig() })
  success(autoOn ? '搜索配置已保存，并已自动启用' : '搜索配置已保存')
}

/** 开关自己改动时也要落盘，否则关掉之后不重启就还是开着的 */
async function toggleSearch(): Promise<void> {
  if (!searchUsable.value) {
    searchEnabled.value = false
    return
  }
  await settings.patch({ search: currentSearchConfig() })
}

async function testSearchConn(): Promise<void> {
  searchTesting.value = true
  searchResult.value = null
  try {
    searchResult.value = await window.baoyi.ai.testSearch(currentSearchConfig())
  } finally {
    searchTesting.value = false
  }
}

/* ---------------------------- TMDB 刮削配置 ---------------------------- */

/*
 * 和联网搜索并排放在这一页，不单开一个「影视」Tab：两者是同一类东西 ——
 * 用户自带 Key 的外部数据源，都影响识别质量而不影响别的。分成两页反而要用户
 * 记住「刮削」和「搜索」在设置里是两处。
 */

const tmdbKey = ref(settings.settings.tmdb.api_key)
const tmdbApiDomain = ref(settings.settings.tmdb.api_domain)
const tmdbImageDomain = ref(settings.settings.tmdb.image_domain)
const tmdbEnabled = ref(settings.settings.tmdb.enabled)
const tmdbTesting = ref(false)
const tmdbResult = ref<{ ok: boolean; message: string } | null>(null)

/** 够不够真的发出一次请求（不看 enabled）。和主进程 tmdbAvailable 同一条判据 */
const tmdbUsable = computed(() => tmdbKey.value.trim().length > 0)

function currentTmdbConfig(): TmdbConfig {
  return {
    api_key: tmdbKey.value.trim(),
    api_domain: tmdbApiDomain.value.trim(),
    image_domain: tmdbImageDomain.value.trim(),
    // 没 Key 不许是开着的，同搜索那边：开关开着而主进程判定不可用，
    // 用户只会以为刮削在工作
    enabled: tmdbEnabled.value && tmdbUsable.value
  }
}

/** 从「没 Key」跨到「有 Key」时顺手打开。理由和 saveSearch 一字不差 */
async function saveTmdb(): Promise<void> {
  const autoOn = !settings.settings.tmdb.api_key.trim() && tmdbUsable.value && !tmdbEnabled.value
  if (autoOn) tmdbEnabled.value = true
  await settings.patch({ tmdb: currentTmdbConfig() })
  success(autoOn ? 'TMDB 配置已保存，并已自动启用' : 'TMDB 配置已保存')
}

async function toggleTmdb(): Promise<void> {
  if (!tmdbUsable.value) {
    tmdbEnabled.value = false
    return
  }
  await settings.patch({ tmdb: currentTmdbConfig() })
}

async function testTmdbConn(): Promise<void> {
  tmdbTesting.value = true
  tmdbResult.value = null
  try {
    tmdbResult.value = await window.baoyi.ai.testTmdb(currentTmdbConfig())
  } finally {
    tmdbTesting.value = false
  }
}

/* ------------------------------ 隐藏里番 ------------------------------ */

const hideHentai = ref(settings.settings.hide_hentai)

/**
 * 即时落盘 + 立刻让影视那边重查。
 *
 * `video.reload()` 这一下是必需的：判据在主进程的查询层，而渲染进程手上是
 * 上一次查回来的 `items` 和 `counts`。不重查的话开关扳完**界面一点变化都没有**，
 * 要等下次进影视页才生效 —— 那看起来就是开关坏了。
 *
 * 之后再看选中项还在不在：用户可能正停在里番那一格上，而那一格马上就没了，
 * 留在原地会得到一面空墙配一个「里番」的标题。
 *
 * 判据是「刷新后的 counts 里还有没有这个分类」，而不是拿分类名去比 ——
 * 渲染进程**不 import `electron/`** 下的任何东西（那条边界全项目都守着），
 * 所以这里没有 `HENTAI_CATEGORY` 这个常量可用。照计数判反而更通用：
 * 任何一个分类因为任何原因消失了，都会被拨回「全部」。
 */
async function toggleHideHentai(): Promise<void> {
  await settings.patch({ hide_hentai: hideHentai.value })
  await video.reload()
  const sel = video.selection
  if (sel.kind === 'category' && !video.counts.categories.some((c) => c.name === sel.value)) {
    video.select({ kind: 'group', value: 'all' })
  }
  success(hideHentai.value ? '里番已隐藏' : '里番已恢复显示')
}

/* ------------------------------ 出站代理 ------------------------------ */

type ProxyMode = ProxyInput['mode']
const proxyMode = ref<ProxyMode>('direct')
const proxyHost = ref('127.0.0.1')
const proxyPort = ref(10808)
const proxyRules = ref(settings.settings.proxy)
const proxyChecking = ref(false)
const proxyResult = ref<{ ok: boolean; message: string } | null>(null)
const hanimeNetwork = ref<Awaited<ReturnType<typeof window.baoyi.settings.proxyStatus>> | null>(null)
const hanimeVerifying = computed(() => tasks.runningTasks.value.some(task => task.kind === 'hanime-verify'))
const hanimeHosts = ref(settings.settings.hanime_builtin_hosts !== false)
watch(() => settings.settings.hanime_builtin_hosts, (value) => { hanimeHosts.value = value !== false })

/**
 * 内置 Hosts 开关分两层生效：取页时的换 IP 回退主进程当场切换；
 * Chromium 启动前注入的那条解析规则改不了，要重启。提示里把这两句都说清楚，
 * 免得用户关了开关、看到「解析规则」还在，以为没保存。
 */
async function toggleHanimeHosts(): Promise<void> {
  await settings.patch({ hanime_builtin_hosts: hanimeHosts.value })
  success(hanimeHosts.value ? '内置 Hosts 已开启；Chromium 的解析规则重启后生效' : '内置 Hosts 已关闭，改走系统 DNS；Chromium 的解析规则重启后生效')
  await checkProxy()
}

function loadProxyForm(raw: string): void {
  proxyRules.value = raw
  try {
    const parsed = parseProxyInput(raw)
    proxyMode.value = parsed.mode
    if (parsed.mode === 'http' || parsed.mode === 'socks5') {
      proxyHost.value = parsed.host
      proxyPort.value = parsed.port
    }
  } catch {
    proxyMode.value = 'custom'
  }
}

loadProxyForm(settings.settings.proxy)
watch(() => settings.settings.proxy, loadProxyForm)
onMounted(() => {
  if (activeModule.value === 'video') void checkProxy()
})
watch(activeModule, (kind) => {
  if (kind === 'video') void checkProxy()
})

/**
 * 保存代理。主进程在 `settings:patch` 里看见 `proxy` 这个键就当场铺下去，
 * 所以这里不需要另开一个「应用代理」的通道。
 *
 * 铺失败时它不抛、只在返回值里说 —— 但 patch 的返回是设置本身，拿不到那句话。
 * 所以保存后再问一次生效情况，把「规则铺上了吗」摆给用户看。
 */
async function saveProxy(): Promise<void> {
  let input: ProxyInput
  if (proxyMode.value === 'direct') input = { mode: 'direct' }
  else if (proxyMode.value === 'system') input = { mode: 'system' }
  else if (proxyMode.value === 'custom') {
    const raw = proxyRules.value.trim()
    if (!raw) {
      error('自定义代理规则不能为空')
      return
    }
    try {
      input = parseProxyInput(raw)
    } catch (err) {
      error(err instanceof Error ? err.message : String(err))
      return
    }
  } else {
    const host = proxyHost.value.trim()
    const port = Number(proxyPort.value)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      error('请输入有效的代理主机和端口（1-65535）')
      return
    }
    input = { mode: proxyMode.value, host, port }
  }

  const serialized = serializeProxyInput(input)
  await settings.patch({ proxy: serialized })
  proxyRules.value = serialized
  success(input.mode === 'direct' ? '已切回直连' : '代理配置已保存')
  await checkProxy()
}

/**
 * 问主进程「这个地址实际会走哪条代理」。
 *
 * 这一条不是锦上添花：代理填错时最常见的现象是「看着保存了但没生效」，而
 * `resolveProxy` 的回答能当场分清两件事 —— 规则没铺上（回 DIRECT），
 * 还是规则铺上了但目标本身不通（回 SOCKS5 ...，那问题在代理或目标那边）。
 */
async function checkProxy(): Promise<void> {
  proxyChecking.value = true
  try {
    const s = await window.baoyi.settings.proxyStatus()
    const rules = s.rules === '' ? '（直连）' : s.rules
    proxyResult.value = {
      ok: true,
      message: `当前规则：${rules}　·　hanime1.me 实际走：${s.resolved}`
    }
    hanimeNetwork.value = s
  } catch (err) {
    proxyResult.value = { ok: false, message: `问不到代理状态：${(err as Error).message}` }
  } finally {
    proxyChecking.value = false
  }
}

async function verifyHanime(): Promise<void> {
  if (hanimeVerifying.value) return
  const taskId = tasks.start('hanime-verify', '内置 Cloudflare 验证', { message: '请在验证窗口完成验证；关闭窗口或超时会记为未完成' })
  try {
    const ok = await window.baoyi.settings.hanimeVerify('https://hanime1.me/')
    proxyResult.value = {
      ok,
      message: ok
        ? 'Hanime 页面已通过内置会话加载，可以重新刮削。'
        : '验证窗口未完成，请在窗口中完成 Cloudflare 验证后再试。'
    }
    tasks.finish(taskId, ok ? 'success' : 'cancelled', proxyResult.value.message)
  } catch (err) {
    proxyResult.value = { ok: false, message: '验证没能完成：' + errorMessage(err) }
    tasks.finish(taskId, 'failed', 'Cloudflare 验证失败', errorMessage(err))
  } finally {
    // 主任务在辅助查询前结束，查询慢或失败都不能继续锁住按钮。
    // 只刷新网络概况，不能用 checkProxy() 的「代理规则正常」覆盖验证失败。
    try {
      hanimeNetwork.value = await window.baoyi.settings.proxyStatus()
    } catch (err) {
      tasks.log(taskId, 'warn', '验证后的网络状态查询失败：' + errorMessage(err))
      // 辅助信息失败不改写主验证结果。
    }
  }
}

/**
 * 最近的搜索调用记录。从识别日志的 web_search 事件里现取，不新建表 ——
 * 每一次搜索本来就完整记在那里了，再存一份就有两个会不一致的真相。
 */
async function loadSearchLog(): Promise<void> {
  searchLog.value = searchCalls(await window.baoyi.logs.list({ limit: 100 }))
}

function toggleSearchLog(): void {
  searchLogOpen.value = !searchLogOpen.value
  if (searchLogOpen.value) void loadSearchLog()
}

const SEARCH_STATUS_META: Record<
  SearchCallRecord['status'],
  { label: string; tone: 'success' | 'warning' | 'muted' }
> = {
  ok: { label: '成功', tone: 'success' },
  empty: { label: '无结果', tone: 'muted' },
  timeout: { label: '超时', tone: 'warning' },
  failed: { label: '失败', tone: 'warning' }
}

function callTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ---------------------------- 扫描与识别 ---------------------------- */

const units = ref<ScanUnit[]>([])

async function loadUnits(): Promise<void> {
  units.value = await window.baoyi.scan.units()
}

onMounted(loadUnits)

const unitStats = computed(() => {
  const acc = { pending: 0, done: 0, skipped: 0, failed: 0 }
  for (const u of units.value) acc[u.status]++
  return acc
})

/** 只展示需要用户过目的：跳过的和失败的 */
const noteworthy = computed(() =>
  units.value.filter((u) => u.status === 'skipped' || u.status === 'failed').slice(0, 12)
)

/** 当前模块的扫描目录。整理 Tab 只在软件模块显示，那里用的也是 software_scan_dirs */
const dirs = computed(() => {
  const kind = activeModule.value
  if (kind === 'game') return settings.settings.game_scan_dirs
  if (kind === 'video') return settings.settings.video_scan_dirs
  return settings.settings.software_scan_dirs
})

// 设置页的扫描包含配置预检和结果刷新，这两个阶段也不能重复点击。
const scanningKind = ref<typeof activeModule.value | null>(null)
const scanKind = computed(() => scanningKind.value ?? activeModule.value)
const currentMediaScan = computed(() => scanKind.value === 'video' ? videoScan : gameScan)
const mediaScanProgress = computed(() => currentMediaScan.value.progress.value)
const scanStopping = computed(() => scanKind.value === 'software'
  ? scan.running.value && scan.stopping.value
  : currentMediaScan.value.running.value && currentMediaScan.value.stopping.value
)
const scanRunning = computed(() =>
  scanningKind.value !== null || (activeModule.value === 'software' ? scan.running.value : currentMediaScan.value.running.value)
)
const busy = computed(() => scanRunning.value || scan.running.value || ai.running.value || gameScan.running.value || videoScan.running.value)
const scanPhaseLabel = computed(() => {
  if (scanStopping.value) return '正在停止，等待当前任务收尾…'
  const kind = scanKind.value
  if (!kind || kind === 'software') return scan.phaseLabel.value
  const moduleName = kind === 'video' ? '影视' : '游戏'
  const p = mediaScanProgress.value
  if (!p) return moduleName + '：正在检查扫描配置…'
  if (p.phase === 'scanning') return moduleName + '：正在扫描 ' + shortenPath(p.current, 40)
  if (p.phase === 'done') return moduleName + '：正在刷新资源库…'
  return moduleName + '：识别 ' + Math.min(p.processed + 1, p.total) + '/' + p.total + '　' + (p.log || shortenPath(p.current, 32))
})
const scanPercent = computed(() => {
  if (scanKind.value === 'software') return scan.percent.value
  const p = mediaScanProgress.value
  if (!p || p.phase === 'scanning' || p.total === 0) return 0
  return Math.max(0, Math.min(100, Math.round((p.processed / p.total) * 100)))
})
const canCancelScan = computed(() =>
  scanRunning.value && (scanKind.value === 'software'
    ? scan.running.value && scan.progress.value?.phase !== 'done'
    : currentMediaScan.value.running.value && mediaScanProgress.value?.phase !== 'done')
)

function cancelScan(): void {
  if (!canCancelScan.value || scanStopping.value) return
  try {
    if (scanKind.value === 'software') scan.cancel()
    else currentMediaScan.value.cancel()
    // 停止状态由共享任务维护；跨页面取消也能同步，直到原 IPC 返回才解锁。
  } catch (err) {
    error('停止扫描失败：' + errorMessage(err))
  }
}

async function resetUnits(): Promise<void> {
  const ok = window.confirm(
    '把所有已识别 / 已跳过的目录退回待识别，下次补全会重新跑一遍 AI。\n已有的软件条目不会被删除，你写过的备注也会保留。确认继续？'
  )
  if (!ok) return
  const n = await window.baoyi.scan.reset()
  await Promise.all([loadUnits(), store.refreshCounts()])
  success(`已把 ${n} 个目录退回待识别`)
}

/** 单个目录退回待识别。日志页那个「退回待识别」也走这里 */
async function retryUnit(dir: string): Promise<void> {
  const ok = await window.baoyi.scan.retry(dir)
  if (!ok) {
    toast('这个目录已经不在扫描列表里了')
    return
  }
  await Promise.all([loadUnits(), store.refreshCounts()])
  success('已退回待识别，点「开始识别」重跑')
}

async function addDir(): Promise<void> {
  const dir = await scan.pickDirectory()
  if (!dir) return
  if (dirs.value.includes(dir)) {
    toast('这个目录已经在列表里了')
    return
  }
  const key = `${activeModule.value}_scan_dirs` as 'software_scan_dirs' | 'game_scan_dirs' | 'video_scan_dirs'
  await settings.patch({ [key]: [...dirs.value, dir] })
}

async function removeDir(dir: string): Promise<void> {
  const key = `${activeModule.value}_scan_dirs` as 'software_scan_dirs' | 'game_scan_dirs' | 'video_scan_dirs'
  await settings.patch({ [key]: dirs.value.filter((d) => d !== dir) })
  await loadUnits()
}

async function runScan(): Promise<void> {
  if (busy.value) return
  if (dirs.value.length === 0) {
    toast('先添加至少一个扫描目录')
    return
  }

  // 模块和目录在第一处 await 前固定；中途切模块或改目录不能改写本轮的目标。
  const kind = activeModule.value
  scanningKind.value = kind
  let mediaStarted = false
  const recordAttempt = (status: 'failed' | 'cancelled', message: string): void => {
    const id = tasks.start(kind === 'video' ? 'video-scan' : 'game-scan', (kind === 'video' ? '影视' : '游戏') + '扫描预检')
    tasks.finish(id, status, message, status === 'failed' ? message : undefined)
  }
  try {
    // 必须在 renderer 拍平。preload 里的 plain 来不及拦 contextBridge 的克隆异常。
    const scanDirs = plain(dirs.value)
    if (kind === 'video') {
      mediaStarted = true
      await videoImport.begin(scanDirs)
      return
    }
    if (kind === 'software') {
      const r = await scan.run(scanDirs)
      const stopped = scan.stopping.value
      await Promise.all([store.reload(), loadUnits()])

      const parts = ['发现 ' + r.found + ' 个程序']
      if (r.pending > 0) {
        parts.push(r.pending + ' 个目录待识别' + (r.added > 0 ? '（新增 ' + r.added + ' 个）' : ''))
      } else {
        parts.push('没有需要识别的目录')
      }
      if (r.settled > 0) parts.push(r.settled + ' 个已识别过，跳过')
      if (r.loose_files.length > 0) {
        parts.push('另有 ' + r.loose_files.length + ' 个未整理的散落文件（安装包或压缩包），本次未处理')
      }
      const message = (stopped ? '扫描已停止：' : '扫描完成：') + parts.join('，')
      if (stopped) toast(message)
      else success(message)
      return
    }

    if (!settings.settings.ai.enabled || !settings.settings.ai.api_key.trim()) {
      recordAttempt('failed', '游戏识别要用 AI，请先填写 API Key 并启用 AI')
      error('游戏识别要用 AI，请先填写 API Key 并启用 AI')
      go('ai')
      return
    }

    const operation = gameScan
    mediaStarted = true
    const r = await operation.run(scanDirs)
    const stopped = operation.stopping.value
    await game.reload()

    if (stopped) {
      toast('扫描已停止：已注册 ' + r.registered + ' 个，已完成的结果已保留')
    } else if (r.candidates === 0) {
      toast('这些目录里没找到游戏（没有可执行文件，或者只是一层收纳目录）')
    } else if (r.failed > 0 && r.registered === 0) {
      error('扫描到 ' + r.candidates + ' 个候选，但没有注册成功，' + r.failed + ' 个识别失败。请检查 AI 配置或识别日志')
    } else if (r.registered === 0) {
      toast('扫描到 ' + r.candidates + ' 个候选，全部跳过；可到识别日志查看原因')
    } else {
      const message = '扫描完成：' + r.candidates + ' 个候选，' + r.registered + ' 已注册，' + r.skipped + ' 已跳过，' + r.failed + ' 失败'
      if (r.failed > 0) toast(message)
      else success(message)
    }
  } catch (err) {
    if (kind !== 'software' && !mediaStarted) recordAttempt('failed', errorMessage(err))
    error('扫描没能完成：' + errorMessage(err))
  } finally {
    scanningKind.value = null
  }
}

async function runAi(): Promise<void> {
  // 和 Home 页的判定保持一致：总开关关着时同样进不去，别空跑一轮
  if (!settings.settings.ai.enabled || !settings.settings.ai.api_key) {
    error('AI 未启用：请先到「AI 配置」填写 API Key 并打开启用开关')
    go('ai')
    return
  }
  const result = await ai.complete()
  focusPending.value = false
  // 日志页是切过去才挂载的，那时它自己会拉最新的，这里不用管
  await Promise.all([store.reload(), loadUnits()])
  if (result.processed === 0) {
    toast('没有待识别的目录')
    return
  }
  success(
    `识别完成：${result.registered} 个条目待确认` +
      (result.failed > 0 ? `，${result.failed} 个目录失败` : '') +
      `，消耗 ${result.tokens.toLocaleString()} tokens`
  )
  if (result.registered > 0) {
    void router.push({ name: 'confirm' })
    return
  }
  // 一个都没认出来 —— 这时候用户最需要的正是「为什么」，直接把报告推到面前。
  // 认出来了就先去确认，报告随时能在识别日志页翻到
  if (result.report_id) await showReport(result.report_id)
}

/** 汇总报告弹窗。识别日志页顶部也有一份历史列表，两处用的是同一个组件 */
const runReport = ref<IdentifyReport | null>(null)

async function showReport(id: string): Promise<void> {
  runReport.value = (await window.baoyi.logs.reports()).find((r) => r.id === id) ?? null
}

/* -------------------------------- 外观 -------------------------------- */

const TITLE_LANGS: Array<{ value: TitleLang; label: string; hint: string }> = [
  { value: 'zh', label: '中文名为主', hint: '标题显示中文名，英文原名作副标题' },
  { value: 'en', label: '英文原名为主', hint: '标题显示 Process Monitor 这类官方原名，中文名作副标题' }
]

const titleLangHint = computed(
  () => TITLE_LANGS.find((t) => t.value === settings.settings.title_lang)?.hint ?? ''
)

async function setTitleLang(e: Event): Promise<void> {
  await settings.patch({ title_lang: (e.target as HTMLSelectElement).value as TitleLang })
}

async function setUnusedDays(): Promise<void> {
  const value = Math.max(7, Math.min(365, Math.round(unusedDays.value) || 60))
  unusedDays.value = value
  await settings.patch({ unused_days: value })
  await store.refreshCounts()
}

/* --------------------------- 分类与标签 --------------------------- */

const tags = ref<Tag[]>([])
const tagFilter = ref<'all' | 'ai' | 'fragment'>('all')
/** 合并时勾中的源标签 */
const mergePick = ref<number[]>([])
const mergeInto = ref<number | null>(null)
const newCategory = ref('')
const newTag = ref('')

async function loadTaxonomy(): Promise<void> {
  await catStore.load(activeModule.value)
  tags.value = await window.baoyi.tags.list(activeModule.value)
}

onMounted(loadTaxonomy)

/** 每个分类名下挂着多少软件。侧边栏计数已经算过一遍，直接借用 */
const categoryCount = computed(
  () => new Map(store.counts.categories.map((c) => [c.name, c.count]))
)

const visibleTags = computed(() => {
  if (tagFilter.value === 'ai') return tags.value.filter((t) => t.source === 'ai')
  // 只挂着 0～1 个条目的标签就是碎片：留着只会让标签栏越来越长
  if (tagFilter.value === 'fragment') return tags.value.filter((t) => t.usage_count <= 1)
  return tags.value
})

const TAG_SOURCE_META: Record<Tag['source'], { label: string; tone: 'muted' | 'accent' | 'success' }> = {
  ai: { label: 'AI 待确认', tone: 'muted' },
  user: { label: '自建', tone: 'accent' },
  confirmed: { label: '已确认', tone: 'success' }
}

async function saveCategory(c: Category, patch: Partial<Category>): Promise<void> {
  await catStore.upsert({ ...c, ...patch }, activeModule.value)
  await store.refreshCounts()
}

function onCategoryField(c: Category, field: 'name' | 'description' | 'icon', e: Event): void {
  const value = (e.target as HTMLInputElement).value.trim()
  if (value === c[field] || (field === 'name' && !value)) return
  void saveCategory(c, { [field]: value })
}

async function addCategory(): Promise<void> {
  const name = newCategory.value.trim()
  if (!name) return
  if (catStore.list.some((c) => c.name === name)) {
    toast('已经有同名分类了')
    return
  }
  const max = catStore.list.reduce((n, c) => Math.max(n, c.sort_order), 0)
  await catStore.upsert({ id: '', name, description: '', icon: 'box', sort_order: max + 1 }, activeModule.value)
  newCategory.value = ''
  await store.refreshCounts()
}

async function shiftCategory(id: string, delta: number): Promise<void> {
  catStore.list = await window.baoyi.categories.move(id, delta)
}

async function dropCategory(c: Category): Promise<void> {
  const n = categoryCount.value.get(c.name) ?? 0
  const warn = n > 0 ? `\n名下 ${n} 个软件会归入「其他」。` : ''
  if (!window.confirm(`删除分类「${c.name}」？${warn}\n不会删除任何实际文件。`)) return
  await catStore.remove(c.id)
  await store.refreshCounts()
}

async function addTag(): Promise<void> {
  const name = newTag.value.trim()
  if (!name) return
  tags.value = await window.baoyi.tags.create(name, activeModule.value)
  newTag.value = ''
}

function onTagRename(t: Tag, e: Event): void {
  const value = (e.target as HTMLInputElement).value.trim()
  if (!value || value === t.name) return
  void window.baoyi.tags.rename(t.id, value).then(async (list) => {
    tags.value = list
    await store.refreshCounts()
  })
}

async function dropTag(t: Tag): Promise<void> {
  const warn = t.usage_count > 0 ? `\n${t.usage_count} 个软件会失去这个标签。` : ''
  if (!window.confirm(`删除标签「${t.name}」？${warn}`)) return
  tags.value = await window.baoyi.tags.remove(t.id)
  mergePick.value = mergePick.value.filter((id) => id !== t.id)
  await store.refreshCounts()
}

function toggleMerge(id: number): void {
  mergePick.value = mergePick.value.includes(id)
    ? mergePick.value.filter((x) => x !== id)
    : [...mergePick.value, id]
}

/** 勾中的这些并进目标标签，条目上的引用一并替换 */
async function doMerge(): Promise<void> {
  const into = mergeInto.value
  const from = mergePick.value.filter((id) => id !== into)
  if (into == null || from.length === 0) {
    toast('先勾选要合并的标签，再选一个目标')
    return
  }
  const target = tags.value.find((t) => t.id === into)?.name ?? ''
  const names = tags.value.filter((t) => from.includes(t.id)).map((t) => t.name)
  if (!window.confirm(`把「${names.join('、')}」并入「${target}」？\n所有条目上的引用会一起替换。`)) return

  tags.value = await window.baoyi.tags.merge(from, into)
  mergePick.value = []
  mergeInto.value = null
  await store.refreshCounts()
  success(`已并入「${target}」`)
}

/* ------------------------------ 目录整理 ------------------------------ */

const organizeRoot = computed(() => settings.settings.organize_root)
async function pickVideoOrganizeRoot(): Promise<void> {
  try {
    const folder = await window.baoyi.videoOrganize.pickDirectory()
    if (folder) { await settings.patch({ video_organize_root: folder }); success('已保存影视整理根目录') }
  } catch (cause) { error(errorMessage(cause)) }
}
const plans = ref<OrganizePlan[]>([])
const openPlan = ref('')
const undoing = ref('')

async function loadPlans(): Promise<void> {
  plans.value = await window.baoyi.organize.plans()
}

onMounted(loadPlans)

async function pickOrganizeRoot(): Promise<void> {
  const dir = await window.baoyi.organize.pickRoot()
  if (!dir) return
  // 整理目标不该同时是扫描目录：搬进去的软件会在下一轮重扫时又被发现一遍
  if (dirs.value.some((d) => dir.toLowerCase().startsWith(d.toLowerCase()))) {
    toast('这个目录在扫描范围里，整理进去的软件下次扫描会被重复发现。建议换一个')
  }
  await settings.patch({ organize_root: dir })
  success('整理目标目录已保存')
}

async function clearOrganizeRoot(): Promise<void> {
  await settings.patch({ organize_root: '' })
}

/** 一条整理记录里成功了几步 —— 列表上直接显示它，比总步数有意义 */
function planTally(p: OrganizePlan) {
  return {
    moved: p.steps.filter((s) => s.ok && s.type === 'move').length,
    linked: p.steps.filter((s) => s.ok && s.type === 'junction').length,
    failed: p.steps.filter((s) => !s.ok).length
  }
}

async function undoPlan(p: OrganizePlan): Promise<void> {
  const t = planTally(p)
  const ok = window.confirm(
    `撤销这次整理？\n\n移动过的 ${t.moved} 个文件夹会搬回原来的位置，` +
      `建立的 ${t.linked} 个链接会被删除（不影响真实文件）。\n\n确认继续？`
  )
  if (!ok) return

  undoing.value = p.id
  try {
    const r = await window.baoyi.organize.undo(p.id)
    await Promise.all([loadPlans(), store.reload()])
    if (r.failed > 0) {
      error(`撤销完成 ${r.restored} 条，${r.failed} 条失败：${r.notes.slice(0, 2).join('；')}`)
      return
    }
    success(`已还原 ${r.restored} 条`)
  } finally {
    undoing.value = ''
  }
}

/* ------------------------------ 忽略名单 ------------------------------ */
const skippedCount = ref(0)

async function loadSkipped(): Promise<void> {
  skippedCount.value = await window.baoyi.pending.skippedCount()
}

onMounted(loadSkipped)

async function clearSkipped(): Promise<void> {
  if (!window.confirm(`清空忽略名单（${skippedCount.value} 项）？\n这些程序下次识别会重新出现在确认面板里。`)) return
  const n = await window.baoyi.pending.clearSkipped()
  await loadSkipped()
  success(`已清空 ${n} 项`)
}

/* ------------------------------ 数据管理 ------------------------------ */

const dataDir = ref('')
const stats = ref<DataStats | null>(null)
const resetting = ref(false)

/**
 * 备份根的**实际生效值**，从主进程取而不是读 settings.save_backup_root ——
 * 那个字段为空时含义是「用默认」，而默认值要拼用户数据目录，渲染进程拼不出来。
 */
const backupRoot = ref('')

async function loadStats(): Promise<void> {
  stats.value = await window.baoyi.data.stats()
}

async function loadBackupRoot(): Promise<void> {
  backupRoot.value = await window.baoyi.data.saveBackupRoot()
}

onMounted(async () => {
  dataDir.value = await window.baoyi.data.dir()
  await Promise.all([loadStats(), loadBackupRoot()])
})

const openBackupRoot = (): Promise<string> => window.baoyi.data.openSaveBackupRoot()

/**
 * 换备份根。已有的备份**不搬** —— 库里每条记录存的是完整路径，搬走等于让
 * 一批记录同时指向不存在的目录；不搬则旧备份照样能还原，只是散在两个地方。
 */
async function pickBackupRoot(): Promise<void> {
  const dir = await window.baoyi.data.pickSaveBackupRoot()
  if (!dir) return
  await settings.patch({ save_backup_root: dir })
  await loadBackupRoot()
  success('存档备份目录已保存')
}

async function resetBackupRoot(): Promise<void> {
  await settings.patch({ save_backup_root: '' })
  await loadBackupRoot()
}

/**
 * 保留上限。走本地 ref 而不是直接 v-model 到 store：数字输入框中间态会经过空串和
 * NaN，直接绑上去等于每敲一个字符就往库里写一次不成立的值。
 */
const keep = ref(settings.settings.save_backup_keep)
watch(() => settings.settings.save_backup_keep, (v) => { keep.value = v })

async function saveKeep(): Promise<void> {
  // 空串必须先单独挡掉：`Number('')` 是 0，而 0 的含义是「不限」——
  // 直接往下走会把「把输入框删干净」理解成「关掉提示」，那是把手滑当成决定。
  // v-model.number 在解析不出数字时会把原始字符串留在这儿，所以这里可能是 '' 或 'abc'。
  const raw = String(keep.value ?? '').trim()
  const n = raw === '' ? Number.NaN : Math.trunc(Number(raw))
  const safe = Number.isFinite(n) && n >= 0 ? Math.min(n, 999) : 10
  keep.value = safe
  if (safe === settings.settings.save_backup_keep) return
  await settings.patch({ save_backup_keep: safe })
  success(safe > 0 ? `超过 ${safe} 份时会提示` : '已改为不限份数')
}

/* -------------------------------- 关于 -------------------------------- */

const info = ref<AppInfo | null>(null)
onMounted(async () => {
  info.value = await window.baoyi.app.info()
})

function openDataDir(): void {
  void window.baoyi.data.openDir()
}

async function exportJson(): Promise<void> {
  try {
    const file = await window.baoyi.data.exportJson()
    if (file) success(`已备份到 ${file}`)
  } catch (cause) { error(`备份失败：${cause instanceof Error ? cause.message : String(cause)}`) }
}

const restoringBackup = ref(false)
async function restoreJson(): Promise<void> {
  if (restoringBackup.value) return
  restoringBackup.value = true
  try {
    const result = await window.baoyi.data.restoreJson()
    if (result) success('资料库已恢复，正在重启应用')
  } catch (cause) { error(`恢复失败：${cause instanceof Error ? cause.message : String(cause)}`) }
  finally { restoringBackup.value = false }
}

async function exportMarkdown(): Promise<void> {
  const file = await window.baoyi.data.exportMarkdown()
  if (file) success(`已导出到 ${file}`)
}

const refreshingIcons = ref(false)

/**
 * 重新提取全部软件图标。
 *
 * 单独一个按钮而不是搭在「重新识别」上：图标和 AI 一点关系都没有，为了换一张图
 * 重跑一遍识别是在烧用户的 token。而不给这个按钮的话，修好的提取逻辑对已经入库的
 * 条目一点效果都没有 —— `extractIcon` 只在识别时被调 —— 现象和「这个 bug 没修」
 * 一模一样。
 *
 * 结果按四档报数（换了 / 手改过跳过 / 提不到 / 总数）。只说「完成了」的话，
 * 「一张都没换」和「全换了」在界面上长得一样，而前者说明这条路根本没跑起来。
 */
async function refreshIcons(): Promise<void> {
  refreshingIcons.value = true
  try {
    const r = await window.baoyi.software.refreshIcons()
    await Promise.all([store.reload(), loadStats()])
    const bits = [`${r.total} 条里换了 ${r.changed} 张`]
    if (r.manual > 0) bits.push(`${r.manual} 条是你手动指的，没动`)
    if (r.failed > 0) bits.push(`${r.failed} 条提不到图标`)
    if (r.changed > 0) success(bits.join('，'))
    else toast(bits.join('，') + ' —— 现在这批已经是能提到的最好结果了')
  } catch (err) {
    error(`重提图标失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    refreshingIcons.value = false
  }
}

async function reset(mode: 'library' | 'all'): Promise<void> {
  // 文案必须把「游戏也会清」写出来。0.6 那版只说「软件条目」而代码只清 software，
  // 两边是对上的；现在改成清全部品类，文案不跟着改就成了一句谎话
  const shared =
    `会清掉：全部软件、游戏、影视及内容记录，待识别目录、整理记录、任务和下载记录、图标缓存、游戏封面与影视海报。\n` +
    `不会删除资源文件，软件、游戏和视频都还在原处。\n` +
    `存档备份也一份不删，备份记录一并留着，不然你就再也找不到那些文件了。`
  const warning =
    mode === 'library'
      ? `清空识别数据，重新开始识别。\n\n${shared}\n\n保留：API Key、搜索配置、扫描目录、自定义分类、识别日志。\n已经整理过的文件夹会留在整理后的位置，整理记录清掉之后就无法再自动撤销了。\n\n确认继续？`
      : `恢复出厂：连 API Key、搜索配置、扫描目录、自定义分类、识别日志、整理记录一起清空，并重新走一遍引导流程。\n\n${shared}\n整理记录清掉之后就无法再自动撤销整理了。\n\n确认继续？`
  if (!window.confirm(warning)) return

  resetting.value = true
  try {
    const { summary } = await window.baoyi.data.reset(mode)
    await settings.load()
    await Promise.all([store.reload(), loadUnits(), loadStats()])

    if (mode === 'all') {
      // 出厂状态下 onboarded 为 false，路由守卫会把用户带回引导页
      await router.push({ name: 'onboarding' })
      window.location.reload()
      return
    }

    // 设置页里那几个 ref 是进页面时快照的，重置后要跟着回到当前值
    fillForm(settings.settings.ai)
    profileName.value = activeProfile.value?.name ?? ''
    testResult.value = null
    searchResult.value = null

    // 保留的存档备份只在真有的时候提 —— 一句「保留 0 份备份」只会让人愣一下
    const kept = summary.saveBackupsKept
      ? `；保留 ${summary.saveBackupsKept} 份存档备份`
      : ''
    success(
      `已清空 ${summary.software} 个软件条目、${summary.games} 个游戏条目、` +
        `${summary.videos} 个影视条目（${summary.episodes} 集）、` +
        `${summary.units} 个目录记录、${summary.icons} 个图标、${summary.covers} 张封面、` +
        `${summary.posters} 张海报${kept}`
    )
    window.location.reload()
  } catch (err) {
    // 不给反馈的话，失败看起来和成功一模一样 —— 按钮变回可点，什么都没发生
    error(`重置失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <div class="settings">
    <header class="head">
      <button class="btn btn--subtle" @click="router.push(moduleTarget(activeModule))">
        <ArrowLeft :size="16" />
        返回
      </button>
      <h1>
        设置
        <span class="head__module">
          {{
            activeModule === 'software' ? '软件' : activeModule === 'game' ? '游戏' : '影视'
          }}
        </span>
      </h1>
    </header>

    <div class="layout">
      <nav class="nav no-select">
        <button
          v-for="t in TABS"
          :key="t.id"
          class="nav__item"
          :class="{ on: tab === t.id }"
          @click="go(t.id)"
        >
          <component :is="t.icon" :size="15" />
          {{ t.label }}
        </button>
      </nav>

      <div class="body">
        <!-- ------------------------- 扫描与识别 ------------------------- -->
        <template v-if="tab === 'scan'">
          <section class="panel">
            <div class="sec-head">
              <h2>扫描目录</h2>
              <button class="btn btn--ghost" @click="addDir">
                <FolderPlus :size="14" />
                添加目录
              </button>
            </div>
            <p v-if="activeModule === 'software'" class="sec-desc">
              扫描本身不花钱也不联网：它只是把每个目录整理成一份待识别清单，
              真正的判断交给下一步的 AI 识别。
            </p>
            <p v-else-if="activeModule === 'video'" class="sec-desc">
              影视扫描先读取本地文件名、NFO 和 HanimeViewer 资料并入库，不调用 Agent，也不消耗模型或搜索额度。
              资料不足的作品会列入待处理，可选中后使用「Agent 复查所选」。
            </p>
            <p v-else class="sec-desc">
              扫描会查找本地游戏目录，随后交给 AI 识别并入库。
              需要启用 AI；识别与刮削可能联网，并消耗你所配置服务的额度。
            </p>

            <ul v-if="dirs.length" class="dirs">
              <li v-for="d in dirs" :key="d">
                <span class="mono truncate" :title="d">{{ d }}</span>
                <button class="btn btn--subtle" title="移除" @click="removeDir(d)">
                  <Trash2 :size="14" />
                </button>
              </li>
            </ul>
            <p v-else class="empty-line">还没有添加任何目录。</p>

            <div class="row">
              <button class="btn btn--primary" :disabled="busy || dirs.length === 0" @click="runScan">
                <Loader2 v-if="scanRunning" :size="14" class="spin" />
                {{ scanRunning ? '扫描中…' : '立即扫描' }}
              </button>
              <button v-if="canCancelScan" class="btn btn--subtle" :disabled="scanStopping" @click="cancelScan">
                {{ scanStopping ? '正在停止…' : '停止扫描' }}
              </button>
              <span v-if="scanRunning" class="hint truncate" role="status">{{ scanPhaseLabel }}</span>
            </div>

            <div v-if="scanRunning" class="bar">
              <i :style="{ width: `${scanPercent}%` }" />
            </div>
          </section>

          <section v-if="activeModule === 'video'" class="panel">
            <h2 class="sec-head">视频导入与文件整理</h2>
            <p class="sec-desc">扫描结果先进入导入确认窗口，核对后再录入。需要联网补充资料时，可以启用 Agent。</p>
            <div class="row"><label class="hint"><input type="checkbox" :checked="videoImport.useAgent.value" @change="videoImport.setAgent(($event.target as HTMLInputElement).checked)" /> 导入时启用 Agent</label><button class="btn btn--ghost" @click="videoImport.show()">打开导入确认</button></div>
            <p class="sec-desc" style="margin-top: 18px">整理根目录：创建合集时勾选移动或复制，文件将自动放进此目录下以合集名命名的新文件夹。</p>
            <div class="row"><span class="hint mono" style="overflow-wrap:anywhere">{{ settings.settings.video_organize_root || '尚未设置' }}</span><button class="btn btn--ghost" @click="pickVideoOrganizeRoot"><FolderOpen :size="14" />{{ settings.settings.video_organize_root ? '修改整理根目录' : '设置整理根目录' }}</button></div>
          </section>
          <section v-if="activeModule === 'software'" class="panel">
            <h2 class="sec-head">AI 识别</h2>
            <p class="sec-desc">
              把每个待识别目录交给 agent 自主探索：它自己列目录、读 exe 的 PE 信息、
              读目录里的说明文档，判断哪个是主程序，再把 32 位和 64 位合并成同一个条目。
              识别不对时到「识别日志」翻它当时的判断过程。
            </p>

            <p v-if="focusPending && unitStats.pending > 0" class="callout">
              还有 <b>{{ unitStats.pending }}</b> 个目录待识别，点下面的「开始识别」交给 AI。
            </p>

            <ul class="tally">
              <li :class="{ lit: focusPending && unitStats.pending > 0 }">
                <b>{{ unitStats.pending }}</b><span>待识别</span>
              </li>
              <li><b>{{ unitStats.done }}</b><span>已识别</span></li>
              <li><b>{{ unitStats.skipped }}</b><span>已跳过</span></li>
              <li :class="{ bad: unitStats.failed > 0 }">
                <b>{{ unitStats.failed }}</b><span>失败</span>
              </li>
            </ul>

            <div class="row row--gap">
              <button class="btn btn--primary" :disabled="busy" @click="runAi">
                <Loader2 v-if="ai.running.value" :size="14" class="spin" />
                开始识别（{{ store.todo }}）
              </button>
              <button
                v-if="units.length > 0"
                class="btn btn--ghost"
                :disabled="busy"
                @click="resetUnits"
              >
                <RotateCcw :size="14" />
                全部重新识别
              </button>
              <button v-if="ai.running.value" class="btn btn--subtle" @click="ai.cancel()">
                中止
              </button>
            </div>

            <template v-if="ai.running.value">
              <div class="bar">
                <i :style="{ width: `${ai.percent.value}%` }" />
              </div>
              <p class="hint truncate">{{ ai.phaseLabel.value }}</p>
              <p class="agent-line truncate">
                <span class="agent-line__dir mono">{{ ai.progress.value?.current || '—' }}</span>
                <span v-if="ai.activity.value">→ {{ ai.activity.value }}</span>
              </p>
            </template>

            <ul v-if="noteworthy.length" class="notes">
              <li v-for="u in noteworthy" :key="u.dir">
                <div class="notes__line">
                  <span class="mono truncate" :title="u.dir">{{ u.dir }}</span>
                  <button class="btn btn--subtle" :disabled="busy" @click="retryUnit(u.dir)">
                    <RotateCcw :size="13" />
                    重试
                  </button>
                </div>
                <span class="notes__reason" :class="{ bad: u.status === 'failed' }">
                  {{ u.note || (u.status === 'failed' ? '识别失败' : '未说明原因') }}
                </span>
              </li>
            </ul>
          </section>

          <section v-if="activeModule === 'software' && skippedCount > 0" class="panel">
            <h2 class="sec-head">忽略名单</h2>
            <p class="sec-desc">
              你在确认面板里点过「不注册」的程序会记在这里，下次识别不再冒出来。
              误点了、或者改了主意，清空它就行 —— 下一轮识别会重新问你一遍。
            </p>
            <div class="row">
              <button class="btn btn--ghost" :disabled="busy" @click="clearSkipped">
                <Eraser :size="14" />
                清空名单
              </button>
              <span class="hint">当前 {{ skippedCount }} 项</span>
            </div>
          </section>
        </template>

        <!-- --------------------------- 目录整理 --------------------------- -->
        <template v-else-if="tab === 'organize'">
          <section class="panel">
            <div class="sec-head">
              <h2>整理目标目录</h2>
              <button class="btn btn--ghost" @click="pickOrganizeRoot">
                <FolderPlus :size="14" />
                {{ organizeRoot ? '换一个' : '选择目录' }}
              </button>
            </div>
            <p class="sec-desc">
              抱一会把软件按分类归置到这个目录下，比如
              <span class="mono">E:\Toolkit\逆向分析\x64dbg\</span>。
              它和扫描目录是<b>分开的</b> —— 扫描是「去哪里找」，这里是「归到哪里去」，
              把整理目标也加进扫描列表只会让下一轮重扫把搬进来的软件再发现一遍。
            </p>

            <div v-if="organizeRoot" class="datadir">
              <span class="datadir__label">目标位置</span>
              <span class="datadir__path mono truncate" :title="organizeRoot">{{ organizeRoot }}</span>
              <button class="btn btn--subtle" title="清除" @click="clearOrganizeRoot">
                <Trash2 :size="14" />
              </button>
            </div>
            <p v-else class="empty-line">还没有设置，整理功能需要先指定一个目标目录。</p>

            <div class="row">
              <button
                class="btn btn--primary"
                :disabled="!organizeRoot"
                @click="router.push({ name: 'organize' })"
              >
                <FolderTree :size="14" />
                开始整理
              </button>
              <span class="hint">会先出一份方案给你逐条过目，不会直接动文件</span>
            </div>

            <p class="sec-desc sec-desc--foot">
              绿色软件会被<b>剪切</b>到目标目录并把文件夹名规范成英文正式名。
              安装版默认只在目标目录里放一个 junction 链接指向原安装位置 ——
              装过的软件在注册表里留着固定路径，搬走就坏了。
              识别时判定为「可安全移动」的安装版也会剪切，但执行前会再查一遍注册表引用，
              发现问题会在方案里标出来由你决定。
            </p>
          </section>

          <section class="panel">
            <div class="sec-head">
              <h2>整理历史</h2>
              <span class="hint">{{ plans.length }} 次</span>
            </div>
            <p class="sec-desc">
              每次整理都完整记下动过哪些目录，所以任何一次都能原路撤回。
              想撤就趁记录还在 —— 它会跟着「清空识别数据」一起清掉。
            </p>

            <ul v-if="plans.length" class="plans">
              <li v-for="p in plans" :key="p.id">
                <div class="plans__line">
                  <button
                    class="plans__toggle"
                    @click="openPlan = openPlan === p.id ? '' : p.id"
                  >
                    <ChevronDown :size="13" :class="['chev', { 'chev--open': openPlan === p.id }]" />
                    <span>{{ new Date(p.created_at).toLocaleString('sv') }}</span>
                  </button>
                  <span class="plans__sum">
                    移动 {{ planTally(p).moved }}　链接 {{ planTally(p).linked }}
                    <span v-if="planTally(p).failed > 0" class="bad">
                      　失败 {{ planTally(p).failed }}
                    </span>
                  </span>
                  <TagBadge v-if="p.undone_at > 0" label="已撤销" tone="muted" />
                  <button
                    v-else
                    class="btn btn--subtle"
                    :disabled="undoing === p.id"
                    @click="undoPlan(p)"
                  >
                    <Loader2 v-if="undoing === p.id" :size="13" class="spin" />
                    <RotateCcw v-else :size="13" />
                    撤销
                  </button>
                </div>

                <ul v-if="openPlan === p.id" class="steps">
                  <li v-for="(s, i) in p.steps" :key="i" :class="{ bad: !s.ok }">
                    <span class="steps__type">{{ s.type === 'move' ? '移动' : '链接' }}</span>
                    <span class="steps__name truncate" :title="s.name">{{ s.name }}</span>
                    <span class="steps__path mono truncate" :title="`${s.from} → ${s.to}`">
                      {{ s.from }} → {{ s.to }}
                    </span>
                    <span v-if="s.note" class="steps__note">{{ s.note }}</span>
                  </li>
                </ul>
              </li>
            </ul>
            <p v-else class="empty-line">还没有整理过。</p>
          </section>
        </template>

        <!-- --------------------------- AI 配置 --------------------------- -->
        <template v-else-if="tab === 'ai'">
          <section class="panel">
            <div class="sec-head">
              <h2>AI 模型配置</h2>
              <label class="switch">
                <input v-model="enabled" type="checkbox" @change="saveAi" />
                <span>{{ enabled ? '已启用' : '已关闭' }}</span>
              </label>
            </div>

            <div class="profiles">
              <select
                class="input profiles__pick"
                :value="settings.settings.ai_profile_id"
                @change="switchProfile(($event.target as HTMLSelectElement).value)"
              >
                <option value="" disabled>
                  {{ profiles.length ? '选择已存的配置…' : '还没有存过配置' }}
                </option>
                <option v-for="p in profiles" :key="p.id" :value="p.id">
                  {{ p.name }} · {{ p.model }}
                </option>
              </select>
              <input
                v-model="profileName"
                class="input profiles__name"
                spellcheck="false"
                :placeholder="namePlaceholder"
                @keydown.enter="renameProfile"
              />
              <button class="btn btn--subtle" title="把当前填的存成一套" @click="addProfile">
                <Plus :size="14" />
                存为新配置
              </button>
              <button
                class="btn btn--subtle"
                :disabled="!canRename"
                title="用左边的名字重命名当前配置"
                @click="renameProfile"
              >
                <Pencil :size="14" />
              </button>
              <button
                class="btn btn--subtle"
                :disabled="!activeProfile"
                title="删除当前配置"
                @click="removeProfile"
              >
                <Trash2 :size="14" />
              </button>
            </div>

            <div class="form">
              <label class="field">
                <span class="field__label">接口地址</span>
                <input
                  v-model="apiUrl"
                  class="input mono"
                  spellcheck="false"
                  placeholder="https://api.deepseek.com/v1"
                />
              </label>
              <label class="field">
                <span class="field__label">API Key</span>
                <span class="field__wrap">
                  <input
                    v-model="apiKey"
                    class="input mono"
                    :type="keyVisible ? 'text' : 'password'"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="sk-…"
                  />
                  <button
                    class="field__eye"
                    type="button"
                    :title="keyVisible ? '隐藏' : '显示'"
                    @click="keyVisible = !keyVisible"
                  >
                    <EyeOff v-if="keyVisible" :size="14" />
                    <Eye v-else :size="14" />
                  </button>
                </span>
              </label>
              <label class="field">
                <span class="field__label">模型</span>
                <span class="field__wrap">
                  <input
                    v-model="model"
                    class="input mono"
                    list="ai-models"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="deepseek-chat"
                  />
                  <datalist id="ai-models">
                    <option v-for="m in modelList" :key="m" :value="m" />
                  </datalist>
                  <button
                    class="field__eye"
                    type="button"
                    :disabled="modelsLoading"
                    title="拉取模型列表"
                    @click="loadModels"
                  >
                    <Loader2 v-if="modelsLoading" :size="14" class="spin" />
                    <RefreshCw v-else :size="14" />
                  </button>
                </span>
              </label>
            </div>

            <div class="row">
              <button class="btn btn--primary" @click="saveAi">保存配置</button>
              <button class="btn btn--ghost" :disabled="testing" @click="testConnection">
                <Loader2 v-if="testing" :size="14" class="spin" />
                测试连接
              </button>
              <span v-if="aiDirty" class="dirty">「{{ activeProfile?.name }}」有未保存的改动</span>
            </div>

            <p v-if="testResult" class="result" :class="{ 'result--bad': !testResult.ok }">
              {{ testResult.message }}
            </p>

            <p class="sec-desc sec-desc--foot">
              需要一个<b>支持 function calling</b> 的模型，兼容 OpenAI 格式的服务商都能用。
              deepseek-chat、qwen-plus、gpt-4o-mini 都够用。
              「测试连接」会真的发一次工具调用来验证，而不只是看能不能连通 ——
              模型列表里哪些支持工具调用，接口不会告诉你，挑完还是得测一次。
              多套配置存在本地库里，Key 明文存放，和其他设置一样。
            </p>
          </section>
        </template>

        <!-- -------------------------- 搜索服务 -------------------------- -->
        <template v-else-if="tab === 'search'">
          <section class="panel">
            <div class="sec-head">
              <h2>联网搜索</h2>
              <label class="switch" :class="{ 'switch--off': !searchUsable }" :title="switchHint">
                <input
                  v-model="searchEnabled"
                  type="checkbox"
                  :disabled="!searchUsable"
                  @change="toggleSearch"
                />
                <span>{{ searchEnabled && searchUsable ? '已启用' : '已关闭' }}</span>
              </label>
            </div>
            <p class="sec-desc">
              遇到 <span class="mono">AmazTool.exe</span> 这种从文件名和 PE 信息都看不出来是什么的程序时，
              AI 可以自己上网查一下再下结论。一眼能认出的软件（7-Zip、Everything）不会触发搜索，
              不用担心额度被白白消耗。
            </p>
            <p v-if="switchHint" class="hint hint--block">{{ switchHint }}。</p>

            <div class="form">
              <label class="field">
                <span class="field__label">服务商</span>
                <select v-model="searchProvider" class="input">
                  <option v-for="p in PROVIDERS" :key="p.value" :value="p.value">{{ p.label }}</option>
                </select>
              </label>
              <p class="provider-hint">{{ providerHint }}</p>

              <label v-if="needsKey" class="field">
                <span class="field__label">API Key</span>
                <input v-model="searchKey" class="input mono" type="password" placeholder="填入对应服务的 Key" />
              </label>
              <label v-if="needsEndpoint" class="field">
                <span class="field__label">
                  {{ searchProvider === 'searxng' ? '实例地址' : '接口地址（可留空用官方）' }}
                </span>
                <input
                  v-model="searchEndpoint"
                  class="input mono"
                  :placeholder="searchProvider === 'searxng' ? 'http://127.0.0.1:8080' : 'https://api.bing.microsoft.com/v7.0/search'"
                />
              </label>
            </div>

            <div class="row">
              <button class="btn btn--primary" @click="saveSearch">保存配置</button>
              <button
                class="btn btn--ghost"
                :disabled="searchTesting || searchProvider === 'model_builtin'"
                @click="testSearchConn"
              >
                <Loader2 v-if="searchTesting" :size="14" class="spin" />
                测试搜索
              </button>
            </div>

            <p v-if="searchResult" class="result" :class="{ 'result--bad': !searchResult.ok }">
              {{ searchResult.message }}
            </p>

            <p class="sec-desc sec-desc--foot">
              查证顺序是先本地后联网：PE 信息 → 目录里的说明文档 → 联网搜索。
              本地文档往往比搜索更准 —— 它写的就是这一份程序本身。
              开关关掉时 agent 那边根本不会注册 <span class="mono">web_search</span> 工具，
              提示词也会改成「只依据本地信息判断」，不会白花轮数去调一个用不了的工具。
            </p>
          </section>

          <!-- TMDB 用于影视资料补全；首轮本地入库不依赖它。 -->
          <section v-if="activeModule === 'video'" class="panel">
            <div class="sec-head">
              <h2>TMDB 刮削（影视）</h2>
              <label
                class="switch"
                :class="{ 'switch--off': !tmdbUsable }"
                :title="tmdbUsable ? '' : '请先填入 API Key'"
              >
                <input
                  v-model="tmdbEnabled"
                  type="checkbox"
                  :disabled="!tmdbUsable"
                  @change="toggleTmdb"
                />
                <span>{{ tmdbEnabled && tmdbUsable ? '已启用' : '已关闭' }}</span>
              </label>
            </div>
            <p class="sec-desc">
              用于补全影视条目的官方标题、简介、评分、海报和季集表。
              个人 Key 是免费的，在 themoviedb.org 注册后于「设置 › API」页面申领。
              本地扫描不需要填写 Key，已有的 NFO、下载器资料和图片会直接保留。
            </p>
            <p v-if="!tmdbUsable" class="hint hint--block">请先填入 API Key。</p>

            <div class="form">
              <label class="field">
                <span class="field__label">API Key</span>
                <input
                  v-model="tmdbKey"
                  class="input mono"
                  type="password"
                  placeholder="TMDB 的 API Key（v3 auth）"
                />
              </label>
              <!--
                两个域名单独给，不合成一个：接口和图片走的是不同的主机，
                而国内的反代方案常常只代理其中一个
              -->
              <label class="field">
                <span class="field__label">接口域名（可留空用官方）</span>
                <input v-model="tmdbApiDomain" class="input mono" placeholder="api.themoviedb.org" />
              </label>
              <label class="field">
                <span class="field__label">图片域名（可留空用官方）</span>
                <input v-model="tmdbImageDomain" class="input mono" placeholder="image.tmdb.org" />
              </label>
            </div>

            <div class="row">
              <button class="btn btn--primary" @click="saveTmdb">保存配置</button>
              <button class="btn btn--ghost" :disabled="tmdbTesting || !tmdbUsable" @click="testTmdbConn">
                <Loader2 v-if="tmdbTesting" :size="14" class="spin" />
                测试连接
              </button>
            </div>

            <p v-if="tmdbResult" class="result" :class="{ 'result--bad': !tmdbResult.ok }">
              {{ tmdbResult.message }}
            </p>

            <p class="sec-desc sec-desc--foot">
              两个域名各填只填域名，不带 <span class="mono">https://</span> 和路径。
              官方的 <span class="mono">api.themoviedb.org</span> 在国内多数网络下连不上，
              填自己的反代能解决；海报下载只允许走这里填的图片域名，别处的地址一概不收。
            </p>
          </section>

          <!--
            代理。放在 TMDB 之后、日志之前 —— 它服务的是「联网刮削」这一组，
            而不是某一个站。
          -->
          <section v-if="activeModule === 'video'" class="panel">
            <div class="sec-head">
              <h2>出站代理</h2>
            </div>
            <p class="sec-desc">
              代理只用于 Hanime 刮削链路，改完保存即刻生效，不用重启。
            </p>

            <div class="form">
              <label class="field">
                <span class="field__label">代理模式</span>
                <select v-model="proxyMode" class="input">
                  <option value="direct">直连</option>
                  <option value="system">系统代理</option>
                  <option value="http">HTTP 代理</option>
                  <option value="socks5">SOCKS5 代理</option>
                  <option value="custom">自定义规则</option>
                </select>
              </label>
              <div v-if="proxyMode === 'http' || proxyMode === 'socks5'" class="row">
                <label class="field field--grow">
                  <span class="field__label">代理主机</span>
                  <input v-model="proxyHost" class="input mono" placeholder="127.0.0.1" />
                </label>
                <label class="field">
                  <span class="field__label">端口</span>
                  <input v-model.number="proxyPort" class="input input--num mono" type="number" min="1" max="65535" />
                </label>
              </div>
              <label v-if="proxyMode === 'custom'" class="field">
                <span class="field__label">Chromium 代理规则</span>
                <input
                  v-model="proxyRules"
                  class="input mono"
                  placeholder="https=socks5://127.0.0.1:10808;http=direct://"
                />
              </label>
            </div>

            <div class="row">
              <button class="btn btn--primary" @click="saveProxy">保存配置</button>
              <button class="btn btn--ghost" :disabled="proxyChecking" @click="checkProxy">
                <Loader2 v-if="proxyChecking" :size="14" class="spin" />
                查看生效情况
              </button>
            </div>

            <p v-if="proxyResult" class="result" :class="{ 'result--bad': !proxyResult.ok }">
              {{ proxyResult.message }}
            </p>

            <div v-if="hanimeNetwork" class="proxy-status">
              <div class="proxy-status__title" :class="{ 'proxy-status__title--off': !hanimeHosts }">
                <span class="status-dot"></span>
                Hanime 内置 Hosts
                <label class="switch">
                  <input v-model="hanimeHosts" type="checkbox" @change="toggleHanimeHosts" />
                  <span>{{ hanimeHosts ? '已开启' : '已关闭（走系统 DNS）' }}</span>
                </label>
              </div>
              <p class="sec-desc">
                仅覆盖 Hanime 镜像域名，不影响 TMDB、豆瓣或普通图片请求。
                启动时把域名固定到上次通了的地址（没有就是地址池第一个）；连不上时按顺序换下一个重试，通了就记住。
                开关对重试即时生效，对启动规则要重启。
              </p>
              <p v-if="hanimeNetwork.resolverRules" class="sec-desc">
                当前解析规则：<span class="mono">{{ hanimeNetwork.resolverRules }}</span>
              </p>
              <p class="sec-desc">
                地址池：<span class="mono">{{ hanimeNetwork.ips.join(', ') }}</span>
                <template v-if="hanimeNetwork.activeIp">　·　当前改用：<span class="mono">{{ hanimeNetwork.activeIp }}</span></template>
              </p>
              <p class="sec-desc">
                覆盖域名：<span class="mono">{{ hanimeNetwork.hosts.join(', ') }}</span>
              </p>
              <div class="row">
                <button class="btn btn--ghost" :disabled="hanimeVerifying" @click="verifyHanime">
                  <Loader2 v-if="hanimeVerifying" :size="14" class="spin" />
                  打开内置 Cloudflare 验证
                </button>
              </div>
              <p class="sec-desc sec-desc--foot">
                内置 Hosts 负责线路和 DNS；如果站点返回 Cloudflare 挑战，会打开同一专用会话的验证窗口，完成后自动重试刮削。
              </p>
            </div>

            <!--
              这一段是必要的，不是免责声明：只有走 Chromium 网络栈的请求吃这份
              代理，而「配了没反应」是这里最容易出现的现象
            -->
            <p class="sec-desc sec-desc--foot">
              目前只有里番（Hanime）那条刮削链路走代理，TMDB 和豆瓣仍是直连。
              本机回环地址一律不走代理，所以海报那条自定义协议不受影响。
              SOCKS5 和自定义规则由 Chromium 负责最终解析。
            </p>
          </section>

          <section v-if="activeModule === 'video'" class="panel">
            <div class="sec-head">
              <h2>隐藏里番</h2>
              <label class="switch">
                <input v-model="hideHentai" type="checkbox" @change="toggleHideHentai" />
                <span>{{ hideHentai ? '已隐藏' : '正常显示' }}</span>
              </label>
            </div>
            <p class="sec-desc">
              打开后影视侧边栏不再出现「里番」这一格，海报墙也不铺这些条目，
              侧栏的观看状态、类型、标签、归档几处计数都不把它们算进去。
            </p>

            <!--
              边界要写明白，否则它很容易被当成锁用。藏起来的是「浏览时看不见」，
              不是「访问不到」—— 说清楚比让用户自己发现要好
            -->
            <p class="sec-desc sec-desc--foot">
              它只管显示：条目、文件和海报都原样留着，关掉开关立刻回来，
              不改任何数据。设置页这边「影视条目」的总数仍是全库的数字，
              已经打开过的详情页地址也照样能打开。
            </p>
          </section>

          <!-- 额度花在哪了。数据全部从识别日志里现取，不单独记账 -->
          <section class="panel">
            <button class="sec-head sec-head--btn" @click="toggleSearchLog">
              <h2>最近调用日志</h2>
              <ChevronDown :size="14" :class="['chev', { 'chev--open': searchLogOpen }]" />
            </button>

            <template v-if="searchLogOpen">
              <p class="sec-desc">
                最近 20 次 <span class="mono">web_search</span> 调用，从识别日志里提取 ——
                所以时间精确到「哪一次识别」，同一次识别里的几次搜索共用一个时间戳。
                清空识别日志会连带清掉它。
              </p>
              <ul v-if="searchLog.length" class="calls">
                <li v-for="(c, i) in searchLog" :key="i">
                  <span class="calls__time mono">{{ callTime(c.at) }}</span>
                  <span class="calls__q truncate" :title="c.query">{{ c.query }}</span>
                  <span class="calls__from truncate" :title="c.label">{{ c.label }}</span>
                  <span class="calls__ms mono">{{ c.ms > 0 ? `${(c.ms / 1000).toFixed(1)}s` : '—' }}</span>
                  <TagBadge
                    :label="SEARCH_STATUS_META[c.status].label"
                    :tone="SEARCH_STATUS_META[c.status].tone"
                  />
                </li>
              </ul>
              <p v-else class="empty-line">
                还没有搜索调用记录。开启搜索并跑一次识别之后，认不出来的程序会触发它。
              </p>
            </template>
          </section>
        </template>

        <!-- ---------------------------- 外观 ---------------------------- -->
        <template v-else-if="tab === 'appearance'">
          <section class="panel">
            <h2 class="sec-head">主题</h2>
            <div class="row">
              <div class="segmented">
                <button
                  :class="{ on: settings.settings.theme === 'dark' }"
                  @click="settings.patch({ theme: 'dark' })"
                >
                  <Moon :size="14" />
                  深色
                </button>
                <button
                  :class="{ on: settings.settings.theme === 'light' }"
                  @click="settings.patch({ theme: 'light' })"
                >
                  <Sun :size="14" />
                  浅色
                </button>
              </div>
            </div>
          </section>

          <section class="panel">
            <h2 class="sec-head">卡片标题</h2>
            <p class="sec-desc">
              Process Monitor、PowerRun 这类软件本来就没有通行中文名，AI 硬译出来的
              「进程监视器」反而比原名难认。选哪个名字打头由你定，另一个降为副标题。
            </p>
            <div class="form">
              <label class="field">
                <span class="field__label">标题优先</span>
                <select :value="settings.settings.title_lang" class="input" @change="setTitleLang">
                  <option v-for="t in TITLE_LANGS" :key="t.value" :value="t.value">{{ t.label }}</option>
                </select>
              </label>
              <p class="provider-hint">{{ titleLangHint }}</p>
            </div>
          </section>

          <section class="panel">
            <h2 class="sec-head">精简提醒</h2>
            <p class="sec-desc">
              超过设定天数没有动静的软件会被归入「长期未用」，辅助你审视是否还需要它。
              判定不只看你通过抱一启动的记录 —— 抱一还会读软件目录里配置文件的最后修改时间，
              所以刚导入的库不会整片显示成「从未使用」。卡片上实心点是抱一记到的启动，
              空心点是这种从磁盘推出来的近似时间。
            </p>
            <div class="row">
              <input
                v-model.number="unusedDays"
                class="input input--num"
                type="number"
                min="7"
                max="365"
                @blur="setUnusedDays"
              />
              <span class="hint">天</span>
              <span class="hint">当前有 {{ store.counts.unused }} 个软件超期</span>
            </div>
          </section>
        </template>

        <!-- ------------------------ 分类与标签 ------------------------ -->
        <template v-else-if="tab === 'taxonomy'">
          <section class="panel">
            <div class="sec-head">
              <h2>分类</h2>
              <span class="hint">{{ catStore.list.length }} 个</span>
            </div>
            <p class="sec-desc">
              分类按<b>用途</b>分 —— 回答的是「我现在要干这件事，该开哪个」，
              而不是「它属于哪一行」。这份列表和每条的说明会原样注入识别 prompt，
              所以描述写得越准，AI 归类越稳。
            </p>

            <ul class="cats">
              <li v-for="(c, i) in catStore.list" :key="c.id">
                <div class="cats__line">
                  <div class="cats__move">
                    <button :disabled="i === 0" title="上移" @click="shiftCategory(c.id, -1)">
                      <ChevronUp :size="13" />
                    </button>
                    <button
                      :disabled="i === catStore.list.length - 1"
                      title="下移"
                      @click="shiftCategory(c.id, 1)"
                    >
                      <ChevronDown :size="13" />
                    </button>
                  </div>
                  <input
                    class="input"
                    :value="c.name"
                    placeholder="分类名"
                    spellcheck="false"
                    @blur="onCategoryField(c, 'name', $event)"
                    @keydown.enter="($event.target as HTMLInputElement).blur()"
                  />
                  <span class="cats__n">{{ categoryCount.get(c.name) ?? 0 }}</span>
                  <button class="btn btn--subtle" title="删除" @click="dropCategory(c)">
                    <Trash2 :size="14" />
                  </button>
                </div>
                <div class="cats__line cats__line--sub">
                  <input
                    class="input"
                    :value="c.description"
                    placeholder="一句话说明这个分类装什么（会喂给 AI）"
                    spellcheck="false"
                    @blur="onCategoryField(c, 'description', $event)"
                    @keydown.enter="($event.target as HTMLInputElement).blur()"
                  />
                  <input
                    class="input input--icon mono"
                    :value="c.icon"
                    placeholder="图标名"
                    spellcheck="false"
                    @blur="onCategoryField(c, 'icon', $event)"
                    @keydown.enter="($event.target as HTMLInputElement).blur()"
                  />
                </div>
              </li>
            </ul>

            <div class="row row--gap">
              <input
                v-model="newCategory"
                class="input"
                placeholder="新分类名"
                spellcheck="false"
                @keydown.enter="addCategory"
              />
              <button class="btn btn--ghost" :disabled="!newCategory.trim()" @click="addCategory">
                <Plus :size="14" />
                添加
              </button>
            </div>
            <p class="hint hint--block">
              图标填 Lucide 名称。内置了 {{ ICON_NAMES.join('、') }}，填别的会退回通用图标。
            </p>
          </section>

          <section class="panel">
            <div class="sec-head">
              <h2>标签</h2>
              <span class="hint">{{ tags.length }} 个</span>
            </div>
            <p class="sec-desc">
              标签描述<b>特征</b>（便携、开源、CLI），用途交给分类，两边说同一件事就是浪费。
              只有「自建」和「已确认」的会作为标签池注入 prompt —— AI 自己造的词不进池，
              否则它造一个新词下一轮就当既成事实继续用，标签只会越长越碎。
            </p>

            <div class="row">
              <div class="segmented">
                <button :class="{ on: tagFilter === 'all' }" @click="tagFilter = 'all'">全部</button>
                <button :class="{ on: tagFilter === 'ai' }" @click="tagFilter = 'ai'">AI 未确认</button>
                <button :class="{ on: tagFilter === 'fragment' }" @click="tagFilter = 'fragment'">
                  碎片（≤1）
                </button>
              </div>
            </div>

            <ul v-if="visibleTags.length" class="tags">
              <li v-for="t in visibleTags" :key="t.id">
                <input
                  type="checkbox"
                  :checked="mergePick.includes(t.id)"
                  title="勾选后可合并"
                  @change="toggleMerge(t.id)"
                />
                <input
                  class="input"
                  :value="t.name"
                  spellcheck="false"
                  @blur="onTagRename(t, $event)"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <TagBadge :label="TAG_SOURCE_META[t.source].label" :tone="TAG_SOURCE_META[t.source].tone" />
                <span class="tags__n">{{ t.usage_count }}</span>
                <button class="btn btn--subtle" title="删除" @click="dropTag(t)">
                  <Trash2 :size="14" />
                </button>
              </li>
            </ul>
            <p v-else class="empty-line">
              {{ tagFilter === 'all' ? '还没有任何标签，识别几个目录之后就有了。' : '这个筛选下没有标签。' }}
            </p>

            <div v-if="mergePick.length > 0" class="row row--gap">
              <span class="hint">已选 {{ mergePick.length }} 个，并入</span>
              <select v-model.number="mergeInto" class="input input--pick">
                <option :value="null">选择目标标签</option>
                <option v-for="t in tags" :key="t.id" :value="t.id">{{ t.name }}</option>
              </select>
              <button class="btn btn--ghost" :disabled="mergeInto == null" @click="doMerge">
                <Merge :size="14" />
                合并
              </button>
            </div>

            <div class="row row--gap">
              <input
                v-model="newTag"
                class="input"
                placeholder="新标签名"
                spellcheck="false"
                @keydown.enter="addTag"
              />
              <button class="btn btn--ghost" :disabled="!newTag.trim()" @click="addTag">
                <Plus :size="14" />
                添加
              </button>
            </div>
          </section>
        </template>

        <!-- -------------------------- 识别日志 -------------------------- -->
        <template v-else-if="tab === 'logs'">
          <IdentifyLog :resource-kind="activeModule" @retry="retryUnit" />
        </template>
        <!-- -------------------------- 数据管理 -------------------------- -->
        <template v-else-if="tab === 'data'">
          <section class="panel">
            <h2 class="sec-head">数据位置</h2>
            <div class="datadir">
              <span class="datadir__label">存放位置</span>
              <button class="datadir__path mono truncate" :title="dataDir" @click="openDataDir">
                {{ dataDir || '读取中…' }}
              </button>
              <button class="btn btn--subtle" title="在资源管理器中打开" @click="openDataDir">
                <FolderOpen :size="14" />
              </button>
            </div>
            <p class="sec-desc">
              数据库是该目录下的 <span class="mono">baoyi.db</span>，图标缓存在
              <span class="mono">icons/</span>。同目录里 <span class="mono">Cache</span>、
              <span class="mono">GPUCache</span> 那些是 Electron 自己的，与抱一的数据无关。
              所有数据都存在本机，不上传、不同步。
            </p>

            <div class="row">
              <button class="btn btn--ghost" @click="exportJson">
                <Download :size="14" />
                备份全部资料（JSON）
              </button>
              <button class="btn btn--ghost" :disabled="restoringBackup || resetting" @click="restoreJson">
                <FolderOpen :size="14" />
                {{ restoringBackup ? '正在恢复…' : '从备份恢复' }}
              </button>
              <button class="btn btn--ghost" @click="exportMarkdown">
                <Download :size="14" />
                导出软件清单（Markdown）
              </button>
            </div>
            <p class="hint hint--block">
              JSON 备份全部品类的资料、观看记录和任务记录，不包含资源文件或 API 配置。
              恢复前会预览并自动备份当前数据库，确认后重启应用。Markdown 为软件清单。
            </p>
          </section>

          <!--
            存档备份目录。放在「数据管理」而不是新开一个游戏 Tab：这一项回答的是
            「东西存在磁盘哪儿」，和上面的数据位置是同一类问题。游戏详情页里
            备份不出来时也会指到这里。
          -->
          <section class="panel">
            <h2 class="sec-head">存档备份目录</h2>
            <div class="datadir">
              <span class="datadir__label">存放位置</span>
              <button
                class="datadir__path mono truncate"
                :title="backupRoot"
                @click="openBackupRoot"
              >
                {{ backupRoot || '读取中…' }}
              </button>
              <button class="btn btn--subtle" title="在资源管理器中打开" @click="openBackupRoot">
                <FolderOpen :size="14" />
              </button>
            </div>
            <p class="sec-desc">
              游戏详情页里「备份存档」复制出来的拷贝都放在这里，一次备份一个目录，
              目录名是「游戏名_编号 / 时间戳_存档目录名」。抱一不自动备份，
              超出保留上限时也只会问你一句，不会自己删。
            </p>

            <div class="row">
              <button class="btn btn--ghost" @click="pickBackupRoot">
                <FolderPlus :size="14" />
                换一个位置
              </button>
              <button
                v-if="settings.settings.save_backup_root"
                class="btn btn--subtle"
                @click="resetBackupRoot"
              >
                用默认位置
              </button>
              <span class="hint">
                {{
                  settings.settings.save_backup_root
                    ? '已指定，改这里不会搬走已有的备份'
                    : '当前用的是用户数据目录下的 save-backups'
                }}
              </span>
            </div>

            <div class="row">
              <input
                v-model.number="keep"
                class="input input--num"
                type="number"
                min="0"
                max="999"
                @blur="saveKeep"
              />
              <span class="hint">份保留上限</span>
              <span class="hint">
                {{
                  keep > 0
                    ? `同一条存档路径超过 ${keep} 份时，备份完问你要不要删掉最早的几份`
                    : '填 0 表示不限，永不提示'
                }}
              </span>
            </div>
          </section>

          <section class="panel">
            <h2 class="sec-head">统计</h2>
            <ul v-if="stats" class="tally">
              <li><b>{{ stats.software }}</b><span>软件条目</span></li>
              <li><b>{{ stats.games }}</b><span>游戏条目</span></li>
              <li><b>{{ stats.videos }}</b><span>影视条目</span></li>
              <li><b>{{ formatBytes(stats.dbBytes) }}</b><span>数据库</span></li>
              <li><b>{{ stats.icons }}</b><span>图标缓存</span></li>
              <li><b>{{ formatBytes(stats.iconBytes) }}</b><span>图标占用</span></li>
              <li><b>{{ stats.covers }}</b><span>游戏封面</span></li>
              <li><b>{{ formatBytes(stats.coverBytes) }}</b><span>封面占用</span></li>
              <li><b>{{ stats.posters }}</b><span>影视海报</span></li>
              <li><b>{{ formatBytes(stats.posterBytes) }}</b><span>海报占用</span></li>
            </ul>
            <p v-if="stats" class="hint hint--block">
              另有 {{ stats.episodes }} 条季集记录、{{ stats.units }} 条目录记录、{{ stats.logs }}
              条识别日志。图标是缓存，重新识别就能再取；封面和海报是资产 ——
              封面是你亲手指的图，海报多半是刮来的但也可能是你选的，
              两者都只在清空条目时才跟着走。
            </p>
          </section>

          <section class="panel">
            <h2 class="sec-head">重新提取软件图标</h2>
            <p class="sec-desc">
              直接从 exe 的图标资源里取最大那一张（256×256 居多）。
              <b>你亲手换过的图标不会被动。</b>
              这个按钮不联网、不花 token，和「重新识别」是两件事。
            </p>
            <div class="row">
              <button class="btn btn--ghost" :disabled="busy || refreshingIcons" @click="refreshIcons">
                <Loader2 v-if="refreshingIcons" :size="14" class="spin" />
                <Image v-else :size="14" />
                {{ refreshingIcons ? '正在重提' : '重新提取' }}
              </button>
              <span class="hint">
                Windows 有时会对明明带图标的程序回一张通用的空白图，这个按钮绕开它
              </span>
            </div>
          </section>

          <section class="panel panel--danger">
            <h2 class="sec-head">重置</h2>
            <p class="sec-desc">
              两个操作都<b>只清抱一自己的记录，不会删除磁盘上的任何实际软件文件</b>。
              反复调识别效果时用第一个，它保留 API Key、扫描目录和识别日志，
              省得每次重填，也方便和改之前那一轮对照。
            </p>

            <div class="row">
              <button class="btn btn--ghost" :disabled="busy || resetting" @click="reset('library')">
                <Eraser :size="14" />
                清空识别数据
              </button>
              <span class="hint">软件条目 + 待识别目录 + 图标缓存</span>
            </div>

            <div class="row row--gap">
              <button class="btn btn--danger" :disabled="busy || resetting" @click="reset('all')">
                <RotateCcw :size="14" />
                恢复出厂
              </button>
              <span class="hint">连设置、分类、日志一起清，重走引导流程</span>
            </div>
          </section>
        </template>

        <!-- ---------------------------- 关于 ---------------------------- -->
        <template v-else-if="tab === 'about'">
          <section class="panel about">
            <BaoyiLogo :size="52" />
            <div>
              <p class="about__name">
                抱一 <span class="about__ver mono">v{{ info?.version ?? '—' }}</span>
              </p>
              <p class="about__slogan">知止而后得。</p>
              <p class="about__quote">是以圣人抱一为天下式。——《道德经》第二十二章</p>
            </div>
          </section>

          <section class="panel">
            <h2 class="sec-head">这是什么</h2>
            <p class="sec-desc sec-desc--loose">
              抱一把散落在各个盘符里的绿色软件收拢成一面卡片墙，交给 AI 认清每一个是什么、
              能替你解决什么问题，再由你决定留下哪些。
            </p>
            <p class="sec-desc sec-desc--loose">
              不联网同步、不上传任何数据，所有记录都在本机。
            </p>
          </section>

          <section class="panel">
            <h2 class="sec-head">构建信息</h2>
            <dl class="kv">
              <dt>抱一</dt>
              <dd class="mono">v{{ info?.version ?? '—' }}</dd>
              <dt>Electron</dt>
              <dd class="mono">{{ info?.electron ?? '—' }}</dd>
              <dt>Chromium</dt>
              <dd class="mono">{{ info?.chrome ?? '—' }}</dd>
              <dt>Node</dt>
              <dd class="mono">{{ info?.node ?? '—' }}</dd>
              <dt>Vue</dt>
              <dd class="mono">{{ vueVersion }}</dd>
              <dt>分发方式</dt>
              <dd>{{ info?.portable ? '绿色版（数据在程序旁边）' : '装机版（数据在 AppData）' }}</dd>
            </dl>
            <p v-if="info?.portable" class="hint">
              整个文件夹可以直接拷走，库和封面海报都跟着 <code>data\</code> 走。
              删掉 <code>绿色版.txt</code> 会让抱一改用 AppData，届时 <code>data\</code>
              里的数据不会自动搬过去。
            </p>
          </section>

          <section class="panel">
            <h2 class="sec-head">项目主页</h2>
            <div class="row">
              <button class="btn btn--ghost" disabled title="仓库还没公开">
                <Github :size="14" />
                GitHub
              </button>
              <span class="hint">仓库地址确定后会填在这里。</span>
            </div>
          </section>
        </template>
      </div>
    </div>

    <ReportDialog v-if="runReport" :report="runReport" @close="runReport = null" />
  </div>
</template>

<style scoped>
.settings {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 24px;
  background: var(--bg-main);
  border-bottom: 1px solid var(--divider);
}

.head h1 {
  font-size: var(--fs-title);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
}

.head__module {
  font-size: var(--fs-body);
  font-weight: 400;
  color: var(--text-sub);
  padding: 2px 8px;
  border-radius: var(--radius-tag);
  background: var(--bg-overlay);
}

.layout {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 导航自己不滚动，右侧内容区单独滚 —— 长页面里 Tab 始终看得见 */
.nav {
  flex: none;
  width: 172px;
  padding: 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid var(--divider);
  overflow-y: auto;
}

.nav__item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 12px;
  border-radius: var(--radius-btn);
  font-size: var(--fs-body);
  color: var(--text-sub);
  text-align: left;
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease;
}

.nav__item:hover {
  background: var(--hover-surface);
  color: var(--text-main);
}

.nav__item.on {
  background: var(--active-surface);
  color: var(--accent);
}

.body {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 20px 24px 40px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 宽屏下内容贴左会显得空旷，限宽后靠 auto 外边距居中 */
.body > * {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
}

.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 15px;
  font-weight: 500;
  margin-bottom: 6px;
}

.sec-head h2 {
  font-size: 15px;
  font-weight: 500;
}

.sec-desc {
  font-size: var(--fs-tag);
  line-height: 1.8;
  color: var(--text-faint);
  margin-bottom: 14px;
}

/* 说明放在操作下面时，上下留白要反过来 */
.sec-desc--foot {
  margin: 16px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--divider);
}

/* 关于页的正文按段落读，不是控件旁边的补充说明 */
.sec-desc--loose {
  font-size: var(--fs-body);
  color: var(--text-sub);
  margin-bottom: 8px;
}
.sec-desc--loose:last-child {
  margin-bottom: 0;
}

/* 从主页扫描完跳过来时的一次性引导 */
.callout {
  margin-bottom: 12px;
  padding: 9px 12px;
  border-radius: var(--radius-input);
  background: var(--active-surface);
  color: var(--accent);
  font-size: var(--fs-tag);
  line-height: 1.7;
}

.kv {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 8px 12px;
  margin: 0;
  font-size: var(--fs-body);
}

.kv dt {
  color: var(--text-faint);
  font-size: var(--fs-tag);
}

.kv dd {
  margin: 0;
  color: var(--text-sub);
  overflow: hidden;
  text-overflow: ellipsis;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 14px;
}

/* ------------------------- 接口配置的存与切 ------------------------- */
.profiles {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.profiles__pick,
.profiles__name {
  flex: 1;
  min-width: 140px;
}

/* 输入框右侧塞一个小按钮（显示密码 / 拉模型列表） */
.field__wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.field__wrap .input {
  padding-right: 36px;
}

.field__eye {
  position: absolute;
  right: 1px;
  display: grid;
  place-items: center;
  width: 32px;
  height: calc(100% - 2px);
  border-radius: 0 var(--radius-input) var(--radius-input) 0;
  color: var(--text-faint);
}
.field__eye:hover {
  color: var(--text-main);
}
.field__eye:disabled {
  cursor: default;
}

.dirty {
  font-size: var(--fs-tag);
  color: var(--warning);
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.row--gap {
  margin-top: 12px;
}

.panel--danger {
  border-color: color-mix(in srgb, var(--danger) 22%, var(--divider));
}

.datadir {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  margin-bottom: 12px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.datadir__label {
  flex-shrink: 0;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.datadir__path {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-tag);
  color: var(--text-sub);
  text-align: left;
  transition: color var(--t-fast) ease;
}
.datadir__path:hover {
  color: var(--accent);
}

.hint {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  min-width: 0;
}

/* 独占一行的说明，不跟按钮挤在同一条 flex 里 */
.hint--block {
  display: block;
  margin-top: 10px;
  line-height: 1.8;
}

.input--num {
  width: 88px;
}

.input--icon {
  width: 150px;
  flex: none;
}

.input--pick {
  width: 180px;
  flex: none;
}

/* ------------------------------ 分类列表 ------------------------------ */
.cats,
.tags {
  list-style: none;
  margin: 0 0 4px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cats li {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.cats__line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cats__line--sub {
  padding-left: 28px;
}

.cats__move {
  display: flex;
  flex-direction: column;
  flex: none;
}

.cats__move button {
  display: grid;
  place-items: center;
  width: 20px;
  height: 15px;
  color: var(--text-faint);
  transition: color var(--t-fast) ease;
}
.cats__move button:hover:not(:disabled) {
  color: var(--accent);
}
.cats__move button:disabled {
  opacity: 0.3;
  cursor: default;
}

.cats__n,
.tags__n {
  flex: none;
  min-width: 26px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.tags {
  margin-top: 12px;
}

.tags li {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.tags li input[type='checkbox'] {
  flex: none;
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}

.switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-tag);
  color: var(--text-sub);
  cursor: pointer;
}

.switch input {
  accent-color: var(--accent);
  width: 15px;
  height: 15px;
}

/* 配置不全时开关点不动。压淡是为了让「点不动」看起来是有理由的，而不是坏了 */
.switch--off {
  opacity: 0.5;
  cursor: not-allowed;
}
.switch--off input {
  cursor: not-allowed;
}

/* 可折叠的小标题 */
.sec-head--btn {
  width: 100%;
  cursor: pointer;
  color: var(--text-main);
}
.sec-head--btn:hover {
  color: var(--accent);
}

.chev {
  flex: none;
  color: var(--text-faint);
  transition: transform var(--t-fast) ease;
}
.chev--open {
  transform: rotate(180deg);
}

/* ------------------------------ 搜索调用日志 ------------------------------ */
.calls {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.calls li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-tag);
  background: var(--bg-main);
  border: 1px solid var(--divider);
  font-size: var(--fs-tag);
}

.calls__time {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
}

.calls__q {
  flex: 1;
  min-width: 0;
  color: var(--text-main);
}

.calls__from {
  flex: none;
  max-width: 26%;
  color: var(--text-faint);
  font-size: 11px;
}

.calls__ms {
  flex: none;
  width: 44px;
  text-align: right;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.result {
  margin-top: 12px;
  padding: 9px 12px;
  border-radius: var(--radius-input);
  background: var(--success-bg);
  color: var(--success);
  font-size: var(--fs-tag);
  line-height: 1.7;
  word-break: break-all;
}

.result--bad {
  background: var(--danger-bg);
  color: var(--danger);
}

.proxy-status {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--divider);
  border-radius: var(--radius-input);
  background: var(--active-surface);
}

.proxy-status__title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--success);
  font-size: var(--fs-tag);
  font-weight: 600;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}

/* 内置 Hosts 关掉后标题和圆点一起变灰，开关本身仍可点 */
.proxy-status__title--off {
  color: var(--text-faint);
}

.proxy-status__title .switch {
  margin-left: auto;
  font-weight: 400;
  color: var(--text-main);
}

.dirs {
  list-style: none;
  margin: 0 0 14px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dirs li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.dirs li span {
  flex: 1;
  min-width: 0;
  color: var(--text-sub);
}

.empty-line {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  margin-bottom: 14px;
}

.segmented {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: var(--radius-btn);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.segmented button {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: var(--fs-tag);
  color: var(--text-sub);
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease;
}
.segmented button.on {
  background: var(--active-surface);
  color: var(--accent);
}

.bar {
  margin-top: 14px;
  height: 4px;
  border-radius: 2px;
  background: var(--hover-surface);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 200ms ease;
}

/* agent 正在做什么，让识别过程可见而不是干等进度条 */
.agent-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.agent-line__dir {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-hint {
  font-size: var(--fs-tag);
  line-height: 1.7;
  color: var(--text-faint);
  margin: -4px 0 2px;
}

.tally {
  list-style: none;
  display: flex;
  gap: 8px;
  margin: 0;
  padding: 0;
}

.tally li {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.tally b {
  font-size: 17px;
  font-weight: 500;
  font-family: var(--font-mono);
}

.tally span {
  font-size: 11px;
  color: var(--text-faint);
}

.tally li.bad b {
  color: var(--danger);
}

.tally li.lit {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: var(--active-surface);
}
.tally li.lit b {
  color: var(--accent);
}

.notes {
  list-style: none;
  margin: 16px 0 0;
  padding: 14px 0 0;
  border-top: 1px solid var(--divider);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--fs-tag);
}

.notes li {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.notes__line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.notes__line span {
  flex: 1;
  min-width: 0;
  color: var(--text-sub);
}

.notes__reason {
  color: var(--text-faint);
  line-height: 1.6;
}

.notes__reason.bad {
  color: var(--danger);
}

/* ------------------------------ 整理历史 ------------------------------ */
.plans {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plans li {
  padding: 9px 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.plans__line {
  display: flex;
  align-items: center;
  gap: 10px;
}

.plans__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-tag);
  color: var(--text-sub);
  font-variant-numeric: tabular-nums;
  transition: color var(--t-fast) ease;
}
.plans__toggle:hover {
  color: var(--text-main);
}

.plans__sum {
  margin-left: auto;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  white-space: nowrap;
}

.plans__sum .bad {
  color: var(--danger);
}

/* 明细是「出了问题才会展开看」的东西，所以压小、压淡，一行一步 */
.steps {
  list-style: none;
  margin: 9px 0 0;
  padding: 9px 0 0;
  border-top: 1px solid var(--divider);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.steps li {
  display: grid;
  grid-template-columns: 36px minmax(0, 130px) minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  padding: 0;
  border: none;
  background: none;
  font-size: 11px;
}

.steps__type {
  color: var(--text-faint);
}

.steps__name {
  color: var(--text-sub);
}

.steps__path {
  color: var(--text-faint);
}

.steps li.bad .steps__name {
  color: var(--danger);
}

.steps__note {
  grid-column: 2 / -1;
  color: var(--warning);
  line-height: 1.6;
}

.about {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 22px;
}

.about__name {
  font-family: var(--font-display);
  font-size: 19px;
  letter-spacing: 3px;
}

.about__ver {
  font-size: 11px;
  letter-spacing: 0;
  color: var(--text-faint);
}

.about__slogan {
  font-family: var(--font-display);
  font-size: var(--fs-body);
  color: var(--text-sub);
  margin-top: 6px;
}

.about__quote {
  font-family: var(--font-display);
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 6px;
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
