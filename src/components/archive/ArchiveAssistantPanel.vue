<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { errorMessage } from '@/utils'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDockBoundary } from '@/composables/useFloatingDock'
import { useRoute, useRouter } from 'vue-router'
import {
  Archive,
  ArrowUp,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  History,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Search,
  Settings,
  Square,
  Trash2,
  Undo2,
  X
} from 'lucide-vue-next'
import { useArchiveAssistant, type LiveBlock } from '@/composables/useArchiveAssistant'
import type { ArchiveMemory, ArchiveSource } from '@/types/archive'
import ArchiveMessage from './ArchiveMessage.vue'
import BaoyiLogo from '@/components/ui/BaoyiLogo.vue'

const PANEL_WIDTH_KEY = 'baoyi:archive-panel-width'
const READ_ONLY_TOOLS = new Set([
  'archive_search',
  'archive_get',
  'archive_read',
  'archive_search_text',
  'archive_catalog',
  'archive_project_files',
  'archive_project_search',
  'archive_result',
  'archive_check',
  'archive_actions',
  'archive_history',
  'session_search',
  'skills_list',
  'skill_view'
])

function readSavedWidth(): number {
  try {
    const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY))
    if (Number.isFinite(raw) && raw >= 380 && raw <= 760) return Math.round(raw)
  } catch { /* best-effort */ }
  return 480
}

const a = useArchiveAssistant()
const route = useRoute()
const router = useRouter()
const panel = ref<HTMLElement>()
const dockStyle = useDockBoundary(panel, 'drawer', () => a.open.value)
const panelWidth = ref(readSavedWidth())
const isResizing = ref(false)
const currentPageSource = ref<ArchiveSource | null>(null)
let pageSourceSeq = 0

const panelInlineStyle = computed(() => ({
  ...dockStyle.value,
  ...(a.wide.value ? {} : { '--archive-panel-w': `${panelWidth.value}px` })
}))

function startResize(e: PointerEvent): void {
  if (a.wide.value) return
  e.preventDefault()
  isResizing.value = true
  const startX = e.clientX
  const startWidth = panelWidth.value
  const onMove = (ev: PointerEvent) => {
    const maxW = Math.min(760, Math.max(400, window.innerWidth - 340))
    const next = Math.max(380, Math.min(maxW, Math.round(startWidth + (startX - ev.clientX))))
    panelWidth.value = next
  }
  const onUp = () => {
    isResizing.value = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth.value))
    } catch { /* best-effort */ }
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}

const routeResourceId = computed(() => {
  const paramId = typeof route.params.id === 'string' ? route.params.id : ''
  if (paramId) return paramId
  const recordId = typeof route.query.record === 'string' ? route.query.record : ''
  if (route.path === '/personal' && recordId) return recordId
  return ''
})

watch(
  [routeResourceId, a.open, a.privacyRevision],
  async ([id, opened]) => {
    const seq = ++pageSourceSeq
    if (!opened || !id) {
      currentPageSource.value = null
      return
    }
    try {
      const src = await window.baoyi.archive.source(id)
      if (seq === pageSourceSeq) currentPageSource.value = src
    } catch {
      if (seq === pageSourceSeq) currentPageSource.value = null
    }
  },
  { immediate: true }
)

const unattachedCurrentSource = computed(() => {
  const cur = currentPageSource.value
  if (!cur) return null
  return a.context.value.some((c) => c.id === cur.id) ? null : cur
})

function attachCurrentSource(): void {
  const cur = unattachedCurrentSource.value
  if (!cur) return
  a.context.value.push(cur)
  input.value?.focus()
}

const section = ref<'chat' | 'memory' | 'actions' | 'skills'>('chat')
const history = ref(false)
const query = ref('')
const transcript = ref<HTMLElement>()
const input = ref<HTMLTextAreaElement>()
const followBottom = ref(true)
const memory = ref<ArchiveMemory | null>(null)
const memoryTarget = ref<'user' | 'memory'>('user')
const memoryDraft = ref('')
const memoryOld = ref<string | undefined>()
const memoryBusy = ref(false)
const skills = ref<any>(null)
const renaming = ref('')
const newTitle = ref('')

const title = computed(() => a.sessions.value.find((s) => s.id === a.selected.value)?.title || tr('新对话'))

const blocks = computed<LiveBlock[]>(() => {
  const calls = new Map<string, any>()
  const rows: LiveBlock[] = []
  for (const m of a.messages.value) {
    if (m.role === 'system') continue
    if (m.role === 'assistant') {
      if (m.content) rows.push({ key: String(m.id), role: 'assistant', text: m.content })
      for (const t of m.tool_calls || []) calls.set(t.id, t.function)
    } else if (m.role === 'tool') {
      const t = calls.get(m.tool_call_id || '')
      let args = {}
      try {
        args = JSON.parse(t?.arguments || '{}')
      } catch {
        /* 无法解析的工具参数显示为空对象。 */
      }
      rows.push({
        key: String(m.id),
        role: 'tool',
        text: '',
        name: m.tool_name || t?.name,
        args,
        result: m.content || ''
      })
    } else if (m.role === 'user') {
      rows.push({
        key: String(m.id),
        role: 'user',
        text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      })
    }
  }
  return rows
})

