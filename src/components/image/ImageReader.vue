<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, X, Maximize, Minimize2, Move, RotateCw, ZoomIn, ZoomOut, RotateCcw, Bookmark, BookMarked, Check, Settings2, Save, Trash2, RectangleVertical, Columns2, Rows3 } from 'lucide-vue-next'
import Panzoom, { type PanzoomObject } from '@panzoom/panzoom'
import type { ImageBookmark, ImageItem, ImagePage } from '@/types/image'
import { DEFAULT_IMAGE_PREFERENCES, normalizeImagePreferences } from '@/utils/image-preferences'
import { imageCanvasLayout, imageSpread } from '@/utils/image-reader'
import ImagePageMetadata from './ImagePageMetadata.vue'

const props = defineProps<{ item: ImageItem; pages: ImagePage[]; startId?: string }>(), emit = defineEmits<{ close: [] }>()
const maximized = ref(false), minimized = ref(false), position = ref<{left:number;top:number}|null>(null)
let windowDrag: {x:number;y:number;left:number;top:number} | undefined
const root = ref<HTMLElement>(), viewport = ref<HTMLElement>(), canvas = ref<HTMLElement>()
const index = ref(Math.max(0, props.pages.findIndex(p => p.id === (props.startId || props.item.progress?.pageId))))
const jumpPage = ref<number|string>(index.value + 1)
const prefs = ref({ ...DEFAULT_IMAGE_PREFERENCES }), customized = ref(false), rotation = ref(0), error = ref(''), idle = ref(false)
const panel = ref<'settings' | 'bookmarks' | ''>(''), bookmarks = ref<ImageBookmark[]>([]), read = ref(props.item.read), busy = ref(false)
const view = ref({ width: 800, height: 650 }), dimensions = ref<Record<string, { width: number; height: number }>>({}), failed = ref(new Set<string>())
let resize: ResizeObserver | undefined, pan: PanzoomObject | undefined, hideTimer: ReturnType<typeof setTimeout> | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined, prefsTimer: ReturnType<typeof setTimeout> | undefined, frame = 0, restoring = true, disposed = false
let neighbors: HTMLImageElement[] = [], drag: { x: number; y: number; top: number; left: number } | undefined
let preferenceWrites = Promise.resolve()
let wheelTotal = 0, lastWheel = 0, wheelTurnAt = 0
const page = computed(() => props.pages[index.value]), chapter = computed(() => page.value?.chapterId || '')
const currentBookmark = computed(() => bookmarks.value.find(b => b.pageId === page.value?.id))
const spreadRange = computed(() => prefs.value.mode === 'double' && props.item.type === 'comic' ? imageSpread(props.pages, index.value, prefs.value.coverSingle) : { start: index.value, length: 1 })
const spread = computed(() => props.pages.slice(spreadRange.value.start, spreadRange.value.start + spreadRange.value.length))
const natural = (p: ImagePage) => dimensions.value[p.id] || { width: 800, height: 1200 }
const layout = computed(() => imageCanvasLayout(spread.value.map(natural), { width: view.value.width - 32, height: view.value.height - 24 }, prefs.value.fit, rotation.value))
const stripWidths = computed(() => props.pages.map(p => (prefs.value.fit === 'original' ? natural(p).width : Math.min(1100, view.value.width - 32)) * prefs.value.zoom))
const stripWidth = computed(() => Math.max(1, ...stripWidths.value))
const sizes = computed(() => props.pages.map((p, i) => stripWidths.value[i] * natural(p).height / natural(p).width))
const starts = computed(() => { const result = [0]; for (const height of sizes.value) result.push(result.at(-1)! + height + 12); return result })
const first = computed(() => Math.max(0, index.value - 2)), last = computed(() => Math.min(props.pages.length, index.value + 5))
const strip = computed(() => props.pages.slice(first.value, last.value))

