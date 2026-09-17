/** Read the repaired example through the packaged renderer using a copy of the production database. No media writes/playback/network scraping. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const runtime = process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { _electron } = require(runtime), { expect } = require(runtime + '/test')
const executable = path.resolve('release/0.8.0-local-structure-20260912/win-unpacked/抱一.exe')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-actual-read-'))
const live = new DatabaseSync('C:/Users/yicha/AppData/Roaming/抱一/baoyi.db', { readOnly: true })
try { live.prepare('VACUUM INTO ?').run(path.join(profile, 'baoyi.db')) } finally { live.close() }
const fixture = new DatabaseSync(path.join(profile, 'baoyi.db'))
try {
  for (const [key, value] of Object.entries({ onboarded: true, hide_hentai: false })) fixture.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, JSON.stringify(value))
} finally { fixture.close() }
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const id = 'b1200803-90dc-4289-8161-fd853f71f0df'
const app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env, timeout: 30000 })
try {
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  const page = await app.firstWindow(); page.setDefaultTimeout(15000)
  await page.waitForFunction(() => !!(window as any).baoyi)
  const errors: string[] = []
  page.on('pageerror', (error: Error) => errors.push(error.message))
  await page.evaluate((id: string) => { location.hash = '/video/' + id }, id)
  await expect(page.locator('.hero__title')).toHaveText('妻NTR・凌辱輪迴 0-4')
  await expect(page.locator('.video-item')).toHaveCount(5)
  await expect(page.locator('.video-item__cover img')).toHaveCount(5)
  await page.waitForFunction(() => [...document.querySelectorAll('.video-item__cover img, .hero__img')].every(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))
  await expect(page.locator('.hero__title-line')).toContainText('里番')
  await expect(page.locator('.video-item').first()).toContainText('第 0 集')
  await expect(page.locator('.video-item').first().getByRole('button', { name: /^播放/ })).toBeDisabled()
  const library = await page.evaluate((id: string) => (window as any).baoyi.video.library(id), id)
  assert.equal(library.directory.path, 'E:\\视频\\妻NTR・凌辱輪迴 0-4')
  assert.equal(library.assets.filter((asset: any) => asset.role === 'video' && asset.state === 'present').length, 4)
  assert.deepEqual(library.contents.map((ep: any) => ep.episode), [0, 1, 2, 3, 4])
  assert.ok(library.contents.every((ep: any) => ep.original_title && ep.description && ep.poster_path))
  assert.equal(new Set(library.contents.map((ep: any) => ep.poster_path)).size, 5)
  assert.equal(library.contents.find((ep: any) => ep.episode === 3).watched_at, 1789184824121)
  assert.equal(library.contents.find((ep: any) => ep.episode === 4).watched_at, 1789183822175)
  const works = await page.evaluate(() => (window as any).baoyi.video.list({ type: 'hentai' }))
  assert.ok(works.some((work: any) => work.id === id))
  assert.ok(!works.some((work: any) => work.id === 'aa6df460-4f3f-4c90-9dc2-bd0d06a0a4c6'))
  assert.deepEqual(errors, [])
  const report = { executable, profile, resourceId: id, directory: library.directory.path, localFiles: 4, missingEpisodes: [0],
    episodePostersRendered: 5, separateDescriptions: true, watchingHistoryPreserved: true, duplicateHidden: true, rendererErrors: errors }
  fs.writeFileSync('output/video-local-structure-20260912/actual-packaged-check.json', JSON.stringify(report, null, 2))
  console.log('PASS repaired example: native cards, five posters, episode zero missing, four local files, independent descriptions, original history and one active collection')
} finally { await app.close() }
