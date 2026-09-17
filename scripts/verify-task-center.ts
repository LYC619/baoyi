import assert from 'node:assert/strict'
import { useTaskCenter } from '../src/composables/useTaskCenter.ts'

const originalInfo = console.info
const consoleMessages: string[] = []
console.info = (...args: unknown[]) => { consoleMessages.push(args.join(' ')) }
const center = useTaskCenter()
const assertEvent = (taskId: string, text: string): void => {
  const task = center.tasks.value.find((item) => item.id === taskId)
  assert.ok(task, `task ${taskId} should exist`)
  assert.ok(task.events.some((event) => event.message.includes(text)), `missing event: ${text}`)
}

const scanId = center.start('software-scan', '软件扫描', { total: 4, current: 'D:\\Library' })
assert.equal(center.tasks.value[0]?.status, 'running')
assert.equal(center.runningCount.value, 1)
center.update(scanId, { processed: 2, total: 4, current: 'D:\\Library\\tool', message: '正在读取文件信息' }, { level: 'info', message: '正在读取文件信息' })
const scan = center.tasks.value.find((item) => item.id === scanId)
assert.equal(scan?.processed, 2)
assert.equal(scan?.percent, 50)
assert.equal(scan?.current, 'D:\\Library\\tool')
assertEvent(scanId, '正在读取文件信息')
assert.ok(consoleMessages.some(message => message.includes('[task:software-scan]') && message.includes('正在读取文件信息')), 'progress events must also reach the console log')
const eventCount = scan?.events.length
const outputCount = consoleMessages.length
center.update(scanId, { processed: 2 }, { level: 'info', message: '  正在读取文件信息  ' })
assert.equal(center.tasks.value.find(item => item.id === scanId)?.events.length, eventCount, 'duplicate progress must not grow the event list')
assert.equal(consoleMessages.length, outputCount, 'duplicate progress must not grow the console log')
center.finish(scanId, 'success', '扫描完成：发现 4 个程序')
assert.equal(center.runningCount.value, 0)
assert.equal(center.tasks.value.find((item) => item.id === scanId)?.status, 'success')
assertEvent(scanId, '扫描完成')

// 结束任务收到迟到 update 时不得复活或改写最终状态。
center.update(scanId, { processed: 999, message: '迟到进度' }, { level: 'warn', message: '迟到进度' })
const ended = center.tasks.value.find((item) => item.id === scanId)
assert.equal(ended?.status, 'success')
assert.equal(ended?.processed, 2)

const failedId = center.start('ai-identify', 'AI 识别', { total: 3 })
center.finish(failedId, 'failed', '识别失败', '连接模型服务超时')
const failed = center.tasks.value.find((item) => item.id === failedId)
assert.equal(failed?.error, '连接模型服务超时')
assert.equal(center.failedCount.value, 1)
assertEvent(failedId, '连接模型服务超时')

const cancelledId = center.start('video-scan', '影视扫描')
center.finish(cancelledId, 'cancelled', '用户停止，已保留已完成结果')
assert.equal(center.tasks.value.find((item) => item.id === cancelledId)?.status, 'cancelled')

const firstRunning = center.start('game-scan', '游戏扫描')
const secondRunning = center.start('organize', '整理软件')
assert.equal(center.runningCount.value, 2)
center.clearFinished()
assert.equal(center.tasks.value.some((item) => item.id === scanId), false)
assert.equal(center.tasks.value.some((item) => item.id === firstRunning), true)
assert.equal(center.tasks.value.some((item) => item.id === secondRunning), true)
center.finish(firstRunning, 'success', '完成')
center.finish(secondRunning, 'success', '完成')

const longRunning = center.start('video-scan', '长时间运行')
for (let i = 0; i < 35; i++) {
  const id = center.start('hanime-verify', `验证 ${i}`)
  center.finish(id, 'success', '验证完成')
}
assert.ok(center.history.value.length <= 30)
assert.equal(center.tasks.value.length, 31)
assert.equal(center.runningTasks.value[0]?.id, longRunning)
center.finish(longRunning, 'success', '长任务完成')
assert.equal(center.history.value.length, 30)
assert.equal(center.history.value[0]?.id, longRunning)
assert.equal(center.tasks.value.some((item) => item.title === '验证 0'), false)

const eventId = center.start('hanime-verify', '事件上限')
for (let i = 0; i < 130; i++) {
  center.log(eventId, 'info', `事件 ${i}`)
}
const eventTask = center.tasks.value.find((item) => item.id === eventId)
assert.equal(eventTask?.events.length, 100)
assert.equal(eventTask?.events.at(-1)?.message, '事件 129')
assert.equal(consoleMessages.filter(message => /\[task:hanime-verify\] 事件 \d+$/.test(message)).length, 130, 'console retains all events even when the panel is capped')
const logCount = consoleMessages.length
center.log(eventId, 'info', '事件 129')
assert.equal(consoleMessages.length, logCount, 'identical log messages are deduplicated at both outputs')
center.finish(eventId, 'success', '完成')


center.clearFinished()
assert.equal(center.tasks.value.length, 0)
console.info = originalInfo
console.log('Task center regression: passed')