type DisplayRow =
  | { kind: 'single'; key: string; block: LiveBlock }
  | { kind: 'tool-group'; key: string; items: LiveBlock[] }

function isCleanReadOnlyTool(b: LiveBlock): boolean {
  if (b.role !== 'tool' || b.pending || !READ_ONLY_TOOLS.has(b.name || '')) return false
  if (!b.result) return true
  try {
    const parsed = JSON.parse(b.result)
    return !parsed?.error
  } catch {
    return true
  }
}

function groupBlocks(list: LiveBlock[]): DisplayRow[] {
  const out: DisplayRow[] = []
  let i = 0
  while (i < list.length) {
    if (isCleanReadOnlyTool(list[i])) {
      let j = i + 1
      while (j < list.length && isCleanReadOnlyTool(list[j])) j++
      if (j - i >= 2) {
        out.push({ kind: 'tool-group', key: 'group-' + list[i].key, items: list.slice(i, j) })
        i = j
        continue
      }
    }
    out.push({ kind: 'single', key: list[i].key, block: list[i] })
    i++
  }
  return out
}

const displayBlocks = computed(() => groupBlocks(blocks.value))
const displayLive = computed(() => groupBlocks(a.visibleLive.value))

const activeHere = computed(() => a.active.value?.sessionId === a.selected.value)
const turnActionsCount = computed(() => a.turnActions.value.length)
const actionDiffMap = computed(() =>
  new Map(a.actions.value.map((act) => [act.id, actionDiffRows(act.before, act.after)]))
)
const taskStatus = computed(() =>
  a.active.value?.status === 'starting' ? tr("正在准备归档助理…") : activeHere.value ? tr("正在处理，随时可以补充要求") : ''
)

function scroll() {
  const node = transcript.value
  if (node) followBottom.value = node.scrollHeight - node.scrollTop - node.clientHeight < 100
}

watch(
  () => [a.visibleLive.value.length, a.visibleLive.value.at(-1)?.text, blocks.value.length],
  async () => {
    if (!followBottom.value) return
    await nextTick()
    transcript.value?.scrollTo({ top: transcript.value.scrollHeight, behavior: 'instant' })
  }
)
watch(a.privacyRevision, () => {
  memory.value = null
  skills.value = null
  memoryDraft.value = ''
  memoryOld.value = undefined
  memoryBusy.value = false
  history.value = false
  section.value = 'chat'
  renaming.value = ''
  newTitle.value = ''
  query.value = ''
})
watch(a.open, async (opened) => {
  if (opened) {
    section.value = 'chat'
    await nextTick()
    input.value?.focus()
  }
})
watch(a.methodRevision, async () => {
  section.value = 'chat'
  history.value = false
  await nextTick()
  input.value?.focus()
})
watch(query, async (value) => {
  try {
    await a.refreshSessions(value)
  } catch (e) {
    a.error.value = errorMessage(e)
  }
})

async function choose(id: string) {
  history.value = false
  section.value = 'chat'
  followBottom.value = true
  await a.load(id)
}
function fresh() {
  const keepJustAttached = a.context.value.length > 0 && !a.selected.value && !blocks.value.length
  a.newSession(keepJustAttached)
  section.value = 'chat'
  history.value = false
  void nextTick(() => input.value?.focus())
}
async function send() {
  section.value = 'chat'
  followBottom.value = true
  await a.send()
  await nextTick()
  input.value?.focus()
}
function key(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}
async function source(id: string) {
  try {
    const r = await window.baoyi.archive.source(id)
    const base = r.kind === 'software' ? '/detail' : `/${r.kind}`
    if (r.kind === 'personal') {
      await router.push({
        path: '/personal',
        query: { section: r.subtype === 'measurement' || r.subtype === 'metric' ? 'state' : r.subtype || 'overview' }
      })
    } else {
      await router.push(`${base}/${encodeURIComponent(r.id)}`)
    }
    if (window.innerWidth < 1080) a.open.value = false
  } catch (e) {
    a.error.value = errorMessage(e)
  }
}
async function view(value: typeof section.value) {
  section.value = value
  history.value = false
  a.error.value = ''
  const scope = a.privacyRevision.value
  try {
    if (value === 'memory') {
      memory.value = null
      const result = await window.baoyi.archive.memory()
      if (scope === a.privacyRevision.value) memory.value = result
    }
    if (value === 'actions') {
      const result = await window.baoyi.archive.actions(a.selected.value || undefined)
      if (scope === a.privacyRevision.value) a.actions.value = result
    }
    if (value === 'skills') {
      skills.value = null
      const result = await window.baoyi.archive.skills()
      if (scope === a.privacyRevision.value) skills.value = result
    }
  } catch (e) {
    if (scope === a.privacyRevision.value) a.error.value = errorMessage(e)
  }
}
function editMemory(target: 'user' | 'memory', text?: string) {
  memoryTarget.value = target
  memoryOld.value = text
  memoryDraft.value = text || ''
}
async function saveMemory(remove = false, text = memoryOld.value, target = memoryTarget.value) {
  memoryBusy.value = true
  a.error.value = ''
  const scope = a.privacyRevision.value
  try {
    const result = await window.baoyi.archive.editMemory({
      target,
      action: remove ? 'remove' : text ? 'replace' : 'add',
      oldText: text,
      content: memoryDraft.value
    })
    if (scope !== a.privacyRevision.value) return
    memory.value = result
    memoryOld.value = undefined
    memoryDraft.value = ''
    a.notice.value = remove ? tr("记忆已删除") : tr("记忆已保存，下次对话会使用")
  } catch (e) {
    if (scope === a.privacyRevision.value) a.error.value = errorMessage(e)
  } finally {
    if (scope === a.privacyRevision.value) memoryBusy.value = false
  }
}
async function archiveSession(id: string) {
  try {
    await window.baoyi.archive.archive(id)
    if (a.selected.value === id) fresh()
    await a.refreshSessions(query.value)
  } catch (e) {
    a.error.value = errorMessage(e)
  }
}
async function rename() {
  try {
    await window.baoyi.archive.rename(renaming.value, newTitle.value)
    renaming.value = ''
    await a.refreshSessions(query.value)
  } catch (e) {
    a.error.value = errorMessage(e)
  }
}

