import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron } from 'playwright'
import { expect } from 'playwright/test'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'

const output = path.resolve(process.argv[3] || 'output/library-review')
await fs.mkdir(output, { recursive: true })
const profile = await fs.mkdtemp(path.join(output, 'novel-ui-'))
const file = path.join(profile, '章节与摘录.txt')
await fs.writeFile(file, Array.from({ length: 4 }, (_, chapter) =>
  `第${chapter + 1}章\r\n` + Array.from({ length: 40 }, (_, n) => `这是章节${chapter + 1}的正文${n}，用来验证滚动位置和摘录定位。`).join('\r\n'),
).join('\r\n'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'light', hanime_builtin_hosts: false }))
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
const docs = new DocumentLibrary(db), item = await docs.register(file, 'novel')
docs.savePosition(item.id, { page: 3, offset: 0.5 }, 4)
db.close()
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const packagedExe = process.argv[2]
const app = await _electron.launch({ executablePath: path.resolve(packagedExe || 'node_modules/electron/dist/electron.exe'), args: [...(packagedExe ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env })
const page = await app.firstWindow(), errors: string[] = []
page.on('pageerror', e => errors.push(e.message))
page.setDefaultTimeout(10000)
const saved = () => page.evaluate(id => (window as any).baoyi.workspace.documents.get(id), item.id)
try {
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile)
  if (packagedExe) assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setSize(1280, 900) })
  await page.locator('.app__view').waitFor()
  await page.evaluate(id => { location.hash = '/document/' + id }, item.id)
  await expect(page.locator('.novel-chapter-header')).toHaveText('第3章')
  await page.locator('.reader-viewport').evaluate(e => { e.scrollTop = (e.scrollHeight - e.clientHeight) * 0.6 })
  await expect.poll(async () => { const value = await saved(); return value.position.page === 3 && Math.abs(value.position.offset - 0.6) < 0.03 }, { timeout: 5000 }).toBe(true)
  await page.reload()
  await expect(page.locator('.novel-chapter-header')).toHaveText('第3章')
  await expect.poll(() => page.locator('.reader-viewport').evaluate(e => e.scrollTop / Math.max(1, e.scrollHeight - e.clientHeight))).toBeGreaterThan(0.5)
  const paragraph = page.locator('.novel-paragraph').filter({ hasText: '正文20，' })
  await paragraph.scrollIntoViewIfNeeded()
  await paragraph.evaluate(e => { const range = document.createRange(); range.selectNodeContents(e); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); e.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
  await page.getByRole('button', { name: '高亮', exact: true }).click()
  await expect(page.locator('.annotation-highlight')).not.toHaveCount(0)
  const notes = await page.evaluate(id => (window as any).baoyi.workspace.documents.annotations(id), item.id)
  assert.equal(notes[0].location.page, 3, 'excerpt uses chapter number, not paragraph number')
  await page.locator('.header-reader-tools').getByRole('button', { name: '上一章', exact: true }).click()
  await expect(page.locator('.novel-chapter-header')).toHaveText('第2章')
  await expect(page.locator('.annotation-highlight')).toHaveCount(0)
  await page.locator('.annotation-card').first().click()
  await expect(page.locator('.novel-chapter-header')).toHaveText('第3章')
  await expect(page.locator('.annotation-highlight.active').first()).toBeVisible()
  await page.screenshot({ path: path.join(output, 'novel-reader.png') })
  assert.deepEqual(errors, [])
  console.log('PASS: novel chapter/scroll restart, chapter-scoped excerpt, cross-chapter return and highlight')
} catch (error) {
  await page.screenshot({ path: path.join(output, 'novel-reader-failure.png') }).catch(() => {})
  throw error
} finally { await app.close() }
