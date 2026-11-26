
import { tr } from '../i18n/index.ts'
import { errorMessage } from '@/utils'
import { ref, watch, onMounted, onBeforeUnmount, type Ref } from 'vue'
import { workspace } from '@/utils/workspace-api'
import { loadPdfDocument, BaoyiPdfRangeTransport } from '@/utils/pdf-document'
import type { DocumentItem } from '@/types/workspace'

interface Cover {
  url: string
  state: 'waiting' | 'loading' | 'ready' | 'unavailable' | 'failed'
  reason: string
  key: string
}
interface Entry {
  id: string
  controller: AbortController
  subscribers: Set<(cover: Cover) => void>
  cover: Cover
  bytes: number
  queued: boolean
  priority: number
  touched: number
  failure?: { key: string; reason: string }
  cancel?: () => Promise<unknown> | void
}
const entries = new Map<string, Entry>()
let active: Entry | undefined,
  activeSignal: AbortSignal | undefined,
  paused = false,
  totalBytes = 0
const blank = (): Cover => ({ url: '', state: 'waiting', reason: '', key: '' })
function publish(entry: Entry) {
  for (const callback of entry.subscribers) callback({ ...entry.cover })
}
function evict() {
  for (const entry of [...entries.values()].sort(
    (a, b) => a.touched - b.touched,
  )) {
    if (entries.size <= 100 && totalBytes <= 32 * 1024 * 1024) break
    if (entry.subscribers.size || entry === active) continue
    release(entry)
    entries.delete(entry.id)
  }
}
function release(entry: Entry) {
  if (entry.cover.url) URL.revokeObjectURL(entry.cover.url)
  totalBytes -= entry.bytes
  entry.bytes = 0
  entry.cover = blank()
}
function queue(entry: Entry, priority: number) {
  entry.priority = Math.max(entry.priority, priority)
  entry.touched = Date.now()
  if (active === entry) {
    if (activeSignal?.aborted) entry.queued = true
    publish(entry)
    return
  }
  if (['ready', 'failed', 'unavailable'].includes(entry.cover.state)) {
    publish(entry)
    return
  }
  entry.queued = true
  void drain()
}
async function encode(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(Error(tr("封面编码失败")))),
      'image/png',
    ),
  )
  return new Uint8Array(await blob.arrayBuffer())
}
async function render(entry: Entry, format: string, data: Uint8Array | BaoyiPdfRangeTransport) {
  const canvas = document.createElement('canvas')
  if (format === 'pdf') {
    const task = loadPdfDocument(data)
    entry.cancel = () => task.destroy()
    try {
      const pdf = await task.promise,
        page = await pdf.getPage(1),
        base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({
        scale: Math.min(300 / base.width, 900 / base.height),
      })
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      const context = canvas.getContext('2d')
      if (!context) throw Error(tr("无法生成封面画布"))
      const rendering = page.render({
        canvas,
        canvasContext: context,
        viewport,
        background: '#ffffff',
      })
      entry.cancel = async () => {
        rendering.cancel()
        await task.destroy()
      }
      await rendering.promise
      return await encode(canvas)
    } finally {
      await task.destroy()
      canvas.width = canvas.height = 0
    }
  }
  const bitmap = await createImageBitmap(
    new Blob([(data as Uint8Array).slice().buffer as ArrayBuffer]),
  )
  try {
    const scale = Math.min(300 / bitmap.width, 900 / bitmap.height, 1)
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale))
    canvas.height = Math.max(1, Math.floor(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw Error(tr("无法生成封面画布"))
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await encode(canvas)
  } finally {
    bitmap.close()
    canvas.width = canvas.height = 0
  }
}
async function drain() {
  if (active || paused) return
  const entry = [...entries.values()]
    .filter((e) => e.queued && e.subscribers.size)
    .sort((a, b) => b.priority - a.priority || a.touched - b.touched)[0]
  if (!entry) return
  entry.queued = false
  active = entry
  const { signal } = entry.controller
  activeSignal = signal
  entry.cover.state = 'loading'
  publish(entry)
  try {
    const result = await workspace.documents.covers.get(entry.id)
    if (signal.aborted || paused || !entry.subscribers.size)
      return
    if (result.state === 'unavailable') {
      entry.cover = { ...blank(), state: 'unavailable', reason: result.reason }
      return
    }
    entry.cover.key = result.key
    if (result.state === 'render' && entry.failure?.key === result.key) {
      entry.cover = { ...blank(), ...entry.failure, state: 'failed' }
      return
    }
    let png: Uint8Array
    if (result.state === 'ready') png = result.png
    else {
      const source = await workspace.documents.covers.source(
        entry.id,
        result.token,
      )
      if (signal.aborted || paused || !entry.subscribers.size)
        return
      const data = source.format === 'pdf'
        ? new BaoyiPdfRangeTransport(entry.id, source.size, undefined, (offset, length) => workspace.documents.covers.range(entry.id, result.token, offset, length))
        : source.data!
      png = await render(entry, source.format, data)
      if (signal.aborted || paused || !entry.subscribers.size)
        return
      const stored = await workspace.documents.covers.put(
        entry.id,
        result.token,
        png,
      )
      if (!stored.stored) {
        entry.cover = {
          ...blank(),
          state: 'failed',
          reason: tr("来源已变化，请刷新或重试封面"),
        }
        return
      }
    }
    if (signal.aborted || paused || !entry.subscribers.size)
      return
    release(entry)
    entry.failure = undefined
    entry.bytes = png.byteLength
    totalBytes += entry.bytes
    entry.cover = {
      url: URL.createObjectURL(
        new Blob([png.slice().buffer as ArrayBuffer], { type: 'image/png' }),
      ),
      state: 'ready',
      reason: '',
      key: result.key,
    }
  } catch (e) {
    if (!signal.aborted && !paused && entry.subscribers.size) {
      entry.cover = {
        ...entry.cover,
        state: 'failed',
        reason: tr("封面暂不可用：") + errorMessage(e),
      }
      if (entry.cover.key)
        entry.failure = { key: entry.cover.key, reason: entry.cover.reason }
    }
  } finally {
    if (entry.cover.state === 'loading') entry.cover.state = 'waiting'
    entry.cancel = undefined
    active = undefined
    publish(entry)
    evict()
    void drain()
  }
}

