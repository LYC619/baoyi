import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { normalizeDownloadProgress } from '../electron/kinds/image/download-progress.ts'
import type { ImageDownloadJob } from '../src/types/image.ts'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output = path.resolve('output/image-optimization/progress-ui' + (process.argv[2] ? '-packaged' : ''))
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', hanime_builtin_hosts: false })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
db.close()
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const executable = path.resolve(process.argv[2] || 'node_modules/electron/dist/electron.exe')
const application = await _electron.launch({ executablePath: executable, args: [...(process.argv[2] ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
const job: ImageDownloadJob = {
  id: 'progress-fixture', work: { id: 'synthetic', title: '长标题与下载状态验证'.repeat(12), author: 'fixture', description: '', tags: [], chapters: 2, pages: 100, finished: true },
  chapters: [{ id: 'one', title: '第一章', order: 1 }, { id: 'two', title: '第二章', order: 2 }],
  root: profile, groupId: null, status: 'running', processed: 30, total: 100, completedChapters: 0,
  current: '第一章', error: '', updatedAt: Date.now(), resourceId: '',
  progress: normalizeDownloadProgress({ phase: 'receiving', totalKnown: true, catalogChapters: 2, chapterIndex: 1, chapterProcessed: 30, chapterTotal: 50, storedBytes: 1024 ** 2, receivedBytes: 1024 ** 2, bytesPerSecond: 128 * 1024 }),
}
try {
  assert.equal(path.resolve(await application.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  const page = await application.firstWindow(); page.setDefaultTimeout(6000)
  const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message))
  await page.waitForFunction(() => !!window.baoyi?.image)
  await application.evaluate(({ ipcMain, BrowserWindow }: any, fixture: ImageDownloadJob) => {
    ipcMain.removeHandler('image:source-status'); ipcMain.handle('image:source-status', () => true)
    ipcMain.removeHandler('image:jobs'); ipcMain.handle('image:jobs', () => [(globalThis as any).__progressJob])
    ;(globalThis as any).__progressJob = fixture
    BrowserWindow.getAllWindows()[0].webContents.send('image:changed')
    BrowserWindow.getAllWindows()[0].webContents.send('image:jobs-changed')
  }, job)
  await page.evaluate(() => { location.hash = '/image' })
  await page.getByRole('button', { name: '从哔咔添加', exact: true }).click()
  const panel = page.locator('.image-download-list')
  await panel.locator('article').waitFor()
  await panel.getByRole('progressbar', { name: '整部页数', exact: true }).waitFor()
  assert.equal(await panel.getByRole('progressbar', { name: '整部页数', exact: true }).getAttribute('max'), '100')
  assert.equal(await panel.getByRole('progressbar', { name: '当前章节页数', exact: true }).getAttribute('max'), '50')
  await panel.getByText('128 KB/s', { exact: true }).waitFor()
  for (const [width, height] of [[1440, 960], [960, 640]]) {
    await application.evaluate(({ BrowserWindow }: any, size: number[]) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
    await panel.scrollIntoViewIfNeeded()
    assert.equal(await panel.locator('article').evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth), false)
    await page.screenshot({ path: path.join(output, `progress-${width}.png`) })
  }
  await application.evaluate(({ BrowserWindow }: any) => {
    Object.assign((globalThis as any).__progressJob.progress, { phase: 'rate-limited', retryAt: Date.now() + 5000, bytesPerSecond: 0 })
    BrowserWindow.getAllWindows()[0].webContents.send('image:jobs-changed')
  })
  await panel.getByText('等待限流', { exact: true }).waitFor()
  assert.equal(await panel.getByText('128 KB/s', { exact: true }).count(), 0)
  await application.evaluate(({ BrowserWindow }: any) => {
    Object.assign((globalThis as any).__progressJob.progress, { phase: 'catalog', totalKnown: false, catalogChapters: 1 })
    BrowserWindow.getAllWindows()[0].webContents.send('image:jobs-changed')
  })
  await panel.getByText('读取章节目录', { exact: true }).waitFor()
  assert.equal(await panel.getByRole('progressbar', { name: '整部页数', exact: true }).getAttribute('value'), null)
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ profile, executable, checks: ['job-progress', 'chapter-progress', 'speed', 'task-only-event', 'rate-limited', 'indeterminate-catalog', 'long-title', '1440x960', '960x640'], errors }, null, 2))
  console.log('PASS 下载进度 UI、速率、独立任务通知、限流状态和长标题窄窗口')
} catch (error) {
  const page = await application.firstWindow()
  await page.screenshot({ path: path.join(output, 'failure.png') })
  throw error
} finally { await application.close() }
