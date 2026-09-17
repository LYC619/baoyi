/** Packaged Electron, isolated SQLite profile, neutral media and a loopback-only model fixture. */
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
import { videoImportLibraryStamp } from '../electron/kinds/video/import-command.ts'
import { captureHiddenElectron } from './helpers/electron-capture.ts'

const require = createRequire(import.meta.url)
const runtime = 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { _electron } = require(runtime), { expect } = require(runtime + '/test')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-video-agent-grouping-20260913/win-unpacked/抱一.exe')
const evidence = path.resolve(process.argv[3] || 'output/video-agent-grouping-20260913/native')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-grouping-native-')), organized = path.join(profile, 'Organized')
fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(organized)
let mode: 'valid' | 'mixed' | 'text' | 'json' | 'invalid' = 'valid'
const requests: { mode: string; count: number; toolChoice: string; ids: string[] }[] = []
const server = http.createServer((request, response) => {
  let body = ''; request.on('data', bytes => { body += bytes }); request.on('end', () => {
    try {
      const input = JSON.parse(body), works = JSON.parse(input.messages.find((message: any) => message.role === 'user').content)
      const families = new Map<string, string[]>()
      for (const work of works) families.set(work.series.title, [...(families.get(work.series.title) || []), work.id])
      const groups = [...families.values()].filter(ids => ids.length > 1).map(resourceIds => ({ resourceIds, reason: 'Matching series name and distinct episode numbers' }))
      if (mode === 'mixed') groups.unshift({ resourceIds: [works[0].id, 'outside-selection'], reason: 'Intentionally invalid fixture' })
      requests.push({ mode, count: works.length, toolChoice: input.tool_choice, ids: works.map((work: any) => work.id) })
      const message = mode === 'text' ? { content: '本轮仅回复说明，尚未提交分组。' }
        : mode === 'json' ? { content: '```json\n' + JSON.stringify({ groups }) + '\n```' }
          : { content: null, tool_calls: [{ id: 'fixture-call-' + requests.length, type: 'function', function: { name: 'propose_collections', arguments: mode === 'invalid' ? '{"groups":[' : JSON.stringify({ groups }) } }] }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 40 } }))
    } catch (cause) { response.writeHead(500); response.end(String(cause)) }
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const database = path.join(profile, 'baoyi.db'), db = new DatabaseSync(database)
db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
const origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
for (const [key, value] of Object.entries({ onboarded: true, hide_hentai: false, theme: 'light', proxy: '', video_import_agent: false, video_organize_root: organized,
  ai: { enabled: true, api_key: 'synthetic-only', api_url: origin + '/v1', model: 'fixture' } })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value))
