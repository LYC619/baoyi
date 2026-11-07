<script setup lang="ts">
import {
  ref,
  shallowRef,
  computed,
  onMounted,
  onBeforeUnmount,
  watch,
  nextTick,
} from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { loadPdfDocument, BaoyiPdfRangeTransport } from '@/utils/pdf-document'
import {
  normalizeOutline,
  outlinePage,
  type OutlineNode,
} from '@/utils/pdf-outline'
import PdfOutline from './PdfOutline.vue'
import PdfReaderPage from './PdfReaderPage.vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import type { ReadingLocation, DocumentAnnotation, NovelIndexResult } from '@/types/workspace'
import {
  makeTextAnchor,
  resolveTextAnchor,
  rangeOffsets,
  rangeFromOffsets,
} from '@/utils/document-anchor'
import { workspace } from '@/utils/workspace-api'
import type { WorkspaceSource } from '@/utils/workspace-sources'
const props = defineProps<{
  documentId?: string
  content: { format: string; text: string; data?: Uint8Array; isLarge?: boolean; size?: number }
  initial: ReadingLocation
  toc: boolean
  annotations?: DocumentAnnotation[]
  novelIndex?: NovelIndexResult | null
  readerSettings?: {
    fontSize: number
    lineHeight: number
    theme: string
    encoding: string
    mode?: 'scroll' | 'paged'
  }
}>()
const emit = defineEmits<{
  position: [location: ReadingLocation, count: number]
  selection: [
    quote: string,
    location: ReadingLocation,
    point: { x: number; y: number },
  ]
  annotation: [id: string]
  locations: [states: Record<string, string>]
  ready: []
  chapterChange: [index: number]
}>()
const viewport = ref<HTMLElement>(),
  tocPanel = ref<HTMLElement>(),
  pdfStack = ref<HTMLElement>(),
  pdfWidth = ref(600),
  page = ref(1),
  count = ref(1),
  zoom = ref(1),
  error = ref(''),
  search = ref(''),
  searching = ref(false),
  searchMessage = ref(''),
  loading = ref(false)
const pdfMode = computed(() => props.content.format === 'pdf'),
  imageMode = computed(() =>
    ['png', 'jpg', 'jpeg'].includes(props.content.format),
  ),
  streamedMode = computed(() => Boolean(props.novelIndex && props.novelIndex.chapters.length > 0)),
  novelMode = computed(() => streamedMode.value && props.content.format === 'txt'),
  streamedMarkdown = computed(() => DOMPurify.sanitize(marked.parse(currentChapterText.value) as string, { FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'object', 'embed', 'form', 'input'], FORBID_ATTR: ['href', 'src', 'style'] })),
  imageUrl = ref('')

const activeChapter = ref(0)
watch([activeChapter,()=>props.toc],async()=>{
  await nextTick()
  tocPanel.value?.querySelector('.toc-chapter-item.active')?.scrollIntoView({block:'nearest'})
})
const currentChapterText = ref('')
const chapterLoading = ref(false)
let chapterRevision = 0

const novelParagraphs = computed(() => {
  if (!currentChapterText.value) return []
  return currentChapterText.value
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
})

async function loadChapter(index: number, initialOffset = 0) {
  if (!props.novelIndex || !props.novelIndex.chapters.length || !props.documentId) return
  const safeIdx = Math.max(0, Math.min(index, props.novelIndex.chapters.length - 1))
  activeChapter.value = safeIdx
  const ch = props.novelIndex.chapters[safeIdx]
  const run = ++chapterRevision
  chapterLoading.value = true
  highlights.value = []
  try {
    const res = await workspace.documents.textSlice(
      props.documentId,
      ch.byteOffset,
      ch.byteLength,
      props.novelIndex.encoding,
    )
    if (run !== chapterRevision || disposed) return
    currentChapterText.value = res.text
    page.value = safeIdx + 1
    count.value = props.novelIndex.chapters.length
    emit('chapterChange', safeIdx)
    await nextTick()
    if (run !== chapterRevision || disposed) return
    if (viewport.value) {
      viewport.value.scrollTop = initialOffset * Math.max(1, viewport.value.scrollHeight - viewport.value.clientHeight)
    }
    emit('position', position(), count.value)
    refreshHighlights()
  } catch (e) {
    if (run === chapterRevision) error.value = (e as Error).message
  } finally {
    if (run === chapterRevision) chapterLoading.value = false
  }
}

function prevChapter() {
  if (streamedMode.value && activeChapter.value > 0) {
    loadChapter(activeChapter.value - 1)
  }
}