const ACTION_FIELD_LABELS: Record<string, string> = {
  get name() { return tr('名称') },
  get type() { return tr('分类') },
  get category() { return tr('分类') },
  get groupId() { return tr('分类') },
  get customGroupId() { return tr('分组') },
  get group() { return tr('分组') },
  get author() { return tr('作者') },
  get counterpart() { return tr('相关方') },
  get issuedOn() { return tr('日期') },
  get expiresOn() { return tr('到期日') },
  get summary() { return tr('摘要') },
  get description() { return tr("简介") },
  get notes() { return tr('笔记') },
  get body() { return tr('正文') },
  get tags() { return tr('标签') },
  get readState() { return tr('阅读状态') },
  get read() { return tr('已读') },
  get submodule() { return tr('所属子库') },
  get favorite() { return tr('收藏') },
  get pinned() { return tr('置顶') },
  get source() { return tr('来源') },
  get state() { return tr('状态') },
  get publication() { return tr('出版信息') },
  get data() { return tr('扩展属性') }
}
const ENUM_VALUE_LABELS: Record<string, Record<string, string>> = {
  readState: { get unread() { return tr('未读') }, get reading() { return tr('在读') }, get finished() { return tr('已读') } },
  submodule: { get archive() { return tr('资料') }, get reading() { return tr('阅读') } },
  source: { get unknown() { return tr('来源未标记') }, get self() { return tr('自己建立') }, get 'third-party'() { return tr('第三方') }, get mixed() { return tr('混合来源') } },
  state: { get active() { return tr('使用中') }, get maintaining() { return tr('维护中') }, get paused() { return tr('已暂停') }, get completed() { return tr('已完成') }, get archived() { return tr('已归档') } },
  publication: { get ongoing() { return tr('连载中') }, get completed() { return tr('已完结') } }
}
function formatFieldValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return tr('（空）')
  if (typeof v === 'boolean') return v ? tr('是') : tr('否')
  if (typeof v === 'string' && ENUM_VALUE_LABELS[key]?.[v]) return ENUM_VALUE_LABELS[key][v]
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join('、') : tr('（无）')
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => val !== undefined && val !== '')
    return entries.length ? entries.map(([k, val]) => `${k}: ${String(val)}`).join('；') : tr('（无）')
  }
  return String(v)
}
function actionDiffRows(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const b = before ?? {}
  const aObj = after ?? {}
  const keys = [...new Set([...Object.keys(b), ...Object.keys(aObj)])].filter((k) => k !== '_protection')
  return keys
    .filter((k) => JSON.stringify(b[k] ?? null) !== JSON.stringify(aObj[k] ?? null))
    .map((k) => ({
      key: k,
      label: ACTION_FIELD_LABELS[k] || k,
      before: before ? formatFieldValue(k, b[k]) : tr("尚未创建"),
      after: after ? formatFieldValue(k, aObj[k]) : tr("已移除")
    }))
}
function changeText(value: Record<string, unknown> | null) {
  return value ? JSON.stringify(value, (key, item) => (key === '_protection' ? undefined : item), 2) : tr('尚未创建')
}
function shortcut(e: KeyboardEvent) {
  if (e.isComposing || document.querySelector?.('dialog[open]')) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
    e.preventDefault()
    if (a.open.value) a.open.value = false
    else void a.show()
  }
  if (e.key === 'Escape' && a.open.value) {
    e.preventDefault()
    if (history.value) history.value = false
    else a.open.value = false
  }
}
onMounted(() => window.addEventListener('keydown', shortcut))
onBeforeUnmount(() => window.removeEventListener('keydown', shortcut))
</script>

