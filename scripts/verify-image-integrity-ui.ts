import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { PicacomicSource } from '../electron/kinds/image/source.ts'
import { createImageDownloads } from '../electron/kinds/image/downloads.ts'
import { pngImage } from './helpers/test-images.ts'
import { inspectImage } from '../electron/kinds/image/metadata.ts'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const packedExecutable = process.argv[2]
const executable = path.resolve(packedExecutable || 'node_modules/electron/dist/electron.exe')
const output = path.resolve('output/image-optimization/integrity-ui' + (packedExecutable ? '-packaged' : '')); fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-')), media = path.join(profile, 'media'); fs.mkdirSync(media)
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', hanime_builtin_hosts: false })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
const data = pngImage(320, 480)
const response = { code: 200, data: { pages: { pages: 1, docs: [1, 2, 3].map(n => ({ _id: 'p' + n, media: { fileServer: 'https://images.picacomic.com', path: String(n) } })) } } }
const source = new PicacomicSource({ token: () => 'fixture', fetch: async raw => raw.includes('/static/') ? new Response(new Uint8Array(data)) : Response.json(response) })
const queue = createImageDownloads({ db, source, changed: () => {} })
await queue.enqueue({ id: 'fixture', title: '完整性检查样本', author: '', description: '', tags: [], chapters: 1, pages: 3, finished: true }, [{ id: 'c1', title: '第一章', order: 1 }], media, null)
await queue.idle(); assert.equal(queue.list()[0].status, 'success')
const library = new ImageLibrary(db), item = library.list()[0], pages = library.pages(item.id)
fs.unlinkSync(pages[1].file); fs.writeFileSync(pages[2].file, pngImage(320, 480, [9, 8, 7])); db.close()
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const app = await _electron.launch({ executablePath: executable, args: [...(packedExecutable ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
try {
  assert.equal(path.resolve(await app.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  const jpeg = Buffer.from(await app.evaluate(({ nativeImage }: any, png: string) => nativeImage.createFromBuffer(Buffer.from(png, 'base64')).toJPEG(90).toString('base64'), data.toString('base64')), 'base64')
  assert.deepEqual(inspectImage(jpeg), { width: 320, height: 480, format: 'JPEG', size: jpeg.length })
  const page = await app.firstWindow(); page.setDefaultTimeout(8000)
  const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message))
  await page.waitForFunction(() => !!window.baoyi?.image)
  await page.evaluate((id: string) => { location.hash = '/image/' + id }, item.id)
  await page.getByRole('button', { name: '检查完整性', exact: true }).click()
  await page.getByLabel('文件检查结果').waitFor()
  assert.match(await page.getByLabel('文件检查结果').innerText(), /正常\s*1/)
  assert.match(await page.getByLabel('文件检查结果').innerText(), /缺失\s*1/)
  assert.match(await page.getByLabel('文件检查结果').innerText(), /损坏\s*1/)
  const audit = await page.evaluate((id: string) => window.baoyi.image.audit(id), item.id)
  assert.equal('file' in audit.entries[0], false)
  await assert.rejects(page.evaluate((id: string) => window.baoyi.image.repair(id), item.id), /请先登录/)
  for (const [width, height] of [[1440, 960], [960, 640]]) {
    await app.evaluate(({ BrowserWindow }: any, size: number[]) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
    assert.equal(await page.locator('.audit-result').evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth), false)
    await page.locator('.audit-result').screenshot({ path: path.join(output, `audit-${width}.png`) })
  }
  await app.evaluate(({ net }: any, { response, png }: any) => {
    ;(globalThis as any).__repairCalls = []
    net.fetch = async (raw: string) => raw.includes('/auth/sign-in') ? Response.json({ code: 200, data: { token: 'fixture' } }) : Response.json(response)
    net.request = (options: any) => {
      const { EventEmitter } = process.getBuiltinModule('node:events'), { PassThrough } = process.getBuiltinModule('node:stream')
      let stream: any
      const request = Object.assign(new EventEmitter(), { setHeader: () => {}, abort: () => stream?.destroy(), end: () => {} })
      request.end = () => queueMicrotask(() => {
        ;(globalThis as any).__repairCalls.push(new URL(options.url).pathname)
        stream = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'image/png' } })
        request.emit('response', stream)
        if (!(globalThis as any).__holdRepair) stream.end(Buffer.from(png, 'base64'))
      }); return request
    }
  }, { response, png: data.toString('base64') })
  await page.evaluate(() => window.baoyi.image.sourceLogin('fixture', 'fixture'))
  await page.getByRole('button', { name: '修复异常页', exact: true }).click()
  await page.getByText('修复完成', { exact: true }).waitFor()
  assert.match(await page.getByLabel('文件检查结果').innerText(), /正常\s*3/)
  const calls = await app.evaluate(() => (globalThis as any).__repairCalls)
  assert.deepEqual(calls.sort(), ['/static/2', '/static/3'])
  fs.unlinkSync(pages[1].file)
  await page.getByRole('button', { name: '检查完整性', exact: true }).click()
  await page.getByRole('button', { name: '修复异常页', exact: true }).waitFor()
  await app.evaluate(() => { (globalThis as any).__holdRepair = true })
  await page.getByRole('button', { name: '修复异常页', exact: true }).click()
  await page.getByText('已加入修复队列', { exact: true }).waitFor()
  await page.evaluate(async () => {
    const active = (await window.baoyi.image.jobs()).find(j => j.repairPages && ['running', 'queued'].includes(j.status))!
    await window.baoyi.image.pauseJob(active.id); await window.baoyi.image.dismissJob(active.id)
  })
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.image-integrity button')).some(button => button.textContent?.includes('检查完整性') && !(button as HTMLButtonElement).disabled))
  await page.getByRole('button', { name: '开始阅读', exact: true }).click()
  await page.getByLabel('当前图片规格').filter({ hasText: '320 × 480' }).waitFor()
  assert.match(await page.getByLabel('当前图片规格').innerText(), /PNG/)
  await page.screenshot({ path: path.join(output, 'reader-info-960.png') })
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ profile, calls, errors, checks: ['read-only-audit', 'repair-auth', 'selective-repair', 'automatic-result-refresh', 'reader-metadata', 'responsive-layout'] }, null, 2))
  console.log('PASS 完整性检查、修复登录保护、定向补页、结果刷新、原图规格和窗口布局')
} finally { await app.close() }
