import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createWorkflowRendererFixture } from './verify-video-workflow-renderer.ts'
import { pngImage } from './helpers/test-images.ts'

const extension = String.raw`
single.episode_total = 1
const singleEpisode = { ...clone(contents[0]), id: 'single-episode', resource_id: single.id, title: '独立单集', original_title: 'Original episode', path: single.path,
  published_at: Date.UTC(2026, 5, 4), air_date: Date.UTC(2024, 0, 2), studio: '测试厂牌', duration_sec: 975,
  description: ('这段简介用于检查图文排版。画面与文字应并排展示，读者可以直接看到标题、日期和剧情，标签放在下方。\n\n').repeat(3),
  tags: ['单集标签一', '单集标签二'], poster_path: 'D:/Fixture/portrait.png', thumbnail_path: 'D:/Fixture/landscape.png', sources: [], assets: libraries.single.assets }
libraries.single.contents = [singleEpisode]
const identifyLog = { id: 'import-log', dir: 'D:/Fixture/import', label: '导入识别示例', kind: 'item', resource_kind: 'video', status: 'success', summary: '来源资料已写入单集', registered: 1, rounds: 1, duration_ms: 12, tokens: 25, stop_reason: '', events: [{type:'tool_call', name:'hanime_detail',args:{id:'800001'},round:1},{type:'tool_result',name:'hanime_detail',text:'站点发布日期：2026-06-04',round:1}],created_at:0 }
window.baoyi.logs = { list: async query => {calls.push(['logs',query]);return [clone(identifyLog)]}, reports:async()=>[] }
window.baoyi.video.importBundle = async () => { identifyLog.created_at=Date.now();progressListeners.forEach(cb=>cb({phase:'identifying',current:identifyLog.dir,processed:1,total:1,registered:1,failed:0,log:'来源资料已识别'}));return {resourceId:single.id,itemsAdded:1,filesAdded:1,created:false,bundleId:'',scanResult:{candidates:1,registered:1,skipped:0,failed:0,episodes:1,tokens:25,searches:0,entries:[{path:single.path,resourceId:single.id,status:'updated',message:'已更新资料'}]}} }
draft.episodes.push({videoCode:'204',title:'独立条目的第二集',order:5,state:'other-work',resourceId:'another-work',qualities:[]})
await window.__fixture.videoStore.reload()
`
const fixture = await createWorkflowRendererFixture(extension)
const { page, errors } = fixture
const evidence = path.resolve(process.argv[2] || 'output/video-field-retest-20260913/renderer')
fs.mkdirSync(evidence, { recursive: true })
let passed = 0, failed = 0
async function test(name: string, run: () => Promise<void>) {
  try { await run(); passed++ }
  catch (cause) { failed++; console.error('FAIL ' + name + ': ' + (cause instanceof Error ? cause.message : cause)); await page.screenshot({ path: path.join(evidence, 'failure-' + failed + '.png') }) }
  finally { for (const name of ['关闭日志面板', '关闭下载面板']) { const button = page.getByRole('button', { name, exact: true }); if (await button.isVisible().catch(() => false)) { await button.click(); await button.waitFor({ state: 'hidden' }) } } }
}
async function route(name: string, params = {}) {
  await page.evaluate(({ name, params }: any) => (window as any).__fixture.router.push({ name, params }), { name, params })
  await page.waitForFunction(() => !document.querySelector('.page-enter-active,.page-leave-active') && !document.querySelector('.detail__state')?.textContent?.includes('载入中'))
}
try {
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForFunction(() => !!(window as any).__fixture)
  await test('single-video detail shows dates without selecting an episode', async () => {
    await route('video-detail', { id: 'single' })
    assert.match(await page.locator('.hero__meta').innerText(), /站点发布.*2026-06-04/)
    assert.match(await page.locator('.hero__meta').innerText(), /发行.*2024-01-02/)
    await page.getByRole('tab', { name: '剧情简介', exact: true }).click()
    const scope = page.getByRole('group', {name:'选择简介范围',exact:true})
    assert.equal(await scope.getByRole('button',{name:'第 1 集',exact:true}).getAttribute('aria-pressed'), 'true')
    await scope.getByRole('button',{name:'作品简介',exact:true}).click()
    await page.getByRole('tab', { name: /作品内容/ }).click()
    await page.getByRole('button', { name: '检查文件', exact: true }).click()
    await page.getByRole('tab', { name: '剧情简介', exact: true }).click()
    assert.equal(await scope.getByRole('button',{name:'作品简介',exact:true}).getAttribute('aria-pressed'), 'true', 'refreshing files preserves a manually selected work scope')
  })
  await test('episode artwork sits left of the introduction with tags below both columns', async () => {
    await route('video-detail', { id: 'single' })
    await page.getByRole('tab', { name: '剧情简介', exact: true }).click()
    await page.getByRole('group',{name:'选择简介范围',exact:true}).getByRole('button',{name:'第 1 集',exact:true}).click()
    const images = [pngImage(180, 270), pngImage(320, 180)].map(bytes => 'data:image/png;base64,' + bytes.toString('base64'))
    await page.locator('.episode-artwork img').evaluateAll((elements: HTMLImageElement[], values: string[]) => elements.forEach((img, index) => { img.src = values[index] }), images)
    for (const width of [1280, 960]) {
      await page.setViewportSize({ width, height: 1000 })
      const layout = await page.evaluate(() => {
        const box = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
        return { art: box('.episode-artwork'), text: box('#video-panel-description .read-text'), tags: box('#video-panel-description .tags'), overflow: document.documentElement.scrollWidth > innerWidth }
      })
      assert.ok(layout.text.x >= layout.art.x + layout.art.width, 'the introduction belongs beside the artwork')
      assert.ok(layout.text.y < layout.art.y + layout.art.height, 'the introduction is visible before the bottom of the artwork')
      assert.ok(layout.tags.y >= Math.max(layout.art.y + layout.art.height, layout.text.y + layout.text.height) - 1, 'tags follow the image and text')
      assert.equal(layout.overflow, false)
      await page.screenshot({ path: path.join(evidence, 'episode-layout-' + width + '.png'), fullPage: true })
    }
  })
  await test('import has scoped identify logs and finished downloads stay collapsed after task history', async () => {
    await route('video-home')
    await page.getByRole('button', { name: '导入目录', exact: true }).click()
    await page.getByRole('button', { name: /^日志：/ }).click()
    const panel = page.getByRole('dialog', { name: '日志' })
    const task = panel.locator('.task-card').filter({ has: page.getByRole('heading', { name: '影视目录导入', exact: true }) })
    await task.getByText('查看识别日志', { exact: true }).click()
    await task.getByRole('button', { name: /导入识别示例/ }).click()
    assert.match(await task.innerText(), /站点发布日期：2026-06-04/)
    // 下载记录不再和任务挤在一起：任务页签里没有下载卡片，切到「下载记录」才有
    assert.equal(await panel.locator('.download-task').count(), 0)
    await panel.locator('.task-tabs').getByRole('button', { name: /^下载记录/ }).click()
    assert.equal(await panel.locator('.download-task').first().isVisible(), true)
    await page.screenshot({ path: path.join(evidence, 'task-import-logs.png') })
  })
  await test('independent playlist entries are displayed without becoming selectable', async () => {
    await route('video-home')
    await page.getByRole('button', { name: /从 Hanime 添加/ }).click()
    const dialog = page.getByRole('dialog', { name: '从 Hanime 添加作品' })
    await dialog.getByLabel('来源页面链接').fill('https://hanime1.me/watch?v=200')
    await dialog.getByRole('button', { name: '解析链接', exact: true }).click()
    const other = dialog.locator('label').filter({ hasText: '独立条目的第二集' }).getByRole('checkbox')
    assert.equal(await other.isDisabled(), true)
    assert.equal(await other.isChecked(), false)
    assert.match(await dialog.innerText(), /已在其他作品/)
  })
  assert.deepEqual(errors, [], 'renderer must not throw')
} finally { await fixture.close() }
console.log(`Video field retest renderer: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