<template>
  <aside
    ref="panel"
    v-show="a.open.value"
    class="archive-panel"
    :style="panelInlineStyle"
    :class="{ wide: a.wide.value, resizing: isResizing }"
    :aria-label="$t('归档助理')"
  >
    <div v-if="!a.wide.value" class="panel-resizer" :title="$t('拖拽调整宽度')" @pointerdown="startResize" />
    <header class="panel-top">
      <BaoyiLogo :size="24" />
      <div>
        <strong>{{ $t("归档助理") }}</strong>
        <small>{{ a.busy.value ? $t('任务进行中') : $t('找回、理解、整理你的收藏') }}</small>
      </div>
      <button class="icon" :title="$t('历史对话')" :aria-label="$t('历史对话')" @click="history = !history">
        <History :size="17" />
      </button>
      <button class="icon" :title="$t('新对话')" :aria-label="$t('新对话')" @click="fresh">
        <Plus :size="18" />
      </button>
      <button class="icon expand" :title="a.wide.value ? $t('缩小') : $t('展开')" @click="a.wide.value = !a.wide.value">
        <Minimize2 v-if="a.wide.value" :size="16" />
        <Maximize2 v-else :size="16" />
      </button>
      <button class="icon" :title="$t('收起助理 · Ctrl J')" :aria-label="$t('收起归档助理')" @click="a.open.value = false">
        <X :size="18" />
      </button>
    </header>

    <nav class="panel-nav">
      <button :class="{ on: section === 'chat' }" @click="view('chat')">{{ $t("对话") }}</button>
      <button :class="{ on: section === 'memory' }" @click="view('memory')">{{ $t("记忆") }}</button>
      <button :class="{ on: section === 'actions' }" @click="view('actions')">{{ $t("修改记录") }}</button>
      <button :class="{ on: section === 'skills' }" @click="view('skills')">{{ $t("归档方法") }}</button>
      <span v-if="a.selected.value" :title="title">{{ title }}</span>
    </nav>

    <div v-if="a.error.value" class="banner error" role="alert">
      {{ $systemMessage(a.error.value) }}
      <button class="icon" :aria-label="$t('关闭提示')" @click="a.error.value = ''"><X :size="13" /></button>
    </div>
    <div v-if="a.notice.value" class="banner" role="status">
      {{ a.notice.value }}
      <button class="icon" :aria-label="$t('关闭提示')" @click="a.notice.value = ''"><X :size="13" /></button>
    </div>

    <section v-if="history" class="history-pane">
      <div class="history-heading">
        <button class="icon" :aria-label="$t('返回对话')" @click="history = false"><ChevronLeft :size="18" /></button>
        <h3>{{ $t("历史对话") }}</h3>
        <span>{{ a.sessions.value.length }}</span>
      </div>
      <label class="search">
        <Search :size="15" />
        <input v-model="query" :placeholder="$t('搜索历史对话')" :aria-label="$t('搜索历史对话')" />
      </label>
      <p v-if="!a.sessions.value.length" class="muted">{{ $t("还没有匹配的对话。完成的任务会保留在这里。") }}</p>
      <article v-for="s in a.sessions.value" :key="s.id" class="history-row" :class="{ selected: s.id === a.selected.value }">
        <form v-if="renaming === s.id" @submit.prevent="rename">
          <input v-model="newTitle" :aria-label="$t('对话标题')" maxlength="100" />
          <button class="icon" :aria-label="$t('保存标题')"><Check :size="16" /></button>
        </form>
        <button v-else class="session-title" @click="choose(s.id)">
          <strong>{{ s.title || $t('归档对话') }}</strong>
          <small>{{ $t("{p0} · {p1} 条记录", {p0: (new Date((s.last_active || s.started_at) * 1000).toLocaleDateString($locale)), p1: (s.message_count)}) }}</small>
        </button>
        <button class="icon" :title="$t('重命名')" :aria-label="$t('重命名对话')" @click="renaming = s.id; newTitle = s.title">
          <Pencil :size="13" />
        </button>
        <button
          class="icon"
          :title="$t('收起这段历史')"
          :aria-label="$t('收起这段历史')"
          :disabled="a.active.value?.sessionId === s.id"
          @click="archiveSession(s.id)"
        >
          <Archive :size="13" />
        </button>
      </article>
    </section>

    <template v-else-if="section === 'chat'">
      <div ref="transcript" class="transcript" @scroll="scroll">
        <div v-if="!blocks.length && !a.visibleLive.value.length && !a.loading.value" class="welcome">
          <span class="eyebrow">{{ $t("你的归档，可以直接问") }}</span>
          <h2>{{ $t("想找什么，") }}<br />{{ $t("或整理些什么？") }}</h2>
          <p>{{ $t("从已收藏的资料里找答案，也把零散的记录整理妥当。") }}</p>
          <div class="starters">
            <button @click="a.draft.value = $t('帮我看看最近归档了什么，按类型简要整理，并附上来源。'); input?.focus()">
              <History :size="17" /><span>{{ $t("看看最近收藏了什么") }}</span>
            </button>
            <button @click="a.draft.value = $t('查找资料库中可能找不到原文件的资料，先核验并告诉我结果。'); input?.focus()">
              <FileText :size="17" /><span>{{ $t("检查资料还能不能打开") }}</span>
            </button>
            <button @click="a.draft.value = $t('帮我整理文库里尚未归类的资料，先阅读必要内容，再建议适合的分类和标签。'); input?.focus()">
              <BookOpen :size="17" /><span>{{ $t("理一理还没归好的资料") }}</span>
            </button>
          </div>
          <div v-if="!a.configured.value" class="setup">
            <p>{{ $t("连接你的模型，就可以开始。") }}</p>
            <button @click="router.push({ name: 'settings', query: { scope: 'global', tab: 'ai' } }); a.open.value = false">
              <Settings :size="14" />{{ $t("配置 AI 模型") }}</button>
          </div>
        </div>

        <p v-if="a.loading.value" class="muted">{{ $t("正在读取对话…") }}</p>

        <template v-for="row in displayBlocks" :key="row.key">
          <ArchiveMessage v-if="row.kind === 'single'" :block="row.block" @source="source" />
          <details v-else class="tool-group">
            <summary>
              <Check :size="13" />
              <span>{{ $t("已查阅 {p0} 步资料记录", {p0: (row.items.length)}) }}</span>
              <ChevronRight class="chevron" :size="13" />
            </summary>
            <div class="tool-group__body">
              <ArchiveMessage v-for="item in row.items" :key="item.key" :block="item" @source="source" />
            </div>
          </details>
        </template>

        <template v-for="row in displayLive" :key="row.key">
          <ArchiveMessage v-if="row.kind === 'single'" :block="row.block" @source="source" />
          <details v-else class="tool-group">
            <summary>
              <Check :size="13" />
              <span>{{ $t("已查阅 {p0} 步资料记录", {p0: (row.items.length)}) }}</span>
              <ChevronRight class="chevron" :size="13" />
            </summary>
            <div class="tool-group__body">
              <ArchiveMessage v-for="item in row.items" :key="item.key" :block="item" @source="source" />
            </div>
          </details>
        </template>

        <div v-if="a.selected.value && turnActionsCount > 1 && !activeHere" class="turn-actions-bar">
          <span>{{ $t("本轮已修改 {p0} 处资料", {p0: (turnActionsCount)}) }}</span>
          <button type="button" @click="view('actions')">{{ $t("查看明细") }}</button>
          <button type="button" :disabled="a.busy.value" @click="a.undoAll()">
            <Undo2 :size="12" />{{ $t("一键撤回本轮修改") }}</button>
        </div>

        <div v-if="activeHere" class="working" role="status"><span class="pulse" />{{ taskStatus }}</div>
        <div
          v-else-if="a.lastRun.value && a.lastRun.value.sessionId === a.selected.value && ['interrupted', 'failed'].includes(a.lastRun.value.status)"
          class="resume"
        >
          <strong>{{ a.lastRun.value.status === 'failed' ? $t('这次任务尚未完成') : $t('任务已暂停') }}</strong>
          <p>{{ a.lastRun.value.error || $t('已完成的操作保留在历史中，可以从这里继续。') }}</p>
          <button @click="a.draft.value = $t('继续上次任务，先核对已经完成的操作和当前状态。'); send()">{{ $t("继续处理") }}</button>
        </div>
      </div>

      <button v-if="a.active.value && !activeHere" class="other-task" @click="choose(a.active.value.sessionId)">{{ $t("有一个归档任务正在进行 · 返回查看") }}</button>

      <form class="composer" @submit.prevent="send">
        <div v-if="a.context.value.length || unattachedCurrentSource" class="context">
          <template v-if="a.context.value.length">
            <span>{{ $t("附带资料") }}</span>
            <button v-for="(item, i) in a.context.value" :key="item.id" type="button" :title="item.name" @click="a.context.value.splice(i, 1)">
              <FileText :size="12" />{{ item.name }}<X :size="12" />
            </button>
          </template>
          <button
            v-if="unattachedCurrentSource"
            type="button"
            class="attach-current"
            :title="$t('把当前页面正在查看的「') + unattachedCurrentSource.name + $t('」附带进对话')"
            @click="attachCurrentSource"
          >
            <Plus :size="12" />{{ $t("附带当前条目：{p0}", {p0: (unattachedCurrentSource.name)}) }}
          </button>
        </div>
        <textarea
          ref="input"
          v-model="a.draft.value"
          :placeholder="activeHere ? $t('补充要求，直接交给当前任务…') : $t('描述你想找的资料，或交代一件归档的事…')"
          :aria-label="$t('给归档助理发消息')"
          maxlength="30000"
          rows="3"
          @keydown="key"
        />
        <div class="composer-footer">
          <select v-model="a.profileId.value" :aria-label="$t('助理使用的模型')" :disabled="a.busy.value">
            <option value="">{{ a.model.value || $t('全局模型') }}</option>
            <option v-for="p in a.profiles.value" :key="p.id" :value="p.id">{{ p.name }} · {{ p.model }}</option>
          </select>
          <span>{{ $t("Shift Enter 换行") }}</span>
          <button v-if="a.busy.value" class="stop" type="button" :aria-label="$t('停止任务')" @click="a.stop">
            <Square :size="12" />{{ $t("停止") }}</button>
          <button
            class="send"
            type="submit"
            :disabled="!a.draft.value.trim() || a.sending.value"
            :aria-label="activeHere ? $t('补充要求') : $t('发送消息')"
            :title="activeHere ? $t('补充要求') : $t('发送')"
          >
            <ArrowUp :size="18" />
          </button>
        </div>
      </form>
    </template>

    <section v-else-if="section === 'memory'" class="secondary-pane">
      <div class="section-heading">
        <span class="eyebrow">{{ $t("让下次交流更顺手") }}</span>
        <h2>{{ $t("记住你的归档习惯") }}</h2>
        <p>{{ $t("明确保存的偏好会用于后续对话。随时修改或删除。") }}</p>
      </div>
      <template v-for="target in ['user', 'memory'] as const" :key="target">
        <div class="memory-title">
          <h3>{{ target === 'user' ? $t('关于你与偏好') : $t('长期背景') }}</h3>
          <button @click="editMemory(target)"><Plus :size="13" />{{ $t("添加") }}</button>
        </div>
        <p v-if="!memory?.[target].length" class="muted">{{ $t("尚未保存内容") }}</p>
        <article v-for="entry in memory?.[target] || []" :key="entry" class="memory-entry">
          <p>{{ entry }}</p>
          <button class="icon" :aria-label="$t('编辑记忆')" :disabled="a.busy.value" @click="editMemory(target, entry)">
            <Pencil :size="14" />
          </button>
          <button class="icon" :aria-label="$t('删除记忆')" :disabled="a.busy.value || memoryBusy" @click="saveMemory(true, entry, target)">
            <Trash2 :size="14" />
          </button>
        </article>
      </template>
      <form class="memory-editor" @submit.prevent="saveMemory()">
        <label>
          {{ memoryOld ? $t('修改') : $t('添加') }}{{ memoryTarget === 'user' ? $t('偏好') : $t('背景') }}
          <textarea
            v-model="memoryDraft"
            rows="4"
            :placeholder="$t('例如：同一资料的不同版本都保留，文件名里保留年份。')"
            :aria-label="$t('记忆内容')"
          />
        </label>
        <button :disabled="!memoryDraft.trim() || a.busy.value || memoryBusy">{{ memoryBusy ? $t('保存中…') : $t('保存记忆') }}</button>
        <small v-if="a.busy.value">{{ $t("当前任务结束后可修改记忆。") }}</small>
      </form>
    </section>

    <section v-else-if="section === 'actions'" class="secondary-pane">
      <div class="section-heading">
        <span class="eyebrow">{{ $t("每次整理都有来处") }}</span>
        <h2>{{ a.selected.value ? $t('本次对话的修改') : $t('最近的修改') }}</h2>
        <p>{{ $t("撤销会核对当前内容，保留你后来的手动编辑。") }}</p>
        <button
          v-if="a.selected.value && turnActionsCount > 1"
          type="button"
          class="batch-undo"
          :disabled="a.busy.value"
          @click="a.undoAll()"
        >
          <Undo2 :size="13" />{{ $t("一键撤回本轮修改（{p0}）", {p0: (turnActionsCount)}) }}</button>
      </div>
      <p v-if="!a.actions.value.length" class="muted">{{ $t("这里会记录归档助理保存的资料修改，随时可以核对或撤销。") }}</p>
      <article v-for="action in a.actions.value" :key="action.id" class="change">
        <div>
          <button class="source-title" @click="source(action.targetId)">{{ action.name }}</button>
          <small>{{ new Date(action.createdAt).toLocaleString($locale) }}</small>
        </div>
        <p>{{ $systemMessage(action.reason) }}</p>
        <div v-if="actionDiffMap.get(action.id)?.length" class="diff-rows">
          <div v-for="row in actionDiffMap.get(action.id)" :key="row.key" class="diff-row">
            <span class="diff-row__label">{{ row.label }}</span>
            <span class="diff-row__from">{{ row.before }}</span>
            <span class="diff-row__sep">→</span>
            <span class="diff-row__to">{{ row.after }}</span>
          </div>
        </div>
        <details class="raw-diff">
          <summary>{{ $t("查看原始字段记录") }}</summary>
          <div class="diff">
            <pre>{{ changeText(action.before) }}</pre>
            <pre>{{ changeText(action.after) }}</pre>
          </div>
        </details>
        <button :disabled="action.state === 'undone' || a.busy.value" @click="a.undo(action.id)">
          <Undo2 :size="13" />{{ action.state === 'undone' ? $t('已撤销') : $t('撤销这次修改') }}
        </button>
      </article>
    </section>

    <section v-else class="secondary-pane">
      <div class="section-heading">
        <span class="eyebrow">{{ $t("把有效做法留下来") }}</span>
        <h2>{{ $t("可复用的归档方法") }}</h2>
        <p>{{ $t("助理会按任务读取相关方法。你也可以在对话中要求保存、改进或删除某个方法。") }}</p>
      </div>
      <div v-if="skills" class="skill-list">
        <article v-for="skill in skills.skills || []" :key="skill.name">
          <BookOpen :size="18" />
          <div>
            <strong>{{ skill.name === 'document-deep-reader' ? $t('文档精读') : skill.name }}</strong>
            <p>{{ skill.description }}</p>
            <button class="method-load" :disabled="a.busy.value" @click="a.loadMethod(skill.name)">{{ $t("加载到输入框") }}</button>
          </div>
        </article>
        <p v-if="!skills.skills?.length" class="muted">{{ $t("还没有保存归档方法。完成一项任务后，可以告诉助理“把这套做法记下来”。") }}</p>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.archive-panel {
  position: fixed;
  right: 0;
  top: var(--titlebar-h, 40px);
  bottom: 0;
  width: min(var(--archive-panel-w, 480px), 100vw);
  z-index: 100;
  background: var(--bg-main);
  border-left: 1px solid var(--divider);
  box-shadow: -8px 0 32px #0002;
  display: flex;
  flex-direction: column;
  color: var(--text-main);
  font-size: 13px;
  transition: width 0.18s ease;
}