function nextChapter() {
  if (streamedMode.value && activeChapter.value < (props.novelIndex?.chapters.length || 0) - 1) {
    loadChapter(activeChapter.value + 1)
  }
}
const chunks = computed(() =>
  props.content.format === 'txt'
    ? props.content.text
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((text) => ({
          html: DOMPurify.sanitize(
            '<p>' +
              text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/\n/g, '<br>') +
              '</p>',
          ),
          text,
          heading: '',
        }))
    : marked
        .lexer(props.content.text)
        .filter((t) => t.type !== 'space')
        .map((t) => ({
          html: DOMPurify.sanitize(marked.parser([t]), {
            FORBID_TAGS: [
              'img',
              'video',
              'audio',
              'iframe',
              'object',
              'embed',
              'form',
              'input',
            ],
            FORBID_ATTR: ['href', 'src', 'style'],
          }),
          text: t.raw,
          heading: t.type === 'heading' ? t.text : '',
        })),
)
const headings = computed(() =>
  chunks.value
    .map((c, index) => ({ text: c.heading, page: index + 1 }))
    .filter((c) => c.text),
)
const surface = ref<HTMLElement>(),
  prose = ref<HTMLElement>(),
  active = ref(''),
  highlights = ref<
    Array<{ id: string; x: number; y: number; width: number; height: number }>
  >([])
const sourceAnnotation = ref<DocumentAnnotation>()
const pdf = shallowRef<PDFDocumentProxy>(),
  pageViews = new Map<number, { ensure: () => Promise<void> | undefined }>()
const outline = ref<OutlineNode[]>([]),
  outlineLoading = ref(false),
  outlineError = ref(''),
  outlineTruncated = ref(false),
  outlineActive = ref(''),
  outlineTargetPage = ref(0)
const outlinePages = new Map<string, Promise<number | null>>()
let outlineNavigation = 0
async function readOutline(instance: PDFDocumentProxy) {
  outlineLoading.value = true
  try {
    const result = normalizeOutline(await instance.getOutline())
    if (!disposed && pdf.value === instance) {
      outline.value = result.nodes
      outlineTruncated.value = result.truncated
    }
  } catch {
    if (!disposed && pdf.value === instance)
      outlineError.value = '章节目录读取失败，仍可按页阅读'
  } finally {
    if (!disposed && pdf.value === instance) outlineLoading.value = false
  }
}
async function navigateOutline(node: OutlineNode) {
  const instance = pdf.value
  if (!instance) return
  const request = ++outlineNavigation
  if (!outlinePages.has(node.id))
    outlinePages.set(node.id, outlinePage(instance, node.dest))
  const target = await outlinePages.get(node.id)
  if (disposed || pdf.value !== instance || request !== outlineNavigation)
    return
  if (target == null) {
    outlineError.value = '此章节无法定位'
    return
  }
  outlineError.value = ''
  outlineActive.value = node.id
  outlineTargetPage.value = target
  await jump({ page: target, offset: 0 })
}
watch(page, (n) => {
  if (n !== outlineTargetPage.value) outlineActive.value = ''
})
const setPageView = (n: number, value: unknown) => {
  if (value) pageViews.set(n, value as { ensure: () => Promise<void> })
  else pageViews.delete(n)
}
const textRoot = () => (pdfMode.value ? pdfStack.value : prose.value)
const pdfLayer = (n: number) =>
  pdfStack.value?.querySelector<HTMLElement>(
    `[data-pdf-page="${n}"] .textLayer`,
  )
