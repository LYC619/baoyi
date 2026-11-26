import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import {
  IpcError,
  invalidArg,
  assertSafeIpcArgs,
  optBool,
  optEnum,
  optId,
  optNumber,
  optRecord,
  optString,
  optStringArray,
  optUrl,
  reqArray,
  reqBool,
  reqBytes,
  reqEnum,
  reqId,
  reqNumber,
  reqRecord,
  reqString,
  reqStringArray,
  reqUrl,
  toStructuredIpcError
} from '../electron/ipc/validate.ts'
import { IpcActivity, mainWindowIpc } from '../electron/ipc/main-window.ts'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { applyLanguage, systemMessage } from '../src/i18n/index.ts'

test('primitive and collection validators accept valid inputs and reject invalid payloads with structured IpcError', () => {
  assert.equal(reqString(' hello ', 'name', { trim: true }), 'hello')
  assert.equal(optString(undefined, 'note'), undefined)
  assert.equal(optString(null, 'note'), undefined)
  assert.equal(reqId(' res-1 '), 'res-1')
  assert.equal(optId(''), undefined)
  assert.equal(reqBool(true, 'flag'), true)
  assert.equal(optBool(undefined, 'flag'), undefined)
  assert.equal(reqNumber(42, 'count', { min: 0, max: 100, integer: true }), 42)
  assert.equal(optNumber(null, 'count'), undefined)
  assert.equal(reqEnum('copy', ['copy', 'move'] as const, 'mode'), 'copy')
  assert.equal(optEnum(undefined, ['copy', 'move'] as const, 'mode'), undefined)
  assert.equal(reqUrl('https://example.com/path?a=1', 'url'), 'https://example.com/path?a=1')
  assert.equal(optUrl('', 'url'), undefined)
  assert.deepEqual(reqStringArray(['a', 'b'], 'ids'), ['a', 'b'])
  assert.equal(optStringArray(undefined, 'ids'), undefined)
  assert.deepEqual(reqArray([1, 2], 'items', { min: 1, max: 5 }), [1, 2])
  assert.equal(reqBytes(new Uint8Array([1, 2, 3]), 'png').byteLength, 3)

  // Cross-realm plain object compatibility (e.g. vm sandbox / renderer harness)
  const foreignObj = vm.runInNewContext('({ key: "ok" })')
  assert.equal(reqRecord(foreignObj, 'patch').key, 'ok')
  assert.equal(optRecord(undefined, 'patch'), undefined)

  const assertInvalid = (fn: () => unknown, field: string) => {
    assert.throws(fn, (err: unknown) => {
      assert.ok(err instanceof IpcError)
      assert.equal(err.code, 'INVALID_ARGUMENT')
      assert.equal(err.field, field)
      assert.equal(err.toJSON().ok, false)
      return true
    })
  }

  assertInvalid(() => reqString('', 'title'), 'title')
  assertInvalid(() => reqString(123, 'title'), 'title')
  assertInvalid(() => reqString('bad\0null', 'title'), 'title')
  assertInvalid(() => reqString('x'.repeat(20), 'title', { max: 10 }), 'title')
  assertInvalid(() => reqId('   ', 'id'), 'id')
  assertInvalid(() => reqRecord(null, 'patch'), 'patch')
  assertInvalid(() => reqRecord([], 'patch'), 'patch')
  assertInvalid(() => reqRecord(new Date(), 'patch'), 'patch')
  assertInvalid(() => reqBool('true', 'flag'), 'flag')
  assertInvalid(() => reqNumber(NaN, 'n'), 'n')
  assertInvalid(() => reqNumber(1.5, 'n', { integer: true }), 'n')
  assertInvalid(() => reqNumber(-1, 'n', { min: 0 }), 'n')
  assertInvalid(() => reqEnum('delete', ['copy', 'move'] as const, 'mode'), 'mode')
  assertInvalid(() => reqUrl('javascript:alert(1)', 'url'), 'url')
  assertInvalid(() => reqUrl('file:///C:/Windows/System32', 'url'), 'url')
  assertInvalid(() => reqStringArray(['ok', 42], 'ids'), 'ids[1]')
  assertInvalid(() => reqBytes(new Uint8Array(0), 'png'), 'png')
  assertInvalid(() => reqBytes('not-bytes', 'png'), 'png')
})

