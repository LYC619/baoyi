import assert from 'node:assert/strict'
import * as Vue from 'vue'
import * as Pinia from 'pinia'
import { renderToString } from '@vue/server-renderer'
import { parse } from 'node-html-parser'
import { createRendererLoader } from './helpers/renderer-harness.ts'

const calls: string[] = []
const progressListeners = new Set<(progress: any) => void>()
let resolveRun: ((value: any) => void) | null = null
let rejectRun: ((error: Error) => void) | null = null
let rejectCatalog = false
let cancelAction = async (_requestId: string): Promise<{ ok: boolean; message?: string }> => ({ ok: true })
const requests: any[] = []

const api = {
  downloadSeries: async (id: string) => {
    calls.push('series:' + id)
    if (rejectCatalog) throw new Error('解析失败')
    return {
      resourceId: id, videoCode: '123', title: '系列主标题', warnings: [],
      episodes: [{ videoCode: '124', title: '第一集' }, { videoCode: '125', title: '第二集' }]
    }
  },
  downloadSeriesRun: (request: any) => {
    calls.push('run:' + request.requestId)
    requests.push(request)
    assert.equal(progressListeners.size, 1, '发起系列下载前必须先订阅进度')
    return new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject })
  },
  cancelDownload: async (requestId: string) => { calls.push('cancel:' + requestId); return cancelAction(requestId) },
  onDownloadProgress: (cb: (progress: any) => void) => { progressListeners.add(cb); return () => progressListeners.delete(cb) },
  revealDownload: async () => true
}

const load = createRendererLoader({
  vue: Vue
}, { window: { baoyi: { video: api } }, console: { info: () => {}, warn: () => {}, error: () => {} } })

const module: any = (() => {
  try { return load('src/composables/useVideoSeriesDownload.ts') }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; return {} }
})()
assert.equal(typeof module.useVideoSeriesDownload, 'function', '缺少系列下载 renderer 单例（预期的 RED）')

const first: any = module.useVideoSeriesDownload('v1')
await first.resolve()
assert.equal(first.catalog.value.episodes.length, 2)
const run = first.download('1080p')
assert.deepEqual(calls.slice(0, 2), ['series:v1', 'run:series-download-1'])

progressListeners.forEach(cb => cb({ requestId: 'other', resourceId: 'v1', phase: 'downloading', episodeIndex: 1, episodeTotal: 2, videoCode: '999', title: '错误任务', receivedBytes: 99, totalBytes: 100, bytesPerSecond: 1, message: '错误任务' }))
assert.equal(first.progress.value.videoCode, '123', '其他请求的进度不能污染当前系列任务')
progressListeners.forEach(cb => cb({ requestId: 'series-download-1', resourceId: 'v1', phase: 'downloading', episodeIndex: 1, episodeTotal: 2, videoCode: '124', title: '第一集', receivedBytes: 50, totalBytes: 100, bytesPerSecond: 10, message: '正在下载' }))
assert.equal(first.progress.value.videoCode, '124')
assert.equal(first.progress.value.episodeIndex, 1)
assert.equal((await first.cancel()).ok, true)
assert.equal(calls.at(-1), 'cancel:series-download-1')
assert.equal(first.running.value, true, '取消请求返回后仍须等待主进程结果')

const completeRun = resolveRun as ((value: any) => void) | null
assert.ok(completeRun)
completeRun({ requestId: 'series-download-1', resourceId: 'v1', status: 'cancelled', path: 'D:/series-downloads', message: '已取消', total: 2, completed: 1, failed: 0, skipped: 0, fallback: 0, results: [], warnings: [] })
const result = await run
assert.equal(result.status, 'cancelled')
assert.equal(first.running.value, false)
assert.equal(progressListeners.size, 0)