function wake() { idle.value = false; clearTimeout(hideTimer); hideTimer = setTimeout(() => { idle.value = true }, 2500) }
function offset() { return prefs.value.mode === 'scroll' && viewport.value ? Math.max(0, Math.min(1, (viewport.value.scrollTop - starts.value[index.value]) / sizes.value[index.value])) : 0 }
async function persist() {
  if (props.item.type !== 'comic' || !page.value || restoring) return
  try { await window.baoyi.image.saveProgress(props.item.id, page.value.id, offset()) } catch (cause) { error.value = (cause as Error).message }
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void persist() }, 350) }
function savePreferences() {
  clearTimeout(prefsTimer); prefsTimer = undefined
  const value = { ...prefs.value }
  preferenceWrites = preferenceWrites.then(async () => {
    const result = await window.baoyi.image.readerPreferences(props.item.id, value)
    customized.value = result.customized
  }).catch(cause => { error.value = cause.message })
  return preferenceWrites
}
function destroyPan() { pan?.destroy(); pan?.resetStyle(); pan = undefined }
function setupPan() {
  destroyPan()
  if (!canvas.value || prefs.value.mode === 'scroll' || restoring || disposed) return
  pan = Panzoom(canvas.value, { canvas: true, minScale: 0.25, maxScale: 4, startScale: prefs.value.zoom, cursor: 'grab', animate: false })
}
function panChanged(event: Event) {
  if (!pan || restoring) return
  const { x, y, scale } = (event as CustomEvent<{ x: number; y: number; scale: number }>).detail
  // Bound translation without "outside" containment, which crops fit-to-screen pages.
  const maxX = Math.max(0, (layout.value.width * scale - view.value.width) / 2 + 24) / scale
  const maxY = Math.max(0, (layout.value.height * scale - view.value.height) / 2 + 24) / scale
  const boundedX = Math.max(-maxX, Math.min(maxX, x)), boundedY = Math.max(-maxY, Math.min(maxY, y))
  if (Math.abs(x - boundedX) > 0.01 || Math.abs(y - boundedY) > 0.01) pan.pan(boundedX, boundedY, { silent: true })
  if (Math.abs(prefs.value.zoom - scale) > 0.001) {
    prefs.value.zoom = scale
    clearTimeout(prefsTimer); prefsTimer = setTimeout(() => { void savePreferences() }, 250)
  }
}
async function go(value: number, relativeOffset = 0) {
  if (!Number.isFinite(value) || !props.pages.length) return
  let at = Math.max(0, Math.min(props.pages.length - 1, Math.trunc(value)))
  if (prefs.value.mode === 'double' && props.item.type === 'comic') at = imageSpread(props.pages, at, prefs.value.coverSingle).start
  index.value = at; rotation.value = 0
  await nextTick()
  if (viewport.value) { viewport.value.scrollTop = prefs.value.mode === 'scroll' ? starts.value[at] + sizes.value[at] * relativeOffset : 0; viewport.value.scrollLeft = 0 }
  pan?.pan(0, 0, { force: true }); scheduleSave(); wake()
}
function step(delta: number) { void go(delta > 0 ? spreadRange.value.start + spreadRange.value.length : spreadRange.value.start - 1) }
async function jump() {
  const value = Number(jumpPage.value)
  if (jumpPage.value !== '' && Number.isFinite(value)) await go(value - 1)
  jumpPage.value = index.value + 1
  root.value?.focus()
}
function advance(delta: number) {
  if (prefs.value.mode === 'scroll' && viewport.value) viewport.value.scrollBy({ top: delta * viewport.value.clientHeight * 0.9, behavior: 'instant' })
  else step(delta)
  wake()
}
async function changePrefs() { await savePreferences(); await go(index.value); wake() }
async function zoom(value: number) {
  const at = index.value, previousOffset = offset()
  prefs.value.zoom = Math.max(0.25, Math.min(4, Math.round(value * 100) / 100))
  pan?.zoom(prefs.value.zoom)
  await nextTick()
  if (prefs.value.mode === 'scroll' && viewport.value) viewport.value.scrollTop = starts.value[at] + sizes.value[at] * previousOffset
  await savePreferences(); scheduleSave(); wake()
}
async function resetZoom() { await zoom(1); pan?.pan(0, 0, { force: true }) }
function wheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) { event.preventDefault(); if (pan) pan.zoomWithWheel(event); else void zoom(prefs.value.zoom + (event.deltaY > 0 ? -0.1 : 0.1)); wake() }
  else if (pan) {
    event.preventDefault()
    const fits = layout.value.width * prefs.value.zoom <= view.value.width && layout.value.height * prefs.value.zoom <= view.value.height
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.value.height : 1)
    if (fits && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
      const now = performance.now()
      if (now - lastWheel > 180 || Math.sign(wheelTotal) !== Math.sign(delta)) wheelTotal = 0
      lastWheel = now
      if (now - wheelTurnAt < 320) return
      wheelTotal += delta
      if (Math.abs(wheelTotal) >= 45) { step(Math.sign(wheelTotal)); wheelTotal = 0; wheelTurnAt = now }
    } else {
      wheelTotal = 0
      const current = pan.getPan()
      pan.pan(current.x - event.deltaX / prefs.value.zoom, current.y - delta / prefs.value.zoom)
    }
    wake()
  }
}
function changeChapter(event: Event) { const at = props.pages.findIndex(p => p.chapterId === (event.target as HTMLSelectElement).value); if (at >= 0) void go(at) }
function scroll() {
  if (prefs.value.mode !== 'scroll' || restoring || frame) return
  frame = requestAnimationFrame(() => { frame = 0; const top = viewport.value?.scrollTop || 0; let low = 0, high = props.pages.length - 1; while (low < high) { const mid = Math.ceil((low + high) / 2); if (starts.value[mid] <= top + 1) low = mid; else high = mid - 1 } index.value = low; scheduleSave() })
}
function dragStart(event: PointerEvent) {
  if (!(event.target as HTMLElement).closest('button,input,select')) root.value?.focus({ preventScroll: true })
  if (prefs.value.mode !== 'scroll' || event.button !== 0 || !viewport.value) return
  drag = { x: event.clientX, y: event.clientY, top: viewport.value.scrollTop, left: viewport.value.scrollLeft }
  viewport.value.setPointerCapture(event.pointerId); event.preventDefault()
}
function dragMove(event: PointerEvent) { if (drag && viewport.value) { viewport.value.scrollTop = drag.top + drag.y - event.clientY; viewport.value.scrollLeft = drag.left + drag.x - event.clientX } }
async function loaded(event: Event, id: string) {
  const img = event.target as HTMLImageElement
  if (!img.naturalWidth) return
  const previousOffset = offset(), at = index.value
  dimensions.value = { ...dimensions.value, [id]: { width: img.naturalWidth, height: img.naturalHeight } }
  if (prefs.value.mode === 'scroll') { await nextTick(); if (viewport.value) viewport.value.scrollTop = starts.value[at] + sizes.value[at] * previousOffset }
}
async function bookmarkAction(action: () => Promise<unknown>) {
  busy.value = true
  try { await action(); bookmarks.value = await window.baoyi.image.bookmarks(props.item.id) } catch (cause) { error.value = (cause as Error).message } finally { busy.value = false }
}
function toggleBookmark() {
  const existing = currentBookmark.value, current = page.value
  if (current) void bookmarkAction(() => existing ? window.baoyi.image.removeBookmark(props.item.id, existing.id) : window.baoyi.image.saveBookmark(props.item.id, current.id, offset()))
}
function jumpBookmark(bookmark: ImageBookmark) { const at = props.pages.findIndex(p => p.id === bookmark.pageId); if (at >= 0) void go(at, bookmark.offset) }
function renameBookmark(bookmark: ImageBookmark, event: Event) { const label = (event.target as HTMLInputElement).value; void bookmarkAction(() => window.baoyi.image.saveBookmark(props.item.id, bookmark.pageId, bookmark.offset, label)) }
function removeBookmark(bookmark: ImageBookmark) { void bookmarkAction(() => window.baoyi.image.removeBookmark(props.item.id, bookmark.id)) }
async function toggleRead() { try { read.value = (await window.baoyi.image.update(props.item.id, { read: !read.value })).read } catch (cause) { error.value = (cause as Error).message } }
async function defaults(reset: boolean) {
  busy.value = true
  try {
    if (prefsTimer) await savePreferences()
    await preferenceWrites
    if (reset) { const result = await window.baoyi.image.readerPreferences(props.item.id, null); prefs.value = result.preferences; customized.value = result.customized; if (props.item.type === 'photo') prefs.value.mode = 'single'; await go(index.value); setupPan() }
    else await window.baoyi.image.preferences({ ...prefs.value })
  } catch (cause) { error.value = (cause as Error).message } finally { busy.value = false }
}
function keys(event: KeyboardEvent) {
  if (!root.value?.contains(document.activeElement) || minimized.value) return
  if (event.key === 'Escape') { event.preventDefault(); if (panel.value) { panel.value = ''; root.value?.focus() } else void close(); return }
  if ((event.target as HTMLElement)?.matches('input,select,textarea,[contenteditable=true]')) return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); void fullscreen() }
  else if (event.key === '+' || event.key === '=') { event.preventDefault(); void zoom(prefs.value.zoom + 0.25) }
  else if (event.key === '-') { event.preventDefault(); void zoom(prefs.value.zoom - 0.25) }
  else if (event.key === '0') { event.preventDefault(); void resetZoom() }
  else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); step((event.key === 'ArrowRight' ? 1 : -1) * (prefs.value.direction === 'rtl' ? -1 : 1)) }
  else if (event.key === 'PageDown' || (event.key === ' ' && !(event.target as HTMLElement)?.matches('button'))) { event.preventDefault(); advance(event.shiftKey ? -1 : 1) }
  else if (event.key === 'PageUp') { event.preventDefault(); advance(-1) }
  else if (prefs.value.mode === 'scroll' && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); viewport.value?.scrollBy({ top: event.key === 'ArrowDown' ? 80 : -80 }) }
  else if (event.key === 'Home') { event.preventDefault(); void go(0) }
  else if (event.key === 'End') { event.preventDefault(); void go(props.pages.length - 1) }
}
function moveWindow(event: PointerEvent) {
  if(maximized.value || document.fullscreenElement || event.button!==0 || (event.target as HTMLElement).closest('button'))return
  const box=root.value!.getBoundingClientRect()
  position.value={left:box.left,top:box.top};windowDrag={x:event.clientX,y:event.clientY,left:box.left,top:box.top}
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function moveWindowTo(event: PointerEvent) {
  if(!windowDrag || !root.value)return
  position.value={left:Math.max(0,Math.min(window.innerWidth-root.value.offsetWidth,windowDrag.left+event.clientX-windowDrag.x)),top:Math.max(36,Math.min(window.innerHeight-60,windowDrag.top+event.clientY-windowDrag.y))}
}
function constrainWindow(){if(position.value && root.value)position.value={left:Math.max(0,Math.min(position.value.left,window.innerWidth-root.value.offsetWidth)),top:Math.max(36,Math.min(position.value.top,window.innerHeight-root.value.offsetHeight))}}
function minimize(){minimized.value=!minimized.value;if(!minimized.value)void nextTick(()=>root.value?.focus())}
async function fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.value?.requestFullscreen() } catch { error.value = '当前窗口无法进入全屏' } }
async function close() { clearTimeout(saveTimer); if (prefsTimer) await savePreferences(); await preferenceWrites; await persist(); if (document.fullscreenElement) await document.exitFullscreen(); emit('close') }
watch([canvas, layout, () => prefs.value.mode], setupPan, { flush: 'post' })
watch(index, value => { jumpPage.value = value + 1 })
watch([index, () => prefs.value.mode], () => {
  neighbors = []
  if (prefs.value.mode === 'scroll') return
  for (const at of [spreadRange.value.start - 1, spreadRange.value.start + spreadRange.value.length]) { const adjacent = props.pages[at]; if (adjacent) { const image = new Image(); image.src = `baoyi://image/${adjacent.id}`; neighbors.push(image) } }
}, { immediate: true })
onMounted(async () => {
  window.addEventListener('keydown', keys); window.addEventListener('resize', constrainWindow)
  try { const state = await window.baoyi.image.readerPreferences(props.item.id); prefs.value = normalizeImagePreferences(state.preferences); customized.value = state.customized; bookmarks.value = await window.baoyi.image.bookmarks(props.item.id) } catch (cause) { error.value = (cause as Error).message }
  if (disposed) return
  if (props.item.type === 'photo') prefs.value.mode = 'single'
  resize = new ResizeObserver(async () => {
    if (!viewport.value) return
    const at = index.value, previousOffset = offset()
    view.value = { width: viewport.value.clientWidth, height: viewport.value.clientHeight }
    await nextTick()
    if (prefs.value.mode === 'scroll' && viewport.value) viewport.value.scrollTop = starts.value[at] + sizes.value[at] * previousOffset
  })
  if (viewport.value) resize.observe(viewport.value)
  await go(index.value, props.startId ? 0 : props.item.progress?.offset || 0); restoring = false; setupPan(); wake(); root.value?.focus()
})
onBeforeUnmount(() => { disposed = true; window.removeEventListener('keydown', keys); window.removeEventListener('resize', constrainWindow); resize?.disconnect(); destroyPan(); clearTimeout(hideTimer); clearTimeout(saveTimer); if (prefsTimer) void savePreferences(); cancelAnimationFrame(frame); neighbors = []; void persist() })
</script>

