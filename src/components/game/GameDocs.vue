<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { BookOpen, Plus, FolderOpen, Maximize, Minimize, Search, ZoomIn, ZoomOut } from 'lucide-vue-next'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { GameItem, LinkedFile } from '@/types'
import type { GamePreview } from '@/types/game-workspace'
import type { GameLinkState } from '@/types/game-project'
import { errorMessage, formatBytes, plain, LINK_TYPE_LABEL } from '@/utils'
import { useToast } from '@/composables/useToast'
import { markdownLines } from '@/utils/game-notes'
import { loadPdfDocument } from '@/utils/pdf-document'
import PdfReaderPage from '@/components/workspace/PdfReaderPage.vue'
import GameMarkdown from './GameMarkdown.vue'
import { gameDocumentGroup, projectOf } from '@/utils/game-project'
import LibraryToolbarMenu from '@/components/library/LibraryToolbarMenu.vue'

const props = defineProps<{ game: GameItem; initialPath?: string }>()
const emit = defineEmits<{ updated: [game: GameItem] }>()
const { error } = useToast()

const links = computed(() => props.game.linked_files.filter((f) => f.type === 'guide'))
const query = ref('')
const selected = ref('')
const doc = ref<GamePreview>()
const states = ref<GameLinkState[]>([])
const loading = ref(false)
const failure = ref('')
const full = ref(false)
const busy = ref(false)
const activeSheet = ref(0)

// Full-text index cache for guide content search
const bodyIndex = ref<Record<string, string>>({})
let indexRound = 0

async function ensureBodyIndex(): Promise<void> {
  const kw = query.value.trim()
  if (!kw) return
  const round = ++indexRound
  const gameId = props.game.id
  for (const f of links.value) {
    if (round !== indexRound || disposed || props.game.id !== gameId) return
    if (bodyIndex.value[f.path] !== undefined) continue
    if (!/\.(?:md|txt|xlsx)$/i.test(f.path)) {
      bodyIndex.value[f.path] = ''
      continue
    }
    try {
      const res = await window.baoyi.game.previewLink(gameId, f.path)
      if (disposed || props.game.id !== gameId) return
      if (res.kind === 'xlsx') {
        const sheetsText = (res.allSheets ?? [{ name: '', rows: res.rows ?? [], truncated: false }])
          .map((s) => `${s.name}\n${s.rows.map((r) => r.join(' ')).join('\n')}`)
          .join('\n')
        bodyIndex.value[f.path] = sheetsText
      } else {
        bodyIndex.value[f.path] = res.text || ''
      }
    } catch {
      bodyIndex.value[f.path] = ''
    }
  }
}

watch(query, () => {
  if (query.value.trim()) void ensureBodyIndex()
})

function matchSnippet(f: LinkedFile): string {
  const kw = query.value.trim().toLowerCase()
  if (!kw) return ''
  if ((f.label + ' ' + f.path).toLowerCase().includes(kw)) return ''
  const raw = bodyIndex.value[f.path] || ''
  const idx = raw.toLowerCase().indexOf(kw)
  if (idx < 0) return ''
  const start = Math.max(0, idx - 16)
  const end = Math.min(raw.length, idx + kw.length + 28)
  return (start > 0 ? '…' : '') + raw.slice(start, end).replace(/\s+/g, ' ').trim() + (end < raw.length ? '…' : '')
}

const current = computed(() => links.value.find((f) => f.path === selected.value))
const visible = computed(() => {
  const kw = query.value.trim().toLowerCase()
  if (!kw) return links.value
  return links.value.filter(
    (f) => (f.label + ' ' + f.path).toLowerCase().includes(kw) || (bodyIndex.value[f.path] || '').toLowerCase().includes(kw)
  )
})
const groups = computed(() =>
  [
    { id: 'start', label: '从这里开始' },
    { id: 'guide', label: '攻略与说明' },
    { id: 'record', label: '精修与核查记录' },
  ]
    .map((group) => ({
      ...group,
      files: visible.value.filter((f) => gameDocumentGroup(f, projectOf(props.game)?.guidePath) === group.id),
    }))
    .filter((group) => group.files.length)
)

const reader = ref<HTMLElement>()
const markdown = ref<InstanceType<typeof GameMarkdown>>()
const headings = computed(() => (doc.value?.kind === 'md' ? markdownLines(doc.value.text).headings : []))

