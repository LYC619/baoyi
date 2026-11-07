import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('模型任务跨模块串行、排队任务可取消，失败后后续任务仍执行', async () => {
  assert.ok(fs.existsSync('electron/services/agent/queue.ts'), '需要共享模型任务队列')
  const { AgentQueue } = await import('../electron/services/agent/queue.ts')
  const queue = new AgentQueue(), events:string[] = [], cancel = new AbortController()
  let release!:()=>void
  const ready = new Promise<void>(resolve=>{release=resolve})
  const first = queue.run(async()=>{events.push('project');await ready;events.push('project-done')})
  const cancelled = queue.run(async()=>{events.push('cancelled')}, cancel.signal).catch(e=>e.message)
  const second = queue.run(async()=>{events.push('document');throw new Error('service-failure')}).catch(e=>e.message)
  const third = queue.run(async()=>{events.push('personal');return 42})
  await Promise.resolve(); assert.equal(queue.busy(),true); assert.deepEqual(events,['project'])
  cancel.abort();assert.match(await cancelled,/停止|取消/)
  release();await first;assert.equal(await second,'service-failure');assert.equal(await third,42)
  assert.deepEqual(events,['project','project-done','document','personal']);assert.equal(queue.busy(),false)
})