const second: any = module.useVideoSeriesDownload('v1')
assert.equal(second.catalog.value.title, '系列主标题', '同一资源的系列状态必须跨组件共享')
const center = load('src/composables/useTaskCenter.ts').useTaskCenter()
let passed = 1
let failed = 0
async function test(name: string, run: () => Promise<void> | void) {
  try { await run(); passed++ } catch (error) { failed++; console.error('FAIL ' + name, error) }
}
function complete(overrides: any = {}) {
  const request = requests.at(-1)
  resolveRun?.({ ...request, status: 'success', path: 'D:/series-downloads', message: '处理完成',
    total: 2, completed: 2, failed: 0, skipped: 0, fallback: 0, results: [], warnings: [], ...overrides })
}
function emit(overrides: any = {}) {
  const request = requests.at(-1)
  progressListeners.forEach(cb => cb({ requestId: request.requestId, resourceId: request.resourceId,
    phase: 'downloading', episodeIndex: 1, episodeTotal: 2, videoCode: '124', title: '第一集',
    receivedBytes: 50, totalBytes: 100, bytesPerSecond: 10, message: '正在下载', ...overrides }))
}
await test('series tasks carry episode units', () => {
  assert.ok(center.tasks.value.length)
  assert.ok(center.tasks.value.every((task: any) => task.kind === 'video-series-download'))
})
await test('selects all after resolution and sends only a selected subset', async () => {
  const state = module.useVideoSeriesDownload('selection')
  await state.resolve()
  assert.deepEqual(Array.from(state.selectedVideoCodes?.value ?? []), ['124', '125'])
  state.selectedVideoCodes.value = ['125']
  const run = state.download('720p')
  complete({ total: 1, completed: 1 }); await run
  assert.deepEqual(Array.from(requests.at(-1).videoCodes), ['125'])
})
await test('empty selections cannot open the native picker', async () => {
  const state = module.useVideoSeriesDownload('empty-selection'); await state.resolve()
  if (state.selectedVideoCodes) state.selectedVideoCodes.value = []
  const before = requests.length
  const run = state.download(); complete(); await run
  assert.equal(requests.length, before)
  assert.match(state.error.value, /选择/)
})
await test('failed refresh clears a previously usable playlist', async () => {
  const state = module.useVideoSeriesDownload('refresh'); await state.resolve()
  rejectCatalog = true
  try { await state.resolve() } finally { rejectCatalog = false }
  assert.equal(state.catalog.value, null)
  assert.equal(state.running.value, false)
})
await test('per-episode outcomes and warnings are logged before the queue finishes', async () => {
  const state = module.useVideoSeriesDownload('events'); await state.resolve()
  const run = state.download()
  const episode = { videoCode: '124', title: '第一集', status: 'failed', path: '', sourceLabel: '720p', message: 'HTTP 403', warnings: ['清晰度回退'] }
  emit({ phase: 'episode-done', episodeResult: episode })
  const task = center.runningTasks.value.find((task: any) => task.current.includes('第一集'))
  const rows = [...(state.episodeResults?.value ?? [])]
  const running = state.running.value
  complete({ status: 'failed', completed: 1, failed: 1, results: [episode], warnings: episode.warnings }); await run
  assert.equal(running, true)
  assert.equal(rows[0]?.videoCode, '124')
  assert.equal(task.processed, 1)
  assert.ok(task.events.some((event: any) => event.level === 'error' && event.message.includes('124') && event.message.includes('403')))
  assert.ok(task.events.some((event: any) => event.level === 'warn' && event.message.includes('清晰度回退')))
})
await test('done event waits for invoke result and cancelled totals reflect committed files', async () => {
  const state = module.useVideoSeriesDownload('terminal'); await state.resolve()
  const run = state.download()
  emit({ phase: 'done', episodeIndex: 2 })
  const running = state.running.value
  const task = center.runningTasks.value.find((task: any) => task.title.includes('系列'))
  complete({ status: 'cancelled', completed: 1 }); await run
  assert.equal(running, true)
  assert.equal(center.tasks.value.find((value: any) => value.id === task.id).processed, 1)
  assert.equal(state.processedCount?.value, 1)
})
await test('late cancellation response cannot clear the new request cancellation state', async () => {
  const state = module.useVideoSeriesDownload('cancel-race'); await state.resolve()
  const pendingCancels: ((value: { ok: boolean }) => void)[] = []
  cancelAction = () => new Promise(resolve => pendingCancels.push(resolve))
  const run1 = state.download(); const cancel1 = state.cancel()
  complete(); await run1
  const run2 = state.download(); const cancel2 = state.cancel()
  pendingCancels[0]({ ok: false }); await cancel1
  const stillCancelling = state.cancelling.value
  pendingCancels[1]({ ok: true }); await cancel2
  complete({ status: 'cancelled', completed: 0 }); await run2
  cancelAction = async () => ({ ok: true })
  assert.equal(stillCancelling, true)
})
await test('retry sends only failed episode IDs after refreshing the playlist', async () => {
  const state = module.useVideoSeriesDownload('retry'); await state.resolve()
  const run = state.download()
  complete({ status: 'failed', completed: 1, failed: 1, results: [
    { videoCode: '124', title: '第一集', status: 'success', path: 'D:/series-downloads/124.mp4', sourceLabel: '', message: '完成', warnings: [] },
    { videoCode: '125', title: '第二集', status: 'failed', path: '', sourceLabel: '', message: 'HTTP 403', warnings: [] }
  ] }); await run
  assert.equal(typeof state.retryFailed, 'function')
  const retries = state.retryFailed()
  await new Promise(resolve => setImmediate(resolve))
  const request = requests.at(-1)
  complete({ total: 1, completed: 1 }); await retries
  assert.deepEqual(Array.from(request.videoCodes), ['125'])
})
await test('IPC rejection releases the running state and progress subscription', async () => {
  const state = module.useVideoSeriesDownload('ipc-failure'); await state.resolve()
  const run = state.download()
  rejectRun?.(new Error('IPC disconnected')); await run
  assert.equal(state.running.value, false)
  assert.equal(progressListeners.size, 0)
  assert.match(state.error.value, /IPC disconnected/)
})
const panelLoader = createRendererLoader({
  vue: Vue,
  pinia: Pinia,
  '@/composables/useVideoSeriesDownload': module
}, {}, true)
const Panel = panelLoader('src/components/video/SeriesDownload.vue').default
async function renderPanel(id: string) {
  const app = Vue.createSSRApp(Panel, { id, hanimeId: '123' })
  app.use(Pinia.createPinia())
  return parse(await renderToString(app))
}
await test('actual Vue panel renders select-all and individual episode controls', async () => {
  const state = module.useVideoSeriesDownload('panel'); await state.resolve()
  const dom = await renderPanel('panel')
  assert.equal(dom.querySelectorAll('input[type=checkbox]').length, 3)
  assert.ok(dom.text.includes('第一集')); assert.ok(dom.text.includes('第二集'))
  state.selectedVideoCodes.value = []
  const empty = await renderPanel('panel')
  assert.equal(empty.querySelector('.btn--primary')?.hasAttribute('disabled'), true)
})
await test('actual Vue panel renders byte progress, per-episode errors, retry and cancelled totals', async () => {
  const state = module.useVideoSeriesDownload('panel-results'); await state.resolve()
  const run = state.download()
  emit({ receivedBytes: 1024, totalBytes: 2048, bytesPerSecond: 1024 })
  let busy: ReturnType<typeof parse>
  try { busy = await renderPanel('panel-results') }
  finally {
    complete({ status: 'cancelled', completed: 0, failed: 1, results: [
      { videoCode: '124', title: '第一集', status: 'failed', path: '', sourceLabel: '720p', message: '<script>HTTP 403</script>', warnings: ['需要验证'] }
    ] }); await run
  }
  const dom = await renderPanel('panel-results')
  assert.match(busy.text, /1 KB.*2 KB.*1 KB\/秒/)
  assert.match(dom.text, /HTTP 403/)
  assert.equal(dom.querySelector('script'), null)
  assert.match(dom.text, /重试失败集/)
  assert.match(dom.text, /未完成 1/)
  assert.equal(dom.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow'), '50')
})
console.log(`系列下载 renderer 回归：${passed} 通过 / ${failed} 失败`)
if (failed) process.exitCode = 1
