import assert from 'node:assert/strict'
import * as Vue from 'vue'
import * as Pinia from 'pinia'
import { renderToString } from '@vue/server-renderer'
import { parse } from 'node-html-parser'
import { createRendererLoader } from './helpers/renderer-harness.ts'

const queries: any[] = []
const counts = { all: 1, archived: 0, type: { movie: 1, series: 0 }, hentai: 2, hentai_visible: true,
  status: { unwatched: 1, watching: 0, watched: 0, dropped: 0 }, categories: [], tags: [], hanime_tags: [{ name: '站方标签', count: 2 }],
  collections: [{ name: '培训系列', count: 1 }], hentai_collections: [{ name: '站方系列', count: 2 }] }
const loader = createRendererLoader({ vue: Vue, pinia: Pinia, '@/composables/useToast': { useToast: () => ({ error: () => {} }) } },
  { window: { baoyi: { video: { list: async (q: any) => { queries.push(q); return [] }, counts: async () => counts } } } }, true)
Pinia.setActivePinia(Pinia.createPinia())
const store = loader('src/stores/video.ts').useVideoStore()
const Sidebar = loader('src/components/video/Sidebar.vue').default
let passed = 0; let failed = 0
async function test(name: string, run: () => Promise<void>) {
  try { await run(); passed++ }
  catch (error) { failed++; console.error('FAIL', name, error instanceof Error ? error.message : error) }
}
async function rows() { return parse(await renderToString(Vue.createSSRApp(Sidebar))).querySelectorAll('button').map(x => x.textContent) }
await store.reload()
await test('hentai is a type row while other category remains selectable when empty', async () => {
  const labels = await rows()
  assert.ok(labels.some(x => x.includes('里番')))
  assert.ok(labels.some(x => x.includes('其他分类')))
  assert.ok(labels.some(x => x.includes('培训系列')))
  assert.ok(labels.every(x => !x.includes('站方系列')))
})
await test('hentai tags preserve explicit type and leaving scope clears it', async () => {
  store.select({ kind: 'tag', value: '站方标签', type: 'hentai' })
  await store.load()
  assert.equal(queries.at(-1).type, 'hentai')
  store.select({ kind: 'group', value: 'all' })
  await store.load()
  assert.equal(queries.at(-1).type, undefined)
})
await test('collections retain their scope in queries and headings', async () => {
  store.select({ kind: 'collection', value: '培训系列' })
  await store.load()
  assert.equal(queries.at(-1).collection, '培训系列')
  assert.equal(store.heading, '培训系列')
  store.select({ kind: 'collection', value: '站方系列', type: 'hentai' })
  await store.load()
  assert.equal(queries.at(-1).type, 'hentai')
  assert.ok((await rows()).some(x => x.includes('站方系列')))
})
await test('global hide removes the type row and resets an active hentai selection', async () => {
  counts.hentai_visible = false
  await store.reload()
  assert.equal(store.selection.kind, 'group')
  assert.ok((await rows()).every(x => !x.includes('里番') && !x.includes('站方')))
})
console.log(`视频分组与类型界面回归：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
