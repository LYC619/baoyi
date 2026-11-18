/** Settings 的真实 SFC setup 回归；桥接边界用 structuredClone，避免把 Vue Proxy 测漏。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import * as Vue from 'vue'
import * as utils from '../src/utils/index.ts'
import * as proxyRules from '../electron/services/proxy-rules.ts'
import type { GameScanProgress, VideoScanResult } from '../src/types/index.ts'

const source = fs.readFileSync(path.resolve('src/components/settings/tabs/ScanTab.vue'), 'utf8')
const result: VideoScanResult = { candidates: 2, registered: 1, skipped: 1, failed: 0, tokens: 0, episodes: 0, searches: 0 }
const softwareResult = { found: 2, added: 1, pending: 1, settled: 0, loose_files: [] }
const tick = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(kind: 'software' | 'game' | 'video' = 'game', tab = 'Scan') {
  const notices: Array<{ type: string; message: string }> = []
  const scanCalls: Array<{ kind: string; dirs: string[] }> = []
  const reloads: string[] = []
  const unmount: Array<() => void> = []
  const listeners = new Map<string, (p: GameScanProgress) => void>()
  const routes: unknown[] = []
  const activeModule = Vue.ref(kind)
  let settings = Vue.reactive({ settings: {
    ai: { api_url: '', api_key: 'test-key', enabled: true, model: 'test' },
    ai_profiles: [], ai_profile_id: '',
    search: { provider: 'model_builtin', api_key: '', endpoint: '', enabled: false },
    tmdb: { api_key: '', api_domain: '', image_domain: '', enabled: false },
    software_scan_dirs: ['D:\\Library\\Software'], game_scan_dirs: ['D:\\Library\\Games'], video_scan_dirs: ['D:\\Library\\Video'],
    proxy: '', unused_days: 60, title_lang: 'zh', save_backup_keep: 10
  }, patch: async () => {} })
  let scanImpl: () => Promise<VideoScanResult> = async () => result
  let softwareScanImpl = async () => softwareResult
  let readinessImpl = async () => ({ ok: true, message: '' })
  let verifyImpl = async () => false
  let statusImpl = async () => ({ rules: '', resolved: 'DIRECT' })
  let confirmResult = true
  let cancellations = 0
  const mediaApi = (module: string) => ({
    // 和 contextBridge 一样，在 preload 函数体执行之前同步拒绝 Proxy。
    scan: (dirs: string[]) => {
      const copy = structuredClone(dirs)
      scanCalls.push({ kind: module, dirs: copy })
      return scanImpl()
    },
    readiness: () => readinessImpl(),
    cancel: () => { cancellations++ },
    onProgress: (cb: (p: GameScanProgress) => void) => {
      listeners.set(module, cb)
      return () => { listeners.delete(module) }
    }
  })
  const previewCalls: string[][] = []
  let prepareImpl: () => Promise<any> = async () => ({ id: 'preview', revision: 1, roots: [], entries: [], status: 'ready' })
  const baoyi = {
    videoImport: { onChanged: () => () => {}, list: async () => [], prepare: (dirs: string[]) => { previewCalls.push(structuredClone(dirs)); return prepareImpl() } },
    video: mediaApi('video'), game: mediaApi('game'),
    scan: {
      units: async () => [],
      run: async (dirs: string[]) => {
        scanCalls.push({ kind: 'software', dirs: structuredClone(dirs) })
        return softwareScanImpl()
      },
      onProgress: () => () => {},
      cancel: () => { cancellations++ }
    },
    settings: {
      getAll: async () => ({}),
      hanimeVerify: () => verifyImpl(),
      proxyStatus: () => statusImpl()
    }
  }
  const stores = (module: string) => ({ reload: async () => { reloads.push(module) } })
  const mocks: Record<string, unknown> = {
    vue: { ...Vue, onMounted: () => {}, onBeforeUnmount: (cb: () => void) => unmount.push(cb) },
    'vue-router': { useRoute: () => ({ query: { tab: 'scan' } }), useRouter: () => ({ replace: (value: unknown) => routes.push(value) }) },
    '@/composables/useModules': { activeModule, moduleTarget: () => '/' },
    '@/composables/useAI': { useAI: () => ({ running: Vue.ref(false) }) },
    '@/composables/useToast': { useToast: () => Object.fromEntries(['success', 'error', 'toast'].map(type => [type, (message: string) => notices.push({ type, message })])) },
    '@/stores/settings': { useSettingsStore: () => settings },
    pinia: { defineStore: (_id: string, setup: () => unknown) => () => Vue.reactive(setup() as object) },
    './software': { useSoftwareStore: () => ({ ...stores('software'), refreshCounts: async () => {} }) },
    '@/stores/project': { useProjectStore: () => ({ refresh: async () => {} }) },
    '@/stores/software': { useSoftwareStore: () => stores('software') },
    '@/stores/video': { useVideoStore: () => stores('video') },
    '@/stores/game': { useGameStore: () => stores('game') },
    '@/stores/categories': { ICON_NAMES: [], useCategoriesStore: () => ({}) },
    '@/utils': utils,
    '../../../../electron/services/proxy-rules': proxyRules
  }
  const scope = Vue.effectScope()
  const load = createRendererLoader(mocks, {
    window: { baoyi, confirm: () => confirmResult }, console: { info: () => {}, warn: () => {}, error: () => {} }
  })
  const initialSettings = settings.settings
  settings = scope.run(() => load('src/stores/settings.ts').useSettingsStore())!
  Object.assign(settings.settings, initialSettings)
  const module = load(`src/components/settings/tabs/${tab}Tab.vue`)
  const taskCenter = load('src/composables/useTaskCenter.ts').useTaskCenter()
  const state = scope.run(() => module.default.setup({}, { expose: () => {} }))!

  return {
    state, taskCenter, settings, notices, scanCalls, reloads, listeners, routes, activeModule, load,
    previewCalls, setPrepare: (fn: typeof prepareImpl) => { prepareImpl = fn },
    setScan: (fn: typeof scanImpl) => { scanImpl = fn },
    setSoftwareScan: (fn: typeof softwareScanImpl) => { softwareScanImpl = fn },
    setReadiness: (fn: typeof readinessImpl) => { readinessImpl = fn },
    setVerification: (fn: typeof verifyImpl) => { verifyImpl = fn },
    setStatus: (fn: typeof statusImpl) => { statusImpl = fn },
    setConfirm: (value: boolean) => { confirmResult = value },
    cancellations: () => cancellations,
    dispose: () => { unmount.forEach(cb => cb()); scope.stop() }
  }
}

let passed = 0
let failed = 0
async function test(name: string, run: () => void | Promise<void>) {
  try { await run(); passed++; console.log(`PASS ${name}`) }
  catch (err) { failed++; console.error(`FAIL ${name}: ${(err instanceof Error ? err.message : String(err)).slice(0, 380)}`) }
}

// Video settings now opens the existing preview/confirm workflow; it no longer runs the legacy direct scanner.
await test('影视设置扫描使用真实预览流程，目录快照过桥且不直接入库', async () => {
  const h = harness('video')
  const pending = deferred<any>()
  try {
    h.setPrepare(() => pending.promise)
    const run = h.state.runScan()
    h.settings.settings.video_scan_dirs.push('D:\\Library\\Added')
    await h.state.runScan()
    assert.deepEqual(h.previewCalls, [['D:\\Library\\Video']])
    assert.equal(h.scanCalls.length, 0)
    pending.resolve({ id: 'preview', revision: 1, roots: [], entries: [], status: 'ready' })
    await run
    assert.equal(h.load('src/composables/useVideoImport.ts').useVideoImport().open.value, true)
    assert.equal(h.state.busy.value, false)
    assert.equal(h.taskCenter.history.value[0].status, 'success')
  } finally { pending.resolve(null); h.dispose() }
})
await test('影视预览失败可见且可重试，取消选择不误报成功', async () => {
  const h = harness('video')
  try {
    h.setPrepare(async () => { throw new Error('无法读取目录') })
    await h.state.runScan()
    assert.match(h.load('src/composables/useVideoImport.ts').useVideoImport().error.value, /无法读取目录/)
    assert.equal(h.state.busy.value, false)
    h.setPrepare(async () => null)
    await h.state.runScan()
    assert.equal(h.previewCalls.length, 2)
    assert.equal(h.taskCenter.history.value[0].status, 'cancelled')
  } finally { h.dispose() }
})

for (const kind of ['game', 'software'] as const) {
  await test(`${kind} 设置扫描：Proxy 在 renderer 拍平后过桥，完成刷新正确的库`, async () => {
    const h = harness(kind)
    try {
      assert.equal(Vue.isReactive(h.state.dirs.value), true)
      await h.state.runScan()
      assert.equal(h.scanCalls.length, 1)
      assert.equal(h.scanCalls[0].kind, kind)
      assert.deepEqual(h.scanCalls[0].dirs, [...h.state.dirs.value])
      assert.deepEqual(h.reloads, [kind])
      assert.equal(h.notices.at(-1)?.type, 'success')
      assert.equal(h.taskCenter.history.value[0]?.kind, kind === 'software' ? 'software-scan' : kind + '-scan')
    } finally { h.dispose() }
  })
}

await test('缺少扫描目录时给出提示，不调用 IPC', async () => {
  const h = harness()
  try {
    h.settings.settings.game_scan_dirs = []
    await h.state.runScan()
    assert.equal(h.scanCalls.length, 0)
    assert.match(h.notices.at(-1)?.message ?? '', /目录/)
  } finally { h.dispose() }
})



await test('游戏未启用 AI 时，不启动一轮注定失败的扫描', async () => {
  const h = harness('game')
  try {
    h.settings.settings.ai.enabled = false
    await h.state.runScan()
    assert.equal(h.scanCalls.length, 0)
    assert.equal((h.routes.at(-1) as any).query.tab, 'ai')
    assert.equal((h.routes.at(-1) as any).query.scope, 'global')
    assert.match(h.notices.at(-1)?.message ?? '', /AI/)
  } finally { h.dispose() }
})





await test('预检/扫描中有忙碌状态，重复点击只启动一次，进度来自游戏通道', async () => {
  const h = harness()
  const pending = deferred<VideoScanResult>()
  try {
    h.setScan(() => pending.promise)
    const first = h.state.runScan()
    void first.catch(() => {})
    assert.equal(h.state.busy.value, true)
    await h.state.runScan()
    await tick()
    assert.equal(h.scanCalls.length, 1)
    assert.equal(h.listeners.has('game'), true)
    h.listeners.get('game')!({ phase: 'identifying', current: 'sample.mkv', processed: 1, total: 2, registered: 0, failed: 0, log: '读本地事实' })
    assert.match(h.state.scanPhaseLabel.value, /读本地事实/)
    assert.equal(h.state.scanPercent.value, 50)
    pending.resolve(result)
    await first
    assert.equal(h.state.busy.value, false)
    assert.equal(h.listeners.size, 0)
  } finally { pending.resolve(result); h.dispose() }
})

await test('扫描同步异常和异步失败均给出错误，状态解锁，可再次扫描', async () => {
  for (const asynchronous of [false, true]) {
    const h = harness()
    try {
      h.setScan(() => {
        if (asynchronous) return Promise.reject(new Error('读取目录失败'))
        throw new Error('读取目录失败')
      })
      await h.state.runScan()
      assert.equal(h.notices.at(-1)?.type, 'error')
      assert.match(h.notices.at(-1)?.message ?? '', /读取目录失败/)
      assert.equal(h.state.busy.value, false)
      assert.equal(h.listeners.size, 0)
      h.setScan(async () => result)
      await h.state.runScan()
      assert.equal(h.scanCalls.length, 2)
    } finally { h.dispose() }
  }
})

await test('0 候选和全部识别失败不显示绿色成功', async () => {
  for (const outcome of [{ ...result, candidates: 0, registered: 0 }, { ...result, registered: 0, failed: 2 }]) {
    const h = harness()
    try {
      h.setScan(async () => outcome)
      await h.state.runScan()
      assert.notEqual(h.notices.at(-1)?.type, 'success')
      assert.match(h.notices.at(-1)?.message ?? '', outcome.candidates ? /失败/ : /没找到|未找到/)
    } finally { h.dispose() }
  }
})

await test('停止扫描只发送一次取消，等旧任务结束才解锁，不误报全部完成', async () => {
  const h = harness()
  const pending = deferred<VideoScanResult>()
  try {
    h.setScan(() => pending.promise)
    const run = h.state.runScan()
    void run.catch(() => {})
    await tick()
    h.state.cancelScan()
    h.state.cancelScan()
    assert.equal(h.cancellations(), 1)
    assert.equal(h.state.busy.value, true)
    pending.resolve(result)
    await run
    assert.match(h.notices.at(-1)?.message ?? '', /停止/)
    assert.equal(h.state.busy.value, false)
  } finally { pending.resolve(result); h.dispose() }
})



await test('软件扫描从另一页面停止：设置页同步停止状态且不显示成功', async () => {
  const h = harness('software')
  const pending = deferred<typeof softwareResult>()
  try {
    h.setSoftwareScan(() => pending.promise)
    const run = h.state.runScan()
    h.load('src/composables/useScan.ts').useScan().cancel()
    assert.match(h.state.scanPhaseLabel.value, /停止/)
    pending.resolve(softwareResult)
    await run
    assert.equal(h.taskCenter.history.value[0].status, 'cancelled')
    assert.notEqual(h.notices.at(-1)?.type, 'success')
    assert.match(h.notices.at(-1)?.message ?? '', /停止/)
  } finally { pending.resolve(softwareResult); h.dispose() }
})

await test('离开设置页保留任务级订阅，持续更新全局进度，收尾后释放', async () => {
  const h = harness()
  const pending = deferred<VideoScanResult>()
  h.setScan(() => pending.promise)
  const run = h.state.runScan()
  void run.catch(() => {})
  await tick()
  h.dispose()
  assert.equal(h.listeners.size, 1)
  h.listeners.get('game')!({ phase: 'identifying', current: '后台条目', processed: 1, total: 2, registered: 1, failed: 0, log: '继续识别' })
  assert.equal(h.taskCenter.runningTasks.value[0].current, '后台条目')
  pending.resolve(result)
  await run
  assert.equal(h.listeners.size, 0)
  assert.equal(h.taskCenter.history.value[0].status, 'success')
  assert.deepEqual(h.reloads, ['game'])
})







await test('游戏进度不串到视频，done 后等待收尾但不可再取消已完成任务', async () => {
  const h = harness('game')
  const pending = deferred<VideoScanResult>()
  try {
    h.setScan(() => pending.promise)
    const run = h.state.runScan()
    void run.catch(() => {})
    await tick()
    assert.equal(h.listeners.has('game'), true)
    assert.equal(h.listeners.has('video'), false)
    h.listeners.get('game')!({ phase: 'done', current: '', processed: 2, total: 2, registered: 1, failed: 0, log: '' })
    assert.equal(h.state.busy.value, true)
    assert.equal(h.state.canCancelScan.value, false)
    assert.equal(h.state.scanPercent.value, 100)
    assert.match(h.state.scanPhaseLabel.value, /游戏.*刷新/)
    pending.resolve(result)
    await run
    assert.equal(h.state.busy.value, false)
  } finally { pending.resolve(result); h.dispose() }
})

await test('扫描页面绑定当前扫描状态，软件识别按钮不泄漏到游戏/视频', () => {
  assert.match(source, /v-if="scanRunning"/)
  assert.match(source, /\{\{ scanPhaseLabel \}\}/)
  assert.match(source, /width: `\$\{scanPercent\}%`/)
  assert.match(source, /<section v-if="activeModule === 'software'" class="panel">\s*<h2 class="sec-head">AI 识别/)
  assert.match(source, /v-if="activeModule === 'software' && skippedCount > 0"/)
})

await test('验证结束后立即解锁，辅助代理状态查询悬挂不能锁住验证按钮', async () => {
  const h = harness('game', 'Network')
  const pending = deferred<{ rules: string; resolved: string }>()
  h.setVerification(async () => true)
  h.setStatus(() => pending.promise)
  const run = h.state.verifyHanime()
  try {
    await tick()
    assert.equal(h.state.hanimeVerifying.value, false)
    assert.equal(h.state.proxyResult.value.ok, true)
    assert.equal(h.taskCenter.history.value[0]?.status, 'success')
    assert.equal(h.taskCenter.runningCount.value, 0)
    assert.match(h.state.proxyResult.value.message, /通过/)
  } finally {
    pending.resolve({ rules: '', resolved: 'DIRECT' })
    await run
    h.dispose()
  }
})

for (const mode of ['incomplete', 'error', 'success'] as const) {
  await test(`Cloudflare ${mode}：验证结果不被随后代理状态查询覆盖，异常不逃逸`, async () => {
    const h = harness('game', 'Network')
    try {
      h.setVerification(async () => {
        if (mode === 'error') throw new Error('验证窗口加载失败')
        return mode === 'success'
      })
      await h.state.verifyHanime()
      assert.equal(h.state.hanimeVerifying.value, false)
      assert.equal(h.state.proxyResult.value.ok, mode === 'success')
      assert.equal(h.taskCenter.history.value[0]?.status, mode === 'error' ? 'failed' : mode === 'success' ? 'success' : 'cancelled')
      assert.match(h.state.proxyResult.value.message, mode === 'error' ? /验证窗口加载失败/ : mode === 'success' ? /通过/ : /未完成/)
    } finally { h.dispose() }
  })
}

console.log(`\nSettings regression: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
