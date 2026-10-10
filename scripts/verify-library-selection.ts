import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { effectScope, nextTick, ref } from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { useLibrarySelection } from '../src/composables/useLibrarySelection.ts'
import { useBulkOperation } from '../src/composables/useBulkOperation.ts'

const scope = effectScope()
await scope.run(async () => {
  const rows = ref([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  const selection = useLibrarySelection(() => rows.value)
  selection.toggleMode(); selection.selectAll(); assert.equal(selection.selectedIds.value.size, 3)
  rows.value = [{ id: 'b' }]; await nextTick()
  assert.deepEqual([...selection.selectedIds.value], ['b'], '筛选后不能保留隐藏项')
  let prevented = false
  selection.key({ key: 'a', ctrlKey: true, target: { tagName: 'INPUT', isContentEditable: false }, preventDefault() { prevented = true } } as any)
  assert.equal(prevented, false, '输入框 Ctrl+A 属于文本选择')
  selection.key({ key: 'Escape', target: {}, preventDefault() {} } as any)
  assert.equal(selection.selecting.value, false)
  assert.equal(selection.selectedIds.value.size, 0)

  const operation = useBulkOperation()
  const called: string[] = []
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const running = operation.run([{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }, { id: 'c', name: '丙' }], async item => {
    called.push(item.id); if (item.id === 'a') await barrier
    if (item.id === 'b') throw new Error('测试失败')
  })
  await operation.run([{ id: 'duplicate', name: '不应执行' }], async item => { called.push(item.id) })
  release(); await running
  assert.deepEqual(called, ['a', 'b', 'c'], '处理中不能重复提交')
  assert.equal(operation.succeeded.value, 2)
  assert.deepEqual(operation.failures.value.map(row => [row.id, row.name, row.message]), [['b', '乙', '测试失败']])
  await operation.run([{ id: 'b', name: '乙' }], async () => {})
  assert.equal(operation.succeeded.value, 1); assert.equal(operation.failures.value.length, 0)
})
scope.stop()
console.log('PASS visible selection, text shortcuts, exit, duplicate guard, partial failure and retry')

{
  const scope = effectScope(), props = Vue.reactive({ ids: ['A'], groups: [], type: 'comic', pending: false }), writes: unknown[] = []
  const loader = createRendererLoader({ vue: Vue, '@/stores/image': { useImageStore: () => ({ collections: [] }) } },
    { window: { baoyi: { image: { bulkUpdate: async (...args: any[]) => { writes.push(args); return 1 } } } } })
  const panel = scope.run(() => loader('src/components/image/ImageBulkPanel.vue').default.setup(props, { expose() {}, emit() {} }))
  panel.action.value = 'category'; await nextTick()
  props.type = 'photo'; await nextTick()
  assert.equal(panel.action.value, 'tags', 'photo selection must reset unsupported comic operations')
  props.pending = true; panel.tagText.value = '标签'
  await panel.apply(); assert.equal(writes.length, 0, 'pending image refresh blocks even direct form calls')
  props.pending = false; await panel.apply(); assert.equal(writes.length, 1)
  scope.stop()
}
console.log('PASS image bulk type switch keeps a supported action selected')
