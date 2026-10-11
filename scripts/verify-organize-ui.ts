/** Real Electron/SQLite/IPC checks, isolated profile and synthetic programs only. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
// npm run verify-organize-ui -- <packaged.exe> [evidence-directory]
const packagedExecutable = process.argv[2] ? path.resolve(process.argv[2]) : null
const expectedVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version
const output = path.resolve(process.argv[3] || 'output/software-library-20261011')
fs.mkdirSync(output, { recursive: true })
const run = fs.mkdtempSync(path.join(output, 'run-')), profile = path.join(run, 'profile'), root = path.join(run, 'library')
fs.mkdirSync(profile); fs.mkdirSync(root)
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', organize_root: root, hanime_builtin_hosts: false, hide_hentai: true, ai: { enabled: false } })) {
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
}
function directory(dir: string) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'app.exe'), 'synthetic fixture - never execute'); return dir }
function record(id: string, dir: string, target = '', archived = false) {
  db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,source_dir,name_zh,category,notes,is_archived,ai_status) VALUES(?,'software',1,1,?,'app.exe',?,?,'Old','preserve user notes',?,'done')").run(id, path.join(dir, 'app.exe'), dir, id, Number(archived))
  db.prepare("INSERT INTO software_meta(resource_id,is_portable,move_risk,link_target,launchers) VALUES(?,1,'safe',?,?)").run(id, target, JSON.stringify([{ path: path.join(dir, 'app.exe'), label: 'Main', kind: 'main', is_default: true }]))
}
const real = directory(path.join(root, 'Old', 'RealTool')); record('RealTool', real)
const installed = directory(path.join(run, 'installed')), linked = path.join(root, 'Old', 'LinkedTool')
fs.symlinkSync(installed, linked, 'junction'); record('LinkedTool', linked, installed)
const archive = directory(path.join(root, 'Old', 'ArchiveTool')); record('ArchiveTool', archive, '', true)
const manual = directory(path.join(root, 'AI相关', 'NewTool'))
fs.mkdirSync(path.join(root, 'Empty'))
const orphanTarget = directory(path.join(run, 'orphan-target')), orphan = path.join(root, 'Old', 'Orphan')
fs.symlinkSync(orphanTarget, orphan, 'junction')
const broken = path.join(root, 'Old', 'Broken'); fs.symlinkSync(path.join(run, 'missing'), broken, 'junction'); record('Broken', broken, path.join(run, 'missing'))
const reinstalled = directory(path.join(root, 'Old', 'ReinstalledTool')); record('ReinstalledTool', reinstalled, path.join(run, 'old-install-location'))
const uninstalled = directory(path.join(root, 'Old', 'UninstalledTool')); record('UninstalledTool', uninstalled); fs.unlinkSync(path.join(uninstalled, 'app.exe'))
db.prepare("UPDATE software_meta SET is_portable=0, move_risk='risky' WHERE resource_id IN ('ReinstalledTool','UninstalledTool')").run()
for (let i = 0; i < 18; i++) record('Filler' + i, directory(path.join(root, 'Old', 'Filler' + i)))
db.close()

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const bootstrap = path.join(profile, 'launch.cjs')
if (!packagedExecutable) fs.writeFileSync(bootstrap, 'const {BrowserWindow}=require("electron"); BrowserWindow.prototype.show=BrowserWindow.prototype.showInactive; require(' + JSON.stringify(path.resolve('dist-electron/main.js')) + ');')
const app = await _electron.launch({ executablePath: packagedExecutable || path.resolve('node_modules/electron/dist/electron.exe'), args: [...(packagedExecutable ? [] : [bootstrap]), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
let page: any
let runtime: { version: string; isPackaged: boolean; appPath: string } | null = null
let acceptDialogs = true
const results: string[] = [], errors: string[] = []
async function check(name: string, fn: () => Promise<void>) { await fn(); results.push(name); console.log('PASS ' + name) }
async function ready() {
  await page.waitForFunction(() => {
    const refresh = document.querySelector<HTMLButtonElement>('.head__sync')
    return refresh && !refresh.disabled && !document.querySelector('.state')?.textContent?.includes('正在同步')
  })
  await page.waitForFunction(() => !document.querySelector('.page-enter-active,.page-leave-active'))
}
async function organize() { await page.evaluate(() => { location.hash = '/organize' }); await page.waitForSelector('.organize-tabs'); await ready() }
async function sync() { await page.getByRole('button', { name: '同步整理目录', exact: true }).click(); await ready() }
async function screenshot(name: string) {
  const png = await app.evaluate(async ({ BrowserWindow }: any) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(run, name + '.png'), Buffer.from(png, 'base64'))
}
try {
  page = await app.firstWindow(); page.setDefaultTimeout(10000)
  page.on('pageerror', (e: Error) => errors.push(e.message)); page.on('dialog', (dialog: any) => acceptDialogs ? dialog.accept() : dialog.dismiss())
  assert.equal(path.resolve(await app.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  runtime = await app.evaluate(({ app }: any) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath() }))
  if (packagedExecutable) {
    assert.equal(runtime!.isPackaged, true, 'release validation must run the packaged application')
    assert.equal(runtime!.version, expectedVersion)
    assert.equal(path.resolve(runtime!.appPath), path.join(path.dirname(packagedExecutable), 'resources', 'app.asar'))
  }
  await app.evaluate(({ BrowserWindow }: any) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.setBackgroundThrottling(false); w.setSize(1120, 780); w.showInactive() })
  await page.waitForFunction(() => !!window.baoyi?.organize)
  await organize()
  await check('folder categories and new software sync through real IPC', async () => {
    const cats = await page.evaluate(() => window.baoyi.categories.list('software'))
    assert.ok(cats.some((c: any) => c.name === 'AI相关')); assert.ok(cats.some((c: any) => c.name === 'Empty'))
    const items = await page.evaluate(() => window.baoyi.software.list())
    const added = items.find((r: any) => r.source_dir === manual)
    assert.equal(added?.category, 'AI相关'); assert.equal(added?.ai_status, 'pending')
    const report = await page.evaluate(() => window.baoyi.organize.sync())
    assert.equal(report.software_added.length, 0, 'second sync must be idempotent')
    assert.equal(report.orphan_links.length, 1)
  })
  await page.getByRole('button', { name: /^已整理/ }).click()
  await check('organized view includes archived, missing links and scrollable final rows', async () => {
    assert.equal(await page.locator('.organized-item').count(), 25)
    assert.ok(await page.locator('.organized-item').filter({ has: page.locator('.item-title', { hasText: 'ArchiveTool' }) }).textContent().then((s: string) => s.includes('已归档')))
    assert.ok((await page.locator('.organized-item').filter({ has: page.locator('.item-title', { hasText: 'Broken' }) }).textContent()).includes('链接目标已失效'))
    const last = page.locator('.organized-item').last(); await last.scrollIntoViewIfNeeded()
    assert.ok(await page.locator('.organize .body').evaluate((el: HTMLElement) => el.scrollTop > 0))
    await screenshot('organized-list')
  })
  await check('portable, linked, installed and unknown software have distinct filters', async () => {
    const filters = page.getByRole('group', { name: '软件类型筛选' })
    await filters.getByRole('button', { name: /^绿色软件/ }).click()
    assert.equal(await page.locator('.organized-item .badge--portable').count(), 20)
    await filters.getByRole('button', { name: /^链接软件/ }).click()
    assert.equal(await page.locator('.organized-item').count(), 2)
    await filters.getByRole('button', { name: /^安装版/ }).click()
    assert.equal(await page.locator('.organized-item').count(), 2)
    await filters.getByRole('button', { name: /^类型待确认/ }).click()
    assert.equal(await page.locator('.organized-item').count(), 1)
    await filters.getByRole('button', { name: /^全部/ }).click()
  })
  await check('reinstall over an old junction clears link state; missing executable recovers at the same path', async () => {
    const item = await page.evaluate(() => window.baoyi.software.get('ReinstalledTool'))
    assert.equal(item.link_target, ''); assert.equal(item.source_dir, reinstalled); assert.equal(item.is_portable, false)
    const row = page.locator('.organized-item').filter({ has: page.locator('.item-title', { hasText: 'UninstalledTool' }) })
    assert.ok((await row.textContent()).includes('主程序已不存在'))
    const preview = await page.evaluate(() => window.baoyi.organize.previewRelocate('ReinstalledTool', 'AI相关', 'ReinstalledTool'))
    assert.ok(preview.warning?.includes('卸载程序'))
    fs.writeFileSync(path.join(uninstalled, 'app.exe'), 'reinstalled fixture')
    await sync()
    const recovered = await page.evaluate(() => window.baoyi.software.get('UninstalledTool'))
    assert.equal(recovered.notes, 'preserve user notes')
    assert.equal((await row.textContent()).includes('主程序已不存在'), false)
  })
  await check('relocation previews exact path before moving and preserves record identity', async () => {
    let row = page.locator('.organized-item').filter({ has: page.locator('.item-title', { hasText: 'RealTool' }) })
    await row.getByRole('button', { name: '重新归置', exact: true }).click()
    await row.getByLabel('重新归置目标分类').fill('AI相关'); await row.getByLabel('重新归置文件夹名').fill('RealRenamed')
    await row.getByRole('button', { name: '预览位置', exact: true }).click()
    await row.getByRole('button', { name: '确认重新归置', exact: true }).waitFor()
    assert.ok(fs.existsSync(real)); assert.equal(fs.existsSync(path.join(root, 'AI相关', 'RealRenamed')), false)
    await screenshot('relocate-preview')
    await row.getByRole('button', { name: '确认重新归置', exact: true }).click(); await ready()
    const item = await page.evaluate(() => window.baoyi.software.get('RealTool'))
    assert.equal(item.category, 'AI相关'); assert.equal(item.source_dir, path.join(root, 'AI相关', 'RealRenamed'))
    assert.equal(item.notes, 'preserve user notes'); assert.equal(item.launchers[0].path, item.exe_path)
    assert.equal(fs.existsSync(real), false)
  })
  await check('external folder move repairs identity and category', async () => {
    const from = path.join(root, 'AI相关', 'RealRenamed'), to = path.join(root, 'Old', 'RealRenamed')
    fs.renameSync(from, to); await sync()
    const item = await page.evaluate(() => window.baoyi.software.get('RealTool'))
    assert.equal(item.source_dir, to); assert.equal(item.category, 'Old'); assert.equal(item.notes, 'preserve user notes')
  })
  await check('detail category cancellation keeps paths; confirmation moves the folder', async () => {
    await page.evaluate(() => { location.hash = '/detail/RealTool' })
    const select = page.locator('.hero__row > select'); await select.waitFor()
    acceptDialogs = false; await select.selectOption('AI相关')
    await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>('.hero__row > select')?.disabled)
    assert.equal(await select.inputValue(), 'Old'); assert.ok(fs.existsSync(path.join(root, 'Old', 'RealRenamed')))
    acceptDialogs = true; await select.selectOption('AI相关')
    await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>('.hero__row > select')?.disabled)
    assert.equal(await select.inputValue(), 'AI相关'); assert.ok(fs.existsSync(path.join(root, 'AI相关', 'RealRenamed')))
    await organize(); await page.getByRole('button', { name: /^已整理/ }).click()
  })
  await check('orphan cleanup UI removes only chosen junction', async () => {
    await page.locator('.orphan-links summary').click()
    await page.locator('.orphan-links input[type=checkbox]').check()
    await page.getByRole('button', { name: /清理所选 1 个链接/ }).click(); await ready()
    assert.equal(fs.existsSync(orphan), false); assert.ok(fs.existsSync(path.join(orphanTarget, 'app.exe')))
  })
  await check('unlink refreshes only its row, preserves search and filter, and restores pending visibility', async () => {
    const waiting = directory(path.join(root, 'Old', 'WaitingForManualSync'))
    await page.getByRole('group', { name: '软件类型筛选' }).getByRole('button', { name: /^链接软件/ }).click()
    await page.getByLabel('搜索已整理软件').fill('LinkedTool')
    const row = page.locator('.organized-item').filter({ has: page.locator('.item-title', { hasText: 'LinkedTool' }) })
    await row.getByRole('button', { name: '移除链接', exact: true }).click(); await ready()
    assert.equal(await page.getByLabel('搜索已整理软件').inputValue(), 'LinkedTool')
    assert.equal(await page.getByRole('group', { name: '软件类型筛选' }).getByRole('button', { name: /^链接软件/ }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('.organized-item').count(), 0)
    const records = await page.evaluate(() => window.baoyi.software.list())
    assert.equal(records.some((r: any) => r.source_dir === waiting), false, 'local unlink must not discover unrelated new software')
    assert.equal(fs.existsSync(linked), false); assert.ok(fs.existsSync(installed))
    const item = await page.evaluate(() => window.baoyi.software.get('LinkedTool')); assert.equal(item.source_dir, installed); assert.equal(item.link_target, '')
    await page.getByRole('button', { name: /^待整理/ }).click()
    assert.ok(await page.locator('.line').filter({ hasText: 'LinkedTool' }).count())
  })
  const materialized = path.join(root, 'Old', 'Materialized')
  await check('convert junction to real directory moves complete files and clears link state', async () => {
    const report = await page.evaluate(() => window.baoyi.organize.run([{ software_id: 'LinkedTool', action: 'junction', category: 'Old', folder: 'Materialized' }]))
    assert.equal(report.linked, 1); await sync(); await page.getByRole('button', { name: /^已整理/ }).click()
    const row = page.locator('.organized-item').filter({ has: page.locator('.item-title', { hasText: 'LinkedTool' }) })
    await row.getByRole('button', { name: '转为实体', exact: true }).click(); await ready()
    assert.equal(fs.lstatSync(materialized).isSymbolicLink(), false)
    assert.equal(fs.existsSync(installed), false); assert.ok(fs.existsSync(path.join(materialized, 'app.exe')))
    const item = await page.evaluate(() => window.baoyi.software.get('LinkedTool'))
    assert.equal(item.link_target, ''); assert.equal(item.source_dir, materialized)
  })
  await check('record removal deletes managed junction and keeps real files', async () => {
    const report = await page.evaluate(() => window.baoyi.organize.run([{ software_id: 'LinkedTool', action: 'junction', category: 'Old', folder: 'LinkedAgain' }]))
    assert.equal(report.linked, 1)
    const result = await page.evaluate(() => window.baoyi.software.remove('LinkedTool'))
    assert.equal(result.link_removed, true); assert.equal(fs.existsSync(path.join(root, 'Old', 'LinkedAgain')), false)
    assert.ok(fs.existsSync(path.join(materialized, 'app.exe')))
    assert.equal(await page.evaluate(() => window.baoyi.software.get('LinkedTool')), null)
  })
  await check('narrow layout exposes controls without horizontal overflow', async () => {
    await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
    await sync(); await page.getByRole('button', { name: /^已整理/ }).click()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await screenshot('organized-narrow')
    assert.equal(errors.length, 0, errors.join('\n'))
  })
  fs.writeFileSync(path.join(run, 'verification.json'), JSON.stringify({ ok: true, runtime, results, errors, profile, root }, null, 2))
  console.log('Evidence: ' + run)
} catch (cause) {
  await screenshot('failure').catch(() => {})
  fs.writeFileSync(path.join(run, 'verification.json'), JSON.stringify({ ok: false, runtime, results, errors, error: String(cause), profile, root }, null, 2))
  throw cause
} finally { await app.close() }
