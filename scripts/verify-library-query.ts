import assert from 'node:assert/strict'
import * as Vue from 'vue'
import * as Pinia from 'pinia'
import { createRendererLoader } from './helpers/renderer-harness.ts'

for (const kind of ['software', 'game', 'video']) {
  let respond: (query: any) => Promise<any[]> = async () => [{ id: 'old' }]
  const settings = { useSettingsStore: () => ({ settings: { unused_days: 60 } }) }
  const loader = createRendererLoader({ vue: Vue, pinia: Pinia, './settings': settings, '@/stores/settings': settings, '@/composables/useToast': { useToast: () => ({ error() {} }) } },
    { window: { baoyi: { [kind]: { list: (query: any) => respond(query) } } } })
  Pinia.setActivePinia(Pinia.createPinia())
  const store = loader('src/stores/' + kind + '.ts')[kind === 'software' ? 'useSoftwareStore' : kind === 'game' ? 'useGameStore' : 'useVideoStore']()
  assert.equal(store.queryPending, true)
  await store.load(); assert.equal(store.queryPending, false)
  store.keyword = 'new'; assert.equal(store.queryPending, true, '输入后、防抖请求前也不能批量处理旧结果')
  let release!: (items: any[]) => void
  respond = () => new Promise(resolve => { release = resolve })
  const loading = store.load(); await Vue.nextTick()
  store.keyword = 'newer'; release([{ id: 'new' }]); await loading
  assert.equal(store.queryPending, true, '旧响应不能解锁新查询的操作')
  respond = async () => { throw new Error('network failure') }
  await store.load(); assert.equal(store.queryPending, true)
  respond = async () => [{ id: 'newer' }]
  await store.load(); assert.equal(store.queryPending, false)
  assert.equal(store.items[0].id, 'newer')
  if (kind === 'video') {
    respond = async () => { throw new Error('same-query refresh failed') }
    await store.load(); assert.equal(store.queryPending, true, 'same-query failure stays locked')
    respond = async () => [{id:'B'}]
    await store.load(); assert.equal(store.queryPending, false)
    for (const selection of [{kind:'category',value:'课程'},{kind:'tag',value:'test'},{kind:'collection',value:'group'},{kind:'type',value:'audio'},{kind:'type',value:'movie'}]) {
      store.select(selection); assert.equal(store.queryPending, true); await store.load(); assert.equal(store.queryPending, false)
    }
  }
}
console.log('PASS software/game/video query boundary: debounce, delayed response, failure and recovery')

// Exercise the real panel handlers even when a caller bypasses disabled buttons.
{
  const scope = Vue.effectScope(), writes: any[] = [], events: any[] = []
  const props = Vue.reactive({ ids: ['A', 'B'], groups: [], pending: true })
  const loader = createRendererLoader({ vue: Vue, 'vue-router': { onBeforeRouteLeave() {} }, '@/composables/useToast': { useToast: () => ({ toast() {} }) } }, { window: { baoyi: { video: { bulkUpdate: async (ids: string[], patch: any) => { writes.push({ids,patch}); return ids.length } } } } })
  const panel = scope.run(() => loader('src/components/video/VideoBulkPanel.vue').default.setup(props, { expose() {}, emit: (...args: any[]) => events.push(args) }))
  panel.tags.value = 'test'
  for (const action of ['add', 'remove', 'group']) await panel.save(action)
  panel.requestRemove(); assert.equal(writes.length, 0); assert.equal(events.length, 0)
  props.pending = false; props.ids = ['B']; await panel.save('add')
  assert.equal(JSON.stringify(writes[0].ids), '["B"]'); scope.stop()
}
console.log('PASS real video bulk handlers reject pending writes/removal and pin current IDs')

// Load the actual Home SFC too: non-button callers and local visibility changes.
{
  const scope = Vue.effectScope(), calls: any[] = []
  const store = Vue.reactive<any>({ items: [{ id: 'A', category: '电影', episode_total: 1 }, { id: 'B', category: '电影', episode_total: 1 }],
    queryPending: true, querySignature: 'all', selection: { kind: 'group', value: 'all' }, keyword: '', missingPosters: [], counts: {}, reload: async () => {} })
  const view = Vue.reactive({ compact: false, pendingOnly: false, issue: 'any' })
  const hideHentai = Vue.ref(false), privacyReady = Vue.ref(true)
  const loader = createRendererLoader({
    vue: { ...Vue, onMounted() {}, onBeforeUnmount() {} },
    'vue-router': { useRouter: () => ({ push() {} }) },
    '@/stores/video': { useVideoStore: () => store },
    '@/stores/settings': { useSettingsStore: () => ({ settings: {} }) },
    '@/composables/useModules': { recallScroll() {}, rememberScroll() {} },
    '@/composables/useToast': { useToast: () => ({ toast() {}, success() {}, error() {} }) },
    '@/composables/useMediaScan': { useMediaScan: () => ({ running: Vue.ref(false), stopping: Vue.ref(false), progress: Vue.ref(null) }), reidentifyVideo: async () => calls.push('review') },
    '@/composables/useVideoImport': { useVideoImport: () => ({ busy: Vue.ref(false) }) },
    '@/composables/useVideoAgentOrganize': { useVideoAgentOrganize: () => ({ show: (works: any) => calls.push(works) }) },
    '@/composables/useVideoWorkflow': { videoLibraryView: view, useVideoWorkflow: () => ({ privacyReady, hideHentai, jobs: Vue.ref([]) }), videoJobRetryStages: () => [] }
  }, { window: { baoyi: { video: { readiness: async () => { calls.push('readiness'); return { ok: true } } } } }, setTimeout, clearTimeout })
  const home = scope.run(() => loader('src/pages/video/Home.vue').default.setup({}, { expose() {} }))
  home.selecting.value = true; home.selectedIds.value = ['A', 'B']
  home.selectWork('A'); home.selectAll(); home.organize('organize'); home.requestRemoval(); home.requestLayout(); home.requestAgent(); home.selectReview(); await home.reviewSelected()
  assert.equal(JSON.stringify(home.selectedIds.value), '["A","B"]')
  assert.equal(home.organizeMode.value, ''); assert.equal(home.removing.value, false); assert.equal(home.layoutIds.value, null); assert.equal(calls.length, 0)
  store.querySignature = 'B'; assert.equal(home.selectedIds.value.length, 0, 'query change clears old selection synchronously')
  store.queryPending = false; store.items = [store.items[1]]; home.selectWork('A'); assert.equal(home.selectedIds.value.length, 0)
  home.selectWork('B'); assert.equal(home.selectedIds.value[0], 'B')
  view.pendingOnly = true; assert.equal(home.selectedIds.value.length, 0)
  home.selectedIds.value = ['B']; home.selectionAnchor.value = 'B'; hideHentai.value = true
  assert.equal(home.selectedIds.value.length, 0); assert.equal(home.selectionAnchor.value, '')
  store.queryPending = true; home.toggleSelecting(); assert.equal(home.selecting.value, false, 'pending queries still allow exit')
  scope.stop()
}
console.log('PASS actual video Home: all direct bulk entry guards, scope/visibility clearing and pending exit')
