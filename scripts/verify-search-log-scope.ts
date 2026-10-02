import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

const requests: Array<{ filter: any; resolve: (logs: any[]) => void; reject: (error: Error) => void }> = []
const mounts: Array<() => Promise<void>> = [], unmounts: Array<() => void> = []
const load = createRendererLoader({
  vue: { ...Vue, onMounted: (fn: () => Promise<void>) => mounts.push(fn), onBeforeUnmount: (fn: () => void) => unmounts.push(fn) }
}, { window: { baoyi: { logs: { list: (filter: any) => new Promise((resolve, reject) => requests.push({ filter, resolve, reject })) } } } })
const props = Vue.reactive({ limit: 20, resourceKind: 'software' })
const scope = Vue.effectScope()
const state = scope.run(() => load('src/components/identify/SearchCallLog.vue').default.setup(props, { expose: () => {} }))
const started = mounts[0]()
assert.equal(requests[0].filter.resource_kind, 'software')
props.resourceKind = 'video'; await Vue.nextTick()
assert.equal(requests[1].filter.resource_kind, 'video')
requests[1].resolve([]); await new Promise(resolve => setImmediate(resolve))
assert.equal(state.loading.value, false)
requests[0].reject(new Error('stale software failure')); await started
assert.equal(state.loadError.value, '', 'previous module must not overwrite current module state')
props.resourceKind = 'game'; await Vue.nextTick()
assert.equal(requests[2].filter.resource_kind, 'game')
assert.equal(state.loading.value, true)
unmounts.forEach(fn => fn()); scope.stop()
requests[2].reject(new Error('disposed failure')); await new Promise(resolve => setImmediate(resolve))
assert.equal(state.loadError.value, '')
console.log('PASS: search calls use module filter; stale and disposed responses cannot overwrite state')
