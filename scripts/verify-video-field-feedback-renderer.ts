/** Field feedback against real Vue routes; only isolated browser/IPC fixtures. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { createWorkflowRendererFixture } from './verify-video-workflow-renderer.ts'

const extension = String.raw`
work.tags = ['摄影', '课程']; work.category = '纪录片'; work.notes = '整部课程的笔记'
contents.forEach((episode, index) => {
  episode.display_label = ''; episode.original_title = 'Original lesson ' + (index + 1)
  episode.description = '仅属于第 ' + (index + 1) + ' 集的独立简介'
  episode.notes = '第 ' + (index + 1) + ' 集的笔记'
})
const loose = { ...asset('loose-file', 'missing'), path: 'D:/Fixture/未归集的花絮.mp4' }
libraries['work-1'].assets.push(loose)
router.addRoute({ path: '/game-fixture', name: 'game-fixture', component: { render: () => h('main', '游戏页面夹具') } })
const prepare = window.baoyi.video.prepareDownload
window.baoyi.video.prepareDownload = async input => {
  const value = await prepare(input)
  if (input.resourceId) {
    value.directoryChange = { from: 'D:/Fixture/Course 4', to: 'D:/Fixture/Course' }
    value.episodes.forEach((episode, i) => { episode.numbered = true; episode.order = i + 1; episode.originalTitle = 'Original lesson ' + (i + 1) })
  }
  return value
}
await window.__fixture.videoStore.reload()
`
const { page, errors, temporary, url, close } = await createWorkflowRendererFixture(extension)
let passed = 0, failed = 0
const route = async (name: string, params = {}) => {
  await page.evaluate(({ name, params }: any) => (window as any).__fixture.router.push({ name, params }), { name, params })
  await page.waitForFunction(() => {
    const view = document.querySelector('.app__view')
    return view && getComputedStyle(view).opacity === '1' && !document.querySelector('.page-enter-active, .page-leave-active')
      && !document.querySelector('.detail__state')?.textContent?.includes('载入中')
  })
}
async function test(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log('PASS ' + name) }
  catch (cause) {
    failed++; console.error('FAIL ' + name + ': ' + (cause instanceof Error ? cause.message.split('\n').slice(0, 4).join(' ') : cause))
    await page.screenshot({ path: path.join(temporary, 'feedback-failure-' + failed + '.png') }).catch(() => {})
  } finally {
    const button = page.getByRole('button', { name: '关闭下载面板', exact: true })
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => {})
  }
}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => !!(window as any).__fixture, null, { timeout: 20000 })
  await test('类型和标签常驻右上角，四个可访问标签页切换内容', async () => {
    await route('video-detail', { id: 'work-1' })
    assert.equal(await page.getByRole('tab').count(), 4)
    assert.equal(await page.getByRole('tab', { name: /作品内容/ }).getAttribute('aria-selected'), 'true')
    const facts = page.getByLabel('作品信息', { exact: true })
    assert.match(await facts.innerText(), /纪录片/)
    assert.match(await facts.innerText(), /摄影/)
    const box = await facts.boundingBox(), title = await page.locator('.hero__text').boundingBox()
    assert.ok(box && title && box.x > title.x && Math.abs(box.y - title.y) < 24)
    await page.getByRole('tab', { name: '文件与资料', exact: true }).click()
    assert.equal(await page.locator('.video-items').isVisible(), false)
    await page.getByRole('heading', { name: '规格', exact: true }).waitFor()
    await page.getByRole('tab', { name: '作品内容', exact: false }).click()
    await page.locator('.video-items').waitFor()
  })
  await test('无季数的第4集显示原名与集数，选集只显示该集简介', async () => {
    await route('video-detail', { id: 'work-1' })
    await page.getByRole('tab', { name: /作品内容/ }).click()
    const row = page.locator('.video-item').filter({ hasText: 'Original lesson 4' })
    assert.match(await row.innerText(), /第 4 集/)
    await row.getByRole('button', { name: '查看第 4 集简介', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: '剧情简介', exact: true })
    assert.match(await panel.innerText(), /仅属于第 4 集的独立简介/)
    assert.ok(!(await panel.innerText()).includes('仅属于第 1 集的独立简介'))
    await panel.getByRole('group', { name: '选择简介范围', exact: true }).getByRole('button',{name:'第 1 集',exact:true}).click()
    assert.match(await panel.innerText(), /仅属于第 1 集的独立简介/)
    assert.ok(!(await panel.innerText()).includes('仅属于第 4 集的独立简介'))
    await page.getByRole('tab', { name: '个人笔记', exact: true }).click()
    const notes = page.getByRole('tabpanel', { name: '个人笔记', exact: true })
    assert.match(await notes.innerText(), /第 1 集的笔记/)
    await notes.getByRole('group', { name: '选择笔记范围', exact: true }).getByRole('button',{name:'作品笔记',exact:true}).click()
    assert.match(await notes.innerText(), /整部课程的笔记/)
  })
  await test('已有剧集时仍展示未归集的真实或缺失文件', async () => {
    await page.getByRole('tab', { name: /作品内容/ }).click()
    const loose = page.locator('.video-item').filter({ hasText: '未归集的花絮.mp4' })
    assert.equal(await loose.count(), 1)
    assert.match(await loose.innerText(), /文件缺失/)
  })
  await test('补齐预览展示目录更名和每集编号，已有内容默认不勾选', async () => {
    await page.getByRole('button', { name: '下载 / 补齐内容', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '补齐作品内容', exact: true })
    await dialog.getByLabel('作品名称', { exact: true }).waitFor()
    assert.match(await dialog.innerText(), /D:\/Fixture\/Course 4/)
    assert.match(await dialog.innerText(), /更名/)
    const local = dialog.locator('.download-contents li').filter({ hasText: '本地已有' })
    assert.match(await local.innerText(), /第 1 集/)
    assert.equal(await local.getByRole('checkbox').isChecked(), false)
  })
  await test('从游戏进入下载作品，返回明确落在影视库并保留筛选', async () => {
    await route('game-fixture')
    await page.evaluate(() => (window as any).__fixture.videoStore.select({ kind: 'type', value: 'series' }))
    await route('video-detail', { id: 'work-1' })
    await page.getByRole('button', { name: '返回影视库', exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).__fixture.router.currentRoute.value.name), 'video-home')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.videoStore.selection), { kind: 'type', value: 'series' })
  })
  await test('小窗口与明暗主题无横向溢出，标签页支持方向键', async () => {
    await route('video-detail', { id: 'work-1' })
    await page.getByRole('button', { name: '列表视图', exact: true }).click()
    for (const [width, height] of [[960, 640], [1280, 900]]) {
      await page.setViewportSize({ width, height })
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value: string) => (window as any).__fixture.setTheme(value), theme)
        assert.equal(await page.locator('.detail').evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth), false)
        assert.equal(await page.locator('.hero').evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth), false)
        const visible = await page.evaluate(() => [...document.querySelectorAll('.video-item')].filter(element => { const rect = element.getBoundingClientRect(); return rect.top > 0 && rect.bottom < innerHeight }).length)
        assert.ok(visible >= 3, 'small view should retain at least three content rows')
        await page.screenshot({ path: path.join(temporary, 'feedback-detail-' + width + '-' + theme + '.png'), animations: 'disabled' })
      }
    }
    const content = page.getByRole('tab', { name: /作品内容/ })
    await content.focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.getByRole('tab', { name: '剧情简介', exact: true }).getAttribute('aria-selected'), 'true')
    await page.keyboard.press('Home')
    assert.equal(await content.getAttribute('aria-selected'), 'true')
  })
  await test('修改默认版本和观看状态后详情页保持可见', async () => {
    await route('video-detail', { id: 'work-1' })
    await page.getByRole('tab', { name: /作品内容/ }).click()
    const row = page.locator('.video-item').first()
    await row.getByRole('combobox').selectOption('alternate')
    await row.getByRole('button', { name: '设为默认', exact: true }).click()
    await page.locator('.video-item').nth(1).getByRole('button', { name: /^标记看过：/ }).click()
    await page.locator('.video-item').nth(3).getByRole('button', { name: /^查看/ }).click()
    await page.waitForFunction(() => {
      const view = document.querySelector('.app__view')
      return document.querySelectorAll('.app__view').length === 1 && view && getComputedStyle(view).opacity === '1'
        && !view.matches('.page-enter-active, .page-leave-active')
    }, null, { timeout: 3000 })
    assert.match(await page.getByRole('tabpanel', { name: '剧情简介', exact: true }).innerText(), /仅属于第 4 集的独立简介/)
    assert.deepEqual(errors, [], 'Updating episode fields must preserve the attached files during rendering')
  })
  assert.deepEqual(errors, [])
} finally { await close() }
console.log(`Video field-feedback UI: ${passed} passed / ${failed} failed; screenshots: ${temporary}`)
if (failed) process.exitCode = 1
