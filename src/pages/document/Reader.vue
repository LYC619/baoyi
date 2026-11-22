<script setup lang="ts">
import { latestOnly, STALE } from '@/composables/latestOnly'
import { errorMessage } from '@/utils'
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import {
  useRouter,
  useRoute,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
} from 'vue-router'
import {
  Bookmark,
  Copy,
  Highlighter,
  Minimize2,
  Pencil,
  Sparkles,
} from 'lucide-vue-next'
import DocumentCanvas from '@/components/workspace/DocumentCanvas.vue'
import ReaderHeader, { type ReaderSettingsModel } from '@/components/workspace/ReaderHeader.vue'
import ReaderAnnotationsSidebar from '@/components/workspace/ReaderAnnotationsSidebar.vue'
import { useArchiveAssistant } from '@/composables/useArchiveAssistant'
import { confirmDialog } from '@/composables/useDialog'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import { workspace, plain, returnPath } from '@/utils/workspace-api'
import type {
  DocumentItem,
  DocumentAnnotation,
  AnnotationInput,
  ReadingLocation,
  DocumentProjectReference,
  NovelIndexResult,
} from '@/types/workspace'
import '@/styles/workspace.css'

const UI_PREF_KEY = 'baoyi.document.readerUi.v1'
const DOC_ENC_KEY = 'baoyi.document.encodings.v1'

interface StoredReaderUiPrefs {
  lineHeight?: number
  theme?: ReaderSettingsModel['theme']
  pdfFit?: 'width' | 'page'
  toc?: boolean
  side?: boolean
}

function loadStoredUiPrefs(): StoredReaderUiPrefs {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(UI_PREF_KEY)
    return raw ? (JSON.parse(raw) as StoredReaderUiPrefs) : {}
  } catch {
    return {}
  }
}

function saveStoredUiPrefs(prefs: StoredReaderUiPrefs) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(UI_PREF_KEY, JSON.stringify(prefs))
  } catch {
    // best-effort
  }
}

