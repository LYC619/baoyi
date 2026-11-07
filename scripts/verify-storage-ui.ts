// Isolated native acceptance; optional first argument selects the packaged executable.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { _electron } from 'playwright'
import { expect } from 'playwright/test'
import { initSchema, SCHEMA_VERSION } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { createLibrarySnapshot, APP_VERSION_KEY } from '../electron/services/library-snapshots.ts'
import { textPdf } from './helpers/pdf-fixture.ts'

const packaged = process.argv[2], output = path.resolve('output/optimization-2026-10-29')
await fs.mkdir(output, { recursive: true })
const profile = await fs.mkdtemp(path.join(output, packaged ? 'packaged-ui-' : 'native-ui-'))
const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version
const pdfFile = path.join(profile, 'storage-evidence.pdf'), exportFile = path.join(profile, 'exported-snapshot.db')
await fs.writeFile(pdfFile, textPdf('Storage optimization PDF evidence.'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'light', hanime_builtin_hosts: false, video_online_proxy: '', ai: { enabled: false, api_key: '', api_url: '', model: '' }, [APP_VERSION_KEY]: version, _snapshot_padding: 'fixture '.repeat(150000) })) {
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
}
const document = await new DocumentLibrary(db).register(pdfFile, 'book')
const originals = []
for (let i = 0; i < 6; i++) originals.push(createLibrarySnapshot(db, { directory: profile, version, targetSchema: SCHEMA_VERSION, reason: 'upgrade', open: (file, readonly) => new DatabaseSync(file, { readOnly: readonly }) }))
db.close()

