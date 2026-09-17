/** Real Vue views with isolated IPC fixtures; native poster delivery is checked separately. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createWorkflowRendererFixture } from './verify-video-workflow-renderer.ts'

const extension = String.raw`
work.name_zh = '影像课堂 0-4'; work.category = '动画'; work.path = 'D:/Fixture/影像课堂 4'
work.tags = Array.from({ length: 36 }, (_, i) => '主题标签' + (i + 1)).concat(['add', 'remove'])
contents.splice(5)
contents.forEach((ep, i) => { ep.episode = i; ep.display_label = ''; ep.title = '影像课堂 ' + i; ep.original_title = 'Original chapter ' + i; ep.description = '第 ' + i + ' 集的独立故事'; if (!i) { ep.path = ''; ep.assets = [] } })
libraries['work-1'].assets = contents.flatMap(ep => ep.assets)
libraries['work-1'].directory.path = work.path
let checks = 0
window.baoyi.video.syncFiles = async id => {
  calls.push(['sync', id]); checks++
  if (checks === 1) { const file = asset('manually-added'); const ep = { ...clone(contents[1]), id: 'new-file', title: '手动放入的视频', original_title: '', episode: -1, path: file.path, assets: [file] }; contents.push(ep); libraries[id].assets.push(file) }
  return { library: clone(libraries[id]), filesAdded: checks === 1 ? 1 : 0, itemsAdded: checks === 1 ? 1 : 0, pathsRepaired: 0, duplicatesMerged: 0, warnings: [], message: '检查完成：新增 ' + (checks === 1 ? 1 : 0) + ' 个视频' }
}
window.baoyi.video.previewCollectionName = async (id, title) => ({ title, from: work.path, to: 'D:/Fixture/' + title })
window.baoyi.video.renameCollection = async (id, title) => { calls.push(['rename', id, title]); const from = work.path; work.name_zh = title; work.path = 'D:/Fixture/' + title; libraries[id].directory.path = work.path; return { title, from, to: work.path, warnings: [] } }
await window.__fixture.videoStore.reload()
`
const fixture = await createWorkflowRendererFixture(extension)
const { page, errors } = fixture
const evidence = path.resolve(process.argv[2] || 'output/video-local-structure-20260912/renderer')
fs.mkdirSync(evidence, { recursive: true })
let passed = 0
async function check(name: string, run: () => Promise<void>) { await run(); passed++; console.log('PASS ' + name) }
try {
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => !!(window as any).__fixture, null, { timeout: 20000 })
  await page.evaluate(() => (window as any).__fixture.router.push({ name: 'video-detail', params: { id: 'work-1' } }))
  await page.locator('.video-item').first().waitFor()
  await page.waitForFunction(() => !document.querySelector('.page-enter-active, .page-leave-active'))
  await check('默认卡片显示第 0 集缺集，已有四集保持可播放', async () => {
    assert.equal(await page.locator('.video-items--cards').count(), 1)
    assert.equal(await page.locator('.video-item').count(), 5)
    const zero = page.locator('.video-item').first()
    assert.match(await zero.innerText(), /第 0 集/)
    assert.match(await zero.innerText(), /尚未下载/)
    assert.equal(await zero.getByRole('button', { name: /^播放/ }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: /^播放：/ }).count(), 5)
    await zero.getByRole('button', { name: '打开第 0 集资料', exact: true }).click()
    assert.match(await page.getByRole('tabpanel', { name: '剧情简介', exact: true }).innerText(), /第 0 集的独立故事/)
    await page.getByRole('tab', { name: /作品内容/ }).click()
  })
  await check('类型紧邻片名，标签显示三行并可展开收起', async () => {
    const title = await page.locator('.hero__title').boundingBox(), type = await page.locator('.hero__title-line .hero__badge').boundingBox()
    assert.ok(title && type && type.x > title.x + title.width && Math.abs(title.y - type.y) < 16)
    assert.equal(await page.locator('.hero__tags').getByText('add', { exact: true }).count(), 0)
    assert.equal(await page.locator('.hero__tags').getByText('remove', { exact: true }).count(), 0)
    const expand = page.getByRole('button', { name: '展开全部标签', exact: true })
    await expand.waitFor()
    const rows = await page.locator('.hero__tags').evaluate((element: HTMLElement) => {
      const bounds = element.getBoundingClientRect()
      return new Set([...element.children].filter(child => child.getBoundingClientRect().bottom <= bounds.bottom + 1).map(child => Math.round(child.getBoundingClientRect().top))).size
    })
    assert.equal(rows, 3)
    await expand.click()
    assert.equal(await page.locator('.hero__tags').evaluate((element: HTMLElement) => element.scrollHeight > element.clientHeight + 1), false)
    await page.getByRole('button', { name: '收起标签', exact: true }).click()
  })
  await check('卡片与列表切换保留缺集和默认版本', async () => {
    await page.getByRole('button', { name: '列表视图', exact: true }).click()
    assert.equal(await page.locator('.video-item__cover').count(), 0)
    assert.match(await page.locator('.video-item').first().innerText(), /第 0 集/)
    await page.getByRole('button', { name: '卡片视图', exact: true }).click()
    assert.equal(await page.locator('.video-item__cover').count(), 5)
  })
  await check('检查文件执行同步并展示新增文件和结果', async () => {
    await page.getByRole('button', { name: '检查文件', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '新增 1 个视频' }).waitFor()
    assert.equal(await page.locator('.video-item').count(), 6)
    assert.match(await page.locator('.video-item').last().innerText(), /未标注集数/)
    assert.equal(await page.evaluate(() => (window as any).__fixture.calls.filter((c: any) => c[0] === 'sync').length), 1)
  })
  await check('更名预览显示当前和目标目录，确认后同步片名', async () => {
    await page.getByLabel('更多作品操作', { exact: true }).click()
    await page.getByRole('button', { name: '修改合集名称', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '修改合集名称', exact: true })
    await dialog.getByLabel('合集名称', { exact: true }).fill('影像课堂 全集 0-4')
    const save = dialog.getByRole('button', { name: '保存名称并更名目录', exact: true })
    await page.waitForFunction(() => !(document.querySelector('.collection-name button[type=submit]') as HTMLButtonElement)?.disabled)
    assert.match(await dialog.innerText(), /影像课堂 4/)
    assert.match(await dialog.innerText(), /影像课堂 全集 0-4/)
    await save.click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.locator('.hero__title').innerText(), '影像课堂 全集 0-4')
  })
  await check('明暗主题与小窗口的卡片、标签和操作无溢出', async () => {
    for (const [width, height] of [[960, 640], [1280, 900]]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height })
      await page.evaluate((value: string) => (window as any).__fixture.setTheme(value), theme)
      assert.equal(await page.locator('.hero').evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth), false)
      assert.equal(await page.locator('.video-items').evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth), false)
      await page.screenshot({ path: path.join(evidence, `cards-${width}-${theme}.png`), animations: 'disabled' })
    }
  })
  assert.deepEqual(errors, [])
} catch (error) { await page.screenshot({ path: path.join(evidence, 'failure.png') }); throw error }
finally { await fixture.close() }
console.log(`Video local-structure UI: ${passed} passed`)