const activeSheetData = computed(() => {
  if (doc.value?.kind !== 'xlsx') return null
  if (doc.value.allSheets?.length) {
    return doc.value.allSheets[activeSheet.value] ?? doc.value.allSheets[0]
  }
  return { name: doc.value.sheets?.[0] || '工作表', rows: doc.value.rows ?? [], truncated: doc.value.truncated }
})

// PDF embedded reader state
const pdfDoc = shallowRef<PDFDocumentProxy | null>(null)
let pdfTask: { destroy: () => Promise<void> } | null = null
const pdfPages = ref(0)
const pdfZoom = ref(1)
const readerWidth = ref(720)
let resizeObserver: ResizeObserver | null = null

async function releasePdf(): Promise<void> {
  const prevTask = pdfTask
  pdfTask = null
  pdfDoc.value = null
  pdfPages.value = 0
  if (prevTask) {
    await prevTask.destroy().catch(() => { /* best-effort */ })
  }
}

let generation = 0
let disposed = false
let restoringScroll = false
let timer: ReturnType<typeof setTimeout> | undefined
let pending: { id: string; file: LinkedFile; progress: number } | undefined
let saving: Promise<void> | null = null

const exists = (f: LinkedFile) => states.value.find((s) => s.path === f.path)?.exists

function rebaseProgress(file: LinkedFile, updated: GameItem) {
  if (pending?.file.path === file.path && JSON.stringify(pending.file) === JSON.stringify(file)) {
    const fresh = updated.linked_files.find((f) => f.path === file.path)
    if (fresh) pending.file = plain(fresh)
  }
}

async function saveProgress() {
  clearTimeout(timer)
  if (saving) {
    await saving
    return saveProgress()
  }
  const p = pending
  if (!p) return
  pending = undefined
  saving = (async () => {
    try {
      const updated = await window.baoyi.game.patchLink(
        p.id,
        p.file.path,
        { read_progress: p.progress },
        JSON.stringify(p.file)
      )
      if (updated) {
        rebaseProgress(p.file, updated)
        emit('updated', updated)
      }
    } catch (e) {
      if (!disposed) error(errorMessage(e))
    }
  })()
  await saving
  saving = null
}

function scrolled() {
  if (!reader.value || !current.value || loading.value || restoringScroll) return
  const el = reader.value
  const range = el.scrollHeight - el.clientHeight
  if (range < 1) return
  const progress = Math.min(1, Math.max(0, el.scrollTop / range))
  pending = { id: props.game.id, file: plain(current.value), progress }
  clearTimeout(timer)
  timer = setTimeout(() => void saveProgress(), 600)
}

function applySavedScroll(file: LinkedFile) {
  if (!reader.value) return
  restoringScroll = true
  const saved = file.read_progress || 0
  if (saved > 0) {
    const range = Math.max(0, reader.value.scrollHeight - reader.value.clientHeight)
    reader.value.scrollTop = range * saved
  } else {
    reader.value.scrollTop = 0
  }
  requestAnimationFrame(() => {
    restoringScroll = false
  })
}

async function read(file: LinkedFile) {
  await saveProgress()
  const n = ++generation
  selected.value = file.path
  doc.value = undefined
  activeSheet.value = 0
  failure.value = ''
  loading.value = true
  await releasePdf()
  try {
    const result = await window.baoyi.game.previewLink(props.game.id, file.path)
    if (n !== generation) return
    if (result.kind === 'md' || result.kind === 'txt') {
      bodyIndex.value[file.path] = result.text || ''
    } else if (result.kind === 'xlsx') {
      bodyIndex.value[file.path] = (result.allSheets ?? [])
        .map((s) => `${s.name}\n${s.rows.map((r) => r.join(' ')).join('\n')}`)
        .join('\n')
    }
    if (result.kind === 'pdf' && result.data) {
      const task = loadPdfDocument(result.data)
      const loaded = await task.promise
      if (n !== generation || disposed) {
        await task.destroy().catch(() => { /* best-effort */ })
        return
      }
      pdfTask = task
      pdfDoc.value = loaded
      pdfPages.value = loaded.numPages
    }
    doc.value = result
    await nextTick()
    if (reader.value) {
      readerWidth.value = Math.max(320, reader.value.clientWidth - 40)
    }
    await nextTick()
    applySavedScroll(file)
  } catch (e) {
    if (n === generation) failure.value = errorMessage(e)
  } finally {
    if (n === generation) loading.value = false
  }
}

