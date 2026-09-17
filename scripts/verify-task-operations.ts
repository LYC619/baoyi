import assert from 'node:assert/strict'
import * as Vue from 'vue'
import * as utils from '../src/utils/index.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import type { TaskRecord } from '../src/types/index.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const scanResult = { found: 2, added: 1, pending: 1, settled: 0, loose_files: [] }
const aiResult = { processed: 2, registered: 1, skipped: 0, failed: 1, tokens: 24, report_id: 'report' }
const mediaResult = { candidates: 3, registered: 1, skipped: 1, failed: 1, tokens: 24, episodes: 2, searches: 1 }
const organizeResult = { plan_id: 'plan', moved: 1, linked: 0, skipped: 0, failed: 1, steps: [{ ok: false, name: '工具', note: '文件被占用' }] }
function harness() {
  const listeners = new Map<string, Set<(p: any) => void>>()
  const calls: string[] = []
  const cancellations: string[] = []
  const notices: string[] = []
  const unmount: Array<() => void> = []
  const implementations: Record<string, (...args: any[]) => any> = {
    readiness: async () => ({ ok: true, message: '' }),
    scan: async () => scanResult, ai: async () => aiResult, import: async () => null,
    game: async () => mediaResult, video: async () => mediaResult,
    organize: async () => organizeResult,
    reidentify: async () => ({ id: 'v1', name_zh: '测试影片', name_en: '', file_name: 'video.mp4', path: 'D:/video.mp4' })
  }
  const api = (kind: string) => ({
    pickDirectories: async () => ['D:/library'],
    readiness: () => implementations.readiness(),
    onProgress: (cb: (p: any) => void) => {
      const list = listeners.get(kind) ?? new Set()
      listeners.set(kind, list)
      list.add(cb)
      return () => { list.delete(cb) }
    },
    cancel: () => { cancellations.push(kind) },
    run: (...args: any[]) => { calls.push(kind); structuredClone(args); return implementations[kind](...args) },
    complete: (...args: any[]) => { calls.push(kind); structuredClone(args); return implementations[kind](...args) },
    scan: (...args: any[]) => { calls.push(kind); structuredClone(args); return implementations[kind](...args) },
    importBundle: () => { calls.push('import'); return implementations.import() },
    reidentify: (...args: any[]) => { calls.push('reidentify'); return implementations.reidentify(...args) }
  })
  const baoyi = Object.fromEntries(['scan', 'ai', 'game', 'video', 'organize'].map(kind => [kind, api(kind)]))
  const store = { reload: async () => {}, merge: () => {}, load: async () => {}, counts: { all: 0 }, items: [], selection: {} }
  const load = createRendererLoader({
    vue: { ...Vue, onMounted: () => {}, onBeforeUnmount: (cb: () => void) => unmount.push(cb) },
    'vue-router': { useRouter: () => ({ push: () => {} }) },
    '@/composables/useModules': { recallScroll: () => 0, rememberScroll: () => {} },
    '@/composables/useToast': { useToast: () => ({ toast: (m: string) => notices.push(m), error: (m: string) => notices.push(m), success: (m: string) => notices.push(m) }) },
    '@/stores/game': { useGameStore: () => store },
    '@/stores/video': { useVideoStore: () => store },
    '@/stores/settings': { useSettingsStore: () => ({ settings: { ai: { enabled: true, api_key: 'test' } } }) },
    '@/utils': utils
  }, {
    window: { baoyi, confirm: () => true }, console: { info: () => {}, warn: () => {}, error: () => {} }
  })
  const center = load('src/composables/useTaskCenter.ts').useTaskCenter()
  return {
    load, center, calls, cancellations, implementations, notices,
    dispose: () => unmount.splice(0).forEach(cb => cb()),
    emit: (kind: string, progress: unknown) => listeners.get(kind)?.forEach(cb => cb(progress)),
    count: (kind: string) => listeners.get(kind)?.size ?? 0,
    latest: () => center.tasks.value[0] as TaskRecord
  }
}
let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS ' + name) }
  catch (err) { failed++; console.error('FAIL ' + name + ': ' + utils.errorMessage(err)) }
}
for (const kind of ['scan', 'ai', 'organize'] as const) {
  const file = { scan: 'useScan', ai: 'useAI', organize: 'useOrganize' }[kind]
  const method = kind === 'ai' ? 'complete' : 'run'
  const payload = kind === 'organize' ? [{ id: 'app', mode: 'move', target: 'D:/apps' }] : ['D:/library']
  await test(kind + ': live progress, final result and no early unlock on done', async () => {
    const h = harness()
    const job = deferred<any>()
    h.implementations[kind] = () => job.promise
    const operation = h.load('src/composables/' + file + '.ts')[file]()
    const run = operation[method](Vue.reactive(payload))
    assert.equal(h.center.runningCount.value, 1)
    h.emit(kind, { phase: 'running', processed: 1, total: 2, found: 2, failed: 0, registered: 1, current: '对象 A', log: '读取元数据' })
    assert.equal(h.latest().processed, 1)
    assert.equal(h.latest().current, '对象 A')
    h.emit(kind, { phase: 'done', processed: 2, total: 2, found: 2, failed: 0, registered: 1, current: '', log: '' })
    assert.equal(operation.running.value, true)
    const duplicate = operation[method](payload).catch(() => {})
    assert.equal(h.calls.length, 1)
    job.resolve(kind === 'scan' ? scanResult : kind === 'ai' ? aiResult : organizeResult)
    await Promise.all([run, duplicate])
    assert.equal(h.latest().status, 'success')
    assert.equal(operation.running.value, false)
    if (kind !== 'scan') assert.match(h.latest().message, /1.*失败/)
    if (kind === 'organize') assert.ok(h.latest().events.some(e => e.message.includes('文件被占用')))
  })
  await test(kind + ': sync/async failure unlocks and retains the actual error', async () => {
    for (const sync of [true, false]) {
      const h = harness()
      h.implementations[kind] = () => { if (sync) throw new Error('读取失败'); return Promise.reject(new Error('读取失败')) }
      const operation = h.load('src/composables/' + file + '.ts')[file]()
      await assert.rejects(operation[method](payload), /读取失败/)
      assert.equal(h.latest()?.status, 'failed')
      assert.equal(h.latest().error, '读取失败')
      assert.equal(operation.running.value, false)
    }
  })
  if (kind !== 'organize') await test(kind + ': cancellation waits for IPC, records partial work, sends once', async () => {
    const h = harness()
    const job = deferred<any>()
    h.implementations[kind] = () => job.promise
    const operation = h.load('src/composables/' + file + '.ts')[file]()
    const run = operation[method](payload)
    operation.cancel(); operation.cancel()
    assert.equal(h.cancellations.length, 1)
    assert.equal(h.latest().status, 'running')
    job.resolve(kind === 'scan' ? scanResult : aiResult)
    await run
    assert.equal(h.latest().status, 'cancelled')
    h.implementations[kind] = async () => kind === 'scan' ? scanResult : aiResult
    await operation[method](payload)
    assert.equal(h.latest().status, 'success', 'new run must not inherit cancellation')
    if (kind === 'scan') assert.equal(operation.stopping.value, false)
  })
}
for (const kind of ['game', 'video'] as const) {
  await test(kind + ': route-independent shared scan, partial result, listener released only at settlement', async () => {
    const h = harness()
    const job = deferred<any>()
    h.implementations[kind] = () => job.promise
    const { useMediaScan } = h.load('src/composables/useMediaScan.ts')
    const page1 = useMediaScan(kind)
    const run = page1.run(Vue.reactive(['D:/library']), '预检提醒：未配置元数据通道')
    assert.equal(h.latest().kind, kind + '-scan')
    assert.ok(h.latest().events.some(e => e.level === 'warn' && e.message.includes('预检提醒')))
    const page2 = useMediaScan(kind)
    assert.equal(page2.running.value, true)
    await assert.rejects(page2.run(['D:/other']), /正在/)
    assert.equal(h.calls.length, 1)
    h.emit(kind, { phase: 'identifying', current: '对象 A', processed: 1, total: 3, registered: 1, failed: 0, log: '读取事实' })
    assert.equal(h.latest().message, '读取事实')
    assert.equal(page2.progress.value.processed, 1)
    job.resolve(mediaResult); await run
    assert.equal(h.latest().status, 'success')
    assert.ok(h.latest().events.some(e => e.level === 'warn'))
    assert.equal(h.count(kind), 0)
  })
  await test(kind + ': cancellation from a remounted page and errors settle correctly', async () => {
    const h = harness()
    const job = deferred<any>()
    h.implementations[kind] = () => job.promise
    const { useMediaScan } = h.load('src/composables/useMediaScan.ts')
    const run = useMediaScan(kind).run(['D:/library'])
    useMediaScan(kind).cancel(); useMediaScan(kind).cancel()
    assert.equal(h.cancellations.length, 1)
    job.resolve({ ...mediaResult, registered: 1, skipped: 0, failed: 0 }); await run
    assert.equal(h.latest().status, 'cancelled')
    assert.ok(h.latest().processed < h.latest().total)
    h.implementations[kind] = () => Promise.reject(new Error('网络断开'))
    await assert.rejects(useMediaScan(kind).run(['D:/library']), /网络断开/)
    assert.equal(h.latest().status, 'failed')
    assert.equal(h.count(kind), 0)
  })
}
await test('reidentify: shares video mutex, records progress and rejects stale item on failed identify', async () => {
  const h = harness()
  const { useMediaScan, reidentifyVideo } = h.load('src/composables/useMediaScan.ts')
  const job = deferred<any>()
  h.implementations.reidentify = () => job.promise
  const run = reidentifyVideo({ id: 'v1', name_zh: '测试影片', name_en: '', file_name: 'video.mp4', path: 'D:/video.mp4' }, false)
  assert.match(h.latest().title, /测试影片/)
  await assert.rejects(useMediaScan('video').run(['D:/library']), /正在/)
  h.emit('video', { phase: 'done', current: 'v1', processed: 1, total: 1, registered: 0, failed: 1, log: '元数据识别失败' })
  job.resolve({ id: 'v1' })
  await assert.rejects(run, /元数据识别失败|识别失败/)
  assert.equal(h.latest().status, 'failed')
  assert.equal(h.count('video'), 0)
})
for (const kind of ['game', 'video'] as const) {
  await test(kind + ' Home: real setup calls shared runner, survives route disposal and reports cancellation', async () => {
    const h = harness()
    const job = deferred<any>()
    h.implementations[kind] = () => job.promise
    if (kind === 'video') h.implementations.readiness = async () => ({ ok: true, message: '首页降级提醒' })
    const setup = h.load('src/pages/' + kind + '/Home.vue').default.setup
    const page = setup({}, { expose: () => {} })
    const run = kind === 'video' ? page.addVideos() : page.addGames()
    for (let i = 0; i < 6; i++) await Promise.resolve()
    assert.equal(h.latest()?.kind, kind + '-scan')
    if (kind === 'video') assert.ok(h.latest().events.some(e => e.level === 'warn' && e.message === '首页降级提醒'))
    h.dispose()
    const newPage = setup({}, { expose: () => {} })
    assert.equal(newPage.scanning.value, true)
    newPage.cancelScan()
    job.resolve(mediaResult); await run
    assert.equal(h.latest().status, 'cancelled')
    assert.match(h.notices.at(-1) ?? '', /停止/)
    h.dispose()
  })
}
await test('video import: retains progress and results in the task center after route disposal', async () => {
  const h = harness(), job = deferred<any>()
  h.implementations.import = () => job.promise
  const page = h.load('src/pages/video/Home.vue').default.setup({}, { expose: () => {} })
  const run = page.importBundle()
  try {
    assert.equal(h.latest()?.kind, 'video-scan', 'directory imports create a persistent scan task')
    assert.match(h.latest().title, /导入/)
    h.dispose()
    h.emit('video', { phase: 'identifying', current: 'D:/library/episode.mp4', processed: 1, total: 2, registered: 1, failed: 0, log: '来源资料已识别' })
    assert.ok(h.latest().events.some(event => event.message.includes('来源资料已识别')))
    await assert.rejects(h.load('src/composables/useMediaScan.ts').useMediaScan('video').run(['D:/other']), /正在/)
  } finally {
    job.resolve({ resourceId: 'v1', itemsAdded: 1, scanResult: { ...mediaResult, failed: 0, entries: [{ path: 'D:/library/episode.mp4', resourceId: 'v1', status: 'new', message: '已导入' }] } })
    await run
  }
  assert.equal(h.latest().status, 'success')
  assert.equal((h.latest() as any).scanEntries.length, 1)
  assert.equal(h.count('video'), 0)
})
await test('video import: cancelling directory selection ends the task without a failure', async () => {
  const h = harness()
  const page = h.load('src/pages/video/Home.vue').default.setup({}, { expose: () => {} })
  await page.importBundle()
  assert.equal(h.latest()?.status, 'cancelled')
  assert.match(h.latest().message, /未选择|取消/)
  assert.equal(h.count('video'), 0)
})
await test('task identify logs include only the selected task time range', async () => {
  const queries: unknown[] = []
  const load = createRendererLoader({ vue: { ...Vue, onMounted: () => {} }, '@/composables/useToast': { useToast: () => ({ success: () => {}, toast: () => {} }) } }, {
    window: { baoyi: { logs: { list: async (query: unknown) => { queries.push(query); return [50, 150, 250].map(at => ({ id: String(at), created_at: at })) } } } }
  })
  const scope = Vue.effectScope()
  const view = scope.run(() => load('src/components/identify/IdentifyLog.vue').default.setup({ resourceKind: 'video', since: 100, until: 200 }, { expose: () => {} }))
  try { await view.load(); assert.deepEqual([...view.logs.value].map((log: any) => log.id), ['150']); assert.equal((queries[0] as any).resource_kind, 'video') }
  finally { scope.stop() }
})
await test('video Detail: reidentify creates task and cannot overwrite a newly navigated item', async () => {
  const h = harness()
  const job = deferred<any>()
  h.implementations.reidentify = () => job.promise
  const props = Vue.reactive({ id: 'v1' })
  const page = h.load('src/pages/video/Detail.vue').default.setup(props, { expose: () => {} })
  page.item.value = { id: 'v1', name_zh: '旧条目', name_en: '', file_name: 'a.mkv', path: 'D:/a.mkv' }
  const run = page.reidentify(false)
  assert.equal(h.latest()?.kind, 'video-scan')
  // Same detail component can be reused for a different route while IPC is pending.
  page.item.value = { id: 'v2', name_zh: '新条目' }
  job.resolve({ id: 'v1', name_zh: '更新后的旧条目' }); await run
  assert.equal(page.item.value.id, 'v2')
  assert.equal(h.latest().status, 'success')
})
console.log('Task operations: ' + passed + ' passed / ' + failed + ' failed')
if (failed) process.exitCode = 1