function getDocumentSavedEncoding(docId: string): string {
  if (typeof localStorage === 'undefined') return 'auto'
  try {
    const raw = localStorage.getItem(DOC_ENC_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    return map[docId] || 'auto'
  } catch {
    return 'auto'
  }
}

function setDocumentSavedEncoding(docId: string, encoding: string) {
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(DOC_ENC_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    if (!encoding || encoding === 'auto') delete map[docId]
    else map[docId] = encoding
    localStorage.setItem(DOC_ENC_KEY, JSON.stringify(map))
  } catch {
    // best-effort
  }
}

const storedUi = loadStoredUiPrefs()
const archiveAssistant = useArchiveAssistant()
const props = defineProps<{ id: string }>()
const router = useRouter()
const route = useRoute()
const item = ref<DocumentItem | null>(null)
const content = ref<Awaited<ReturnType<typeof workspace.documents.content>> | null>(null)
const annotations = ref<DocumentAnnotation[]>([])
const canvas = ref<InstanceType<typeof DocumentCanvas>>()
const headerRef = ref<InstanceType<typeof ReaderHeader>>()

const toc = ref(storedUi.toc ?? false)
const side = ref(storedUi.side ?? true)
const error = ref('')
const contentError = ref('')
const busy = ref(false)
const loading = ref(false)
const selected = ref<string[]>([])
const editing = ref<AnnotationInput | null>(null)
const message = ref('')
const quote = ref('')
const quoteLocation = ref<ReadingLocation>({ page: 1, offset: 0 })
const position = ref<ReadingLocation>({ page: 1, offset: 0 })
const initial = ref<ReadingLocation>({ page: 1, offset: 0 })
const pageCount = ref(1)
const unsaved = ref(false)

const novelIndex = ref<NovelIndexResult | null>(null)
const currentChapterIndex = ref(0)
const readerSettings = ref<ReaderSettingsModel>({
  fontSize: 18,
  lineHeight: storedUi.lineHeight && storedUi.lineHeight >= 1.4 && storedUi.lineHeight <= 2.6 ? storedUi.lineHeight : 1.8,
  theme: storedUi.theme && ['light', 'sepia', 'eye', 'dark'].includes(storedUi.theme) ? storedUi.theme : 'light',
  encoding: getDocumentSavedEncoding(props.id),
  immersive: false,
  pdfFit: storedUi.pdfFit === 'page' ? 'page' : 'width',
})
const settingsOpen = ref(false)

function persistUiPrefs() {
  saveStoredUiPrefs({
    lineHeight: readerSettings.value.lineHeight,
    theme: readerSettings.value.theme,
    pdfFit: readerSettings.value.pdfFit,
    toc: toc.value,
    side: side.value,
  })
}

function onChapterChange(idx: number) {
  currentChapterIndex.value = idx
}

function updateReaderSettings(patch: Partial<ReaderSettingsModel>) {
  Object.assign(readerSettings.value, patch)
  persistUiPrefs()
  if (patch.fontSize !== undefined && typeof workspace.preferences?.save === 'function') {
    void workspace.preferences.save('document', { fontSize: patch.fontSize }).catch(() => {
      // best-effort
    })
  }
  if (patch.encoding !== undefined) {
    setDocumentSavedEncoding(props.id, patch.encoding)
  }
}

const readIndex = latestOnly((encoding?: string) => workspace.documents.textIndex(props.id, encoding))
async function reloadEncoding() {
  if (!item.value) return
  setDocumentSavedEncoding(props.id, readerSettings.value.encoding)
  const enc = readerSettings.value.encoding === 'auto' ? undefined : readerSettings.value.encoding
  try {
    loading.value = true
    if (novelIndex.value && typeof workspace.documents.textIndex === 'function') {
      const index = await readIndex(enc)
      if (index === STALE) return
      novelIndex.value = index
      pageCount.value = Math.max(1, novelIndex.value?.chapters.length || 1)
    } else if (['txt', 'md', 'markdown'].includes(item.value.format)) {
      const nextContent = await workspace.documents.content(props.id, enc)
      if (disposed) return
      content.value = nextContent
    }
  } catch (e) {
    error.value = errorMessage(e)
  }
  loading.value = false
}

function closeSide() {
  side.value = false
  persistUiPrefs()
  headerRef.value?.focusSideTrigger()
}

const selectionPoint = ref({ x: 16, y: 180 })
const activeAnnotation = ref('')
const locationStates = ref<Record<string, string>>({})
const supported = computed(() =>
  Boolean(item.value && ['pdf', 'md', 'markdown', 'txt', 'png', 'jpg', 'jpeg'].includes(item.value.format))
)

let saveTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const projectReferences = ref<DocumentProjectReference[]>([])
const lifetime = new AbortController()
const readReferences = latestOnly(() => workspace.links.projectReferences([props.id]))

async function refreshReferences() {
  try {
    const refs = await readReferences()
    if (refs !== STALE && !disposed) projectReferences.value = refs
  } catch (e) {
    if (!disposed) error.value = '项目引用读取失败：' + errorMessage(e)
  }
}

const offReferences = workspace.onChanged(() => void refreshReferences())
const offProjects = window.baoyi.project.onChanged(() => void refreshReferences())
onMounted(() => {
  void refreshReferences()
})

function toggleToc() {
  toc.value = !toc.value
  if (toc.value && typeof window !== 'undefined' && (window.innerWidth || 1200) <= 850) side.value = false
  persistUiPrefs()
}
function toggleSide() {
  side.value = !side.value
  if (side.value && typeof window !== 'undefined' && (window.innerWidth || 1200) <= 850) toc.value = false
  persistUiPrefs()
}

const readDocument = latestOnly(async () => {
  const value = await workspace.documents.get(props.id)
  if (lifetime.signal.aborted) return null
  if (!value) throw new Error('资料索引已移除')
  const [notes, preferences] = await Promise.all([
    workspace.documents.annotations(props.id),
    workspace.preferences.get('document'),
  ])
  if (lifetime.signal.aborted) return null
  const savedEnc = getDocumentSavedEncoding(props.id)
  const enc = savedEnc && savedEnc !== 'auto' ? savedEnc : undefined
  let c: Awaited<ReturnType<typeof workspace.documents.content>> | null = null
  let index: NovelIndexResult | null = null
  let contentFailure = ''
  if (['pdf', 'md', 'markdown', 'txt', 'png', 'jpg', 'jpeg'].includes(value.format) && value.available) {
    try {
      c = await workspace.documents.content(props.id, enc)
      if (
        (value.format === 'txt' || (['md', 'markdown'].includes(value.format) && c.isLarge)) &&
        typeof workspace.documents.textIndex === 'function'
      ) {
        const idx = await workspace.documents.textIndex(props.id, enc)
        if (!idx.isChunked || value.type === 'novel' || c.isLarge) {
          index = idx
        }
      }
    } catch (e) {
      contentFailure = errorMessage(e)
    }
  }
  return { value, notes, preferences, c, index, contentFailure, savedEnc }
})

async function load() {
  const query = { ...route.query }
  loading.value = true
  error.value = ''
  contentError.value = ''
  content.value = null
  novelIndex.value = null
  item.value = null
  annotations.value = []
  message.value = ''
  locationStates.value = {}
  activeAnnotation.value = ''
  clearTimeout(saveTimer)
  unsaved.value = false
  try {
    const result = await readDocument()
    if (result === STALE || !result || lifetime.signal.aborted) return
    const { value, notes, preferences, c, index, contentFailure, savedEnc } = result
    readerSettings.value.fontSize = preferences.fontSize
    readerSettings.value.encoding = savedEnc || 'auto'
    item.value = value
    annotations.value = notes
    position.value = { ...value.position }
    const requestedOffset = query.offset === undefined ? value.position.offset : Number(query.offset)
    initial.value = {
      page: Math.max(1, Number(query.page) || value.position.page),
      offset: Number.isFinite(requestedOffset) ? Math.min(1, Math.max(0, requestedOffset)) : value.position.offset,
    }
    novelIndex.value = index
    pageCount.value = Math.max(1, index?.chapters.length || value.pageCount || 1)
    content.value = c
    contentError.value = contentFailure
  } catch (e) {
    error.value = errorMessage(e)
  }
  loading.value = false
}

onMounted(() => {
  void load()
})

function changedLocation(location: ReadingLocation, count: number) {
  position.value = location
  pageCount.value = count
  unsaved.value = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void savePosition(), 600)
}

