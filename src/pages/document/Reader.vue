<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  useRouter,
  useRoute,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
} from 'vue-router'
import {
  ArrowLeft,
  PanelLeft,
  PanelRight,
  Bookmark,
  Highlighter,
  ExternalLink,
  Download,
  Pencil,
  Trash2,
  Copy,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Search,
} from 'lucide-vue-next'
import DocumentCanvas from '@/components/workspace/DocumentCanvas.vue'
import {useArchiveAssistant} from '@/composables/useArchiveAssistant'
const archiveAssistant=useArchiveAssistant()
import AnnotationProjectLinks from '@/components/workspace/AnnotationProjectLinks.vue'
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
import {
  workspaceSources,
} from '@/utils/workspace-sources'
import '@/styles/workspace.css'
const props = defineProps<{ id: string }>(),
  router = useRouter(),
  route = useRoute(),
  item = ref<DocumentItem | null>(null),
  content = ref<Awaited<ReturnType<typeof workspace.documents.content>> | null>(
    null,
  ),
  annotations = ref<DocumentAnnotation[]>([]),
  canvas = ref<InstanceType<typeof DocumentCanvas>>()
const toc = ref(false),
  side = ref(true),
  error = ref(''),
  contentError = ref(''),
  busy = ref(false),
  loading = ref(false),
  selected = ref<string[]>([]),
  editing = ref<AnnotationInput | null>(null),
  message = ref(''),
  quote = ref(''),
  quoteLocation = ref<ReadingLocation>({ page: 1, offset: 0 }),
  position = ref<ReadingLocation>({ page: 1, offset: 0 }),
  initial = ref<ReadingLocation>({ page: 1, offset: 0 }),
  pageCount = ref(1),
  unsaved = ref(false)

const novelIndex = ref<NovelIndexResult | null>(null),
  currentChapterIndex = ref(0),
  readerSettings = ref({
    fontSize: 18,
    lineHeight: 1.8,
    theme: 'light' as 'light' | 'sepia' | 'eye' | 'dark',
    encoding: 'auto',
    immersive: false,
  }),
  settingsOpen = ref(false),
  searchQuery = ref('')

function onChapterChange(idx: number) {
  currentChapterIndex.value = idx
}

async function reloadEncoding() {
  if (!item.value || !novelIndex.value) return
  const run = ++revision, id = props.id
  try {
    loading.value = true
    const enc = readerSettings.value.encoding === 'auto' ? undefined : readerSettings.value.encoding
    const index = await workspace.documents.textIndex(id, enc)
    if (run !== revision) return
    novelIndex.value = index
    pageCount.value = Math.max(1, novelIndex.value?.chapters.length || 1)
  } catch (e) {
    if (run === revision) error.value = (e as Error).message
  } finally {
    if (run === revision) loading.value = false
  }
}
const sideTrigger = ref<HTMLButtonElement>()
function closeSide() {
  side.value = false
  sideTrigger.value?.focus()
}
const selectionPoint = ref({ x: 16, y: 180 }),
  activeAnnotation = ref(''),
  locationStates = ref<Record<string, string>>({})
const supported = computed(
  () =>
    item.value &&
    ['pdf', 'md', 'markdown', 'txt', 'png', 'jpg', 'jpeg'].includes(
      item.value.format,
    ),
)
let revision = 0,
  saveTimer: ReturnType<typeof setTimeout> | undefined,
  disposed = false
