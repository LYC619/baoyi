/** Launch only a supplied local build, with a freshly seeded, isolated user profile. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { insertVideo, type VideoPayload } from '../electron/kinds/video/db.ts'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-field-test-20260908/win-unpacked/抱一.exe')
assert.ok(fs.existsSync(executable), 'Test build executable is missing')
const output = path.resolve('.recover/field-test-fixes/packaged-ui')
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const mediaDir = path.join(profile, 'media'); const posters = path.join(profile, 'posters')
fs.mkdirSync(mediaDir); fs.mkdirSync(posters)
const picture = fs.readFileSync('resources/icon.png')
const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'light' })) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
}
const ids: Record<string, string> = {}
for (const [key, title, category, collection] of [
  ['film', '影片示例', '欧美', '放映清单'], ['recording', '培训录屏示例', '其他', '培训系列'], ['hentai', '站方样本', '里番', '站方系列']
]) {
  const file = path.join(mediaDir, key + '.mp4'); fs.writeFileSync(file, 'synthetic fixture')
  const payload: VideoPayload = {
    path: file, video_type: 'movie', name_zh: title, name_en: '', category, collection_name: collection,
    summary: '本地验证条目', description: '', tags: [], official_url: '', source_dir: mediaDir, file_size: 17,
    year: 2026, end_year: 0, rating: 0, duration_sec: 1500, resolution: '1080p', video_codec: '', source: '', release_group: '',
    audio_tracks: [], subtitle_tracks: [], parts: [{ path: file, label: '', file_size: 17, duration_sec: 1500 }], linked_files: [],
    tmdb_id: '', imdb_id: '', douban_id: '', douban_rating: 0, hanime_tags: key === 'hentai' ? ['站方标签'] : [],
    poster_path: '', fanart_path: '', episodes: []
  }
  const id = insertVideo(db, payload).id; ids[key] = id
  const cached = path.join(posters, id + '.png'); fs.writeFileSync(cached, picture)
  fs.writeFileSync(path.join(mediaDir, key + '-poster.png'), picture)
  db.prepare('UPDATE video_meta SET poster_path = ? WHERE resource_id = ?').run(cached, id)
}
db.close()
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE
const application = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], env: environment, timeout: 30000 })
const evidence: string[] = []; const errors: string[] = []
try {
  const actualProfile = await application.evaluate(({ app }: any) => app.getPath('userData'))
  assert.equal(path.resolve(actualProfile).toLowerCase(), path.resolve(profile).toLowerCase(), 'Refusing to use a non-isolated profile')
  evidence.push('isolated-profile')
  const page = await application.firstWindow(); page.on('pageerror', (error: Error) => errors.push(error.message))
  await page.waitForFunction(() => !!(window as any).baoyi)
  await page.evaluate(() => { location.hash = '/video' })
  await page.waitForFunction(() => document.querySelectorAll('.wall .card').length === 2)
  const info = await page.evaluate(() => (window as any).baoyi.app.info())
  assert.equal(info.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version)
  const counts = await page.evaluate(() => (window as any).baoyi.video.counts())
  assert.equal(counts.all, 2); assert.equal(counts.hentai, 1)
  evidence.push('native-db-preload-query')
  await page.getByRole('button', { name: /培训录屏示例/ }).click()
  await page.getByLabel('视频分组', { exact: true }).fill('课程笔记')
  await page.getByLabel('视频分组', { exact: true }).press('Tab')
  await page.waitForFunction(async (id: string) => (await (window as any).baoyi.video.get(id)).collection_name === '课程笔记', ids.recording)
  await page.getByRole('button', { name: '查看分组', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.wall .card').length === 1)
  assert.match(await page.locator('.wall').innerText(), /培训录屏示例/)
  evidence.push('edit-and-open-collection')
  await page.locator('.sidebar .row').filter({ hasText: '其他分类' }).click()
  await page.waitForFunction(() => document.querySelector('.home__heading')?.textContent?.includes('其他分类') || document.querySelector('main h1')?.textContent?.includes('其他分类'))
  assert.equal(await page.locator('.wall .card').count(), 1)
  evidence.push('other-category')
  await page.locator('.sidebar .row').filter({ hasText: /^里番/ }).click()
  await page.getByRole('button', { name: /站方样本/ }).waitFor()
  assert.equal(await page.locator('.wall .card').count(), 1)
  await page.locator('.sidebar .row').filter({ hasText: '站方标签' }).click()
  assert.equal(await page.locator('.wall .card').count(), 1)
  await page.getByRole('button', { name: /站方样本/ }).click()
  assert.equal(await page.getByRole('combobox', { name: '视频类型', exact: true }).inputValue(), 'hentai')
  assert.equal(await page.getByLabel('视频分类', { exact: true }).count(), 0)
  await page.getByRole('combobox', { name: '视频类型', exact: true }).selectOption('movie')
  await page.waitForFunction(async (id: string) => (await (window as any).baoyi.video.get(id)).category === '其他', ids.hentai)
  await page.getByRole('combobox', { name: '视频类型', exact: true }).selectOption('hentai')
  await page.waitForFunction(async (id: string) => (await (window as any).baoyi.video.get(id)).category === '里番', ids.hentai)
  evidence.push('hentai-type-tags-and-type-edit')
  for (const [width, height] of [[1280, 900], [960, 720]]) {
    await application.evaluate(({ BrowserWindow }: any, dimensions: number[]) => BrowserWindow.getAllWindows()[0].setContentSize(dimensions[0], dimensions[1]), [width, height])
    await page.screenshot({ path: path.join(output, `detail-${width}.png`) })
    const overflow = await page.evaluate(() => [...document.querySelectorAll('input,select')].filter(e => {
      const a = e.getBoundingClientRect(); const b = (e.closest('.panel') || e.parentElement)!.getBoundingClientRect()
      return a.width > 0 && (a.right > b.right + 2 || a.left < b.left - 2)
    }).map(e => e.getAttribute('aria-label') || e.className))
    assert.deepEqual(overflow, [])
  }
  await page.evaluate(() => { location.hash = '/video' })
  await page.locator('.sidebar .row').filter({ hasText: '全部影视' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.wall .card').length === 2)
  for (const [width, height] of [[1280, 900], [960, 720]]) {
    await application.evaluate(({ BrowserWindow }: any, dimensions: number[]) => BrowserWindow.getAllWindows()[0].setContentSize(dimensions[0], dimensions[1]), [width, height])
    await page.screenshot({ path: path.join(output, `library-${width}.png`) })
    assert.equal(await page.locator('.sidebar .row').filter({ hasText: '站方系列' }).count(), 0)
  }
  evidence.push('1280-and-960-layouts')
  fs.unlinkSync(path.join(posters, ids.recording + '.png'))
  await page.reload()
  await page.getByRole('button', { name: /补海报 1/ }).waitFor()
  await page.getByRole('button', { name: /补海报 1/ }).click()
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.wall .card__img')].filter(img => img.complete && img.naturalWidth > 0).length === 2)
  evidence.push('missing-poster-ui-repair-and-custom-protocol')
  await page.evaluate(() => (window as any).baoyi.settings.patch({ hide_hentai: true }))
  await page.reload()
  await page.locator('.sidebar').waitFor()
  assert.equal(await page.locator('.sidebar .row').filter({ hasText: /^里番/ }).count(), 0)
  assert.equal((await page.evaluate(() => (window as any).baoyi.video.list({ type: 'hentai' }))).length, 0)
  evidence.push('global-hide')
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ executable, profile, evidence, errors }, null, 2))
  console.log(`Packaged UI: ${evidence.length} checks passed; screenshots: ${output}`)
} catch (error) {
  const page = application.windows()[0]
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.txt'), JSON.stringify({ evidence, errors, text: await page.locator('body').innerText() }, null, 2))
  }
  throw error
} finally {
  await application.close()
}