async function savePosition() {
  clearTimeout(saveTimer)
  if (!unsaved.value || !item.value) return
  const id = item.value.id
  const loc = { ...position.value }
  const count = pageCount.value
  try {
    await workspace.documents.position(id, loc, count)
    if (position.value.page === loc.page && position.value.offset === loc.offset) unsaved.value = false
  } catch (e) {
    if (!disposed) error.value = '阅读位置未保存：' + errorMessage(e)
  }
}

async function beforeNavigate() {
  if (busy.value) return false
  if (
    editing.value &&
    !(await confirmDialog({
      title: '放弃未保存的标注？',
      message: '当前标注尚未保存，离开后修改将丢失。',
      confirmText: '放弃并离开',
      tone: 'danger',
    }))
  ) {
    return false
  }
  await savePosition()
  if (
    unsaved.value &&
    !(await confirmDialog({
      title: '阅读位置尚未保存',
      message: '仍要离开当前阅读页吗？',
      confirmText: '仍要离开',
    }))
  ) {
    return false
  }
}

onBeforeRouteLeave(beforeNavigate)
onBeforeRouteUpdate(beforeNavigate)
onBeforeUnmount(() => {
  disposed = true
  lifetime.abort()
  offReferences()
  offProjects()
  clearTimeout(saveTimer)
  void savePosition()
})

