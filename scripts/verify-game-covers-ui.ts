/** Exercise actual SFC setup handlers with an isolated IPC boundary. */
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

let passed = 0
let failed = 0
function fixture(page: 'Home' | 'Detail') {
  const requests: unknown[][] = []
  const game = { id: 'one', name_en: 'Portal', name_zh: '', file_name: 'game.exe', source_dir: 'X:/fixture', cover_path: 'X:/cover.png', identity_name: 'Portal', identity_query: '', identity_confirmed: false, save_paths: [], linked_files: [], tags: [], total_playtime_sec: 0, last_played_at: 0, play_status: 'unplayed', updated_at: 1 }
  const store = Vue.reactive({
    items: [game, { ...game, id: 'two' }], keyword: '', sort: 'added', counts: { all: 2 }, selection: { kind: 'group' },
    staleSaves: new Map(), heading: '所有游戏', load: async () => {}, reload: async () => { requests.push(['reload']) },
    update: async (_id: string, patch: any) => ({ ...game, ...patch })
  })
  const taskState = Vue.ref<any[]>([])
  const api: any = {
    get: async (id: string) => ({ ...game, id }), pickCover: async () => null,
    searchCovers: async () => ({ ok: true, candidates: [], query: 'Portal', message: '' }),
    setCoverFromUrl: async (...args: unknown[]) => { requests.push(['set-cover', ...args]); return { ok: true, item: game, message: '' } },
    clearCover: async () => ({ ...game, cover_path: '' }),
    addManual: async () => { requests.push(['add-manual']); return { ok: true, item: game, message: '已登记' } },
    rebuildCovers: async (ids: string[]) => { requests.push(['rebuild', [...ids]]); return { processed: ids.length, updated: ids.length, failed: 0 } },
    onCoverProgress: () => () => {}, backups: async () => [], running: async () => false
  }
  const load = createRendererLoader({
    vue: { ...Vue, onMounted: () => {}, onBeforeUnmount: () => {} },
    'vue-router': { useRouter: () => ({ push: (route: unknown) => { requests.push(['route', route]) } }) },
    '@/stores/game': { useGameStore: () => store, PLAY_STATUS_LABEL: {} },
    '@/stores/settings': { useSettingsStore: () => ({ settings: { ai: { enabled: false, api_key: '' }, title_lang: 'en' } }) },
    '@/composables/useToast': { useToast: () => ({ error: () => {}, success: () => {}, toast: () => {} }) },
    '@/composables/useModules': { recallScroll: () => 0, rememberScroll: () => {} },
    '@/composables/useMediaScan': { useMediaScan: () => ({ running: Vue.ref(false), stopping: Vue.ref(false), progress: Vue.ref(null) }) },
    '@/composables/useTaskCenter': { useTaskCenter: () => ({
      runningTasks: taskState,
      start: (...args: unknown[]) => { requests.push(['task-start', ...args]); return 'task-fixture' },
      update: (...args: unknown[]) => { requests.push(['task-update', ...args]) },
      log: (...args: unknown[]) => { requests.push(['task-log', ...args]) },
      finish: (...args: unknown[]) => { requests.push(['task-finish', ...args]) }
    }) }
  }, { window: { baoyi: { game: api }, confirm: () => true }, setTimeout, clearTimeout })
  const component = load(`src/pages/game/${page}.vue`).default
  const state = component.setup({ id: 'one' }, { expose: () => {} })
  return { state, api, requests, store, taskState, game }
}

async function test(name: string, run: () => Promise<void>) {
  try { await run(); passed++ }
  catch (error) { failed++; console.error('FAIL', name, error instanceof Error ? error.message : error) }
}

await test('closing a pending cover search keeps late results closed', async () => {
  const h = fixture('Detail')
  await h.state.load()
  let release!: (result: unknown) => void
  h.api.searchCovers = () => new Promise(resolve => { release = resolve })
  const pending = h.state.searchCovers()
  h.state.closeCoverHits()
  release({ ok: true, query: 'Portal', message: '', candidates: [{ url: 'old', label: 'Old' }] })
  await pending
  assert.equal(h.state.coverHits.value.length, 0)
})

await test('a file dialog result for the previous game cannot replace the current detail', async () => {
  const h = fixture('Detail')
  await h.state.load()
  let release!: (result: unknown) => void
  h.api.pickCover = () => new Promise(resolve => { release = resolve })
  const pending = h.state.pickCover()
  h.state.item.value = { ...h.game, id: 'two' }
  release({ ok: true, item: { ...h.game, cover_path: 'old-game-cover' }, message: '' })
  await pending
  assert.equal(h.state.item.value.id, 'two')
})