function resume() {
  if (reader.value && current.value) {
    applySavedScroll(current.value)
  }
}

async function open(reveal = false) {
  if (!current.value) return
  try {
    const r = await (reveal ? window.baoyi.game.revealLink : window.baoyi.game.openLink)(
      props.game.id,
      current.value.path
    )
    if (!r.ok) error(r.message)
  } catch (e) {
    error(errorMessage(e))
  }
}

async function add() {
  busy.value = true
  try {
    const result = await window.baoyi.game.pickLinks(props.game.id, 'file', 'guide')
    if (result) emit('updated', result)
  } catch (e) {
    error(errorMessage(e))
  } finally {
    busy.value = false
  }
}

async function patch(value: Partial<LinkedFile> | null) {
  await saveProgress()
  if (!current.value) return
  busy.value = true
  try {
    const result = await window.baoyi.game.patchLink(
      props.game.id,
      current.value.path,
      plain(value),
      JSON.stringify(current.value)
    )
    if (result) emit('updated', result)
  } catch (e) {
    error(errorMessage(e))
  } finally {
    busy.value = false
  }
}

watch(
  () => props.initialPath,
  (target) => {
    if (!target || target === selected.value) return
    const hit = links.value.find((f) => f.path === target)
    if (hit) void read(hit)
  }
)

watch(
  () => props.game.id + JSON.stringify(props.game.linked_files),
  async () => {
    const id = props.game.id
    try {
      const result = await window.baoyi.game.linkStates(id)
      if (!disposed && props.game.id === id) states.value = result
    } catch (e) {
      if (!disposed) error(errorMessage(e))
    }
    if (!links.value.some((f) => f.path === selected.value)) {
      selected.value = ''
      doc.value = undefined
      const first =
        links.value.find((f) => f.path === props.initialPath) ||
        links.value.find((f) => f.path === projectOf(props.game)?.guidePath) ||
        links.value[0]
      if (first) void read(first)
    }
  },
  { immediate: true }
)

watch(reader, (el) => {
  resizeObserver?.disconnect()
  if (!el || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => {
    readerWidth.value = Math.max(320, el.clientWidth - 40)
  })
  resizeObserver.observe(el)
})

onBeforeUnmount(() => {
  disposed = true
  generation++
  resizeObserver?.disconnect()
  void releasePdf()
  void saveProgress()
})
</script>