async function run(fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

function capture(text: string, loc: ReadingLocation, point: { x: number; y: number }) {
  quote.value = text
  quoteLocation.value = loc
  selectionPoint.value = {
    x: Math.max(12, Math.min((window.innerWidth || 1200) - 465, point.x)),
    y: Math.max(150, Math.min((window.innerHeight || 800) - 60, point.y + 10)),
  }
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(message, (value) => {
  clearTimeout(noticeTimer)
  if (value) noticeTimer = setTimeout(() => (message.value = ''), 2600)
})

function outsideSelection(event: PointerEvent) {
  const target = event.target as Element
  if (quote.value && !target.closest('.reader-selection') && !target.closest('[role="dialog"]') && !target.closest('dialog')) {
    clearSelection()
  }
  if (!target.closest('.settings-anchor')) settingsOpen.value = false
}
function selectionChanged() {
  if (!window.getSelection?.()?.toString().trim() && !editing.value) quote.value = ''
}
function onReaderKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
    if (supported.value && content.value && !['png', 'jpg', 'jpeg'].includes(item.value?.format || '')) {
      event.preventDefault()
      if (readerSettings.value.immersive) {
        readerSettings.value.immersive = false
        void nextTick(() => headerRef.value?.focusSearch())
      } else {
        headerRef.value?.focusSearch()
      }
      return
    }
  }
  if (event.key === 'Escape') {
    clearSelection()
    settingsOpen.value = false
  }
}
onMounted(() => {
  document.addEventListener('pointerdown', outsideSelection)
  document.addEventListener('selectionchange', selectionChanged)
  document.addEventListener('keydown', onReaderKeydown)
})
onBeforeUnmount(() => {
  clearTimeout(noticeTimer)
  document.removeEventListener('pointerdown', outsideSelection)
  document.removeEventListener('selectionchange', selectionChanged)
  document.removeEventListener('keydown', onReaderKeydown)
})

