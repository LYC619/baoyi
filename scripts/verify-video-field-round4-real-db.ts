/**
 * 实测第四轮 · 真库快照上的实机观察（只看不改）：拷一份真库（含 WAL）到临时 profile 起打包产物，看
 *   1. 顶栏「日志」入口、角标拆分、四个页签；「下载记录」默认只列待处理，和角标数字对得上；
 *   2. 「整理记录」页签里，用户那部作品的部分完成日志已经对齐到改名后的目录（不再指着消失的长目录）；
 *   3. 「统一移动」预览：那部作品标成「继续上次未完成的整理（1 个文件未搬）」、目标是当前目录；只开预览不点「开始移动」；
 *   4. 影视墙没有「打开 Hanime」「导入确认」「整理记录」按钮；「从 Hanime 添加」面板里有「在 Hanime 里找」（只看不点）。
 * 不碰 %APPDATA% 里的真库，不写 E:\视频。
 *
 *   node scripts/snapshot-live-db.cjs && node --experimental-strip-types scripts/verify-video-field-round4-real-db.ts [exe] [证据目录] [快照库]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const runtime = process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { _electron } = require(runtime), { expect } = require(runtime + '/test')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-field-test-round4-20260922/win-unpacked/抱一.exe')
assert.ok(fs.existsSync(executable), executable)
const evidence = path.resolve(process.argv[3] || 'output/field-test-round4-20260922/real-db')
fs.mkdirSync(evidence, { recursive: true })
const snapshot = path.resolve(process.argv[4] || path.join(os.tmpdir(), 'baoyi-round4-snapshot', 'baoyi.db'))
assert.ok(fs.existsSync(snapshot), '先跑 node scripts/snapshot-live-db.cjs 拍真库快照：' + snapshot)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-round4-real-'))
fs.copyFileSync(snapshot, path.join(profile, 'baoyi.db'))
const NEFER = '944c2c34-766b-4648-8a4e-661cb30776a5', NEFER_JOURNAL = '8f07605e-f5db-4864-b50c-85fc885c7b67'
const readJournal = (file: string) => {
  const d = new DatabaseSync(file, { readOnly: true })
  const row = d.prepare('SELECT status, data FROM video_organize_journal WHERE id = ?').get(NEFER_JOURNAL) as { status: string; data: string }
  const binding = d.prepare('SELECT directory_path FROM video_directories WHERE resource_id = ?').get(NEFER) as { directory_path: string }
  const video = d.prepare("SELECT path FROM video_assets WHERE resource_id = ? AND role = 'video'").get(NEFER) as { path: string }
  d.close()
  const j = JSON.parse(row.data)
  return { status: row.status, target: j.targetDirectory as string, binding: binding.directory_path, video: video.path, warnings: j.warnings as string[],
    files: (j.files as Array<{ status: string; destination: string; error: string }>).map(f => ({ status: f.status, destination: f.destination, error: f.error })) }
}
const before = readJournal(path.join(profile, 'baoyi.db'))
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
const errors: string[] = [], mainLog: string[] = [], checks: string[] = []
const app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env: environment, timeout: 30000 })
app.process().stdout?.on('data', (chunk: Buffer) => mainLog.push(chunk.toString('utf8')))
app.process().stderr?.on('data', (chunk: Buffer) => mainLog.push(chunk.toString('utf8')))
async function check(name: string, action: () => Promise<void>) { await action(); checks.push(name); console.log('PASS ' + name) }
const report: Record<string, unknown> = { executable, profile, snapshot, journalBefore: before }
const eVideoStamp = () => { try { return fs.readdirSync('E:\\视频\\成动漫\\3D').length + ':' + fs.statSync('E:\\视频\\动漫\\0913\\154773').mtimeMs } catch { return 'n/a' } }
const stampBefore = eVideoStamp()
try {
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  const page = await app.firstWindow(); page.setDefaultTimeout(20000)
  page.on('pageerror', (error: Error) => errors.push(error.message))
  page.on('console', (message: any) => { if (message.type() === 'error' && !/404/.test(message.text())) errors.push(message.text()) })
  await page.waitForFunction(() => !!(window as any).baoyi)
  await page.locator('.app__view').waitFor()
  await page.evaluate(() => { location.hash = '/video' })
  await page.locator('.wall').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.wall .card').length > 0)
  await page.locator('button.row').filter({ hasText: '里番' }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.wall .card').length > 10)

  await check('影视墙：没有「打开 Hanime」「导入确认」「整理记录」；「从 Hanime 添加」面板里有「在 Hanime 里找」', async () => {
    for (const name of ['打开 Hanime', '导入确认', '整理记录']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, name)
    await page.getByRole('button', { name: '从 Hanime 添加', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '从 Hanime 添加作品', exact: true })
    await expect(dialog.getByRole('button', { name: '在 Hanime 里找', exact: true })).toBeEnabled()
    await page.screenshot({ path: path.join(evidence, '01-add-from-hanime.png') })
    await dialog.getByRole('button', { name: '关闭下载面板', exact: true }).click()
  })

  await check('顶栏「日志」：角标 = 下载待处理 + 任务失败，悬停有拆分；「下载记录」默认只列待处理，条数和角标一致', async () => {
    const trigger = page.locator('.task-trigger')
    await expect(trigger).toContainText('日志')
    const badge = trigger.locator('.task-trigger__failed')
    const count = Number(await badge.innerText())
    const title = await badge.getAttribute('title')
    report.badge = { count, title }
    assert.ok(count > 0 && /个下载待处理/.test(title || ''), JSON.stringify(report.badge))
    await trigger.click()
    const panel = page.getByRole('dialog', { name: '日志', exact: true })
    await expect(panel.locator('.task-tabs button')).toHaveCount(4)
    await panel.locator('.task-tabs').getByRole('button', { name: /^下载记录/ }).click()
    await expect.poll(() => panel.locator('.download-task').count()).toBe(count)
    assert.ok((await panel.locator('.download-task').first().innerText()).includes('移除记录'))
    await page.screenshot({ path: path.join(evidence, '02-log-panel-downloads.png') })
    await panel.locator('.task-filter select').selectOption('all')
    await expect.poll(() => panel.locator('.download-task').count()).toBeGreaterThan(count)
    report.downloads = { attention: count, all: await panel.locator('.download-task').count() }
  })

  await check('「整理记录」页签：那部作品的部分完成日志已对齐到改名后的目录，带说明；没有点重试或回退', async () => {
    const panel = page.getByRole('dialog', { name: '日志', exact: true })
    await panel.locator('.task-tabs').getByRole('button', { name: /^整理记录/ }).click()
    await panel.locator(`[data-journal="${NEFER_JOURNAL}"]`).waitFor()
    const card = panel.locator(`[data-journal="${NEFER_JOURNAL}"]`)
    const text = await card.innerText()
    assert.match(text, /部分完成/)
    assert.match(text, /已按新目录对齐/)
    assert.ok(text.includes(before.binding), '卡片上的目标目录是现在的绑定目录')
    // 对齐说明里会写「从 <旧目录> 移到 <新目录>」，旧目录名出现在那一句里是对的；路径行（目标 / 源 / →）里不能再有
    const paths = await card.locator('.organize-path').allInnerTexts()
    assert.ok(paths.length > 0 && paths.every((line: string) => !line.includes('27261ee4')), '路径行里不再有消失的长目录：' + paths.join(' | '))
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(evidence, '03-organize-journal-healed.png') })
    const after = readJournal(path.join(profile, 'baoyi.db'))
    report.journalAfter = after
    assert.equal(after.status, 'partial')
    assert.equal(after.target, before.binding)
    assert.ok(after.files.every(f => f.destination.startsWith(before.binding + path.sep) && f.destination.length <= 240), JSON.stringify(after.files))
    assert.equal(after.video, before.video, '视频路径没动（只看不改）')
    await panel.getByRole('button', { name: '关闭日志面板', exact: true }).click()
  })

  await check('「统一移动」预览：那部作品标为「继续上次未完成的整理」、目标是当前目录；只开预览不点「开始移动」', async () => {
    await page.getByRole('button', { name: '统一移动', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '统一移动', exact: true })
    await dialog.getByRole('list', { name: '移动计划', exact: true }).waitFor()
    const hint = await dialog.locator('.layout__hint').first().innerText()
    const rows: Array<{ cls: string; text: string }> = await dialog.locator('.layout__list > li').evaluateAll((items: Element[]) => items.map(item => ({ cls: item.className, text: (item.textContent || '').replace(/\s+/g, ' ').trim() })))
    const nefer = rows.find(row => row.text.includes('奈芙爾'))
    report.layoutPreview = { hint, rows: rows.length, nefer, actions: rows.reduce((acc: Record<string, number>, row) => { const key = row.cls.replace('layout__row--', ''); acc[key] = (acc[key] || 0) + 1; return acc }, {}) }
    assert.ok(nefer, '计划里要有那部作品：' + rows.map(r => r.text.slice(0, 40)).join(' | '))
    assert.match(nefer!.cls, /move-files/)
    const left = before.files.filter(f => f.status === 'failed' || f.status === 'pending').length
    assert.match(nefer!.text, new RegExp('继续上次未完成的整理（' + left + ' 个文件未搬）'))
    assert.ok(nefer!.text.includes(before.binding), nefer!.text)
    await dialog.locator('.layout__list > li').filter({ hasText: '奈芙爾' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(evidence, '04-layout-preview-nefer.png') })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  assert.deepEqual(errors, [])
  assert.equal(eVideoStamp(), stampBefore, 'E:\\视频 里的目录没被动过')
  report.checks = checks; report.errors = errors
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Field test round 4 real-db: ' + checks.length + ' passed / 0 failed')
} catch (error) {
  const page = app.windows()[0]
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {})
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ ...report, checks, errors, failure: error instanceof Error ? error.message : String(error), mainLog: mainLog.join('').slice(-3000) }, null, 2))
  throw error
} finally { await app.close(); fs.rmSync(profile, { recursive: true, force: true }) }
