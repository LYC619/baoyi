/** Native Electron/SQLite/IPC checks; only a fresh profile and synthetic videos are modified. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { persistVideoWorkBundle } from '../electron/kinds/video/local-sync.ts'
import { listEpisodes } from '../electron/kinds/video/db.ts'

const require = createRequire(import.meta.url)
const runtime = process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { _electron } = require(runtime), { expect } = require(runtime + '/test')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-local-structure-20260912/win-unpacked/抱一.exe')
assert.ok(fs.existsSync(executable))
for (const marker of ['portable.txt', '绿色版.txt']) assert.ok(!fs.existsSync(path.join(path.dirname(executable), marker)))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-native-local-'))
const evidence = path.resolve(process.argv[3] || 'output/video-local-structure-20260912/native-local')
fs.mkdirSync(evidence, { recursive: true })
const libraryRoot = path.join(profile, 'videos'), folder = path.join(libraryRoot, '影像课堂 4')
fs.mkdirSync(folder, { recursive: true })
const d = new DatabaseSync(path.join(profile, 'baoyi.db'))
d.exec('PRAGMA foreign_keys = ON'); initSchema(d, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, hide_hentai: true, theme: 'light', video_scan_dirs: [libraryRoot] })) d.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, JSON.stringify(value))
const files = [1, 2, 3, 4].map(number => {
  const file = path.join(folder, 'Original chapter ' + number + ' - E0' + number + '.mp4')
  fs.writeFileSync(file, 'synthetic native episode ' + number)
  return file
})
const source = (number: number) => ({ provider: 'fixture', externalId: String(number), scope: 'episode' as const, pageUrl: 'https://example.invalid/' + number, evidence: 'confirmed' as const })
const record = registerVideoContent(d, { directory: folder, root: libraryRoot, title: '影像课堂 0-4', category: '动画',
  tags: Array.from({ length: 30 }, (_, i) => '主题' + (i + 1)).concat(['add', 'remove']), sources: [0, 1, 2, 3, 4].map(source),
  items: [0, 1, 2, 3, 4].map(number => ({ title: '影像课堂 ' + number, originalTitle: 'Original chapter ' + number, order: number, number,
    description: '第 ' + number + ' 集的独立简介。', sources: [source(number)], files: number ? [{ path: files[number - 1], quality: '720p' }] : [] })) })
const episodes = listEpisodes(d, record.resourceId)
for (const episode of episodes) {
  const poster = path.join(folder, 'cover-' + episode.episode + '.png')
  fs.copyFileSync('resources/icon.png', poster)
  d.prepare('UPDATE episode SET poster_path = ? WHERE id = ?').run(poster, episode.id)
}
d.prepare('UPDATE video_meta SET poster_path = ? WHERE resource_id = ?').run(path.join(folder, 'cover-4.png'), record.resourceId)
d.prepare("UPDATE episode SET watch_status = 'watching', position_sec = 91 WHERE id = ?").run(episodes[3].id)
persistVideoWorkBundle(d, record.resourceId)
d.close()
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
const errors: string[] = [], checks: string[] = []
let app: any, page: any
async function launch() {
  app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env: environment, timeout: 30000 })
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  page = await app.firstWindow(); page.setDefaultTimeout(12000)
  page.on('pageerror', (error: Error) => errors.push(error.message))
  page.on('console', (message: any) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.waitForFunction(() => !!(window as any).baoyi)
  await page.evaluate((id: string) => { location.hash = '/video/' + id }, record.resourceId)
  await page.locator('.video-item').first().waitFor()
}
async function check(name: string, action: () => Promise<void>) { await action(); checks.push(name); console.log('PASS ' + name) }
async function stable() {
  await page.waitForFunction(() => { const view = document.querySelector('.app__view'); return view && getComputedStyle(view).opacity === '1' && !document.querySelector('.page-enter-active, .page-leave-active') })
}
try {
  await launch()
  await check('portable episode posters render through the native file protocol', async () => {
    await expect(page.locator('.video-item')).toHaveCount(5)
    await expect(page.locator('.video-item__cover img')).toHaveCount(5)
    await page.waitForFunction(() => [...document.querySelectorAll('.video-item__cover img, .hero__img')].every(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))
    await expect(page.locator('.hero__img')).toHaveCount(1)
    await expect(page.locator('.video-item').first()).toContainText('第 0 集')
    await expect(page.locator('.video-item').first().getByRole('button', { name: /^播放/ })).toBeDisabled()
  })
  await check('card layouts and three-row tags work in both themes and smaller windows', async () => {
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme: string) => (window as any).baoyi.settings.patch({ theme }), theme)
      await page.reload()
      await expect(page.locator('.video-item')).toHaveCount(5)
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
      for (const [width, height] of [[1280, 900], [960, 640]]) {
        await app.evaluate(({ BrowserWindow }: any, values: number[]) => BrowserWindow.getAllWindows()[0].setContentSize(values[0], values[1]), [width, height])
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await stable()
        assert.equal(await page.locator('.video-items').evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth), false)
        assert.equal(await page.locator('.hero__tags').getByText('add', { exact: true }).count(), 0)
        await page.getByRole('button', { name: '展开全部标签', exact: true }).click()
        await page.getByRole('button', { name: '收起标签', exact: true }).click()
        await page.screenshot({ path: path.join(evidence, `cards-${width}-${theme}.png`), animations: 'disabled' })
      }
    }
  })
  await check('checking files imports a new local episode and writes its adjacent metadata', async () => {
    const file = path.join(folder, '影像课堂 5.mp4'); fs.writeFileSync(file, 'synthetic native episode 5')
    await page.getByRole('button', { name: '检查文件', exact: true }).click()
    await expect(page.locator('.video-item')).toHaveCount(6)
    await expect(page.getByRole('status').filter({ hasText: '新增 1 个视频' })).toBeVisible()
    assert.ok(fs.existsSync(file.replace(/\.[^.]+$/, '.baoyi.json')))
    const again = await page.evaluate((id: string) => (window as any).baoyi.video.syncFiles(id), record.resourceId)
    assert.equal(again.filesAdded, 0)
    assert.equal((await page.evaluate(() => (window as any).baoyi.video.list({}))).length, 1)
  })
  let renamed = ''
  await check('collection rename updates folder, manifest, file paths and preserves watching progress', async () => {
    await page.getByLabel('更多作品操作', { exact: true }).click()
    await page.getByRole('button', { name: '修改合集名称', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '修改合集名称', exact: true })
    await dialog.getByLabel('合集名称', { exact: true }).fill('影像课堂 0-5')
    await expect(dialog.getByRole('button', { name: '保存名称并更名目录', exact: true })).toBeEnabled()
    await page.screenshot({ path: path.join(evidence, 'rename-preview.png') })
    await dialog.getByRole('button', { name: '保存名称并更名目录', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const library = await page.evaluate((id: string) => (window as any).baoyi.video.library(id), record.resourceId)
    renamed = library.directory.path
    assert.equal(renamed, path.join(libraryRoot, '影像课堂 0-5'))
    assert.ok(!fs.existsSync(folder))
    assert.equal(library.contents.find((ep: any) => ep.id === episodes[3].id).position_sec, 91)
    for (const number of [1, 2, 3, 4]) assert.equal(fs.readFileSync(path.join(renamed, path.basename(files[number - 1])), 'utf8'), 'synthetic native episode ' + number)
    const manifest = JSON.parse(fs.readFileSync(path.join(renamed, 'baoyi.json'), 'utf8'))
    assert.equal(manifest.work.title, '影像课堂 0-5')
    assert.equal(manifest.items.find((ep: any) => ep.number === 0).files.length, 0)
  })
  await check('importing the renamed bundle reuses the same work and all episode IDs', async () => {
    await app.evaluate(({ dialog }: any, directory: string) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, renamed)
    const imported = await page.evaluate(() => (window as any).baoyi.video.importBundle())
    assert.equal(imported.resourceId, record.resourceId)
    assert.equal(imported.itemsAdded, 0)
    assert.equal((await page.evaluate(() => (window as any).baoyi.video.list({}))).length, 1)
  })
  await app.close(); app = undefined
  await launch()
  await check('restart retains the renamed collection, six contents and playable local files', async () => {
    await expect(page.locator('.hero__title')).toHaveText('影像课堂 0-5')
    await expect(page.locator('.video-item')).toHaveCount(6)
    const result = await page.evaluate((id: string) => (window as any).baoyi.video.library(id), record.resourceId)
    assert.equal(result.assets.filter((asset: any) => asset.role === 'video' && asset.state === 'present').length, 5)
    assert.equal(result.contents[0].episode, 0); assert.equal(result.contents[0].assets.length, 0)
  })
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ executable, profile, checks, errors }, null, 2))
  console.log('Native local structure: ' + checks.length + ' passed / 0 failed')
} catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); throw error }
finally { if (app) await app.close() }
