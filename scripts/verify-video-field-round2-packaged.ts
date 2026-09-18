/**
 * 实测第二轮 · 打包产物上的真机检查（B1 从单集选封面 / B3 待补齐原因 / B8 改集号与分部 / A 海报写进作品目录）。
 * 只动临时 profile 和合成视频目录，不碰用户资料库和真实视频库。
 *
 *   node --experimental-strip-types scripts/verify-video-field-round2-packaged.ts [exe] [证据目录]
 */
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
const executable = path.resolve(process.argv[2] || 'release/0.8.0-field-test-round2-20260918/win-unpacked/抱一.exe')
assert.ok(fs.existsSync(executable), executable)
for (const marker of ['portable.txt', '绿色版.txt']) assert.ok(!fs.existsSync(path.join(path.dirname(executable), marker)))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-round2-'))
const evidence = path.resolve(process.argv[3] || 'output/field-test-round2-20260918/packaged')
fs.mkdirSync(evidence, { recursive: true })
const libraryRoot = path.join(profile, 'videos'), folder = path.join(libraryRoot, '影像课堂')
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
const record = registerVideoContent(d, { directory: folder, root: libraryRoot, title: '影像课堂', category: '动画', sources: [1, 2, 3, 4].map(source),
  items: [1, 2, 3, 4].map(number => ({ title: '影像课堂 ' + number, originalTitle: 'Original chapter ' + number, order: number, number,
    sources: [source(number)], files: [{ path: files[number - 1], quality: '720p' }] })) })
