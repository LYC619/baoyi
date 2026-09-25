/** Packaged UX and video field-feedback checks. Uses only a new temporary profile and synthetic media. */
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
import { createVideoJobStore } from '../electron/kinds/video/download/jobs.ts'
import type { VideoDownloadJob } from '../src/types/video-workflow.ts'

const require = createRequire(import.meta.url)
const runtime = process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { _electron } = require(runtime)
const { expect } = require(runtime + '/test')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-local-structure-20260912/win-unpacked/抱一.exe')
assert.ok(fs.existsSync(executable), 'Build the application before running this check')
for (const marker of ['portable.txt', '绿色版.txt']) assert.ok(!fs.existsSync(path.join(path.dirname(executable), marker)), 'Portable markers override the isolated profile')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-ux-package-'))
const evidenceRoot = path.resolve('output/video-local-structure-20260912/packaged-ui')
fs.mkdirSync(evidenceRoot, { recursive: true })
const output = fs.mkdtempSync(path.join(evidenceRoot, 'run-'))
const media = path.join(profile, 'media')
const posters = path.join(profile, 'posters')
fs.mkdirSync(media); fs.mkdirSync(posters)
const dbPath = path.join(profile, 'baoyi.db')
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL')
initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'light', hide_hentai: true, video_download_root: media })) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
}
const originalFiles: Record<string, string> = {}
function work(key: string, title: string, count: number, firstNumber = 1, category = '其他') {
  const directory = path.join(media, key)
  fs.mkdirSync(directory)
  const items = Array.from({ length: count }, (_, index) => {
    const number = firstNumber + index
    const file = path.join(directory, `chapter-${number}.mp4`)
    originalFiles[file] = `isolated content ${key} ${number}`
    fs.writeFileSync(file, originalFiles[file])
    const files = [{ path: file, quality: '1080p', size: fs.statSync(file).size }]
    if (key === 'course' && !index) {
      const alternate = path.join(directory, 'chapter-1-720p.mp4')
      originalFiles[alternate] = 'isolated alternate version'
      fs.writeFileSync(alternate, originalFiles[alternate])
      files.push({ path: alternate, quality: '720p', size: fs.statSync(alternate).size })
    }
    return { title: `第 ${number} 讲 · 摄影构图与光线实践`, originalTitle: `Original lesson ${number}`, description: `第 ${number} 集的独立简介。`,
      label: `章节 ${number}`, order: number, season: 1, number, files }
  })
  const result = registerVideoContent(db, { title, directory, root: media, category, tags: ['摄影', '课程'], items })
  const poster = path.join(posters, result.resourceId + '.png')
  fs.copyFileSync('resources/icon.png', poster)
  db.prepare('UPDATE video_meta SET poster_path = ? WHERE resource_id = ?').run(poster, result.resourceId)
  return { ...result, directory, items, episodes: listEpisodes(db, result.resourceId) }
}
const course = work('course', '摄影课程：从构图、光线到后期处理的完整学习记录与实践示例', 8)
const donor = work('supplement', '课程补录 · 第九讲', 1, 9)
const hidden = work('private', '隔离的私密作品标识', 1, 1, '里番')
db.prepare("UPDATE resource SET notes = '保留主作品笔记' WHERE id = ?").run(course.resourceId)
db.prepare("UPDATE episode SET watch_status = 'watching', position_sec = 91 WHERE id = ?").run(donor.episodes[0].id)
const jobs = createVideoJobStore(db)
for (const [key, owner, category] of [['finished', course, '其他'], ['private-job', hidden, '里番']] as const) {
  const job: VideoDownloadJob = { id: key, resourceId: owner.resourceId, bundleId: owner.bundleId, title: key === 'private-job' ? '隔离的私密任务标识' : '已完成的课程任务', category,
    videoCode: 'fixture-' + key, root: media, directory: owner.directory, sourceLabel: '1080p', strictQuality: true, register: true,
    status: 'success', createdAt: 1, updatedAt: 2, message: '已完成', description: '', posterUrl: '', posterPath: '', sources: [], warnings: [],
    items: [{ videoCode: 'fixture-' + key, title: '完成内容', order: 1, path: owner.items[0].files[0].path, sourceLabel: '1080p', transfer: 'complete', metadata: 'complete', registration: 'complete', receivedBytes: 1, totalBytes: 1, error: '', warnings: [] }] }
  jobs.save(job)
}
db.close()

