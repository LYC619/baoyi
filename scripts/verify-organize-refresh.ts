import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

// Render the real page to exercise its actual child refresh event binding.
const scope = Vue.effectScope()
let mount: () => Promise<void> = async () => {}, syncs = 0, linked = true
const previews: (string[] | undefined)[] = [], reads: (string[] | undefined)[] = []
const row = { software_id: 'one', name: 'Linked', is_link: true, is_archived: false }
const errors: string[] = []
const organize = {
  running: Vue.ref(false),
  sync: async () => { syncs++; return { root: 'C:/Library', ran: true, categories_added: [], software_added: [], healed: [], recategorized: [], missing: [], orphan_links: [{ path: 'first', name: 'First' }, { path: 'second', name: 'Second' }], skipped_dirs: [], notes: [] } },
  preview: async (ids?: string[]) => { previews.push(ids); return { root: 'C:/Library', entries: linked ? [] : [{ software_id: 'one', action: 'junction' }] } },
  organized: async (ids?: string[]) => { reads.push(ids); return { root: 'C:/Library', entries: linked ? [row] : [] } },
  removeLinks: async () => ({ removed: 1, removed_paths: ['first'], failed: 1, notes: ['second is busy'] })
}
const load = createRendererLoader({
  vue: { ...Vue, onMounted(fn: typeof mount) { mount = fn }, withDirectives: (vnode: unknown) => vnode },
  'vue-router': { onBeforeRouteLeave() {}, useRouter: () => ({ push() {} }) },
  '@/composables/useOrganize': { useOrganize: () => organize },
  '@/composables/useToast': { useToast: () => ({ error: (s: string) => errors.push(s), success() {}, toast() {} }) },
  '@/stores/categories': { useCategoriesStore: () => ({ list: [], load: async () => {} }) },
  '@/stores/software': { useSoftwareStore: () => ({ reload: async () => {} }) },
  '@/components/software/OrganizedSoftware.vue': { default: { name: 'OrganizedSoftware' } }
}, { window: { confirm: () => true } }, true)
const render = scope.run(() => load('src/pages/software/Organize.vue').default.setup({}, { expose() {} }))
function nodes(node: any): any[] {
  return !node || typeof node !== 'object' ? [] : [node, ...(Array.isArray(node.children) ? node.children.flatMap(nodes) : [])]
}
function tree() { return nodes(render({}, [])) }
await mount()
const tabs = tree().find(n => n.props?.['aria-label'] === '整理视图')
tabs.children[1].props.onClick()
await Vue.nextTick()
const child = tree().find(n => n.props?.onRefresh)
assert.ok(child, 'organized list must expose a refresh event')
linked = false
await child.props.onRefresh('one')
assert.equal(syncs, 1, 'unlink must not launch another directory sync')
assert.deepEqual(Array.from(reads.at(-1) ?? []), ['one'], 'only the affected organized record is read')
assert.deepEqual(Array.from(previews.at(-1) ?? []), ['one'], 'only the removed link gets a new pending preview')
const updated = tree().find(n => n.props?.onRefresh)
assert.equal(updated.props.entries.length, 0)
assert.equal(errors.length, 0)
const checkboxes = tree().filter(n => n.type === 'input' && n.props?.type === 'checkbox')
checkboxes[0].props['onUpdate:modelValue'](['first', 'second'])
const clean = tree().find(n => n.type === 'button' && typeof n.children === 'string' && n.children.includes('清理所选'))
await clean.props.onClick()
assert.equal(syncs, 1, 'partial orphan cleanup must not rescan the directory')
assert.deepEqual(tree().filter(n => n.type === 'input' && n.props?.type === 'checkbox').map(n => n.props.value), ['second'])
assert.equal(errors.length, 1, 'failed cleanup is reported and stays selected')
assert.ok(tree().some(n => n.type === 'button' && typeof n.children === 'string' && n.children.includes('清理所选 1 个链接')))
scope.stop()
console.log('PASS unlink updates its row and pending preview without a directory scan')
console.log('PASS partial orphan cleanup keeps failed selection without a directory scan')
