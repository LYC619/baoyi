/** Field-report scenarios in the packaged application. All files and SQL writes are synthetic. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { applyVideoCatalogue } from '../electron/kinds/video/catalogue.ts'
import { applyVideoOrganize, previewVideoOrganize } from '../electron/kinds/video/organize.ts'
import { listEpisodes } from '../electron/kinds/video/db.ts'

const require = createRequire(import.meta.url)
const runtime = process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { _electron } = require(runtime), { expect } = require(runtime + '/test')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-video-field-retest-20260913/win-unpacked/抱一.exe')
const evidence = path.resolve(process.argv[3] || 'output/video-field-retest-20260913/native-field')
const live = process.argv.includes('--live')
assert.ok(fs.existsSync(executable))
for (const marker of ['portable.txt', '绿色版.txt']) assert.ok(!fs.existsSync(path.join(path.dirname(executable), marker)))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-field-native-'))
fs.mkdirSync(evidence, { recursive: true })
function file(relative: string, text = 'synthetic field retest video') {
  const value = path.join(profile, relative)
  assert.ok(!path.relative(profile, value).startsWith('..'))
  fs.mkdirSync(path.dirname(value), { recursive: true }); fs.writeFileSync(value, text); return value
}
const d = new DatabaseSync(path.join(profile, 'baoyi.db'))
d.exec('PRAGMA foreign_keys = ON'); initSchema(d, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, hide_hentai: false, theme: 'light', ai: { enabled: false, api_key: '', api_url: '', model: '' } })) {
  d.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value))
}
if (live) {
  const production = new DatabaseSync(path.join(process.env.APPDATA!, '抱一', 'baoyi.db'), { readOnly: true })
  const proxy = production.prepare('SELECT value FROM settings WHERE key = ?').get('proxy')
  production.close()
  if (proxy) d.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('proxy', proxy.value)
}
const source = (code: string) => ({ provider: 'hanime', externalId: code, scope: 'episode' as const, pageUrl: 'https://hanime1.me/watch?v=' + code, evidence: 'confirmed' as const })
const independent = ['406504', '406505'].map((code, index) => registerVideoContent(d, { title: '独立样例 LEVEL：' + (index + 1), category: '动画',
  items: [{ title: '独立样例 LEVEL：' + (index + 1), order: index + 1, number: index + 1, publishedAt: Date.UTC(2026, 5, 4), sources: [source(code)], files: [{ path: file('Independent/Example LEVEL：' + (index + 1) + '.mp4') }] }] }).resourceId)
d.prepare(`INSERT INTO video_sources(id,resource_id,episode_id,provider,external_id,scope,page_url,evidence,confirmed,created_at,updated_at)
  VALUES ('legacy-duplicate',?,NULL,'hanime','406504','episode','','legacy',0,0,0)`).run(independent[0])
d.exec("CREATE TRIGGER field_setup_failure BEFORE UPDATE ON video_meta BEGIN SELECT RAISE(ABORT, 'synthetic old failure'); END")
await assert.rejects(applyVideoOrganize(d, { preview: previewVideoOrganize(d, { resourceIds: independent, survivorId: independent[0], collectionTitle: '独立样例' }), mode: 'logical' }), /synthetic old failure/)
d.exec('DROP TRIGGER field_setup_failure')
const loose = registerVideoContent(d, { title: '本地增集样例', category: '动画', items: [{ title: 'Local story LEVEL：1', originalTitle: 'Local story LEVEL：1', order: 1, number: 1, sources: [source('880001')], files: [{ path: file('Loose/Local story LEVEL：1 [720P].mp4') }] }] }).resourceId
applyVideoCatalogue(d, loose, { videoCode: '880001', title: 'Local story', description: '', posterUrl: '', tags: [], warnings: [],
  currentEpisode: { videoCode: '880001', title: 'Local story LEVEL：1' }, episodes: [1, 2].map(number => ({ videoCode: '88000' + number, title: 'Local story LEVEL：' + number })) })
const secondId = listEpisodes(d, loose).find(episode => episode.episode === 2)!.id
const importFile = file('Import/Offline.mp4')
file('Import/Offline.nfo', '<movie><title>任务导入样例</title><plot>本地离线资料</plot></movie>')
d.close()
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
let app: any, page: any
const checks: string[] = [], errors: string[] = []
const report: Record<string, unknown> = { executable, profile, liveSources: live ? ['406504', '406505'] : [], videoTransferred: false }
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
  await check('single-work publication date is visible without manually selecting an episode', async () => {
    await route('/video/' + independent[0])
    await expect(page.locator('.hero__meta')).toContainText('2026-06-04')
    await page.screenshot({ path: path.join(evidence, 'single-date.png') })
  })
  if (live) await check('both reported source IDs prepare independently within their shared live playlist', async () => {
    for (const [index, id] of independent.entries()) {
      const draft = await page.evaluate((id: string) => (window as any).baoyi.video.prepareDownload({ resourceId: id }), id)
      assert.equal(draft.resourceId, id)
      assert.equal(draft.episodes.find((episode: any) => episode.videoCode === ['406504', '406505'][index]).state, 'local')
      assert.equal(draft.episodes.find((episode: any) => episode.videoCode === ['406505', '406504'][index]).state, 'other-work')
      assert.equal((await library(id)).contents.length, 1)
    }
  })
  await check('an unbound work discovers its second local file and includes it in deletion preview', async () => {
    const secondFile = file('Loose/Local story LEVEL：2 [720P].mp4')
    await route('/video/' + loose)
    await page.getByRole('button', { name: '检查文件', exact: true }).click()
    await expect(page.locator('.video-items__check-result')).toContainText('新增 1 个视频')
    const row = page.locator('.video-item').filter({ hasText: 'Local story LEVEL：2' })
    await expect(row.locator('.video-item__state')).toContainText('文件可用')
    assert.equal((await library(loose)).contents.find((episode: any) => episode.id === secondId).path, secondFile)
    await row.getByRole('button', { name: '查看第 2 集简介', exact: true }).click()
    await page.getByRole('button', { name: '移除 / 移出合集…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '管理这一集', exact: true })
    await dialog.getByRole('checkbox').check()
    await expect(dialog).toContainText(secondFile)
    await expect(dialog.getByRole('button', { name: '删除记录并移入回收站', exact: true })).toBeEnabled()
    await page.screenshot({ path: path.join(evidence, 'second-file-removal-preview.png') })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  })
  await check('collection uses the series title and can replace a failed empty legacy attempt', async () => {
    await route('/video')
    await page.getByRole('button', { name: '创建合集', exact: true }).click()
    for (const number of [1, 2]) await page.getByRole('button', { name: '选择作品：独立样例 LEVEL：' + number, exact: true }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '组建合集', exact: true })
    await expect(dialog.getByLabel('合集名称', { exact: true })).toHaveValue('独立样例')
    const create = dialog.getByRole('button', { name: '创建合集', exact: true })
    await expect(create).toBeEnabled(); await create.click()
    await expect(dialog.locator('.organize-journal__status')).toHaveText('已完成')
    assert.equal((await library(independent[0])).contents.length, 2)
    assert.ok(!(await dialog.innerText()).includes('作品资料或文件已变化'))
    await page.screenshot({ path: path.join(evidence, 'collection-created.png') })
    await dialog.getByRole('button', { name: '关闭整理面板', exact: true }).click()
  })
  await check('directory import persists its progress and results in the task panel', async () => {
    await route('/video')
    await app.evaluate(({ dialog }: any, directory: string) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, path.dirname(importFile))
    await page.getByRole('button', { name: '导入目录', exact: true }).click()
    await page.getByRole('button', { name: /^任务中心：/ }).click()
    const dialog = page.getByRole('dialog', { name: '任务与下载', exact: true })
    const task = dialog.locator('.task-card').filter({ has: page.getByRole('heading', { name: '影视目录导入', exact: true }) })
    await expect(task).toContainText('已完成')
    await expect(task).toContainText('1 项入库')
    await task.getByRole('button', { name: /查看日志/ }).click()
    await expect(task).toContainText('已读取本地资料')
    await page.screenshot({ path: path.join(evidence, 'import-task.png') })
    await dialog.getByRole('button', { name: '关闭任务面板', exact: true }).click()
  })
  await app.close(); app = undefined
  await launch()
  await check('restart retains imported task history, collection ownership and discovered files', async () => {
    assert.equal((await library(independent[0])).contents.length, 2)
    assert.equal((await library(loose)).contents.find((episode: any) => episode.id === secondId).assets.filter((asset: any) => asset.role === 'video' && asset.state === 'present').length, 1)
    const tasks = await page.evaluate(() => (window as any).baoyi.tasks.list())
    assert.ok(tasks.some((task: any) => task.title === '影视目录导入' && task.status === 'success'))
    assert.deepEqual(errors, [])
  })
  report.status = 'passed'
} catch (cause) {
  report.status = 'failed'; report.error = cause instanceof Error ? cause.message : String(cause)
  console.error('FAIL native field retest:', report.error); process.exitCode = 1
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {})
} finally {
  if (app) await app.close()
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ ...report, checks, errors }, null, 2))
}
console.log(`Native field retest: ${checks.length} passed / ${process.exitCode ? 1 : 0} failed`)
