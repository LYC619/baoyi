/** User-visible UX regression against real Electron with a disposable library. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { pngImage } from './helpers/test-images.ts'
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const packed = process.argv[2]
const output = path.resolve('output/image-ux' + (packed ? '-packaged' : '')); fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', hide_hentai: false, hanime_builtin_hosts: false })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
for (const [id, kind] of [['software-only', 'ai-identify'], ['game-only', 'game-scan'], ['video-only', 'video-scan']]) {
  db.prepare('INSERT INTO task_records (id,kind,title,status,started_at,events) VALUES(?,?,?,?,?,?)').run(id, kind, id, 'failed', Date.now(), '[]')
}
for (let c = 1; c <= 2; c++) {
  const directory = path.join(profile, 'media', 'chapter-' + c); fs.mkdirSync(directory, { recursive: true })
  for (let n = 1; n <= 4; n++) fs.writeFileSync(path.join(directory, n + '.png'), pngImage(720, 1080, [30 + n * 25, 60 + c * 35, 110]))
}
const library = new ImageLibrary(db)
const item = library.register((await scanImageImport(path.join(profile, 'media'), 'comic', false))[0])
const pages = library.pages(item.id); db.close()
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const app = await _electron.launch({ executablePath: path.resolve(packed || 'node_modules/electron/dist/electron.exe'), args: [...(packed ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env })
const checks: string[] = [], failures: string[] = [], errors: string[] = []
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(3500); page.on('pageerror', (e: Error) => errors.push(e.message))
  await page.waitForFunction(() => !!window.baoyi?.image)
  assert.equal(path.resolve(await app.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  const test = async (name: string, action: () => Promise<void>) => { try { await action(); checks.push(name); console.log('PASS', name) } catch (e) { failures.push(name + ': ' + (e as Error).message); console.error('FAIL', name, (e as Error).message); await page.screenshot({ path: path.join(output, 'failure-' + name + '.png') }) } }
  const detail = async () => { await page.evaluate((id: string) => { location.hash = '/image/' + id }, item.id); await page.locator('.detail-chapters button').first().waitFor() }
  await detail()
  await test('chapter-preview', async () => {
    await page.locator('.detail-chapters button').filter({ hasText: 'chapter-2' }).click()
    assert.equal(await page.locator('.image-reader').count(), 0, 'chapter selection must only change preview')
    assert.equal(await page.locator('.detail-pages .image-cover').count(), 4)
    assert.equal(await page.locator('.detail-pages button[aria-label="打开第 5 页"]').count(), 1)
    assert.equal((await page.evaluate((id: string) => window.baoyi.image.get(id), item.id)).progress, null)
    await page.getByRole('button', { name: '打开第 5 页', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.reader-bottom span')?.textContent?.includes('5 / 8'))
    await page.getByLabel('关闭阅读器', { exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '打开第 5 页')
  })
  if (await page.locator('.image-reader').count()) await page.getByLabel('关闭阅读器', { exact: true }).click()
  await test('compact-tools', async () => {
    const tool = page.getByRole('button', { name: '检查完整性', exact: true })
    const box = await tool.boundingBox(), row = await page.locator('.detail-utilities').boundingBox()
    assert.ok(box && row && row.height <= 60, 'idle tools occupy one compact row')
    await tool.click(); await page.getByLabel('文件检查结果', { exact: true }).waitFor()
    await page.getByRole('button', { name: '收起文件检查', exact: true }).click()
    assert.equal(await page.getByLabel('文件检查结果', { exact: true }).isVisible(), false)
    await page.getByRole('button', { name: '展开文件检查结果', exact: true }).click()
    assert.equal(await page.getByLabel('文件检查结果', { exact: true }).isVisible(), true)
  })
  await test('reader-navigation', async () => {
    await page.locator('.detail-actions .im-primary').click()
    await page.getByLabel('单页阅读', { exact: true }).click()
    await page.keyboard.press('Home')
    const current = (n: number) => page.waitForFunction((n: number) => document.querySelector('.reader-bottom span')?.textContent?.includes(n + ' / 8'), n)
    await current(1)
    const viewport = await page.locator('.reader-viewport').boundingBox()
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
    await page.mouse.wheel(0, 120); await current(2)
    await page.mouse.wheel(0, 240); await page.waitForTimeout(80); await current(2)
    await page.getByRole('button', { name: '后一页', exact: true }).click(); await current(3)
    const jump = page.getByRole('spinbutton', { name: '跳转页码', exact: true })
    await jump.fill('7'); await jump.press('Enter'); await current(7)
    await jump.fill('999'); await jump.press('Enter'); await current(8)
    await jump.fill(''); await jump.press('Enter'); await current(8)
    await page.getByLabel('放大图片', { exact: true }).click()
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
    const originalPan = await page.locator('.reader-spread').boundingBox()
    await page.mouse.wheel(0, 120)
    await page.waitForFunction((y: number) => document.querySelector('.reader-spread')!.getBoundingClientRect().y < y - 10, originalPan.y)
    await current(8)
    await page.getByLabel('重置缩放', { exact: true }).click()
    await page.getByLabel('阅读设置', { exact: true }).click()
    await page.getByLabel('阅读方向', { exact: true }).selectOption('rtl')
    await page.getByLabel('阅读设置', { exact: true }).click()
    await page.getByRole('button', { name: '后一页', exact: true }).click(); await current(7)
    await page.mouse.move(viewport.x + 200, viewport.y + 200); await page.mouse.down(); await page.mouse.move(viewport.x + 260, viewport.y + 180, { steps: 5 }); await page.mouse.up(); await current(7)
    await page.getByLabel('连续阅读', { exact: true }).click()
    await page.locator('.reader-viewport').evaluate((el: HTMLElement) => { el.scrollTop = 0 })
    await page.locator('.reader-viewport').click({ position: { x: 100, y: 100 } }); await page.keyboard.press('Space')
    assert.ok(await page.locator('.reader-viewport').evaluate((el: HTMLElement) => el.scrollTop > 0))
    await page.getByLabel('单页阅读', { exact: true }).click()
    await page.getByLabel('关闭阅读器', { exact: true }).focus(); await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.image-reader')), true)
    for (const [width, height] of [[1440, 900], [960, 640]]) {
      await app.evaluate(({ BrowserWindow }: any, size: number[]) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
      await page.screenshot({ path: path.join(output, 'reader-' + width + '.png') })
      assert.equal(await page.locator('.reader-tools').evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth), false)
    }
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.image-reader').count(), 0)
  })
  if (await page.locator('.image-reader').count()) await page.getByLabel('关闭阅读器', { exact: true }).click()
  await test('module-logs', async () => {
    await page.locator('.task-trigger').click()
    await page.waitForFunction(() => { const el = document.querySelector('.task-panel'); return el && getComputedStyle(el).opacity === '1' && !el.className.includes('enter-') })
    assert.match(await page.locator('#task-center-title').innerText(), /图片/)
    assert.equal(await page.getByRole('button', { name: '识别与调用', exact: true }).count(), 0)
    assert.ok(!(await page.locator('.task-panel').innerText()).includes('video-only'))
    await page.screenshot({ path: path.join(output, 'image-logs.png') })
    await page.getByLabel('关闭日志面板', { exact: true }).click()
    await page.evaluate(() => { location.hash = '/' })
    await page.waitForFunction(() => !document.querySelector('.image-detail'))
    await page.locator('.task-trigger').click()
    await page.getByText('software-only', { exact: true }).waitFor()
    await page.waitForFunction(() => { const el = document.querySelector('.task-panel'); return el && getComputedStyle(el).opacity === '1' && !el.className.includes('enter-') })
    assert.ok(!(await page.locator('.task-panel').innerText()).includes('game-only'))
    assert.ok(!(await page.locator('.task-panel').innerText()).includes('video-only'))
    await page.screenshot({ path: path.join(output, 'software-logs.png') })
    await page.getByRole('button', { name: '清除历史', exact: true }).click()
    const tasks = await page.evaluate(() => window.baoyi.tasks.list())
    assert.deepEqual(tasks.map((t: any) => t.id).sort(), ['game-only', 'video-only'])
    await page.getByLabel('关闭日志面板', { exact: true }).click()
  })
  if (await page.locator('.task-trigger').getAttribute('aria-expanded') === 'true') await page.getByLabel('关闭日志面板', { exact: true }).click()
  await test('themes-layout', async () => {
    await page.evaluate(() => { location.hash = '/image' })
    await page.getByLabel('图片排序', { exact: true }).waitFor()
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme: string) => { document.documentElement.dataset.theme = theme }, theme)
      const colors = await page.getByLabel('图片排序', { exact: true }).evaluate((el: HTMLSelectElement) => ({ scheme: getComputedStyle(el).colorScheme, background: getComputedStyle(el.options[0]).backgroundColor, color: getComputedStyle(el.options[0]).color }))
      assert.equal(colors.scheme, theme)
      assert.notEqual(colors.background, 'rgba(0, 0, 0, 0)')
      assert.notEqual(colors.background, colors.color)
      const luminance = (color: string) => color.match(/\d+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
      const bg = luminance(colors.background), fg = luminance(colors.color)
      assert.ok((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) >= 4.5, 'menu option contrast must be readable')
      await page.screenshot({ path: path.join(output, 'shelf-' + theme + '.png') })
    }
    await detail()
    for (const [width, height] of [[1440, 900], [960, 640]]) {
      await app.evaluate(({ BrowserWindow }: any, size: number[]) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
      await page.screenshot({ path: path.join(output, 'detail-' + width + '.png') })
      await page.locator('.detail-chapters').scrollIntoViewIfNeeded()
      await page.locator('.detail-pages').scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(output, 'chapter-preview-' + width + '.png') })
      assert.equal(await page.locator('.image-detail').evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth), false)
    }
  })
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ profile, checks, failures, errors, pageIds: pages.map(p => p.id) }, null, 2))
  assert.deepEqual(errors, []); assert.deepEqual(failures, [])
  console.log('PASS ' + checks.join(', '))
} finally { await app.close() }