function clearSelection() {
  quote.value = ''
  window.getSelection?.()?.removeAllRanges()
}
function excerpt() {
  if (quote.value) {
    editing.value = {
      kind: 'excerpt',
      quote: quote.value,
      note: '',
      location: plain(quoteLocation.value),
    }
  }
}
async function highlight() {
  if (!quote.value) return
  await run(async () => {
    const a = await workspace.documents.annotate(props.id, {
      kind: 'excerpt',
      quote: quote.value,
      note: '',
      location: plain(quoteLocation.value),
    })
    annotations.value = await workspace.documents.annotations(props.id)
    activeAnnotation.value = a.id
    clearSelection()
    message.value = '已保存高亮，可在标注卡补充想法'
  })
}
async function saveAnnotation() {
  if (!editing.value) return
  await run(async () => {
    await workspace.documents.annotate(props.id, plain(editing.value!))
    annotations.value = await workspace.documents.annotations(props.id)
    editing.value = null
    quote.value = ''
    message.value = '已保存标注'
  })
}
const pageBookmarked = computed(() =>
  annotations.value.some((a) => a.kind === 'bookmark' && a.location?.page === position.value.page)
)
async function togglePageBookmark() {
  if (!item.value) return
  const existing = annotations.value.find(
    (a) => a.kind === 'bookmark' && a.location?.page === position.value.page && !a.note
  )
  await run(async () => {
    if (existing) {
      await workspace.documents.removeAnnotation(props.id, existing.id)
      annotations.value = await workspace.documents.annotations(props.id)
      message.value = '已移除当前页书签'
    } else {
      const label = novelIndex.value
        ? novelIndex.value.chapters[currentChapterIndex.value]?.title || `第 ${position.value.page} 章`
        : `第 ${position.value.page} ${item.value?.format === 'pdf' ? '页' : '段'}`
      await workspace.documents.annotate(props.id, {
        kind: 'bookmark',
        quote: label,
        note: '',
        location: plain(position.value),
      })
      annotations.value = await workspace.documents.annotations(props.id)
      message.value = '已添加当前页书签'
    }
  })
}
async function bookmark() {
  if (!quote.value) return
  await run(async () => {
    await workspace.documents.annotate(props.id, {
      kind: 'bookmark',
      quote: quote.value,
      note: '',
      location: plain(quoteLocation.value),
    })
    annotations.value = await workspace.documents.annotations(props.id)
    clearSelection()
    message.value = '已保存书签'
  })
}
async function remove(a: DocumentAnnotation) {
  const ok = await confirmDialog({
    title: '移除此条标注？',
    message: '已引用该标注的项目或个人记录会保留当时的原文快照。',
    confirmText: '移除标注',
    tone: 'danger',
  })
  if (!ok) return
  await run(async () => {
    await workspace.documents.removeAnnotation(props.id, a.id)
    annotations.value = await workspace.documents.annotations(props.id)
    selected.value = selected.value.filter((id) => id !== a.id)
  })
}
async function removeSelected() {
  if (!selected.value.length) return
  const ok = await confirmDialog({
    title: `删除选中的 ${selected.value.length} 条标注与书签？`,
    message: '已建立的跨模块引用会保留原文快照，不会受影响。',
    confirmText: '删除所选',
    tone: 'danger',
  })
  if (!ok) return
  await run(async () => {
    for (const annotationId of [...selected.value]) {
      await workspace.documents.removeAnnotation(props.id, annotationId)
      selected.value = selected.value.filter((id) => id !== annotationId)
      annotations.value = annotations.value.filter((a) => a.id !== annotationId)
    }
    message.value = '已删除所选标注'
  })
}
async function exportSelected() {
  await run(async () => {
    const file = await workspace.documents.export(props.id, [...selected.value])
    if (file) message.value = '已导出到 ' + file
  })
}
async function copySelected() {
  await run(async () => {
    await window.baoyi.app.copyText(await workspace.documents.markdown(props.id, [...selected.value]))
    message.value = '已复制 Markdown，包含原文、想法和来源'
  })
}
async function copyQuote() {
  await run(async () => {
    await window.baoyi.app.copyText(quote.value)
    message.value = '已复制选文'
    clearSelection()
  })
}
function edit(a: DocumentAnnotation) {
  editing.value = {
    id: a.id,
    kind: a.kind,
    quote: a.quote,
    note: a.note,
    location: plain(a.location),
  }
}
async function focus(a: DocumentAnnotation) {
  activeAnnotation.value = a.id
  clearSelection()
  await canvas.value?.focusAnnotation(a)
}
function fromHighlight(id: string) {
  activeAnnotation.value = id
  document.getElementById('annotation-' + id)?.scrollIntoView({ block: 'nearest' })
}
async function ready() {
  const a = annotations.value.find((a) => a.id === route.query.annotation)
  if (a) {
    await focus(a)
    return
  }
  const id = props.id
  if (typeof route.query.insight === 'string' && typeof route.query.evidence === 'string') {
    try {
      const result = await window.baoyi.archive.insights.detail(id)
      if (disposed) return
      const note = result.history.find((note) => note.id === route.query.insight)
      const evidence = note?.evidence.find((value) => value.id === route.query.evidence)
      if (evidence) {
        await canvas.value?.focusSource({
          documentId: id,
          name: '精读证据',
          quote: evidence.quote,
          location: { page: evidence.page || 1, offset: 0 },
          line: evidence.startLine,
          label: evidence.page ? '第 ' + evidence.page + ' 页' : '原文引文',
        })
      } else {
        error.value = '这条精读证据已不可用，可从速览重新打开'
      }
    } catch (e) {
      error.value = errorMessage(e)
    }
  }
}
watch(
  () => [route.query.annotation, route.query.insight, route.query.evidence],
  () => {
    if (content.value) void ready()
  }
)
async function ask() {
  if (!quote.value) return
  const text = `请解释这段选文的含义，说明依据仅限所选片段并引用原句。\n资料：[${item.value?.name || '当前资料'}](baoyi://resource/${props.id})，阅读位置 ${quoteLocation.value.page}。\n选文：\n${quote.value}`
  clearSelection()
  await archiveAssistant.show(text, [props.id])
}
function onFitPdf(mode: 'width' | 'page') {
  updateReaderSettings({ pdfFit: mode })
  void canvas.value?.fitPdf(mode)
}
</script>