const episodes = listEpisodes(d, record.resourceId)
for (const episode of episodes) {
  const poster = path.join(folder, 'cover-' + episode.episode + '.png')
  fs.copyFileSync('resources/icon.png', poster)
  d.prepare('UPDATE episode SET poster_path = ? WHERE id = ?').run(poster, episode.id)
}
// 作品自己有封面、经过识别确认、清单只缺简介 → 角标应写「缺简介」而不是笼统的「资料待补齐」（B3）
d.prepare('UPDATE video_meta SET poster_path = ? WHERE resource_id = ?').run(path.join(folder, 'cover-4.png'), record.resourceId)
d.prepare("UPDATE resource SET ai_status = 'done', description = '' WHERE id = ?").run(record.resourceId)
persistVideoWorkBundle(d, record.resourceId)
d.prepare("UPDATE video_directories SET metadata_state = 'pending', missing = ? WHERE resource_id = ?").run(JSON.stringify(['description']), record.resourceId)
d.close()
const artworkDir = path.join(folder, '.baoyi', 'artwork')
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
const errors: string[] = [], checks: string[] = []
let app: any, page: any
async function launch(hash: string) {
  app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env: environment, timeout: 30000 })
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  page = await app.firstWindow(); page.setDefaultTimeout(12000)
  page.on('pageerror', (error: Error) => errors.push(error.message))
  page.on('console', (message: any) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.waitForFunction(() => !!(window as any).baoyi)
  // 等 Vue 挂完再改 hash：早于路由初始化改会被它的首次导航盖回软件首页
  await page.locator('.app__view').waitFor()
  await page.evaluate((h: string) => { location.hash = h }, hash)
}
async function check(name: string, action: () => Promise<void>) { await action(); checks.push(name); console.log('PASS ' + name) }
const library = () => page.evaluate((id: string) => (window as any).baoyi.video.library(id), record.resourceId)
const item = () => page.evaluate((id: string) => (window as any).baoyi.video.get(id), record.resourceId)
const loaded = (selector: string) => page.waitForFunction((s: string) => [...document.querySelectorAll(s)].every(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0), selector)
try {
  await launch('/video')
  await check('B3 the wall badge names the missing item instead of a generic pending label', async () => {
    await page.locator('.work-group').first().waitFor()
    await expect(page.locator('.card__pending').first()).toHaveText('缺简介')
    await loaded('.card__img')
    await page.screenshot({ path: path.join(evidence, 'b3-wall-badge.png') })
  })
  await page.evaluate((id: string) => { location.hash = '/video/' + id }, record.resourceId)
  await page.locator('.video-item').first().waitFor()
  await check('B1 picking an episode cover installs it into <work>/.baoyi/artwork and marks it user-picked', async () => {
    assert.ok(!fs.existsSync(artworkDir), '开始前作品目录里还没有 artwork 目录')
    await page.getByRole('button', { name: '从单集选', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '从单集选封面', exact: true })
    await expect(dialog.getByRole('listitem')).toHaveCount(4)
    await loaded('.episode-artwork-dialog img')
    await page.screenshot({ path: path.join(evidence, 'b1-episode-artwork-dialog.png') })
    await dialog.getByRole('button', { name: '用第 2 集 · 封面作为作品封面', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await item()).poster_path).toMatch(/[\\/]\.baoyi[\\/]artwork[\\/]/)
    const after = await item()
    assert.ok(fs.existsSync(after.poster_path), '新封面文件真的在作品目录里')
    assert.equal(path.dirname(after.poster_path).toLowerCase(), artworkDir.toLowerCase())
    assert.ok(after.user_edited.includes('poster_path'), '亲手挑的封面要标成手改')
    assert.equal(fs.readFileSync(after.poster_path).equals(fs.readFileSync(path.join(folder, 'cover-2.png'))), true)
    await loaded('.hero__img')
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'baoyi.json'), 'utf8'))
    assert.match(manifest.work.poster, /^\.baoyi[\\/]artwork[\\/]/, '清单里的封面是相对作品目录的路径')
    await page.screenshot({ path: path.join(evidence, 'b1-after-pick.png') })
  })
  await check('B8 renumbering episode 3 into season 2 episode 1 regroups the list and lands in the manifest', async () => {
    await page.getByRole('button', { name: '管理集数', exact: true }).click()
    await page.getByRole('region', { name: '管理集数', exact: true }).waitFor()
    await page.getByLabel('Original chapter 3 的季', { exact: true }).fill('2')
    await page.getByLabel('Original chapter 3 的集号', { exact: true }).fill('1')
    await page.screenshot({ path: path.join(evidence, 'b8-manage-mode.png') })
    await page.getByRole('button', { name: '保存 1 处改动', exact: true }).click()
    await expect(page.locator('.video-items__season')).toHaveCount(2)
    await expect(page.locator('.video-items__season').last()).toContainText('第 2 季')
    const third = episodes.find(ep => ep.episode === 3)!
    const saved = await library()
    assert.deepEqual(saved.contents.map((ep: any) => `S${ep.season}E${ep.episode}`), ['S0E1', 'S0E2', 'S0E4', 'S2E1'])
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'baoyi.json'), 'utf8'))
    const entry = manifest.items.find((ep: any) => ep.id === third.id)
    assert.equal(entry.season, 2); assert.equal(entry.number, 1)
    await expect(page.getByRole('list', { name: '第 2 季的内容', exact: true }).locator('.video-item')).toHaveCount(1)
    await page.screenshot({ path: path.join(evidence, 'b8-regrouped.png') })
  })
  await check('B8 a conflicting renumber is refused as a whole and nothing changes', async () => {
    await page.getByRole('button', { name: '管理集数', exact: true }).click()
    await page.getByLabel('Original chapter 4 的集号', { exact: true }).fill('2')
    await page.getByRole('button', { name: '保存 1 处改动', exact: true }).click()
    await expect(page.locator('.toast').filter({ hasText: '编号存在冲突' })).toHaveCount(1)
    assert.deepEqual((await library()).contents.map((ep: any) => `S${ep.season}E${ep.episode}`), ['S0E1', 'S0E2', 'S0E4', 'S2E1'])
    await page.getByRole('button', { name: '取消', exact: true }).click()
  })
  await app.close(); app = undefined
  await launch('/video/' + record.resourceId)
  await check('restart keeps the picked poster, the season grouping and playable files', async () => {
    await page.locator('.video-item').first().waitFor()
    await loaded('.hero__img')
    await expect(page.locator('.video-items__season').last()).toContainText('第 2 季')
    const after = await item()
    assert.equal(path.dirname(after.poster_path).toLowerCase(), artworkDir.toLowerCase())
    assert.ok(after.user_edited.includes('poster_path'))
    const result = await library()
    assert.equal(result.assets.filter((asset: any) => asset.role === 'video' && asset.state === 'present').length, 4)
  })
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ executable, profile, checks, errors }, null, 2))
  console.log('Field test round 2 packaged: ' + checks.length + ' passed / 0 failed')
} catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); throw error }
finally { if (app) await app.close() }
