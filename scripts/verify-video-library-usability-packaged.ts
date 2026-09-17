/** Native smoke test. All pages, media, profiles and database writes are synthetic. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { previewVideoOrganize, applyVideoOrganize } from '../electron/kinds/video/organize.ts'
import { pngImage } from './helpers/test-images.ts'

const require = createRequire(import.meta.url)
const runtime = process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { _electron } = require(runtime), { expect } = require(runtime + '/test')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-video-library-usability-20260913/win-unpacked/抱一.exe')
const evidence = path.resolve(process.argv[3] || 'output/video-library-usability-20260913/native')
assert.ok(fs.existsSync(executable), executable)
for (const marker of ['portable.txt', '绿色版.txt']) assert.ok(!fs.existsSync(path.join(path.dirname(executable), marker)))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-usability-native-'))
const downloads = path.join(profile, 'FixtureDownloads')
fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(downloads)
function file(relative: string, content: string | Buffer = 'synthetic media fixture'): string {
  const target = path.resolve(profile, relative), within = path.relative(profile, target)
  assert.ok(within !== '..' && !within.startsWith('..' + path.sep) && !path.isAbsolute(within))
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target
}
// A deterministic MP4 container header exercises transfer verification without using real content.
const media = Buffer.alloc(16384, 0)
media.writeUInt32BE(24, 0); media.write('ftypisom', 4, 'ascii'); media.write('isommp42', 16, 'ascii')
let agentRequests = 0, mediaRequests = 0
const server = http.createServer((request, response) => {
  if (request.url === '/fixture.mp4') {
    mediaRequests++; response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': media.length }); response.end(media)
  } else {
    agentRequests++; response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{"error":"Agent must not run during local imports"}')
  }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, hide_hentai: false, theme: 'light', proxy: '', video_scan_dirs: [downloads],
  ai: { enabled: true, api_key: 'synthetic-only', api_url: origin + '/v1', model: 'fixture' } })) {
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value))
}
const source = (code: string) => ({ provider: 'hanime', externalId: code, scope: 'episode' as const, pageUrl: 'https://hanime1.me/watch?v=' + code, evidence: 'confirmed' as const })
const loose = registerVideoContent(db, { title: '目录同步样例', category: '动画', items: [{ title: '目录同步样例 1', originalTitle: 'Folder Story #1',
  number: 1, order: 1, publishedAt: Date.UTC(2024, 0, 12), description: 'First synthetic episode', sources: [source('886001')],
  files: [{ path: file('Loose/Folder Story #1 [中文字幕]_720P.mp4') }] }] }).resourceId
const multi = [1, 2].map(number => registerVideoContent(db, { title: '多目录样例 ' + number, category: '动画',
  items: [{ title: '多目录样例 ' + number, originalTitle: 'Multi Folder #' + number, number, order: number, sources: [source('88700' + number)],
    files: [{ path: file('Multi' + number + '/Multi Folder #' + number + ' [720P].mp4') }] }] }).resourceId)
assert.equal((await applyVideoOrganize(db, { preview: previewVideoOrganize(db, { resourceIds: multi, survivorId: multi[0], collectionTitle: '多目录样例' }), mode: 'logical' })).status, 'applied')
const viewerFile = file('Viewer/Local Viewer #1 [中文字幕]_720P.mp4', media)
file('Viewer/info.json', JSON.stringify({ title: 'Local Viewer #1', chineseTitle: '本地资料样例 1', introduction: '本地资料已经包含完整简介。',
  uploadTime: '2026-06-04', artist: 'Fixture Studio', coverUrl: '', videoUrls: [], tags: ['Animation'] }))
const unknownFile = file('Unknown/Unknown film.mp4', media)
db.close()
const watchUrl = 'https://hanime1.me/watch?v=880088'
const homeHtml = '<!doctype html><html><head><title>Hanime synthetic fixture</title></head><body><h1>合成浏览测试</h1><a id="watch-fixture" href="' + watchUrl + '">打开测试视频</a></body></html>'
const watchHtml = `<!doctype html><html><head><meta charset="UTF-8"><title>合成浏览测试</title>
  <meta property="og:url" content="${watchUrl}"><meta property="og:image" content="https://hanime1.me/image/cover/fixture.png">
  <meta property="article:published_time" content="2026-07-09"></head><body>
  <h1 id="shareBtn-title">Browser fixture 1</h1><div class="video-details-wrapper"><div>浏览下载样例 1</div>
  <div class="video-caption-text">用于验证原生窗口下载与资料保存的中性合成页面。</div></div><span id="video-artist-name">Fixture Studio</span>
  <video id="player" width="640" height="360" muted controls preload="none" poster="https://hanime1.me/image/thumbnail/fixture.png">
  <source src="${origin}/fixture.mp4" size="720" type="video/mp4"></video>
  <button id="play-synthetic">播放合成画面</button><script>
  document.getElementById('play-synthetic').onclick = async () => {
    const canvas=document.createElement('canvas'); canvas.width=640;canvas.height=360;
    const context=canvas.getContext('2d'); let frame=0;
    const draw=()=>{context.fillStyle='#334455';context.fillRect(0,0,640,360);context.fillStyle='#aabbcc';context.fillRect((frame++*8)%600,160,40,40)};
    draw();window.fixtureTimer=setInterval(draw,100);const player=document.getElementById('player');
    player.srcObject=canvas.captureStream(10);player.muted=true;await player.play();
  };
  </script></body></html>`
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
let app: any, page: any, site: any, importedId = '', unknownId = '', downloadId = '', downloadedResourceId = ''
const checks: string[] = [], errors: string[] = []
const report: Record<string, unknown> = { executable, profile, fixtureDownloads: downloads, usesLiveSite: false }
async function launch() {
  app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env: environment, timeout: 30000 })
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  page = await app.firstWindow(); page.setDefaultTimeout(20000)
  page.on('pageerror', (cause: Error) => errors.push(cause.message))
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].hide())
  await page.waitForFunction(() => !!(window as any).baoyi)
  await page.locator('.app__view').waitFor()
}
async function route(hash: string) {
  await page.evaluate((hash: string) => { location.hash = hash }, hash)
  await page.waitForFunction(() => !document.querySelector('.page-enter-active,.page-leave-active') && !document.querySelector('.detail__state')?.textContent?.includes('载入中'))
}
const library = (id: string) => page.evaluate((id: string) => (window as any).baoyi.video.library(id), id)
async function check(name: string, run: () => Promise<void>) { await run(); checks.push(name); console.log('PASS ' + name) }
try {
  await launch()
  await check('check-files discovers a previously unknown episode and displays its publication range', async () => {
    const second = file('Loose/Folder Story #2 [中文字幕]_720P.mp4')
    file('Loose/info.json', JSON.stringify({ title: 'Folder Story #2', chineseTitle: '目录同步样例 2', introduction: 'Second synthetic episode',
      videoCode: '886002', uploadTime: '2026-07-09', artist: 'Fixture Studio', coverUrl: '', videoUrls: [] }))
    await route('/video/' + loose)
    await page.getByRole('button', { name: '检查文件', exact: true }).click()
    await expect(page.locator('.video-items__check-result')).toContainText('新增 1 个视频')
    const contents = (await library(loose)).contents
    assert.equal(contents.length, 2); assert.equal(contents.find((item: any) => item.episode === 2).path, second)
    await expect(page.locator('.hero__meta')).toContainText('最早 2024-01-12')
    await expect(page.locator('.hero__meta')).toContainText('最晚 2026-07-09')
    assert.ok(!fs.existsSync(path.join(profile, 'Loose/baoyi.json')))
    await page.screenshot({ path: path.join(evidence, 'discovered-episode.png') })
  })
  await check('logical collection checks its other known directory without reimport', async () => {
    const third = file('Multi2/Multi Folder #3 [720P].mp4')
    const result = await page.evaluate((id: string) => (window as any).baoyi.video.syncFiles(id), multi[0])
    assert.equal(result.filesAdded, 1); assert.equal(result.itemsAdded, 1)
    assert.equal(result.library.contents.find((item: any) => item.episode === 3).path, third)
  })
  await check('ordinary import uses local metadata with Agent configured and retains zero-token logs', async () => {
    assert.deepEqual(await page.evaluate(() => (window as any).baoyi.video.readiness()), { ok: true, message: '' })
    const scan = await page.evaluate((dirs: string[]) => (window as any).baoyi.video.scan(dirs), [path.dirname(viewerFile), path.dirname(unknownFile)])
    assert.equal(scan.registered, 2); assert.equal(scan.failed, 0); assert.equal(scan.tokens, 0); assert.equal(agentRequests, 0)
    report.scan = scan
    const videos = await page.evaluate(async () => [...await (window as any).baoyi.video.list(), ...await (window as any).baoyi.video.list({ type: 'hentai' })])
    const imported = videos.find((item: any) => item.name_zh === '本地资料样例 1')
    assert.ok(imported); importedId = imported.id
    unknownId = videos.find((item: any) => item.name_zh === 'Unknown film')?.id
    assert.ok(unknownId)
    assert.ok(videos.find((item: any) => item.id === unknownId).pending_reasons.includes('metadata'))
    assert.ok(!imported.pending_reasons.includes('metadata'))
    const episode = (await library(importedId)).contents[0]
    assert.equal(episode.published_at, Date.UTC(2026, 5, 4)); assert.equal(episode.studio, 'Fixture Studio')
    assert.equal(episode.description, '本地资料已经包含完整简介。')
    const logs = await page.evaluate(() => (window as any).baoyi.logs.list({ resource_kind: 'video' }))
    assert.equal(logs.length, 2); assert.ok(logs.every((log: any) => log.tokens === 0 && log.rounds === 0))
    assert.ok(JSON.stringify(logs).includes('2026-06-04'))
    await route('/video/' + importedId)
    await expect(page.locator('.hero__meta')).toContainText('2026-06-04')
  })
  await check('date and local-availability filters run through production IPC and UI', async () => {
    const items = await page.evaluate(() => (window as any).baoyi.video.list({ type: 'hentai', publishedFrom: '2026-06-04', publishedTo: '2026-06-04', local: 'available' }))
    assert.deepEqual(items.map((item: any) => item.id), [importedId])
    await route('/video')
    await page.locator('.sidebar button.row').filter({ has: page.locator('.row__label', { hasText: /^里番$/ }) }).click()
    await page.getByRole('button', { name: '筛选', exact: true }).click()
    await page.getByLabel('开始日期', { exact: true }).fill('2026-06-04')
    await page.getByLabel('结束日期', { exact: true }).fill('2026-06-04')
    await page.getByLabel('本地内容').selectOption('available')
    await page.getByRole('button', { name: '应用筛选', exact: true }).click()
    await expect(page.locator('.toolbar__count')).toHaveText('1 部作品')
    await page.screenshot({ path: path.join(evidence, 'filtered-library.png') })
    await page.getByRole('button', { name: /^筛选/ }).click()
    await page.getByRole('button', { name: '清空筛选', exact: true }).click()
  })
  await check('native Hanime window shares its persistent session and can play a neutral synthetic stream', async () => {
    await app.evaluate(async ({ session, Menu }: any, fixture: any) => {
      const scoped = session.fromPartition('persist:hanime-network')
      await scoped.protocol.handle('https', (request: Request) => {
        const url = new URL(request.url)
        if (url.hostname !== 'hanime1.me') return new Response('Synthetic test blocks external sites', { status: 451 })
        if (url.pathname.startsWith('/image/')) {
          const bytes = Buffer.from(url.pathname.includes('/cover/') ? fixture.poster : fixture.thumbnail, 'base64')
          return new Response(bytes, { headers: { 'Content-Type': 'image/png' } })
        }
        return new Response(url.pathname === '/watch' ? fixture.watch : fixture.home, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      })
      await scoped.cookies.set({ url: 'https://hanime1.me', name: 'baoyi_fixture_session', value: 'shared', secure: true, expirationDate: Math.floor(Date.now() / 1000) + 86400 })
      const original = Menu.buildFromTemplate.bind(Menu)
      Menu.buildFromTemplate = (template: any[]) => {
        const menu = original(template)
        if (template.some(item => item.label === '下载当前视频')) (globalThis as any).__fixtureHanimeMenu = menu
        return menu
      }
    }, { home: homeHtml, watch: watchHtml, poster: pngImage(240, 360).toString('base64'), thumbnail: pngImage(640, 360, [100, 140, 170]).toString('base64') })
    await page.locator('.sidebar button.row').filter({ has: page.locator('.row__label', { hasText: /^里番$/ }) }).click()
    const pendingWindow = app.waitForEvent('window')
    await page.getByRole('button', { name: '打开 Hanime', exact: true }).click()
    site = await pendingWindow; site.setDefaultTimeout(20000)
    await site.waitForURL('https://hanime1.me/')
    await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows().forEach((win: any) => win.hide()))
    assert.deepEqual(await site.evaluate(() => ({ api: typeof (window as any).baoyi, node: typeof (window as any).require })), { api: 'undefined', node: 'undefined' })
    assert.ok((await site.evaluate(() => document.cookie)).includes('baoyi_fixture_session=shared'))
    await site.locator('#watch-fixture').click(); await site.waitForURL(watchUrl)
    await site.locator('#play-synthetic').click()
    await site.waitForFunction(() => { const video = document.querySelector('video')!; return !video.paused && video.readyState >= 2 && video.currentTime > 0 })
    await page.evaluate(() => (window as any).baoyi.hanimeBrowser.open())
    assert.equal(await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows().filter((win: any) => win.webContents.getURL().startsWith('https://hanime1.me/')).length), 1)
    await site.screenshot({ path: path.join(evidence, 'native-browser-fixture.png') })
  })
  await check('native current-video menu hands off to the download preview and transfers into the configured library', async () => {
    await app.evaluate(({ BrowserWindow }: any) => {
      const item = (globalThis as any).__fixtureHanimeMenu?.items.find((item: any) => item.label === '下载当前视频')
      if (!item?.enabled) throw new Error('Current-video action is not enabled')
      item.click(item, BrowserWindow.getAllWindows().find((win: any) => win.webContents.getURL().startsWith('https://hanime1.me/')), {})
    })
    const panel = page.getByRole('dialog', { name: '从链接添加作品', exact: true })
    await expect(panel.getByLabel('来源页面链接', { exact: true })).toHaveValue(watchUrl)
    await expect(panel.getByLabel('作品名称', { exact: true })).toHaveValue('浏览下载样例 1')
    await expect(panel).toContainText(downloads)
    const enqueue = panel.getByRole('button', { name: '下载所选 1 项', exact: true })
    await expect(enqueue).toBeEnabled()
    await page.screenshot({ path: path.join(evidence, 'browser-download-preview.png') })
    await enqueue.click()
    await expect.poll(async () => {
      const jobs = await page.evaluate(() => (window as any).baoyi.video.downloadJobs())
      return jobs.find((job: any) => job.videoCode === '880088')?.status || 'none'
    }, { timeout: 45000, intervals: [100, 250, 500, 1000] }).toBe('success')
    const job = (await page.evaluate(() => (window as any).baoyi.video.downloadJobs())).find((job: any) => job.videoCode === '880088')
    downloadId = job.id; downloadedResourceId = job.resourceId
    assert.ok(downloadedResourceId); assert.equal(job.items[0].metadata, 'complete'); assert.equal(job.items[0].registration, 'complete')
    const relative = path.relative(downloads, job.items[0].path)
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    assert.deepEqual(fs.readFileSync(job.items[0].path), media); assert.ok(mediaRequests > 0); assert.equal(agentRequests, 0)
    const episode = (await library(downloadedResourceId)).contents[0]
    assert.equal(episode.published_at, Date.UTC(2026, 6, 9)); assert.equal(episode.studio, 'Fixture Studio')
    assert.ok(episode.poster_path.startsWith(profile)); assert.ok(episode.thumbnail_path.startsWith(profile))
    await panel.getByRole('button', { name: '关闭下载面板', exact: true }).click()
    await route('/video/' + downloadedResourceId)
    await page.getByRole('tab', { name: '剧情简介', exact: true }).click()
    await expect(page.getByRole('button', { name: '放大竖向海报', exact: true })).toBeVisible()
    const heights = await page.locator('.episode-artwork img').evaluateAll((images: Element[]) => images.map(image => image.getBoundingClientRect().height))
    assert.equal(heights.length, 2); assert.ok(Math.abs(heights[0] - heights[1]) < 1)
    await page.getByRole('button', { name: '放大竖向海报', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '查看图片', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '查看图片', exact: true })).not.toBeVisible()
    await page.screenshot({ path: path.join(evidence, 'downloaded-synopsis.png') })
    report.download = { jobId: downloadId, resourceId: downloadedResourceId, path: job.items[0].path, bytes: media.length }
  })
  await check('hiding the adult scope closes the browser and blocks reopening', async () => {
    await page.evaluate(() => (window as any).baoyi.settings.patch({ hide_hentai: true }))
    await expect.poll(() => site.isClosed()).toBe(true)
    assert.match(await page.evaluate(async () => {
      try { await (window as any).baoyi.hanimeBrowser.open(); return 'unexpected success' }
      catch (cause) { return String(cause) }
    }), /已隐藏/)
    await page.evaluate(() => (window as any).baoyi.settings.patch({ hide_hentai: false }))
    await app.evaluate(({ session }: any) => session.fromPartition('persist:hanime-network').cookies.flushStore())
  })
  await app.close(); app = undefined
  await launch()
  await check('restart retains discovered files, local logs, downloaded content and browser session', async () => {
    assert.equal((await library(loose)).contents.length, 2)
    assert.equal((await library(multi[0])).contents.length, 3)
    assert.equal((await library(downloadedResourceId)).contents[0].published_at, Date.UTC(2026, 6, 9))
    assert.equal((await page.evaluate(() => (window as any).baoyi.logs.list({ resource_kind: 'video' }))).length, 2)
    assert.equal((await page.evaluate(() => (window as any).baoyi.video.downloadJobs())).find((job: any) => job.id === downloadId)?.status, 'success')
    const cookies = await app.evaluate(({ session }: any) => session.fromPartition('persist:hanime-network').cookies.get({ name: 'baoyi_fixture_session' }))
    assert.equal(cookies[0]?.value, 'shared'); assert.equal(agentRequests, 0); assert.deepEqual(errors, [])
  })
  report.status = 'passed'
} catch (cause) {
  report.status = 'failed'; report.error = cause instanceof Error ? cause.stack : String(cause)
  console.error('FAIL native usability:', report.error); process.exitCode = 1
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {})
  if (page) report.jobs = await page.evaluate(() => (window as any).baoyi.video.downloadJobs()).catch(() => [])
} finally {
  if (app) await app.close()
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ ...report, checks, errors, agentRequests, mediaRequests }, null, 2))
}
console.log(`Native usability: ${checks.length} passed / ${process.exitCode ? 1 : 0} failed`)
