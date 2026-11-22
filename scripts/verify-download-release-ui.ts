/** Verify the delivered application using a disposable schema-15 library. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadPlaywright, electronTestEnv } from './helpers/playwright.ts'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, SCHEMA_VERSION } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { APP_VERSION_KEY } from '../electron/services/storage/library-snapshots.ts'

const { _electron } = loadPlaywright()
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const executable = path.resolve(process.argv[2] || `release/${version}/win-unpacked/抱一.exe`)
assert.ok(fs.existsSync(executable))
const output = path.resolve(`output/release-${version}/download-ui`)
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'light', hanime_builtin_hosts: false, [APP_VERSION_KEY]: '0.16.2' })) {
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
}
for (const [id, category] of [['classified', '开发工具'], ['other', '其他'], ['fresh', '其他']]) {
  const exe = path.join(profile, id + '.exe')
  fs.writeFileSync(exe, 'synthetic fixture')
  const launchers = JSON.stringify([{ path: exe, label: '', kind: 'main', is_default: true }])
  db.prepare('INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,name_zh,category,ai_status,source_dir) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'software', Date.now(), Date.now(), exe, id + '.exe', id, category, id === 'other' ? 'done' : 'pending', profile)
  db.prepare('INSERT INTO software_meta(resource_id,launchers) VALUES(?,?)').run(id, launchers)
  db.prepare('INSERT INTO pending_software(id,created_at,exe_path,file_name,name_zh,category,launchers,summary,source_dir) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id + '-pending', Date.now(), exe, id + '.exe', id + ' 已识别', '媒体娱乐', launchers, 'AI 新简介', profile)
}
// Recreate the previous release's missing column and schema version.
db.exec('ALTER TABLE software_meta DROP COLUMN category_locked')
db.prepare("UPDATE settings SET value='15' WHERE key='_schema'").run()
db.close()
const env = electronTestEnv(); delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const launch = () => _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
let application = await launch()
const errors: string[] = [], checks: string[] = []
let runtime: any
try {
  runtime = await application.evaluate(({ app }: any) => ({ isPackaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData'), appPath: app.getAppPath() }))
  assert.equal(runtime.isPackaged, true); assert.equal(runtime.version, version)
  assert.equal(path.resolve(runtime.profile).toLowerCase(), profile.toLowerCase())
  assert.equal(path.resolve(runtime.appPath).toLowerCase(), path.join(path.dirname(executable), 'resources/app.asar').toLowerCase())
  checks.push('packaged-runtime-and-isolated-profile')
  let page = await application.firstWindow()
  page.on('pageerror', (e: Error) => errors.push(e.message))
  await page.locator('.titlebar').waitFor()
  assert.ok(page.url().startsWith('file://'))
  const snapshot = await page.evaluate(() => (window as any).baoyi.data.snapshotInfo())
  assert.equal(snapshot.schema, SCHEMA_VERSION)
  assert.ok(snapshot.inventory.total >= 1)
  checks.push('schema-15-to-current-upgrade-and-snapshot')
  // A category changed after identification must win over the staged result.
  await page.evaluate(() => (window as any).baoyi.software.update('classified', { category: '用户最新分类' }))
  const confirmed = await page.evaluate(() => (window as any).baoyi.pending.confirm(['classified-pending', 'other-pending', 'fresh-pending']))
  assert.equal(confirmed.registered, 3)
  const items = await page.evaluate(() => Promise.all(['classified', 'other', 'fresh'].map(id => (window as any).baoyi.software.get(id))))
  assert.equal(items[0].category, '用户最新分类'); assert.equal(items[0].summary, 'AI 新简介')
  assert.equal(items[1].category, '其他'); assert.equal(items[2].category, '媒体娱乐')
  checks.push('latest-user-category-and-completed-other-preserved', 'unclassified-item-receives-ai-category')
  await page.getByRole('button', { name: /^影视\s/ }).click()
  await page.locator('.sidebar').waitFor()
  await page.evaluate(() => { location.hash = '/settings?tab=downloads' })
  const videos = page.getByLabel('同时下载视频数'), connections = page.getByLabel('每个视频连接数')
  await videos.waitFor()
  assert.equal(await videos.inputValue(), '2'); assert.equal(await connections.inputValue(), '4')
  await videos.fill('3'); await videos.press('Tab')
  await page.waitForFunction(async () => (await (window as any).baoyi.settings.getAll()).video_download_concurrency === 3)
  await connections.fill('8'); await connections.press('Tab')
  await page.waitForFunction(async () => (await (window as any).baoyi.settings.getAll()).video_download_connections === 8)
  await connections.fill('9'); await connections.press('Tab')
  await page.getByRole('status').filter({ hasText: '整数' }).waitFor()
  assert.equal(await connections.inputValue(), '8')
  checks.push('download-settings-defaults-save-and-invalid-rollback')
  await page.locator('.ffmpeg-panel').screenshot({ path: path.join(output, 'download-settings.png') })
  await application.close(); application = await launch()
  page = await application.firstWindow(); page.on('pageerror', (e: Error) => errors.push(e.message))
  await page.locator('.titlebar').waitFor()
  const settings = await page.evaluate(() => (window as any).baoyi.settings.getAll())
  assert.equal(settings.video_download_concurrency, 3); assert.equal(settings.video_download_connections, 8)
  assert.equal((await page.evaluate(() => (window as any).baoyi.software.get('classified'))).category, '用户最新分类')
  checks.push('settings-and-category-survive-restart')
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ status: 'passed', version, executable, profile, runtime, checks, errors }, null, 2) + '\n')
  console.log(`PASS packaged download release: ${checks.length} checks; page errors ${errors.length}`)
} catch (error) {
  const page = application.windows()[0]
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  throw error
} finally { await application.close() }
