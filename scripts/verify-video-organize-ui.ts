/** Actual renderer state, isolated IPC fixtures: no library, filesystem media or network. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

const file = 'src/components/video/useOrganizeSession.ts'
assert.ok(fs.existsSync(file), 'W7 must provide a preview-first organize session (RED)')
const work = (id: string, category = '其他') => ({ id, category, name_zh: '作品 ' + id, path: 'D:/Fixture/' + id, notes: '保留笔记 ' + id, updated_at: 1 })
const works = [work('one'), work('two')]
const preview = {
  kind: 'organize', request: { resourceIds: ['one', 'two'], survivorId: 'one' }, fingerprint: 'snapshot-1',
  works: works.map(w => ({ resourceId: w.id, name: w.name_zh, path: w.path, notes: w.notes, archived: false, watchStatus: 'watching', positionSec: 12, directory: null, fileIds: [w.id] })),
  survivor: { resourceId: 'one', name: '作品 one' }, targetDirectory: '', root: '', bundleId: 'bundle', episodes: [],
  files: [{ id: 'file', resourceIds: ['one'], assetIds: [], episodeIds: [], source: 'D:/Fixture/one.mp4', destination: '', relativePath: 'one.mp4', size: 10, state: 'present', action: 'none' }],
  collisions: [], warnings: ['尚未选择物理目标；可以仅逻辑合并'], canMerge: true, canOrganize: false
}
const journal = {
  id: 'journal', kind: 'organize', mode: 'physical', status: 'partial', survivorId: 'one', sourceIds: ['one', 'two'], createdAt: 1, updatedAt: 2,
  targetDirectory: 'E:/Fixture/one', files: [{ ...preview.files[0], status: 'failed', error: '文件离线', attempts: 1, sha256: '', originalRetained: true }],
  warnings: [], conflicts: [], canRetry: true, canRollback: true
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function harness(initialWorks = works) {
  const calls: any[][] = []
  const privateHidden = Vue.ref(false), selected = Vue.ref(initialWorks), ready = Vue.ref(true)
  const api = {
    preview: async (request: any) => { calls.push(['preview', request]); return { ...structuredClone(preview), request } },
    apply: async (request: any) => { calls.push(['apply', request]); return structuredClone(journal) },
    retry: async (id: string) => { calls.push(['retry', id]); return { ...structuredClone(journal), status: 'applied', canRetry: false } },
    rollback: async (id: string) => { calls.push(['rollback', id]); return { ...structuredClone(journal), status: 'rollback-partial', conflicts: ['后续笔记已更改，保留用户修改'], canRetry: false } },
    list: async (id?: string) => { calls.push(['list', id]); return [structuredClone(journal), { ...structuredClone(journal), id: 'private', sourceIds: ['one', 'secret'], targetDirectory: 'D:/Private/secret-name' }] },
    previewRelocate: async (request: any) => { calls.push(['previewRelocate', request]); return { kind: 'relocate', request, fingerprint: 'relocate-1', resourceId: 'one', name: '作品 one', sourceDirectory: 'D:/Fixture/one', targetDirectory: request.directory, root: 'E:/Fixture', bundleId: 'bundle', directories: ['Subs'], files: [], collisions: [], warnings: [], canApply: true } },
    relocate: async (request: any) => { calls.push(['relocate', request]); return { ...structuredClone(journal), kind: 'relocate', mode: request.preview.request.mode } },
    pickDirectory: async (): Promise<string | null> => { calls.push(['pickDirectory']); return 'E:/Fixture/one' }
  }
  const get = async (id: string) => privateHidden.value && id === 'secret' ? null : work(id, id === 'secret' ? '里番' : '其他')
  const module = createRendererLoader({ vue: Vue }, { window: { baoyi: { videoOrganize: api, video: { get } } }, setTimeout, clearTimeout })(file)
  const scope = Vue.effectScope()
  const session = scope.run(() => module.useOrganizeSession({ works: () => selected.value, resourceId: 'one', privacyReady: () => ready.value, privateHidden: () => privateHidden.value }))
  return { session, api, calls, selected, ready, privateHidden, close: () => { session.dispose(); scope.stop() } }
}
let passed = 0, failed = 0
for (const suffix of [' LEVEL：', ' ＃', ' ']) {
  const h = harness([1, 2].map(number => ({ ...work(String(number)), name_zh: '示例作品' + suffix + number })))
  try { assert.equal(h.session.collectionTitle.value, '示例作品'); passed++ }
  catch (cause) { failed++; console.error('FAIL default collection name ' + suffix + ': ' + String(cause)) }
  finally { h.close() }
}
async function test(name: string, run: (h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness()
  try { await run(h); passed++ }
  catch (cause) { failed++; console.error('FAIL ' + name + ': ' + (cause instanceof Error ? cause.message : cause)) }
  finally { h.close() }
}
await test('打开会话不请求预览、历史、目录选择或写操作', async h => {
  await Vue.nextTick()
  assert.deepEqual(h.calls, [])
  assert.equal(await h.session.apply('logical'), null)
  assert.deepEqual(h.calls, [])
})
await test('可逻辑合并与可物理整理独立，不把无目标目录当成无法合并', async h => {
  await h.session.previewChanges('organize')
  assert.equal(await h.session.apply('physical'), null)
  assert.ok(await h.session.apply('logical'))
  assert.equal(h.calls.filter(c => c[0] === 'apply').length, 1)
  assert.equal(h.calls.at(-1)?.[1].mode, 'logical')
  assert.equal(h.calls.at(-1)?.[1].preview.fingerprint, 'snapshot-1')
  assert.equal(Vue.isProxy(h.calls.at(-1)?.[1].preview), false, 'IPC receives a serializable snapshot')
})
await test('主作品、目录和文件名变化后必须重新预览，编号不自动更改', async h => {
  await h.session.previewChanges('organize')
  h.session.survivorId.value = 'two'
  h.session.copyFiles.value = true
  h.session.targetDirectory.value = 'E:/Fixture/two'
  h.session.fileNames.value = { file: '手动保留名称.mp4' }
  await Vue.nextTick()
  assert.equal(await h.session.apply('logical'), null)
  assert.equal(h.calls.length, 1)
  await h.session.previewChanges('organize')
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1)?.[1])), { resourceIds: ['one', 'two'], survivorId: 'two', collectionTitle: '作品 one', transfer: 'copy', targetDirectory: 'E:/Fixture/two', fileNames: { file: '手动保留名称.mp4' } })
})
await test('成功执行后的库变更通知不会把成功结果标成需要重新预览', async h => {
  h.api.apply = async request => {
    h.calls.push(['apply', request])
    h.session.invalidate()
    return { ...structuredClone(journal), status: 'applied' }
  }
  await h.session.previewChanges('organize')
  assert.equal((await h.session.apply('logical'))?.status, 'applied')
  h.session.invalidate()
  assert.equal(h.session.notice.value, '')
  assert.equal(h.session.preview.value, null)
  assert.equal(await h.session.apply('logical'), null)
  assert.equal(h.calls.filter(c => c[0] === 'apply').length, 1)
})
await test('资料或磁盘变化导致的陈旧预览错误可见，不能自动重试写入', async h => {
  h.api.apply = async request => { h.calls.push(['apply', request]); throw new Error('资料或实际路径已变化，请重新预览') }
  await h.session.previewChanges('organize')
  assert.equal(await h.session.apply('logical'), null)
  assert.match(h.session.error.value, /重新预览/)
  assert.equal(h.session.stale.value, true)
  await h.session.apply('logical')
  assert.equal(h.calls.filter(c => c[0] === 'apply').length, 1)
})
await test('取消预览后的迟到响应不能恢复面板内容', async h => {
  const pending = deferred<any>()
  h.api.preview = () => pending.promise
  const requested = h.session.previewChanges('organize')
  h.session.dispose()
  pending.resolve(structuredClone(preview))
  await requested
  assert.equal(h.session.preview.value, null)
})
await test('历史逐项结果、重试与回退只在显式调用后执行', async h => {
  await h.session.refreshHistory()
  assert.equal(h.session.journals.value[0].files[0].error, '文件离线')
  assert.equal(h.calls.filter(c => ['retry', 'rollback'].includes(c[0])).length, 0)
  await h.session.retry('journal')
  assert.equal(h.session.journals.value.find((j: any) => j.id === 'journal').canRetry, false)
  await h.session.retry('journal')
  assert.equal(h.calls.filter(c => c[0] === 'retry').length, 1)
  await h.session.rollback('journal')
  assert.match(h.session.journals.value.find((j: any) => j.id === 'journal').conflicts[0], /用户修改/)
})
await test('隐藏设置过滤涉及任一隐藏作品的历史与计数，切换立即清空旧记录', async h => {
  await h.session.refreshHistory()
  h.privateHidden.value = true
  await Vue.nextTick()
  assert.equal(h.session.journals.value.length, 0)
  await h.session.refreshHistory()
  assert.equal(h.session.journals.value.length, 1)
  assert.equal(h.session.journals.value[0].id, 'journal')
  assert.ok(!JSON.stringify(h.session.journals.value).includes('secret-name'))
})
await test('隐私开关与未返回的预览竞态不泄露名称、路径或错误', async h => {
  const pending = deferred<any>()
  h.api.preview = () => pending.promise
  const requested = h.session.previewChanges('organize')
  h.privateHidden.value = true
  pending.resolve(structuredClone(preview))
  await requested
  assert.equal(h.session.preview.value, null)
  assert.equal(h.session.journals.value.length, 0)
})
await test('重新绑定与复制目录使用各自的完整预览，切换模式使快照失效', async h => {
  h.session.targetDirectory.value = 'E:/Fixture/one'
  await h.session.previewChanges('relocate')
  assert.equal(h.calls.at(-1)?.[1].mode, 'rebind')
  h.session.relocateMode.value = 'copy'
  assert.equal(await h.session.relocate(), null)
  await h.session.previewChanges('relocate')
  await h.session.relocate()
  assert.equal(h.calls.at(-1)?.[1].preview.request.mode, 'copy')
})
await test('重复应用互斥，执行期间更改隐私也不恢复敏感结果', async h => {
  const pending = deferred<any>()
  h.api.apply = request => { h.calls.push(['apply', request]); return pending.promise }
  await h.session.previewChanges('organize')
  const applying = h.session.apply('logical')
  await h.session.apply('logical')
  assert.equal(h.calls.filter(c => c[0] === 'apply').length, 1)
  h.privateHidden.value = true
  pending.resolve(structuredClone(journal))
  await applying
  assert.equal(h.session.journals.value.length, 0)
})
console.log(`视频整理 UI 状态：${passed} 通过 / ${failed} 失败`)
if (failed) process.exitCode = 1
