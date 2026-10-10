/** Actual image detail SFC: deterministic request and mutation ownership regressions. */
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

const settle = async () => { for (let i = 0; i < 20; i++) await Vue.nextTick() }
const deferred = () => {
  let resolve!: (value: any) => void, reject!: (error: Error) => void
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const make = (id: string) => ({ id, name: `相册 ${id}`, type: 'photo', tags: [], chapters: [], favorite: false })
function fixture(overrides: Record<string, any> = {}, read = false) {
  const scope = Vue.effectScope(), unmount: (() => void)[] = [], writes: any[] = [], opens: any[] = [], navigations: any[] = []
  const props = Vue.reactive({ id: 'A' }), route = Vue.reactive({ query: read ? { read: '1' } : {} })
  const api = {
    get: async (id: string) => make(id), pages: async (id: string) => [{ id: `${id}-page` }],
    update: async (id: string, value: any) => { writes.push({ id, value }); return { ...make(id), ...value } },
    move: async (ids: string[]) => { writes.push(ids); return { warnings: [] } },
    remove: async (id: string) => { writes.push(id) },
    rescan: async (id: string) => { writes.push(id) }, relocate: async (id: string) => { writes.push(id) },
    ...overrides
  }
  const loader = createRendererLoader({
    vue: { ...Vue, onUnmounted: (fn: () => void) => unmount.push(fn) },
    'vue-router': { useRoute: () => route, useRouter: () => ({ replace: async () => {}, push: async (to: string) => { navigations.push(to) } }) },
    '@/stores/image': { useImageStore: () => ({ refresh: async () => {}, groups: [] }) },
    '@/composables/useImageReader': { useImageReader: () => ({ session: Vue.ref(null), open: (...args: any[]) => opens.push(args) }) },
    '@/components/image/image.css': {}
  }, { window: { baoyi: { image: api } }, confirm: () => true })
  const state = scope.run(() => loader('src/pages/image/Detail.vue').default.setup(props, { expose() {} }))
  return { props, state, api, writes, opens, navigations, dispose() { unmount.forEach(fn => fn()); scope.stop() } }
}

for (const failure of [false, true]) {
  const slow = deferred(), f = fixture({ get: (id: string) => id === 'A' ? slow.promise : Promise.resolve(make(id)) }, true)
  f.props.id = 'B'; await settle()
  failure ? slow.reject(new Error('old failure')) : slow.resolve(make('A')); await settle()
  assert.equal(f.state.item.value.id, 'B', 'old response must not replace current item')
  assert.equal(f.state.pages.value[0].id, 'B-page')
  assert.equal(f.state.error.value, '')
  assert.equal(f.opens.length, 1, 'only current successful read=1 request opens reader')
  assert.equal(f.opens[0][0].id, 'B')
  await f.state.patch({ name: 'B edited' }); assert.equal(f.writes[0].id, 'B')
  f.dispose()
}
{
  const first = deferred(), second = deferred(); let count = 0
  const f = fixture({ get: (id: string) => id === 'A' ? (++count === 1 ? first.promise : second.promise) : Promise.resolve(make(id)) })
  f.props.id = 'B'; await settle(); f.props.id = 'A'; await settle()
  second.resolve({ ...make('A'), name: 'latest A' }); await settle(); first.resolve(make('A')); await settle()
  assert.equal(f.state.item.value.name, 'latest A', 'A/B/A must use request epoch')
  f.dispose()
}
{
  const slow = deferred(), f = fixture({ get: () => slow.promise })
  assert.equal(f.state.status.value, 'loading')
  await f.state.patch({ name: 'blocked' }); await f.state.move(); await f.state.remove(); await f.state.rescan()
  assert.equal(f.writes.length, 0, 'loading blocks dependency operations')
  f.dispose(); slow.resolve(make('A')); await settle()
  assert.equal(f.state.item.value, null, 'unmounted request cannot commit')
}
{
  const f = fixture({ get: async () => null }); await settle(); assert.equal(f.state.status.value, 'missing')
  await f.state.rescan(true); assert.equal(f.writes[0], 'A', 'missing state keeps relocation available'); f.dispose()
}
{
  const f = fixture({ get: async () => { throw new Error('read failed') } }); await settle()
  assert.equal(f.state.status.value, 'error'); assert.equal(f.state.error.value, 'read failed')
  f.api.get = async (id: string) => make(id); await f.state.load()
  assert.equal(f.state.status.value, 'ready'); assert.equal(f.state.error.value, ''); f.dispose()
}
for (const operation of ['patch', 'move', 'remove', 'rescan', 'relocate']) {
  const slow = deferred(), targets: any[] = [], f = fixture({
    [operation === 'patch' ? 'update' : operation]: (id: any) => { targets.push(id); return slow.promise }
  })
  await settle()
  const pending = operation === 'patch' ? f.state.patch({ name: 'old edit' }) : operation === 'relocate' ? f.state.rescan(true) : f.state[operation]()
  f.props.id = 'B'; await settle(); f.state.choosingCover.value = true
  slow.resolve(operation === 'patch' ? make('A') : { warnings: ['old warning'] }); await pending; await settle()
  assert.equal(JSON.stringify(targets[0]), JSON.stringify(operation === 'move' ? ['A'] : 'A'))
  assert.equal(f.state.item.value.id, 'B', `${operation} must not overwrite new route`)
  assert.equal(f.state.error.value, ''); assert.equal(f.state.busy.value, false)
  assert.equal(f.navigations.length, 0, `${operation} must not navigate new route`); f.dispose()
}
console.log('PASS image detail: stale success/error, A/B/A, unmount, loading, missing/recovery, retry, pinned writes and read=1')

for (const saved of ['{broken', 'null', '"invalid"', '{"grouping":"invalid","cardSize":"invalid"}']) {
  const scope = Vue.effectScope()
  const loader = createRendererLoader({ vue: Vue }, { localStorage: { getItem: () => saved, setItem() {} } })
  const view = scope.run(() => loader('src/composables/useLibraryView.ts').useLibraryView('image'))
  assert.equal(view.grouping.value, 'category'); assert.equal(view.cardSize.value, 150)
  scope.stop()
}
console.log('PASS malformed and invalid-shape library preferences fall back safely')
