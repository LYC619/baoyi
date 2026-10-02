/** Real desktop, IPC, browser, transfer and registration; only localhost media. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createDiscoveryCatalogue } from '../electron/kinds/video/discovery/catalogue.ts'
import { pngImage } from './helpers/test-images.ts'
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output = path.resolve('output/discovery-ui'); fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-')), mediaRoot = path.join(profile, 'videos'); fs.mkdirSync(mediaRoot)
let video = Buffer.alloc(0)
const hits: string[] = [], posters = new Map<string, Buffer>()
const server = http.createServer((request, response) => {
  hits.push(request.url || '/')
  if (request.url?.startsWith('/poster/')) { response.setHeader('Content-Type', 'image/png'); response.end(posters.get(request.url) || pngImage(400, 600)); return }
  if (request.url?.startsWith('/video.webm')) {
    response.setHeader('Content-Type', 'video/webm'); response.setHeader('Accept-Ranges', 'bytes')
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '')
    if (range) {
      const start = Number(range[1]), end = Math.min(Number(range[2]) || video.length - 1, video.length - 1)
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${video.length}`, 'Content-Length': end - start + 1 }); response.end(video.subarray(start, end + 1)); return
    }
    response.setHeader('Content-Length', video.length); response.end(video); return
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end('<!doctype html><html><body style="background:#161922;color:#eee;font-family:sans-serif"><h1>本机公开影像测试</h1><video width="640" controls autoplay muted src="/video.webm"></video></body></html>')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const sample = { schemaVersion: 1, id: 'open-films', name: '开放影像', homeUrl: base, entries: Array.from({ length: 12 }, (_, i) => ({
  id: 'film-' + i, code: 'DEMO-' + String(i + 1).padStart(3, '0'), title: ['森林纪行', '光的形状', '城市之间', '海岸线', '山野来信', '一日之光'][i % 6] + (i >= 6 ? ' · 下篇' : ''),
  description: '这是一段完全在本机生成的非成人测试影像，用于验证浏览、播放、下载和本地入库。', coverUrl: base + '/poster/' + i, pageUrl: base + '/watch/' + i,
  playUrl: base + '/watch/' + i, year: 2026 - i % 4, tags: i % 2 ? ['短片', '城市'] : ['纪录片', '自然'],
  rating: { value: 8.8 - i * .1, scale: 10, votes: 100 + i }, rankings: i < 3 ? [{ name: '本周精选', source: '开放影像编辑', period: '2026 第 40 周', position: i + 1 }] : [],
  downloads: i === 11 ? [] : [{ label: '720p', url: base + '/video.webm' }]
})) }
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', hide_hentai: true, video_scan_dirs: [mediaRoot], proxy_mode: 'direct', hanime_hosts_enabled: false })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value))
const catalogue = createDiscoveryCatalogue(db); catalogue.importSource(sample); catalogue.importSource({ ...sample, id: 'learning', name: '课程片库', entries: [sample.entries[1]] }); db.close()
const sourceFile = path.join(profile, 'import-source.json'); fs.writeFileSync(sourceFile, JSON.stringify({ ...sample, id: 'imported', name: '导入来源' }))
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('node_modules/electron/dist/electron.exe')
const args = process.argv[2] ? [`--user-data-dir=${profile}`] : [path.resolve('.'), `--user-data-dir=${profile}`]
let application: any
const evidence: string[] = [], errors: string[] = []
async function waitForApi(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for ' + label)
}
try {
  application = await _electron.launch({ executablePath, args, env, timeout: 45000 })
  assert.equal(path.resolve(await application.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  const page = await application.firstWindow(); page.on('pageerror', (error: Error) => errors.push(error.message))
  await page.waitForFunction(() => !!(window as any).baoyi)
  const generated = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const context = canvas.getContext('2d')!, recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm;codecs=vp8' })
    const chunks: Blob[] = []
    const recorded = new Promise<number[]>(resolve => { recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = async () => resolve([...new Uint8Array(await new Blob(chunks).arrayBuffer())]) })
    recorder.start()
    for (let i = 0; i < 20; i++) { context.fillStyle = `hsl(${160 + i * 3},35%,25%)`; context.fillRect(0, 0, 320, 180); context.fillStyle = '#fff'; context.font = '20px sans-serif'; context.fillText('Local media test ' + i, 55, 95); await new Promise(resolve => setTimeout(resolve, 50)) }
    recorder.stop(); const bytes = await recorded
    const images = Array.from({ length: 12 }, (_, i) => {
      canvas.width = 400; canvas.height = 600
      const ctx = canvas.getContext('2d')!, hue = [158, 210, 35, 192, 98, 20][i % 6]
      const gradient = ctx.createLinearGradient(0, 0, 400, 600); gradient.addColorStop(0, `hsl(${hue},28%,18%)`); gradient.addColorStop(1, `hsl(${hue},35%,55%)`)
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 400, 600); ctx.fillStyle = '#ffffff20'; ctx.beginPath(); ctx.arc(300, 210, 190, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#ffffff'; ctx.font = '20px sans-serif'; ctx.fillText('OPEN FILMS / ' + String(i + 1).padStart(2, '0'), 32, 52)
      ctx.font = '43px serif'; ctx.fillText(['森林纪行', '光的形状', '城市之间', '海岸线', '山野来信', '一日之光'][i % 6], 32, 480)
      ctx.font = '15px sans-serif'; ctx.fillText('A LOCAL SCREENING COLLECTION', 32, 520)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    return { bytes, images }
  })
  video = Buffer.from(generated.bytes); generated.images.forEach((image: string, i: number) => posters.set('/poster/' + i, Buffer.from(image, 'base64')))
  await page.evaluate(() => { location.hash = '/video' })
  await page.getByRole('button', { name: '找视频', exact: true }).click()
  await page.getByRole('button', { name: /开放影像/ }).click()
  await page.waitForFunction(() => document.querySelectorAll('.discovery-card').length === 12)
  await page.waitForFunction(() => [...document.querySelectorAll('.discovery-poster img')].filter(image => (image as HTMLImageElement).naturalWidth > 0).length >= 4)
  evidence.push('source-selection-cached-covers')
  await page.getByLabel('搜索作品').fill('demo001'); assert.equal(await page.locator('.discovery-card').count(), 1)
  await page.getByLabel('搜索作品').fill(''); await page.getByLabel('按榜单筛选').selectOption({ label: '本周精选 · 2026 第 40 周' }); assert.equal(await page.locator('.discovery-card').count(), 3)
  await page.getByLabel('按榜单筛选').selectOption(''); evidence.push('normalized-search-ranking-filter')
  await page.screenshot({ path: path.join(output, 'poster-wall-dark.png') })
  await page.getByRole('button', { name: '查看 森林纪行', exact: true }).click()
  const detail = page.getByRole('dialog', { name: '森林纪行', exact: true })
  await detail.getByRole('button', { name: '收藏', exact: true }).click()
  await detail.getByRole('button', { name: '已收藏', exact: true }).waitFor()
  await detail.getByLabel('我的评分').selectOption('4')
  await detail.getByLabel('我的备注').fill('保留这部作品'); await detail.getByLabel('我的备注').press('Tab')
  await waitForApi(() => page.evaluate(async () => (await (window as any).baoyi.video.discovery.entries('open-films'))[0].mark.notes === '保留这部作品'), 'saved notes')
  await detail.getByLabel('我的备注').fill(''); await detail.getByLabel('我的备注').press('Tab')
  await waitForApi(() => page.evaluate(async () => (await (window as any).baoyi.video.discovery.entries('open-films'))[0].mark.notes === ''), 'cleared notes')
  evidence.push('favorite-personal-rating-clear-notes')
  await page.screenshot({ path: path.join(output, 'detail-dark.png') })
  const opened = application.waitForEvent('window')
  await detail.getByRole('button', { name: '观看', exact: true }).click()
  const viewer = await opened
  try { await viewer.waitForFunction(() => { const element = document.querySelector('video'); return !!element && element.readyState >= 2 }) }
  catch (error) {
    console.error('viewer diagnostic', await viewer.evaluate(() => { const v = document.querySelector('video'); return { url: location.href, body: document.body.innerText, video: v && { ready: v.readyState, network: v.networkState, error: v.error?.message, src: v.currentSrc } } }), { hits, bytes: video.length })
    throw error
  }
  await viewer.locator('video').evaluate((element: HTMLVideoElement) => element.play())
  await viewer.waitForFunction(() => (document.querySelector('video')?.currentTime || 0) > .1)
  assert.equal(await viewer.evaluate(() => typeof (window as any).baoyi), 'undefined')
  await viewer.screenshot({ path: path.join(output, 'local-playback.png') }); await viewer.close()
  assert.equal((await page.evaluate(() => (window as any).baoyi.video.counts())).all, 0)
  evidence.push('real-webm-playback-isolated-browser-no-inventory-write')
  await detail.getByRole('button', { name: '下载保存', exact: true }).click()
  const save = page.getByRole('dialog', { name: '保存到本地' })
  await save.getByRole('button', { name: /下载所选 1 项/ }).click()
  await waitForApi(() => page.evaluate(async () => (await (window as any).baoyi.video.downloadJobs()).some((job: any) => job.discovery && job.status === 'success')), 'completed download')
  const job = (await page.evaluate(() => (window as any).baoyi.video.downloadJobs())).find((job: any) => job.discovery)
  assert.equal(fs.readFileSync(job.items[0].path).length, video.length)
  assert.equal((await page.evaluate((id: string) => (window as any).baoyi.video.get(id), job.resourceId)).video_type, 'movie')
  assert.equal((await page.evaluate(() => (window as any).baoyi.video.counts())).all, 1)
  await save.getByRole('button', { name: '关闭下载面板' }).click()
  await page.getByRole('button', { name: '本地已有', exact: true }).click(); assert.equal(await page.locator('.discovery-card').count(), 1)
  evidence.push('real-transfer-registration-library-filter')
  await application.evaluate(({ dialog }: any, file: string) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, sourceFile)
  await page.getByRole('button', { name: '导入来源目录', exact: true }).first().click()
  await page.getByRole('heading', { name: '导入来源', exact: true }).waitFor(); assert.equal(await page.locator('.discovery-card').count(), 12)
  evidence.push('native-import-dialog-ipc')
  const exported = path.join(profile, 'exported-source.json')
  await application.evaluate(({ dialog }: any, file: string) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, exported)
  await page.getByRole('button', { name: '导出来源目录', exact: true }).click()
  await page.waitForTimeout(100)
  assert.equal(JSON.parse(fs.readFileSync(exported, 'utf8')).entries.length, 12)
  await page.getByRole('button', { name: '移除来源', exact: true }).click()
  await page.getByRole('button', { name: '确认移除来源', exact: true }).click()
  await waitForApi(() => page.evaluate(async () => (await (window as any).baoyi.video.discovery.sources()).length === 2), 'source removal')
  assert.equal((await page.evaluate(() => (window as any).baoyi.video.counts())).all, 1)
  evidence.push('catalogue-export-remove-preserves-local-video')
  await page.getByRole('button', { name: /课程片库/ }).click(); await page.waitForFunction(() => document.querySelectorAll('.discovery-card').length === 1)
  await page.getByRole('button', { name: /开放影像/ }).click(); await page.waitForFunction(() => document.querySelectorAll('.discovery-card').length === 12)
  await page.getByRole('button', { name: '收藏', exact: true }).click(); assert.equal(await page.locator('.discovery-card').count(), 1)
  evidence.push('source-isolation-persistent-marks')
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await page.evaluate(async () => { await (window as any).baoyi.settings.patch({ theme: 'light' }); document.documentElement.dataset.theme = 'light' })
  await page.setViewportSize({ width: 820, height: 740 }); await page.screenshot({ path: path.join(output, 'poster-wall-light-narrow.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  evidence.push('light-theme-narrow-layout')
  await page.reload(); await page.getByLabel('网页地址', { exact: true }).waitFor()
  assert.equal((await page.evaluate(() => (window as any).baoyi.video.discovery.entries('open-films')))[0].mark.userRating, 4)
  await application.close()
  application = await _electron.launch({ executablePath, args, env, timeout: 45000 })
  const reopened = await application.firstWindow(); reopened.on('pageerror', (error: Error) => errors.push(error.message))
  await reopened.waitForFunction(() => !!(window as any).baoyi)
  assert.equal((await reopened.evaluate(() => (window as any).baoyi.video.discovery.entries('open-films')))[0].mark.userRating, 4)
  assert.equal((await reopened.evaluate(() => (window as any).baoyi.video.counts())).all, 1)
  assert.equal((await reopened.evaluate(() => (window as any).baoyi.video.downloadJobs()))[0].status, 'success')
  evidence.push('full-app-restart-keeps-marks-library-and-job')
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ evidence, errors, hits, profile }, null, 2))
  console.log('Discovery desktop verification: ' + evidence.length + ' checks passed; ' + output)
} catch (error) {
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ evidence, errors, hits, profile, error: String(error) }, null, 2))
  if (application) { const page = await application.firstWindow(); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}) }
  throw error
} finally { if (application) await application.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
