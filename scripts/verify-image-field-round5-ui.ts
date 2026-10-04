/** 第五轮图片实测修复：首页专属「继续阅读」、已入库作品不再进批量勾选、打开所在文件夹、阅读器最大化铺满窗口。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { pngImage } from './helpers/test-images.ts'
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const packed = process.argv[2]
const output = path.resolve('output/image-field-round5' + (packed ? '-packaged' : '')); fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', hanime_builtin_hosts: false })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
const root = path.join(profile, 'media')
for (let c = 1; c <= 2; c++) {
  const directory = path.join(root, 'chapter-' + c); fs.mkdirSync(directory, { recursive: true })
  for (let n = 1; n <= 4; n++) fs.writeFileSync(path.join(directory, n + '.png'), pngImage(720, 1080, [30 + n * 25, 60 + c * 35, 110]))
}
const library = new ImageLibrary(db)
const item = library.register((await scanImageImport(root, 'comic', false))[0])
// 作品必须落在某个分类里。否则切到该分类时书架本来就是空的，
// 「首页专属」会因为「没有可继续的书」而假通过 —— 那是两个不同的原因。
library.update(item.id, { groupId: 'image-group-1' })
library.saveProgress(item.id, library.pages(item.id)[0].id, 0)
db.prepare("UPDATE image_meta SET source='pica', source_id='rank1' WHERE resource_id=?").run(item.id)
db.prepare("UPDATE image_chapters SET source_id='chapter-'||(ordinal+1) WHERE resource_id=?").run(item.id)
// 打开所在文件夹对目录和归档（zip／cbz）是两条分支：目录走「打开目录」，归档要走
// 「在资源管理器里选中」。归档这条另备一件作品来验，路径在启动前就改成归档文件。
const archive = path.join(profile, 'archived-work.cbz')
fs.writeFileSync(archive, 'fixture')
const archivedRoot = path.join(profile, 'archived'); fs.mkdirSync(archivedRoot, { recursive: true })
for (let n = 1; n <= 2; n++) fs.writeFileSync(path.join(archivedRoot, n + '.png'), pngImage(640, 960, [90, 40 + n * 30, 150]))
const archivedItem = library.register((await scanImageImport(archivedRoot, 'comic', false))[0])
db.prepare('UPDATE resource SET path=? WHERE id=?').run(archive, archivedItem.id)
db.close()
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const app = await _electron.launch({ executablePath: path.resolve(packed || 'node_modules/electron/dist/electron.exe'), args: [...(packed ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
const checks: string[] = [], errors: string[] = []
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(6000); page.on('pageerror', (e: Error) => errors.push(e.message))
  await page.waitForFunction(() => !!window.baoyi?.image)
  assert.equal(path.resolve(await app.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.evaluate(() => { location.hash = '/image' })
  await page.locator('.image-card').first().waitFor()

  // 1. 继续阅读只属于首页
  await page.locator('.image-continue').waitFor()
  assert.ok(await page.locator('.continue-card').count() >= 1, '首页要有继续阅读卡片')
  await page.getByRole('button', { name: /喜欢的作品/ }).click()
  // 摘除区块是异步渲染的结果：直接数 count 会读到点击那一帧的 DOM，必须等它真的摘掉
  await page.locator('.image-continue').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.image-card').count(), 1, '切到分类后书架仍然有这件作品')
  assert.equal(await page.locator('.image-continue').count(), 0, '切到分类后不该再显示继续阅读')
  await page.getByRole('button', { name: /全部漫画/ }).click()
  await page.locator('.image-continue').waitFor()
  checks.push('continue-reading-home-only')

  // 2. 已入库标注的查询依据
  const state = await page.evaluate(() => window.baoyi.image.sourceOwned(['rank1', 'missing']))
  assert.deepEqual(state.owned, ['rank1'])
  assert.deepEqual(state.queued, [])
  assert.deepEqual([...state.chapters.rank1].sort(), ['chapter-1', 'chapter-2'])
  checks.push('source-owned-query')

  // 3. 打开所在文件夹
  await app.evaluate(({ shell }: any) => {
    ;(globalThis as any).__shellFixture = { open: [] as string[], reveal: [] as string[] }
    shell.openPath = async (target: string) => { (globalThis as any).__shellFixture.open.push(target); return '' }
    shell.showItemInFolder = (target: string) => { (globalThis as any).__shellFixture.reveal.push(target) }
  })
  await page.evaluate((id: string) => { location.hash = '/image/' + id }, item.id)
  await page.locator('.detail-utilities').waitFor()
  assert.equal(await page.evaluate((id: string) => window.baoyi.image.reveal(id), archivedItem.id), true)
  assert.deepEqual(await app.evaluate(() => (globalThis as any).__shellFixture.reveal), [archive], '归档要在资源管理器里选中')
  assert.deepEqual(await app.evaluate(() => (globalThis as any).__shellFixture.open), [], '归档不能被当成目录打开')
  await page.getByRole('button', { name: '打开所在文件夹', exact: true }).click()
  let opened: string[] = []
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    opened = await app.evaluate(() => (globalThis as any).__shellFixture.open)
    if (opened.length) break
    await delay(50)
  }
  assert.deepEqual(opened, [item.path], '打开所在文件夹要打开作品自己的目录')
  assert.equal(await page.evaluate(() => window.baoyi.image.reveal('missing-id')), false, '不存在的作品要如实返回失败')
  checks.push('reveal-in-folder')

  // 4. 阅读器最大化要铺满整个窗口，不再留出顶栏
  await page.locator('.detail-actions .im-primary').click()
  await page.getByLabel('最大化阅读窗口', { exact: true }).click()
  const size = await app.evaluate(({ BrowserWindow }: any) => { const s = BrowserWindow.getAllWindows()[0].getContentSize(); return { width: s[0], height: s[1] } })
  const box = await page.locator('.image-reader').boundingBox()
  assert.equal(Math.round(box!.y), 0, '最大化后阅读器要盖住顶栏')
  assert.ok(Math.abs(box!.height - size.height) <= 1, '阅读器高度应等于窗口高度')
  assert.ok(Math.abs(box!.width - size.width) <= 1, '阅读器宽度应等于窗口宽度')
  await page.screenshot({ path: path.join(output, 'reader-maximized.png') })
  await page.getByLabel('还原阅读窗口', { exact: true }).click()
  await page.waitForFunction(() => Math.round(document.querySelector('.image-reader')!.getBoundingClientRect().top) > 0)
  assert.ok((await page.locator('.image-reader').boundingBox())!.y > 0, '还原后回到浮动位置')
  await page.getByLabel('关闭阅读器', { exact: true }).click()
  checks.push('reader-maximized-covers-titlebar')

  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ profile, executable: packed || 'node_modules/electron/dist/electron.exe', checks, errors }, null, 2))
  console.log('PASS ' + checks.join(', '))
} catch (error) {
  const page = await app.firstWindow()
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  throw error
} finally { await app.close() }