const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
delete environment.VITE_DEV_SERVER_URL
const checks: string[] = [], errors: string[] = [], layouts: unknown[] = []
let application: any, page: any
async function launch() {
  application = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], env: environment, timeout: 30000 })
  const actual = await application.evaluate(({ app }: any) => app.getPath('userData'))
  assert.equal(path.resolve(actual).toLowerCase(), profile.toLowerCase(), 'Refusing to operate on a non-isolated profile')
  page = await application.firstWindow()
  page.setDefaultTimeout(12000)
  page.on('pageerror', (error: Error) => errors.push(error.message))
  page.on('console', (message: any) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.waitForFunction(() => !!(window as any).baoyi)
}
function read<T>(query: (d: DatabaseSync) => T): T {
  const connection = new DatabaseSync(dbPath, { readOnly: true })
  try { return query(connection) } finally { connection.close() }
}
async function go(hash: string) {
  await page.evaluate((value: string) => { location.hash = value }, hash)
}
async function check(name: string, action: () => Promise<void>) {
  await action(); checks.push(name); console.log('PASS', name)
}
async function size(width: number, height: number, zoom = 1) {
  await application.evaluate(({ BrowserWindow }: any, values: number[]) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setZoomFactor(values[2]); window.setContentSize(values[0], values[1])
  }, [width, height, zoom])
}
async function screenshot(file: string): Promise<void> {
  await page.waitForFunction(() => {
    const view = document.querySelector('.app__view')
    return view && getComputedStyle(view).opacity === '1' && !document.querySelector('.page-enter-active, .page-leave-active')
  })
  await page.screenshot({ path: path.join(output, file), animations: 'disabled' })
}
async function selectOrganization() {
  await go('/video')
  await page.getByRole('button', { name: /^(创建合集|取消选择)$/ }).waitFor()
  const select = page.getByRole('button', { name: '创建合集', exact: true })
  if (await select.count()) await select.click()
  else await expect(page.getByRole('button', { name: '取消选择', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '全选当前范围', exact: true }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '组建合集', exact: true })
  await expect(panel.getByRole('button', { name: '创建合集', exact: true })).toBeEnabled()
  return panel
}

