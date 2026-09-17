/** Packaged Electron, actual IPC and SQLite. Only an isolated profile and synthetic media are changed. */
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
import { listEpisodes, updateEpisode } from '../electron/kinds/video/db.ts'
import { pngImage } from './helpers/test-images.ts'

const require = createRequire(import.meta.url)
const runtime = process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { _electron } = require(runtime), { expect } = require(runtime + '/test')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-video-feedback-20260912/win-unpacked/抱一.exe')
assert.ok(fs.existsSync(executable))
for (const marker of ['portable.txt', '绿色版.txt']) assert.ok(!fs.existsSync(path.join(path.dirname(executable), marker)))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-native-feedback-'))
const evidence = path.resolve(process.argv[3] || 'output/video-feedback-fixes-20260912/native-feedback')
fs.mkdirSync(evidence, { recursive: true })
const libraryRoot = path.join(profile, 'videos'), folder = path.join(libraryRoot, '原生实测合集')
function file(relative: string, data: string | Buffer = 'synthetic video fixture') {
  const target = path.join(profile, relative)
  assert.ok(path.relative(profile, target) && !path.relative(profile, target).startsWith('..'))
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); return target
}
const poster = file('artwork/portrait.png', pngImage(180, 270))
const thumbnail = file('artwork/landscape.png', pngImage(320, 180, [120, 90, 60]))
const customPoster = file('artwork/selected-portrait.png', pngImage(200, 300, [90, 120, 70]))
const customThumbnail = file('artwork/selected-landscape.png', pngImage(400, 225, [90, 60, 110]))
const files = [1, 2, 3].map(i => file('videos/原生实测合集/Lesson ' + i + '.mp4'))
const singlePath = file('videos/Single/Single.mp4')
const singleInfo = file('videos/Single/info.json', JSON.stringify({ title: 'Single', introduction: 'Independent fixture', coverUrl: '', tags: ['独立作品标签'], videoUrls: {} }))
file('videos/Single/.nomedia', '')
const importPath = file('unregistered/Imported.mp4')
file('unregistered/Imported.nfo', '<movie><title>本地导入演示</title><originaltitle>Imported original</originaltitle><plot>本地资料的完整简介</plot><genre>动画</genre><tag>导入标签</tag></movie>')
file('unregistered/info.json', JSON.stringify({ title: 'Imported', introduction: '本地资料的完整简介', coverUrl: '', tags: ['导入标签'], videoUrls: {} }))
file('unregistered/.nomedia', '')
file('unregistered/Imported.png', pngImage(180, 270))
const importDirectory = path.dirname(importPath)

const d = new DatabaseSync(path.join(profile, 'baoyi.db'))
d.exec('PRAGMA foreign_keys = ON'); initSchema(d, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, hide_hentai: false, theme: 'light', video_scan_dirs: [libraryRoot] })) d.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value))
const work = registerVideoContent(d, { directory: folder, root: libraryRoot, title: '原生实测合集', category: '动画', posterPath: poster, thumbnailPath: thumbnail,
  items: files.map((p, i) => ({ title: '原生单集 ' + (i + 1), originalTitle: 'Lesson ' + (i + 1), order: i + 1, number: i + 1,
    description: '独立简介 ' + (i + 1), tags: ['独立标签' + (i + 1)], posterPath: poster, thumbnailPath: thumbnail, files: [{ path: p }] })) })
