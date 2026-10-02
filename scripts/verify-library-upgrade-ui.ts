import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, SCHEMA_KEY } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { APP_VERSION_KEY } from '../electron/services/library-snapshots.ts'
import { seedImageLibrary } from './helpers/image-library-fixture.ts'
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const packedExecutable = process.argv[2]
const sourceSchema=Number(process.argv[3]||12)
assert.ok([11,12].includes(sourceSchema))
const executable = path.resolve(packedExecutable || 'node_modules/electron/dist/electron.exe')
const output = path.resolve('output/image-optimization/upgrade-ui' + (packedExecutable ? '-packaged' : '')); fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-')), db = new DatabaseSync(path.join(profile, 'baoyi.db'))
initSchema(db, KINDS); seedImageLibrary(db, profile, 1, true)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', hanime_builtin_hosts: false, [APP_VERSION_KEY]: '0.9.0' })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(sourceSchema), SCHEMA_KEY)
db.exec('DROP TABLE image_collection_members; DROP TABLE image_collections')
if(sourceSchema===11)db.exec('DROP TABLE image_bookmarks; DROP TABLE image_reader_state')
db.close()
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const launch = () => _electron.launch({ executablePath: executable, args: [...(packedExecutable ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env })
let app = await launch()
const errors: string[] = []
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', (e: Error) => errors.push(e.message))
  await page.waitForFunction(() => !!window.baoyi?.data)
  // Preload is ready before Vue installs its router. Wait for the mounted app.
  await page.locator('.titlebar').waitFor()
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.evaluate(() => { location.hash = '/settings?tab=data' })
  await page.getByRole('button', { name: '创建数据库快照', exact: true }).waitFor()
  const before = await page.evaluate(() => window.baoyi.data.snapshotInfo())
  assert.equal(before.version, version); assert.equal(before.schema, 13); assert.equal(before.dataDirectory, profile); assert.equal(before.inventory.total, 1)
  const copy = new DatabaseSync(path.join(before.inventory.directory, before.inventory.snapshots[0].file), { readOnly: true })
  try { assert.equal(copy.prepare('SELECT value FROM settings WHERE key=?').get(SCHEMA_KEY)!.value, String(sourceSchema)); assert.ok(copy.prepare("SELECT id FROM resource WHERE id='fixture-0'").get()); assert.equal(!!copy.prepare("SELECT 1 FROM sqlite_master WHERE name='image_reader_state'").get(),sourceSchema===12);assert.equal(copy.prepare("SELECT 1 FROM sqlite_master WHERE name='image_collections'").get(),undefined) } finally { copy.close() }
  await page.getByRole('button', { name: '创建数据库快照', exact: true }).click()
  await page.waitForFunction(async () => (await window.baoyi.data.snapshotInfo()).inventory.total === 2)
  const exportPath = path.join(profile, 'manual-export.json')
  await app.evaluate(({ dialog }: any, file: string) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, exportPath)
  await page.getByRole('button', { name: '备份全部资料（JSON）', exact: true }).click()
  await page.getByLabel('最近元数据备份', { exact: true }).getByText(exportPath, { exact: true }).waitFor()
  const latest = await page.evaluate(() => window.baoyi.data.snapshotInfo()); assert.equal(latest.lastExport?.file, exportPath)
  assert.equal(latest.lastExport?.state, 'available')
  await app.evaluate(({ shell }: any) => { (globalThis as any).openedSnapshotDirectory = ''; shell.openPath = async (file: string) => { (globalThis as any).openedSnapshotDirectory = file; return '' } })
  await page.getByLabel('打开快照目录', { exact: true }).click()
  assert.equal(await app.evaluate(() => (globalThis as any).openedSnapshotDirectory), before.inventory.directory)
  await page.getByText(`已备份到 ${exportPath}`, { exact: true }).waitFor({ state: 'hidden' })
  await page.locator('.library-safety').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'protection-1440.png') })
  await page.locator('.snapshot-table').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'snapshots-1440.png') })
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await page.locator('.library-safety').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'protection-960.png') })
  await page.locator('.snapshot-table').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'snapshots-960.png') })
  assert.equal(await page.locator('.library-safety').evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth), false)
  await app.close(); app = await launch()
  const restarted = await app.firstWindow(); await restarted.waitForFunction(() => !!window.baoyi?.data)
  const resumed = await restarted.evaluate(() => window.baoyi.data.snapshotInfo()); assert.equal(resumed.inventory.total, 2)
  assert.equal(resumed.lastExport?.file, exportPath)
  const manual = resumed.inventory.snapshots.find((s: any) => s.reason === 'manual')!
  fs.unlinkSync(path.join(resumed.inventory.directory, manual.file))
  await restarted.locator('.titlebar').waitFor()
  await restarted.evaluate(() => { location.hash = '/settings?tab=data' })
  await restarted.getByText('文件缺失', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ profile, executable, version, before, after: resumed, errors }, null, 2))
  console.log(`PASS real schema-${sourceSchema} upgrade snapshot, settings info, manual snapshot/export, directory, restart and missing-file state`)
} catch (cause) { const page = await app.firstWindow(); await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(errors); throw cause }
finally { await app.close() }
