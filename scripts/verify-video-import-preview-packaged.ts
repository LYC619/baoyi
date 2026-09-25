/** Real Electron/SQLite/UI tests in an isolated profile with neutral synthetic media and Agent responses. */
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
import { pngImage } from './helpers/test-images.ts'
import { captureHiddenElectron } from './helpers/electron-capture.ts'
const require = createRequire(import.meta.url)
const runtime = 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { _electron } = require(runtime), { expect } = require(runtime + '/test')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-video-import-preview-20260913/win-unpacked/抱一.exe')
const evidence = path.resolve(process.argv[3] || 'output/video-import-preview-20260913/native')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-import-native-'))
fs.mkdirSync(evidence, { recursive: true })
const imports = path.join(profile, 'Import'), organized = path.join(profile, 'Organized')
fs.mkdirSync(imports); fs.mkdirSync(organized)
function file(relative: string, content = 'synthetic media fixture') {
  const target = path.resolve(profile, relative), inside = path.relative(profile, target)
  assert.ok(inside !== '..' && !inside.startsWith('..' + path.sep) && !path.isAbsolute(inside))
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target
}
for (const name of ['Alpha', 'Beta']) { file(`Import/${name}/${name}.mp4`); file(`Import/${name}/${name}.nfo`, `<movie><title>${name}</title><plot>Local ${name} description</plot></movie>`) }
file('Import/Unknown/Unknown.mp4')
let agentRequests = 0, groupingRequests = 0
const server = http.createServer((request, response) => {
  let body = ''; request.on('data', bytes => { body += bytes }); request.on('end', () => {
    try {
      const input = JSON.parse(body); agentRequests++
      const grouping = input.tools?.some((tool: any) => tool.function.name === 'propose_collections')
      const done = input.messages.some((message: any) => message.role === 'tool')
      let args: any = { name_zh: 'Native reviewed entry', category: '其他', summary: 'Reviewed fixture', description: 'Agent reviewed synthetic description', tags: ['Fixture'] }
      if (grouping) {
        groupingRequests++
        const works = JSON.parse(input.messages.find((message: any) => message.role === 'user').content)
        args = { groups: [{ resourceIds: works.filter((work: any) => work.title.startsWith('Morning')).map((work: any) => work.id), reason: 'Matching series prefix and distinct episode numbers' }] }
      }
      const message = done ? { role: 'assistant', content: '已完成所选预览' } : { role: 'assistant', content: null,
        tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: grouping ? 'propose_collections' : 'register_video', arguments: JSON.stringify(args) } }] }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message, finish_reason: done ? 'stop' : 'tool_calls' }], usage: { total_tokens: 40 } }))
    } catch (cause) { response.writeHead(500); response.end(String(cause)) }
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
const database = path.join(profile, 'baoyi.db'), db = new DatabaseSync(database)
db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, hide_hentai: false, theme: 'light', proxy: '', video_import_agent: false,
  ai: { enabled: true, api_key: 'synthetic-only', api_url: origin + '/v1', model: 'fixture' } })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value))