const episodeIds = listEpisodes(d, work.resourceId).map(ep => ep.id)
updateEpisode(d, episodeIds[1], { watch_status: 'watching', position_sec: 53, published_at: Date.UTC(2026, 7, 28), air_date: Date.UTC(2024, 0, 2), duration_sec: 997, studio: '原生测试厂牌' })
persistVideoWorkBundle(d, work.resourceId)
const single = registerVideoContent(d, { title: '原生独立视频', category: '动画', items: [{ title: 'Single', order: 1, files: [{ path: singlePath }], attachments: [{ path: singleInfo, role: 'attachment' }] }] })
d.prepare("UPDATE video_meta SET video_type = 'series' WHERE resource_id = ?").run(single.resourceId)
d.close()
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
const errors: string[] = [], checks: string[] = []
let app: any, page: any, importedId = '', detachedId = '', moveId = ''
async function launch() {
  app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env: environment, timeout: 30000 })
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  page = await app.firstWindow(); page.setDefaultTimeout(15000)
  page.on('pageerror', (error: Error) => errors.push(error.message))
  page.on('console', (message: any) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.waitForFunction(() => !!(window as any).baoyi)
  await page.locator('.app__view').waitFor()
  await home()
}
async function route(hash: string) {
  await page.evaluate((hash: string) => { location.hash = hash }, hash)
  await page.waitForFunction(() => !document.querySelector('.page-enter-active,.page-leave-active'))
}
async function home() {
  await route('/video')
  await page.getByRole('button', { name: '批量管理', exact: true }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: '批量管理', exact: true }).waitFor()
}
async function detail(id = work.resourceId) {
  await route('/video/' + id)
  await page.locator('.video-item').first().waitFor()
}
async function library(id = work.resourceId): Promise<any> { return page.evaluate((id: string) => (window as any).baoyi.video.library(id), id) }
async function get(id: string): Promise<any> { return page.evaluate((id: string) => (window as any).baoyi.video.get(id), id) }
async function pick(target: string) { await app.evaluate(({ dialog }: any, target: string) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }) }, target) }
async function check(name: string, run: () => Promise<void>) { await run(); checks.push(name); console.log('PASS ' + name) }
try {
  await launch()
  await check('the containing-folder button reveals a video file even when its display type is a collection', async () => {
    await detail(single.resourceId)
    await app.evaluate(({ shell }: any) => {
      const state = globalThis as any
      state.__folderTest = { calls: [], openPath: shell.openPath, showItemInFolder: shell.showItemInFolder }
      shell.openPath = async (file: string) => { state.__folderTest.calls.push(['open', file]); return '' }
      shell.showItemInFolder = (file: string) => { state.__folderTest.calls.push(['reveal', file]) }
    })
    try {
      await page.getByRole('button', { name: '打开所在文件夹', exact: true }).click()
      await expect.poll(() => app.evaluate(() => (globalThis as any).__folderTest.calls)).toEqual([['reveal', singlePath]])
    } finally {
      await app.evaluate(({ shell }: any) => {
        const state = globalThis as any
        shell.openPath = state.__folderTest.openPath; shell.showItemInFolder = state.__folderTest.showItemInFolder
        delete state.__folderTest
      })
    }
    await home()
  })
  await check('ordinary directory import automatically registers local NFO and artwork without a manifest', async () => {
    assert.equal(fs.existsSync(path.join(importDirectory, 'baoyi.json')), false)
    await pick(importDirectory)
    await page.getByRole('button', { name: '导入目录', exact: true }).click()
    await expect(page.locator('.scan-results')).toContainText('本轮已入库 1 项')
    await expect(page.locator('.scan-results')).toContainText('无需再次注册')
    const items = await page.evaluate(() => (window as any).baoyi.video.list({}))
    assert.equal(items.length, 3)
    const imported = items.find((item: any) => item.name_zh === '本地导入演示')
    assert.ok(imported); importedId = imported.id
    assert.equal(imported.name_en, 'Imported original'); assert.ok(imported.tags.includes('导入标签')); assert.ok(imported.poster_path)
    const again = await page.evaluate((directory: string) => (window as any).baoyi.video.scan([directory]), importDirectory)
    assert.equal(again.skipped, 1); assert.equal(again.failed, 0); assert.equal(again.tokens, 0)
  })
  await check('native image protocol shows the portrait and landscape on their separate surfaces', async () => {
    await detail()
    await expect(page.locator('.video-item')).toHaveCount(3)
    await page.waitForFunction(() => [...document.querySelectorAll('.video-item__cover img, .hero__img')].every(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))
    const sizes = await page.locator('.video-item__cover img').evaluateAll((images: HTMLImageElement[]) => images.map(img => [img.naturalWidth, img.naturalHeight]))
    assert.deepEqual(sizes, [[320, 180], [320, 180], [320, 180]])
    assert.deepEqual(await page.locator('.hero__img').evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]), [180, 270])
    await page.screenshot({ path: path.join(evidence, 'content-landscapes.png') })
  })
  await check('independent episode tags and selected artwork persist through real IPC', async () => {
    await page.locator('.video-item__cover').nth(1).click()
    await expect(page.getByLabel('单集基本资料')).toContainText('2026-08-28')
    await expect(page.getByLabel('单集基本资料')).toContainText('2024-01-02')
    await expect(page.getByLabel('单集基本资料')).toContainText('原生测试厂牌')
    await page.getByRole('button', { name: '编辑这一集', exact: true }).click()
    const tags = page.getByPlaceholder('单集标签，用顿号分隔')
    await tags.fill('原生单集新标签、保留标签'); await tags.press('Enter')
    await expect.poll(async () => (await library()).contents[1].tags).toEqual(['原生单集新标签', '保留标签'])
    await page.getByRole('button', { name: '完成单集编辑', exact: true }).click()
    await pick(customPoster); await page.getByRole('button', { name: '选择封面', exact: true }).click()
    await expect.poll(() => page.getByAltText('单集封面', { exact: true }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(200)
    await pick(customThumbnail); await page.getByRole('button', { name: '选择预览图', exact: true }).click()
    await expect.poll(() => page.getByAltText('单集预览图', { exact: true }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(400)
    const result = await library(); assert.deepEqual(result.contents[0].tags, ['独立标签1']); assert.equal(result.contents[1].position_sec, 53)
    assert.ok(result.contents[1].poster_path !== result.contents[1].thumbnail_path)
    const bundle = JSON.parse(fs.readFileSync(path.join(folder, 'baoyi.json'), 'utf8'))
    assert.deepEqual(bundle.items.find((ep: any) => ep.id === episodeIds[1]).tags, ['原生单集新标签', '保留标签'])
    await page.screenshot({ path: path.join(evidence, 'episode-dual-artwork.png') })
  })
  await check('collection group can be changed directly without editing the whole work', async () => {
    await page.getByRole('tab', { name: '文件与资料', exact: true }).click()
    await page.getByLabel('视频分组').fill('原生直接分组'); await page.getByLabel('视频分组').press('Tab')
    await expect.poll(async () => (await get(work.resourceId)).collection_name).toBe('原生直接分组')
  })
  await check('home expansion and episode-tag filtering point to the matching episode', async () => {
    await home()
    await page.getByRole('button', { name: '展开 3 集', exact: true }).click()
    await expect(page.locator('.collection-episodes button')).toHaveCount(3)
    const sizes = await page.evaluate(() => {
      const work = document.querySelector('.work-card .card__poster')!.getBoundingClientRect()
      const episodes = [...document.querySelectorAll('.collection-episodes .card__poster')].map(element => element.getBoundingClientRect())
      return { width: work.width, height: work.height, episodes: episodes.map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })), text: document.querySelector('.collection-episodes')!.textContent }
    })
    assert.equal(sizes.episodes.length, 3)
    assert.ok(sizes.episodes.every((rect: { width: number; height: number }) => Math.abs(rect.width - sizes.width) < 1 && Math.abs(rect.height - sizes.height) < 1))
    assert.ok(sizes.episodes[1].x > sizes.episodes[0].x && Math.abs(sizes.episodes[1].y - sizes.episodes[0].y) < 1)
    assert.ok(!sizes.text.includes('原生单集新标签'))
    await page.screenshot({ path: path.join(evidence, 'horizontal-episode-cards.png') })
    await page.locator('.collection-episodes button').nth(1).click()
    await page.getByRole('button', { name: '编辑这一集', exact: true }).waitFor()
    await page.getByRole('tabpanel', { name: '剧情简介', exact: true }).getByText('原生单集新标签', { exact: true }).click()
    await expect(page.locator('.collection-episodes button')).toHaveCount(1)
    await expect(page.locator('.collection-episodes')).toContainText('原生单集 2')
    await page.locator('.collection-episodes button').click()
    await expect(page.getByRole('tabpanel', { name: '剧情简介', exact: true })).toContainText('独立简介 2')
  })
  await check('bulk work groups and tags use the packaged database', async () => {
    await home(); await page.getByRole('button', { name: '批量管理', exact: true }).click()
    for (const title of ['原生实测合集', '原生独立视频']) await page.getByRole('button', { name: '选择作品：' + title, exact: true }).click()
    const panel = page.getByRole('region', { name: '批量管理', exact: true })
    await panel.getByLabel('收藏分组').fill('原生批量分组'); await panel.getByRole('button', { name: '设置分组', exact: true }).click()
    await expect.poll(async () => (await get(single.resourceId)).collection_name).toBe('原生批量分组')
    await panel.getByLabel('作品标签').fill('批量临时标签'); await panel.getByRole('button', { name: '加标签', exact: true }).click()
    await expect.poll(async () => (await get(work.resourceId)).tags.includes('批量临时标签')).toBe(true)
    await panel.getByRole('button', { name: '移除标签', exact: true }).click()
    await expect.poll(async () => (await get(single.resourceId)).tags.includes('批量临时标签')).toBe(false)
    await page.screenshot({ path: path.join(evidence, 'bulk-management.png') })
    await page.getByRole('button', { name: '取消选择', exact: true }).click()
  })
  await check('move collection preview preserves same-name attachments and the native journal can roll it back', async () => {
    await page.getByRole('button', { name: '创建合集', exact: true }).click()
    for (const title of ['原生独立视频', '本地导入演示']) await page.getByRole('button', { name: '选择作品：' + title, exact: true }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '组建合集', exact: true })
    await panel.getByLabel('合集名称', { exact: true }).fill('原生移动合集')
    await panel.getByText('文件整理（可选）', { exact: true }).click()
    await panel.getByLabel('同时整理文件到统一目录').check()
    await panel.getByLabel('文件处理').selectOption('move')
    const target = path.join(profile, 'moved-collection')
    await panel.getByRole('textbox', { name: /^整理目标目录/ }).fill(target)
    const apply = panel.getByRole('button', { name: '创建合集并移动文件', exact: true })
    await expect(apply).toBeEnabled(); await apply.click()
    await expect(panel.locator('.organize-journal__status')).toHaveText('已完成')
    const journals = await page.evaluate(() => (window as any).baoyi.videoOrganize.list())
    const journal = journals.find((j: any) => j.targetDirectory === target)
    assert.ok(journal); moveId = journal.id
    assert.equal(journal.files.filter((f: any) => path.basename(f.source) === 'info.json').length, 2)
    assert.equal(journal.files.filter((f: any) => path.basename(f.source) === '.nomedia').length, 1)
    assert.equal(fs.existsSync(singlePath), false); assert.equal(fs.existsSync(importPath), false)
    assert.ok(journal.files.some((f: any) => f.sourceRemoved))
    await page.screenshot({ path: path.join(evidence, 'move-completed.png') })
    await panel.getByRole('button', { name: '回退本次操作', exact: true }).click()
    await expect(panel.locator('.organize-journal__status')).toHaveText('已回退')
    assert.equal(fs.readFileSync(singlePath, 'utf8'), 'synthetic video fixture')
    assert.equal(fs.readFileSync(importPath, 'utf8'), 'synthetic video fixture')
    assert.ok(await get(single.resourceId)); assert.ok(await get(importedId))
    await panel.getByRole('button', { name: '关闭整理面板', exact: true }).click()
  })
  await check('episode removal keeps files and ordinary checks do not resurrect the record', async () => {
    await detail(); await page.locator('.video-item__cover').nth(2).click()
    await page.getByRole('button', { name: '移除 / 移出合集…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '管理这一集', exact: true })
    assert.equal(await dialog.getByRole('checkbox').isChecked(), false)
    await dialog.getByRole('button', { name: '确认移除记录', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    assert.ok(fs.existsSync(files[2]))
    const synced = await page.evaluate((id: string) => (window as any).baoyi.video.syncFiles(id), work.resourceId)
    assert.equal(synced.library.contents.length, 2)
  })
  await check('detaching one episode preserves its local file, artwork, tags and watch position', async () => {
    await page.getByRole('tab', { name: /^作品内容/ }).click(); await page.locator('.video-item__cover').nth(1).click()
    await page.getByRole('button', { name: '移除 / 移出合集…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '管理这一集', exact: true })
    await dialog.getByLabel('操作').selectOption('detach')
    await dialog.getByRole('button', { name: '确认移出合集', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const items = await page.evaluate(() => (window as any).baoyi.video.list({}))
    detachedId = items.find((item: any) => item.id !== work.resourceId && item.path === files[1])?.id
    assert.ok(detachedId); const detached = await library(detachedId)
    assert.equal(detached.contents[0].position_sec, 53)
    assert.equal(detached.contents[0].published_at, Date.UTC(2026, 7, 28))
    assert.equal(detached.contents[0].studio, '原生测试厂牌')
    assert.deepEqual(detached.contents[0].tags, ['原生单集新标签', '保留标签'])
    assert.ok(detached.contents[0].poster_path && detached.contents[0].thumbnail_path)
    assert.ok(fs.existsSync(files[1]))
    await page.evaluate((id: string) => (window as any).baoyi.video.syncFiles(id), work.resourceId)
    assert.equal((await library()).contents.length, 1)
  })
  await check('bulk deletion explicitly selected by the user sends only synthetic files to the native recycle bin', async () => {
    await home(); await page.getByRole('button', { name: '批量管理', exact: true }).click()
    for (const title of ['原生独立视频', '本地导入演示']) await page.getByRole('button', { name: '选择作品：' + title, exact: true }).click()
    await page.getByRole('region', { name: '批量管理', exact: true }).getByRole('button', { name: '删除所选…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '删除所选作品', exact: true })
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: '删除记录并移入回收站', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    assert.equal(fs.existsSync(singlePath), false); assert.equal(fs.existsSync(importPath), false)
    assert.equal(await get(single.resourceId), null); assert.equal(await get(importedId), null)
    assert.ok(fs.existsSync(files[0]) && fs.existsSync(files[1]) && fs.existsSync(files[2]))
  })
  await app.close(); app = undefined
  await launch()
  await check('restart retains independent ownership, exclusions, tags, images and completed rollback', async () => {
    await page.evaluate((directory: string) => (window as any).baoyi.video.scan([directory]), folder)
    assert.equal((await library()).contents.length, 1)
    const detached = await library(detachedId)
    assert.equal(detached.contents[0].id, episodeIds[1]); assert.equal(detached.contents[0].position_sec, 53)
    assert.deepEqual(detached.contents[0].tags, ['原生单集新标签', '保留标签'])
    const journals = await page.evaluate(() => (window as any).baoyi.videoOrganize.list())
    assert.equal(journals.find((j: any) => j.id === moveId).status, 'rolled-back')
    assert.equal(await get(single.resourceId), null); assert.equal(await get(importedId), null)
  })
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ executable, profile, checks, errors }, null, 2))
  console.log(`Native video feedback: ${checks.length} passed / 0 failed`)
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ executable, profile, checks, errors, failure: String(error) }, null, 2))
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {})
  throw error
} finally { if (app) await app.close() }
