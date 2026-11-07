import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

test('a failed source is not decoded again after unrelated library changes', async () => {
  const scope = Vue.effectScope(),
    mounts: Function[] = []
  let intersect: Function = () => {},
    reads = 0,
    key = 'same-file'
  const load = createRendererLoader(
    {
      vue: {
        ...Vue,
        onMounted: (f: Function) => mounts.push(f),
        onBeforeUnmount() {},
      },
      '@/utils/pdf-document': {
        loadPdfDocument: () => ({
          promise: Promise.reject(Error('broken PDF')),
          destroy: async () => {},
        }),
      },
      '@/utils/workspace-api': {
        workspace: {
          documents: {
            covers: {
              get: async () => ({
                state: 'render',
                key,
                token: 'token',
                format: 'pdf',
              }),
              source: async () => {
                reads++
                return { format: 'pdf', data: new Uint8Array([1]) }
              },
            },
          },
        },
      },
    },
    {
      document: { createElement: () => ({}) },
      IntersectionObserver: class {
        constructor(callback: Function) {
          intersect = callback
        }
        observe() {}
        disconnect() {}
      },
    },
  )
  const api = load('src/composables/useDocumentCovers.ts')
  const state = scope.run(() =>
    api.useDocumentCovers(Vue.ref({ id: 'a', format: 'pdf' }), Vue.ref({})),
  )
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  try {
    mounts.forEach((f) => f())
    intersect([{ isIntersecting: true }])
    await settle()
    assert.equal(state.cover.value.state, 'failed')
    assert.equal(reads, 1)
    api.invalidateDocumentCovers()
    await settle()
    assert.equal(
      reads,
      1,
      'same fingerprint should retain failure without re-reading the PDF',
    )
    key = 'changed-file'
    api.invalidateDocumentCovers()
    await settle()
    assert.equal(reads, 2)
    state.retry()
    await settle()
    assert.equal(reads, 3, 'explicit retry should still work')
  } finally {
    scope.stop()
    await api.pauseDocumentCovers()
  }
})

test('a visible cover resumes when its cancelled request returns after scrolling back', async () => {
  const mounts: Function[] = [],
    unmounts: Function[] = []
  let intersect: (rows: { isIntersecting: boolean }[]) => void = () => {}
  let finish!: (value: unknown) => void,
    calls = 0
  const load = createRendererLoader(
    {
      vue: {
        ...Vue,
        onMounted: (f: Function) => mounts.push(f),
        onBeforeUnmount: (f: Function) => unmounts.push(f),
      },
      '@/utils/pdf-document': {},
      '@/utils/workspace-api': {
        workspace: {
          documents: {
            covers: {
              get: async () => {
                calls++
                if (calls === 1)
                  return new Promise((resolve) => {
                    finish = resolve
                  })
                return {
                  state: 'ready',
                  key: 'current',
                  png: new Uint8Array([1]),
                }
              },
            },
          },
        },
      },
    },
    {
      Blob,
      URL: { createObjectURL: () => 'blob:cover', revokeObjectURL() {} },
      IntersectionObserver: class {
        constructor(callback: typeof intersect) {
          intersect = callback
        }
        observe() {}
        disconnect() {}
      },
    },
  )
  const scope = Vue.effectScope()
  const api = load('src/composables/useDocumentCovers.ts')
  const state = scope.run(() =>
    api.useDocumentCovers(Vue.ref({ id: 'a', format: 'pdf' }), Vue.ref({})),
  )
  try {
    mounts.forEach((f) => f())
    intersect([{ isIntersecting: true }])
    assert.equal(calls, 1)
    intersect([{ isIntersecting: false }])
    intersect([{ isIntersecting: true }])
    finish({ state: 'ready', key: 'stale', png: new Uint8Array([1]) })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      state.cover.value.state,
      'ready',
      'scrolling back must not leave a cancelled cover waiting forever',
    )
    assert.equal(
      state.cover.value.key,
      'current',
      'the old response must be ignored',
    )
    assert.equal(calls, 2)
  } finally {
    unmounts.forEach((f) => f())
    scope.stop()
    await api.pauseDocumentCovers()
  }
})