test('assertSafeIpcArgs blocks prototype pollution, NUL bytes, excessive nesting and arg count while allowing binary buffers', () => {
  assert.doesNotThrow(() => assertSafeIpcArgs('documents:covers:put', ['doc-1', 'tok-1', new Uint8Array([0, 1, 0, 2])]))

  assert.throws(
    () => assertSafeIpcArgs('software:update', ['id-1', JSON.parse('{"__proto__":{"polluted":true}}')]),
    (err: unknown) => err instanceof IpcError && err.code === 'INVALID_ARGUMENT'
  )
  assert.throws(
    () => assertSafeIpcArgs('software:update', ['id-1', { nested: { constructor: {} } }]),
    (err: unknown) => err instanceof IpcError && err.code === 'INVALID_ARGUMENT'
  )
  assert.throws(
    () => assertSafeIpcArgs('software:get', ['id-1\0evil']),
    (err: unknown) => err instanceof IpcError && err.code === 'INVALID_ARGUMENT'
  )
  assert.throws(
    () => assertSafeIpcArgs('too:many', Array.from({ length: 13 }, (_, i) => i)),
    (err: unknown) => err instanceof IpcError && err.code === 'INVALID_ARGUMENT'
  )

  let deep: Record<string, unknown> = { ok: true }
  for (let i = 0; i < 20; i++) deep = { next: deep }
  assert.throws(
    () => assertSafeIpcArgs('deep:nested', [deep]),
    (err: unknown) => err instanceof IpcError && err.code === 'INVALID_ARGUMENT'
  )
})

test('toStructuredIpcError maps domain and system errors to consistent codes', () => {
  assert.equal(toStructuredIpcError(new IpcError('INVALID_ARGUMENT', '参数 id 无效', 'id')).code, 'INVALID_ARGUMENT')
  assert.equal(toStructuredIpcError(new Error('只允许主窗口操作')).code, 'FORBIDDEN')
  assert.equal(toStructuredIpcError(new Error('游戏不存在')).code, 'NOT_FOUND')
  assert.equal(toStructuredIpcError(new Error('已经有同名分类了')).code, 'CONFLICT')
  assert.equal(toStructuredIpcError(new Error('资料库正在恢复，请等待重启')).code, 'UNAVAILABLE')
  assert.equal(toStructuredIpcError(Object.assign(new Error('UNIQUE failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' })).code, 'CONFLICT')
  assert.equal(toStructuredIpcError(new Error('unexpected failure')).code, 'INTERNAL')
})

test('mainWindowIpc and IpcActivity enforce sender origin, payload guard, and shutdown gating', async () => {
  const activity = new IpcActivity()
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const rawIpc = {
    handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(ch, fn) },
    on: () => {}
  }
  const mainFrame = { id: 'main-frame' }
  const webContents = { mainFrame }
  const win = { isDestroyed: () => false, webContents } as any
  const ipc = mainWindowIpc(activity.track(rawIpc as any), () => win)

  let called = 0
  ipc.handle('demo:echo', (_e, id: unknown) => { called++; return reqId(id) })

  const goodEvent = { sender: webContents, senderFrame: mainFrame }
  const badEvent = { sender: webContents, senderFrame: { id: 'iframe' } }

  assert.equal(await handlers.get('demo:echo')!(goodEvent, 'item-1'), 'item-1')
  assert.equal(called, 1)

  await assert.rejects(
    async () => handlers.get('demo:echo')!(badEvent, 'item-1'),
    (err: unknown) => err instanceof IpcError && err.code === 'FORBIDDEN'
  )
  await assert.rejects(
    async () => handlers.get('demo:echo')!(goodEvent, 'bad\0id'),
    (err: unknown) => err instanceof IpcError && err.code === 'INVALID_ARGUMENT'
  )
  assert.equal(called, 1, 'boundary rejection must happen before handler body runs')

  await activity.stop()
  await assert.rejects(
    async () => handlers.get('demo:echo')!(goodEvent, 'item-1'),
    (err: unknown) => err instanceof IpcError && err.code === 'UNAVAILABLE'
  )
})

