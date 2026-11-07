import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

test('outline navigation caches targets and ignores a slower earlier click', async () => {
  const scope = Vue.effectScope()
  const load = createRendererLoader({
    vue: { ...Vue, onMounted() {}, onBeforeUnmount() {} },
    '@/utils/pdf-document': {},
    '@/utils/workspace-api': {},
    marked: { marked: {} },
    dompurify: {},
  })
  const state = scope.run(() =>
    load('src/components/workspace/DocumentCanvas.vue').default.setup(
      {
        content: { format: 'pdf', text: '' },
        initial: { page: 1, offset: 0 },
        annotations: [],
        toc: true,
      },
      { expose() {}, emit() {} },
    ),
  )
  let finish!: (value: unknown) => void,
    calls = 0
  state.pdf.value = {
    numPages: 5,
    getDestination: async (name: string) => {
      calls++
      return name === 'slow'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : [2]
    },
  }
  state.count.value = 5
  try {
    const first = state.navigateOutline({ id: '0', dest: 'slow' })
    await state.navigateOutline({ id: '1', dest: 'fast' })
    finish([0])
    await first
    assert.equal(
      state.page.value,
      3,
      'a delayed first click must not override the most recent chapter',
    )
    await state.navigateOutline({ id: '1', dest: 'fast' })
    assert.equal(calls, 2, 'a resolved chapter destination should be reused')
  } finally {
    scope.stop()
  }
})
