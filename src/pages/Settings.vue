<script setup lang="ts">
import { computed, onMounted, ref, version as vueVersion, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  Eraser,
  FolderOpen,
  FolderPlus,
  Github,
  Globe,
  Info,
  Loader2,
  Merge,
  Moon,
  Palette,
  Plus,
  RotateCcw,
  ScrollText,
  Sun,
  Tags,
  Telescope,
  Trash2
} from 'lucide-vue-next'
import BaoyiLogo from '@/components/BaoyiLogo.vue'
import IdentifyLog from '@/components/IdentifyLog.vue'
import TagBadge from '@/components/TagBadge.vue'
import { useAI } from '@/composables/useAI'
import { useScan } from '@/composables/useScan'
import { useToast } from '@/composables/useToast'
import { useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'
import { useSoftwareStore } from '@/stores/software'
import { formatBytes } from '@/utils'
import type { AppInfo, Category, DataStats, ScanUnit, SearchProvider, Tag, TitleLang } from '@/types'

const route = useRoute()
const router = useRouter()
const settings = useSettingsStore()
const store = useSoftwareStore()
const catStore = useCategoriesStore()
const { success, error, toast } = useToast()
const scan = useScan()
const ai = useAI()

/* -------------------------------- 分页 -------------------------------- */

const TABS = [
  { id: 'scan', label: '扫描与识别', icon: Telescope },
  { id: 'ai', label: 'AI 配置', icon: Bot },
  { id: 'search', label: '搜索服务', icon: Globe },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'taxonomy', label: '分类与标签', icon: Tags },
  { id: 'logs', label: '识别日志', icon: ScrollText },
  { id: 'data', label: '数据管理', icon: Database },
  { id: 'about', label: '关于', icon: Info }
] as const

type TabId = (typeof TABS)[number]['id']

