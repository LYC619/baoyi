/** End-to-end online discovery in one main window, using only local synthetic media. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output = path.resolve('output/online-source-ui'); fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-')), mediaRoot = path.join(profile, 'videos'); fs.mkdirSync(mediaRoot)
const fixtureRoot = path.join(output, 'demo'); fs.mkdirSync(fixtureRoot, { recursive: true })
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, hide_hentai: true, theme: 'dark', video_scan_dirs: [mediaRoot], proxy_mode: 'direct', hanime_hosts_enabled: false })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value))
db.close()
const titles = ['森林纪行', '光的形状', '城市之间', '海岸线', '山野来信', '一日之光', '远方的风', '只有观看页面']
const film = (i: number, detail = false) => ({ '@type': 'VideoObject', name: titles[i], url: `/film-${i}.html`, thumbnailUrl: `/poster-${i % 6}.png`,
  description: '本机生成的公开影像示例，用于验证网页接入、内置播放和下载入库。', uploadDate: '2026-10-01', keywords: i % 2 ? ['短片', '城市'] : ['纪录片', '自然'],
  aggregateRating: { ratingValue: 4.5, bestRating: 5, ratingCount: 20 }, ...(detail && i !== 7 ? { contentUrl: '/video.webm' } : {}), ...(i === 7 ? { embedUrl: '/external.html' } : {}) })
const pageHtml = (data: unknown, next = '') => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>本机开放影像</title><script type="application/ld+json">${JSON.stringify(data)}</script></head><body><h1>本机开放影像</h1><p>将本页 HTTP 地址填入抱一的“接入海报墙”。</p>${next ? `<a rel="next" href="${next}">下一页</a>` : ''}</body></html>`
fs.writeFileSync(path.join(fixtureRoot, 'index.html'), pageHtml({ '@type': 'ItemList', itemListElement: titles.slice(0, 6).map((_, i) => ({ '@type': 'ListItem', item: film(i) })) }, '/page2.html'))
fs.writeFileSync(path.join(fixtureRoot, 'page2.html'), pageHtml([film(0), film(6), film(7)], '/index.html'))
titles.forEach((_, i) => fs.writeFileSync(path.join(fixtureRoot, `film-${i}.html`), pageHtml({ '@graph': [film((i + 1) % 6, true), film(i, true)] })))
fs.writeFileSync(path.join(fixtureRoot, 'unsupported.html'), '<!doctype html><html><h1>普通网页，没有 VideoObject 资料</h1></html>')
const hits: string[] = []; let refreshed = false, failRefresh = false
const server = http.createServer((req, res) => {
  hits.push(req.url || '/')
  const name = req.url === '/' ? 'index.html' : (req.url || '').slice(1)
  if (name === 'index.html' && failRefresh) { res.writeHead(503); res.end(); return }
  res.setHeader('Content-Type', name.endsWith('.webm') ? 'video/webm' : name.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8')
  if (name === 'index.html' && refreshed) { res.end(pageHtml(film(6), '/page2.html')); return }
  if (!/^[a-z0-9.-]+$/.test(name) || !fs.existsSync(path.join(fixtureRoot, name))) { res.writeHead(404); res.end(); return }
  const bytes = fs.readFileSync(path.join(fixtureRoot, name)), range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
  if (range) {
    const start = Number(range[1]), end = Math.min(Number(range[2]) || bytes.length - 1, bytes.length - 1)
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 }); res.end(bytes.subarray(start, end + 1)); return
  }
  res.setHeader('Content-Length', bytes.length); res.end(bytes)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('node_modules/electron/dist/electron.exe')
const args = process.argv[2] ? [`--user-data-dir=${profile}`] : [path.resolve('.'), `--user-data-dir=${profile}`]
let application: any
const evidence: string[] = [], errors: string[] = []
async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error('Timeout: ' + label)
}
async function enter(page: any) { await page.getByRole('button', { name: /^影视\s/ }).click(); await page.getByRole('button', { name: '找视频', exact: true }).click() }
async function screenshot(name: string) {
  const capture = await application.evaluate(async ({ BrowserWindow }: any) => {
    const win = BrowserWindow.getAllWindows()[0]
    const state = { visible: win.isVisible(), minimized: win.isMinimized(), bounds: win.getBounds() }
    const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    return { state, data: image.toPNG().toString('base64') }
  })
  assert.ok(capture.data.length > 1000, 'Empty window capture: ' + JSON.stringify(capture.state))
  fs.writeFileSync(path.join(output, name), Buffer.from(capture.data, 'base64'))
}
try {
  application = await _electron.launch({ executablePath, args, env, timeout: 45000 })
  const page = await application.firstWindow(); page.on('pageerror', (error: Error) => errors.push(error.message))
  assert.equal(path.resolve(await application.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  await page.waitForFunction(() => !!(window as any).baoyi)
  assert.equal(await page.evaluate(() => typeof (window as any).baoyi.video.discovery.online?.connect), 'function', 'Missing online source IPC')
  const generated = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
    const ctx = canvas.getContext('2d')!, stream = canvas.captureStream(15), recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }), chunks: Blob[] = []
    const recorded = new Promise<number[]>(resolve => { recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = async () => resolve([...new Uint8Array(await new Blob(chunks).arrayBuffer())]) })
    recorder.start()
    for (let i = 0; i < 60; i++) { ctx.fillStyle = `hsl(${160 + i},35%,25%)`; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif'; ctx.fillText('LOCAL FILMS / ' + i, 160, 185); await new Promise(resolve => setTimeout(resolve, 50)) }
    recorder.stop(); const bytes = await recorded; stream.getTracks().forEach(track => track.stop())
    const posters = Array.from({ length: 6 }, (_, i) => {
      canvas.width = 400; canvas.height = 600; const hue = [158, 210, 35, 192, 98, 20][i]
      const gradient = ctx.createLinearGradient(0, 0, 400, 600); gradient.addColorStop(0, `hsl(${hue},28%,18%)`); gradient.addColorStop(1, `hsl(${hue},35%,55%)`)
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 400, 600); ctx.fillStyle = '#ffffff20'; ctx.beginPath(); ctx.arc(300, 210, 190, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.fillText('OPEN FILMS / ' + String(i + 1).padStart(2, '0'), 32, 52)
      ctx.font = '43px serif'; ctx.fillText(['森林纪行', '光的形状', '城市之间', '海岸线', '山野来信', '一日之光'][i], 32, 480)
      ctx.font = '15px sans-serif'; ctx.fillText('A LOCAL SCREENING COLLECTION', 32, 520)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    return { bytes, posters }
  })
  const video = Buffer.from(generated.bytes); fs.writeFileSync(path.join(fixtureRoot, 'video.webm'), video)
  generated.posters.forEach((data: string, i: number) => fs.writeFileSync(path.join(fixtureRoot, `poster-${i}.png`), Buffer.from(data, 'base64')))
  await enter(page)
  assert.equal((await page.evaluate(() => (window as any).baoyi.video.discovery.sources())).length, 0)
  await page.getByLabel('网页地址', { exact: true }).fill(base + '/index.html')
  await page.getByRole('button', { name: '接入海报墙', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.discovery-card').length === 6)
  await page.waitForFunction(() => [...document.querySelectorAll('.discovery-poster img')].filter(img => (img as HTMLImageElement).naturalWidth > 0).length === 6)
  const source = (await page.evaluate(() => (window as any).baoyi.video.discovery.sources()))[0]
  assert.ok(source.online); assert.equal(application.windows().length, 1)
  assert.ok(!hits.some(hit => hit.startsWith('/film-')), 'No background detail crawl')
  evidence.push('zero-catalogue-url-to-wall-cached-posters-no-background-crawl')
  await screenshot('wall-dark.png')
  await page.getByRole('button', { name: '查看 森林纪行', exact: true }).click()
  const detail = page.getByRole('dialog', { name: '森林纪行', exact: true })
  await waitFor(() => detail.getByRole('button', { name: '下载保存', exact: true }).isEnabled(), 'detail media enrichment')
  await detail.getByRole('button', { name: '收藏', exact: true }).click(); await detail.getByRole('button', { name: '已收藏', exact: true }).waitFor()
  await detail.getByLabel('我的评分').selectOption('4')
  await detail.getByLabel('我的备注').fill('在线收藏，稍后下载'); await detail.getByLabel('我的备注').press('Tab')
  await waitFor(() => page.evaluate(async (id: string) => (await (window as any).baoyi.video.discovery.entries(id))[0].mark.notes === '在线收藏，稍后下载', source.id), 'personal notes')
  await screenshot('detail-dark.png')
  await detail.getByRole('button', { name: '观看', exact: true }).click()
  await page.locator('.discovery-player video').waitFor()
  await page.locator('.discovery-player video').evaluate((v: HTMLVideoElement) => v.play())
  await page.waitForFunction(() => (document.querySelector('.discovery-player video') as HTMLVideoElement)?.currentTime > .1)
  assert.equal(application.windows().length, 1); assert.equal(await page.locator('.discovery-detail').count(), 0)
  assert.equal((await page.evaluate(() => (window as any).baoyi.video.counts())).all, 0)
  await screenshot('player-dark.png')
  evidence.push('on-demand-detail-matched-video-favorite-rating-notes-real-inline-playback')
  await page.evaluate(() => { (window as any).__playedVideo = document.querySelector('.discovery-player video') })
  await page.locator('.discovery-player').getByRole('button', { name: '下载保存', exact: true }).click()
  const save = page.getByRole('dialog', { name: '保存到本地' })
  await save.waitFor(); assert.equal(await page.locator('.discovery-player').count(), 0)
  assert.equal(await page.evaluate(() => (window as any).__playedVideo.paused), true)
  await save.getByRole('button', { name: /下载所选 1 项/ }).click()
  await waitFor(() => page.evaluate(async () => (await (window as any).baoyi.video.downloadJobs()).some((job: any) => job.discovery && job.status === 'success')), 'download and registration')
  const job = (await page.evaluate(() => (window as any).baoyi.video.downloadJobs())).find((job: any) => job.discovery)
  assert.deepEqual(fs.readFileSync(job.items[0].path), video)
  assert.equal((await page.evaluate(() => (window as any).baoyi.video.counts())).all, 1)
  await save.getByRole('button', { name: '关闭下载面板' }).click()
  await page.getByRole('button', { name: '本地已有', exact: true }).click(); assert.equal(await page.locator('.discovery-card').count(), 1)
  await page.getByRole('button', { name: '全部', exact: true }).click()
  evidence.push('player-stops-before-download-exact-bytes-registration-local-filter')
  await page.getByRole('button', { name: '读取下一页', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.discovery-card').length === 8)
  assert.equal(await page.getByRole('button', { name: '读取下一页', exact: true }).count(), 0)
  await page.getByRole('button', { name: '查看 只有观看页面', exact: true }).click()
  const unavailable = page.getByRole('dialog', { name: '只有观看页面', exact: true })
  await unavailable.getByRole('button', { name: '观看', exact: true }).click()
  await page.getByText('此作品未提供可内置播放的媒体文件。', { exact: true }).waitFor()
  assert.equal(await page.locator('.discovery-player').getByRole('button', { name: '下载保存', exact: true }).isEnabled(), false)
  assert.equal(application.windows().length, 1); await page.getByRole('button', { name: '关闭播放器', exact: true }).click()
  refreshed = true; await page.getByRole('button', { name: '刷新来源', exact: true }).click()
  await waitFor(() => page.getByRole('button', { name: '刷新来源', exact: true }).isEnabled(), 'refresh')
  assert.equal(await page.locator('.discovery-card').count(), 8)
  await page.getByRole('button', { name: '收藏', exact: true }).click(); assert.equal(await page.locator('.discovery-card').count(), 1)
  failRefresh = true; await page.getByRole('button', { name: '刷新来源', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '503' }).waitFor()
  assert.equal(await page.locator('.discovery-card').count(), 1); failRefresh = false
  evidence.push('pagination-dedup-loop-stop-unavailable-player-refresh-preserves-cached-favorites-on-error')
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await page.evaluate(async () => { await (window as any).baoyi.settings.patch({ theme: 'light' }); document.documentElement.dataset.theme = 'light' })
  await page.setViewportSize({ width: 820, height: 740 }); await screenshot('wall-light-narrow.png')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.getByRole('button', { name: /在线浏览/ }).click()
  await page.getByLabel('网页地址', { exact: true }).fill(base + '/unsupported.html')
  await page.getByRole('button', { name: '接入海报墙', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'VideoObject' }).waitFor()
  assert.equal(await page.getByLabel('网页地址', { exact: true }).inputValue(), base + '/unsupported.html')
  assert.equal((await page.evaluate(() => (window as any).baoyi.video.discovery.sources())).length, 1)
  assert.equal(application.windows().length, 1)
  await screenshot('unsupported-light.png')
  evidence.push('light-narrow-layout-unsupported-keeps-address-no-browser-popup')
  await application.close(); application = await _electron.launch({ executablePath, args, env, timeout: 45000 })
  const reopened = await application.firstWindow(); reopened.on('pageerror', (error: Error) => errors.push(error.message)); await enter(reopened)
  await reopened.getByRole('button', { name: /本机开放影像/ }).click(); await reopened.waitForFunction(() => document.querySelectorAll('.discovery-card').length === 8)
  const cached = await reopened.evaluate((id: string) => (window as any).baoyi.video.discovery.entries(id), source.id)
  assert.equal(cached[0].mark.favorite, true); assert.equal(cached[0].mark.userRating, 4); assert.ok(cached[0].entry.mediaUrl)
  assert.equal((await reopened.evaluate(() => (window as any).baoyi.video.counts())).all, 1)
  assert.equal((await reopened.evaluate(() => (window as any).baoyi.video.downloadJobs()))[0].status, 'success')
  evidence.push('full-restart-keeps-online-config-media-marks-library-job')
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ evidence, errors, hits, profile, executablePath, fixtureRoot }, null, 2))
  console.log(`Online source desktop verification: ${evidence.length} groups passed; ${output}`)
} catch (error) {
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ evidence, errors, hits, profile, error: String(error) }, null, 2))
  if (application) await screenshot('failure.png').catch(() => {})
  throw error
} finally { if (application) await application.close().catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