<template>
  <Teleport to="body"><section ref="root" class="image-reader" :class="{ idle: idle && !panel, maximized, minimized }" :style="position&&!maximized&&!minimized?{left:position.left+'px',top:position.top+'px',right:'auto'}:{}" tabindex="-1" role="dialog" aria-modal="false" :aria-label="`阅读 ${item.name}`" @pointermove="wake" @focusin="wake">
    <header class="reader-title" @pointerdown="moveWindow" @pointermove="moveWindowTo" @pointerup="windowDrag=undefined" @lostpointercapture="windowDrag=undefined" @dblclick="maximized=!maximized">
      <Move :size="14"/><strong :title="item.name">{{item.name}}</strong><span v-if="!minimized">拖动标题移动窗口</span>
      <button :aria-label="minimized?'展开阅读器':'收起阅读器'" :title="minimized?'展开':'收起'" @click="minimize"><Minimize2 :size="16"/></button>
      <button v-if="!minimized" :aria-label="maximized?'还原阅读窗口':'最大化阅读窗口'" title="最大化 / 还原" @click="maximized=!maximized"><Maximize :size="16"/></button>
      <button aria-label="关闭阅读器" title="关闭阅读器" @click="close"><X :size="20"/></button>
    </header>
    <header class="reader-tools">

      <select v-if="item.type==='comic'" :value="chapter" aria-label="阅读章节" @change="changeChapter"><option v-for="c in item.chapters.filter(c=>c.pageCount)" :key="c.id" :value="c.id">{{ c.title }}</option></select>
      <div v-if="item.type==='comic'" class="reader-modes" role="group" aria-label="阅读模式">
        <button aria-label="单页阅读" title="单页" :aria-pressed="prefs.mode==='single'" @click="prefs.mode='single';changePrefs()"><RectangleVertical :size="17" /><span>单页</span></button>
        <button aria-label="双页阅读" title="双页" :aria-pressed="prefs.mode==='double'" @click="prefs.mode='double';changePrefs()"><Columns2 :size="17" /><span>双页</span></button>
        <button aria-label="连续阅读" title="纵向连续" :aria-pressed="prefs.mode==='scroll'" @click="prefs.mode='scroll';changePrefs()"><Rows3 :size="17" /><span>连续</span></button>
      </div>
      <div class="reader-zoom"><button aria-label="缩小图片" title="缩小" :disabled="prefs.zoom<=0.25" @click="zoom(prefs.zoom-0.25)"><ZoomOut :size="18" /></button><output aria-label="缩放比例">{{ Math.round(prefs.zoom*100) }}%</output><button aria-label="放大图片" title="放大" :disabled="prefs.zoom>=4" @click="zoom(prefs.zoom+0.25)"><ZoomIn :size="18" /></button><button aria-label="重置缩放" title="重置缩放与位置" @click="resetZoom"><RotateCcw :size="17" /></button></div>
      <button v-if="prefs.mode!=='scroll'" aria-label="旋转图片" title="旋转图片" @click="rotation=(rotation+90)%360"><RotateCw :size="18" /></button>
      <button :aria-label="currentBookmark?'移除当前书签':'添加书签'" :title="currentBookmark?'移除当前书签':'添加书签'" :aria-pressed="!!currentBookmark" :disabled="busy" @click="toggleBookmark"><Bookmark :size="18" /></button>
      <button aria-label="书签列表" title="书签列表" :aria-pressed="panel==='bookmarks'" @click="panel=panel==='bookmarks'?'':'bookmarks'"><BookMarked :size="18" /></button>
      <button :aria-label="read?'标记为未读':'标记为已读'" :title="read?'标记为未读':'标记为已读'" :aria-pressed="read" @click="toggleRead"><Check :size="18" /></button>
      <button aria-label="阅读设置" title="阅读设置" :aria-pressed="panel==='settings'" @click="panel=panel==='settings'?'':'settings'"><Settings2 :size="18" /></button>
      <button aria-label="全屏阅读" title="全屏阅读" @click="fullscreen"><Maximize :size="19" /></button>
    </header>
    <p v-if="error" class="reader-error" role="alert">{{ error }}</p>
    <div class="reader-body">
      <div ref="viewport" class="reader-viewport" :class="['reader-'+prefs.mode,'reader-fit-'+prefs.fit]" @scroll.passive="scroll" @wheel="wheel" @pointerdown="dragStart" @pointermove="dragMove" @pointerup="drag=undefined" @pointercancel="drag=undefined" @lostpointercapture="drag=undefined">
        <div v-if="prefs.mode==='scroll'" class="reader-strip" :style="{width:stripWidth+'px'}">
          <div :style="{height:starts[first]+'px'}" />
          <div v-for="(p,i) in strip" :key="p.id" class="reader-strip-page" :style="{height:sizes[first+i]+'px',width:stripWidths[first+i]+'px'}"><img v-if="!failed.has(p.id)" :src="`baoyi://image/${p.id}`" :alt="`第 ${p.ordinal+1} 页`" draggable="false" @load="loaded($event,p.id)" @error="failed.add(p.id)" /><div v-else class="reader-missing">第 {{ p.ordinal+1 }} 页无法读取</div></div>
          <div :style="{height:(starts[pages.length]-starts[last])+'px'}" />
        </div>
        <div v-else ref="canvas" class="reader-spread" :class="{rtl:prefs.direction==='rtl'}" :style="{width:layout.width+'px',height:layout.height+'px',marginLeft:-layout.width/2+'px',marginTop:-layout.height/2+'px'}" @panzoomchange="panChanged">
          <div v-for="(p,i) in spread" :key="p.id" class="reader-sheet" :style="{width:layout.sheets[i].width+'px',height:layout.sheets[i].height+'px'}"><img v-if="!failed.has(p.id)" :src="`baoyi://image/${p.id}`" :alt="`第 ${p.ordinal+1} 页`" draggable="false" :style="{width:layout.sheets[i].imageWidth+'px',height:layout.sheets[i].imageHeight+'px',transform:`rotate(${rotation}deg)`}" @load="loaded($event,p.id)" @error="failed.add(p.id)" /><div v-else class="reader-missing">这一页无法读取</div></div>
        </div>

      </div>
      <aside v-if="panel" class="reader-panel" :aria-label="panel==='settings'?'作品阅读设置':'作品书签'">
        <header><h2>{{ panel==='settings'?'阅读设置':'书签' }}</h2><button aria-label="关闭阅读面板" title="关闭面板" @click="panel=''"><X :size="17" /></button></header>
        <template v-if="panel==='settings'">
          <p class="reader-scope">{{ customized?'此作品设置':'全局默认' }}</p>
          <label>图片缩放<select v-model="prefs.fit" aria-label="图片缩放" @change="changePrefs"><option value="screen">适屏</option><option value="width">适宽</option><option value="original">原始尺寸</option></select></label>
          <template v-if="item.type==='comic'"><label>阅读方向<select v-model="prefs.direction" aria-label="阅读方向" @change="changePrefs"><option value="ltr">从左到右</option><option value="rtl">从右到左</option></select></label><label class="reader-check"><input v-model="prefs.coverSingle" type="checkbox" @change="changePrefs" />封面独立成页</label></template>
          <div class="reader-defaults"><button :disabled="busy" @click="defaults(false)"><Save :size="16" />设为全局默认</button><button :disabled="busy||!customized" @click="defaults(true)"><RotateCcw :size="16" />使用全局默认</button></div>
          <div class="reader-help"><h3>操作提示</h3><p>左右方向键或右栏按钮翻页</p><p>适屏时滚轮翻页，放大后滚轮移动图片</p><p>连续模式：滚轮、空格 / Page Down 向下阅读</p><p>拖动移动 · Ctrl + 滚轮缩放</p><p>+ / − 缩放 · 0 重置 · F 全屏</p><p>Home / End 首末页 · Esc 返回</p></div>
        </template>
        <template v-else><p v-if="!bookmarks.length" class="reader-scope">暂无书签</p><div v-for="b in bookmarks" :key="b.id" class="reader-bookmark"><button :aria-label="`跳转到第 ${b.ordinal+1} 页`" :disabled="b.missing" @click="jumpBookmark(b)"><Bookmark :size="16" />第 {{ b.ordinal+1 }} 页{{ b.missing?' · 缺失':'' }}</button><input :value="b.label" aria-label="书签名称" placeholder="书签名称" maxlength="200" :disabled="busy" @change="renameBookmark(b,$event)" /><button :aria-label="`删除第 ${b.ordinal+1} 页书签`" title="删除书签" :disabled="busy" @click="removeBookmark(b)"><Trash2 :size="16" /></button></div></template>
      </aside>
    </div>
    <footer class="reader-bottom"><button aria-label="前一页" title="前一页" :disabled="index===0" @click="step(-1)"><ArrowRight v-if="prefs.direction==='rtl'" :size="18"/><ArrowLeft v-else :size="18" /></button><span>{{ index+1 }} / {{ pages.length }} 页</span><input type="range" aria-label="阅读进度" :min="0" :max="Math.max(0,pages.length-1)" :value="index" :dir="prefs.direction" @input="go(Number(($event.target as HTMLInputElement).value))" /><button aria-label="后一页" title="后一页" :disabled="spreadRange.start+spreadRange.length>=pages.length" @click="step(1)"><ArrowLeft v-if="prefs.direction==='rtl'" :size="18"/><ArrowRight v-else :size="18" /></button><form class="reader-jump" novalidate @submit.prevent="jump"><label>跳至<input v-model="jumpPage" type="number" min="1" :max="pages.length" step="1" aria-label="跳转页码" /></label><button type="submit" title="跳转到指定页" aria-label="跳转到指定页">页</button></form><ImagePageMetadata :page-id="page?.id || ''" /></footer>
  </section></Teleport>