const candidateFiles: string[] = [], independentFiles: string[] = []
function work(title: string, count = 1, candidate = false) {
  return registerVideoContent(db, { title, category: '动画', items: Array.from({ length: count }, (_, i) => {
    const target = path.resolve(profile, 'Library', title, `${title}-${i + 1}.mp4`), inside = path.relative(profile, target)
    assert.ok(inside !== '..' && !inside.startsWith('..' + path.sep) && !path.isAbsolute(inside))
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'synthetic media')
    ;(candidate ? candidateFiles : independentFiles).push(target)
    return { title: count === 1 ? title : `Recorded episode ${i + 1}`, order: i + 1, number: i + 1,
      description: 'Keep original episode details', watch: { status: 'watching' as const, position: 90, watchedAt: 0 }, files: [{ path: target }] }
  }) }).resourceId
}
const ids: string[] = [], sizes = [6, 4, 4, 3, 3, ...Array(24).fill(2)]
sizes.forEach((count, series) => { for (let n = 1; n <= count; n++) ids.push(work(`Series ${String(series + 1).padStart(2, '0')} E${String(n).padStart(2, '0')}`, 1, true)) })
for (let i = 0; i < 9; i++) ids.push(work(`Existing ${i} E01`, 2))
for (let i = 0; i < 60; i++) ids.push(work(i < 9 ? `Existing ${i} E03` : `Independent [${i}]`))
assert.equal(ids.length, 137); db.close()
function read<T>(run: (db: DatabaseSync) => T): T { const reader = new DatabaseSync(database, { readOnly: true }); try { return run(reader) } finally { reader.close() } }
const stamp = () => read(videoImportLibraryStamp)
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
let app: any, page: any, dialog: any
const checks: string[] = [], errors: string[] = [], report: Record<string, unknown> = { executable, profile, syntheticInput: true, usesLiveSite: false }
async function launch() {
  app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env: environment, timeout: 30000 })
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', (cause: Error) => errors.push(cause.message))
  await app.evaluate(({ BrowserWindow }: any) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false); window.hide(); window.setSize(1280, 920)
  })
  await page.waitForFunction(() => !!(window as any).baoyi?.videoAgentOrganize)
  await page.locator('.app__view').waitFor()
  await page.evaluate(() => { location.hash = '/video' })
  await page.waitForFunction(() => !document.querySelector('.page-enter-active,.page-leave-active'))
  await page.locator('.home__content[aria-busy=false] .card').first().waitFor()
}
async function selectAll() {
  await page.getByRole('button', { name: '批量管理', exact: true }).click()
  await page.getByRole('button', { name: '全选当前范围', exact: true }).click()
  await page.getByRole('button', { name: 'Agent 整理', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Agent 整理', exact: true })
  await expect(dialog.locator('header p')).toContainText('137')
  await dialog.locator('select').selectOption('move')
}
async function generate(retry = false) {
  await dialog.getByRole('button', { name: retry ? '重新生成预览' : '生成整理预览', exact: true }).click()
  await expect(dialog.locator('.agent-plan-heading')).toBeVisible({ timeout: 45000 })
  await expect(dialog.getByRole('button', { name: '停止后续处理', exact: true })).toHaveCount(0)
}
async function taskHistory() { return page.evaluate(() => (window as any).baoyi.tasks.list()) }
async function check(name: string, run: () => Promise<void>) { await run(); checks.push(name); console.log('PASS ' + name) }
try {
  await launch(); await selectAll()
  const before = stamp()
  await check('137-work packaged preview uses three bounded submissions and makes no library or file changes', async () => {
    await generate()
    await expect(dialog.locator('.agent-group')).toHaveCount(29)
    await expect(dialog.locator('.agent-warnings')).toHaveCount(0)
    assert.equal(requests.length, 3); assert.equal(requests.reduce((n, request) => n + request.count, 0), 68)
    assert.ok(requests.every(request => request.count <= 24 && request.toolChoice === 'required' && request.ids.every(id => /^w\d+$/.test(id))))
    assert.equal(stamp(), before); assert.ok([...candidateFiles, ...independentFiles].every(file => fs.existsSync(file)))
    await captureHiddenElectron(app, path.join(evidence, 'bulk-preview-137.png'))
  })
  await check('text-only failures show model diagnostics and preserve the artwork confirmation option', async () => {
    mode = 'text'; await dialog.getByRole('button', { name: '重新选择操作', exact: true }).click(); await generate()
    await expect(dialog.locator('.agent-warnings')).toContainText('分组分析未完成')
    await expect(dialog.getByRole('button', { name: '确认执行所选操作', exact: true })).toBeEnabled()
    await dialog.locator('.agent-log summary').click(); await expect(dialog.locator('.agent-log pre')).toContainText('本轮仅回复说明')
    const history = await taskHistory(), task = history.find((task: any) => task.title === 'Agent 整理 · 生成预览')
    assert.equal(task.status, 'failed'); assert.ok(task.events.some((event: any) => event.message.includes('本轮仅回复说明')))
    assert.equal(stamp(), before)
    await captureHiddenElectron(app, path.join(evidence, 'model-reply-diagnostics.png'))
  })
  await check('mixed valid and invalid proposals retain all 29 safe suggestions', async () => {
    mode = 'mixed'; await generate(true)
    await expect(dialog.locator('.agent-group')).toHaveCount(29)
    await expect(dialog.locator('.agent-warnings')).toContainText('本批所选')
    await expect(dialog.locator('.agent-group > label > input:checked')).toHaveCount(29)
    assert.equal(stamp(), before)
    await captureHiddenElectron(app, path.join(evidence, 'partial-groups-retained.png'))
  })
  await check('whole structured JSON responses produce the same validated previews', async () => {
    mode = 'json'; await generate(true)
    await expect(dialog.locator('.agent-group')).toHaveCount(29); await expect(dialog.locator('.agent-warnings')).toHaveCount(0)
    await expect(dialog.locator('.agent-log pre')).toContainText('完整 JSON')
    assert.equal(stamp(), before)
  })
  await check('invalid tool JSON is retained with the loop stop reason in persistent task logs', async () => {
    mode = 'invalid'; await dialog.getByRole('button', { name: '重新选择操作', exact: true }).click(); await generate()
    await expect(dialog.locator('.agent-warnings')).toContainText('分组分析未完成')
    await expect(dialog.locator('.agent-log pre')).toContainText('参数不是合法的 JSON')
    await expect(dialog.locator('.agent-log pre')).toContainText('模型结束：error')
    await dialog.locator('.agent-log summary').click()
    assert.equal(stamp(), before)
    await captureHiddenElectron(app, path.join(evidence, 'tool-validation-diagnostics.png'))
  })
  await app.close(); app = undefined; await launch()
  await check('restart preserves detailed failure logs without touching the selected videos', async () => {
    const history = await taskHistory()
    assert.ok(history.some((task: any) => task.status === 'failed' && task.events.some((event: any) => event.message.includes('参数不是合法的 JSON'))))
    assert.ok(history.some((task: any) => task.events.some((event: any) => event.message.includes('本轮仅回复说明'))))
    assert.equal(stamp(), before)
  })
  await check('confirmed batch moves all 29 collections into named children while preserving episode data', async () => {
    mode = 'valid'; await selectAll(); await dialog.getByLabel('刮削缺失封面', { exact: false }).uncheck(); await generate()
    await expect(dialog.locator('.agent-group > label > input:checked')).toHaveCount(29)
    await dialog.getByRole('button', { name: '确认执行所选操作', exact: true }).click()
    await expect(dialog.locator('.agent-results')).toBeVisible({ timeout: 180000 })
    await expect(dialog.locator('.agent-results li')).toHaveCount(29)
    await expect(dialog.locator('.agent-results .agent-error')).toHaveCount(0)
    const state = read(reader => ({ active: reader.prepare("SELECT COUNT(*) AS n FROM resource WHERE kind='video' AND is_archived=0").get(),
      episodes: reader.prepare('SELECT path, description, position_sec FROM episode').all(), journal: reader.prepare('SELECT status FROM video_organize_journal').all(),
      foreignKeys: reader.prepare('PRAGMA foreign_key_check').all() }))
    assert.equal(state.active?.n, 98); assert.equal(state.journal.length, 29); assert.ok(state.journal.every(row => row.status === 'applied'))
    assert.equal(state.episodes.length, 146); assert.ok(state.episodes.every(row => row.description === 'Keep original episode details' && row.position_sec === 90))
    assert.equal(state.episodes.filter(row => String(row.path).startsWith(organized + path.sep)).length, 68)
    assert.equal(fs.readdirSync(organized).length, 29); assert.ok(candidateFiles.every(file => !fs.existsSync(file)))
    assert.ok(independentFiles.every(file => fs.existsSync(file))); assert.deepEqual(state.foreignKeys, [])
    await captureHiddenElectron(app, path.join(evidence, 'batch-move-results.png')); report.applied = state
  })
  assert.deepEqual(errors, []); report.status = 'passed'
} catch (cause) {
  report.status = 'failed'; report.error = cause instanceof Error ? cause.stack : String(cause); process.exitCode = 1
  console.error('FAIL packaged grouping:', report.error)
  if (page) {
    report.page = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 5000) })).catch(() => null)
    report.screenshotCaptured = await captureHiddenElectron(app, path.join(evidence, 'failure.png')).then(() => true, () => false)
  }
} finally {
  if (app) await app.close()
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ ...report, checks, errors, requests }, null, 2))
}
console.log(`Packaged video Agent grouping: ${checks.length} passed / ${process.exitCode ? 1 : 0} failed`)