.archive-panel.resizing {
  transition: none;
  user-select: none;
}

.archive-panel.wide {
  width: min(980px, calc(100vw - 64px));
}

.panel-resizer {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 2;
}

.panel-resizer:hover,
.archive-panel.resizing .panel-resizer {
  background: color-mix(in srgb, var(--accent) 45%, transparent);
}

.panel-top {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 19px 20px 16px;
}
.panel-top > div {
  flex: 1;
}
.panel-top strong {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.06em;
}
.panel-top small {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

button,
input,
textarea,
select {
  font: inherit;
}
button {
  cursor: pointer;
  color: inherit;
  background: none;
  border: 0;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}

.icon {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  flex-shrink: 0;
}
.icon:hover {
  background: var(--hover-surface);
}

.panel-nav {
  display: flex;
  align-items: center;
  gap: 20px;
  border-bottom: 1px solid var(--divider);
  padding: 0 24px;
}
.panel-nav > button {
  padding: 11px 0;
  color: var(--text-muted);
  white-space: nowrap;
  border-bottom: 2px solid transparent;
}
.panel-nav .on {
  color: var(--accent-ink, var(--accent));
  border-color: var(--accent);
}
.panel-nav > span {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 11px;
  max-width: 120px;
}

.transcript {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 28px 24px;
  scrollbar-gutter: stable;
}

.tool-group {
  margin: 6px 0;
  border: 1px solid var(--divider);
  border-radius: 9px;
  font-size: 12px;
  background: var(--bg-card, var(--bg-main));
}

.tool-group > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  cursor: pointer;
  color: var(--text-sub);
  list-style: none;
}

