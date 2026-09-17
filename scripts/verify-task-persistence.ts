import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import type { TaskRecord } from '../src/types'

let passed = 0, failed = 0
async function test(name: string, save: (task: TaskRecord) => Promise<boolean>) {
  const load = createRendererLoader({ vue: Vue }, {
    window: { baoyi: { tasks: { list: async () => [], save } } },
    console: { ...console, info: () => {} }
  })
  try {
    const center = load('src/composables/useTaskCenter.ts').useTaskCenter()
    const id = center.start('game-cover', '查找游戏封面')
    center.update(id, { processed: 1, total: 2 }, { level: 'info', message: '已找到候选' })
    center.log(id, 'info', '图片已缓存')
    center.finish(id, 'success', '封面已准备好')
    await Promise.resolve()
    assert.equal(center.tasks.value.find((task: TaskRecord) => task.id === id)?.status, 'success')
    passed++
  } catch (error) { failed++; console.error('FAIL', name, error) }
}

const saved: TaskRecord[] = []
await test('progress and events cross a structured-clone boundary', task => {
  saved.push(structuredClone(task))
  return Promise.resolve(true)
})
if (saved.at(-1)?.status !== 'success' || !saved.at(-1)?.events.some(event => event.message === '图片已缓存')) {
  failed++; console.error('FAIL persisted snapshots must include the final state and event history')
}
await test('synchronous persistence failure does not interrupt the user action', () => { throw new Error('bridge unavailable') })
await test('asynchronous persistence failure does not interrupt the user action', async () => { throw new Error('database unavailable') })
console.log(`Task persistence: ${passed} passed / ${failed} failed`)
if (failed) process.exitCode = 1