const pdfParts = (a: DocumentAnnotation) => [
  { page: a.location.page, anchor: a.location.anchor },
  ...(a.location.anchor?.pages || []),
]
function annotationRanges(a: DocumentAnnotation): Range[] {
  if (!pdfMode.value) {
    const r = annotationRange(a)
    return r ? [r] : []
  }
  return pdfParts(a).flatMap((part) => {
    const root = pdfLayer(part.page)
    if (!root) return []
    const found = resolveTextAnchor(
      root.textContent || '',
      part.anchor,
      a.quote,
    )
    const r = found ? rangeFromOffsets(root, found.start, found.end) : null
    return r ? [r] : []
  })
}
function annotationRange(a: DocumentAnnotation): Range | null {
  if (streamedMode.value && a.location.page !== activeChapter.value + 1) return null
  const root = pdfMode.value ? pdfLayer(a.location.page) : prose.value
  if (!root) return null
  if (a.location.anchor) {
    const found = resolveTextAnchor(root.textContent || '', a.location.anchor)
    return found ? rangeFromOffsets(root, found.start, found.end) : null
  }
  const scope = pdfMode.value
    ? root
    : root.querySelector(`[data-paragraph="${a.location.page}"]`)
  if (!scope) return null
  const found = resolveTextAnchor(scope.textContent || '', undefined, a.quote)
  return found ? rangeFromOffsets(scope, found.start, found.end) : null
}
function boxes(range: Range) {
  const seen = new Set<string>()
  return [...range.getClientRects()].filter((r) => {
    const key = [r.x, r.y, r.width, r.height]
      .map((n) => Math.round(n * 10))
      .join(':')
    if (r.width < 1 || r.height < 1 || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
function refreshHighlights() {
  const base = (
      pdfMode.value ? pdfStack.value : surface.value
    )?.getBoundingClientRect(),
    states: Record<string, string> = {},
    result: typeof highlights.value = []
  if (!base) return
  for (const a of [
    ...(props.annotations || []),
    ...(sourceAnnotation.value ? [sourceAnnotation.value] : []),
  ]) {
    if (a.kind === 'bookmark') continue
    const ranges = annotationRanges(a),
      expected = pdfMode.value ? pdfParts(a).length : 1
    const pending =
      (streamedMode.value && a.location.page !== activeChapter.value + 1) ||
      (pdfMode.value &&
      pdfParts(a).some(
        (p) =>
          p.page <= count.value &&
          pdfLayer(p.page)?.parentElement?.dataset.rendered !== 'true',
      ))
    states[a.id] =
      ranges.length === expected
        ? 'located'
        : pending
          ? 'pending'
          : a.location.anchor
            ? 'changed'
            : 'coarse'
    for (const range of ranges)
      for (const r of boxes(range))
        result.push({
          id: a.id,
          x: r.left - base.left,
          y: r.top - base.top,
          width: r.width,
          height: r.height,
        })
  }
  highlights.value = result
  emit('locations', states)
}
async function focusAnnotation(a: DocumentAnnotation) {
  if (!ready) {
    pendingFocus = a
    return
  }
  if (pdfMode.value) {
    await jump(a.location)
    await Promise.all(pdfParts(a).map((p) => pageViews.get(p.page)?.ensure()))
  } else if (streamedMode.value) {
    await jump(a.location)
  }
  await nextTick()
  const range = annotationRange(a)
  if (range && viewport.value) {
    const box = range.getBoundingClientRect(),
      view = viewport.value.getBoundingClientRect()
    viewport.value.scrollTop +=
      box.top - view.top - Math.min(120, view.height / 3)
    active.value = a.id
    emit('annotation', a.id)
  } else await jump({ page: a.location.page, offset: a.location.offset })
  refreshHighlights()
}
function hitAnnotation(event: MouseEvent) {
  if (window.getSelection()?.toString().trim()) return
  for (const a of props.annotations || []) {
    const ranges = annotationRanges(a)
    if (
      ranges
        .flatMap(boxes)
        .some(
          (r) =>
            event.clientX >= r.left &&
            event.clientX <= r.right &&
            event.clientY >= r.top &&
            event.clientY <= r.bottom,
        )
    ) {
      active.value = a.id
      emit('annotation', a.id)
      break
    }
  }
}
async function focusSource(source: WorkspaceSource) {
  let location = { ...source.location }
  if (source.line) {
    let cursor = 0,
      paragraph = 1
    for (const [i, c] of chunks.value.entries()) {
      const start = props.content.text.indexOf(c.text, cursor)
      if (start < 0) continue
      const line = props.content.text.slice(0, start).split('\n').length
      if (line > source.line) break
      paragraph = i + 1
      cursor = start + c.text.length
    }
    location = { page: paragraph, offset: 0 }
  }
  await jump(location)
  const note: DocumentAnnotation = {
    id: 'agent-source',
    documentId: source.documentId,
    kind: 'excerpt',
    quote: source.quote.trim(),
    note: '',
    location,
    createdAt: 0,
    updatedAt: 0,
  }
  sourceAnnotation.value = note
  await focusAnnotation(note)
}
let task: ReturnType<typeof loadPdfDocument> | undefined,
  disposed = false,
  ready = false,
  scrollTimer: ReturnType<typeof setTimeout> | undefined,
  pendingFocus: DocumentAnnotation | undefined
async function renderPdf() {
  pdfWidth.value = viewport.value?.clientWidth || 600
  await nextTick()
  await pageViews.get(page.value)?.ensure()
  refreshHighlights()
}
function position(): ReadingLocation {
  if (streamedMode.value) {
    const el = viewport.value
    return { page: activeChapter.value + 1, offset: el ? Math.max(0, Math.min(1, el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight))) : 0 }
  }
  const el = viewport.value,
    leaf = pdfStack.value?.querySelector<HTMLElement>(
      `[data-pdf-page="${page.value}"]`,
    )
  const offset =
    pdfMode.value && el && leaf
      ? Math.max(
          0,
          Math.min(
            1,
            (el.getBoundingClientRect().top -
              leaf.getBoundingClientRect().top) /
              leaf.offsetHeight,
          ),
        )
      : 0
  return { page: page.value, offset }
}
function record() {
  if (ready && !chapterLoading.value) emit('position', position(), count.value)
}
async function jump(location: ReadingLocation) {
  if (streamedMode.value && props.novelIndex?.chapters.length) {
    const chIdx = Math.max(0, Math.min(Math.floor(location.page) - 1, props.novelIndex.chapters.length - 1))
    await loadChapter(chIdx, location.offset)
    return
  }
  page.value = Math.min(count.value, Math.max(1, Math.floor(location.page)))
  if (pdfMode.value) {
    await renderPdf()
    const leaf = pdfStack.value?.querySelector<HTMLElement>(
      `[data-pdf-page="${page.value}"]`,
    )
    if (leaf && viewport.value) {
      leaf.scrollIntoView({ block: 'start' })
      viewport.value.scrollTop += location.offset * leaf.offsetHeight
    }
  } else if (!imageMode.value)
    viewport.value
      ?.querySelector(`[data-paragraph="${page.value}"]`)
      ?.scrollIntoView({ block: 'start' })
  record()
}
defineExpose({
  jump,
  focusAnnotation,
  focusSource,
  loadChapter,
  prevChapter,
  nextChapter,
  activeChapter,
  find,
  searching,
  searchMessage,
  zoom,
  changeZoom,
})
function scroll() {
  if (!ready || chapterLoading.value) return
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => {
    if (!streamedMode.value && !imageMode.value && viewport.value) {
      const top = viewport.value.getBoundingClientRect().top,
        blocks = [
          ...viewport.value.querySelectorAll<HTMLElement>(
            pdfMode.value ? '[data-pdf-page]' : '[data-paragraph]',
          ),
        ]
      const first = blocks.find(
        (el) => el.getBoundingClientRect().bottom > top + 25,
      )
      if (first)
        page.value = Number(
          pdfMode.value ? first.dataset.pdfPage : first.dataset.paragraph,
        )
    }
    record()
  }, 200)
}
function select() {
  if (chapterLoading.value) return
  const selection = window.getSelection(),
    root = textRoot()
  if (
    !selection?.rangeCount ||
    !selection.toString().trim() ||
    !root?.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  )
    return
  const range = selection.getRangeAt(0),
    quote = selection.toString().trim()
  if (quote.length > 30000) {
    error.value = '单条标注最多 30000 字，请分段保存'
    return
  }
  const rects = boxes(range),
    box = rects.at(-1) || range.getBoundingClientRect()
  let location: ReadingLocation
  if (pdfMode.value) {
    const parts: Array<{
      page: number
      anchor: NonNullable<ReadingLocation['anchor']>
    }> = []
    for (const layer of pdfStack.value?.querySelectorAll<HTMLElement>(
      '.textLayer',
    ) || []) {
      if (!range.intersectsNode(layer) || !layer.textContent) continue
      const part = range.cloneRange()
      if (!layer.contains(range.startContainer)) part.setStart(layer, 0)
      if (!layer.contains(range.endContainer))
        part.setEnd(layer, layer.childNodes.length)
      const offsets = rangeOffsets(layer, part)
      if (offsets.end <= offsets.start) continue
      const anchor = makeTextAnchor(
          layer.textContent,
          offsets.start,
          offsets.end,
          'pdf',
        ),
        paper = layer.parentElement!,
        p = paper.getBoundingClientRect(),
        clamp = (n: number) => Math.max(0, Math.min(1, n))
      anchor.regions = boxes(part).map((r) => {
        const x = clamp((r.left - p.left) / p.width),
          y = clamp((r.top - p.top) / p.height)
        return {
          x,
          y,
          width: Math.min(1 - x, clamp(r.width / p.width)),
          height: Math.min(1 - y, clamp(r.height / p.height)),
        }
      })
      parts.push({ page: Number(paper.dataset.pdfPage), anchor })
    }
    if (!parts.length) return
    const [first, ...rest] = parts
    if (rest.length) first.anchor.pages = rest
    location = { page: first.page, offset: 0, anchor: first.anchor }
  } else {
    const offsets = rangeOffsets(root, range),
      anchor = makeTextAnchor(
        root.textContent || '',
        offsets.start,
        offsets.end,
        'text',
      ),
      node =
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement,
      paragraph = node?.closest<HTMLElement>('[data-paragraph]')
    location = {
      page: streamedMode.value ? activeChapter.value + 1 : paragraph ? Number(paragraph.dataset.paragraph) : page.value,
      offset: streamedMode.value ? position().offset : 0,
      anchor,
    }
  }
  emit('selection', quote, location, { x: box.left, y: box.bottom })
}
let lastMatch: {query:string;page:number;start:number;occurrence?:number} | undefined
function changeZoom(delta:number) {zoom.value=Math.max(.7,Math.min(2,Math.round((zoom.value+delta)*10)/10))}
function showSearchRange(root:HTMLElement|null|undefined, query:string, occurrence=0, scrollToMatch=true) {
  if(!root) return
  const text=root.textContent || '', lower=text.toLowerCase(), term=query.toLowerCase()
  let start=lower.indexOf(term)
  for(let i=0;i<occurrence && start>=0;i++)start=lower.indexOf(term,start+term.length)
  if(start<0)return
  const range=rangeFromOffsets(root,start,start+term.length)
  if(!range)return
  const view=viewport.value
  if(view&&scrollToMatch)view.scrollTop+=range.getBoundingClientRect().top-view.getBoundingClientRect().top-100
  const api=(CSS as any).highlights, HighlightClass=(window as any).Highlight
  if(api&&HighlightClass)api.set('document-search',new HighlightClass(range))
}
function pageRendered(n:number) {
  refreshHighlights()
  if(lastMatch?.page===n&&lastMatch.query===search.value.toLowerCase()) showSearchRange(pdfLayer(n),lastMatch.query,lastMatch.occurrence||0,false)
}
async function find(query:string) {
  query=query.trim()
  if(!query||searching.value)return
  searching.value=true;search.value=query;searchMessage.value='正在查找…'
  ;(CSS as any).highlights?.delete('document-search')
  try {
    const term=query.toLowerCase(),previous=lastMatch?.query===term?lastMatch:undefined
    if(streamedMode.value&&props.documentId){
      const match=await workspace.documents.searchText(props.documentId,query,previous?.page||page.value,previous?previous.start+query.length:0,props.novelIndex?.encoding)
      if(disposed)return
      if(!match){searchMessage.value='未找到匹配内容';return}
      await loadChapter(match.page-1)
      showSearchRange(prose.value,query,match.occurrence)
      lastMatch={query:term,page:match.page,start:match.start}
      searchMessage.value='已找到 · 第 '+match.page+' 章'
    } else if(pdfMode.value&&pdf.value){
      const instance=pdf.value,first=previous?.page||page.value
      for(let step=0;step<=count.value;step++){
        if(disposed||pdf.value!==instance)return
        const n=(first-1+step)%count.value+1,content=await (await instance.getPage(n)).getTextContent()
        const text=content.items.map(i=>'str' in i?i.str:'').join(''),lower=text.toLowerCase()
        const start=lower.indexOf(term,step===0&&previous?previous.start+query.length:0)
        if(start<0)continue
        await jump({page:n,offset:0});await pageViews.get(n)?.ensure();await nextTick()
        let occurrence=0,cursor=lower.indexOf(term)
        while(cursor>=0&&cursor<start){occurrence++;cursor=lower.indexOf(term,cursor+term.length)}
        showSearchRange(pdfLayer(n),query,occurrence)
        lastMatch={query:term,page:n,start,occurrence};searchMessage.value='已找到 · 第 '+n+' 页';return
      }
      searchMessage.value='未找到匹配内容（扫描页需文字层）'
    } else {
      const first=previous?.page||page.value
      for(let step=0;step<=chunks.value.length;step++){
        const n=(first-1+step)%chunks.value.length,lower=chunks.value[n]?.text.toLowerCase()||''
        const start=lower.indexOf(term,step===0&&previous?previous.start+query.length:0)
        if(start<0)continue
        await jump({page:n+1,offset:0});await nextTick()
        let occurrence=0,cursor=lower.indexOf(term)
        while(cursor>=0&&cursor<start){occurrence++;cursor=lower.indexOf(term,cursor+term.length)}
        showSearchRange(prose.value?.querySelector<HTMLElement>('[data-paragraph="'+(n+1)+'"]'),query,occurrence)
        lastMatch={query:term,page:n+1,start};searchMessage.value='已找到 · 第 '+(n+1)+' 段';return
      }
      searchMessage.value='未找到匹配内容'
    }
  }catch(e){if(!disposed)searchMessage.value='搜索失败：'+(e as Error).message}
  finally{searching.value=false}
}
watch(zoom, async () => {
  if (pdfMode.value) void renderPdf()
  else {
    await nextTick()
    refreshHighlights()
  }
})
watch(() => [props.readerSettings?.fontSize, props.readerSettings?.lineHeight], async () => {
  await nextTick()
  if (!disposed) refreshHighlights()
})
watch(
  () => props.annotations,
  async () => {
    await nextTick()
    refreshHighlights()
  },
  { deep: true },
)
let observer: ResizeObserver | undefined,
  resizeTimer: ReturnType<typeof setTimeout> | undefined
onMounted(async () => {
  loading.value = true
  try {
    const preferences = await workspace.preferences.get('document')
    if (disposed) return
    zoom.value = pdfMode.value ? preferences.pdfZoom : 1
    if (pdfMode.value) {
      if (props.content.isLarge && props.documentId) {
        task = loadPdfDocument(new BaoyiPdfRangeTransport(props.documentId, props.content.size || 0))
      } else {
        task = loadPdfDocument(props.content.data!)
      }
      pdf.value = await task.promise
      if (disposed) return
      count.value = pdf.value.numPages
      void readOutline(pdf.value)
    } else if (imageMode.value) {
      imageUrl.value = URL.createObjectURL(
        new Blob([props.content.data!.slice().buffer as ArrayBuffer], {
          type: props.content.format === 'png' ? 'image/png' : 'image/jpeg',
        }),
      )
    } else if (streamedMode.value && props.novelIndex?.chapters.length) {
      count.value = props.novelIndex.chapters.length
      const initialChapter = Math.max(0, Math.min(props.initial.page - 1, count.value - 1))
      await loadChapter(initialChapter, props.initial.offset)
    } else {
      count.value = Math.max(1, chunks.value.length)
      await nextTick()
      await jump(props.initial)
    }
    ready = true
    record()
    refreshHighlights()
    if (pendingFocus) {
      const target = pendingFocus
      pendingFocus = undefined
      await focusAnnotation(target)
    }
    emit('ready')
    let lastWidth = viewport.value?.clientWidth
    observer = new ResizeObserver(() => {
      const width = viewport.value?.clientWidth
      if (width === lastWidth) return
      lastWidth = width
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (pdfMode.value) void renderPdf()
        else refreshHighlights()
      }, 150)
    })
    if (viewport.value) observer.observe(viewport.value)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
})
onBeforeUnmount(() => {
  disposed = true
  ;(CSS as any).highlights?.delete('document-search')
  ready = false
  observer?.disconnect()
  clearTimeout(scrollTimer)
  clearTimeout(resizeTimer)
  void task?.destroy()
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
})
</script>
<template>
  <div class="reader-document">
    <aside v-if="toc" ref="tocPanel" class="reader-toc">
      <h3>目录</h3>
      <template v-if="pdfMode"
        ><PdfOutline
          :nodes="outline"
          :loading="outlineLoading"
          :error="outlineError"
          :truncated="outlineTruncated"
          :active="outlineActive"
          @navigate="navigateOutline" />
        <p class="ws-muted">原版页面 · {{ count }} 页</p>
        <label
          >跳转页码<input
            type="number"
            aria-label="跳转到页码"
            :value="page"
            min="1"
            :max="count"
            @change="
              jump({
                page: Number(($event.target as HTMLInputElement).value),
                offset: 0,
              })
            " /></label></template>
      <template v-else-if="streamedMode">
        <div class="toc-novel-list">
          <button
            v-for="ch in props.novelIndex?.chapters"
            :key="ch.index"
            class="toc-chapter-item"
            :class="{ active: activeChapter === ch.index }"
            :title="ch.title"
            @click="loadChapter(ch.index)"
          >
            {{ ch.title }}
          </button>
        </div>
      </template>
      <template v-else>
        <button
          v-for="heading in headings"
          :key="heading.page"
          :class="{ active: page === heading.page }"
          @click="jump({ page: heading.page, offset: 0 })"
        >
          {{ heading.text }}
        </button>
        <p v-if="!headings.length" class="ws-muted">
          此资料没有章节标题。
        </p></template
      >
    </aside>
    <div class="reader-canvas-main">
      <div class="ws-toolbar reader-controls">
        <template v-if="pdfMode"
          ><button
            class="ws-icon"
            aria-label="上一页"
            :disabled="page <= 1 || loading"
            @click="jump({ page: page - 1, offset: 0 })"
          >
            <ChevronLeft :size="18" /></button
          ><span>{{ page }} / {{ count }}</span
          ><button
            class="ws-icon"
            aria-label="下一页"
            :disabled="page >= count || loading"
            @click="jump({ page: page + 1, offset: 0 })"
          >
            <ChevronRight :size="18" /></button></template
        ><span v-else-if="!imageMode" class="ws-muted">第 {{ page }} / {{ count }} {{ streamedMode ? '章' : '段' }}</span>
        <span v-if="searchMessage" class="reader-search-message" role="status">{{searchMessage}}</span>
      </div>
      <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
      <div
        ref="viewport"
        class="reader-viewport"
        @scroll.passive="scroll"
        @mouseup="select"
        @keyup="select"
        @click="hitAnnotation"
      >
        <div v-if="loading" class="reader-loading" role="status">
          正在载入页面…
        </div>
        <div v-if="pdfMode" ref="pdfStack" class="pdf-stack">
          <template v-if="pdf"
            ><PdfReaderPage
              v-for="n in count"
              :key="n"
              :ref="(value) => setPageView(n, value)"
              :pdf="pdf"
              :page="n"
              :width="pdfWidth"
              :zoom="zoom"
              @rendered="pageRendered(n)"
              @error="(message) => (error = message)"
          /></template>
          <span
            v-for="(h, i) in highlights"
            :key="i"
            class="annotation-highlight"
            :class="{ active: h.id === active }"
            :data-annotation="h.id"
            :style="{
              left: h.x + 'px',
              top: h.y + 'px',
              width: h.width + 'px',
              height: h.height + 'px',
            }"
          />
        </div>
        <img
          v-else-if="imageMode"
          :src="imageUrl"
          alt="资料原图"
          class="document-image"
          :style="{ width: zoom * 90 + '%' }"
        />
        <div v-else ref="surface" class="text-surface" :class="'theme-' + (props.readerSettings?.theme || 'light')">
          <article
            v-if="streamedMode"
            ref="prose"
            class="document-prose"
            :class="{ 'novel-prose': novelMode }"
            :style="{ fontSize: (props.readerSettings?.fontSize || 18) + 'px', lineHeight: props.readerSettings?.lineHeight || 1.8 }"
          >
            <div v-if="chapterLoading" class="novel-chapter-loading">正在读取章节内容…</div>
            <header v-if="novelMode" class="novel-chapter-header">
              <h2>{{ props.novelIndex?.chapters[activeChapter]?.title }}</h2>
            </header>
            <section v-if="!novelMode" :data-paragraph="activeChapter + 1" v-html="streamedMarkdown" />
            <template v-else><p
              v-for="(para, pIdx) in novelParagraphs"
              :key="pIdx"
              :data-paragraph="pIdx + 1"
              class="novel-paragraph"
            >
              {{ para }}
            </p></template>
            <div class="chapter-nav-bottom">
              <button
                class="ws-button"
                :disabled="activeChapter <= 0 || chapterLoading"
                @click="prevChapter"
              >
                上一章
              </button>
              <span class="ws-muted">
                第 {{ activeChapter + 1 }} / {{ props.novelIndex?.chapters.length }} 章
              </span>
              <button
                class="ws-button primary"
                :disabled="activeChapter >= (props.novelIndex?.chapters.length || 1) - 1 || chapterLoading"
                @click="nextChapter"
              >
                下一章
              </button>
            </div>
          </article>
          <article
            v-else
            ref="prose"
            class="document-prose"
            :style="{ fontSize: (props.readerSettings?.fontSize || 18) + 'px', lineHeight: props.readerSettings?.lineHeight || 1.8 }"
          >
            <section
              v-for="(chunk, index) in chunks"
              :key="index"
              :data-paragraph="index + 1"
              :class="{
                matched:
                  search &&
                  chunk.text.toLowerCase().includes(search.toLowerCase()),
              }"
              v-html="chunk.html"
            />
          </article>
          <span
            v-for="(h, i) in highlights"
            :key="i"
            class="annotation-highlight"
            :class="{ active: h.id === active }"
            :data-annotation="h.id"
            :style="{
              left: h.x + 'px',
              top: h.y + 'px',
              width: h.width + 'px',
              height: h.height + 'px',
            }"
          />
        </div>
      </div>
    </div>
  </div>
