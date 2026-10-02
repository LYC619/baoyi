import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { createImageDownloads } from '../electron/kinds/image/downloads.ts'
import { PicacomicSource } from '../electron/kinds/image/source.ts'
import { pngImage } from './helpers/test-images.ts'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const packedExecutable = process.argv[2]
const executable = path.resolve(packedExecutable || 'node_modules/electron/dist/electron.exe')
const output = path.resolve('output/image-optimization/updates-ui' + (packedExecutable ? '-packaged' : '')); fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-')), media = path.join(profile, 'media'); fs.mkdirSync(media)
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', hanime_builtin_hosts: false })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
const data = pngImage(240, 360)
const source = new PicacomicSource({ token: () => 'fixture', fetch: async raw => {
  const n = raw.match(/order\/(\d+)/)?.[1] || '1'
  return raw.includes('/static/') ? new Response(new Uint8Array(data)) : Response.json({ code: 200, data: { pages: { pages: 1, docs: [{ _id: 'p' + n, media: { fileServer: 'https://images.picacomic.com', path: n } }] } } })
} })
const queue = createImageDownloads({ db, source, changed: () => {} })
await queue.enqueue({ id: 'work', title: '本地保留的名称', author: '', description: '本地备注', tags: ['本地标签'], chapters: 2, pages: 2, finished: false }, [{ id: 'c1', title: '第一章', order: 1 }, { id: 'c2', title: '第二章', order: 2 }], media, null)
await queue.idle(); assert.equal(queue.list()[0].status, 'success')
const library = new ImageLibrary(db), item = library.list()[0], pages = library.pages(item.id)
fs.unlinkSync(pages[0].file); db.close()
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const app = await _electron.launch({ executablePath: executable, args: [...(packedExecutable ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
try {
  assert.equal(path.resolve(await app.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  await app.evaluate(({ net }: any, png: string) => {
    ;(globalThis as any).__updateCalls = []
    net.fetch = async (raw: string) => {
      const pathname = new URL(raw).pathname; (globalThis as any).__updateCalls.push(pathname)
      if (pathname.endsWith('sign-in')) return Response.json({ code: 200, data: { token: 'fixture' } })
      if (pathname.endsWith('/eps')) return Response.json({ code: 200, data: { eps: { pages: 1, docs: [1, 2, 3, 4].map(n => ({ _id: 'c' + n, title: ['第一章', '第二章', '第三章 · 长标题测试与多行显示', '第四章'][n - 1], order: n })) } } })
      const n = pathname.match(/order\/(\d+)/)?.[1]
      if (n) return Response.json({ code: 200, data: { pages: { pages: 1, docs: [{ _id: 'p' + n, media: { fileServer: 'https://images.picacomic.com', path: n } }] } } })
      return Response.json({ code: 200, data: { comic: { _id: 'work', title: '来源的新名称', description: '来源的新备注', tags: ['来源标签'], epsCount: 4, pagesCount: 4, finished: true } } })
    }
    net.request = (options: any) => {
      const { EventEmitter } = process.getBuiltinModule('node:events'), { PassThrough } = process.getBuiltinModule('node:stream')
      let stream: any
      const request = Object.assign(new EventEmitter(), { setHeader: () => {}, abort: () => stream?.destroy(), end: () => {} })
      request.end = () => queueMicrotask(() => {
        ;(globalThis as any).__updateCalls.push(new URL(options.url).pathname)
        stream = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'image/png' } })
        request.emit('response', stream); stream.end(Buffer.from(png, 'base64'))
      }); return request
    }
  }, data.toString('base64'))
  const page = await app.firstWindow(); page.setDefaultTimeout(8000)
  const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message))
  await page.waitForFunction(() => !!window.baoyi?.image)
  await page.evaluate((id: string) => { location.hash = '/image/' + id }, item.id)
  await page.getByRole('button', { name: '检查连载更新', exact: true }).waitFor()
  assert.deepEqual(await app.evaluate(() => (globalThis as any).__updateCalls), [], '进入作品页不自动请求来源')
  await page.getByRole('button', { name: '检查连载更新', exact: true }).click()
  await page.locator('.image-updates [role="alert"]').filter({ hasText: '请先登录' }).waitFor()
  await page.evaluate(() => window.baoyi.image.sourceLogin('fixture', 'fixture'))
  await page.getByRole('button', { name: '检查连载更新', exact: true }).click()
  const rows = page.locator('.image-updates [data-chapter-id]')
  await rows.filter({ hasText: '已下载' }).waitFor()
  assert.match(await page.locator('[data-chapter-id="c1"]').innerText(), /不完整/)
  assert.match(await page.locator('[data-chapter-id="c2"]').innerText(), /已下载/)
  assert.match(await page.locator('[data-chapter-id="c3"]').innerText(), /新增/)
  await page.getByLabel('全选新增章节', { exact: true }).uncheck()
  await page.locator('[data-chapter-id="c3"] input').check()
  assert.equal(await page.locator('[data-chapter-id="c4"] input').isChecked(), false)
  for (const [width, height] of [[1440, 960], [960, 640]]) {
    await app.evaluate(({ BrowserWindow }: any, size: number[]) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
    assert.equal(await page.locator('.update-result').evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth), false)
    await page.locator('.update-result').screenshot({ path: path.join(output, `updates-${width}.png`) })
  }
  await page.getByRole('button', { name: '下载所选新章节', exact: true }).click()
  await page.getByText('新增章节已入库', { exact: true }).waitFor()
  const updated = await page.evaluate((id: string) => window.baoyi.image.get(id), item.id)
  assert.equal(updated.name, item.name); assert.equal(updated.description, item.description); assert.deepEqual(updated.tags, item.tags)
  assert.equal(updated.path, item.path); assert.equal(updated.chapterCount, 2)
  const calls = await app.evaluate(() => (globalThis as any).__updateCalls)
  assert.deepEqual(calls.filter((url: string) => url.includes('/static/')), ['/static/3'])
  assert.equal(fs.existsSync(pages[0].file), false)
  await page.getByRole('button', { name: '检查连载更新', exact: true }).click()
  await page.locator('[data-chapter-id="c3"]').filter({ hasText: '已下载' }).waitFor()
  assert.match(await page.locator('[data-chapter-id="c4"]').innerText(), /新增/)
  await page.evaluate(() => window.baoyi.image.sourceLogout())
  await assert.rejects(page.evaluate((id: string) => window.baoyi.image.downloadUpdates(id, ['c4']), item.id), /请先登录/)
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ profile, calls, errors }, null, 2))
  console.log('PASS 手动检查、章节状态、选择新增、原目录与资料保留、无自动请求、登录保护和宽窄布局')
} finally { await app.close() }