<template>
  <main class="ws document-reader">
    <ReaderHeader
      v-if="!readerSettings.immersive"
      ref="headerRef"
      :item="item"
      :supported="supported"
      :has-content="Boolean(content)"
      :unsaved="unsaved"
      :busy="busy"
      :toc="toc"
      :side="side"
      :settings-open="settingsOpen"
      :zoom="canvas?.zoom || 1"
      :searching="Boolean(canvas?.searching)"
      :page-bookmarked="pageBookmarked"
      :novel-index="novelIndex"
      :current-chapter-index="currentChapterIndex"
      :reader-settings="readerSettings"
      @back="router.push(returnPath(route.query.from, '/document'))"
      @find="(q, dir) => canvas?.find(q, dir)"
      @change-zoom="(d) => canvas?.changeZoom(d)"
      @fit-pdf="onFitPdf"
      @bookmark-page="togglePageBookmark"
      @prev-chapter="canvas?.prevChapter()"
      @next-chapter="canvas?.nextChapter()"
      @toggle-toc="toggleToc"
      @toggle-side="toggleSide"
      @update:settings-open="(v) => (settingsOpen = v)"
      @update:reader-settings="updateReaderSettings"
      @reload-encoding="reloadEncoding"
      @open-external="run(() => workspace.documents.open(id))"
    />

    <button
      v-if="readerSettings.immersive"
      type="button"
      class="immersive-exit-button"
      title="显示顶栏"
      @click="readerSettings.immersive = false"
    >
      <Minimize2 :size="16" />退出全屏
    </button>

    <p v-if="error" class="ws-error reader-toast" role="alert">
      {{ error }}
      <button v-if="unsaved" type="button" class="ws-button" @click="savePosition">重试保存位置</button>
      <button type="button" class="ws-icon" aria-label="关闭错误" @click="error = ''">×</button>
    </p>
    <p v-else-if="message" class="ws-notice reader-toast" role="status">
      {{ message }}
      <button type="button" class="ws-icon" aria-label="关闭提示" @click="message = ''">×</button>
    </p>

    <div
      v-if="quote"
      class="reader-selection"
      role="toolbar"
      aria-label="选文操作"
      :style="{ left: selectionPoint.x + 'px', top: selectionPoint.y + 'px' }"
      @pointerdown.prevent
      @mousedown.prevent
    >
      <button type="button" class="ws-button" :disabled="busy" @click="bookmark">
        <Bookmark :size="15" />书签
      </button>
      <button type="button" class="ws-button primary" :disabled="busy" @click="highlight">
        <Highlighter :size="15" />高亮
      </button>
      <button type="button" class="ws-button" :disabled="busy" @click="excerpt">
        <Pencil :size="14" />想法
      </button>
      <button type="button" class="ws-button" @click="ask">
        <Sparkles :size="14" />询问助理
      </button>
      <button type="button" class="ws-icon" aria-label="复制选文" @click="copyQuote">
        <Copy :size="15" />
      </button>
      <button type="button" class="ws-icon" aria-label="取消选文" @click="clearSelection">×</button>
    </div>

    <div class="reader-body">
      <DocumentCanvas
        v-if="content"
        :key="id"
        ref="canvas"
        :document-id="props.id"
        :content="content"
        :initial="initial"
        :toc="toc"
        :annotations="annotations"
        :novel-index="novelIndex"
        :reader-settings="readerSettings"
        @selection="capture"
        @position="changedLocation"
        @annotation="fromHighlight"
        @locations="locationStates = { ...locationStates, ...$event }"
        @chapter-change="onChapterChange"
        @ready="ready"
      />
      <div v-else class="reader-fallback ws-empty">
        <h2>
          {{ loading ? '正在打开资料…' : !item?.available ? '原文件暂时找不到' : '使用熟悉的应用查看' }}
        </h2>
        <p>
          {{
            contentError ||
            (!item?.available
              ? '书签、标注与引用仍保留。重新定位后可继续阅读。'
              : '此格式可以在外部应用打开，资料信息和关联仍由抱一管理。')
          }}
        </p>
        <button
          v-if="item && !item.available"
          type="button"
          class="ws-button"
          :disabled="busy"
          @click="
            run(async () => {
              await workspace.documents.relocate(id)
              await load()
            })
          "
        >
          重新定位
        </button>
        <button v-if="contentError" type="button" class="ws-button" :disabled="busy" @click="load">
          重试打开
        </button>
      </div>

      <ReaderAnnotationsSidebar
        v-if="side"
        :document-id="id"
        :format="item?.format"
        :is-novel="Boolean(novelIndex)"
        :annotations="annotations"
        :active-annotation="activeAnnotation"
        :selected="selected"
        :location-states="locationStates"
        :project-references="projectReferences"
        :busy="busy"
        @close="closeSide"
        @focus="focus"
        @edit="edit"
        @remove="remove"
        @update:selected="(ids) => (selected = ids)"
        @remove-selected="removeSelected"
        @copy-selected="copySelected"
        @export-selected="exportSelected"
        @refresh-references="refreshReferences"
      />
    </div>

    <ProjectDialog
      v-if="editing"
      :title="editing.id ? '编辑标注' : '补充想法'"
      :busy="busy"
      @close="editing = null"
    >
      <form id="annotation-form" class="ws ws-form" @submit.prevent="saveAnnotation">
        <p v-if="error" class="ws-error">{{ error }}</p>
        <label v-if="editing.kind === 'excerpt'">
          原文
          <textarea v-model="editing.quote" required maxlength="30000" readonly />
        </label>
        <p class="ws-muted">
          来源位置：第 {{ editing.location.page
          }}{{ editing.location.anchor?.pages?.length ? '–' + editing.location.anchor.pages.at(-1)!.page : '' }}
          页/段
        </p>
        <label>
          我的想法
          <textarea
            v-model="editing.note"
            maxlength="20000"
            placeholder="记下自己的理解，也可以稍后补充。"
          />
        </label>
      </form>
      <template #footer>
        <div class="ws">
          <button class="ws-button primary" form="annotation-form" type="submit" :disabled="busy">
            保存标注
          </button>
        </div>
      </template>
    </ProjectDialog>
  </main>
</template>

<style scoped>
.document-reader {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}
.immersive-exit-button {
  position: fixed;
  top: 14px;
  right: 18px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 20px;
  background: rgb(0 0 0 / 0.7);
  color: #fff;
  border: none;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.2);
  transition: opacity 0.2s ease;
}
.immersive-exit-button:hover {
  background: rgb(0 0 0 / 0.85);
}
.reader-body {
  display: flex;
  min-height: 0;
  flex: 1;
  min-width: 0;
}
.reader-selection {
  position: fixed;
  z-index: 50;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  background: var(--bg-main);
  border: 1px solid var(--divider);
  box-shadow: var(--shadow-pop);
  border-radius: 8px;
  padding: 6px;
  font-size: 12px;
  max-width: calc(100vw - 24px);
}
.reader-selection .ws-button {
  padding: 6px 8px;
  font-size: 12px;
}
.reader-fallback {
  flex: 1;
}
.reader-toast {
  position: absolute;
  bottom: 12px;
  left: 20px;
  z-index: 40;
  border: 1px solid var(--divider);
  box-shadow: var(--shadow-pop);
  border-radius: var(--radius-btn);
  padding: 8px 12px;
  font-size: 12px;
  max-width: calc(100% - 40px);
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