test('IPC handler modules reject invalid runtime arguments before hitting database or filesystem', async () => {
  const db = new DatabaseSync(':memory:')
  initSchema(db as any, KINDS)
  const mainFrame = { id: 'main' }
  const webContents = { mainFrame, send: () => {} }
  const win = { isDestroyed: () => false, webContents } as any
  const event = { sender: webContents, senderFrame: mainFrame }

  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = { handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(ch, fn) } }

  const load = createRendererLoader({
    electron: { app: { getPath: () => process.cwd(), getVersion: () => '0.20.3' }, dialog: {}, shell: {}, nativeImage: {} },
    '../services/storage/database.ts': { getDb: () => db, coversDir: () => process.cwd() },
    '../services/storage/settings-store.ts': { getSettings: () => ({ hide_hentai: false, ai: {}, video_scan_dirs: [] }) },
    './library-backup.ts': { assertLibraryIdle: () => {}, libraryRestoreInProgress: () => false },
    '../kinds/game/service.ts': { replaceCoverFile: () => ({ ok: true }), validateCoverFile: () => ({ ok: true }), invalidateGameCoverRequests: () => {} }
  }, { Buffer, Uint8Array, ArrayBuffer, URL, Date, Set, Map, WeakSet })

  load('electron/ipc/audio.ts').registerAudioIpc(() => win, ipc)
  load('electron/ipc/game-workspace.ts').registerGameWorkspaceIpc(() => win, ipc)

  await assert.rejects(async () => handlers.get('video:audio-lyrics')!(event, ''), /参数 id 无效/)
  await assert.rejects(async () => handlers.get('video:audio-info')!(event, 123), /参数 id 无效/)
  await assert.rejects(async () => handlers.get('game:notes:list')!(event, null), /参数 id 无效/)
  await assert.rejects(async () => handlers.get('game:notes:save')!(event, 'g1', 'not-an-object'), /参数 input 无效/)
  await assert.rejects(async () => handlers.get('game:notes:remove')!(event, 'g1', 'n1', -5), /参数 stamp 无效/)
  await assert.rejects(async () => handlers.get('game:link:patch')!(event, 'g1', '', {}, ''), /参数 target 无效/)
  await assert.rejects(async () => handlers.get('game:default-entry')!(event, 'g1', null), /参数 target 无效/)

  db.close()
})

test('English validation messages translate reasons and limits without changing raw errors or user paths', () => {
  applyLanguage('en')
  try {
    assert.throws(() => invalidArg('url', '不是合法链接'), (cause: unknown) => {
      assert.ok(cause instanceof IpcError)
      assert.equal(cause.message, '参数 url 无效：不是合法链接')
      assert.equal(cause.code, 'INVALID_ARGUMENT')
      assert.equal(systemMessage(cause.message), 'The value for url is invalid: Not a valid URL')
      return true
    })
    assert.throws(() => reqString('a', 'name', { min: 3 }), (cause: unknown) => {
      assert.ok(cause instanceof IpcError)
      assert.equal(systemMessage(cause.message), 'Invalid parameter name: Length must be at least 3')
      return true
    })
    assert.equal(systemMessage('已启动Example Game'), 'Started Example Game')
    assert.equal(systemMessage('入口编号无效'), 'Entry ID is invalid.')
    assert.equal(systemMessage('2026 年度设置'), '2026 年度设置', 'short UI suffixes must not mangle user titles')
    assert.equal(systemMessage('服务器返回了 3 个'), '服务器返回了 3 个', 'short UI counters must not mangle unknown messages')
    assert.equal(systemMessage('保存失败：C:\\资料\\已停止.txt'), 'Could not save: C:\\资料\\已停止.txt')
    assert.equal(systemMessage('保存失败：保存失败：已停止'), 'Could not save: 保存失败：已停止', 'captured text is not recursively pattern matched')
  } finally { applyLanguage('zh-CN') }
})
