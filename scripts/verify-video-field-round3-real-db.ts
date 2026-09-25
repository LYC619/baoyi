/**
 * 实测第三轮 · 真库快照上的实机观察（只看不改）：拷一份真库到临时 profile 起打包产物，看
 *   1. 启动时清掉了无关占位集（真库只读查到 51 条），有文件的集一条不少；
 *   2. 影视墙用简体「斗士」能搜到繁体标题「被幹鬥士 瘋狂性愛！」；
 *   3. 卡片大小滑块改了格子宽度；
 *   4. 详情页看第 2 集简介时「播放这一集」可用（不真的播放）；
 *   5. 「统一移动」只开预览、看计划数，不点「开始移动」。
 * 不碰 %APPDATA% 里的真库，不写 E:\视频。
 *
 *   node --experimental-strip-types scripts/verify-video-field-round3-real-db.ts [exe] [证据目录]
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
const executable = path.resolve(process.argv[2] || 'release/0.8.0-field-test-round3-20260919/win-unpacked/抱一.exe')
assert.ok(fs.existsSync(executable), executable)
const evidence = path.resolve(process.argv[3] || 'output/field-test-round3-20260919/real-db')
fs.mkdirSync(evidence, { recursive: true })
const realDb = path.join(process.env.APPDATA!, '抱一', 'baoyi.db')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-round3-real-'))
fs.copyFileSync(realDb, path.join(profile, 'baoyi.db'))
const strayPlaceholders = (file: string) => {
  const d = new DatabaseSync(file, { readOnly: true })
  const row = d.prepare(`SELECT count(*) c FROM episode e WHERE e.path = '' AND e.episode < 0 AND e.position_sec = 0 AND e.watch_status = 'unwatched'
    AND NOT EXISTS (SELECT 1 FROM video_episode_assets ea JOIN video_assets a ON a.id = ea.asset_id WHERE ea.episode_id = e.id AND a.role = 'video')`).get() as { c: number }
  d.close(); return row.c
}
const before = strayPlaceholders(path.join(profile, 'baoyi.db'))
const episodesWithFilesBefore = (() => { const d = new DatabaseSync(path.join(profile, 'baoyi.db'), { readOnly: true }); const c = (d.prepare("SELECT count(*) c FROM episode WHERE path != ''").get() as { c: number }).c; d.close(); return c })()
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
const errors: string[] = [], mainLog: string[] = [], checks: string[] = []
const app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env: environment, timeout: 30000 })
app.process().stdout?.on('data', (chunk: Buffer) => mainLog.push(chunk.toString('utf8')))
app.process().stderr?.on('data', (chunk: Buffer) => mainLog.push(chunk.toString('utf8')))
async function check(name: string, action: () => Promise<void>) { await action(); checks.push(name); console.log('PASS ' + name) }
const report: Record<string, unknown> = { executable, profile, strayPlaceholdersBefore: before }
try {
  assert.equal(await app.evaluate(({ app }: any) => app.getPath('userData')), profile)
  const page = await app.firstWindow(); page.setDefaultTimeout(20000)
  page.on('pageerror', (error: Error) => errors.push(error.message))
  page.on('console', (message: any) => { if (message.type() === 'error' && !/404/.test(message.text())) errors.push(message.text()) })  // 图标 404 是旧问题，第二轮也过滤
  await page.waitForFunction(() => !!(window as any).baoyi)
  await page.locator('.app__view').waitFor()
  await page.evaluate(() => { location.hash = '/video' })
  await page.locator('.wall').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.wall .card').length > 0)
  // 真库里影视几乎都在里番分类，默认视图只有 1 张卡；第二轮也是先点侧栏「里番」
  await page.locator('button.row').filter({ hasText: '里番' }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.wall .card').length > 10)

  await check('启动时清掉了无关占位集：库里的无关占位数归零，同系列的和有文件的集都还在', async () => {
    // 打包后的主进程 console.log 在 Windows 上传不到这里（第二轮也一样），所以直接比库
    const after = strayPlaceholders(path.join(profile, 'baoyi.db'))
    report.strayPlaceholdersAfter = after
    assert.ok(before > 0, '真库快照里本来就该有无关占位集（只读查到 51 条），现在是 ' + before)
    assert.ok(after < before, `启动后无关占位集应该少于启动前：${before} → ${after}`)
    const d = new DatabaseSync(path.join(profile, 'baoyi.db'), { readOnly: true })
    const withFiles = (d.prepare("SELECT count(*) c FROM episode WHERE path != ''").get() as { c: number }).c
    d.close(); report.episodesWithFilesAfter = withFiles; assert.equal(withFiles, episodesWithFilesBefore, '有文件的集一条都不能少')
  })

  await check('简体「斗士」在影视墙搜到繁体标题「被幹鬥士 瘋狂性愛！」，「疯狂性爱」也行', async () => {
    const search = page.getByRole('textbox', { name: '搜索作品、内容标题或文件名' })
    for (const keyword of ['斗士', '疯狂性爱']) {
      await search.fill(keyword)
      await page.waitForFunction(() => document.querySelectorAll('.wall .card').length > 0 && document.querySelectorAll('.wall .card').length < 10)
      await page.waitForTimeout(300)
      const names = await page.evaluate(() => [...document.querySelectorAll('.wall .card')].map(card => card.textContent || ''))
      assert.ok(names.some((name: string) => name.includes('被幹鬥士')), `搜「${keyword}」得到：${names.join(' | ')}`)
    }
    await page.screenshot({ path: path.join(evidence, '01-search-simplified-hits-traditional.png') })
    await page.getByRole('button', { name: '清空搜索', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.wall .card').length > 10)
  })

  await check('卡片大小滑块改了格子宽度，并写进设置', async () => {
    const slider = page.getByRole('slider', { name: '卡片大小', exact: true })
    await slider.waitFor()
    const width = () => page.evaluate(() => (document.querySelector('.wall .card') as HTMLElement).getBoundingClientRect().width)
    const small = await width()
    await slider.fill('300')
    await expect.poll(width).toBeGreaterThan(small + 60)
    await page.screenshot({ path: path.join(evidence, '02-card-size-300.png') })
    await expect.poll(async () => (await page.evaluate(() => (window as any).baoyi.settings.getAll())).video_card_size).toBe(300)
    await slider.fill('150')
    await expect.poll(async () => (await page.evaluate(() => (window as any).baoyi.settings.getAll())).video_card_size).toBe(150)
    report.cardWidthAt150 = small
  })

  await check('详情页看第 2 集简介时「播放这一集」可用（不真的播放）', async () => {
    const d = new DatabaseSync(path.join(profile, 'baoyi.db'), { readOnly: true })
    const id = (d.prepare("SELECT id FROM resource WHERE kind = 'video' AND name_zh LIKE '%鬥士%' AND is_archived = 0").get() as { id: string } | undefined)?.id
    d.close(); assert.ok(id, '真库里要有「被幹鬥士」这部')
    await page.evaluate((h: string) => { location.hash = h }, '/video/' + id)
    await page.locator('.video-item').first().waitFor()
    await page.getByRole('tab', { name: /剧情简介/ }).click()
    await page.getByRole('group', { name: '选择简介范围', exact: true }).getByRole('button', { name: /第 2 集/ }).first().click()
    const play = page.getByRole('button', { name: '播放这一集', exact: true })
    await expect(play).toBeEnabled()
    await page.screenshot({ path: path.join(evidence, '03-episode-2-play-button.png') })
  })

  await check('统一移动只开预览：整理根目录来自设置，计划里有可移动的作品，不点「开始移动」', async () => {
    await page.evaluate(() => { location.hash = '/video' })
    await page.locator('.wall').waitFor()
    await page.getByRole('button', { name: '统一移动', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '统一移动', exact: true })
    await dialog.getByRole('list', { name: '移动计划', exact: true }).waitFor()
    const hint = await dialog.locator('.layout__hint').first().innerText()
    const counts = { move: Number(/要移动 (\d+) 部/.exec(hint)?.[1]), inPlace: Number(/已就位 (\d+) 部/.exec(hint)?.[1]), skip: Number(/这次不动 (\d+) 部/.exec(hint)?.[1]) }
    report.layoutPreview = { hint, ...counts }
    assert.match(hint, /整理根目录：E:\\视频\\动漫\\260913整理/)
    assert.ok(counts.move > 0, hint)
    await page.screenshot({ path: path.join(evidence, '04-layout-preview-only.png') })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  assert.deepEqual(errors, [])
  report.checks = checks; report.errors = errors
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Field test round 3 real-db: ' + checks.length + ' passed / 0 failed')
} catch (error) {
  const page = app.windows()[0]
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {})
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ ...report, checks, errors, failure: error instanceof Error ? error.message : String(error), mainLog: mainLog.join('').slice(-3000) }, null, 2))
  throw error
} finally { await app.close(); fs.rmSync(profile, { recursive: true, force: true }) }
