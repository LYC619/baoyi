import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const { createImageRequestGate } = await import('../electron/kinds/image/request-gate.ts')
let active = 0, peak = 0, limit = 2
const gate = createImageRequestGate(() => limit)
const order: number[] = []
let release!: () => void
const held = new Promise<void>(resolve => { release = resolve })
const tasks = [1, 2, 3].map(id => gate.run(async () => {
  active++; peak = Math.max(peak, active); order.push(id)
  await held
  active--
}))
await delay(5)
assert.deepEqual(order, [1, 2])
release(); await Promise.all(tasks)
assert.equal(peak, 2)
assert.deepEqual(order, [1, 2, 3])

const starts: number[] = []
active = 0; peak = 0
gate.defer(70)
const before = Date.now()
await Promise.all([1, 2, 3].map(() => gate.run(async () => {
  starts.push(Date.now()); active++; peak = Math.max(peak, active)
  await delay(15); active--
})))
assert.ok(starts.every(time => time - before >= 60), '所有后续请求都应尊重共享退避')
assert.equal(peak, 1, '遇限流后本任务降至单路')
assert.equal(gate.concurrency(), 1)
gate.dispose()

const queuedGate = createImageRequestGate(() => 1)
let unblock!: () => void
const first = queuedGate.run(() => new Promise<void>(resolve => { unblock = resolve }))
await delay(1)
const controller = new AbortController()
const waiting = queuedGate.run(async () => assert.fail('取消的候选不得开始'), controller.signal)
controller.abort(new Error('paused'))
await assert.rejects(waiting, /paused/)
unblock(); await first
limit = 3
queuedGate.dispose()
console.log('PASS 图片请求并发上限、共享退避、降速与排队取消')