.tool-group > summary > span {
  flex: 1;
}

.tool-group[open] > summary .chevron {
  transform: rotate(90deg);
}

.tool-group__body {
  padding: 0 10px 8px;
}

.turn-actions-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--divider);
  background: var(--active-surface);
  font-size: 12px;
  color: var(--text-sub);
}

.turn-actions-bar > span {
  flex: 1;
}

.turn-actions-bar > button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent-ink, var(--accent));
  font-size: 12px;
}

.welcome {
  padding: 46px 8px 28px;
  max-width: 580px;
  margin: auto;
}
.eyebrow {
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--accent-ink, var(--accent));
}
h2 {
  font-family: var(--font-ui);
  font-size: 29px;
  line-height: 1.5;
  font-weight: 500;
  letter-spacing: 0.04em;
  margin: 15px 0;
}
.welcome > p,
.section-heading p {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.8;
  max-width: 370px;
}

.starters {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-top: 30px;
}
.starters button {
  display: flex;
  align-items: center;
  gap: 14px;
  text-align: left;
  padding: 15px 16px;
  border: 1px solid var(--divider);
  border-radius: 9px;
  background: var(--bg-card, var(--bg-main));
}
.starters button:hover {
  border-color: var(--accent);
  background: var(--hover-surface);
}
.starters svg {
  color: var(--accent);
}

