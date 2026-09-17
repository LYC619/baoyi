/**
 * Offline regression of the REAL proxy.ts lifecycle. Only Electron and time are
 * substituted: no Electron process, network, media, real cookies or CAPTCHA.
 * The production executeJavaScript expression runs against inert parsed HTML.
 *
 * node --experimental-strip-types --no-warnings scripts/verify-hanime-verification.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parse } from 'node-html-parser'
import * as hanime from '../electron/kinds/video/hentai/hanime.ts'
import * as proxyRules from '../electron/services/proxy-rules.ts'
import * as networkRules from '../electron/services/hanime-network-rules.ts'
import * as hanimeDirect from '../electron/services/hanime-direct.ts'

const URL_A = 'https://hanime1.me/search?query=fixture-a'
const URL_B = 'https://hanime1.me/search?query=fixture-b'
const PAD = ' '.repeat(1400)
const CHALLENGE = '<html><head><title>Just a moment</title></head><body>Verify you are human' + PAD + '</body></html>'
const content = (text = 'Local fixture ready') => '<html><head><title>Local fixture</title></head><body><main class="content-padding-new"><div class="home-rows-videos-wrapper">' + text + PAD + '</div></main></body></html>'
const GOOD = content()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve() }
function track<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown }
  void promise.then(value => { state.settled = true; state.value = value }, error => { state.settled = true; state.error = error })
  return state
}

class Clock {
  now = 0
  nextId = 0
  timers = new Map<number, { at: number; run: () => void }>()
  setTimeout = (run: () => void, delay = 0) => {
    const id = ++this.nextId
    this.timers.set(id, { at: this.now + delay, run })
    return id
  }
  clearTimeout = (id: number) => { this.timers.delete(id) }
  async tick(ms: number) {
    await flush()
    const until = this.now + ms
    for (let steps = 0; steps < 1000; steps++) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) { this.now = until; await flush(); return }
      this.now = next[1].at
      this.timers.delete(next[0])
      next[1].run()
      await flush()
    }
    throw new Error('Timer loop did not converge')
  }
}

class FakeWebContents extends EventEmitter {
  url = 'about:blank'
  html = '<html><head></head><body></body></html>'
  loading = false
  destroyed = false
  userAgent = ''
  executions = 0
  lastExpression = ''
  nextExecution: (() => Promise<unknown>) | undefined
  popup: ((details: { url: string }) => { action: string }) | undefined
  setUserAgent(ua: string) { this.userAgent = ua }
  setWindowOpenHandler(handler: NonNullable<FakeWebContents['popup']>) { this.popup = handler }
  isDestroyed() { return this.destroyed }
  isLoadingMainFrame() { return this.loading }
  getURL() { return this.url }
  start(url: string, isMainFrame = true, isInPlace = false) {
    if (isMainFrame) this.loading = !isInPlace
    this.emit('did-start-navigation', { url, isMainFrame, isInPlace }, url, isInPlace, isMainFrame, 1, 1)
  }
  navigate(url: string, html: string, status = 200) {
    this.start(url)
    this.url = url
    this.html = html
    this.loading = false
    this.emit('did-navigate', {}, url, status, status === 200 ? 'OK' : 'Error')
    this.emit('did-finish-load')
    this.emit('did-stop-loading')
  }
  inspect(code: string) {
    const root = parse(this.html)
    // Inert approximation of rendered text for these fixtures, not a layout engine.
    const visible = parse(this.html)
    for (const element of visible.querySelectorAll('script, style, [hidden]')) element.remove()
    const body = root.querySelector('body')
    const document = {
      readyState: this.loading ? 'loading' : 'complete',
      documentElement: { outerHTML: this.html },
      title: root.querySelector('title')?.textContent ?? '',
      body: body && { textContent: body.textContent, innerText: visible.querySelector('body')?.textContent ?? '' },
      querySelector: (selector: string) => root.querySelector(selector)
    }
    return runInNewContext(code, { document, location: new URL(this.url) }) as unknown
  }
  executeJavaScript(code: string) {
    this.executions++
    this.lastExpression = code
    const execute = this.nextExecution
    this.nextExecution = undefined
    return execute ? execute() : Promise.resolve(this.inspect(code))
  }
  requestNavigation(url: string, redirect = false, isMainFrame = true) {
    let prevented = false
    const event = { url, isMainFrame, preventDefault: () => { prevented = true } }
    this.emit(redirect ? 'will-redirect' : 'will-navigate', event, url, false, isMainFrame, 1, 1)
    return prevented
  }
}

type WindowOptions = { webPreferences: { session: unknown; contextIsolation: boolean; nodeIntegration: boolean } }
class FakeWindow extends EventEmitter {
  webContents = new FakeWebContents()
  destroyed = false
  closeCalls = 0
  focusCalls = 0
  options: WindowOptions
  onLoad: (win: FakeWindow, url: string) => Promise<void>
  constructor(options: WindowOptions, onLoad: FakeWindow['onLoad']) {
    super()
    this.options = options
    this.onLoad = onLoad
  }
  loadURL(url: string) { return this.onLoad(this, url) }
  isDestroyed() { return this.destroyed }
  focus() { this.focusCalls++ }
  close() {
    this.closeCalls++
    this.destroyed = true
    this.webContents.destroyed = true
    this.emit('closed')
    this.webContents.emit('destroyed')
  }
}

// Transpile, do not copy/extract/rewrite the functions under test. Loading this
// module cannot import real Electron or reach the network: unexpected imports fail.
const source = readFileSync(new URL('../electron/services/proxy.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
async function harness(onLoad: FakeWindow['onLoad'] = (win, url) => {
  win.webContents.navigate(url, CHALLENGE)
  return Promise.resolve()
}) {
  const clock = new Clock()
  const windows: FakeWindow[] = []
  const partitions: string[] = []
  const fetchCalls: unknown[][] = []
  const isolatedSession = {
    setProxy: async () => {},
    fetch: (...args: unknown[]) => { fetchCalls.push(args); return Promise.resolve(new Response('fixture')) }
  }
  let handler!: (url: string) => Promise<string | null>
  let injectedFetch!: typeof globalThis.fetch
  const electron = {
    app: { isReady: () => true },
    session: { fromPartition: (partition: string) => { partitions.push(partition); return isolatedSession } },
    BrowserWindow: class extends FakeWindow {
      constructor(options: WindowOptions) { super(options, onLoad); windows.push(this) }
    }
  }
  const exports = {} as typeof import('../electron/services/proxy.ts')
  const dependencies: Record<string, unknown> = {
    electron,
    '../kinds/video/hentai/hanime.ts': {
      ...hanime,
      setHanimeChallengeHandler: (value: typeof handler) => { handler = value },
      setHanimeFetch: (value: typeof injectedFetch) => { injectedFetch = value }
    },
    './proxy-rules.ts': proxyRules,
    './hanime-network-rules.ts': networkRules,
    './hanime-direct.ts': hanimeDirect
  }
  runInNewContext(compiled, {
    exports, URL, console,
    Date: class extends Date { static now() { return clock.now } },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    require: (id: string) => { assert.ok(id in dependencies, 'Unexpected dependency: ' + id); return dependencies[id] }
  }, { filename: 'electron/services/proxy.ts' })
  await exports.applyProxy('')
  return { clock, windows, open: handler, verify: exports.openHanimeVerification, partitions, isolatedSession, fetchCalls, fetch: injectedFetch }
}

const tests: [string, () => Promise<void>][] = []
function test(name: string, run: () => Promise<void>) { tests.push([name, run]) }

test('replacement navigation rejecting loadURL must not close the live verification window', async () => {
  const load = deferred<void>()
  const h = await harness((win, url) => { win.webContents.navigate(url, CHALLENGE); return load.promise })
  const task = track(h.open(URL_A))
  await flush()
  const win = h.windows[0]
  win.webContents.navigate(URL_A, CHALLENGE)
  load.reject(Object.assign(new Error('ERR_ABORTED (-3): navigation superseded'), { code: 'ERR_ABORTED', errno: -3 }))
  await flush()
  assert.equal(win.closeCalls, 0, 'loadURL rejection closed a live replacement navigation')
  assert.equal(task.settled, false)
  win.webContents.navigate(URL_A, GOOD)
  await h.clock.tick(1000)
  assert.equal(task.value, GOOD)
})

test('execution-context rejection during a click is transient, not verification success', async () => {
  const h = await harness()
  const task = track(h.open(URL_A))
  await flush()
  const win = h.windows[0]
  win.webContents.nextExecution = () => Promise.reject(new Error('Execution context was destroyed'))
  await h.clock.tick(1000)
  assert.equal(task.settled, false)
  assert.equal(win.closeCalls, 0)
  win.webContents.navigate(URL_A, GOOD)
  await h.clock.tick(1000)
  assert.equal(task.value, GOOD)
})

for (const [name, url, html, status] of [
  ['blank HTML padded by scripts/styles', URL_A, '<html><head><style>' + PAD + '</style></head><body></body></html>', 200],
  ['blank site shell containing only script text', URL_A, '<html><body><main class="content-padding-new"></main><script>const unused = 1;' + PAD + '</script></body></html>', 200],
  ['hidden-only site shell', URL_A, '<html><body><main class="content-padding-new" hidden>Not rendered' + PAD + '</main></body></html>', 200],
  ['Chromium error document', 'chrome-error://chromewebdata/', '<html><body>ERR_PROXY_CONNECTION_FAILED' + PAD + '</body></html>', -1],
  ['HTTP error with normal-looking site shell', URL_A, content('Service unavailable'), 503],
  ['unrecognised HTTP 200 error page', URL_A, '<html><body>Upstream failure' + PAD + '</body></html>', 200],
  ['unrelated external page', 'https://example.invalid/', GOOD, 200],
  ['different requested resource', URL_B, content('Other resource'), 200]
] as const) {
  test(name + ' must not count as passed or trigger automatic close', async () => {
    const h = await harness((win) => { win.webContents.navigate(url, html, status); return Promise.resolve() })
    const task = track(h.verify(URL_A))
    await h.clock.tick(2000)
    assert.equal(task.settled, false, name + ' was accepted as verification success')
    assert.equal(h.windows[0].closeCalls, 0)
    h.windows[0].close()
    await h.clock.tick(1000)
    assert.equal(task.value, false)
  })
}

test('same URL callers share one verification result', async () => {
  const h = await harness()
  const a = track(h.open(URL_A))
  const b = track(h.open(URL_A))
  await flush()
  assert.equal(h.windows.length, 1)
  const before = h.windows[0].webContents.executions
  await h.clock.tick(1000)
  assert.equal(h.windows[0].webContents.executions - before, 1, 'duplicate independent pollers')
  h.windows[0].webContents.navigate(URL_A, GOOD)
  await h.clock.tick(1000)
  assert.equal(a.value, GOOD)
  assert.equal(b.value, GOOD)
})

test('different URL callers must not receive HTML for another request', async () => {
  const h = await harness()
  const a = track(h.open(URL_A))
  const b = track(h.open(URL_B))
  await flush()
  h.windows[0].webContents.navigate(URL_A, GOOD)
  await h.clock.tick(1000)
  assert.equal(a.value, GOOD)
  assert.equal(b.settled, false, 'second caller consumed the first URL HTML')
  assert.equal(h.windows.length, 2)
  assert.equal(h.windows[1].webContents.getURL(), URL_B)
  const other = content('Second request')
  h.windows[1].webContents.navigate(URL_B, other)
  await h.clock.tick(1000)
  assert.equal(b.value, other)
})

test('old execution completion and closed event cannot close or clear a newer window', async () => {
  const h = await harness()
  const a = track(h.open(URL_A))
  await flush()
  const old = h.windows[0]
  const pending = deferred<unknown>()
  old.webContents.nextExecution = () => pending.promise
  await h.clock.tick(1000)
  old.close()
  const b = track(h.open(URL_B))
  await flush()
  const fresh = h.windows[1]
  old.webContents.html = GOOD
  // Resolve the actual production expression, not a fabricated result shape.
  pending.resolve(old.webContents.inspect(old.webContents.lastExpression))
  await flush()
  assert.equal(fresh.closeCalls, 0, 'old cleanup closed the replacement window')
  assert.equal(a.value, null, 'user cancellation accepted stale HTML')
  old.emit('closed')
  const c = track(h.open(URL_B))
  await flush()
  assert.equal(h.windows.length, 2, 'old closed listener erased active newer attempt')
  fresh.webContents.navigate(URL_B, GOOD)
  await h.clock.tick(1000)
  assert.equal(b.value, GOOD)
  assert.equal(c.value, GOOD)
})

for (const operation of ['loadURL', 'executeJavaScript'] as const) {
  for (const reason of ['close', 'timeout'] as const) {
    test(operation + ' pending: ' + reason + ' still settles and removes timers/listeners', async () => {
      const pending = deferred<never>()
      const h = await harness((win, url) => {
        win.webContents.navigate(url, CHALLENGE)
        if (operation === 'executeJavaScript') win.webContents.nextExecution = () => pending.promise
        return operation === 'loadURL' ? pending.promise : Promise.resolve()
      })
      const task = track(h.open(URL_A))
      await flush()
      const win = h.windows[0]
      if (reason === 'close') win.close()
      await h.clock.tick(reason === 'timeout' ? 120_000 : 0)
      assert.equal(task.settled, true, operation + ' blocked ' + reason + ' cancellation')
      assert.equal(task.value, null)
      assert.equal(h.clock.timers.size, 0, 'leaked timer')
      assert.equal(win.webContents.eventNames().length, 0, 'leaked webContents listener')
      assert.equal(win.listenerCount('closed'), 0, 'leaked closed listener')
    })
  }
}

test('safe navigation and popup policy, without changing session/cookie/security isolation', async () => {
  const h = await harness()
  for (const url of ['file://hanime1.me/private', 'javascript:alert(1)', 'https://hanime1.me.evil.invalid/', 'https://user:pass@hanime1.me/']) {
    const invalid = track(h.verify(url))
    await flush()
    assert.equal(invalid.value, false, 'unsafe URL was not rejected: ' + url)
  }
  assert.equal(h.windows.length, 0)
  const task = track(h.open(URL_A))
  await flush()
  const win = h.windows[0]
  assert.equal(win.options.webPreferences.session, h.isolatedSession)
  assert.equal(win.options.webPreferences.contextIsolation, true)
  assert.equal(win.options.webPreferences.nodeIntegration, false)
  assert.deepEqual(h.partitions, ['persist:hanime-network'])
  await h.fetch(URL_A)
  assert.equal((h.fetchCalls[0][1] as RequestInit).credentials, 'include')
  assert.ok(win.webContents.popup, 'missing popup deny policy')
  assert.equal(win.webContents.popup({ url: 'https://example.invalid/' }).action, 'deny')
  assert.equal(win.webContents.popup({ url: URL_A }).action, 'deny')
  assert.equal(win.webContents.requestNavigation('https://example.invalid/'), true)
  assert.equal(win.webContents.requestNavigation('file:///tmp/a', true), true)
  assert.equal(win.webContents.requestNavigation(URL_A), false)
  assert.equal(win.webContents.requestNavigation('https://challenges.cloudflare.com/', true, false), false, 'challenge iframe redirect should remain isolated but usable')
  win.close()
  await h.clock.tick(1000)
  assert.equal(task.value, null)
})

test('snapshot returned across main-frame navigation must be discarded', async () => {
  const h = await harness()
  const task = track(h.open(URL_A))
  await flush()
  const wc = h.windows[0].webContents
  const pending = deferred<unknown>()
  wc.html = GOOD
  wc.nextExecution = () => pending.promise
  await h.clock.tick(1000)
  const stale = wc.inspect(wc.lastExpression)
  wc.start(URL_A)
  pending.resolve(stale)
  await flush()
  assert.equal(task.settled, false, 'accepted a snapshot from before navigation')
  assert.equal(h.windows[0].closeCalls, 0)
  wc.navigate(URL_A, CHALLENGE)
  await h.clock.tick(1000)
  assert.equal(task.settled, false)
  wc.navigate(URL_A, GOOD)
  await h.clock.tick(1000)
  assert.equal(task.value, GOOD)
})

test('unreachable main-frame load fails the verification at once instead of waiting 120 s', async () => {
  const h = await harness((win, url) => {
    // Chromium reports the failure through did-fail-load; loadURL itself rejects too.
    win.webContents.start(url)
    win.webContents.loading = false
    win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', url, true, 1, 1)
    return Promise.reject(Object.assign(new Error('ERR_CONNECTION_REFUSED (-102) loading ' + url), { code: 'ERR_CONNECTION_REFUSED', errno: -102 }))
  })
  const task = track(h.verify(URL_A))
  await h.clock.tick(1000)
  assert.equal(task.settled, true, 'verification kept waiting after the site was unreachable')
  assert.equal(task.value, false)
  assert.equal(h.windows[0].closeCalls, 1)
  assert.equal(h.clock.timers.size, 0)
})

test('superseded navigation (ERR_ABORTED) and HTTP-level load errors keep the window open', async () => {
  for (const [code, description] of [[-3, 'ERR_ABORTED'], [-324, 'ERR_EMPTY_RESPONSE']] as const) {
    const h = await harness((win, url) => { win.webContents.navigate(url, CHALLENGE); return Promise.resolve() })
    const task = track(h.verify(URL_A))
    await flush()
    h.windows[0].webContents.emit('did-fail-load', {}, code, description, URL_A, true, 1, 1)
    await h.clock.tick(2000)
    assert.equal(task.settled, false, description + ' closed a live verification window')
    assert.equal(h.windows[0].closeCalls, 0)
    h.windows[0].webContents.navigate(URL_A, GOOD)
    await h.clock.tick(1000)
    assert.equal(task.value, true)
  }
})

test('renderer termination settles a pending inspection as failure', async () => {
  const h = await harness()
  const task = track(h.open(URL_A))
  await flush()
  const wc = h.windows[0].webContents
  const pending = deferred<unknown>()
  wc.nextExecution = () => pending.promise
  await h.clock.tick(1000)
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  await flush()
  assert.equal(task.settled, true)
  assert.equal(task.value, null)
  assert.equal(h.clock.timers.size, 0)
})

let failed = 0
for (const [name, run] of tests) {
  try { await run(); console.log('PASS ' + name) }
  catch (error) { failed++; console.error('FAIL ' + name + '\n  ' + (error as Error).message) }
}
console.log(tests.length - failed + '/' + tests.length + ' passed; ' + failed + ' failed (offline; no Electron process or network)')
if (failed) process.exitCode = 1