await test('changing the cover keyword invalidates an older search for the same game', async () => {
  const h = fixture('Detail')
  await h.state.load()
  let release!: (result: unknown) => void
  h.api.searchCovers = () => new Promise(resolve => { release = resolve })
  const pending = h.state.searchCovers()
  await h.state.save({ identity_query: 'Portal 2' })
  release({ ok: true, query: 'Portal', message: '', candidates: [{ url: 'old', label: 'Old' }] })
  await pending
  assert.equal(h.state.coverHits.value.length, 0)
  assert.equal(h.state.item.value.identity_query, 'Portal 2')
})

await test('a visibly broken preview is not applied on click', async () => {
  const h = fixture('Detail')
  await h.state.load()
  const candidate = { url: 'broken', label: 'Broken', status: 'ready' }
  h.state.coverHits.value = [candidate]
  h.state.previewFailed(candidate)
  await h.state.useCover(candidate.url)
  assert.equal(h.requests.filter(r => r[0] === 'set-cover').length, 0)
})

await test('manual registration is available while AI is disabled', async () => {
  const h = fixture('Home')
  await h.state.addManualGame()
  assert.equal(h.requests.filter(r => r[0] === 'add-manual').length, 1)
  assert.ok(h.requests.some(r => r[0] === 'reload'))
})

await test('bulk fill uses selected games within the current filtered list', async () => {
  const h = fixture('Home')
  h.state.selecting.value = true
  h.state.selectedIds.value = new Set(['one', 'not-in-filter'])
  await h.state.fillMissingCovers()
  assert.deepEqual(h.requests.find(r => r[0] === 'rebuild')?.[1], ['one'])
  assert.ok(h.requests.some(r => r[0] === 'task-finish' && r[2] === 'success'))
})

await test('a remounted home cannot start a second cover batch while the task runs', async () => {
  const h = fixture('Home')
  h.taskState.value = [{ kind: 'game-scan', title: '批量补齐游戏封面', status: 'running' }]
  await h.state.fillMissingCovers()
  assert.equal(h.requests.filter(r => r[0] === 'rebuild').length, 0)
})

await test('individual cover searches are tracked through their actual failure result', async () => {
  const h = fixture('Detail')
  await h.state.load()
  h.api.searchCovers = async () => ({ ok: false, candidates: [], query: 'Portal', message: 'HTTP 429，请稍后重试', diagnostics: [{ source: 'steam', stage: 'network', status: 'failed', message: 'HTTP 429' }] })
  await h.state.searchCovers()
  assert.ok(h.requests.some(r => r[0] === 'task-start'))
  assert.ok(h.requests.some(r => r[0] === 'task-finish' && r[2] === 'failed' && String(r[3]).includes('429')))
  assert.match(h.state.coverMiss.value, /429/)
})

await test('a cover write error remains visible in the detail panel', async () => {
  const h = fixture('Detail')
  await h.state.load()
  h.state.coverHits.value = [{ url: 'candidate', label: 'Image', source: 'steam', status: 'ready' }]
  h.api.setCoverFromUrl = async () => ({ ok: false, message: '写入失败：磁盘已满' })
  await h.state.useCover('candidate')
  assert.match(h.state.coverMiss.value, /磁盘已满/)
  assert.equal(h.state.item.value.cover_path, h.game.cover_path)
})

await test('identity editing prevents a stale chosen-cover response from replacing the new metadata', async () => {
  const h = fixture('Detail')
  await h.state.load()
  let release!: (result: unknown) => void
  h.api.setCoverFromUrl = () => new Promise(resolve => { release = resolve })
  const pending = h.state.useCover('candidate')
  await h.state.save({ identity_query: 'New query' })
  release({ ok: true, item: { ...h.game, cover_path: 'old-response' }, message: '' })
  await pending
  assert.equal(h.state.item.value.identity_query, 'New query')
})

await test('mixed batch outcomes and skipped newer choices remain visible with final progress', async () => {
  const h = fixture('Home')
  h.api.rebuildCovers = async () => ({ processed: 3, updated: 1, failed: 1, skipped: 1 })
  await h.state.fillMissingCovers()
  const finish = h.requests.find(r => r[0] === 'task-finish')!
  assert.match(String(finish[3]), /部分完成/)
  assert.match(String(finish[3]), /跳过 1/)
  assert.ok(h.requests.some(r => r[0] === 'task-update' && (r[2] as { processed: number }).processed === 3))
})

await test('closing the panel lets the search task settle without reopening old results', async () => {
  const h = fixture('Detail')
  await h.state.load()
  let release!: (result: unknown) => void
  h.api.searchCovers = () => new Promise(resolve => { release = resolve })
  const pending = h.state.searchCovers()
  h.state.closeCoverHits()
  release({ ok: true, candidates: [{ url: 'candidate', status: 'ready' }], query: 'Portal', message: '' })
  await pending
  assert.equal(h.state.coverHits.value.length, 0)
  assert.ok(h.requests.some(r => r[0] === 'task-finish' && r[2] !== 'running'))
})

console.log(`Game cover UI regression: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