.setup {
  padding: 16px 0;
  color: var(--text-sub);
}
.setup button,
.resume button,
.memory-editor > button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 13px;
  border-radius: 7px;
  background: var(--accent);
  color: var(--accent-contrast, #fff);
}

.composer {
  margin: 0 18px 18px;
  border: 1px solid var(--divider);
  border-radius: 13px;
  background: var(--bg-card, var(--bg-main));
  box-shadow: 0 3px 12px #0001;
  padding: 12px 14px 10px;
}
.composer:focus-within {
  border-color: var(--accent);
}
.composer textarea {
  display: block;
  width: 100%;
  min-height: 64px;
  max-height: 200px;
  resize: vertical;
  border: 0;
  background: none;
  outline: 0;
  color: var(--text-main);
  line-height: 1.7;
  font-size: 14px;
}
.composer-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 7px;
}
.composer-footer select {
  min-width: 0;
  max-width: 180px;
  flex: 1;
  border: 0;
  background: var(--bg-main);
  color: var(--text-muted);
  font-size: 11px;
}
.composer-footer > span {
  font-size: 10px;
  color: var(--text-muted);
  margin-left: auto;
}
.send {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--accent);
  color: white;
  display: grid;
  place-items: center;
}
.stop {
  display: flex;
  gap: 5px;
  align-items: center;
  font-size: 12px;
}

.context {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 10px;
  font-size: 11px;
  color: var(--text-muted);
}
.context > span {
  padding: 4px 0;
}
.context button {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 240px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 5px;
  padding: 4px 7px;
  background: var(--active-surface);
}
.context button.attach-current {
  border: 1px dashed var(--divider-strong);
  background: transparent;
  color: var(--text-sub);
}
.context button.attach-current:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.working {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12px;
  color: var(--text-muted);
  padding: 16px 0;
}
.pulse {
  width: 6px;
  height: 6px;
  background: var(--accent);
  border-radius: 50%;
  animation: pulse 1.2s ease infinite;
}
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--active-surface);
  padding: 9px 18px;
  font-size: 12px;
  line-height: 1.6;
}
.error {
  color: var(--danger, #c46b5b);
}
.muted {
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-muted);
}
.other-task {
  padding: 10px;
  color: var(--accent);
  border-top: 1px solid var(--divider);
}
.resume {
  margin: 16px 0;
  padding: 16px;
  border: 1px solid var(--divider);
  border-radius: 9px;
}
.resume p {
  font-size: 12px;
  color: var(--text-sub);
}

