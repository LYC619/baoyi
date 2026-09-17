/** Exercise background organization with the real packaged window and an isolated library. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { captureHiddenElectron } from './helpers/electron-capture.ts'

const require = createRequire(import.meta.url)
const { _electron } = require('C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-video-agent-background-20260913/win-unpacked/抱一.exe')
const evidence = path.resolve(process.argv[3] || 'output/video-agent-background-20260913/native')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-agent-background-'))
const database = path.join(profile, 'baoyi.db'), organized = path.join(profile, 'Organized')
fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(organized)
const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', bytes => { body += bytes })
  request.on('end', () => {
    try {
      const input = JSON.parse(body), works = JSON.parse(input.messages.find((message: any) => message.role === 'user').content)
      const families = new Map<string, string[]>()
      for (const work of works) families.set(work.series.title, [...families.get(work.series.title) || [], work.id])
      const groups = [...families.values()].filter(ids => ids.length > 1).map(resourceIds => ({ resourceIds, reason: 'Same series, distinct episodes' }))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'group', type: 'function', function: {
        name: 'propose_collections', arguments: JSON.stringify({ groups })
      } }] } }], usage: { total_tokens: 40 } }))
    } catch (cause) { response.writeHead(500); response.end(String(cause)) }
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const db = new DatabaseSync(database)
db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
const origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
for (const [key, value] of Object.entries({ onboarded: true, hide_hentai: false, theme: 'light', proxy: '', video_organize_root: organized,
  ai: { enabled: true, api_key: 'synthetic-only', api_url: origin + '/v1', model: 'fixture' } })) {
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value))
}
const ids: string[] = [], media: string[] = []
function work(title: string, count = 1) {
  const result = registerVideoContent(db, { title, category: '动画', items: Array.from({ length: count }, (_, index) => {
    const file = path.join(profile, 'Library', title, `${title}-${index + 1}.mp4`)
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'synthetic media'); media.push(file)
    return { title: count === 1 ? title : `Recorded episode ${index + 1}`, order: index + 1, number: index + 1,
      description: 'Original episode details', watch: { status: 'watching' as const, position: 90, watchedAt: 0 }, files: [{ path: file }] }
  }) })
  ids.push(result.resourceId)
}
const sizes = [6, 4, 4, 3, 3, ...Array(24).fill(2)]
sizes.forEach((size, series) => { for (let number = 1; number <= size; number++) work(`Series ${String(series + 1).padStart(2, '0')} E${String(number).padStart(2, '0')}`) })
for (let index = 0; index < 9; index++) work(`Existing ${index} E01`, 2)
for (let index = 0; index < 60; index++) work(index < 9 ? `Existing ${index} E03` : `Independent [${index}]`)
assert.equal(ids.length, 137); db.close()
const environment: NodeJS.ProcessEnv = { ...process.env, BAOYI_TIMING: '1' }
delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
const checks: string[] = [], failures: string[] = [], pageErrors: string[] = [], processLogs: string[] = []
const report: Record<string, any> = { executable, profile, syntheticInput: true, usesLiveSite: false }
let app: any, page: any
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(probe: () => Promise<boolean>, description: string, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await probe()) return; await delay(100) }
  throw new Error('Timed out: ' + description)
}
async function check(name: string, run: () => Promise<void>) {
  try { await run(); checks.push(name); console.log('PASS ' + name) }
  catch (cause) { const error = name + ': ' + (cause instanceof Error ? cause.stack : String(cause)); failures.push(error); console.error('FAIL ' + error) }
}
async function click(name: string) { await page.getByRole('button', { name, exact: true }).evaluate((element: HTMLElement) => element.click()) }
async function snapshot() {
  return page.evaluate(() => {
    const view = document.querySelector('.app__view')
    return { route: location.hash, view: !!view, opacity: view ? getComputedStyle(view).opacity : '',
      cards: document.querySelectorAll('.home .card').length, loading: document.querySelector('.home__content')?.getAttribute('aria-busy'),
      dialog: !!document.querySelector('dialog[open]'), transitions: [...document.querySelectorAll('.page-enter-active,.page-leave-active')].map(element => element.className),
      visibility: document.visibilityState }
  })
}
async function visibleVideo(expected: number) {
  await until(async () => { const state = await snapshot(); return state.route === '#/video' && state.view && state.opacity === '1' && state.cards === expected && state.loading === 'false' }, 'visible video library')
}
function readState() {
  const reader = new DatabaseSync(database, { readOnly: true })
  try { return { active: reader.prepare("SELECT COUNT(*) AS n FROM resource WHERE kind='video' AND is_archived=0").get()?.n,
    journal: reader.prepare('SELECT status FROM video_organize_journal').all(),
    episodes: reader.prepare('SELECT path,description,position_sec FROM episode').all(), foreignKeys: reader.prepare('PRAGMA foreign_key_check').all(),
    task: reader.prepare("SELECT status,message,processed,total,percent FROM task_records WHERE title='Agent 整理 · 执行所选操作' ORDER BY started_at DESC LIMIT 1").get() }
  } finally { reader.close() }
}
try {
  app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env: environment, timeout: 30000 })
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  app.process().stdout?.on('data', (chunk: Buffer) => processLogs.push(chunk.toString()))
  app.process().stderr?.on('data', (chunk: Buffer) => processLogs.push(chunk.toString()))
  page = await app.firstWindow(); page.setDefaultTimeout(15000)
  page.on('pageerror', (cause: Error) => pageErrors.push(cause.message))
  // Playwright normally forces document.visibilityState to visible, even for a hidden native window.
  // Disable it on Playwright's own session: an additional CDP session cannot clear another session's override.
  const frameClient = page._connection.toImpl(page).delegate._mainFrameSession._client
  await frameClient.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await app.evaluate(({ BrowserWindow, ipcMain }: any) => {
    const win = BrowserWindow.getAllWindows()[0], fs = process.getBuiltinModule('node:fs') as any
    win.hide(); win.setSize(1280, 920)
    const metrics = { listCalls: 0, listMs: [] as number[], listSyncMs: [] as number[], statCalls: 0, readBytes: 0, maxMainDrift: 0, events: [] as unknown[] }
    ;(globalThis as any).__backgroundMetrics = metrics
    let inList = false, last = performance.now()
    const timer = setInterval(() => { const now = performance.now(); metrics.maxMainDrift = Math.max(metrics.maxMainDrift, now - last - 100); last = now }, 100)
    timer.unref()
    win.on('unresponsive', () => metrics.events.push('unresponsive'))
    win.webContents.on('render-process-gone', (_event: unknown, details: unknown) => metrics.events.push(details))
    const handler = ipcMain._invokeHandlers.get('video:list')
    ipcMain.removeHandler('video:list')
    ipcMain.handle('video:list', (...args: any[]) => {
      metrics.listCalls++; inList = true; const start = performance.now()
      try {
        const result = handler(...args)
        if (result?.then) return result.finally(() => metrics.listMs.push(performance.now() - start))
        metrics.listMs.push(performance.now() - start)
        return result
      } finally { metrics.listSyncMs.push(performance.now() - start); inList = false }
    })
    const stat = fs.statSync, read = fs.readFileSync
    fs.statSync = (...args: any[]) => { if (inList) metrics.statCalls++; return stat(...args) }
    fs.readFileSync = (...args: any[]) => { const data = read(...args); if (inList) metrics.readBytes += data.length; return data }
  })
  await until(() => page.evaluate(() => !!document.querySelector('.app__view')), 'application boot')
  await page.evaluate(() => { location.hash = '/video' })
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].showInactive())
  await visibleVideo(137)
  await check('a burst of library changes is coalesced instead of rescanning every file', async () => {
    await app.evaluate(({ BrowserWindow }: any) => {
      const metrics = (globalThis as any).__backgroundMetrics
      metrics.listCalls = 0; metrics.listMs = []; metrics.listSyncMs = []; metrics.statCalls = 0; metrics.readBytes = 0; metrics.maxMainDrift = 0
      for (let index = 0; index < 40; index++) BrowserWindow.getAllWindows()[0].webContents.send('video:library-changed', 'fixture-' + index)
    })
    await delay(1000)
    await until(() => page.evaluate(() => document.querySelector('.home__content')?.getAttribute('aria-busy') === 'false'), 'burst refresh', 90000)
    report.burst = await app.evaluate(() => (globalThis as any).__backgroundMetrics)
    assert.ok(report.burst.listCalls > 0, 'the visible library must consume the invalidation')
    assert.ok(report.burst.listCalls <= 3, `40 events caused ${report.burst.listCalls} full list calls`)
    assert.equal(report.burst.statCalls, 0, 'refreshing the list must not synchronously scan media files')
  })
  await check('hidden-window changes wait for one refresh when the window is shown again', async () => {
    let before = 0
    try {
      await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].hide())
      await until(() => page.evaluate(() => document.hidden), 'hidden document')
      before = await app.evaluate(() => (globalThis as any).__backgroundMetrics.listCalls)
      await app.evaluate(({ BrowserWindow }: any) => {
        for (let index = 0; index < 40; index++) BrowserWindow.getAllWindows()[0].webContents.send('video:library-changed', 'hidden-' + index)
      })
      await delay(500)
      assert.equal(await app.evaluate(() => (globalThis as any).__backgroundMetrics.listCalls), before)
    } finally { await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].showInactive()) }
    await until(async () => await app.evaluate(() => (globalThis as any).__backgroundMetrics.listCalls) > before, 'resumed refresh')
    await visibleVideo(137)
    const after = await app.evaluate(() => (globalThis as any).__backgroundMetrics.listCalls)
    assert.ok(after - before <= 2)
  })
  await click('批量管理'); await click('全选当前范围'); await click('Agent 整理')
  await page.getByRole('dialog', { name: 'Agent 整理', exact: true }).locator('select').selectOption('move')
  await page.getByLabel('刮削缺失封面', { exact: false }).evaluate((input: HTMLInputElement) => { if (input.checked) input.click() })
  await click('生成整理预览')
  await until(() => page.evaluate(() => document.querySelectorAll('.agent-group').length === 29 && !document.querySelector('.agent-progress')), '29-group preview')
  const started = Date.now(); await click('确认执行所选操作')
  await check('minimizing and restoring during confirmed organization keeps the window usable', async () => {
    await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].minimize())
    await delay(1500)
    await app.evaluate(({ BrowserWindow }: any) => {
      const win = BrowserWindow.getAllWindows()[0]
      setTimeout(() => { win.restore(); win.showInactive() }, 0)
      return true
    })
    await until(async () => await app.evaluate(({ BrowserWindow }: any) => !BrowserWindow.getAllWindows()[0].isMinimized()), 'restored native window')
    await until(() => page.evaluate(() => !!document.querySelector('.agent-organize[open] .agent-progress,.agent-organize[open] .agent-results')), 'restored Agent panel')
    report.restored = await snapshot()
    await captureHiddenElectron(app, path.join(evidence, 'restored-during-organization.png'))
  })
  await check('leaving the video route during organization and returning preserves its state', async () => {
    await click('关闭 Agent 整理')
    await page.evaluate(() => { location.hash = '/settings' })
    await until(() => page.evaluate(() => location.hash === '#/settings' && !!document.querySelector('.app__view') && !document.querySelector('.page-enter-active,.page-leave-active')), 'settings navigation')
    await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].hide())
    await delay(1500)
    await page.evaluate(() => { location.hash = '/video' })
    await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].showInactive())
    await until(() => page.evaluate(() => !!document.querySelector('.home__content') && !document.querySelector('.page-enter-active,.page-leave-active')), 'return to video')
    report.returned = await snapshot()
    assert.equal(report.returned.opacity, '1')
  })
  await check('29 background moves finish once and retain all episode details', async () => {
    await until(async () => { const state = readState(); return !!state.task && state.task.status !== 'running' }, 'background completion', 180000)
    report.durationMs = Date.now() - started; report.completed = readState()
    assert.equal(report.completed.task.status, 'success')
    assert.equal(report.completed.task.percent, 100)
    assert.equal(report.completed.active, 98)
    assert.equal(report.completed.journal.length, 29)
    assert.ok(report.completed.journal.every((journal: any) => journal.status === 'applied'))
    assert.equal(report.completed.episodes.length, 146)
    assert.ok(report.completed.episodes.every((episode: any) => episode.description === 'Original episode details' && episode.position_sec === 90))
    assert.equal(report.completed.episodes.filter((episode: any) => episode.path.startsWith(organized + path.sep)).length, 68)
    assert.deepEqual(report.completed.foreignKeys, [])
    await visibleVideo(98)
    await captureHiddenElectron(app, path.join(evidence, 'completed-after-return.png'))
  })
  report.metrics = await app.evaluate(() => (globalThis as any).__backgroundMetrics)
  await check('the main loop stays responsive and no renderer errors occur', async () => {
    assert.deepEqual(pageErrors, []); assert.deepEqual(report.metrics.events, [])
    assert.ok(report.metrics.maxMainDrift < 1500, `main loop was blocked for ${Math.round(report.metrics.maxMainDrift)} ms`)
  })
} catch (cause) {
  failures.push(cause instanceof Error ? cause.stack || cause.message : String(cause))
  console.error('FAIL background fixture: ' + failures.at(-1))
} finally {
  if (page) report.finalPage = await snapshot().catch(() => null)
  if (app) await app.close()
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  fs.writeFileSync(path.join(evidence, 'process.log'), processLogs.join(''))
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ ...report, checks, failures, pageErrors }, null, 2))
}
console.log(`Video Agent background packaged: ${checks.length} passed / ${failures.length} failed`)
process.exitCode = failures.length ? 1 : 0