export async function pauseDocumentCovers() {
  paused = true
  for (const entry of entries.values()) {
    entry.queued = false
    entry.controller.abort(); entry.controller = new AbortController()
  }
  await cancel(active)
}
async function cancel(entry?: Entry) {
  try {
    await entry?.cancel?.()
  } catch { /* best-effort */ }
}
export function resumeDocumentCovers() {
  paused = false
  for (const entry of entries.values())
    if (!entry.subscribers.size) release(entry)
  void drain()
}
export function invalidateDocumentCovers() {
  for (const entry of entries.values()) {
    entry.controller.abort(); entry.controller = new AbortController()
    void cancel(entry)
    release(entry)
    if (entry.subscribers.size) {
      entry.queued = true
      queue(entry, entry.priority)
    }
  }
}
export function useDocumentCovers(
  item: Ref<DocumentItem>,
  element: Ref<HTMLElement | undefined>,
  priority = 0,
) {
  const cover = ref<Cover>(blank())
  let subscribed: Entry | undefined,
    observer: IntersectionObserver | undefined,
    visible = false
  const update = (value: Cover) => {
    cover.value = value
  }
  function detach() {
    if (!subscribed) return
    subscribed.subscribers.delete(update)
    if (!subscribed.subscribers.size) {
      subscribed.queued = false
      if (active === subscribed) {
        subscribed.controller.abort(); subscribed.controller = new AbortController()
        void cancel(subscribed)
      }
    }
    subscribed = undefined
    evict()
  }
  function attach() {
    if (visible && subscribed?.id === item.value.id) {
      queue(subscribed, priority)
      return
    }
    detach()
    if (!visible || !['pdf', 'png', 'jpg', 'jpeg'].includes(item.value.format))
      return
    let entry = entries.get(item.value.id)
    if (!entry) {
      entry = {
        id: item.value.id,
        controller: new AbortController(),
        subscribers: new Set(),
        cover: blank(),
        bytes: 0,
        queued: false,
        priority,
        touched: Date.now(),
      }
      entries.set(entry.id, entry)
    }
    subscribed = entry
    entry.subscribers.add(update)
    update(entry.cover)
    queue(entry, priority)
  }
  watch(() => [item.value.id, item.value.path, item.value.updatedAt], attach)
  onMounted(() => {
    observer = new IntersectionObserver(
      (rows) => {
        visible = rows.some((r) => r.isIntersecting)
        if (visible) attach()
        else detach()
      },
      { rootMargin: '100px' },
    )
    if (element.value) observer.observe(element.value)
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    detach()
  })
  function retry() {
    if (subscribed) {
      subscribed.controller.abort(); subscribed.controller = new AbortController()
      subscribed.failure = undefined
      release(subscribed)
      queue(subscribed, priority)
    }
  }
  return { cover, retry }
}
