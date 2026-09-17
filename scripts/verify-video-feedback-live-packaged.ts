/** Optional live source check. Isolated profile, no real video transfer and no account cookies. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { listEpisodes } from '../electron/kinds/video/db.ts'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-video-feedback-20260912/win-unpacked/抱一.exe')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-native-source-'))
const evidence = path.resolve(process.argv[3] || 'output/video-feedback-fixes-20260912/native-live-source.json')
fs.mkdirSync(path.dirname(evidence), { recursive: true })
const d = new DatabaseSync(path.join(profile, 'baoyi.db'))
d.exec('PRAGMA foreign_keys = ON'); initSchema(d, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, hide_hentai: false })) d.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value))
const production = new DatabaseSync(path.join(process.env.APPDATA!, '抱一', 'baoyi.db'), { readOnly: true })
const proxy = production.prepare('SELECT value FROM settings WHERE key = ?').get('proxy')
production.close()
if (proxy) d.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('proxy', proxy.value)
const video = path.join(profile, 'Source.mp4'); fs.writeFileSync(video, 'synthetic source fixture')
const work = registerVideoContent(d, { title: 'Native source fixture', items: [{ title: 'Native source fixture', order: 1, files: [{ path: video }] }] })
const episodeId = listEpisodes(d, work.resourceId)[0].id
d.close()
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const checks: string[] = [], report: Record<string, unknown> = { executable, profile, checkedAt: new Date().toISOString(), sourceId: '407946', videoTransferred: false }
let app: any
try {
  app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env, timeout: 30000 })
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].hide())
  await page.waitForFunction(() => !!(window as any).baoyi)
  console.log('Checking exact source binding and two image roles in the packaged app')
  const result = await page.evaluate(({ id, episodeId }: { id: string; episodeId: string }) => (window as any).baoyi.video.scrapeEpisode(id, episodeId, '407946'), { id: work.resourceId, episodeId })
  assert.equal(result.item.hanime_id, '407946')
  assert.ok(result.episode.tags.length > 0)
  assert.ok(result.episode.published_at > 0)
  assert.ok(result.episode.duration_sec > 0)
  assert.ok(result.episode.studio)
  report.sourceFacts = { publishedDate: new Date(result.episode.published_at).toISOString().slice(0, 10), releaseDate: result.episode.air_date ? new Date(result.episode.air_date).toISOString().slice(0, 10) : '', durationSec: result.episode.duration_sec, studio: result.episode.studio }
  const sizes = await app.evaluate(({ nativeImage }: any, files: string[]) => files.map(file => nativeImage.createFromPath(file).getSize()), [result.episode.poster_path, result.episode.thumbnail_path])
  assert.ok(sizes[0].height > sizes[0].width && sizes[0].width > 0)
  assert.ok(sizes[1].width > sizes[1].height && sizes[1].height > 0)
  assert.notEqual(result.episode.poster_path, result.episode.thumbnail_path)
  report.images = { portrait: sizes[0], landscape: sizes[1] }; report.tagCount = result.episode.tags.length
  checks.push('exact source binding saves episode facts, publication date, studio, duration, portrait and landscape')
  console.log('PASS exact source binding and dual artwork')
  const draft = await page.evaluate((id: string) => (window as any).baoyi.video.prepareDownload({ resourceId: id }), work.resourceId)
  assert.equal(draft.videoCode, '407946'); assert.ok(draft.episodes.some((ep: any) => ep.videoCode === '407946'))
  report.catalogueEpisodes = draft.episodes.length
  checks.push('the newly bound local video can prepare its site catalogue for completion')
  console.log('PASS source-bound local video prepares its download catalogue')
  const hits = await page.evaluate(() => (window as any).baoyi.video.searchSource('姉とボイン'))
  assert.ok(hits.length > 0)
  report.nfoTitleSearchMatches = hits.length
  checks.push('the NFO sample title can be found without any pre-existing site identifier')
  console.log('PASS local NFO sample title has source search results')
  report.checks = checks; report.status = 'passed'
  console.log(`Native live source: ${checks.length} passed / 0 failed`)
} catch (error) {
  report.status = 'failed'; report.checks = checks
  report.error = (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, '[URL]')
  process.exitCode = 1
  console.error('FAIL native source check:', report.error)
} finally {
  if (app) await app.close()
  fs.writeFileSync(evidence, JSON.stringify(report, null, 2))
}