const projectReferences = ref<DocumentProjectReference[]>([])
let referenceRevision = 0
async function refreshReferences() {
  const id = props.id,
    run = ++referenceRevision
  try {
    const refs = await workspace.links.projectReferences([id])
    if (!disposed && id === props.id && run === referenceRevision)
      projectReferences.value = refs
  } catch (e) {
    if (!disposed && id === props.id && run === referenceRevision)
      error.value = '项目引用读取失败：' + (e as Error).message
  }
}
const offReferences = workspace.onChanged(() => void refreshReferences())
const offProjects = window.baoyi.project.onChanged(
  () => void refreshReferences(),
)
watch(
  () => props.id,
  () => {
    projectReferences.value = []
    void refreshReferences()
  },
  { immediate: true },
)
function toggleToc() {
  toc.value = !toc.value
  if (toc.value && window.innerWidth <= 850) side.value = false
}
function toggleSide() {
  side.value = !side.value
  if (side.value && window.innerWidth <= 850) toc.value = false
}
async function load() {
  const run = ++revision,
    id = props.id,
    query = { ...route.query }
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
    const value = await workspace.documents.get(id)
    if (run !== revision) return
    if (!value) throw new Error('资料索引已移除')
    const [notes, preferences] = await Promise.all([workspace.documents.annotations(id), workspace.preferences.get('document')])
    if (run !== revision) return
    readerSettings.value.fontSize = preferences.fontSize
    item.value = value
    annotations.value = notes
    position.value = { ...value.position }
    const requestedOffset =
      query.offset === undefined ? value.position.offset : Number(query.offset)
    initial.value = {
      page: Math.max(1, Number(query.page) || value.position.page),
      offset: Number.isFinite(requestedOffset)
        ? Math.min(1, Math.max(0, requestedOffset))
        : value.position.offset,
    }
    pageCount.value = Math.max(1, value.pageCount)
    if (supported.value && value.available) {
      try {
        const c = await workspace.documents.content(id)
        if (run !== revision) return
        if (((value.format === 'txt' && (value.type === 'novel' || c.isLarge)) || (['md', 'markdown'].includes(value.format) && c.isLarge)) && typeof workspace.documents.textIndex === 'function') {
          const enc = readerSettings.value.encoding === 'auto' ? undefined : readerSettings.value.encoding
          const index = await workspace.documents.textIndex(id, enc)
          if (run !== revision) return
          novelIndex.value = index
          pageCount.value = Math.max(1, novelIndex.value?.chapters.length || value.pageCount || 1)
        }
        if (run === revision) content.value = c
      } catch (e) {
        if (run === revision) contentError.value = (e as Error).message
      }
    }
  } catch (e) {
    if (run === revision) error.value = (e as Error).message
  } finally {
    if (run === revision) loading.value = false
  }
}
watch(
  () => props.id,
  () => {
    selected.value = []
    quote.value = ''
    editing.value = null
    void load()
  },
  { immediate: true },
)
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
  const id = item.value.id,
    loc = { ...position.value },
    count = pageCount.value
  try {
    await workspace.documents.position(id, loc, count)
    if (
      id === item.value?.id &&
      position.value.page === loc.page &&
      position.value.offset === loc.offset
    )
      unsaved.value = false
  } catch (e) {
    if (!disposed) error.value = '阅读位置未保存：' + (e as Error).message
  }
}
async function beforeNavigate() {
  if (busy.value) return false
  if (editing.value && !confirm('放弃尚未保存的标注编辑并离开？')) return false
  await savePosition()
  if (unsaved.value && !confirm('阅读位置尚未保存，仍要离开？')) return false
}
onBeforeRouteLeave(beforeNavigate)
onBeforeRouteUpdate(beforeNavigate)
onBeforeUnmount(() => {
  disposed = true
  revision++
  referenceRevision++
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
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
function capture(
  text: string,
  loc: ReadingLocation,
  point: { x: number; y: number },
) {
  quote.value = text
  quoteLocation.value = loc
  selectionPoint.value = {
    x: Math.max(12, Math.min(window.innerWidth - 465, point.x)),
    y: Math.max(150, Math.min(window.innerHeight - 60, point.y + 10)),
  }
}
let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(message, value => { clearTimeout(noticeTimer); if(value) noticeTimer = setTimeout(() => message.value = '', 2600) })
function outsideSelection(event: PointerEvent) {
  const target = event.target as Element
  if (quote.value && !target.closest('.reader-selection') && !target.closest('[role="dialog"]')) clearSelection()
  if (!target.closest('.settings-anchor')) settingsOpen.value = false
}
function selectionChanged() { if (!window.getSelection()?.toString().trim() && !editing.value) quote.value = '' }
function escapeSelection(event: KeyboardEvent) { if(event.key==='Escape') {clearSelection();settingsOpen.value=false} }
onMounted(() => { document.addEventListener('pointerdown',outsideSelection); document.addEventListener('selectionchange',selectionChanged); document.addEventListener('keydown',escapeSelection) })
onBeforeUnmount(() => { clearTimeout(noticeTimer); document.removeEventListener('pointerdown',outsideSelection); document.removeEventListener('selectionchange',selectionChanged); document.removeEventListener('keydown',escapeSelection) })
function clearSelection() {
  quote.value = ''
  window.getSelection()?.removeAllRanges()
}
function excerpt() {
  if (quote.value)
    editing.value = {
      kind: 'excerpt',
      quote: quote.value,
      note: '',
      location: plain(quoteLocation.value),
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
  if (!confirm('移除此标注？已引用的记录会保留来源快照。')) return
  await run(async () => {
    await workspace.documents.removeAnnotation(props.id, a.id)
    annotations.value = await workspace.documents.annotations(props.id)
    selected.value = selected.value.filter((id) => id !== a.id)
  })
}
async function removeSelected() {
  if (!selected.value.length || !confirm('删除选中的 ' + selected.value.length + ' 条标注和书签？已有引用保留来源快照。')) return
  await run(async () => {
    for (const annotationId of [...selected.value]) {
      await workspace.documents.removeAnnotation(props.id,annotationId)
      selected.value = selected.value.filter(id => id !== annotationId)
      annotations.value = annotations.value.filter(a => a.id !== annotationId)
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
    await window.baoyi.app.copyText(
      await workspace.documents.markdown(props.id, [...selected.value]),
    )
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
  document
    .getElementById('annotation-' + id)
    ?.scrollIntoView({ block: 'nearest' })
}
async function ready() {
  const a = annotations.value.find((a) => a.id === route.query.annotation)
  if (a) {
    await focus(a)
    return
  }
  const id = props.id,
    run = revision
  if(typeof route.query.insight==='string'&&typeof route.query.evidence==='string'){
    try{
      const result=await window.baoyi.archive.insights.detail(id)
      if(run!==revision||id!==props.id)return
      const note=result.history.find(note=>note.id===route.query.insight),evidence=note?.evidence.find(value=>value.id===route.query.evidence)
      if(evidence)await canvas.value?.focusSource({documentId:id,name:'精读证据',quote:evidence.quote,location:{page:evidence.page||1,offset:0},line:evidence.startLine,label:evidence.page?'第 '+evidence.page+' 页':'原文引文'})
      else error.value='这条精读证据已不可用，可从速览重新打开'
    }catch(e){error.value=(e as Error).message}
    return
  }
  if (
    typeof route.query.sourceSession === 'string' &&
    typeof route.query.message === 'string'
  )
    try {
      const session = await workspace.agent.session(route.query.sourceSession)
      if (run !== revision || id !== props.id || !session) return
      const source = workspaceSources(session, route.query.message)[
        Number(route.query.source) || 0
      ]
      if (source?.documentId === id) await canvas.value?.focusSource(source)
    } catch (e) {
      error.value = (e as Error).message
    }
}
watch(
  () => [
    route.query.annotation,
    route.query.insight,
    route.query.evidence,
    route.query.sourceSession,
    route.query.message,
    route.query.source,
  ],
  () => {
    if (content.value) void ready()
  },
)
async function ask() {
  if (!quote.value) return
  const text=`请解释这段选文的含义，说明依据仅限所选片段并引用原句。
资料：[${item.value?.name||'当前资料'}](baoyi://resource/${props.id})，阅读位置 ${quoteLocation.value.page}。
选文：
${quote.value}`
  clearSelection()
  await archiveAssistant.show(text,[props.id])
}
</script>
<template>
  <main class="ws document-reader">
    <header v-if="!readerSettings.immersive" class="reader-header">
      <button
        class="ws-icon"
        aria-label="返回来源"
        @click="router.push(returnPath(route.query.from, '/document'))"
      >
        <ArrowLeft :size="18" />
      </button>

      <div class="header-book-info">
        <h1 class="header-book-title" :title="item?.name">{{ item?.name || '资料' }}</h1>
        <span v-if="novelIndex?.chapters.length" class="ws-muted current-chapter-label" :title="novelIndex.chapters[currentChapterIndex]?.title">
          {{ novelIndex.chapters[currentChapterIndex]?.title }}
        </span>
        <span v-else class="ws-muted">
          {{ item?.format.toUpperCase() }}
          <template v-if="unsaved"> · 正在保存位置</template>
        </span>
      </div>

      <div class="header-reader-tools">
        <form v-if="supported && content && !['png','jpg','jpeg'].includes(item?.format || '')" class="reader-search" @submit.prevent="canvas?.find(searchQuery)">
          <input v-model="searchQuery" type="search" aria-label="搜索正文" placeholder="搜索正文…" />
          <button class="ws-icon" aria-label="查找下一处" title="查找下一处" :disabled="!searchQuery.trim() || canvas?.searching"><Search :size="16"/></button>
        </form>
        <div v-if="item?.format === 'pdf'" class="pdf-zoom-tools">
          <button class="ws-icon" aria-label="缩小页面" title="缩小页面" @click="canvas?.changeZoom(-0.1)"><Minus :size="16"/></button>
          <span>{{Math.round((canvas?.zoom || 1)*100)}}%</span>
          <button class="ws-icon" aria-label="放大页面" title="放大页面" @click="canvas?.changeZoom(0.1)"><Plus :size="16"/></button>
        </div>
        <!-- Novel chapter switcher -->
        <template v-if="novelIndex?.chapters.length">
          <button
            class="ws-icon"
            :disabled="currentChapterIndex <= 0"
            aria-label="上一章"
            title="上一章"
            @click="canvas?.prevChapter()"
          >
            <ChevronLeft :size="18" />
          </button>
          <span class="chapter-indicator">
            {{ currentChapterIndex + 1 }} / {{ novelIndex.chapters.length }}
          </span>
          <button
            class="ws-icon"
            :disabled="currentChapterIndex >= novelIndex.chapters.length - 1"
            aria-label="下一章"
            title="下一章"
            @click="canvas?.nextChapter()"
          >
            <ChevronRight :size="18" />
          </button>
        </template>

        <!-- TOC Toggle -->
        <button
          class="ws-icon"
          :class="{ active: toc }"
          aria-label="切换阅读目录"
          title="切换阅读目录"
          @click="toggleToc"
        >
          <PanelLeft :size="18" />
        </button>

        <!-- Reading settings popover toggle -->
        <div class="settings-anchor">
          <button
            class="ws-icon"
            :class="{ active: settingsOpen }"
            aria-label="阅读偏好与设置"
            title="阅读偏好（字号、配色、编码）"
            @click="settingsOpen = !settingsOpen"
          >
            <SlidersHorizontal :size="16" />
          </button>

          <!-- Settings Popover -->
          <div v-if="settingsOpen" class="reader-settings-panel">
            <div v-if="item?.format !== 'pdf'" class="setting-row">
              <span>字号</span>
              <div class="setting-controls">
                <button
                  class="ws-icon"
                  :disabled="readerSettings.fontSize <= 12"
                  @click="readerSettings.fontSize -= 2"
                >
                  <Minus :size="13" />
                </button>
                <span>{{ readerSettings.fontSize }}px</span>
                <button
                  class="ws-icon"
                  :disabled="readerSettings.fontSize >= 32"
                  @click="readerSettings.fontSize += 2"
                >
                  <Plus :size="13" />
                </button>
              </div>
            </div>

            <div v-if="item?.format !== 'pdf'" class="setting-row">
              <span>行距</span>
              <div class="setting-controls">
                <button
                  class="ws-icon"
                  :disabled="readerSettings.lineHeight <= 1.4"
                  @click="readerSettings.lineHeight = Number((readerSettings.lineHeight - 0.2).toFixed(1))"
                >
                  <Minus :size="13" />
                </button>
                <span>{{ readerSettings.lineHeight }}</span>
                <button
                  class="ws-icon"
                  :disabled="readerSettings.lineHeight >= 2.6"
                  @click="readerSettings.lineHeight = Number((readerSettings.lineHeight + 0.2).toFixed(1))"
                >
                  <Plus :size="13" />
                </button>
              </div>
            </div>

            <div class="setting-row">
              <span>配色</span>
              <div class="theme-chips">
                <button
                  class="theme-chip light"
                  :class="{ active: readerSettings.theme === 'light' }"
                  title="白昼"
                  @click="readerSettings.theme = 'light'"
                >
                  白
                </button>
                <button
                  class="theme-chip sepia"
                  :class="{ active: readerSettings.theme === 'sepia' }"
                  title="暖黄羊皮纸"
                  @click="readerSettings.theme = 'sepia'"
                >
                  黄
                </button>
                <button
                  class="theme-chip eye"
                  :class="{ active: readerSettings.theme === 'eye' }"
                  title="护眼柔绿"
                  @click="readerSettings.theme = 'eye'"
                >
                  绿
                </button>
                <button
                  class="theme-chip dark"
                  :class="{ active: readerSettings.theme === 'dark' }"
                  title="深色夜读"
                  @click="readerSettings.theme = 'dark'"
                >
                  夜
                </button>
              </div>
            </div>

            <div v-if="item && ['txt', 'md', 'markdown'].includes(item.format)" class="setting-row">
              <span>编码</span>
              <select v-model="readerSettings.encoding" class="encoding-select" @change="reloadEncoding">
                <option value="auto">自动嗅探</option>
                <option value="utf-8">UTF-8</option>
                <option value="gb18030">GBK / GB18030</option>
                <option value="utf-16le">UTF-16 LE</option>
              </select>
            </div>
          </div>
        </div>

        <button
          ref="sideTrigger"
          class="ws-icon"
          aria-label="切换标注栏"
          :aria-expanded="side"
          :class="{ active: side }"
          title="切换书签与笔记"
          @click="toggleSide"
        >
          <PanelRight :size="18" />
        </button>

        <!-- Immersive Mode Toggle -->
        <button
          class="ws-icon"
          aria-label="沉浸模式"
          title="沉浸阅读（隐藏工具栏）"
          @click="readerSettings.immersive = true"
        >
          <Maximize2 :size="16" />
        </button>

        <button
          class="ws-button"
          :disabled="busy || !item?.available"
          title="在系统默认应用中打开"
          @click="run(() => workspace.documents.open(id))"
        >
          <ExternalLink :size="15" />外部打开
        </button>
      </div>
    </header>

    <!-- Floating button to exit immersive mode -->
    <button
      v-if="readerSettings.immersive"
      class="immersive-exit-button"
      title="退出沉浸阅读"
      @click="readerSettings.immersive = false"
    >
      <Minimize2 :size="16" />退出沉浸
    </button>
    <p v-if="error" class="ws-error reader-toast" role="alert">
      {{ error }}
      <button v-if="unsaved" class="ws-button" @click="savePosition">
        重试保存位置</button
      ><button class="ws-icon" aria-label="关闭错误" @click="error = ''">
        ×
      </button>
    </p>
    <p v-else-if="message" class="ws-notice reader-toast" role="status">
      {{ message }}
      <button class="ws-icon" aria-label="关闭提示" @click="message = ''">
        ×
      </button>
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
      <button class="ws-button" :disabled="busy" @click="bookmark"><Bookmark :size="15"/>书签</button>
      <button class="ws-button primary" :disabled="busy" @click="highlight">
        <Highlighter :size="15" />高亮</button
      ><button class="ws-button" :disabled="busy" @click="excerpt">
        <Pencil :size="14" />想法</button
      ><button class="ws-button" @click="ask">
        <Sparkles :size="14" />询问助手</button
      ><button class="ws-icon" aria-label="复制选文" @click="copyQuote">
        <Copy :size="15" /></button
      ><button class="ws-icon" aria-label="取消选文" @click="clearSelection">
        ×
      </button>
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
          {{
            loading
              ? '正在打开资料…'
              : !item?.available
                ? '原文件暂时找不到'
                : '使用熟悉的应用查看'
          }}
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
          class="ws-button"
          :disabled="busy"
          @click="
            run(async () => {
              await workspace.documents.relocate(id)
              await load()
            })
          "
        >
          重新定位</button
        ><button
          v-if="contentError"
          class="ws-button"
          :disabled="busy"
          @click="load"
        >
          重试打开
        </button>
      </div>
      <aside
        v-if="side"
        class="reader-annotations"
        @keydown.esc.stop="closeSide"
      >
        <header class="ws-section-head">
          <h2>
            标注与书签 <small class="ws-muted">{{ annotations.length }}</small>
          </h2>
          <button class="ws-icon" aria-label="收起标注栏" @click="closeSide">
            ×
          </button>
        </header>
        <p v-if="!annotations.length" class="ws-muted">
          选中原文即可高亮，或补充自己的想法。
        </p>
        <article
          v-for="a in annotations"
          :id="'annotation-' + a.id"
          :key="a.id"
          class="annotation-card"
          :class="{ active: a.id === activeAnnotation }"
          tabindex="0"
          role="button"
          :aria-label="'定位标注 ' + (a.quote || a.note || a.location.page)"
          @click="focus(a)"
          @keydown.enter.self="focus(a)"
        >
          <div class="annotation-heading">
            <input
              v-model="selected"
              type="checkbox"
              :value="a.id"
              :aria-label="'选择标注 ' + (a.quote || a.note || a.location.page)"
              @click.stop
            /><span
              >{{ a.kind === 'bookmark' ? '书签' : '标注' }} · 第
              {{ a.location.page
              }}{{
                a.location.anchor?.pages?.length
                  ? '–' + a.location.anchor.pages.at(-1)!.page
                  : ''
              }}
              {{novelIndex ? '章' : item?.format === 'pdf' ? '页' : '段'}}</span
            ><button
              class="ws-icon"
              aria-label="编辑标注"
              @click.stop="edit(a)"
            >
              <Pencil :size="13" /></button
            ><button
              class="ws-icon"
              aria-label="移除标注"
              @click.stop="remove(a)"
            >
              <Trash2 :size="13" />
            </button>
          </div>
          <blockquote v-if="a.quote">{{ a.quote }}</blockquote>
          <p v-if="a.note" class="ws-pre annotation-note">{{ a.note }}</p>
          <p
            v-if="locationStates[a.id] === 'changed'"
            class="annotation-location"
          >
            原文位置已变化
          </p>
          <p
            v-else-if="locationStates[a.id] === 'coarse'"
            class="annotation-location"
          >
            仅保留页/段位置，原句无法唯一定位
          </p>
          <AnnotationProjectLinks
            v-if="a.kind === 'excerpt'"
            :document-id="id"
            :annotation-id="a.id"
            :references="
              projectReferences.filter((r) => r.annotationId === a.id)
            "
            @changed="refreshReferences"
          />
        </article>
        <footer v-if="annotations.length" class="annotation-footer">
          <label><input type="checkbox" aria-label="全选标注" :checked="selected.length===annotations.length" @change="selected=($event.target as HTMLInputElement).checked ? annotations.map(a=>a.id) : []"/>全选</label>
          <button class="ws-button danger" :disabled="busy || !selected.length" @click="removeSelected"><Trash2 :size="14"/>删除所选标注</button>
          <span class="ws-muted">已选择 {{ selected.length }} 条</span
          ><button
            class="ws-button"
            :disabled="busy || !selected.length"
            @click="copySelected"
          >
            <Copy :size="14" />复制 Markdown</button
          ><button
            class="ws-button"
            :disabled="busy || !selected.length"
            @click="exportSelected"
          >
            <Download :size="14" />导出所选
          </button>
        </footer>
      </aside>
    </div>
    <ProjectDialog
      v-if="editing"
      :title="editing.id ? '编辑标注' : '补充想法'"
      :busy="busy"
      @close="editing = null"
      ><form
        id="annotation-form"
        class="ws ws-form"
        @submit.prevent="saveAnnotation"
      >
        <p v-if="error" class="ws-error">{{ error }}</p>
        <label v-if="editing.kind === 'excerpt'"
          >原文<textarea
            v-model="editing.quote"
            required
            maxlength="30000"
            readonly
          />
        </label>
        <p class="ws-muted">
          来源位置：第 {{ editing.location.page
          }}{{
            editing.location.anchor?.pages?.length
              ? '–' + editing.location.anchor.pages.at(-1)!.page
              : ''
          }}
          页/段
        </p>
        <label
          >我的想法<textarea
            v-model="editing.note"
            maxlength="20000"
            placeholder="记下自己的理解，也可以稍后补充。"
          />
        </label>
      </form>
      <template #footer
        ><div class="ws">
          <button
            class="ws-button primary"
            form="annotation-form"
            type="submit"
            :disabled="busy"
          >
            保存标注
          </button>
        </div></template
      ></ProjectDialog
    >
  </main>
</template>
<style scoped>
.reader-search,.pdf-zoom-tools{display:flex;align-items:center;gap:3px}.reader-search input{width:135px;min-width:65px}.pdf-zoom-tools span{font-size:12px;min-width:36px}.reader-selection{max-width:calc(100vw - 24px);flex-wrap:wrap}.header-reader-tools{flex-wrap:wrap}
.document-reader {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}
.reader-header {
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--divider);
  padding: 8px 18px;
  background: var(--bg-main);
  z-index: 30;
}
.header-book-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.header-book-title {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin: 0;
}
.current-chapter-label {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}
.header-reader-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.chapter-indicator {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}
.settings-anchor {
  position: relative;
}
.reader-settings-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: -50px;
  width: 240px;
  background: var(--bg-card, #fff);
  border: 1px solid var(--divider);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 50;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}
.setting-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.theme-chips {
  display: flex;
  gap: 6px;
}
.theme-chip {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid var(--divider);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.1s ease;
}
.theme-chip:hover {
  transform: scale(1.08);
}
.theme-chip.active {
  outline: 2px solid var(--primary, #3b82f6);
  outline-offset: 1px;
}
.theme-chip.light {
  background: #ffffff;
  color: #111;
}
.theme-chip.sepia {
  background: #fbf0d9;
  color: #5f4b32;
}
.theme-chip.eye {
  background: #e8f5e9;
  color: #2e4d34;
}
.theme-chip.dark {
  background: #18181b;
  color: #fff;
}
.encoding-select {
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--divider);
  font-size: 12px;
  background: var(--bg-card, transparent);
  color: var(--text);
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
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  border: none;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  transition: opacity 0.2s ease;
}
.immersive-exit-button:hover {
  background: rgba(0, 0, 0, 0.85);
}
.reader-body {
  display: flex;
  min-height: 0;
  flex: 1;
  min-width: 0;
}
.reader-annotations {
  flex: 0 0 295px;
  border-left: 1px solid var(--divider);
  padding: 22px 18px;
  overflow: auto;
}
.reader-annotations h2 {
  font-size: 16px;
}
.annotation-card {
  padding: 15px 5px;
  border-bottom: 1px solid var(--divider);
  cursor: pointer;
  scroll-margin: 10px;
}
.annotation-card.active {
  background: var(--ws-tint);
  box-shadow: inset 3px 0 var(--accent);
}
.annotation-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--text-sub);
}
.annotation-heading > span {
  flex: 1;
  text-align: left;
}
.annotation-heading .ws-icon {
  width: 22px;
  height: 26px;
}
.annotation-card blockquote {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.8;
  border-left: 2px solid var(--accent);
  padding-left: 12px;
  margin: 12px 0;
}
.annotation-note,
.annotation-location {
  font-size: 12px;
  color: var(--text-sub);
}
.annotation-location {
  color: var(--accent);
}
.annotation-footer {
  position: sticky;
  bottom: -22px;
  background: var(--bg-main);
  padding: 17px 0;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.annotation-footer > span {
  width: 100%;
}
.reader-selection {
  position: fixed;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 5px;
  background: var(--bg-main);
  border: 1px solid var(--divider);
  box-shadow: 0 5px 20px #0002;
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
  box-shadow: 0 3px 12px #0001;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  max-width: calc(100% - 40px);
  display: flex;
  align-items: center;
  gap: 8px;
}
@media (max-width: 1100px) {
  .reader-annotations {
    flex-basis: 250px;
    padding: 18px 14px;
  }
  .reader-header {
    padding: 12px 15px;
    gap: 9px;
  }
}
@media (max-width: 850px) {
  .reader-annotations {
    position: absolute;
    right: 0;
    top: 70px;
    bottom: 0;
    width: 285px;
    z-index: 15;
    background: var(--bg-main);
    box-shadow: -8px 0 24px #0002;
  }
  .reader-header .ws-button {
    font-size: 11px;
    padding: 7px;
  }
  .reader-header .ws-button svg {
    display: none;
  }
}
</style>
