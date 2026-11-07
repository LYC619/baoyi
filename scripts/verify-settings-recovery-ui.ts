import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadPlaywright, electronTestEnv } from './helpers/playwright.ts'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createVideoJobStore } from '../electron/kinds/video/download/jobs.ts'
const { _electron } = loadPlaywright()
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const output = path.resolve(process.env.BAOYI_SETTINGS_UI_OUTPUT || `output/release-${version}/settings-ui`)
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-')), db = new DatabaseSync(path.join(profile, 'baoyi.db'))
initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, hanime_builtin_hosts: false, theme: 'light', video_download_concurrency: 3, video_download_connections: 6, tmdb: { enabled: false, api_key: 'fixture-key', api_domain: '', image_domain: '' } })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
const movie = path.join(profile, 'fixture.mp4'), cacheDirectory = path.join(profile, '.fixture.mp4.baoyi-hls')
fs.mkdirSync(cacheDirectory); fs.writeFileSync(path.join(cacheDirectory, 'manifest.json'), '{}'); fs.writeFileSync(path.join(cacheDirectory, '000000.segment'), 'fixture')
fs.writeFileSync(movie, 'complete media must survive')
createVideoJobStore(db).save({ id: 'cache-fixture', resourceId: '', bundleId: '', title: '缓存清理示例', category: '其他', videoCode: '100', root: profile, directory: profile,
  sourceLabel: '720p', strictQuality: false, register: false, status: 'failed', createdAt: Date.now(), updatedAt: Date.now(), message: '已停止', description: '', posterUrl: '', posterPath: '', sources: [], warnings: [],
  items: [{ videoCode: '100', title: '测试视频', order: 1, path: movie, sourceLabel: '720p', transfer: 'failed', metadata: 'pending', registration: 'pending', receivedBytes: 7, totalBytes: 0, error: 'fixture', warnings: [] }] })
db.close()
const env = electronTestEnv(); delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const app = await _electron.launch({ executablePath: path.resolve(process.argv[2] || `release/${version}/win-unpacked/抱一.exe`), args: ['--user-data-dir=' + profile, '--disable-gpu'], env })
const checks: string[] = [], errors: string[] = []
try {
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  const page = await app.firstWindow(); page.on('pageerror', (e: Error) => errors.push(e.message))
  await page.getByRole('button', { name: /^影视\s/ }).click()
  await page.evaluate(() => { location.hash = '/settings?tab=search' })
  await page.getByRole('heading', { name: '联网搜索', exact: true }).waitFor()
  await page.locator('.scope-nav').getByRole('button', { name: '影视', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '下载与缓存', exact: true }).count(), 1, 'downloads must have their own navigation entry')
  for (const [tab, heading] of [['影视刮削', 'TMDB 刮削（影视）'], ['网站与代理', '出站代理'], ['下载与缓存', '视频下载设置']]) {
    await page.getByRole('button', { name: tab, exact: true }).click()
    await page.getByRole('heading', { name: heading, exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: '联网搜索', exact: true }).count(), 0)
    checks.push(tab + '-independent-panel')
    await page.screenshot({ path: path.join(output, tab + '.png') })
  }
  assert.equal(await page.getByLabel('同时下载视频数').inputValue(), '3')
  assert.equal(await page.getByLabel('每个视频连接数').inputValue(), '6')
  await page.getByText('缓存清理示例', { exact: true }).waitFor()
  await app.evaluate(({ dialog }: any) => { dialog.showMessageBox = async () => ({ response: 0 }) })
  await page.getByRole('button', { name: '清理缓存…', exact: true }).click()
  await page.getByRole('button', { name: '刷新缓存清单' }).waitFor()
  assert.ok(fs.existsSync(cacheDirectory), 'cancel must preserve cached fragments')
  await app.evaluate(({ dialog }: any) => { dialog.showMessageBox = async () => ({ response: 1 }) })
  await page.getByRole('button', { name: '清理缓存…', exact: true }).click()
  await page.getByText('当前下载记录没有残留缓存。', { exact: true }).waitFor()
  assert.equal(fs.existsSync(cacheDirectory), false); assert.equal(fs.readFileSync(movie, 'utf8'), 'complete media must survive')
  checks.push('cache-inspection-confirmation-and-complete-file-preservation')
  for (const width of [960, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async theme => { await (window as any).baoyi.settings.patch({ theme }); document.documentElement.dataset.theme = theme }, theme)
      await page.screenshot({ path: path.join(output, `downloads-${width}-${theme}.png`) })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    }
  }
  checks.push('downloads-at-960-and-1280-light-and-dark')
  await page.reload(); await page.getByRole('heading', { name: '视频下载设置', exact: true }).waitFor()
  assert.equal(await page.getByLabel('每个视频连接数').inputValue(), '6')
  checks.push('download-route-and-values-survive-reload')
  await page.getByRole('button', { name: '影视刮削', exact: true }).click()
  await page.getByPlaceholder('TMDB 的 API Key（v3 auth）').fill('unsaved-key')
  await page.locator('.scope-nav').getByRole('button', { name: '全局', exact: true }).click()
  await page.getByRole('button', { name: '联网搜索', exact: true }).click()
  await page.locator('.scope-nav').getByRole('button', { name: '影视', exact: true }).click()
  await page.getByRole('button', { name: '影视刮削', exact: true }).click()
  assert.equal(await page.getByPlaceholder('TMDB 的 API Key（v3 auth）').inputValue(), 'unsaved-key')
  assert.equal((await page.evaluate(() => (window as any).baoyi.settings.getAll())).tmdb.api_key, 'fixture-key')
  checks.push('unsaved-metadata-input-survives-tab-switch-without-saving')
  await page.getByRole('button', { name: '里番区基础设置', exact: true }).click()
  await page.getByRole('heading', { name: '隐藏里番', exact: true }).waitFor()
  checks.push('content-visibility-belongs-to-hentai-settings')
  for (const module of ['软件', '游戏']) {
    await page.getByRole('button', { name: new RegExp('^' + module + '\\s') }).click()
    await page.evaluate(() => { location.hash = '/settings?tab=search' })
    await page.getByRole('heading', { name: '联网搜索', exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: '视频下载设置', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '下载与缓存', exact: true }).count(), 0)
    checks.push(module + '-search-without-video-tools')
  }
  const settings = await page.evaluate(() => (window as any).baoyi.settings.getAll())
  assert.equal(settings.tmdb.api_key, 'fixture-key'); assert.equal(settings.hanime_builtin_hosts, false)
  await app.evaluate(({ ipcMain }: any, config: any) => {
    ipcMain.removeHandler('settings:get'); let failed = false
    ipcMain.handle('settings:get', () => { if (!failed) { failed = true; throw new Error('isolated startup failure') }; return config })
  }, settings)
  await page.reload()
  await page.getByRole('heading', { name: '抱一没能启动' }).waitFor()
  await page.getByText('数据目录：' + profile, { exact: true }).waitFor()
  assert.ok((await page.locator('body').innerText()).includes(profile), 'boot fallback must show the actual data directory')
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.locator('.titlebar').waitFor({ timeout: 10000 })
  checks.push('startup-failure-retry-recovers-under-csp')
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ status: 'passed', version, profile, checks, errors }, null, 2))
  console.log(`PASS settings and startup recovery UI: ${checks.length} checks`)
} finally { await app.close() }