<template>
  <section class="docs-panel" :class="{ 'docs-panel--full': full }" aria-label="攻略阅读">
    <aside class="docs-nav">
      <header>
        <label>
          <Search :size="14" />
          <input v-model="query" aria-label="搜索攻略与说明" placeholder="搜索标题或正文关键词" />
        </label>
        <button
          class="btn btn--icon"
          :disabled="busy || game.linked_files.length >= 20"
          aria-label="关联资料"
          @click="add"
        >
          <Plus :size="16" />
        </button>
      </header>
      <p v-if="!links.length" class="empty">还没有攻略。关联 Markdown、TXT、PDF、XLSX 或其他本地资料。</p>
      <p v-if="links.length && !visible.length" class="empty">没有匹配的资料，试试其他关键词。</p>
      <section v-for="group in groups" :key="group.id" class="doc-group">
        <h4>
          {{ group.label }} <small>{{ group.files.length }}</small>
        </h4>
        <button
          v-for="f in group.files"
          :key="f.path"
          class="doc-item"
          :class="{ selected: selected === f.path }"
          @click="read(f)"
        >
          <BookOpen :size="18" />
          <span>
            <strong>{{ f.label }}</strong>
            <small>
              {{ f.path.split('.').pop()?.toUpperCase() }} ·
              {{
                exists(f) === false
                  ? '文件缺失'
                  : f.read_progress
                    ? '读到 ' + Math.round(f.read_progress * 100) + '%'
                    : '未阅读'
              }}
            </small>
            <em v-if="matchSnippet(f)" class="doc-snippet">{{ matchSnippet(f) }}</em>
            <i v-if="f.read_progress" class="progress"><i :style="{ width: f.read_progress * 100 + '%' }" /></i>
          </span>
        </button>
      </section>
    </aside>

    <article class="docs-main">
      <header v-if="current">
        <div>
          <h3>{{ current.label }}</h3>
          <small>
            {{ doc ? formatBytes(doc.bytes) : '' }}
            {{ doc?.kind === 'pdf' && pdfPages ? `· 共 ${pdfPages} 页` : '' }}
            {{ doc?.truncated ? '· 仅显示预览范围' : '' }}
          </small>
        </div>
        <template v-if="doc?.kind === 'pdf'">
          <button
            type="button"
            class="btn btn--icon"
            aria-label="缩小 PDF"
            :disabled="pdfZoom <= 0.6"
            @click="pdfZoom = Math.max(0.6, +(pdfZoom - 0.15).toFixed(2))"
          >
            <ZoomOut :size="14" />
          </button>
          <button type="button" class="btn btn--subtle" @click="pdfZoom = 1">
            {{ Math.round(pdfZoom * 100) }}%
          </button>
          <button
            type="button"
            class="btn btn--icon"
            aria-label="放大 PDF"
            :disabled="pdfZoom >= 2"
            @click="pdfZoom = Math.min(2, +(pdfZoom + 0.15).toFixed(2))"
          >
            <ZoomIn :size="14" />
          </button>
        </template>
        <button v-if="current.read_progress" class="btn btn--subtle" @click="resume">继续阅读</button>
        <button class="btn btn--icon" :aria-label="full ? '退出全屏阅读' : '全屏阅读'" @click="full = !full">
          <component :is="full ? Minimize : Maximize" :size="15" />
        </button>
        <button class="btn btn--ghost" :disabled="!exists(current)" @click="open()">系统打开</button>
        <button class="btn btn--icon" :disabled="!exists(current)" aria-label="定位资料" @click="open(true)">
          <FolderOpen :size="15" />
        </button>
        <LibraryToolbarMenu icon="more" label="管理资料">
          <label>
            名称
            <input
              :value="current.label"
              :disabled="busy"
              @change="patch({ label: ($event.target as HTMLInputElement).value })"
            />
          </label>
          <label>
            类型
            <select
              :value="current.type"
              :disabled="busy"
              @change="patch({ type: ($event.target as HTMLSelectElement).value as LinkedFile['type'] })"
            >
              <option v-for="(label, key) in LINK_TYPE_LABEL" :key="key" :value="key">{{ label }}</option>
            </select>
          </label>
          <button :disabled="busy" @click="patch(null)">解除关联，保留文件</button>
        </LibraryToolbarMenu>
      </header>

      <nav v-if="headings.length" class="doc-chapters" aria-label="攻略章节">
        <button v-for="(h, i) in headings" :key="i" @click="markdown?.jump(i)">{{ h.text }}</button>
      </nav>

      <div ref="reader" class="doc-reader reader-viewport" @scroll="scrolled">
        <p v-if="loading" role="status">读取中…</p>
        <p v-else-if="failure" role="alert">{{ failure }}</p>
        <template v-else-if="doc">
          <GameMarkdown v-if="doc.kind === 'md'" ref="markdown" :text="doc.text" :images="doc.images" />
          <pre v-else-if="doc.kind === 'txt'">{{ doc.text }}</pre>
          <template v-else-if="doc.kind === 'xlsx' && activeSheetData">
            <div v-if="(doc.allSheets?.length ?? 0) > 1" class="sheet-tabs" role="tablist" aria-label="工作表切换">
              <button
                v-for="(sheet, idx) in doc.allSheets"
                :key="idx"
                type="button"
                role="tab"
                class="sheet-tab"
                :class="{ active: activeSheet === idx }"
                :aria-selected="activeSheet === idx"
                @click="activeSheet = idx"
              >
                {{ sheet.name }}
              </button>
            </div>
            <p class="sheet-names">
              {{ activeSheetData.name }}（最多预览 50 行 / 50 列{{ activeSheetData.truncated ? '，下方已截断' : '' }}）
            </p>
            <table>
              <tbody>
                <tr v-for="(row, i) in activeSheetData.rows" :key="i">
                  <th>{{ i + 1 }}</th>
                  <td v-for="(cell, j) in row" :key="j">{{ cell }}</td>
                </tr>
              </tbody>
            </table>
          </template>
          <div v-else-if="doc.kind === 'pdf' && pdfDoc" class="pdf-stream">
            <PdfReaderPage
              v-for="p in pdfPages"
              :key="p"
              :pdf="pdfDoc"
              :page="p"
              :width="readerWidth"
              :zoom="pdfZoom"
              @error="failure = $event"
            />
          </div>
          <p v-else class="empty">此格式暂不支持内嵌预览，请使用系统程序打开。</p>
          <p v-if="doc.truncated" class="preview-limit">已达到预览上限，完整内容请使用系统程序打开。</p>
        </template>
        <p v-else class="empty">选择左侧资料开始阅读</p>
      </div>
    </article>
  </section>