</template>
<style>
::highlight(document-search){background:#f5d56e;color:#242424}
</style>
<style scoped>
.reader-search-message{font-size:12px;margin-left:auto;color:var(--text-sub)}
.pdf-stack {
  position: relative;
  display: flow-root;
}
.text-surface {
  position: relative;
  display: flow-root;
}
.annotation-highlight {
  position: absolute;
  pointer-events: none;
  background: #ddbd4052;
  border-bottom: 1px solid #b89a4277;
  border-radius: 2px;
  z-index: 2;
}
.annotation-highlight.active {
  background: #5baf8f66;
  outline: 1px solid var(--accent);
  animation: annotation-pulse 1.2s ease-out;
}
@keyframes annotation-pulse {
  from {
    background: #e6ba2dcc;
  }
  to {
    background: #5baf8f66;
  }
}
.reader-document {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
}
.reader-toc {
  width: 230px;
  flex: none;
  padding: 22px 15px;
  border-right: 1px solid var(--divider);
  overflow: auto;
}
.reader-toc button {
  display: block;
  width: 100%;
  text-align: left;
  color: var(--text-sub);
  font-size: 12px;
  padding: 8px 5px;
  overflow-wrap: anywhere;
}
.reader-toc button.active {
  color: var(--accent);
}
.reader-canvas-main {
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}
.reader-controls {
  padding: 8px 18px;
  margin: 0;
  border-bottom: 1px solid var(--divider);
  font-size: 12px;
}
.reader-controls input {
  max-width: 180px;
  padding: 6px 9px;
}
.reader-viewport {
  position: relative;
  overflow: auto;
  min-height: 0;
  flex: 1;
  scroll-behavior: auto;
  padding: 24px;
  user-select: text;
}
.reader-loading {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--ws-paper);
  text-align: center;
  font-size: 12px;
  color: var(--text-sub);
}
.document-prose {
  max-width: 720px;
  margin: auto;
  line-height: 1.95;
  user-select: text;
  overflow-wrap: anywhere;
}
.document-prose section {
  scroll-margin-top: 15px;
}
.document-prose .matched {
  background: var(--ws-tint);
  outline: 1px solid var(--accent);
}
.document-prose :deep(h1) {
  font: 600 1.85em/1.5 var(--font-display);
  margin: 0 0 1em;
}
.document-prose :deep(h2) {
  font-size: 1.4em;
  margin: 1.5em 0 0.7em;
}
.document-prose :deep(h3) {
  font-size: 1.16em;
  margin: 1.3em 0 0.5em;
}
.document-prose :deep(p) {
  margin: 0.7em 0;
}
.document-prose :deep(pre) {
  white-space: pre-wrap;
  background: var(--ws-tint);
  padding: 16px;
  border-radius: 5px;
  font-size: 0.85em;
}
.document-prose :deep(ul),
.document-prose :deep(ol) {
  padding-left: 1.8em;
}
.document-prose :deep(blockquote) {
  border-left: 3px solid var(--accent);
  padding: 4px 18px;
  color: var(--text-sub);
}
.document-prose :deep(table) {
  border-collapse: collapse;
  display: block;
  overflow: auto;
}
.document-prose :deep(td),
.document-prose :deep(th) {
  border: 1px solid var(--divider);
  padding: 8px 14px;
}
.pdf-page {
  position: relative;
  margin: auto;
  background: #fff;
  box-shadow: 0 2px 8px #0002;
  user-select: text;
}
.pdf-page canvas {
  display: block;
}
.document-image {
  display: block;
  max-width: none;
  margin: auto;
}
@media (max-width: 1000px) {
  .reader-toc {
    width: 140px;
  }
  .reader-viewport {
    padding: 18px;
  }
  .reader-controls {
    padding: 6px 10px;
    gap: 5px;
  }
}

