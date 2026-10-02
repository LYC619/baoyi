import assert from 'node:assert/strict'

const { createTransferMeter, normalizeDownloadProgress } = await import('../electron/kinds/image/download-progress.ts')
let now = 0
const meter = createTransferMeter(() => now)
meter.add(1024)
assert.equal(meter.speed(), 0, '没有足够采样时间不显示虚构速度')
now = 1000
assert.equal(meter.speed(), 1024)
meter.add(1024)
now = 2000
assert.equal(meter.speed(), 1024)
now = 5001
assert.equal(meter.speed(), 0, '停止接收后速度应归零')
assert.throws(() => meter.add(-1))
assert.throws(() => meter.add(Infinity))
const defaults = normalizeDownloadProgress()
assert.equal(defaults.totalKnown, false)
assert.equal(defaults.receivedBytes, 0)
assert.equal(defaults.bytesPerSecond, 0)
const bad = normalizeDownloadProgress({ storedBytes: -5, receivedBytes: Infinity, phase: 'bad', totalKnown: 'yes' } as any)
assert.equal(bad.storedBytes, 0)
assert.equal(bad.receivedBytes, 0)
assert.equal(bad.phase, 'queued')
assert.equal(bad.totalKnown, false)
console.log('PASS 滚动速度窗口、空闲归零、启动采样与历史进度规范化')
