import assert from 'node:assert/strict'
import { ref } from 'vue'
import { useTaskCenter } from '../src/composables/useTaskCenter.ts'

const all = useTaskCenter()
const module = ref<'software' | 'game' | 'video' | 'image'>('software')
const scoped = (useTaskCenter as any)(() => module.value) as ReturnType<typeof useTaskCenter>
const software = all.start('ai-identify', 'Software failure')
all.finish(software, 'failed', 'Connection failed')
const game = all.start('game-scan', 'Game scan')
const video = all.start('video-scan', 'Video scan')
all.finish(video, 'interrupted', 'Interrupted')
const organize = all.start('organize', 'Software organize')

assert.deepEqual(scoped.runningTasks.value.map(t => t.id), [organize], 'software log must exclude game/video tasks')
assert.equal(scoped.attentionCount.value, 1)
module.value = 'image'
assert.equal(scoped.runningCount.value, 0)
assert.equal(scoped.history.value.length, 0)
module.value = 'game'
assert.deepEqual(scoped.runningTasks.value.map(t => t.id), [game])
module.value = 'video'
assert.deepEqual(scoped.history.value.map(t => t.id), [video])
scoped.setVideoHidden(true)
assert.equal(scoped.history.value.length, 0)
scoped.setVideoHidden(false)
await scoped.clearFinished()
assert.ok(all.tasks.value.some(t => t.id === software), 'clearing video must preserve software history')
assert.ok(!all.tasks.value.some(t => t.id === video))
assert.ok(all.tasks.value.some(t => t.id === game), 'running tasks must survive clear')
module.value = 'software'
assert.equal(scoped.failedCount.value, 1)
await scoped.clearFinished()
assert.equal(scoped.failedCount.value, 0)
assert.ok(all.tasks.value.some(t => t.id === organize))
console.log('PASS: reactive module scope, counts, privacy and scoped clear')