</template>

<style scoped>
.docs-panel {
  height: clamp(540px, 72vh, 900px);
  display: flex;
  border: 1px solid var(--card-border);
  border-radius: 12px;
  background: var(--bg-card);
  overflow: hidden;
}
.docs-panel--full {
  position: fixed;
  inset: 48px 16px 16px;
  z-index: 60;
  height: auto;
  box-shadow: 0 0 0 100vmax #0009;
}
.docs-nav {
  width: 290px;
  flex: none;
  border-right: 1px solid var(--divider);
  padding: 12px;
  overflow: auto;
}
.docs-nav header {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.docs-nav label {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
  flex: 1;
  color: var(--text-faint);
  background: var(--bg-main);
  padding: 6px 9px;
  border-radius: 5px;
}
.docs-nav input {
  width: 100%;
  min-width: 0;
  background: none;
  border: 0;
  font-size: 12px;
  color: var(--text-main);
  outline: none;
}
.doc-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 10px;
  width: 100%;
  text-align: left;
  border-radius: 7px;
}
.doc-item.selected {
  background: var(--active-surface);
}
.doc-item > svg {
  color: var(--accent-ink);
  flex: none;
}
.doc-item > span {
  min-width: 0;
  flex: 1;
}
.doc-item strong {
  display: block;
  font-size: 12px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.doc-item small {
  display: block;
  font-size: 10px;
  color: var(--text-faint);
  margin-top: 7px;
}
.doc-snippet {
  display: block;
  margin-top: 5px;
  font-style: normal;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-sub);
  overflow-wrap: anywhere;
}
.progress {
  height: 3px;
  display: block;
  background: var(--divider);
  margin-top: 9px;
  border-radius: 3px;
}
.progress i {
  display: block;
  height: 100%;
  background: var(--accent);
}
.docs-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.docs-main > header {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  gap: 8px;
  border-bottom: 1px solid var(--divider);
}
.docs-main > header > div:first-child {
  flex: 1;
  min-width: 0;
}
.docs-main h3 {
  font-size: 14px;
  overflow-wrap: anywhere;
}
.docs-main small {
  font-size: 10px;
  color: var(--text-faint);
}
.doc-chapters {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  padding: 12px 24px;
  border-bottom: 1px solid var(--divider);
  max-height: 95px;
  overflow: auto;
}
.doc-chapters button {
  border: 1px solid var(--divider-strong);
  border-radius: 5px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-sub);
}
.doc-reader {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px 30px;
}
.doc-reader pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.9 var(--font-mono);
  user-select: text;
}
.sheet-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.sheet-tab {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--divider);
  background: var(--bg-main);
  color: var(--text-sub);
  font-size: 12px;
}
.sheet-tab.active {
  background: var(--active-surface);
  border-color: var(--accent);
  color: var(--accent);
}
.pdf-stream {
  display: flex;
  flex-direction: column;
  align-items: center;
}
table {
  border-collapse: collapse;
  user-select: text;
}
td,
th {
  border: 1px solid var(--divider-strong);
  padding: 8px 12px;
  font-size: 12px;
  min-width: 60px;
  max-width: 400px;
  overflow-wrap: anywhere;
}
th {
  color: var(--text-faint);
  min-width: 30px;
}
.sheet-names,
.preview-limit {
  font-size: 11px;
  color: var(--text-faint);
  margin-bottom: 14px;
}
.empty {
  font-size: 12px;
  color: var(--text-faint);
  padding: 35px 15px;
  line-height: 1.8;
}
@media (max-width: 1100px) {
  .docs-nav {
    width: 220px;
  }
  .docs-main > header {
    flex-wrap: wrap;
  }
  .doc-reader {
    padding: 18px;
  }
}
.doc-group {
  margin: 16px 0;
}
.doc-group h4 {
  display: flex;
  justify-content: space-between;
  padding: 0 10px 7px;
  font-size: 11px;
  color: var(--text-faint);
  font-weight: 500;
}
.doc-group h4 small {
  font-weight: 400;
}
.doc-reader :deep(.game-markdown) {
  max-width: 850px;
  margin: 0 auto;
}
.docs-nav .empty {
  padding: 20px 10px;
}
</style>
