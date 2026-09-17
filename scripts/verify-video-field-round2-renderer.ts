/** 实测第二轮前端四项（B2 搜索后合集自动展开可收回、B5 下载区置底、B6 正文可选中、B9 批量管理无「下一步」）。
 * 真 Vue 页面 + 内存 IPC 夹具，不启动 Electron、不碰用户资料库。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createWorkflowRendererFixture } from './verify-video-workflow-renderer.ts'

const fixture = await createWorkflowRendererFixture(), { page, errors } = fixture
const evidence = path.resolve(process.argv[2] || 'output/field-test-round2/renderer'); fs.mkdirSync(evidence, { recursive: true })
let passed = 0, failed = 0
async function test(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log('PASS ' + name) }
  catch (e) { failed++; console.error('FAIL ' + name, e instanceof Error ? e.message : e); await page.screenshot({ path: path.join(evidence, 'failed-' + failed + '.png') }) }
}
const episodes = () => page.locator('.collection-episodes button').count()
const search = () => page.getByRole('textbox', { name: '搜索作品、内容标题或文件名' })
async function searched(keyword: string) {
  await search().fill(keyword)
  // 列表按关键词重查回来、且展开逻辑那一轮 IPC 也回来之后再断言，不用固定 sleep 赌运气
  await page.waitForFunction(k => (window as any).__fixture.calls.some((c: any[]) => c[0] === 'list' && c[1].keyword === k), keyword)
  await page.waitForTimeout(250)
}
async function cleared() {
  await page.getByRole('button', { name: '清空搜索', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.work-group').length === 2)
  await page.waitForTimeout(250)
}
try {
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForFunction(() => !!(window as any).__fixture)
  await page.setViewportSize({ width: 1280, height: 900 })
  await test('B2 搜索命中单集的合集自动展开，只命中作品名的不展开，清空后全部收回', async () => {
    assert.equal(await episodes(), 0)
    await searched('光线')
    assert.equal(await episodes(), 1, '关键词命中一集：展开且只列那一集')
    await searched('摄影')
    assert.equal(await episodes(), 0, '只有作品名命中、单集都不命中：不该展开')
    await searched('课程')
    assert.equal(await episodes(), 9, '命中九集')
    await cleared()
    assert.equal(await episodes(), 0, '清空搜索后自动展开的要全部收回')
    assert.equal(await page.getByRole('button', { name: '展开 10 集', exact: true }).count(), 1)
  })
  await test('B2 手动展开的合集在搜索前后保持展开，收起后才收回', async () => {
    await page.getByRole('button', { name: '展开 10 集', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.collection-episodes button').length === 10)
    await searched('光线')
    assert.equal(await episodes(), 1, '手动展开的合集在搜索时只列命中的集')
    await cleared()
    assert.equal(await episodes(), 10, '清空搜索后手动展开的仍然展开、恢复全部集')
    await page.getByRole('button', { name: '收起单集', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.collection-episodes').length === 0)
    await page.screenshot({ path: path.join(evidence, 'b2-collapsed.png') })
  })
  await test('B9 批量管理态没有「下一步」，退出按钮文案区分两种选择态', async () => {
    await page.getByRole('button', { name: '批量管理', exact: true }).click()
    await page.getByRole('region', { name: '批量管理' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).count(), 0, '批量管理不该出现创建合集的「下一步」')
    await page.getByRole('button', { name: '退出批量管理', exact: true }).click()
    await page.getByRole('button', { name: '创建合集', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).count(), 1)
    assert.equal(await page.getByRole('button', { name: '取消选择', exact: true }).count(), 1)
    await page.getByRole('button', { name: '取消选择', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '批量管理', exact: true }).count(), 1)
  })
  await test('B6 正文可以选中，卡片和页签壳子不能', async () => {
    const select = (selector: string) => page.evaluate(s => getComputedStyle(document.querySelector(s)!).userSelect, selector)
    assert.equal(await select('.card'), 'none')
    assert.equal(await select('.search__input'), 'text')
    await page.getByRole('button', { name: /摄影课程/ }).first().click()
    await page.getByRole('tab', { name: '剧情简介', exact: true }).waitFor()
    assert.equal(await select('.detail-tabs'), 'none')
    assert.equal(await select('#video-panel-description'), 'text')
    assert.equal(await select('.hero__title'), 'text')
    await page.evaluate(() => (window as any).__fixture.router.push({ name: 'video-home' }))
    await page.waitForFunction(() => document.querySelectorAll('.work-group').length === 2)
  })
  await test('B5 任务面板：历史再多，下载区固定贴着底栏、自己滚动，不超过 45% 高', async () => {
    await page.evaluate(() => {
      const center = (window as any).__fixture.center
      for (let i = 0; i < 40; i++) center.finish(center.start('software-scan', '历史任务 ' + i), 'success', '完成 ' + i)
    })
    await page.locator('.task-trigger').click()
    const panel = page.locator('.task-panel'); await panel.waitFor()
    await page.waitForFunction(() => document.querySelectorAll('.task-panel__downloads .download-task').length >= 3)
    const layout = await page.evaluate(() => {
      const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect()
      const body = rect('.task-panel__body'), downloads = rect('.task-panel__downloads'), footer = rect('.task-panel__footer'), panel = rect('.task-panel')
      const bodyEl = document.querySelector('.task-panel__body')!
      return { body, downloads, footer, panel, innerHeight: window.innerHeight, bodyScrollable: bodyEl.scrollHeight > bodyEl.clientHeight, history: document.querySelectorAll('.task-panel__body .task-card').length }
    })
    assert.ok(layout.history >= 30, '历史要铺满：' + layout.history)
    assert.ok(layout.bodyScrollable, '任务区自己滚动')
    assert.ok(Math.abs(layout.downloads.bottom - layout.footer.top) < 1, '下载区底边贴着 footer 顶：' + layout.downloads.bottom + ' vs ' + layout.footer.top)
    assert.ok(layout.footer.bottom <= layout.innerHeight + 1, '面板不能超出窗口')
    assert.ok(layout.downloads.height <= layout.innerHeight * 0.45 + 1, '下载区最多 45% 高')
    assert.ok(layout.body.bottom <= layout.downloads.top + 1, '任务区在下载区上方')
    await page.screenshot({ path: path.join(evidence, 'b5-task-panel.png') })
    await page.getByRole('button', { name: '关闭任务面板' }).click()
  })
  assert.deepEqual(errors, [], 'renderer must not throw')
} finally { await fixture.close() }
console.log('Field test round 2 renderer: ' + passed + ' passed / ' + failed + ' failed'); process.exitCode = failed ? 1 : 0