</template>

<style scoped>
.image-reader{position:fixed;inset:var(--titlebar-h) 0 0;z-index:200;background:#141416;color:#e4e4e7;display:flex;flex-direction:column;font-size:12px;outline:none}.image-reader:fullscreen{inset:0}.reader-tools{flex:0 0 56px;display:flex;align-items:center;gap:6px;padding:8px 12px;background:#222225;border-bottom:1px solid #37373b;min-width:0;transition:opacity .2s}.reader-tools strong{flex:1;min-width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500}.reader-tools select{width:140px;min-width:90px}.image-reader select,.image-reader input:not([type=range]):not([type=checkbox]){color:#e4e4e7;background:#2c2c30;border:1px solid #4b4b51;border-radius:5px;padding:7px;font-size:12px;min-width:0}.image-reader button{display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;color:inherit;width:32px;height:32px;padding:6px;border-radius:5px;cursor:pointer;gap:7px}.image-reader button:hover{background:#39393f}.image-reader button[aria-pressed=true]{background:#384843;color:#b5e0cd}.image-reader :focus-visible{outline:2px solid #a8d9c3;outline-offset:1px}.image-reader button:disabled{opacity:.35;cursor:default}.reader-modes,.reader-zoom{display:flex;align-items:center;flex-shrink:0}.reader-modes{border:1px solid #48484e;border-radius:6px}.reader-zoom output{width:46px;text-align:center;font-variant-numeric:tabular-nums}.reader-body{display:flex;flex:1;min-height:0;min-width:0}.reader-viewport{flex:1;min-width:0;overflow:hidden;position:relative;overscroll-behavior:contain}.reader-spread{position:absolute;left:50%;top:50%;display:flex;align-items:center;justify-content:center;gap:8px}.reader-spread.rtl{flex-direction:row-reverse}.reader-sheet{display:flex;align-items:center;justify-content:center;flex:none;position:relative}.reader-sheet img{display:block;max-width:none;flex:none;user-select:none}.reader-viewport.reader-scroll{overflow:auto;cursor:grab;touch-action:pan-y}.reader-strip{margin:0 auto}.reader-strip-page{margin:0 auto 12px;position:relative}.reader-strip-page img{width:100%;height:100%;object-fit:contain;display:block;user-select:none}.reader-missing{display:flex;align-items:center;justify-content:center;text-align:center;color:#bbb;height:100%;width:100%;padding:24px;line-height:1.8}.reader-bottom{flex:0 0 46px;background:#222225;border-top:1px solid #37373b;display:flex;align-items:center;justify-content:center;gap:12px;transition:opacity .2s;padding:0 14px}.reader-bottom input{width:40%;max-width:650px;min-width:60px;accent-color:#a8d9c3}.reader-bottom span{min-width:80px;text-align:center;font-variant-numeric:tabular-nums}.idle .reader-tools:not(:focus-within):not(:hover),.idle .reader-bottom:not(:focus-within):not(:hover){opacity:.3}.reader-error{margin:0;background:#582e33;color:#ffdad9;padding:8px 16px;overflow-wrap:anywhere}.reader-panel{flex:0 0 246px;width:246px;overflow:auto;background:#222225;border-left:1px solid #414147;padding:14px}.reader-panel header{display:flex;align-items:center;justify-content:space-between}.reader-panel h2{font-size:15px;font-weight:600;margin:0}.reader-panel label{display:flex;flex-direction:column;gap:8px;margin-top:20px}.reader-panel .reader-check{flex-direction:row;align-items:center}.reader-check input{accent-color:#a8d9c3}.reader-scope{color:#b1b1bb;font-size:12px;margin:14px 0}.reader-defaults{display:flex;flex-direction:column;gap:10px;margin-top:24px;padding-top:16px;border-top:1px solid #414147}.reader-defaults button{width:100%;justify-content:flex-start}.reader-bookmark{display:grid;grid-template-columns:1fr 32px;gap:4px;border-bottom:1px solid #414147;padding:12px 0}.reader-bookmark>button:first-child{grid-column:1 / -1;width:100%;justify-content:flex-start}.reader-bookmark input{width:100%}@media(max-width:1050px){.reader-tools{gap:3px;padding:8px}.reader-tools select{width:110px}.reader-tools strong{font-size:12px}.reader-zoom output{width:40px}.reader-panel{flex-basis:222px;width:222px}}
</style>
<style scoped>
.image-reader{color-scheme:dark}
.image-reader option{color:#e4e4e7;background:#2c2c30}
.reader-tools{flex:0 0 auto;min-height:56px;flex-wrap:wrap;gap:8px}
.reader-tools strong{flex:1 1 120px}
.reader-modes button{width:auto;padding:6px 9px;gap:5px}
.reader-modes span{font-size:12px}
.reader-zoom{padding-inline:5px;border-inline:1px solid #414147}
.reader-viewport .reader-edge{position:absolute;top:50%;transform:translateY(-50%);width:42px;height:78px;z-index:2;background:#222225d9;border:1px solid #505059;color:#fff;opacity:0;transition:opacity .15s;touch-action:manipulation}
.reader-edge-left{left:12px}.reader-edge-right{right:12px}
.reader-viewport:hover .reader-edge:not(:disabled),.reader-viewport .reader-edge:focus-visible{opacity:.9}
.reader-bottom{min-height:54px;gap:10px;flex-wrap:wrap;flex:0 0 auto;padding:8px 12px}
.reader-bottom input[type=range]{flex:1;max-width:650px;width:auto}
.reader-jump,.reader-jump label{display:flex;align-items:center;gap:6px;white-space:nowrap;color:#b9b9c8}
.reader-jump input{width:58px;text-align:center;font-variant-numeric:tabular-nums;padding:5px!important}
.reader-jump button{width:28px}
.reader-help{margin-top:24px;padding-top:16px;border-top:1px solid #414147;color:#b9b9c8;line-height:1.8}
.reader-help h3{font-size:12px;color:#e4e4e7;margin:0 0 8px;font-weight:500}.reader-help p{margin:6px 0}
@media(max-width:1050px){.reader-tools{gap:5px}.reader-tools select{width:120px}.reader-tools strong{flex-basis:160px}.reader-modes button{padding-inline:7px}.reader-bottom{gap:7px}.reader-zoom{border-right:0;padding-inline:2px}}
</style>

<style scoped>
.image-reader{inset:70px 24px auto auto;width:min(78vw,1120px);height:min(82vh,900px);min-width:min(640px,96vw);min-height:380px;max-width:100vw;max-height:calc(100vh - 40px);resize:both;overflow:hidden;display:grid;grid-template:34px minmax(0,1fr) / 100px minmax(0,1fr) 92px;border:1px solid #55555c;border-radius:10px;box-shadow:0 16px 60px #0008;z-index:180}
.image-reader.maximized{inset:var(--titlebar-h) 0 0!important;width:100%!important;height:calc(100vh - var(--titlebar-h))!important;max-height:none;border-radius:0;resize:none}
.image-reader:fullscreen{inset:0!important;width:100%!important;height:100%!important;max-height:none;border-radius:0;resize:none}
.reader-title{grid-column:1 / -1;display:flex;gap:8px;align-items:center;padding:0 5px 0 12px;background:#29292e;cursor:move;touch-action:none;min-width:0;user-select:none}
.reader-title strong{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:500}.reader-title span{font-size:10px;color:#a1a1ac}.reader-title button{height:28px;width:30px}
.reader-tools{grid-column:1;grid-row:2;display:flex;flex-direction:column;flex-wrap:nowrap;overflow-y:auto;gap:8px;padding:12px 6px;min-height:0;border:0;border-right:1px solid #37373b;align-items:center}
.reader-tools select{width:86px;min-width:0;font-size:11px;padding:5px}.reader-modes{flex-direction:column;width:86px;flex-shrink:0}.reader-modes button{width:100%}.reader-zoom{display:grid;grid-template-columns:32px 32px;gap:3px;justify-content:center;border:0;padding:3px 0}.reader-zoom output{grid-column:1 / -1;grid-row:1;width:auto}.reader-zoom button:last-child{grid-column:1 / -1;justify-self:center}
.reader-body{grid-column:2;grid-row:2;overflow:hidden}.reader-panel{flex-basis:210px;width:210px;padding:10px}
.reader-bottom{grid-column:3;grid-row:2;display:flex;flex-direction:column;flex-wrap:nowrap;gap:16px;padding:14px 5px;min-height:0;overflow-y:auto;border:0;border-left:1px solid #37373b;justify-content:center}
.reader-bottom{overflow-x:hidden}.reader-bottom span{min-width:0;font-size:11px;white-space:nowrap}.reader-bottom input[type=range]{flex:none;min-width:0;width:78px}.reader-jump,.reader-jump label{flex-direction:column;gap:5px}.reader-bottom :deep(.page-metadata){flex:none;min-width:0;width:80px;font-size:10px}
.reader-error{position:absolute;left:108px;right:100px;top:36px;z-index:5;border-radius:6px;font-size:11px;max-height:70px;overflow:auto}
.idle .reader-tools:not(:focus-within):not(:hover),.idle .reader-bottom:not(:focus-within):not(:hover){opacity:1}
.image-reader.minimized{inset:auto 24px 20px auto!important;width:300px!important;height:34px!important;min-height:0;min-width:0;resize:none;display:block}.minimized>:not(.reader-title){display:none}.minimized .reader-title{height:32px}.minimized .reader-title>svg{display:none}
@media(max-height:650px){.reader-tools{gap:3px;padding-block:5px}.reader-bottom{gap:10px}}
</style>