const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'public, max-age=31536000')
  if (request.url === '/cache.js') { response.setHeader('Content-Type', 'application/javascript'); response.end('/*' + 'x'.repeat(2 * 1024 * 1024) + '*/;window.fixtureLoaded=true;'); return }
  response.setHeader('Content-Type', 'text/html')
  if (request.url === '/seed') response.setHeader('Set-Cookie', 'fixture_login=keep; Max-Age=3600; Path=/; SameSite=Lax')
  response.end(request.url === '/seed' ? '<script>localStorage.setItem("fixture","keep")</script><script src="/cache.js"></script>' : '<title>Storage state</title>')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const launch = () => _electron.launch({ executablePath: path.resolve(packaged || 'node_modules/electron/dist/electron.exe'), args: [...(packaged ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
let application = await launch(), page = await application.firstWindow()
const errors: string[] = [], checks: string[] = []
let browserBefore = 0, browserAfter = 0
try {
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profile)
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), version)
  if (packaged) assert.equal(await application.evaluate(({ app }) => app.isPackaged), true)
  assert.equal(await application.evaluate(({ app }) => app.commandLine.getSwitchValue('disk-cache-size')), String(64 * 1024 * 1024))
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.unmaximize(); window.setSize(1280, 960) })
  await page.locator('.app__view').waitFor()
  await application.evaluate(async ({ BrowserWindow, session }, base) => {
    for (const partition of ['persist:video-discovery', 'persist:general-web-browser', 'persist:hanime-network']) {
      const store = session.fromPartition(partition); await store.setProxy({ mode: 'direct' })
      const window = new BrowserWindow({ show: false, webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true } })
      await window.loadURL(base + '/seed'); await store.cookies.flushStore(); store.flushStorageData(); window.destroy()
    }
  }, base)
  await page.evaluate(() => { location.hash = '/settings?scope=global&tab=data' })
  await expect(page.getByRole('heading', { name: '数据占用', exact: true })).toBeVisible()
  const before = await page.evaluate(() => window.baoyi.data.storageUsage())
  browserBefore = before.items.find(item => item.category === 'browser-cache')!.bytes
  assert.ok(browserBefore > 2 * 1024 * 1024)
  await page.getByRole('button', { name: '清理浏览缓存', exact: true }).click()
  await expect(page.locator('.storage-usage [role=status]')).toContainText('登录状态和资料文件保留')
  const after = await page.evaluate(() => window.baoyi.data.storageUsage())
  browserAfter = after.items.find(item => item.category === 'browser-cache')!.bytes
  assert.ok(browserAfter < browserBefore, `${browserAfter} < ${browserBefore}`)
  checks.push('native-cache-clearing-reduces-size-with-64MiB-session-budget')

  const persisted = await application.evaluate(async ({ BrowserWindow, session }, base) => {
    const states = []
    for (const partition of ['persist:video-discovery', 'persist:general-web-browser', 'persist:hanime-network']) {
      const store = session.fromPartition(partition), cookies = await store.cookies.get({ url: base })
      const window = new BrowserWindow({ show: false, webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true } })
      await window.loadURL(base + '/state')
      states.push({ partition, cookie: cookies.find(cookie => cookie.name === 'fixture_login')?.value, local: await window.webContents.executeJavaScript('localStorage.getItem("fixture")') })
      window.destroy()
    }
    return states
  }, base)
  assert.ok(persisted.every(item => item.cookie === 'keep' && item.local === 'keep'))
  checks.push('all-three-native-web-profiles-retain-cookies-and-local-storage')
  await page.screenshot({ path: path.join(output, packaged ? 'packaged-storage.png' : 'native-storage.png') })

  await page.getByRole('button', { name: '压缩旧升级快照', exact: true }).click()
  await expect(page.locator('.library-safety [role=status]')).toContainText('全部恢复点保留')
  const info = await page.evaluate(() => window.baoyi.data.snapshotInfo())
  assert.equal(info.inventory.total, originals.length)
  assert.equal(info.inventory.snapshots.filter(item => item.compression === 'gzip').length, 3)
  const archived = info.inventory.snapshots.find(item => item.compression === 'gzip')!
  await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog }, exportFile)
  await page.locator('.snapshot-table tbody tr').filter({ hasText: '已压缩' }).first().getByRole('button', { name: '导出数据库' }).click()
  await expect(page.locator('.library-safety [role=status]')).toContainText('已导出并核对原始摘要')
  assert.equal(createHash('sha256').update(await fs.readFile(exportFile)).digest('hex'), archived.sha256)
  const restored = new DatabaseSync(exportFile, { readOnly: true }); assert.equal(restored.prepare('PRAGMA quick_check').get()?.quick_check, 'ok'); restored.close()
  checks.push('native-snapshot-compression-export-and-sqlite-restoration')
  await page.locator('.library-safety').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, packaged ? 'packaged-snapshots.png' : 'native-snapshots.png') })

  await page.evaluate(id => { location.hash = '/document/' + id }, document.id)
  await expect(page.locator('.pdf-page[data-rendered=true]')).toHaveCount(1)
  await expect(page.locator('.textLayer')).toContainText('Storage optimization PDF evidence.')
  checks.push('native-pdf-canvas-rendering-and-selectable-text')
  const extracted = await application.evaluate(async ({ app }, { pdfFile, packaged }) => {
    const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path'), root = app.getAppPath()
    const runtimeRequire = process.getBuiltinModule('module').createRequire(path.join(root, 'package.json'))
    const nativePath = runtimeRequire.resolve('@napi-rs/canvas')
    if (packaged && !nativePath.includes('app.asar')) throw new Error('Canvas was resolved outside the packaged application')
    const directory = path.join(root, 'dist-electron'), names = fs.readdirSync(directory) as string[]
    const pdf = runtimeRequire(path.join(directory, names.find(name => /^pdf-[^.]+\.js$/.test(name))!))
    const worker = runtimeRequire(path.join(directory, names.find(name => /^pdf\.worker-[^.]+\.js$/.test(name))!))
    ;(globalThis as any).pdfjsWorker ||= { WorkerMessageHandler: worker.WorkerMessageHandler }
    const task = pdf.getDocument({ data: new Uint8Array(fs.readFileSync(pdfFile)), useSystemFonts: true, disableFontFace: true, useWorkerFetch: false, verbosity: 0 })
    try { const document = await task.promise; const content = await (await document.getPage(1)).getTextContent(); return { text: content.items.map((item: any) => item.str || '').join(' '), nativePath } }
    finally { await task.destroy() }
  }, { pdfFile, packaged: !!packaged })
  assert.match(extracted.text, /Storage optimization PDF evidence/)
  checks.push('bundled-main-process-pdf-text-extraction-retains-native-canvas')

  await application.close(); application = await launch(); page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.app__view').waitFor()
  const restarted = await page.evaluate(() => window.baoyi.data.snapshotInfo())
  assert.equal(restarted.inventory.total, originals.length)
  assert.equal(restarted.inventory.snapshots.filter(item => item.compression === 'gzip').length, 3)
  const cookies = await application.evaluate(async ({ session }, base) => session.fromPartition('persist:hanime-network').cookies.get({ url: base }), base)
  assert.equal(cookies.find(cookie => cookie.name === 'fixture_login')?.value, 'keep')
  checks.push('native-restart-keeps-snapshot-history-and-login')
  assert.deepEqual(errors, [])
  const result = { status: 'passed', version, packaged: !!packaged, profile, checks, browserBefore, browserAfter, errors }
  await fs.writeFile(path.join(output, packaged ? 'packaged-ui.json' : 'native-ui.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { await application.close().catch(() => {}); await new Promise<void>(resolve => server.close(() => resolve())) }
