import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

const calls: string[] = []
const progressListeners = new Set<(progress: any) => void>()
let downloadResult: any = null
let resolveDownload: ((value: any) => void) | null = null
const api = {
  downloadSources: async (id: string) => { calls.push('sources:' + id); return {
    resourceId: id, videoCode: '123', title: '站点标题', pageUrl: 'https://hanime1.me/watch?v=123', warnings: [],
    sources: [{ id: 'source-1', label: '1080p', extension: 'mp4' }]
  } },
  download: (request: any) => {
    calls.push('download:' + request.requestId)
    // The renderer must subscribe before this call returns/starts emitting.
    assert.equal(progressListeners.size, 1, '发起下载前必须先订阅进度')
    return new Promise(resolve => { resolveDownload = resolve })
  },
  cancelDownload: async (requestId: string) => { calls.push('cancel:' + requestId); return { ok: true } },
  onDownloadProgress: (cb: (progress: any) => void) => { progressListeners.add(cb); return () => progressListeners.delete(cb) },
  revealDownload: async (requestId: string) => { calls.push('reveal:' + requestId); return true }
}
const load = createRendererLoader({
  vue: Vue,
  '@/composables/useTaskCenter': { useTaskCenter: () => ({
    start: () => 'task-download', update: () => {}, log: () => {}, finish: () => {}
  }) }
}, { window: { baoyi: { video: api } }, console: { info: () => {}, warn: () => {}, error: () => {} } })
const composable: any = (() => {
  try { return load('src/composables/useVideoDownload.ts') }
  catch (e: any) { if (e.code !== 'ENOENT') throw e; return {} }
})()
assert.equal(typeof composable.useVideoDownload, 'function', '缺少视频下载 renderer 单例（预期的 RED）')
const first: any = composable.useVideoDownload('v1')
await first.resolve()
assert.equal(first.catalog.value.title, '站点标题')
const run = first.download('source-1')
assert.deepEqual(calls.slice(0, 2), ['sources:v1', 'download:download-1'])
progressListeners.forEach(cb => cb({ requestId: 'other', resourceId: 'v1', phase: 'downloading', receivedBytes: 99, totalBytes: 100, bytesPerSecond: 1, message: '错误任务' }))
assert.equal(first.progress.value.receivedBytes, 0, '其他请求的进度不能污染当前任务')
progressListeners.forEach(cb => cb({ requestId: 'download-1', resourceId: 'v1', phase: 'downloading', receivedBytes: 50, totalBytes: 100, bytesPerSecond: 10, message: '正在下载' }))
assert.equal(first.progress.value.receivedBytes, 50)
assert.equal((await first.cancel()).ok, true)
assert.equal(calls.at(-1), 'cancel:download-1')
;(resolveDownload as any)?.({ requestId: 'download-1', resourceId: 'v1', status: 'cancelled', path: '', message: '已取消', receivedBytes: 50, totalBytes: 100, bytesPerSecond: 10, warnings: [] })
downloadResult = await run
assert.equal(downloadResult.status, 'cancelled')
assert.equal(first.running.value, false, '必须等下载 Promise 收尾后再释放运行状态')
assert.equal(progressListeners.size, 0, '下载完成后必须清理进度监听')

const second: any = composable.useVideoDownload('v1')
assert.equal(second.catalog.value.title, '站点标题', '同一资源的状态必须跨组件共享')
console.log('视频下载 renderer 回归：通过')
