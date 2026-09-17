/** W7 against actual Vue pages in an isolated browser. All operations are fixtures. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { createWorkflowRendererFixture } from './verify-video-workflow-renderer.ts'

const extension = String.raw`
const org = { calls: [], flavor: 'normal', staleNext: false, serial: 0, pickValue: 'E:/Fixture/整理目录', histories: [], holdPreview: false, resolvePreview: null }
const catalog = [work, single, secret, ...Array.from({ length: 6 }, (_, i) => ({ ...single, id: 'extra-' + i, name_zh: '本地作品 ' + (i + 1) }))]
work.notes = '主作品的原笔记'; single.notes = '源作品的笔记\n第二行也要保留'
window.baoyi.video.list = async query => clone(catalog.filter(w => query.type === 'hentai' ? w.category === '里番' : w.category !== '里番'))
window.baoyi.video.get = async id => clone(catalog.find(w => w.id === id) || null)
const log = (name, request) => org.calls.push([name, clone(request ?? null)])
const filePlan = (id, target) => ({ id, resourceIds: [id === 'file-a' ? work.id : single.id], assetIds: [id], episodeIds: ['episode-' + id], source: 'D:/Fixture/' + (id === 'file-a' ? '原片.mp4' : '补录.mp4'), destination: target ? target + '/' + (id === 'file-a' ? '原片.mp4' : '补录.mp4') : '', relativePath: id === 'file-a' ? '原片.mp4' : '补录.mp4', size: 1024, state: 'present', action: target ? 'copy' : 'none' })
const plan = request => {
  const selected = request.resourceIds.map(id => catalog.find(w => w.id === id))
  const target = org.flavor === 'logical-only' ? '' : request.targetDirectory || 'E:/Fixture/整理目录'
  const files = [filePlan('file-a', target), filePlan('file-b', target)].map(file => request.fileNames?.[file.id] ? { ...file, relativePath: request.fileNames[file.id], destination: target + '/' + request.fileNames[file.id] } : file)
  const works = selected.map(w => ({ resourceId: w.id, name: w.name_zh, path: w.path, notes: w.notes, archived: false, watchStatus: 'watching', positionSec: 83, directory: null, fileIds: files.filter(file => file.resourceIds.includes(w.id)).map(file => file.id) }))
  const collisions = org.flavor === 'logical-only' ? [{ code: 'directory-conflict', scope: 'physical', message: '物理目录暂不可用，仍可逻辑合并' }]
    : org.flavor === 'episode-conflict' && !request.episodeNumbers?.['content-1'] ? [{ code: 'episode-slot', scope: 'logical', message: '季 1 / 集 1 同时属于多个内容项；保留编号，未自动改序' }]
    : org.flavor === 'file-conflict' && !request.fileNames?.['file-b'] ? [{ code: 'destination-exists', scope: 'file', fileId: 'file-b', path: files[1].destination, message: '目标文件已存在，不会覆盖' }] : []
  return { kind: 'organize', request: clone(request), fingerprint: 'fixture-' + (++org.serial), works, survivor: works.find(w => w.resourceId === request.survivorId), targetDirectory: target, root: 'E:/Fixture', bundleId: 'fixture-bundle',
    episodes: works.map((w, i) => ({ id: 'content-' + i, resourceId: w.resourceId, title: '原始内容 ' + i, season: 1, episode: request.episodeNumbers?.['content-' + i]?.episode || (org.flavor === 'episode-conflict' ? 1 : i + 1), generated: false, fileIds: [files[i]?.id] })), files, collisions,
    warnings: ['源作品保留为归档记录；复制后仍保留原文件，回滚也不会删除副本'], canMerge: !collisions.some(c => c.scope === 'logical'), canOrganize: !collisions.some(c => c.scope === 'logical') && !!target }
}
const result = (preview, mode) => ({ id: 'journal-' + (++org.serial), kind: preview.kind, mode, status: mode === 'physical' ? 'partial' : 'applied', survivorId: preview.kind === 'organize' ? preview.request.survivorId : preview.resourceId,
  sourceIds: preview.kind === 'organize' ? preview.request.resourceIds : [preview.resourceId], createdAt: Date.now(), updatedAt: Date.now(), targetDirectory: preview.targetDirectory,
  files: preview.files.map((file, i) => ({ ...file, status: mode === 'logical' ? 'unchanged' : mode === 'physical' && i ? 'failed' : 'switched', error: mode === 'physical' && i ? '目标已存在，未覆盖，原文件保留' : '', attempts: 1, sha256: '', originalRetained: true })), warnings: [], conflicts: [], canRetry: mode === 'physical', canRollback: true })
const keep = journal => { org.histories = [clone(journal), ...org.histories.filter(j => j.id !== journal.id)]; changed(journal.survivorId); return clone(journal) }
const privateHistory = { id: 'private-history', kind: 'organize', mode: 'physical', status: 'partial', survivorId: work.id, sourceIds: [work.id, secret.id], createdAt: 1, updatedAt: 1, targetDirectory: 'D:/Private/隐私整理路径', files: [{ ...filePlan('file-a', 'D:/Private/隐私整理路径'), source: 'D:/Private/私密原件.mp4', resourceIds: [secret.id], status: 'failed', error: '私密错误内容', attempts: 1, sha256: '', originalRetained: true }], warnings: [], conflicts: [], canRetry: true, canRollback: true }
window.baoyi.videoOrganize = {
  preview: async request => { log('preview', request); const value = plan(request); if (org.holdPreview) return new Promise(resolve => { org.resolvePreview = () => resolve(value) }); return clone(value) },
  apply: async request => { log('apply', request); if (org.staleNext) { org.staleNext = false; throw new Error('资料或实际路径已变化，请重新预览') } return keep(result(request.preview, request.mode)) },
  retry: async id => { log('retry', id); const journal = org.histories.find(j => j.id === id); return keep({ ...journal, status: 'applied', canRetry: false, updatedAt: Date.now(), files: journal.files.map(file => ({ ...file, status: 'switched', error: '', attempts: file.attempts + (file.status === 'failed' ? 1 : 0) })) }) },
  rollback: async id => { log('rollback', id); const journal = org.histories.find(j => j.id === id); return keep({ ...journal, status: 'rollback-partial', canRetry: false, updatedAt: Date.now(), conflicts: ['后续笔记已变化，保留用户修改；副本继续保留'], files: journal.files.map(file => ({ ...file, status: 'retained' })) }) },
  list: async id => { log('list', id); return clone([...org.histories, privateHistory].filter(j => !id || j.sourceIds.includes(id))) },
  pickDirectory: async () => { log('pickDirectory'); return org.pickValue },
  previewRelocate: async request => { log('previewRelocate', request); return { kind: 'relocate', request: clone(request), fingerprint: 'relocate-' + (++org.serial), resourceId: work.id, name: work.name_zh, sourceDirectory: work.path, targetDirectory: request.directory, root: 'E:/Fixture', bundleId: 'fixture-bundle', directories: ['Subs', 'Empty'], files: [{ ...filePlan('file-a', request.directory), source: work.path + '/原片.mp4', action: request.mode === 'copy' ? 'copy' : 'verify' }], collisions: [], warnings: ['所有原文件保留'], canApply: true } },
  relocate: async request => { log('relocate', request); return keep(result(request.preview, request.preview.request.mode)) }
}
window.__fixture.organize = org
await window.__fixture.videoStore.reload()
`
const { page, errors, temporary, url, close } = await createWorkflowRendererFixture(extension)
let passed = 0, failed = 0
const dialog = () => page.getByRole('dialog').filter({ has: page.locator('.organize-panel__head') })
const route = async (name: string, params = {}) => {
  await page.evaluate(({ name, params }: any) => (window as any).__fixture.router.push({ name, params }), { name, params })
  await page.waitForFunction(() => {
    const view = document.querySelector('.app__view')
    return view && getComputedStyle(view).opacity === '1' && !document.querySelector('.page-enter-active, .page-leave-active')
      && !document.querySelector('.detail__state')?.textContent?.includes('载入中')
  })
}
async function selectPair(flavor = 'normal') {
  await route('video-home')
  await page.evaluate((flavor: string) => {
    const f = (window as any).__fixture
    f.setHidden(false); f.organize.flavor = flavor; f.organize.calls = []
    f.videoStore.select({ kind: 'group', value: 'all' })
  }, flavor)
  const cancel = page.getByRole('button', { name: '取消选择', exact: true })
  if (await cancel.isVisible()) await cancel.click()
  await page.getByRole('button', { name: '创建合集', exact: true }).click()
  await page.getByRole('button', { name: /^选择作品：摄影课程/ }).click()
  await page.getByRole('button', { name: '选择作品：单视频作品', exact: true }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await dialog().waitFor()
}
async function ready() {
  await page.waitForFunction(() => document.querySelector('.organize-preview') && document.querySelector('.organize-panel__body')?.getAttribute('aria-busy') === 'false' && !document.querySelector('[data-preview-stale="true"]'))
}
async function previewRelocate() {
  await dialog().getByRole('button', { name: /^(生成|重新)预览$/ }).click()
  await ready()
}
async function copyMode() {
  await dialog().locator('summary').filter({ hasText: '文件整理（可选）' }).click()
  await dialog().getByRole('checkbox', { name: '同时整理文件到统一目录', exact: true }).check()
  await ready()
}
async function test(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log('PASS ' + name) }
  catch (cause) {
    failed++; console.error('FAIL ' + name + ': ' + (cause instanceof Error ? cause.message.split('\n').slice(0, 4).join(' ') : cause))
    await page.screenshot({ path: path.join(temporary, 'organize-failure-' + failed + '.png') }).catch(() => {})
  } finally {
    const button = page.getByRole('button', { name: '关闭整理面板', exact: true })
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => {})
    await page.evaluate(() => { const org = (window as any).__fixture.organize; org.holdPreview = false; org.resolvePreview?.(); org.resolvePreview = null }).catch(() => {})
  }
}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => !!(window as any).__fixture?.organize, null, { timeout: 20000 })
  await test('选完作品自动预览，默认只有创建合集，无文件路径表单或自动执行', async () => {
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.organize.calls), [])
    await selectPair('logical-only')
    await ready()
    assert.equal(await dialog().getByRole('textbox', { name: '合集名称', exact: true }).isVisible(), true)
    assert.equal(await dialog().getByRole('button', { name: '创建合集', exact: true }).isEnabled(), true)
    assert.equal(await dialog().getByRole('button', { name: '生成预览', exact: true }).count(), 0)
    assert.equal(await dialog().getByRole('textbox', { name: /整理目标目录/ }).isVisible(), false)
    assert.equal(await dialog().getByRole('button', { name: /仅逻辑合并|复制并整理/ }).count(), 0)
    const calls = await page.evaluate(() => (window as any).__fixture.organize.calls)
    assert.equal(calls.filter((call: any[]) => call[0] === 'preview').length, 1)
    assert.equal(calls.filter((call: any[]) => call[0] === 'apply').length, 0)
  })
  await test('名称和集数直接编辑，自动核对后提交，不要求目录', async () => {
    await selectPair('logical-only'); await ready()
    await dialog().getByRole('textbox', { name: '合集名称', exact: true }).fill('摄影完整合集')
    await dialog().getByRole('spinbutton', { name: '原始内容 1 的集数', exact: true }).fill('4')
    await ready()
    await dialog().getByRole('button', { name: '创建合集', exact: true }).click()
    await dialog().getByRole('heading', { name: '本次结果与历史' }).waitFor()
    const call = await page.evaluate(() => (window as any).__fixture.organize.calls.find((c: any[]) => c[0] === 'apply'))
    assert.equal(call[1].mode, 'logical')
    assert.equal(call[1].preview.request.collectionTitle, '摄影完整合集')
    assert.deepEqual(call[1].preview.request.episodeNumbers['content-1'], { season: 1, episode: 4 })
    assert.equal(call[1].preview.request.targetDirectory, undefined)
    assert.equal(await page.evaluate(() => (window as any).__fixture.organize.calls.filter((c: any[]) => c[0] === 'list').length), 0)
  })
  await test('加入已有合集明确选择保留的作品，原资料和笔记可展开核对', async () => {
    await selectPair('logical-only'); await ready()
    await dialog().getByRole('radio', { name: '加入已有合集', exact: true }).check()
    await dialog().getByRole('combobox', { name: '加入哪个合集', exact: true }).selectOption('work-1')
    await ready()
    await dialog().locator('summary').filter({ hasText: '查看原作品与笔记' }).click()
    for (const text of ['主作品的原笔记', '源作品的笔记', '第二行也要保留']) assert.ok((await dialog().innerText()).includes(text), text)
    await dialog().getByRole('button', { name: '加入合集', exact: true }).click()
    await dialog().locator('.organize-journal').waitFor()
    const call = await page.evaluate(() => (window as any).__fixture.organize.calls.find((c: any[]) => c[0] === 'apply'))
    assert.equal(call[1].preview.request.survivorId, 'work-1')
    assert.equal(call[1].preview.request.collectionTitle, undefined, 'joining must retain the existing collection description/title')
  })
  await test('复制文件是显式选项，逐项失败、重试和回退保留用户修改', async () => {
    await selectPair('file-conflict'); await ready(); await copyMode()
    assert.match(await dialog().getByLabel('整理冲突').innerText(), /目标文件已存在，不会覆盖/)
    await dialog().getByRole('button', { name: '创建合集并复制文件', exact: true }).click()
    const result = dialog().locator('.organize-journal').first()
    await result.waitFor()
    assert.match(await result.innerText(), /部分完成/)
    assert.match(await result.innerText(), /目标已存在，未覆盖/)
    assert.equal(await result.locator('[data-file]').count(), 2)
    await result.getByRole('button', { name: '重试未完成项', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.organize-journal__status')?.textContent === '已完成')
    await result.getByRole('button', { name: '回退本次操作', exact: true }).click()
    await result.getByLabel('回退与恢复冲突').waitFor()
    assert.match(await result.innerText(), /保留用户修改/)
  })
  await test('修改文件名立即锁定旧预览，自动核对后提交精确路径', async () => {
    await selectPair('file-conflict'); await ready(); await copyMode()
    await dialog().getByRole('textbox', { name: '目标相对路径：补录.mp4', exact: true }).fill('Extras/手动命名.mp4')
    assert.equal(await dialog().getByRole('button', { name: '创建合集并复制文件', exact: true }).isDisabled(), true)
    await ready()
    const request = await page.evaluate(() => (window as any).__fixture.organize.calls.filter((call: any[]) => call[0] === 'preview').at(-1)[1])
    assert.equal(request.fileNames['file-b'], 'Extras/手动命名.mp4')
    assert.equal(await dialog().getByLabel('整理冲突').count(), 0)
    assert.equal(await page.evaluate(() => (window as any).__fixture.organize.calls.filter((c: any[]) => c[0] === 'apply').length), 0)
  })
  await test('重复季集阻止执行，允许直接修正编号后继续', async () => {
    await selectPair('episode-conflict'); await ready()
    assert.equal(await dialog().getByRole('button', { name: '创建合集', exact: true }).isDisabled(), true)
    await dialog().getByRole('spinbutton', { name: '原始内容 1 的集数', exact: true }).fill('2')
    await ready()
    assert.equal(await dialog().getByRole('button', { name: '创建合集', exact: true }).isEnabled(), true)
  })
  await test('提交时资料变化显示错误；再次核对不会自动重试写入', async () => {
    await selectPair(); await ready()
    await page.evaluate(() => { (window as any).__fixture.organize.staleNext = true })
    await dialog().getByRole('button', { name: '创建合集', exact: true }).click()
    await dialog().getByRole('alert').waitFor()
    assert.match(await dialog().getByRole('alert').innerText(), /资料或实际路径已变化/)
    assert.equal(await dialog().getByRole('button', { name: '创建合集', exact: true }).isDisabled(), true)
    await dialog().getByRole('button', { name: '重新预览', exact: true }).click()
    await ready()
    assert.equal(await dialog().getByRole('button', { name: '创建合集', exact: true }).isEnabled(), true)
    assert.equal(await page.evaluate(() => (window as any).__fixture.organize.calls.filter((c: any[]) => c[0] === 'apply').length), 1)
  })
  await test('历史涉及任一隐藏作品就隐藏整条，标题、路径、错误与计数同步清除', async () => {
    await route('video-home')
    const cancel = page.getByRole('button', { name: '取消选择', exact: true })
    if (await cancel.isVisible()) await cancel.click()
    await page.getByRole('button', { name: '整理记录', exact: true }).click()
    await dialog().locator('[data-journal="private-history"]').waitFor()
    await page.evaluate(() => (window as any).__fixture.setHidden(true))
    await page.waitForFunction(() => !document.querySelector('.organize-panel')?.textContent?.includes('隐私整理路径'))
    assert.equal(await dialog().locator('.organize-journal').count(), 0)
    await dialog().getByRole('button', { name: '刷新记录', exact: true }).click()
    await page.waitForFunction(() => !!document.querySelector('.organize-journal'))
    assert.equal(await dialog().locator('[data-journal="private-history"]').count(), 0)
    assert.ok(!/隐私整理路径|私密原件|私密错误内容/.test(await dialog().innerText()))
    await page.evaluate(() => (window as any).__fixture.setHidden(false))
  })
  await test('隐藏开关清空预览和私密选择，不自动保留标题或编号', async () => {
    await route('video-home')
    await page.evaluate(() => (window as any).__fixture.videoStore.select({ kind: 'type', value: 'hentai' }))
    await page.getByRole('button', { name: '创建合集', exact: true }).click()
    await page.getByRole('button', { name: '选择作品：隐藏作品名称', exact: true }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await ready()
    await page.evaluate(() => (window as any).__fixture.setHidden(true))
    assert.ok(!(await dialog().innerText()).includes('隐藏作品名称'))
    assert.equal(await dialog().getByRole('textbox', { name: '合集名称', exact: true }).inputValue(), '')
    assert.equal(await dialog().getByRole('button', { name: '创建合集', exact: true }).isDisabled(), true)
    await dialog().getByRole('button', { name: '关闭整理面板', exact: true }).click()
    assert.match(await page.locator('.library-summary').innerText(), /已选 0 部作品/)
    await page.evaluate(() => (window as any).__fixture.setHidden(false))
  })
  await test('目录迁移仍需明确预览和确认，切换复制方式后旧预览失效', async () => {
    await route('video-detail', { id: 'work-1' })
    await page.getByLabel('更多作品操作', { exact: true }).click()
    await page.getByRole('button', { name: '目录管理 / 重新绑定', exact: true }).click()
    await dialog().getByRole('textbox', { name: /新作品目录/ }).fill('E:/Fixture/已移动作品')
    await previewRelocate()
    assert.equal(await dialog().getByRole('button', { name: '确认重新绑定', exact: true }).isEnabled(), true)
    await dialog().getByRole('radio', { name: '复制整目录（保留原件）', exact: true }).check()
    assert.equal(await dialog().getByRole('button', { name: '确认复制整目录', exact: true }).isDisabled(), true)
    await previewRelocate()
    await dialog().getByRole('button', { name: '确认复制整目录', exact: true }).click()
    await dialog().locator('.organize-journal').waitFor()
    const call = await page.evaluate(() => (window as any).__fixture.organize.calls.filter((c: any[]) => c[0] === 'relocate').at(-1))
    assert.equal(call[1].preview.request.mode, 'copy')
    assert.equal(call[1].preview.request.directory, 'E:/Fixture/已移动作品')
    await dialog().getByRole('button', { name: '整理记录', exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).__fixture.organize.calls.filter((c: any[]) => c[0] === 'list').at(-1)[1]), 'work-1')
  })
  await test('自动预览未返回时可关闭，迟到结果不恢复面板或执行', async () => {
    await selectPair(); await ready()
    await page.evaluate(() => { (window as any).__fixture.organize.holdPreview = true })
    await dialog().getByRole('textbox', { name: '合集名称', exact: true }).fill('迟到的预览')
    await page.waitForFunction(() => !!(window as any).__fixture.organize.resolvePreview)
    await page.keyboard.press('Escape')
    assert.equal(await dialog().count(), 0)
    await page.evaluate(() => { const org = (window as any).__fixture.organize; org.holdPreview = false; org.resolvePreview() })
    assert.equal(await dialog().count(), 0)
    assert.equal(await page.evaluate(() => (window as any).__fixture.organize.calls.filter((c: any[]) => c[0] === 'apply').length), 0)
  })
  await test('明暗主题和小窗口无溢出，主要操作保持可见，键盘焦点封闭', async () => {
    await selectPair(); await ready()
    for (const [width, height] of [[960, 640], [1280, 900]]) {
      await page.setViewportSize({ width, height })
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme: string) => (window as any).__fixture.setTheme(theme), theme)
        assert.equal(await dialog().evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth), false)
        const footer = await dialog().locator('.organize-panel__footer').boundingBox()
        assert.ok(footer && footer.y + footer.height <= height)
        await page.screenshot({ path: path.join(temporary, 'organize-' + width + '-' + theme + '.png'), animations: 'disabled' })
      }
    }
    const closeButton = dialog().getByRole('button', { name: '关闭整理面板', exact: true })
    await closeButton.focus(); await page.keyboard.press('Shift+Tab')
    assert.equal(await dialog().getByRole('button', { name: '创建合集', exact: true }).evaluate((element: Element) => element === document.activeElement), true)
    await page.keyboard.press('Tab')
    assert.equal(await closeButton.evaluate((element: Element) => element === document.activeElement), true)
  })
  assert.deepEqual(errors, [])
} finally { await close() }
console.log(`Video organization UI: ${passed} passed / ${failed} failed; screenshots: ${temporary}`)
if (failed) process.exitCode = 1
