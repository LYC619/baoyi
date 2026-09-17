import assert from 'node:assert/strict'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import type { VideoAgentPlan, VideoAgentProgress } from '../src/types/video-agent-organize.ts'

let passed = 0, failed = 0
const samplePlan = (patch: Partial<VideoAgentPlan> = {}): VideoAgentPlan => ({ id: 'preview', actions: { merge: true, artwork: true, metadata: false, transfer: 'none' },
  works: [{ id: 'one', title: 'Morning E01' }, { id: 'two', title: 'Morning E02' }], groups: [], tokens: 17, log: '', groupingStatus: 'complete', warnings: [], ...patch })
function fixture() {
  let callback: (value: VideoAgentProgress) => void = () => {}
  let prepare = async () => samplePlan()
  const bridge = { onProgress: (next: typeof callback) => { callback = next }, prepare: () => prepare(), cancel: async () => true }
  const load = createRendererLoader({}, { window: { baoyi: { videoAgentOrganize: bridge } }, console: { info() {}, warn() {}, error() {} } })
  const session = load('src/composables/useVideoAgentOrganize.ts').useVideoAgentOrganize()
  const tasks = load('src/composables/useTaskCenter.ts').useTaskCenter()
  session.show(samplePlan().works)
  return { session, tasks, progress: (value: VideoAgentProgress) => callback(value), setPrepare: (next: typeof prepare) => { prepare = next } }
}
async function test(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log('PASS ' + name) }
  catch (cause) { failed++; console.error('FAIL ' + name + ': ' + (cause instanceof Error ? cause.message : cause)) }
}
async function panel(session: any) {
  const load = createRendererLoader({ '@/composables/useVideoAgentOrganize': { useVideoAgentOrganize: () => session }, './OrganizePreview.vue': { default: { render: () => null } } }, {}, true)
  const context: { teleports?: Record<string, string> } = {}
  await renderToString(createSSRApp(load('src/components/video/AgentOrganizePanel.vue').default), context)
  return context.teleports?.body || ''
}

await test('failed IPC keeps streamed diagnostics in task history and displays a readable error', async () => {
  const f = fixture()
  f.setPrepare(async () => {
    f.progress({ current: '第 1 / 2 批', processed: 0, total: 4, message: '正在核对', log: '工具校验失败：参数不是合法的 JSON', level: 'warn' })
    throw new Error("Error invoking remote method 'video-agent:prepare': Error: 分析期间作品资料已变化，请重新生成整理预览")
  })
  await f.session.prepare()
  assert.equal(f.session.error.value, '分析期间作品资料已变化，请重新生成整理预览')
  assert.match(f.session.analysisLog.value, /不是合法的 JSON/)
  const task = f.tasks.history.value[0]
  assert.equal(task.status, 'failed'); assert.ok(task.events.some((event: any) => event.level === 'warn' && event.message.includes('不是合法的 JSON')))
  const html = await panel(f.session)
  assert.match(html, /分析日志/); assert.match(html, /不是合法的 JSON/); assert.doesNotMatch(html, /Error invoking remote/)
})

await test('a failed grouping plan remains available for artwork and is never labeled as no matching series', async () => {
  const f = fixture()
  f.setPrepare(async () => samplePlan({ groupingStatus: 'failed', warnings: ['第 1 / 1 批：模型已回复，但未提交可用分组。'], log: '模型回复：仅有说明文字' }))
  await f.session.prepare()
  assert.equal(f.tasks.history.value[0].status, 'failed')
  const html = await panel(f.session)
  assert.match(html, /分组分析未完成/); assert.match(html, /模型已回复，但未提交可用分组/)
  assert.match(html, /重新生成预览/); assert.match(html, /确认执行所选操作/)
  assert.doesNotMatch(html, /没有找到证据充分的同系列分组/)
})

await test('partial grouping records warnings, preserves valid choices and permits a retry', async () => {
  const f = fixture()
  f.setPrepare(async () => samplePlan({ groupingStatus: 'partial', warnings: ['第 2 / 3 批：请求失败'],
    groups: [{ id: 'valid', title: 'Morning 1-2', resourceIds: ['one', 'two'], reason: 'Matching series', preview: { canMerge: true, works: [], episodes: [], files: [], warnings: [], collisions: [] } as any }] }))
  await f.session.prepare()
  assert.deepEqual([...f.session.groupIds.value], ['valid'])
  const task = f.tasks.history.value[0]
  assert.match(task.message, /部分|提示/); assert.ok(task.events.some((event: any) => event.level === 'warn' && event.message.includes('请求失败')))
  const html = await panel(f.session)
  assert.match(html, /Morning 1-2/); assert.match(html, /第 2 \/ 3 批：请求失败/)
  assert.match(html, /重新生成预览/)
})

await test('a cancelled analysis is recorded as cancelled and a new attempt clears its old diagnostics', async () => {
  const f = fixture()
  f.setPrepare(async () => { f.progress({ current: '', processed: 0, total: 2, message: '停止', log: '上一轮分析' }); throw new Error('已停止分析，尚未修改作品') })
  await f.session.prepare(); assert.equal(f.tasks.history.value[0].status, 'cancelled')
  f.setPrepare(async () => samplePlan({ groupingStatus: 'no-candidates', log: '本轮无需请求 Agent' }))
  await f.session.prepare()
  assert.doesNotMatch(f.session.analysisLog.value, /上一轮分析/)
  const html = await panel(f.session); assert.match(html, /片名和集数/); assert.doesNotMatch(html, /分组分析未完成/)
})

console.log(`Video Agent grouping renderer: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