function tabFromRoute(value: unknown): TabId {
  const id = String(Array.isArray(value) ? value[0] : (value ?? '')) as TabId
  return TABS.some((t) => t.id === id) ? id : 'scan'
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

async function saveAi(): Promise<void> {
  await settings.patch({
    ai: {
      api_url: apiUrl.value.trim(),
      api_key: apiKey.value.trim(),
      model: model.value.trim(),
      enabled: enabled.value
    }
  })
  success('AI 配置已保存')
}

async function testConnection(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await window.baoyi.ai.test({
      api_url: apiUrl.value.trim(),
      api_key: apiKey.value.trim(),
      model: model.value.trim(),
      enabled: true
    })
  } finally {
    testing.value = false
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

const providerHint = computed(
  () => PROVIDERS.find((p) => p.value === searchProvider.value)?.hint ?? ''
)
const needsKey = computed(
  () => searchProvider.value !== 'model_builtin' && searchProvider.value !== 'searxng'
)
const needsEndpoint = computed(
  () => searchProvider.value === 'searxng' || searchProvider.value === 'bing'
)

function currentSearchConfig() {
  return {
    provider: searchProvider.value,
    api_key: searchKey.value.trim(),
    endpoint: searchEndpoint.value.trim(),
    enabled: searchEnabled.value
  }
}

async function saveSearch(): Promise<void> {
  await settings.patch({ search: currentSearchConfig() })
  success('搜索配置已保存')
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

const dirs = computed(() => settings.settings.scan_dirs)
const busy = computed(() => scan.running.value || ai.running.value)

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
  await settings.patch({ scan_dirs: [...dirs.value, dir] })
}

async function removeDir(dir: string): Promise<void> {
  await settings.patch({ scan_dirs: dirs.value.filter((d) => d !== dir) })
  await loadUnits()
}

async function runScan(): Promise<void> {
  if (dirs.value.length === 0) {
    toast('先添加至少一个扫描目录')
    return
  }
  const r = await scan.run(dirs.value)
  await Promise.all([store.reload(), loadUnits()])

  // 说清楚三件事：找到多少程序、还要识别几个目录、有几个这次不用再花钱
  const parts = [`发现 ${r.found} 个程序`]
  if (r.pending > 0) {
    parts.push(r.added > 0 ? `${r.pending} 个目录待识别（新增 ${r.added} 个）` : `${r.pending} 个目录待识别`)
  } else {
    parts.push('没有需要识别的目录')
  }
  if (r.settled > 0) parts.push(`${r.settled} 个已识别过，跳过`)
  success(`扫描完成：${parts.join('，')}`)
}

async function runAi(): Promise<void> {
  if (!settings.settings.ai.api_key) {
    error('请先到「AI 配置」填写并保存 API Key')
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
  if (result.registered > 0) void router.push({ name: 'confirm' })
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
  await catStore.load()
  tags.value = await window.baoyi.tags.list()
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
  await catStore.upsert({ ...c, ...patch })
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
  await catStore.upsert({ id: '', name, description: '', icon: 'box', sort_order: max + 1 })
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
  tags.value = await window.baoyi.tags.create(name)
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

async function loadStats(): Promise<void> {
  stats.value = await window.baoyi.data.stats()
}

onMounted(async () => {
  dataDir.value = await window.baoyi.data.dir()
  await loadStats()
})

/* -------------------------------- 关于 -------------------------------- */

const info = ref<AppInfo | null>(null)
onMounted(async () => {
  info.value = await window.baoyi.app.info()
})

function openDataDir(): void {
  void window.baoyi.data.openDir()
}

async function exportJson(): Promise<void> {
  const file = await window.baoyi.data.exportJson()
  if (file) success(`已导出到 ${file}`)
}

async function exportMarkdown(): Promise<void> {
  const file = await window.baoyi.data.exportMarkdown()
  if (file) success(`已导出到 ${file}`)
}

async function reset(mode: 'library' | 'all'): Promise<void> {
  const warning =
    mode === 'library'
      ? `清空所有软件条目、待识别目录和图标缓存，重新开始识别。\n\n保留：API Key、搜索配置、扫描目录、自定义分类、识别日志。\n不会删除磁盘上的任何实际软件文件。\n\n确认继续？`
      : `恢复出厂：连 API Key、搜索配置、扫描目录、自定义分类、识别日志一起清空，并重新走一遍引导流程。\n\n不会删除磁盘上的任何实际软件文件。\n\n确认继续？`
  if (!window.confirm(warning)) return

  resetting.value = true
  try {
    const { summary } = await window.baoyi.data.reset(mode)
    await settings.load()
    await Promise.all([store.reload(), loadUnits(), loadStats()])

    if (mode === 'all') {
      // 出厂状态下 onboarded 为 false，路由守卫会把用户带回引导页
      void router.push({ name: 'onboarding' })
      return
    }

    // 设置页里那几个 ref 是进页面时快照的，重置后要跟着回到当前值
    apiUrl.value = settings.settings.ai.api_url
    apiKey.value = settings.settings.ai.api_key
    model.value = settings.settings.ai.model
    enabled.value = settings.settings.ai.enabled
    testResult.value = null
    searchResult.value = null

    success(
      `已清空 ${summary.software} 个软件条目、${summary.units} 个目录记录、${summary.icons} 个图标缓存`
    )
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
      <button class="btn btn--subtle" @click="router.push({ name: 'home' })">
        <ArrowLeft :size="16" />
        返回
      </button>
      <h1>设置</h1>
    </header>

    <div class="layout">
      <nav class="nav">
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
            <p class="sec-desc">
              扫描本身不花钱也不联网：它只是把每个目录整理成一份待识别清单，
              真正的判断交给下一步的 AI 识别。
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
                <Loader2 v-if="scan.running.value" :size="14" class="spin" />
                立即扫描
              </button>
              <span v-if="scan.running.value" class="hint truncate">{{ scan.phaseLabel.value }}</span>
            </div>

            <div v-if="scan.running.value" class="bar">
              <i :style="{ width: `${scan.percent.value}%` }" />
            </div>
          </section>

          <section class="panel">
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

          <section v-if="skippedCount > 0" class="panel">
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

            <div class="form">
              <label class="field">
                <span class="field__label">接口地址</span>
                <input v-model="apiUrl" class="input mono" placeholder="https://api.deepseek.com/v1" />
              </label>
              <label class="field">
                <span class="field__label">API Key</span>
                <input v-model="apiKey" class="input mono" type="password" placeholder="sk-…" />
              </label>
              <label class="field">
                <span class="field__label">模型</span>
                <input v-model="model" class="input mono" placeholder="deepseek-chat" />
              </label>
            </div>

            <div class="row">
              <button class="btn btn--primary" @click="saveAi">保存配置</button>
              <button class="btn btn--ghost" :disabled="testing" @click="testConnection">
                <Loader2 v-if="testing" :size="14" class="spin" />
                测试连接
              </button>
            </div>

            <p v-if="testResult" class="result" :class="{ 'result--bad': !testResult.ok }">
              {{ testResult.message }}
            </p>

            <p class="sec-desc sec-desc--foot">
              需要一个<b>支持 function calling</b> 的模型，兼容 OpenAI 格式的服务商都能用。
              deepseek-chat、qwen-plus、gpt-4o-mini 都够用。
              「测试连接」会真的发一次工具调用来验证，而不只是看能不能连通。
            </p>
          </section>
        </template>

        <!-- -------------------------- 搜索服务 -------------------------- -->
        <template v-else-if="tab === 'search'">
          <section class="panel">
            <div class="sec-head">
              <h2>联网搜索</h2>
              <label class="switch">
                <input v-model="searchEnabled" type="checkbox" @change="saveSearch" />
                <span>{{ searchEnabled ? '已启用' : '已关闭' }}</span>
              </label>
            </div>
            <p class="sec-desc">
              遇到 <span class="mono">AmazTool.exe</span> 这种从文件名和 PE 信息都看不出来是什么的程序时，
              AI 可以自己上网查一下再下结论。一眼能认出的软件（7-Zip、Everything）不会触发搜索，
              不用担心额度被白白消耗。
            </p>

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
            </p>
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
              图标填 Lucide 名称。侧边栏内置了 bug、bot、search、file-text、
              sliders-horizontal、globe、image、clapperboard、shield、sticky-note、box，
              填别的会退回通用图标。
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
          <IdentifyLog @retry="retryUnit" />
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
                导出为 JSON
              </button>
              <button class="btn btn--ghost" @click="exportMarkdown">
                <Download :size="14" />
                导出为 Markdown
              </button>
            </div>
            <p class="hint hint--block">
              JSON 是完整备份，字段一个不落；Markdown 是给人读的清单，按分类分节，可直接贴进笔记。
            </p>
          </section>

          <section class="panel">
            <h2 class="sec-head">统计</h2>
            <ul v-if="stats" class="tally">
              <li><b>{{ stats.software }}</b><span>软件条目</span></li>
              <li><b>{{ formatBytes(stats.dbBytes) }}</b><span>数据库</span></li>
              <li><b>{{ stats.icons }}</b><span>图标缓存</span></li>
              <li><b>{{ formatBytes(stats.iconBytes) }}</b><span>图标占用</span></li>
            </ul>
            <p v-if="stats" class="hint hint--block">
              另有 {{ stats.units }} 条目录记录、{{ stats.logs }} 条识别日志。
            </p>
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
            </dl>
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

.about {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 22px;
}

.about__name {
  font-family: var(--font-serif);
  font-size: 19px;
  letter-spacing: 3px;
}

.about__ver {
  font-size: 11px;
  letter-spacing: 0;
  color: var(--text-faint);
}

.about__slogan {
  font-family: var(--font-serif);
  font-size: var(--fs-body);
  color: var(--text-sub);
  margin-top: 6px;
}

.about__quote {
  font-family: var(--font-serif);
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
