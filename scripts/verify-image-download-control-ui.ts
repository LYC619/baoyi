import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { pngImage } from './helpers/test-images.ts'
import type { ImageDownloadJob } from '../src/types/image.ts'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output = path.resolve('output/image-optimization/control-ui' + (process.argv[2] ? '-packaged' : '')); fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-')), downloadRoot = path.join(profile, 'downloads'); fs.mkdirSync(downloadRoot)
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', hanime_builtin_hosts: false })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
db.close()
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const application = await _electron.launch({ executablePath: path.resolve(process.argv[2] || 'node_modules/electron/dist/electron.exe'), args: [...(process.argv[2] ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
try {
  assert.equal(path.resolve(await application.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  const page = await application.firstWindow(); page.setDefaultTimeout(6000)
  const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message))
  await page.waitForFunction(() => !!window.baoyi?.image)
  await application.evaluate(({ net, dialog }: any, { downloadRoot, png }: any) => {
    const state = { release: false, calls: [] as string[] }; (globalThis as any).__controlFixture = state
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [downloadRoot] })
    net.fetch = async (raw: string) => {
      const url = new URL(raw), id = url.pathname.split('/')[2]
      const ok = (data: any) => Response.json({ code: 200, data })
      if (url.pathname === '/auth/sign-in') return ok({ token: 'synthetic' })
      if (url.pathname.includes('/order/')) return ok({ pages: { pages: 1, docs: [1, 2, 3].map(n => ({ _id: 'p' + n, media: { fileServer: 'https://images.picacomic.com', path: `${id}/${n}` } })) } })
      if (url.pathname.endsWith('/eps')) return ok({ eps: { pages: 1, docs: [{ _id: 'c1', title: '第一章', order: 1 }] } })
      return ok({ comic: { _id: id, title: id + '下载测试', author: 'fixture', tags: [], epsCount: 1, pagesCount: 3, finished: true } })
    }
    net.request = (options: any) => {
      const { EventEmitter } = process.getBuiltinModule('node:events'), { PassThrough } = process.getBuiltinModule('node:stream')
      let stream: any
      const request = Object.assign(new EventEmitter(), { setHeader: () => {}, abort: () => { stream?.destroy() }, end: () => {} })
      request.end = () => queueMicrotask(() => {
        const url = new URL(options.url); state.calls.push(url.pathname)
        stream = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'image/png' } })
        request.emit('response', stream)
        if (state.release || url.pathname === '/static/alpha/1') stream.end(Buffer.from(png, 'base64'))
      })
      return request
    }
  }, { downloadRoot, png: pngImage(14, 20).toString('base64') })
  await page.evaluate(() => { location.hash = '/image' })
  await page.getByRole('button', { name: '从哔咔添加', exact: true }).click()
  await page.getByLabel('用户名', { exact: true }).fill('fixture')
  await page.getByLabel('密码', { exact: true }).fill('fixture')
  await page.getByRole('button', { name: '登录哔咔', exact: true }).click()
  await page.getByRole('button', { name: '我的收藏', exact: true }).waitFor()
  const enqueue = (id: string) => page.evaluate((id: string) => window.baoyi.image.download(id, ['c1'], null), id) as Promise<ImageDownloadJob>
  const alpha = await enqueue('alpha')
  const input = page.getByRole('spinbutton', { name: '图片下载并发', exact: true })
  await input.waitFor()
  await input.fill('3'); await input.press('Tab')
  const waitJobs = async (check: (jobs: ImageDownloadJob[]) => boolean) => {
    let jobs: ImageDownloadJob[] = [], end = Date.now() + 6000
    do { jobs = await page.evaluate(() => window.baoyi.image.jobs()); if (check(jobs)) return jobs; await delay(30) } while (Date.now() < end)
    assert.fail('下载状态未达到预期: ' + JSON.stringify(jobs.map(j => [j.work.id, j.status, j.processed])))
  }
  await waitJobs(jobs => jobs.some(j => j.id === alpha.id && j.processed === 1))
  assert.equal((await page.evaluate(() => window.baoyi.image.downloadOptions())).concurrency, 3)
  await assert.rejects(page.evaluate(() => window.baoyi.image.downloadOptions({ concurrency: 4 })), /1.*3/)
  const beta = await enqueue('beta'), gamma = await enqueue('gamma')
  const article = (id: string) => page.locator(`.image-download-list article[data-job-id="${id}"]`)
  await article(gamma.id).getByRole('button', { name: '上移任务', exact: true }).click()
  await waitJobs(jobs => jobs.find(j => j.id === gamma.id)?.queuePosition === 1)
  for (const id of [gamma.id, beta.id, alpha.id]) {
    await article(id).getByRole('button', { name: '暂停下载', exact: true }).click()
    await waitJobs(jobs => jobs.find(j => j.id === id)?.status === 'paused')
  }
  await article(alpha.id).getByText('已暂停', { exact: true }).waitFor()
  for (const [width, height] of [[1440, 960], [960, 640]]) {
    await application.evaluate(({ BrowserWindow }: any, size: number[]) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
    assert.equal(await article(alpha.id).evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth), false)
    await article(alpha.id).screenshot({ path: path.join(output, `paused-${width}.png`) })
  }
  await application.evaluate(() => { (globalThis as any).__controlFixture.release = true })
  await article(alpha.id).getByRole('button', { name: '继续下载', exact: true }).click()
  const completed = await waitJobs(jobs => jobs.find(j => j.id === alpha.id)?.status === 'success')
  assert.equal(completed.find(j => j.id === alpha.id)?.progress?.reusedPages, 1)
  const calls: string[] = await application.evaluate(() => (globalThis as any).__controlFixture.calls)
  assert.equal(calls.filter(url => url === '/static/alpha/1').length, 1)
  assert.ok(completed.filter(j => j.id !== alpha.id).every(j => j.status === 'paused'))
  await page.getByRole('button', { name: '关闭哔咔', exact: true }).click()
  await page.locator('.task-trigger').click()
  await page.locator('.task-tabs button').filter({ hasText: '下载记录' }).click()
  const panel = page.locator('.task-panel__downloads')
  assert.equal(await panel.locator(`[data-job-id="${alpha.id}"]`).count(), 0, '待处理不显示已完成的漫画')
  assert.equal(await panel.locator(`[data-job-id="${beta.id}"]`).count(), 1, '待处理保留暂停的漫画')
  await page.getByLabel('下载记录范围', { exact: true }).selectOption('all')
  await panel.locator(`[data-job-id="${alpha.id}"]`).waitFor()
  await page.getByLabel('下载记录范围', { exact: true }).selectOption('attention')
  await page.waitForFunction(() => !document.querySelector('.task-panel__downloads .download-phase')?.textContent?.includes('已入库'))
  await page.evaluate(() => window.baoyi.image.sourceLogout())
  await assert.rejects(page.evaluate((id: string) => window.baoyi.image.resumeJob(id), beta.id), /请先登录/)
  assert.equal((await page.evaluate(() => window.baoyi.image.jobs())).find((job: ImageDownloadJob) => job.id === beta.id)?.status, 'paused')
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ profile, checks: ['real-ipc', 'pause-running-and-queued', 'resume-missing-only', 'queue-move', 'concurrency-setting', 'validation', 'resume-auth', 'wide-and-narrow'], calls, errors }, null, 2))
  console.log('PASS 真实 IPC 暂停/继续、队列排序、并发设置、缺页续传、任务筛选和窗口布局')
} catch (error) {
  await (await application.firstWindow()).screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  throw error
} finally { await application.close() }