.history-pane,
.secondary-pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px 28px;
}
.history-heading {
  display: flex;
  gap: 10px;
  align-items: center;
}
.history-heading h3 {
  flex: 1;
}
.history-heading span {
  color: var(--text-muted);
}
.search {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--divider);
  padding: 10px 12px;
  border-radius: 8px;
  margin-bottom: 20px;
  transition: border-color var(--t-fast) ease;
}
.search:focus-within {
  border-color: var(--accent);
}
.search input {
  border: 0;
  outline: 0;
  background: none;
  color: inherit;
  width: 100%;
}
.history-row {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--divider);
  padding: 9px 0;
}
.session-title {
  flex: 1;
  text-align: left;
  min-width: 0;
  padding: 8px;
}
.session-title strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.session-title small {
  display: block;
  margin-top: 6px;
  color: var(--text-muted);
  font-size: 10px;
}
.history-row.selected {
  background: var(--active-surface);
  border-radius: 7px;
}
.history-row form {
  display: flex;
  flex: 1;
}
.history-row input {
  background: none;
  border: 1px solid var(--divider);
  color: inherit;
  min-width: 0;
  width: 100%;
}
.section-heading {
  margin: 10px 0 30px;
}
.section-heading h2 {
  font-size: 23px;
}

.batch-undo {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding: 7px 11px;
  border: 1px solid var(--divider-strong);
  border-radius: 7px;
  font-size: 12px;
  color: var(--text-main);
}
.batch-undo:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.memory-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 24px;
}
.memory-title h3 {
  font-size: 13px;
  font-weight: 600;
}
.memory-title button {
  display: flex;
  gap: 4px;
  align-items: center;
  color: var(--accent-ink, var(--accent));
  font-size: 12px;
}
.memory-entry {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  border-top: 1px solid var(--divider);
  padding: 12px 0;
}
.memory-entry p {
  margin: 4px 0;
  flex: 1;
  line-height: 1.8;
  white-space: pre-wrap;
}
.memory-editor {
  margin: 28px 0;
}
.memory-editor label {
  display: block;
  color: var(--text-sub);
  font-size: 12px;
}
.memory-editor textarea {
  display: block;
  width: 100%;
  margin: 10px 0;
  border: 1px solid var(--divider);
  background: var(--bg-main);
  color: inherit;
  padding: 10px;
  border-radius: 7px;
  resize: vertical;
  line-height: 1.8;
}
.memory-editor small {
  display: block;
  margin-top: 12px;
  color: var(--text-muted);
}
.change {
  border: 1px solid var(--divider);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 14px;
}
.change > div {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}
.source-title {
  font-weight: 600;
  text-align: left;
  color: var(--accent-ink, var(--accent));
}
.change small {
  font-size: 10px;
  color: var(--text-muted);
}
.change p {
  font-size: 12px;
  color: var(--text-sub);
}
.change summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--text-muted);
}
.change > button {
  display: flex;
  gap: 7px;
  align-items: center;
  border: 1px solid var(--divider);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 11px;
  margin-top: 15px;
}
.diff-rows {
  display: grid;
  gap: 6px;
  margin: 10px 0;
  padding: 10px 12px;
  border-radius: 7px;
  background: var(--bg-card, var(--bg-main));
  border: 1px solid var(--divider);
  font-size: 12px;
}
.diff-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
}
.diff-row__label {
  color: var(--text-sub);
  font-weight: 500;
  min-width: 52px;
}
.diff-row__from {
  color: var(--text-faint);
  text-decoration: line-through;
  overflow-wrap: anywhere;
}
.diff-row__sep {
  color: var(--text-faint);
}
.diff-row__to {
  color: var(--accent-ink, var(--accent));
  font-weight: 500;
  overflow-wrap: anywhere;
}
.raw-diff {
  margin-top: 6px;
}
.diff {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 6px;
}
.diff pre {
  font-size: 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow: auto;
}
.method-load {
  color: var(--accent-ink, var(--accent));
  border: 1px solid var(--divider);
  border-radius: 6px;
  padding: 7px 10px;
}
.skill-list article {
  display: flex;
  gap: 12px;
  padding: 18px 0;
  border-bottom: 1px solid var(--divider);
}
.skill-list svg {
  color: var(--accent);
  flex-shrink: 0;
}
.skill-list p {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.7;
}

@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}

@media (max-width: 800px) {
  .archive-panel,
  .archive-panel.wide {
    width: 100vw;
    top: var(--titlebar-h, 40px);
  }
  .panel-resizer {
    display: none;
  }
  .panel-top {
    padding: 14px;
  }
  .expand {
    display: none;
  }
  .transcript {
    padding: 8px 18px 20px;
  }
  .welcome {
    padding-top: 28px;
  }
  .composer-footer > span {
    display: none;
  }
  .panel-nav {
    gap: 18px;
    padding: 0 18px;
  }
  .panel-nav > span {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .archive-panel {
    transition: none;
  }
  .pulse {
    animation: none;
  }
}
</style>
