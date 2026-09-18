/**
 * 实测第二轮 · 真库快照上的观察（只看不改）：拷一份真库到临时 profile 起打包产物，
 * 看启动迁移日志、影视墙里番格的图片数和破图数，截图留证。不碰 %APPDATA% 里的真库，不写 E:\视频。
 *
 *   node --experimental-strip-types scripts/verify-video-field-round2-real-db.ts [exe] [证据目录]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const runtime = process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { _electron } = require(runtime)
const executable = path.resolve(process.argv[2] || 'release/0.8.0-field-test-round2-20260918/win-unpacked/抱一.exe')
assert.ok(fs.existsSync(executable), executable)
const evidence = path.resolve(process.argv[3] || 'output/field-test-round2-20260918/real-db')
fs.mkdirSync(evidence, { recursive: true })
const realDb = path.join(process.env.APPDATA!, '抱一', 'baoyi.db')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-round2-real-'))
fs.copyFileSync(realDb, path.join(profile, 'baoyi.db'))
const before = (() => {
  const d = new DatabaseSync(path.join(profile, 'baoyi.db'), { readOnly: true })
  const count = (sql: string) => (d.prepare(sql).get() as { c: number }).c
  const result = {
    cacheRefs: count("SELECT count(*) c FROM (SELECT poster_path p FROM video_meta WHERE poster_path LIKE '%posters%' UNION ALL SELECT thumbnail_path FROM video_meta WHERE thumbnail_path LIKE '%posters%' UNION ALL SELECT poster_path FROM episode WHERE poster_path LIKE '%posters%')"),
    artworkRefs: count("SELECT count(*) c FROM (SELECT poster_path p FROM video_meta WHERE poster_path LIKE '%.baoyi%artwork%' UNION ALL SELECT thumbnail_path FROM video_meta WHERE thumbnail_path LIKE '%.baoyi%artwork%' UNION ALL SELECT poster_path FROM episode WHERE poster_path LIKE '%.baoyi%artwork%')"),
    videos: count('SELECT count(*) c FROM video_meta')
  }
  d.close(); return result
})()
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
const errors: string[] = [], mainLog: string[] = []
const app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env: environment, timeout: 30000 })
app.process().stdout?.on('data', (chunk: Buffer) => mainLog.push(chunk.toString('utf8')))
app.process().stderr?.on('data', (chunk: Buffer) => mainLog.push(chunk.toString('utf8')))
try {
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  const page = await app.firstWindow(); page.setDefaultTimeout(20000)
  page.on('pageerror', (error: Error) => errors.push(error.message))
  page.on('console', (message: any) => { if (message.type() === 'error') errors.push(message.text()) })
  // 404 的图到底是哪些：记下协议请求里的路径，并归类到缓存目录 / 作品目录 / 其他
  const notFound: string[] = []
  page.on('response', (response: any) => { if (response.status() === 404) { try { notFound.push(decodeURIComponent(new URL(response.url()).searchParams.get('p') || response.url())) } catch { notFound.push(response.url()) } } })
  await page.waitForFunction(() => !!(window as any).baoyi)
  await page.locator('.app__view').waitFor()
  await page.evaluate(() => { location.hash = '/video' })
  await page.locator('.wall').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.wall .card').length > 0)
  const firstView = await page.evaluate(() => document.querySelectorAll('.wall .card').length)
  await page.locator('button.row').filter({ hasText: '里番' }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.wall .card').length > 10)
  // 等图片都判定完（成功或失败），再数
  await page.waitForFunction(() => [...document.querySelectorAll('.wall img')].every(img => (img as HTMLImageElement).complete))
  await page.waitForTimeout(1500)
  const wall = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.wall img')] as HTMLImageElement[]
    return { cards: document.querySelectorAll('.wall .card').length, imgs: imgs.length, broken: imgs.filter(img => !img.naturalWidth).map(img => img.getAttribute('src')),
      placeholders: document.querySelectorAll('.wall .card__initial, .wall .card__placeholder').length }
  })
  await page.screenshot({ path: path.join(evidence, '01-video-wall-hentai.png'), fullPage: false })
  // 主进程里的迁移日志
  const migration = mainLog.join('').split(/\r?\n/).filter(line => /\[抱一\]/.test(line))
  const after = (() => {
    const d = new DatabaseSync(path.join(profile, 'baoyi.db'), { readOnly: true })
    const count = (sql: string) => (d.prepare(sql).get() as { c: number }).c
    const result = {
      cacheRefs: count("SELECT count(*) c FROM (SELECT poster_path p FROM video_meta WHERE poster_path LIKE '%posters%' UNION ALL SELECT thumbnail_path FROM video_meta WHERE thumbnail_path LIKE '%posters%' UNION ALL SELECT poster_path FROM episode WHERE poster_path LIKE '%posters%')"),
      artworkRefs: count("SELECT count(*) c FROM (SELECT poster_path p FROM video_meta WHERE poster_path LIKE '%.baoyi%artwork%' UNION ALL SELECT thumbnail_path FROM video_meta WHERE thumbnail_path LIKE '%.baoyi%artwork%' UNION ALL SELECT poster_path FROM episode WHERE poster_path LIKE '%.baoyi%artwork%')")
    }
    d.close(); return result
  })()
  const allView = { cardsBeforeHentaiClick: firstView }
  const notFoundSummary = { total: notFound.length, exists: notFound.filter(f => fs.existsSync(f)).length,
    inProjectCache: notFound.filter(f => /[\\/]data[\\/]posters[\\/]/i.test(f)).length, inArtwork: notFound.filter(f => /\.baoyi[\\/]artwork/i.test(f)).length,
    sample: notFound.slice(0, 6) }
  const report = { executable, profile, before, after, wall, allView, notFound: notFoundSummary, migration, errors: errors.filter(e => !/404/.test(e)), profilePosters: fs.existsSync(path.join(profile, 'posters')) ? fs.readdirSync(path.join(profile, 'posters')).length : -1 }
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { await app.close() }