/* Novel Reading & Themes */
.novel-prose {
  max-width: 800px;
  margin: 0 auto;
  padding: 40px 20px 80px 20px;
}

.novel-chapter-header h2 {
  font-size: 1.4em;
  text-align: center;
  margin-bottom: 28px;
  font-weight: 600;
  border-bottom: 1px dashed var(--divider);
  padding-bottom: 16px;
}

.novel-paragraph {
  text-indent: 2em;
  margin: 0 0 1.2em 0;
  text-align: justify;
}

.novel-chapter-loading {
  text-align: center;
  padding: 12px;
  color: var(--text-muted);
  font-size: 13px;
}

.chapter-nav-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 48px;
  padding-top: 24px;
  border-top: 1px solid var(--divider);
}

.toc-novel-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toc-chapter-item {
  flex: 0 0 auto;
  min-height: 34px;
  line-height: 1.5;
  text-align: left;
  background: transparent;
  border: none;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-muted);
}

.toc-chapter-item:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.toc-chapter-item.active {
  background: var(--primary, #3b82f6);
  color: #fff;
}

/* Themes */
.text-surface.theme-sepia {
  background: #fbf0d9;
  color: #5f4b32;
}

.text-surface.theme-sepia .novel-prose {
  color: #5f4b32;
}

.text-surface.theme-eye {
  background: #e8f5e9;
  color: #2e4d34;
}

.text-surface.theme-eye .novel-prose {
  color: #2e4d34;
}

.text-surface.theme-dark {
  background: #18181b;
  color: #d4d4d8;
}

.text-surface.theme-dark .novel-prose {
  color: #d4d4d8;
}
</style>
