/** Real reader setup: late IPC responses must stay with their document. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

const settle = async () => { for (let i = 0; i < 20; i++) await Vue.nextTick() }
function deferred() {
  let resolve!: (value: any) => void
  const promise = new Promise<any>(yes => { resolve = yes })
  return { promise, resolve }
}
const document = (id: string) => ({ id, name: id, format: 'txt', available: true, position: { page: 1, offset: id === 'A' ? 0.7 : 0.2 }, pageCount: 3 })
function fixture(overrides: Record<string, any> = {}, query: Record<string, string> = {}, id = 'A') {
  const scope = Vue.effectScope(), unmount: (() => void)[] = [], guards: (() => Promise<unknown>)[] = []
  const props = Vue.reactive({ id }), route = Vue.reactive({ query }), reads: string[] = []
  const api = {
    get: async (id: string) => document(id),
    annotations: async (id: string) => [{ id: id + '-note' }],
    content: async (id: string) => { reads.push(id); return { format: 'txt', text: id } },
    position: async () => {}, annotate: async () => {}, ...overrides
  }
  const load = createRendererLoader({
    vue: { ...Vue, onMounted: (fn: () => void) => fn(), onBeforeUnmount: (fn: () => void) => unmount.push(fn) },
    'vue-router': { useRoute: () => route, useRouter: () => ({}), onBeforeRouteLeave: (fn: () => Promise<unknown>) => guards.push(fn), onBeforeRouteUpdate: () => {} },
    '@/styles/workspace.css': {}
  }, { document: {addEventListener(){},removeEventListener(){}}, window: { baoyi: { archive:{onEvent:()=>()=>{}},project:{onChanged:()=>()=>{}},workspace: { preferences:{get:async()=>({fontSize:21,pdfZoom:1})}, documents: api, links:{projectReferences:async()=>[]},onChanged:()=>()=>{} } } }, confirm: () => true, setTimeout, clearTimeout })
  const state = scope.run(() => load('src/pages/document/Reader.vue').default.setup(props, { expose() {} }))
  return { props, state, guards, reads, dispose() { unmount.forEach(fn => fn()); scope.stop() } }
}

test('重建阅读页后，旧标注响应不进入新资料，也不继续读取旧正文', async () => {
  const slow = deferred(), old = fixture({ annotations: () => slow.promise })
  await settle(); old.dispose()
  const f = fixture({}, {}, 'B')
  try {
    await settle()
    slow.resolve([{ id: 'A-note' }]); await settle()
    assert.equal(f.state.item.value.id, 'B')
    assert.equal(f.state.annotations.value[0].id, 'B-note')
    assert.equal(f.state.position.value.offset, 0.2)
    assert.deepEqual(f.reads, ['B'])
    assert.deepEqual(old.reads, [])
  } finally { f.dispose() }
})

test('unmounted reader ignores late annotations', async () => {
  const slow = deferred(), f = fixture({ annotations: () => slow.promise })
  await settle(); f.dispose(); slow.resolve([{ id: 'A-note' }]); await settle()
  assert.equal(f.state.annotations.value.length, 0)
  assert.equal(f.reads.length, 0)
})

test('source offset zero is not replaced with the last reading offset', async () => {
  const f = fixture({}, { page: '2', offset: '0' })
  try { await settle(); assert.equal(f.state.initial.value.page, 2); assert.equal(f.state.initial.value.offset, 0); assert.equal(f.state.readerSettings.value.fontSize, 21) }
  finally { f.dispose() }
})

test('reader keeps the current route until an annotation write finishes', async () => {
  const slow = deferred(), f = fixture({ annotate: () => slow.promise })
  try {
    await settle()
    f.state.editing.value = { kind: 'excerpt', quote: 'source', note: '', location: { page: 1, offset: 0 } }
    const save = f.state.saveAnnotation()
    assert.equal(await f.guards[0](), false)
    slow.resolve({}); await save
    assert.notEqual(await f.guards[0](), false)
  } finally { f.dispose() }
})
