/** Renderer-only workflow regression: no network, filesystem media, or Electron app. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

const events = new Set<(job: any) => void>()
const requests: any[] = []
const retries: Array<[string, string]> = []
const settings = { hide_hentai: false, video_download_root: 'D:/Library', video_download_quality: '720p', video_download_strict_quality: true, video_download_register: true }
const draft = { id: 'draft-1', resourceId: '', title: '示例作品', videoCode: '100', category: '里番', description: '', pageUrl: 'https://hanime1.me/watch?v=100', root: 'D:/Library', directory: 'D:/Library/示例作品', bound: false, missing: ['poster'], warnings: [], episodes: [
  { videoCode: '100', title: '已有文件', order: 1, state: 'local', qualities: ['720p'] },
  { videoCode: '101', title: '文件丢失', order: 2, state: 'missing', qualities: [] },
  { videoCode: '102', title: '尚未下载', order: 3, state: 'available', qualities: [] },
  { videoCode: '103', title: '已排队', order: 4, state: 'queued', qualities: [] }
] }
const job = { id: 'job-1', resourceId: '', bundleId: '', title: draft.title, category: draft.category, videoCode: '100', root: draft.root, directory: draft.directory, sourceLabel: '720p', strictQuality: true, register: true, status: 'queued', createdAt: 1, updatedAt: 1, message: '已排队', description: '', posterUrl: '', posterPath: '', sources: [], warnings: [], items: [] }
let prepare = async () => structuredClone(draft)
const api = {
  prepareDownload: () => prepare(),
  pickDownloadRoot: async () => ({ ...structuredClone(draft), root: 'E:/Videos', directory: 'E:/Videos/示例作品' }),
  enqueueDownload: async (request: any) => { requests.push(request); return { ...job, updatedAt: 2 } },
  downloadJobs: async () => [],
  onDownloadJob: (callback: (job: any) => void) => { events.add(callback); return () => events.delete(callback) },
  retryDownloadJob: async (id: string, stage: string) => { retries.push([id, stage]); return { ...job, status: 'queued', updatedAt: 4 } },
  cancelDownloadJob: async () => true,
  revealDownloadJob: async () => true
}
const load = createRendererLoader({ vue: Vue }, { window: { baoyi: { video: api, settings: { getAll: async () => ({ ...settings }) } } }, console: { info() {}, warn() {}, error() {} } })
const module = fs.existsSync('src/composables/useVideoWorkflow.ts') ? load('src/composables/useVideoWorkflow.ts') : {}
assert.equal(typeof module.useVideoWorkflow, 'function', '应提供共用下载草稿与持久任务的 renderer 状态（RED）')
const flow = module.useVideoWorkflow()
await flow.refresh()
flow.url.value = draft.pageUrl
await flow.prepare()
assert.deepEqual(Array.from(flow.selectedVideoCodes.value), ['101', '102'], '默认只选真正需要补齐的内容，不选已有/排队内容')
assert.equal(flow.sourceLabel.value, '720p')
assert.equal(flow.strictQuality.value, true)
assert.equal(flow.register.value, true)
flow.title.value = '用户改过的作品名'
const returned = module.useVideoWorkflow()
assert.equal(returned.title.value, '用户改过的作品名', '访问设置再返回时保留草稿编辑')
await returned.pickRoot()
assert.equal(flow.draft.value.root, 'E:/Videos')
flow.register.value = false
await flow.enqueue()
assert.deepEqual(Array.from(requests[0].videoCodes), ['101', '102'])
assert.equal(requests[0].register, false)
assert.equal(requests[0].title, '用户改过的作品名')
assert.equal(flow.jobs.value[0].status, 'queued', '入队不等于下载或入库成功')
events.forEach(cb => cb({ ...job, status: 'partial', updatedAt: 3, message: '视频已下载，资料待补齐' }))
assert.equal(flow.jobs.value[0].status, 'partial')
await flow.retry('job-1', 'metadata')
assert.deepEqual(retries, [['job-1', 'metadata']], '补资料重试必须保留阶段，不能重新下载')
settings.hide_hentai = true
await flow.refresh()
assert.equal(flow.jobs.value.length, 0, '隐藏类别不泄露任务标题或计数')
settings.hide_hentai = false
await flow.refresh()
let completePrepare: ((value: any) => void) | undefined
prepare = () => new Promise(resolve => { completePrepare = resolve })
const pending = flow.prepare()
flow.reset()
completePrepare?.(structuredClone(draft))
await pending
assert.equal(flow.draft.value, null, '取消解析后的迟到响应不得恢复草稿')

let finishHydrate: ((tasks: any[]) => void) | undefined
let clears = 0
const taskLoader = createRendererLoader({ vue: Vue }, { window: { baoyi: { tasks: {
  list: () => new Promise(resolve => { finishHydrate = resolve }), save: async () => true, clear: async () => { clears++; return true }
} } }, console: { info() {}, warn() {}, error() {} } })
const tasks = taskLoader('src/composables/useTaskCenter.ts').useTaskCenter()
const live = tasks.start('video-scan', '加载历史期间开始的新任务')
finishHydrate?.([{ id: 'task-1', kind: 'video-scan', title: '旧任务', status: 'running', startedAt: 1, processed: 0, total: 1, percent: 0, current: '', message: '', events: [] }])
await new Promise(resolve => setImmediate(resolve))
assert.ok(tasks.tasks.value.some((task: any) => task.id === live && task.status === 'running'), '加载历史不能覆盖正在执行的新任务')
assert.ok(tasks.history.value.some((task: any) => task.status === 'interrupted'))
assert.equal(new Set(tasks.tasks.value.map((task: any) => task.id)).size, 2, '新旧任务 ID 不能冲突')
await tasks.clearFinished()
assert.equal(clears, 1, '清除历史必须同步持久存储')
assert.equal(tasks.runningCount.value, 1)
console.log('视频工作流 renderer：草稿、缺失默认选择、持久队列、阶段重试、隐藏与任务恢复通过')

// Each regression gets a fresh renderer module; only the IPC boundary is replaced.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function workflowHarness() {
  const listeners = new Set<(value: any) => void>()
  const submitted: any[] = []
  const fixture = structuredClone(draft)
  const preferences = { ...settings, hide_hentai: false }
  const ipc: any = {
    ...api,
    prepareDownload: async () => structuredClone(fixture),
    downloadJobs: async () => [],
    onDownloadJob: (callback: (value: any) => void) => { listeners.add(callback); return () => listeners.delete(callback) },
    enqueueDownload: async (request: any) => { submitted.push(request); return { ...structuredClone(job), items: request.videoCodes.map((code: string) => ({ videoCode: code, transfer: 'pending' })), updatedAt: Date.now() } }
  }
  const preferencesApi = { getAll: async () => ({ ...preferences }) }
  const module = createRendererLoader({ vue: Vue }, { window: { baoyi: { video: ipc, settings: preferencesApi } } })('src/composables/useVideoWorkflow.ts')
  return { module, ipc, submitted, fixture, preferences, preferencesApi, publish: (value: any) => listeners.forEach(callback => callback(value)) }
}
let regressionPassed = 0
let regressionFailed = 0
async function regression(name: string, run: () => Promise<void>) {
  try { await run(); regressionPassed++ }
  catch (cause) { regressionFailed++; console.error('FAIL ' + name + ': ' + (cause instanceof Error ? cause.message : cause)) }
}
await regression('同一来源从链接和已有作品同时入队，只发送一个请求', async () => {
  const h = workflowHarness()
  const first = h.module.useVideoWorkflow()
  const second = h.module.useVideoWorkflow('work-1')
  first.url.value = draft.pageUrl
  await Promise.all([first.prepare(), second.prepare()])
  const pending = deferred<any>()
  h.ipc.enqueueDownload = (request: any) => { h.submitted.push(request); return pending.promise }
  const one = first.enqueue()
  const two = second.enqueue()
  assert.equal(h.submitted.length, 1, '跨入口的未返回入队请求也必须互斥')
  pending.resolve({ ...job, items: [{ videoCode: '101', transfer: 'pending' }], updatedAt: Date.now() })
  await Promise.all([one, two])
  assert.match(second.error.value, /排队|处理|下载/)
})
await regression('解析后更换链接不能下载旧草稿', async () => {
  const h = workflowHarness(), flow = h.module.useVideoWorkflow()
  flow.url.value = draft.pageUrl
  await flow.prepare()
  flow.url.value = 'https://hanime1.me/watch?v=999'
  assert.equal(await flow.enqueue(), null)
  assert.equal(h.submitted.length, 0)
  assert.match(flow.error.value, /重新解析/)
})
await regression('等待目录选择时不能启动另一轮解析', async () => {
  const h = workflowHarness(), flow = h.module.useVideoWorkflow()
  flow.url.value = draft.pageUrl
  await flow.prepare()
  const pending = deferred<any>()
  h.ipc.pickDownloadRoot = () => pending.promise
  let prepares = 0
  h.ipc.prepareDownload = async () => { prepares++; return structuredClone(draft) }
  const picking = flow.pickRoot()
  await flow.prepare()
  assert.equal(prepares, 0)
  flow.reset()
  pending.resolve({ ...draft, root: 'X:/late' })
  await picking
  assert.equal(flow.draft.value, null, '取消后目录选择返回不能恢复草稿')
})
await regression('未知隐私设置期间不显示私密任务，旧设置响应不能覆盖新偏好', async () => {
  const h = workflowHarness()
  const pending = deferred<any>()
  h.preferencesApi.getAll = () => pending.promise
  const flow = h.module.useVideoWorkflow()
  h.publish({ ...job, updatedAt: Date.now() })
  assert.equal(flow.jobs.value.length, 0, '设置返回前不能闪出隐藏类别标题')
  const refresh = flow.refresh()
  flow.applyPreferences({ ...h.preferences, hide_hentai: true })
  pending.resolve({ ...h.preferences, hide_hentai: false })
  await refresh
  assert.equal(flow.jobs.value.length, 0, '迟到的旧设置不能取消隐藏')
})
await regression('实时排队和历史恢复会阻止陈旧草稿重复入队', async () => {
  const h = workflowHarness(), flow = h.module.useVideoWorkflow()
  flow.url.value = draft.pageUrl
  await flow.prepare()
  h.publish({ ...job, id: 'other-entry', status: 'running', items: [{ videoCode: '101', transfer: 'running' }], updatedAt: Date.now() })
  flow.selectedVideoCodes.value = ['101']
  assert.equal(await flow.enqueue(), null)
  assert.equal(h.submitted.length, 0)
})
await regression('入队失败释放互斥，成功前保留用户选项', async () => {
  const h = workflowHarness(), flow = h.module.useVideoWorkflow()
  flow.url.value = draft.pageUrl
  await flow.prepare()
  flow.register.value = false
  flow.strictQuality.value = false
  h.ipc.enqueueDownload = async () => { throw new Error('磁盘未连接') }
  assert.equal(await flow.enqueue(), null)
  assert.equal(flow.enqueuing.value, false)
  assert.deepEqual(Array.from(flow.selectedVideoCodes.value), ['101', '102'])
  h.ipc.enqueueDownload = async (request: any) => { h.submitted.push(request); return { ...job, updatedAt: Date.now() } }
  assert.ok(await flow.enqueue())
  assert.equal(h.submitted[0].register, false)
  assert.equal(h.submitted[0].strictQuality, false)
})
await regression('扫描逐项结果随任务保留，并区分待确认和失败', async () => {
  const entries = [
    { path: 'D:/Fixture/ok', resourceId: 'v1', status: 'updated', message: '新增内容' },
    { path: 'D:/Fixture/review', resourceId: 'v2', status: 'review', message: '归属待确认' },
    { path: 'D:/Fixture/broken', status: 'failed', message: '清单损坏' }
  ]
  const saved: any[] = []
  const loader = createRendererLoader({ vue: Vue }, { window: { baoyi: {
    video: { onProgress: () => () => {}, scan: async () => ({ candidates: 3, registered: 1, skipped: 0, failed: 1, episodes: 1, tokens: 0, entries }) },
    tasks: { list: async () => [], save: async (value: any) => { saved.push(value) }, clear: async () => true }
  } }, console: { info() {}, warn() {}, error() {} } })
  const scans = loader('src/composables/useMediaScan.ts')
  await scans.useMediaScan('video').run(['D:/Fixture'])
  const remounted = scans.useMediaScan('video')
  assert.ok(remounted.result?.value, '返回首页必须保留本轮扫描结果')
  assert.deepEqual(JSON.parse(JSON.stringify(remounted.result?.value?.entries)), entries, '返回首页仍能处理具体扫描结果')
  assert.ok(saved.at(-1).scanEntries?.some((entry: any) => entry.status === 'review'))
  assert.ok(saved.at(-1).events.some((event: any) => event.level === 'warn'))
})
await regression('已有作品补充来源链接时同时保留作品归属，更换链接必须重新解析', async () => {
  const h = workflowHarness(), flow = h.module.useVideoWorkflow('no-source')
  const inputs: any[] = []
  h.ipc.prepareDownload = async (input: any) => { inputs.push(input); return { ...structuredClone(draft), resourceId: 'no-source', bound: true } }
  flow.url.value = draft.pageUrl
  await flow.prepare()
  assert.equal(inputs[0].resourceId, 'no-source')
  assert.equal(inputs[0].url, draft.pageUrl)
  flow.url.value = 'https://hanime1.me/watch?v=999'
  assert.equal(await flow.enqueue(), null, '已有作品也不能提交另一个链接的旧草稿')
  assert.equal(h.submitted.length, 0)
})
await regression('清理历史只删除可见的已结束任务，保留隐藏任务与运行中任务', async () => {
  const cleared: string[][] = []
  const center = createRendererLoader({ vue: Vue }, { window: { baoyi: { tasks: {
    list: async () => [
      { id: 'private', kind: 'video-scan', title: '隐藏任务', status: 'success' },
      { id: 'public', kind: 'game-scan', title: '可见任务', status: 'success' }
    ], save: async () => true, clear: async (ids: string[]) => { cleared.push(ids); return true }
  } } }, console: { info() {} } })('src/composables/useTaskCenter.ts').useTaskCenter()
  await new Promise(resolve => setImmediate(resolve))
  center.setVideoHidden(true)
  const running = center.start('game-scan', '仍在扫描')
  await center.clearFinished()
  assert.deepEqual(Array.from(cleared[0]), ['public'])
  assert.ok(center.tasks.value.some((task: any) => task.id === 'private'))
  assert.ok(center.tasks.value.some((task: any) => task.id === running && task.status === 'running'))
})
await regression('持久层拒绝清理历史时保留记录并报告失败', async () => {
  const center = createRendererLoader({ vue: Vue }, { window: { baoyi: { tasks: {
    list: async () => [{ id: 'keep', kind: 'game-scan', title: '保留的任务', status: 'success' }],
    save: async () => true, clear: async () => false
  } } }, console: { info() {} } })('src/composables/useTaskCenter.ts').useTaskCenter()
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(() => center.clearFinished(), /清除|清理/)
  assert.equal(center.history.value.length, 1)
})
await regression('隐藏视频任务后，迟到的重新识别错误不能泄露文件路径', async () => {
  let rejectGet!: (cause: Error) => void
  const pendingGet = new Promise((_resolve, reject) => { rejectGet = reject })
  const loader = createRendererLoader({ vue: { ...Vue, inject: () => null, getCurrentInstance: () => null, onMounted() {}, onBeforeUnmount() {} } }, {
    window: { baoyi: { video: { ...api, get: () => pendingGet }, settings: { getAll: async () => ({ ...settings, hide_hentai: false }) } } }, console: { info() {}, warn() {}, error() {} }
  })
  const setup = loader('src/components/tasks/TaskCenter.vue').default.setup({}, { expose() {} })
  await setup.workflow.refresh()
  const requested = setup.retryScan({ id: 'task-private', scanEntries: [] }, { path: 'D:/Private/片名', resourceId: 'private', status: 'failed' })
  setup.workflow.applyPreferences({ ...settings, hide_hentai: true })
  rejectGet(new Error('私密片名：D:/Private/片名'))
  await requested
  assert.equal(setup.actionError.value, '')
  setup.workflow.applyPreferences({ ...settings, hide_hentai: false })
  setup.actionError.value = '先前的私密错误'
  setup.workflow.applyPreferences({ ...settings, hide_hentai: true })
  assert.equal(setup.actionError.value, '', '已经显示的任务错误也要立即遮蔽')
})
await regression('隐藏下载任务后，迟到的操作错误不泄露私密路径', async () => {
  const h = workflowHarness(), flow = h.module.useVideoWorkflow()
  await flow.refresh()
  h.publish({ ...job, status: 'partial', updatedAt: Date.now() })
  let rejectReveal!: (cause: Error) => void
  h.ipc.revealDownloadJob = () => new Promise((_resolve, reject) => { rejectReveal = reject })
  const requested = flow.reveal(job.id)
  flow.applyPreferences({ ...h.preferences, hide_hentai: true })
  rejectReveal(new Error('D:/Private/私密下载目录'))
  await requested
  assert.equal(flow.jobsError.value, '')
})
console.log(`视频工作流竞态与扫描回归：${regressionPassed} 通过 / ${regressionFailed} 失败`)
if (regressionFailed) process.exitCode = 1