const source = (code: string) => ({ provider: 'hanime', externalId: code, scope: 'episode' as const, pageUrl: 'https://hanime1.me/watch?v=' + code, evidence: 'confirmed' as const })
function work(title: string, number = 1, code = '') {
  return registerVideoContent(db, { title, category: '动画', description: 'Original work description', items: [{ title, originalTitle: title, order: number, number,
    description: 'Original episode description', sources: code ? [source(code)] : [], watch: { status: 'watching', position: 75, watchedAt: 0 },
    files: [{ path: file(`Library/${title}/${title}.mp4`) }] }] }).resourceId
}
const manualIds = [work('Cloud E01'), work('Cloud E02', 2)]
const agentIds = [work('Morning E01', 1, '990001'), work('Morning E02', 2, '990002')]
work('Independent work')
const creator = registerVideoContent(db, { title: '作者内容样例', category: '里番', items: [
  { title: '已录入内容', order: 2, season: 1, number: 2, description: '只显示本地登记内容。', files: [{ path: file('Creator/Recorded.mp4') }] },
  { title: '文件缺失记录', order: 3, season: 1, number: 3, files: [{ path: path.join(profile, 'Creator/Missing.mp4') }] },
  ...Array.from({ length: 8 }, (_, i) => ({ title: '仅网站占位 ' + i, order: i + 4, season: 1, number: i + 4, files: [], sources: [source('99100' + i)] }))
] }).resourceId
db.close()
function stamp() { const reader = new DatabaseSync(database, { readOnly: true }); try { return videoImportLibraryStamp(reader) } finally { reader.close() } }
function libraryRows() {
  const reader = new DatabaseSync(database, { readOnly: true })
  try { return Object.fromEntries(['resource', 'video_meta', 'episode', 'video_assets', 'video_episode_assets', 'video_sources', 'video_directories', 'video_scan_state', 'video_scan_ignores', 'video_detached_owners', 'video_organize_journal'].map(table =>
    [table, reader.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) ? reader.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() : null])) }
  finally { reader.close() }
}
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
let app: any, page: any, draftId = '', unknownId = '', alphaId = ''
const checks: string[] = [], errors: string[] = [], report: Record<string, unknown> = { executable, profile, usesLiveSite: false }
async function launch() {
  app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env: environment, timeout: 30000 })
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', (cause: Error) => errors.push(cause.message))
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].hide())
  await page.waitForFunction(() => !!(window as any).baoyi?.videoImport)
  await page.locator('.app__view').waitFor()
  // Native hidden windows can stop the animation frames needed by routing and pointer actions.
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].showInactive())
}
async function route(hash: string) {
  await page.evaluate((hash: string) => { location.hash = hash }, hash)
  await page.waitForFunction(() => !document.querySelector('.page-enter-active,.page-leave-active') && !document.querySelector('.detail__state')?.textContent?.includes('载入中'))
  if (hash === '/video') { await page.locator('.home__content[aria-busy=false] .card').first().waitFor() }
}
const getDraft = () => page.evaluate((id: string) => (window as any).baoyi.videoImport.get(id), draftId)
async function check(name: string, run: () => Promise<void>) { await run(); checks.push(name); console.log('PASS ' + name) }
try {
  await launch(); await route('/video')
  await check('native preview clones SQLite without writing resources or calling Agent', async () => {
    const before = stamp(), batch = await page.evaluate((root: string) => (window as any).baoyi.videoImport.prepare([root]), imports)
    report.initialPreview = batch
    report.libraryBeforeReview = libraryRows()
    assert.equal(stamp(), before); assert.equal(agentRequests, 0); assert.equal(batch.entries.length, 3)
    draftId = batch.id; unknownId = batch.entries.find((entry: any) => entry.status === 'review').id; alphaId = batch.entries.find((entry: any) => entry.title === 'Alpha').id
    assert.equal(batch.entries.filter((entry: any) => entry.selected).length, 2)
    assert.ok(!fs.existsSync(path.join(imports, 'Alpha/baoyi.json')))
  })
  await check('import dialog supports Shift selection, row review and editing without replacing the batch', async () => {
    await page.getByRole('button', { name: /^导入待确认/ }).click()
    const panel = page.getByRole('dialog', { name: '视频导入确认' })
    await expect(panel.locator('.import-list li')).toHaveCount(3)
    await panel.getByRole('button', { name: '全选 / 取消当前列表', exact: true }).click()
    await panel.getByRole('button', { name: '全选 / 取消当前列表', exact: true }).click()
    await expect(panel.locator('.import-list input:checked')).toHaveCount(0)
    const boxes = panel.locator('.import-list input[type=checkbox]')
    await boxes.nth(0).click(); await boxes.nth(2).click({ modifiers: ['Shift'] })
    await expect(panel.locator('.import-list input:checked')).toHaveCount(3)
    const before = stamp(), originals = (await getDraft()).entries.filter((entry: any) => entry.id !== unknownId).map((entry: any) => [entry.id,entry.title])
    await panel.locator('.import-list li').filter({ hasText: 'Unknown' }).getByRole('button').click()
    await panel.getByRole('button', { name: 'Agent 复查此项', exact: true }).click()
    await expect(panel.getByLabel('名称', { exact: true })).toHaveValue('Native reviewed entry')
    assert.deepEqual((await getDraft()).entries.filter((entry: any) => entry.id !== unknownId).map((entry: any) => [entry.id,entry.title]), originals)
    assert.equal(stamp(), before)
    await panel.getByLabel('名称', { exact: true }).fill('人工确认样例')
    await panel.getByRole('button', { name: '保存修改', exact: true }).click()
    await captureHiddenElectron(app, path.join(evidence, 'import-confirm.png'))
    await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(980, 780))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await captureHiddenElectron(app, path.join(evidence, 'import-confirm-980.png'))
    await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(1280, 920))
    await panel.getByRole('button', { name: '关闭导入确认', exact: true }).click()
  })
  await check('confirming one row preserves other rows and repeated confirmation is idempotent', async () => {
    const batch = await page.evaluate(({ id, row }: any) => (window as any).baoyi.videoImport.confirm(id, [row]), { id: draftId, row: alphaId })
    assert.equal(batch.entries.filter((entry: any) => entry.status === 'confirmed').length, 1)
    const before = stamp()
    await page.evaluate(({ id, row }: any) => (window as any).baoyi.videoImport.confirm(id, [row]), { id: draftId, row: alphaId })
    assert.equal(stamp(), before); assert.equal((await getDraft()).entries.length, 3)
  })
  await app.close(); app = undefined; await launch(); await route('/video')
  await check('restart recovers the same draft, edits, row IDs and logs', async () => {
    const restored = await getDraft(); assert.equal(restored.entries.length, 3)
    assert.equal(restored.entries.find((entry: any) => entry.id === unknownId).title, '人工确认样例')
    assert.ok(restored.entries.find((entry: any) => entry.id === unknownId).log.includes('Agent'))
    await page.getByRole('button', { name: /^导入待确认/ }).click()
    await expect(page.getByRole('dialog', { name: '视频导入确认' }).locator('.import-list li')).toHaveCount(3)
    await page.keyboard.press('Escape')
  })
  await check('a moved file blocks stale confirmation without losing the draft', async () => {
    const batch = await getDraft(), beta = batch.entries.find((entry: any) => entry.title === 'Beta'), before = stamp()
    const old = path.join(imports, 'Beta/Beta.mp4'); fs.renameSync(old, old + '.moved')
    await assert.rejects(page.evaluate(({ id, row }: any) => (window as any).baoyi.videoImport.confirm(id, [row]), { id: draftId, row: beta.id }), /文件|变化/)
    assert.equal(stamp(), before); assert.equal((await getDraft()).entries.length, 3)
  })
  await check('only recorded content is displayed, missing files stay visible, and hentai has no season labels', async () => {
    await route('/video/' + creator)
    await expect(page.locator('.video-item')).toHaveCount(2)
    await page.getByRole('button', { name: '检查文件', exact: true }).click()
    await expect(page.locator('.video-item')).toHaveCount(2)
    await expect(page.getByRole('tab', { name: /作品内容/ })).toContainText('2')
    await page.getByRole('tab', { name: '剧情简介', exact: true }).click()
    await page.getByRole('group', { name: '选择简介范围', exact: true }).getByRole('button', { name: '第 2 集', exact: true }).click()
    await expect(page.locator('.episode-reading__head h2').first()).toHaveText('第 2 集')
    await captureHiddenElectron(app, path.join(evidence, 'recorded-only-no-seasons.png'))
  })
  await check('library batch selection supports Shift and exposes the unassigned collection group', async () => {
    await route('/video')
    await expect(page.locator('.sidebar .row__label').filter({ hasText: /^未设置$/ })).toHaveCount(1)
    await page.getByRole('button', { name: '创建合集', exact: true }).click()
    const cards = page.locator('.card[aria-label^="选择作品："]')
    await cards.nth(1).click(); await cards.nth(4).click({ modifiers: ['Shift'] })
    await expect(page.locator('.card[aria-pressed=true]')).toHaveCount(4)
    await page.getByRole('button', { name: '取消选择', exact: true }).click()
  })
  await check('settings saves the organizer root; manual merge derives a name and moves into its child folder', async () => {
    await app.evaluate(({ dialog }: any, directory: string) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, organized)
    await route('/settings?tab=scan')
    await page.getByRole('button', { name: '设置整理根目录', exact: true }).click()
    assert.equal((await page.evaluate(() => (window as any).baoyi.settings.getAll())).video_organize_root, organized)
    await route('/video')
    await page.getByRole('button', { name: '创建合集', exact: true }).click()
    for (const title of ['Cloud E01', 'Cloud E02']) await page.getByRole('button', { name: '选择作品：' + title, exact: true }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '组建合集', exact: true })
    await expect(panel.getByLabel('合集名称', { exact: true })).toHaveValue('Cloud 1-2')
    await panel.getByRole('radio', { name: '移动', exact: true }).check()
    const button = panel.getByRole('button', { name: '创建合集并移动文件', exact: true }); await expect(button).toBeEnabled()
    await expect(panel.locator('.organize-preview__target')).toContainText(path.join(organized, 'Cloud 1-2'))
    await captureHiddenElectron(app, path.join(evidence, 'collection-directory-preview.png'))
    await button.click(); await expect(panel.locator('.organize-journal__status').first()).toHaveText('已完成')
    const library = await page.evaluate((id: string) => (window as any).baoyi.video.library(id), manualIds[0])
    assert.equal(library.contents.length, 2); assert.ok(library.contents.every((episode: any) => episode.path.startsWith(path.join(organized, 'Cloud 1-2')) && fs.existsSync(episode.path)))
    await panel.getByRole('button', { name: '关闭整理面板', exact: true }).click()
    await page.getByRole('button', { name: '取消选择', exact: true }).click()
  })
  await check('Agent organizer previews selected groups and fills artwork without rewriting episode metadata', async () => {
    await app.evaluate(async ({ session }: any, fixture: any) => {
      await session.fromPartition('persist:hanime-network').protocol.handle('https', (request: Request) => {
        const url = new URL(request.url)
        if (url.hostname !== 'hanime1.me') return new Response('External access blocked by synthetic fixture', { status: 451 })
        if (url.pathname.startsWith('/image/')) return new Response(Buffer.from(url.pathname.includes('portrait') ? fixture.portrait : fixture.landscape, 'base64'), { headers: { 'Content-Type': 'image/png' } })
        const code = url.searchParams.get('v') || '990001'
        return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta property="og:url" content="https://hanime1.me/watch?v=${code}"><meta property="og:image" content="https://hanime1.me/image/portrait.png"></head><body><h1 id="shareBtn-title">Morning ${code === '990001' ? 1 : 2}</h1><div class="video-details-wrapper"><div>合成站点资料</div><div class="video-caption-text">This description must not replace existing user metadata.</div></div><video id="player" poster="https://hanime1.me/image/landscape.png"></video></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      })
    }, { portrait: pngImage(180, 270).toString('base64'), landscape: pngImage(320, 180).toString('base64') })
    await route('/video'); await page.getByRole('button', { name: '批量管理', exact: true }).click()
    for (const title of ['Morning E01', 'Morning E02']) await page.getByRole('button', { name: '选择作品：' + title, exact: true }).click()
    await page.getByRole('button', { name: 'Agent 整理', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Agent 整理', exact: true }), before = stamp()
    await panel.getByRole('button', { name: '生成整理预览', exact: true }).click()
    await expect(panel.locator('.agent-group > label > strong')).toHaveText('Morning 1-2')
    assert.equal(stamp(), before)
    await captureHiddenElectron(app, path.join(evidence, 'agent-organize-preview.png'))
    await panel.getByRole('button', { name: '确认执行所选操作', exact: true }).click()
    await expect(panel.locator('.agent-results')).toBeVisible({ timeout: 45000 })
    const library = await page.evaluate((id: string) => (window as any).baoyi.video.library(id), agentIds[0])
    assert.equal(library.contents.length, 2)
    assert.ok(library.contents.every((episode: any) => episode.description === 'Original episode description' && episode.position_sec === 75))
    assert.ok(library.contents.every((episode: any) => episode.poster_path && fs.existsSync(episode.poster_path)), JSON.stringify(library.contents.map((episode: any) => ({ title: episode.title, poster: episode.poster_path }))))
    assert.equal(groupingRequests, 1, 'a successful submission must not need a second model request')
    await captureHiddenElectron(app, path.join(evidence, 'agent-organize-results.png'))
    await panel.getByRole('button', { name: '完成', exact: true }).click()
  })
  assert.deepEqual(errors, []); report.status = 'passed'
} catch (cause) {
  report.status = 'failed'; report.error = cause instanceof Error ? cause.stack : String(cause); process.exitCode = 1
  console.error('FAIL native import preview:', report.error)
  report.libraryAfterFailure = libraryRows()
  if (page) { await captureHiddenElectron(app, path.join(evidence, 'failure.png')).catch(() => {}); report.draft = await getDraft().catch(() => null) }
} finally {
  if (app) await app.close()
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ ...report, checks, errors, agentRequests, groupingRequests }, null, 2))
}
console.log(`Native video import/organization: ${checks.length} passed / ${process.exitCode ? 1 : 0} failed`)
