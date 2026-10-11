import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

// Backend business failures must stay selected for retry, not be counted as successful removals.
const scope = Vue.effectScope()
const errors: string[] = [], done: string[][] = []
const props = Vue.reactive({ kind: 'software', items: [{ id: 'one', name: 'Tool' }], ids: ['one'], categories: [] })
const load = createRendererLoader({ vue: { ...Vue, onBeforeUnmount() {} }, 'vue-router': { onBeforeRouteLeave() {} },
  '@/composables/useToast': { useToast: () => ({ toast: (s: string) => errors.push(s) }) }
}, { window: { baoyi: { software: { remove: async () => ({ ok: false, message: '链接被占用' }) } } } })
const panel = scope.run(() => load('src/components/library/LibraryBulkPanel.vue').default.setup(props, {
  expose() {}, emit: (name: string, ids: string[]) => { if (name === 'completed') done.push(ids) }
}))
panel.action.value = 'remove'; await Vue.nextTick()
await panel.apply(); await panel.apply()
assert.equal(panel.succeeded.value, 0)
assert.deepEqual(Array.from(panel.failures.value, (x: any) => x.message), ['链接被占用'])
assert.deepEqual(Array.from(done[0]), ['one'])
scope.stop()
console.log('PASS software removal failure remains selected for retry')

{
  const scope = Vue.effectScope(), writes: unknown[] = []
  let accepted = false, previews = 0
  const props = Vue.reactive({ kind: 'software', items: [{ id: 'one', name: 'Tool' }], ids: ['one'], categories: ['AI'] })
  const api = {
    software: { get: async () => ({ id: 'one', tags: [] }), update: async (...args: unknown[]) => { writes.push(args); return {} } },
    organize: {
      organized: async () => ({ entries: [{ software_id: 'one', name: 'Tool', folder_category: 'Old', folder: 'Tool' }] }),
      previewRelocate: async () => { previews++; return { ok: true, from: 'C:/Library/Old/Tool', to: 'C:/Library/AI/Tool', category: 'AI', folder: 'Tool', is_link: false } },
      relocate: async (...args: unknown[]) => { writes.push(args); return { ok: true } }
    }
  }
  const load = createRendererLoader({ vue: Vue, 'vue-router': { onBeforeRouteLeave() {} }, '@/composables/useToast': { useToast: () => ({ toast() {} }) } }, { window: { baoyi: api, confirm: () => accepted } })
  const panel = scope.run(() => load('src/components/library/LibraryBulkPanel.vue').default.setup(props, { expose() {}, emit() {} }))
  panel.value.value = 'AI'; await panel.apply()
  assert.equal(previews, 1); assert.equal(writes.length, 0, 'cancelled preview cannot mutate paths or category')
  accepted = true; await panel.apply()
  assert.equal(previews, 2); assert.equal(writes.length, 1)
  assert.deepEqual(Array.from(writes[0] as string[]), ['one', 'AI', 'Tool', 'C:/Library/Old/Tool'])
  assert.equal(panel.succeeded.value, 1)
  scope.stop()
}
console.log('PASS bulk category change previews, cancellation writes nothing, confirmation relocates')