try {
  await launch()
  await check('isolated packaged app, native SQLite and preload', async () => {
    assert.equal(await page.evaluate(() => (window as any).baoyi.data.dir()), profile)
    assert.equal((await page.evaluate(() => (window as any).baoyi.app.info())).version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version)
    assert.ok(fs.existsSync(path.join(path.dirname(executable), 'resources/MediaInfoModule.wasm')))
    await go('/video')
    await expect(page.locator('.wall .card')).toHaveCount(2)
    const counts = await page.evaluate(() => (window as any).baoyi.video.counts())
    assert.equal(counts.all, 2); assert.equal(counts.hentai, 0)
  })
  await check('private works and download tasks stay hidden', async () => {
    assert.deepEqual(await page.evaluate(() => (window as any).baoyi.video.list({ type: 'hentai' })), [])
    assert.equal((await page.evaluate(() => (window as any).baoyi.video.downloadJobs())).length, 1)
    await page.locator('.task-trigger').click()
    await expect(page.locator('.task-panel')).toBeVisible()
    assert.ok(!(await page.locator('.task-panel').innerText()).includes('私密'))
    await page.keyboard.press('Escape')
  })
  await check('960×640 / 1280×900 detail rows, both themes and keyboard', async () => {
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme: string) => (window as any).baoyi.settings.patch({ theme }), theme)
      await go('/video/' + course.resourceId); await page.reload()
      await expect(page.locator('.video-item')).toHaveCount(8)
      await page.getByRole('button', { name: '列表视图', exact: true }).click()
      for (const [width, height, minimum] of [[960, 640, 3], [1280, 900, 5]]) {
        await size(width, height)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme,
          visible: [...document.querySelectorAll('.video-item')].filter(element => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }).length,
          overflow: document.documentElement.scrollWidth > innerWidth }))
        assert.ok(layout.visible >= minimum, JSON.stringify(layout)); assert.equal(layout.overflow, false); assert.equal(layout.theme, theme)
        layouts.push(layout)
        await screenshot(`detail-${width}-${theme}.png`)
      }
    }
    const control = page.getByRole('button', { name: '下载 / 补齐内容', exact: true })
    await control.focus(); await page.keyboard.press('Tab')
    const focus = await page.evaluate(() => { const e = document.activeElement!; return { tag: e.tagName, width: getComputedStyle(e).outlineWidth } })
    assert.notEqual(focus.tag, 'BODY'); assert.notEqual(focus.width, '0px')
  })
  await check('125% interface zoom keeps controls within the window', async () => {
    await size(1280, 900, 1.25)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await expect(page.getByRole('button', { name: '下载 / 补齐内容', exact: true })).toBeVisible()
    await screenshot('detail-125-percent.png')
    await size(1280, 900)
  })
  await check('default file version and watched state persist through native IPC', async () => {
    const row = page.locator('.video-item').first()
    const library = await page.evaluate((id: string) => (window as any).baoyi.video.library(id), course.resourceId)
    const alternate = library.contents[0].assets.find((asset: any) => asset.quality === '720p')
    await row.getByRole('combobox').selectOption(alternate.id)
    await row.getByRole('button', { name: '设为默认', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((id: string) => (window as any).baoyi.video.library(id), course.resourceId)).contents[0].path).toBe(alternate.path)
    await page.locator('.video-item').nth(1).getByRole('button', { name: /^标记看过：/ }).click()
    await expect.poll(() => read(d => d.prepare('SELECT watch_status FROM episode WHERE id = ?').get(course.episodes[1].id)!.watch_status)).toBe('watched')
  })
  await check('episode tabs show separate descriptions and save notes to the selected episode', async () => {
    // Wait for refreshed episode counters before selecting another episode.
    await expect(page.getByLabel('作品信息', { exact: true })).toHaveCount(1)
    await expect(page.getByLabel('作品信息', { exact: true })).toContainText('已看 1 / 8 集')
    await expect(page.getByLabel('作品信息', { exact: true })).toContainText('摄影')
    await page.locator('.video-item').nth(3).getByRole('button', { name: /^查看/ }).click()
    const description = page.getByRole('tabpanel', { name: '剧情简介', exact: true })
    await expect(description).toContainText('第 4 集的独立简介。')
    assert.ok(!(await description.innerText()).includes('第 1 集的独立简介。'))
    await screenshot('episode-description.png')
    await page.getByRole('tab', { name: '个人笔记', exact: true }).click()
    await page.getByRole('button', { name: '编辑资料', exact: true }).click()
    const notes = page.getByRole('tabpanel', { name: '个人笔记', exact: true })
    await notes.locator('textarea').fill('只保存在第四集的实测笔记')
    await notes.getByRole('heading').click()
    await expect.poll(() => read(d => d.prepare('SELECT notes FROM episode WHERE id = ?').get(course.episodes[3].id)!.notes)).toBe('只保存在第四集的实测笔记')
    assert.equal(read(d => d.prepare('SELECT notes FROM resource WHERE id = ?').get(course.resourceId)!.notes), '保留主作品笔记')
    await page.getByRole('button', { name: '完成编辑', exact: true }).click()
    await page.getByRole('tab', { name: /作品内容/ }).click()
  })
  await check('return from a video opened after a game lands in the video library', async () => {
    await go('/game')
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/game')
    await go('/video/' + course.resourceId)
    await expect(page.locator('.video-item')).toHaveCount(8)
    await page.getByRole('button', { name: '返回影视库', exact: true }).click()
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/video')
  })
  await check('organization preview is read-only; UI merge and rollback preserve history', async () => {
    const panel = await selectOrganization()
    await expect(panel.getByRole('button', { name: '创建合集', exact: true })).toBeEnabled()
    assert.equal(read(d => d.prepare('SELECT COUNT(*) AS n FROM video_organize_journal').get()!.n), 0)
    assert.equal(read(d => d.prepare('SELECT COUNT(*) AS n FROM resource WHERE is_archived = 0').get()!.n), 3)
    await screenshot('organize-preview.png')
    await panel.getByRole('button', { name: '创建合集', exact: true }).click()
    await expect(panel.locator('.organize-journal__status')).toHaveText('已完成')
    assert.equal((await page.evaluate((id: string) => (window as any).baoyi.video.library(id), course.resourceId)).contents.length, 9)
    assert.equal(read(d => d.prepare('SELECT position_sec FROM episode WHERE id = ?').get(donor.episodes[0].id)!.position_sec), 91)
    await panel.getByRole('button', { name: '回退本次操作', exact: true }).click()
    await expect(panel.locator('.organize-journal__status')).toHaveText('已回退')
    assert.equal(read(d => d.prepare('SELECT resource_id FROM episode WHERE id = ?').get(donor.episodes[0].id)!.resource_id), donor.resourceId)
    assert.equal(read(d => d.prepare('SELECT notes FROM resource WHERE id = ?').get(course.resourceId)!.notes), '保留主作品笔记')
    await panel.getByRole('button', { name: '关闭整理面板', exact: true }).click()
  })
  await check('physical organization through UI publishes files and retains originals', async () => {
    const panel = await selectOrganization()
    const target = course.directory
    await panel.locator('summary').filter({ hasText: '文件整理（可选）' }).click()
    await panel.getByRole('checkbox', { name: '同时复制文件到统一目录', exact: true }).check()
    await panel.locator('.organize-location input').fill(path.join(profile, 'organized', '课程整理'))
    await expect(panel.getByText('目标必须位于所选根目录内', { exact: true }).first()).toBeVisible()
    await expect(panel.getByRole('button', { name: '创建合集并复制文件', exact: true })).toBeDisabled()
    await panel.locator('.organize-root summary').click()
    await panel.getByLabel('所属影视库根目录', { exact: true }).fill(profile)
    await expect(panel.getByText('作品已绑定另一目录，请先使用整目录重新定位', { exact: true })).toBeVisible()
    await panel.locator('.organize-location input').fill(target)
    await panel.getByLabel('所属影视库根目录', { exact: true }).fill(media)
    await expect(panel.getByRole('button', { name: '创建合集并复制文件', exact: true })).toBeEnabled()
    await panel.getByRole('button', { name: '创建合集并复制文件', exact: true }).click()
    await expect(panel.locator('.organize-journal__status').first()).toHaveText('已完成')
    await expect(panel.locator('.organize-notice')).toHaveCount(0)
    const library = await page.evaluate((id: string) => (window as any).baoyi.video.library(id), course.resourceId)
    assert.equal(library.directory.path, target); assert.equal(library.contents.length, 9)
    for (const asset of library.assets) if (asset.role === 'video') assert.ok(fs.existsSync(asset.path))
    for (const [file, contents] of Object.entries(originalFiles)) assert.equal(fs.readFileSync(file, 'utf8'), contents)
    assert.ok(fs.existsSync(path.join(target, 'baoyi.json')))
    await screenshot('organize-result.png')
    await panel.getByRole('button', { name: '关闭整理面板', exact: true }).click()
  })
  await check('task clearing is scoped and protects active work and reset', async () => {
    await page.evaluate(async () => {
      const api = (window as any).baoyi
      for (const [id, status] of [['completed-a', 'success'], ['completed-b', 'success'], ['active-a', 'running']]) {
        await api.tasks.save({ id, status, kind: 'video-scan', title: id, startedAt: Date.now(), processed: 0, total: 1, percent: 0, current: '', message: '', events: [] })
      }
      await api.tasks.clear([])
    })
    assert.equal((await page.evaluate(() => (window as any).baoyi.tasks.list())).length, 3)
    await page.evaluate(() => (window as any).baoyi.tasks.clear(['completed-a', 'active-a']))
    assert.deepEqual((await page.evaluate(() => (window as any).baoyi.tasks.list())).map((task: any) => task.id).sort(), ['active-a', 'completed-b'])
    await page.evaluate(() => (window as any).baoyi.tasks.clear())
    assert.deepEqual((await page.evaluate(() => (window as any).baoyi.tasks.list())).map((task: any) => task.id), ['active-a'])
    await assert.rejects(page.evaluate(() => (window as any).baoyi.data.reset('library')), /任务/)
    await page.evaluate(async () => { const api = (window as any).baoyi; const task = (await api.tasks.list())[0]; await api.tasks.save({ ...task, status: 'success' }); await api.tasks.clear() })
  })

  const backupPath = path.join(profile, 'all-metadata.json')
  await application.evaluate(({ app, dialog }: any, file: string) => {
    const state = { file, confirm: false, messages: [] as any[], restarts: [] as any[], originals: { save: dialog.showSaveDialog, open: dialog.showOpenDialog, message: dialog.showMessageBox, relaunch: app.relaunch, exit: app.exit } }
    ;(globalThis as any).__uxFixture = state
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: state.file })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [state.file] })
    dialog.showMessageBox = async (_window: unknown, options: unknown) => { state.messages.push(options); return { response: state.confirm ? 1 : 0 } }
    app.relaunch = () => state.restarts.push('relaunch')
    app.exit = (code: number) => state.restarts.push(['exit', code])
  }, backupPath)
  await check('Settings exports all 21 metadata tables without settings', async () => {
    await go('/settings')
    await page.getByRole('button', { name: '数据管理', exact: true }).click()
    await page.getByRole('button', { name: '备份全部资料（JSON）', exact: true }).click()
    await expect.poll(() => fs.existsSync(backupPath)).toBe(true)
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    assert.equal(backup.format, 'baoyi-library-metadata')
    assert.equal(Object.keys(backup.tables).length, 21); assert.ok(!('settings' in backup.tables))
    assert.equal(backup.tables.resource.length, 3)
    assert.equal(backup.tables.video_organize_journal.length, 2)
    await screenshot('settings-backup.png')
  })
  await check('cancelled restore is read-only; confirmed restore snapshots WAL and requests restart', async () => {
    await page.evaluate((id: string) => (window as any).baoyi.video.update(id, { name_zh: '恢复前修改的标题' }), course.resourceId)
    const restore = page.getByRole('button', { name: '从备份恢复', exact: true })
    await restore.click()
    await expect.poll(() => application.evaluate(() => (globalThis as any).__uxFixture.messages.length)).toBe(1)
    await expect(restore).toBeEnabled()
    assert.equal(read(d => d.prepare('SELECT name_zh FROM resource WHERE id = ?').get(course.resourceId)!.name_zh), '恢复前修改的标题')
    assert.ok(!fs.existsSync(path.join(profile, 'recovery')))
    await application.evaluate(() => { (globalThis as any).__uxFixture.confirm = true })
    await restore.click()
    await expect.poll(() => application.evaluate(() => (globalThis as any).__uxFixture.restarts.length)).toBe(2)
    const originalTitle = JSON.parse(fs.readFileSync(backupPath, 'utf8')).tables.resource.find((r: any) => r.id === course.resourceId).name_zh
    assert.equal(read(d => d.prepare('SELECT name_zh FROM resource WHERE id = ?').get(course.resourceId)!.name_zh), originalTitle)
    const recoveryFiles = fs.readdirSync(path.join(profile, 'recovery')).filter(file => file.endsWith('.db'))
    assert.equal(recoveryFiles.length, 1)
    const snapshot = new DatabaseSync(path.join(profile, 'recovery', recoveryFiles[0]), { readOnly: true })
    try {
      assert.equal(snapshot.prepare('SELECT name_zh FROM resource WHERE id = ?').get(course.resourceId)!.name_zh, '恢复前修改的标题')
      assert.equal(snapshot.prepare("SELECT value FROM settings WHERE key = 'video_download_root'").get()!.value, JSON.stringify(media))
    } finally { snapshot.close() }
    assert.deepEqual(await application.evaluate(() => (globalThis as any).__uxFixture.restarts), ['relaunch', ['exit', 0]])
    for (const [file, contents] of Object.entries(originalFiles)) assert.equal(fs.readFileSync(file, 'utf8'), contents)
  })
  await application.evaluate(({ app, dialog }: any) => {
    const original = (globalThis as any).__uxFixture.originals
    Object.assign(dialog, { showSaveDialog: original.save, showOpenDialog: original.open, showMessageBox: original.message })
    app.relaunch = original.relaunch; app.exit = original.exit
  })
  await application.close(); application = undefined
  await launch()
  await check('new process reads restored library and task history', async () => {
    assert.equal((await page.evaluate((id: string) => (window as any).baoyi.video.library(id), course.resourceId)).contents.length, 9)
    assert.equal((await page.evaluate(() => (window as any).baoyi.video.downloadJobs())).length, 1)
    assert.equal((await page.evaluate(() => (window as any).baoyi.videoOrganize.list())).length, 2)
  })
  await check('Settings reset clears SQLite, runtime jobs and renderer state; originals remain', async () => {
    await go('/settings')
    await page.getByRole('button', { name: '数据管理', exact: true }).click()
    page.once('dialog', (dialog: any) => dialog.accept())
    const reloaded = page.waitForEvent('domcontentloaded')
    await page.getByRole('button', { name: '清空识别数据', exact: true }).click()
    await reloaded
    await expect.poll(() => read(d => d.prepare('SELECT COUNT(*) AS n FROM resource').get()!.n)).toBe(0)
    await expect.poll(async () => { try { return (await page.evaluate(() => (window as any).baoyi.video.downloadJobs())).length } catch { return -1 } }).toBe(0)
    await page.waitForFunction(() => !!(window as any).baoyi)
    for (const table of ['video_assets', 'video_sources', 'video_directories', 'episode', 'video_download_jobs', 'video_organize_journal', 'task_records']) {
      assert.equal(read(d => d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n), 0, table)
    }
    assert.equal(read(d => d.prepare("SELECT value FROM settings WHERE key = 'video_download_root'").get()!.value), JSON.stringify(media))
    for (const [file, contents] of Object.entries(originalFiles)) assert.equal(fs.readFileSync(file, 'utf8'), contents)
    await go('/video')
    await expect(page.getByRole('button', { name: '从 Hanime 添加', exact: true })).toBeVisible()
    await expect(page.locator('.wall .card')).toHaveCount(0)
    await page.locator('.task-trigger').click()
    assert.ok(!(await page.locator('.task-panel').innerText()).includes('已完成的课程任务'))
    await screenshot('reset-empty-library.png')
  })
  assert.deepEqual(errors, [], 'No renderer exceptions, bridge clone errors or CSP failures')
  const report = { executable, profile, output, checks, layouts, errors, limitations: ['Synthetic media were not played', 'Native file/restore dialogs and restart are controlled in the isolated fixture', '125% Chromium zoom is not a physical display DPI test'] }
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(evidenceRoot, 'latest.json'), JSON.stringify(report, null, 2))
  console.log(`Packaged integration: ${checks.length} passed / 0 failed; evidence: ${output}`)
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    const visual = await page.evaluate(() => ({
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      views: [...document.querySelectorAll('.app > *, .app__view, .detail')].map(element => {
        const style = getComputedStyle(element), rect = element.getBoundingClientRect()
        return { tag: element.tagName, classes: element.className, opacity: style.opacity, display: style.display,
          visibility: style.visibility, transition: style.transition, transform: style.transform,
          width: rect.width, height: rect.height, x: rect.x, y: rect.y, inline: element.getAttribute('style') }
      }),
      animations: document.getAnimations().map(animation => ({ state: animation.playState, time: animation.currentTime,
        target: (animation.effect as KeyframeEffect)?.target?.getAttribute('class'), timing: animation.effect?.getComputedTiming() }))
    })).catch(() => null)
    const windows = await application.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows().map((window: any) => ({
      visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), bounds: window.getBounds(),
      backgroundThrottling: window.webContents.getBackgroundThrottling()
    }))).catch(() => null)
    const frame = await page.evaluate(() => Promise.race([
      new Promise(resolve => requestAnimationFrame(() => resolve('animation frame received'))),
      new Promise(resolve => setTimeout(() => resolve('no animation frame within 1 second'), 1000))
    ])).catch(() => null)
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, layouts, error: String(error), visual, windows, frame, text: await page.locator('body').innerText().catch(() => '') }, null, 2))
  }
  throw error
} finally {
  if (application) {
    await application.evaluate(({ app }: any) => {
      const original = (globalThis as any).__uxFixture?.originals
      if (original) { app.relaunch = original.relaunch; app.exit = original.exit }
    }).catch(() => {})
    await application.close()
  }
}
