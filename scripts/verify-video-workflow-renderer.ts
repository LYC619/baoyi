/** Actual Vue routes in an isolated Chromium profile. IPC is an in-memory fixture;
 * no Electron app, library, configuration, network media or packaging is used. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const entry = String.raw`
import { createApp, h, Transition } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import Home from '@/pages/video/Home.vue'
import Detail from '@/pages/video/Detail.vue'
import TaskCenter from '@/components/tasks/TaskCenter.vue'
import { useSettingsStore } from '@/stores/settings'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useVideoStore } from '@/stores/video'
import '@/styles/global.scss'

const clone = value => JSON.parse(JSON.stringify(value))
const base = {
  name_en: '', summary: '本地课程示例，内容与版本均为测试夹具。', description: '这是课程简介。可以先播放视频，也可以查看文件版本。',
  original_description: '', category: '其他', tags: [], hanime_tags: [], official_url: '', notes: '', is_archived: false,
  file_name: '课程', source_dir: 'D:/Fixture', file_size: 1000, video_type: 'series', year: 2026, end_year: 0,
  rating: 0, douban_rating: 0, tmdb_id: '', douban_id: '', hanime_id: '100', poster_path: '', fanart_path: '',
  audio_tracks: [], subtitle_tracks: [], parts: [], linked_files: [], user_edited: [], collection_name: '',
  duration_sec: 1200, resolution: '', video_codec: '', source: '', release_group: '', watch_status: 'unwatched',
  last_watched_at: 0, position_sec: 0, created_at: 1, updated_at: 2, episode_total: 10, episode_present: 8, episode_watched: 1,
  available_files: 9, missing_files: 1, pending_reasons: ['资料待补齐']
}
const longTitle = '摄影课程：如何在低照度环境中保留自然色彩与细节，并比较多个完整文件版本'
const work = { ...base, id: 'work-1', name_zh: longTitle, path: 'D:/Fixture/Course' }
const single = { ...base, id: 'single', name_zh: '单视频作品', video_type: 'movie', path: 'D:/Fixture/one.mp4', episode_total: 0, episode_present: 0, available_files: 1, missing_files: 0, pending_reasons: [] }
const noSource = { ...single, id: 'no-source', name_zh: '尚无来源的作品', hanime_id: '' }
const secret = { ...base, id: 'secret', name_zh: '隐藏作品名称', category: '里番', path: 'D:/Private', hanime_id: '999' }
const asset = (id, state = 'present', quality = '1080p') => ({ id, resource_id: work.id, path: 'D:/Fixture/' + id + '.mp4', role: 'video', state, quality, file_size: 1024, checked_at: Date.now(), created_at: 1 })
const contents = Array.from({ length: 10 }, (_, i) => {
  const primary = asset('asset-' + i, i === 7 ? 'offline' : i === 8 ? 'unchecked' : 'present')
  return { id: 'episode-' + i, resource_id: work.id, season: 0, episode: i + 1, display_order: i + 1, display_label: i === 1 ? '番外' : '第 ' + (i + 1) + ' 节',
    title: i === 1 ? '光线与色温的额外演示' : '课程内容 ' + (i + 1), path: primary.path, file_size: 1024, duration_sec: 1000,
    watch_status: i === 2 ? 'watched' : 'unwatched', position_sec: 0, watched_at: 0, sources: [],
    assets: i === 0 ? [primary, asset('alternate', 'present', '720p'), asset('offline-version', 'offline', '480p')] : [primary] }
})
const libraries = {
  'work-1': { resourceId: work.id, directory: { resourceId: work.id, root: 'D:/Fixture', path: work.path, relativePath: 'Course', metadataState: 'pending' }, contents, assets: contents.flatMap(c => c.assets) },
  single: { resourceId: single.id, directory: null, contents: [], assets: [{ ...asset('single'), resource_id: single.id, path: single.path }] }
}
libraries['no-source'] = { ...clone(libraries.single), resourceId: noSource.id }
libraries.secret = { ...clone(libraries.single), resourceId: secret.id }
const item = (code, transfer, metadata, registration) => ({ videoCode: code, title: '内容 ' + code, order: 1, transfer, metadata, registration, path: transfer === 'complete' ? 'D:/Fixture/' + code + '.mp4' : '', sourceLabel: '720p', receivedBytes: 512, totalBytes: 0, error: '', warnings: [] })
const makeJob = (id, title, items, extra = {}) => ({ id, title, resourceId: work.id, category: '其他', status: 'partial', createdAt: 1, updatedAt: 2, directory: work.path, root: 'D:/Fixture', register: true, sourceLabel: '720p', strictQuality: false, warnings: [], message: '部分内容待处理', items, ...extra })
const initialJobs = [
  makeJob('metadata', '资料失败的作品', [item('100', 'complete', 'failed', 'complete')]),
  makeJob('registration', '入库失败的作品', [item('101', 'complete', 'complete', 'failed')]),
  makeJob('interrupted', '中断的作品', [item('102', 'complete', 'complete', 'complete'), item('103', 'failed', 'pending', 'pending')], { status: 'interrupted' }),
  makeJob('private', '隐藏的任务标题', [item('999', 'failed', 'pending', 'pending')], { category: '里番' })
]
const jobs = JSON.parse(localStorage.getItem('fixture-jobs') || 'null') || initialJobs
const calls = []
const jobListeners = new Set(), libraryListeners = new Set(), progressListeners = new Set()
let settingsStore
const preferences = { hide_hentai: false, video_download_quality: '720p', video_download_strict_quality: false, video_download_register: true, video_download_root: 'D:/Fixture' }
const prefs = () => ({ ...preferences, ...settingsStore?.settings })
const notify = job => { localStorage.setItem('fixture-jobs', JSON.stringify(jobs)); jobListeners.forEach(cb => cb(clone(job))) }
const changed = id => libraryListeners.forEach(cb => cb(id))
const draft = { id: 'draft', resourceId: '', videoCode: '200', title: '新链接作品', category: '其他', description: '', pageUrl: 'https://hanime1.me/watch?v=200', root: 'D:/Fixture', directory: 'D:/Fixture/新链接作品', bound: false, missing: ['poster'], warnings: [], episodes: [
  { videoCode: '200', title: '已有内容', order: 1, state: 'local', qualities: ['720p'] },
  { videoCode: '201', title: '待补内容', order: 2, state: 'missing', qualities: [] },
  { videoCode: '202', title: '新发现内容', order: 3, state: 'available', qualities: [] },
  { videoCode: '203', title: '队列内内容', order: 4, state: 'queued', qualities: [] }
] }
window.baoyi = {
  settings: { getAll: async () => clone(prefs()), patch: async patch => { Object.assign(preferences, patch); return clone(prefs()) } },
  tasks: { list: async () => [], save: async () => true, clear: async () => true },
  app: { copyText: async value => calls.push(['copy', value]) },
  video: {
    list: async query => {
      calls.push(['list', query])
      if (query.type === 'hentai') return prefs().hide_hentai ? [] : [clone(secret)]
      const result = [clone(work), clone(single)]
      return query.keyword ? result.filter(w => w.id === work.id).map(w => ({ ...w, matched_content: '光线与色温的额外演示' })) : result
    },
    counts: async () => ({ all: 2, archived: 0, type: { movie: 1, series: 1 }, status: { unwatched: 2, watched: 0, watching: 0, dropped: 0 }, categories: [], tags: [], hanime_tags: [], hentai_visible: !prefs().hide_hentai, hentai: prefs().hide_hentai ? 0 : 1 }),
    get: async id => clone(id === work.id ? work : id === 'single' ? single : id === 'secret' ? secret : id === 'no-source' ? noSource : null),
    library: async id => clone(libraries[id]),
    searchSource: async query => { calls.push(['search-source',query]); return [{ videoCode: '200', title: '匹配来源示例', coverUrl: '' }] },
    scrapeEpisode: async (id, episodeId, source) => { calls.push(['bind-source',id,episodeId,source]); const target = id === 'no-source' ? noSource : work; target.hanime_id = /(?:v=)?(\d+)$/.exec(source)?.[1] || ''; return { item: clone(target), episode: null, warnings: [] } },
    syncFiles: async id => ({ library: clone(libraries[id]), itemsAdded: 0, filesAdded: 0, pathsRepaired: 0, duplicatesMerged: 0, warnings: [], message: '检查完成：新增 0 个视频' }),
    onLibraryChanged: cb => { libraryListeners.add(cb); return () => libraryListeners.delete(cb) },
    prepareDownload: async input => { calls.push(['prepare', input]); if (input.resourceId === 'no-source' && !noSource.hanime_id && !input.url) throw new Error('此作品没有来源编号，请补充来源链接'); return { ...clone(draft), ...(input.resourceId ? { resourceId: input.resourceId, title: work.name_zh, directory: work.path, bound: true } : {}) } },
    pickDownloadRoot: async () => ({ ...clone(draft), root: 'E:/Fixture', directory: 'E:/Fixture/新链接作品' }),
    enqueueDownload: async request => { calls.push(['enqueue', request]); const next = makeJob('queued-' + Date.now(), request.title || work.name_zh, request.videoCodes.map(code => item(code, 'pending', 'pending', 'pending')), { status: 'queued', register: request.register }); jobs.push(next); notify(next); return clone(next) },
    downloadJobs: async () => clone(jobs.filter(j => !prefs().hide_hentai || j.category !== '里番')),
    onDownloadJob: cb => { jobListeners.add(cb); return () => jobListeners.delete(cb) },
    retryDownloadJob: async (id, stage) => { calls.push(['retry', id, stage]); const job = jobs.find(j => j.id === id); job.status = 'queued'; job.retryStage = stage; job.updatedAt = Date.now(); notify(job); return clone(job) },
    cancelDownloadJob: async id => { calls.push(['cancel', id]); const job = jobs.find(j => j.id === id); job.status = 'cancelled'; job.updatedAt = Date.now(); notify(job); return true },
    revealDownloadJob: async id => { calls.push(['reveal-job', id]); return true },
    playAsset: async id => { calls.push(['play', id]); return { ok: true, item: clone(work), episode: null } },
    revealAsset: async id => { calls.push(['reveal', id]); return true },
    setDefaultAsset: async (episodeId, assetId) => { calls.push(['default', episodeId, assetId]); const row = contents.find(c => c.id === episodeId); row.path = row.assets.find(a => a.id === assetId).path; return true },
    relocateAsset: async id => { calls.push(['relocate', id]); const a = libraries['work-1'].assets.find(a => a.id === id); a.path = 'E:/Found/' + id + '.mp4'; a.state = 'present'; return true },
    updateEpisode: async (id, patch) => { const row = contents.find(c => c.id === id); Object.assign(row, patch); const { assets, sources, ...episode } = clone(row); return { item: clone(work), episode } },
    update: async (id, patch) => { Object.assign(id === work.id ? work : single, patch); return clone(id === work.id ? work : single) },
    revealInFolder: async () => true, importBundle: async () => null,
    readiness: async () => ({ ok: true, message: '' }), pickDirectories: async () => ['D:/Fixture'],
    onProgress: cb => { progressListeners.add(cb); return () => progressListeners.delete(cb) }, cancel: () => {},
    scan: async () => ({ candidates: 3, registered: 1, skipped: 1, failed: 1, episodes: 1, tokens: 0, searches: 0, entries: [
      { path: 'D:/Fixture/Course', resourceId: work.id, status: 'updated', message: '新增课程内容' },
      { path: 'D:/Fixture/review', resourceId: work.id, status: 'review', message: '归属需要确认' },
      { path: 'D:/Fixture/broken', status: 'failed', message: '清单损坏，文件保留' }
    ] }),
    reidentify: async id => { calls.push(['reidentify', id]); return clone(work) }
  }
}
const pinia = createPinia()
settingsStore = useSettingsStore(pinia)
settingsStore.settings = { ...settingsStore.settings, ...preferences, theme: 'light', onboarded: true }
settingsStore.loaded = true
const Settings = { setup: () => () => h('main', { style: 'padding:20px' }, [h('h1', '设置夹具'), h('button', { onClick: () => router.back() }, '返回下载草稿')]) }
const router = createRouter({ history: createWebHashHistory(), routes: [
  { path: '/', redirect: '/video' }, { path: '/video', name: 'video-home', component: Home },
  { path: '/video/:id', name: 'video-detail', component: Detail, props: true }, { path: '/settings', name: 'settings', component: Settings }
] })
const app = createApp({ setup: () => () => h('div', { style: 'height:100vh;display:flex;flex-direction:column' }, [
  h('header', { style: 'height:38px;min-height:38px;display:flex;justify-content:flex-end' }, [h(TaskCenter)]),
  h(RouterView, null, { default: ({ Component }) => h(Transition, { name: 'page', mode: 'out-in' }, () => Component ? h(Component, { class: 'app__view' }) : null) })
]) })
app.use(pinia).use(router)
await router.isReady()
document.documentElement.dataset.theme = 'light'
app.mount('#app')
window.__fixture = { calls, jobs, contents, libraries, changed, settingsStore, router, center: useTaskCenter(), videoStore: useVideoStore(pinia), work, single, noSource, secret,
  setHidden: value => { settingsStore.settings = { ...settingsStore.settings, hide_hentai: value } },
  setTheme: value => { document.documentElement.dataset.theme = value }
}
`
export async function createWorkflowRendererFixture(extraEntry = '') {
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-workflow-renderer-'))
const virtualId = 'virtual:w56-renderer'
const server = await createServer({
  configFile: false, root: process.cwd(), cacheDir: path.join(temporary, 'vite-cache'),
  resolve: { alias: { '@': path.resolve('src') } },
  plugins: [vue(), {
    name: 'isolated-workflow-fixture',
    resolveId: id => id === virtualId ? '\0' + virtualId : undefined,
    load: id => id === '\0' + virtualId ? entry + '\n' + extraEntry : undefined,
    configureServer: server => {
      server.middlewares.use('/__w56__', (_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="/@id/' + virtualId + '"></script></body></html>')
      })
    }
  }],
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'error'
})
await server.listen()
const address = server.httpServer!.address()
assert.ok(address && typeof address !== 'string')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(3000)
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))
// Fixture routes must never request external media or the user's network services.
await page.route('**/*', (route: any) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
return { page, errors, temporary, url: 'http://127.0.0.1:' + address.port + '/__w56__#/video', close: async () => { await browser.close(); await server.close() } }
}

async function runWorkflowRenderer() {
const { page, errors, temporary, url, close } = await createWorkflowRendererFixture()
let passed = 0, failed = 0
async function test(name: string, action: () => Promise<void>) {
  try { await action(); passed++; console.log('PASS ' + name) }
  catch (cause) { failed++; console.error('FAIL ' + name + ': ' + (cause instanceof Error ? cause.message.split('\n').slice(0, 4).join(' ') : cause)) }
  finally {
    for (const name of ['关闭下载面板', '关闭任务面板']) {
      const close = page.getByRole('button', { name, exact: true })
      if (await close.isVisible().catch(() => false)) await close.click().catch(() => {})
    }
  }
}
const route = async (name: string, params = {}) => {
  await page.evaluate(({ name, params }: any) => (window as any).__fixture.router.push({ name, params }), { name, params })
  await page.waitForFunction(() => {
    const view = document.querySelector('.app__view')
    return view && getComputedStyle(view).opacity === '1' && !document.querySelector('.page-enter-active, .page-leave-active')
      && !document.querySelector('.detail__state')?.textContent?.includes('载入中')
  })
}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => !!(window as any).__fixture, null, { timeout: 20000 })
  await test('首页链接入口、默认缺项、取消不创建作品、设置往返保留草稿', async () => {
    const add = page.getByRole('button', { name: /从链接添加|链接下载/ })
    assert.equal(await add.count(), 1, '首页必须提供统一链接入口')
    await add.click()
    const dialog = page.getByRole('dialog', { name: /从链接添加作品/ })
    await dialog.getByLabel('来源页面链接').fill('https://hanime1.me/watch?v=200')
    await dialog.getByRole('button', { name: '解析链接', exact: true }).click()
    await dialog.getByLabel('作品名称', { exact: true }).fill('用户保留的名称')
    assert.equal(await dialog.locator('.download-contents input:checked').count(), 2)
    assert.match(await dialog.innerText(), /已发现 4/)
    assert.match(await dialog.innerText(), /影视库根目录/)
    await dialog.getByRole('button', { name: '下载与存储设置' }).click()
    await page.getByRole('button', { name: '返回下载草稿' }).click()
    assert.equal(await dialog.getByLabel('作品名称', { exact: true }).inputValue(), '用户保留的名称')
    await dialog.getByLabel('仅保存文件').check()
    await dialog.getByRole('button', { name: /关闭下载面板/ }).click()
    assert.equal(await page.evaluate(() => (window as any).__fixture.calls.filter((c: any[]) => c[0] === 'enqueue').length), 0)
    assert.equal(await page.locator('.wall .card').count(), 2)
  })
  await test('作品搜索显示命中的内容，已知文件计数和待处理筛选', async () => {
    await route('video-home')
    await page.getByRole('textbox', { name: /搜索/ }).fill('色温')
    await page.waitForFunction(() => document.querySelector('.card')?.textContent?.includes('光线与色温'))
    assert.match(await page.locator('.card').first().innerText(), /命中内容/)
    await page.getByRole('button', { name: '清空搜索' }).click()
    await page.getByRole('button', { name: /^待处理/ }).click()
    assert.ok(await page.locator('.card').count() >= 1)
  })
  await test('已有作品可补来源链接，保持指定作品归属', async () => {
    await route('video-detail', { id: 'no-source' })
    await page.getByRole('button', { name: '下载 / 补齐内容', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '匹配单集来源' })
    const link = dialog.getByLabel('视频链接或来源编号')
    await link.fill('https://hanime1.me/watch?v=200')
    await dialog.getByRole('button', { name: '绑定并刮削', exact: true }).click()
    await dialog.waitFor({state:'hidden'})
    assert.ok(await page.evaluate(() => (window as any).__fixture.calls.some((c: any[]) => c[0] === 'bind-source' && c[1] === 'no-source' && c[3] === 'https://hanime1.me/watch?v=200')))
    await page.getByRole('button', { name: '下载 / 补齐内容', exact: true }).click()
    await page.getByRole('dialog', { name: '补齐作品内容' }).getByLabel('作品名称', { exact: true }).waitFor()
    assert.ok(await page.evaluate(() => (window as any).__fixture.calls.some((c: any[]) => c[0] === 'prepare' && c[1].resourceId === 'no-source')))
  })
  await test('确认下载提交画质与仅保存选项，队列内可取消，键盘可关闭面板', async () => {
    await route('video-home')
    const trigger = page.getByRole('button', { name: '从链接添加', exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: /从链接添加作品/ })
    await dialog.getByLabel('来源页面链接').fill('https://hanime1.me/watch?v=200')
    await dialog.getByRole('button', { name: '解析链接', exact: true }).click()
    await dialog.getByLabel('作品名称', { exact: true }).fill('完整队列示例')
    await dialog.getByRole('combobox', { name: '目标清晰度', exact: true }).selectOption('1080p')
    assert.match(await dialog.innerText(), /回退到可用清晰度/)
    await dialog.getByLabel(/严格匹配清晰度/).check()
    await dialog.getByLabel('仅保存文件').check()
    await dialog.getByRole('button', { name: '下载所选 2 项', exact: true }).click()
    const submission = await page.evaluate(() => (window as any).__fixture.calls.filter((c: any[]) => c[0] === 'enqueue').at(-1)?.[1])
    assert.deepEqual(submission.videoCodes, ['201', '202'])
    assert.equal(submission.sourceLabel, '1080p')
    assert.equal(submission.strictQuality, true)
    assert.equal(submission.register, false)
    await dialog.getByRole('button', { name: '关闭下载面板' }).focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await dialog.getByRole('button', { name: '下载与存储设置' }).evaluate((element: Element) => element === document.activeElement), true)
    await page.keyboard.press('Escape')
    assert.equal(await dialog.count(), 0)
    assert.equal(await trigger.evaluate((element: Element) => element === document.activeElement), true)
    await page.locator('.task-trigger').click()
    await page.locator('.download-task').filter({ hasText: '完整队列示例' }).getByRole('button', { name: '取消排队' }).click()
    assert.ok(await page.evaluate(() => (window as any).__fixture.jobs.some((job: any) => job.title === '完整队列示例' && job.status === 'cancelled')))
  })
  await test('详情统一下载入口和阅读态资料', async () => {
    await route('video-detail', { id: 'work-1' })
    assert.equal(await page.getByRole('heading', { name: /摄影课程/ }).count(), 1)
    assert.equal(await page.getByRole('button', { name: '下载 / 补齐内容', exact: true }).count(), 1)
    assert.equal(await page.getByLabel('片名', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '下载 / 补齐内容', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '补齐作品内容' })
    await dialog.getByRole('button', { name: '下载所选 2 项', exact: true }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '更换目录' }).isDisabled(), true)
    await dialog.getByRole('button', { name: '关闭下载面板' }).click()
  })
  await test('多个版本播放、设默认及不可用版本的安全状态', async () => {
    await route('video-detail', { id: 'work-1' })
    const row = page.locator('.video-item').first()
    await row.getByRole('combobox').selectOption('alternate')
    await row.getByRole('button', { name: '设为默认' }).click()
    await page.waitForFunction(() => (window as any).__fixture.contents[0].path.endsWith('alternate.mp4'))
    await row.getByRole('button', { name: /^播放：/ }).click()
    assert.ok(await page.evaluate(() => (window as any).__fixture.calls.some((c: any[]) => c[0] === 'play' && c[1] === 'alternate')))
    await row.getByRole('combobox').selectOption('offline-version')
    assert.equal(await row.getByRole('button', { name: /^播放：/ }).isDisabled(), true)
    assert.equal(await row.getByRole('button', { name: '设为默认' }).isDisabled(), true)
    await row.getByRole('button', { name: /^重新定位/ }).click()
    await page.waitForFunction(() => (window as any).__fixture.libraries['work-1'].assets.find((a: any) => a.id === 'offline-version').state === 'present')
    await row.getByRole('button', { name: /^播放：/ }).waitFor()
    assert.equal(await row.getByRole('button', { name: /^播放：/ }).isEnabled(), true)
  })
  await test('持久队列有分阶段恢复，隐藏分类同步移除标题和计数', async () => {
    await page.locator('.task-trigger').click()
    const panel = page.locator('.task-panel')
    await panel.locator('.task-group--downloads > summary').click()
    const metadata = panel.locator('article').filter({ hasText: '资料失败的作品' })
    assert.equal(await metadata.count(), 1, '任务中心必须显示主进程工作流任务')
    await metadata.getByRole('button', { name: '补齐资料', exact: true }).click()
    const registration = panel.locator('article').filter({ hasText: '入库失败的作品' })
    await registration.getByRole('button', { name: '仅重试入库', exact: true }).click()
    const interrupted = panel.locator('article').filter({ hasText: '中断的作品' })
    await interrupted.getByRole('button', { name: '仅重试剩余视频', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.calls.filter((c: any[]) => c[0] === 'retry').map((c: any[]) => c.slice(1))), [['metadata', 'metadata'], ['registration', 'registration'], ['interrupted', 'remaining']])
    await page.evaluate(() => (window as any).__fixture.setHidden(true))
    await page.waitForFunction(() => !document.querySelector('.task-panel')?.textContent?.includes('隐藏的任务标题'))
    assert.ok(!(await panel.innerText()).includes('隐藏的任务标题'))
    assert.ok(!(await page.locator('.task-trigger').getAttribute('aria-label'))!.includes('4 个排队'))
    await page.getByRole('button', { name: '关闭任务面板' }).click()
    await page.evaluate(() => (window as any).__fixture.setHidden(false))
  })
  await test('扫描逐项结果可打开作品与修正，不把汇总当作每项成功', async () => {
    await route('video-home')
    await page.getByRole('button', { name: /扫描本地|加影视/ }).click()
    await page.waitForFunction(() => document.querySelector('.scan-results')?.textContent?.includes('清单损坏'))
    assert.match(await page.locator('.scan-results').innerText(), /待确认/)
    const correction = page.locator('.scan-results li').filter({ hasText: '归属需要确认' })
    await correction.getByRole('button', { name: /修正|打开作品/ }).click()
    await page.locator('.video-items').waitFor()
  })
  await test('960×640 与 1280×900：首屏内容行、长标题、主题和键盘焦点', async () => {
    await page.getByRole('button', { name: '列表视图', exact: true }).click()
    await route('video-detail', { id: 'work-1' })
    for (const [width, height, minimum] of [[960, 640, 3], [1280, 900, 5]]) {
      await page.setViewportSize({ width, height })
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme: string) => (window as any).__fixture.setTheme(theme), theme)
        const layout = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('.video-item')].map(e => e.getBoundingClientRect())
          return { visible: rows.filter(r => r.top >= 0 && r.bottom <= innerHeight).length, overflow: document.documentElement.scrollWidth > innerWidth }
        })
        assert.ok(layout.visible >= minimum, width + 'px 首屏至少 ' + minimum + ' 行，实际 ' + layout.visible)
        assert.equal(layout.overflow, false)
        await page.screenshot({ path: path.join(temporary, 'detail-' + width + '-' + theme + '.png') })
      }
    }
    const edit = page.getByRole('button', { name: '编辑资料', exact: true })
    await edit.focus()
    const focus = await edit.evaluate((element: HTMLElement) => ({ width: getComputedStyle(element).outlineWidth, active: element === document.activeElement }))
    assert.equal(focus.active, true)
    assert.notEqual(focus.width, '0px')
  })
  await test('单视频首屏可播放，位置与简介标签可用', async () => {
    await route('video-detail', { id: 'single' })
    await page.setViewportSize({ width: 960, height: 640 })
    assert.equal(await page.locator('.detail__play').isEnabled(), true)
    await page.getByRole('tab', { name: '剧情简介', exact: true }).click()
    const description = page.getByText('这是课程简介。可以先播放视频，也可以查看文件版本。', { exact: true }).first()
    const rect = await description.boundingBox()
    assert.ok(rect && rect.y + rect.height <= 640, '简介标签打开后应直接读到介绍')
    assert.equal(await page.getByRole('button', { name: '打开所在文件夹', exact: true }).isVisible(), true)
  })
  await test('renderer 重新加载后恢复主进程任务列表', async () => {
    await page.reload()
    await page.waitForFunction(() => !!(window as any).__fixture)
    await page.locator('.task-trigger').click()
    assert.match(await page.locator('.task-panel').innerText(), /资料失败的作品/)
    assert.match(await page.locator('.task-panel').innerText(), /排队/)
  })
  await test('隐藏设置会立即遮蔽已经打开的私密详情', async () => {
    await route('video-detail', { id: 'secret' })
    await page.getByRole('heading', { name: '隐藏作品名称', exact: true }).waitFor()
    await page.evaluate(() => (window as any).__fixture.setHidden(true))
    await page.waitForFunction(() => !document.querySelector('.detail')?.textContent?.includes('隐藏作品名称'))
    assert.equal(await page.getByRole('heading', { name: '隐藏作品名称', exact: true }).count(), 0)
    await page.evaluate(() => (window as any).__fixture.setHidden(false))
  })
  await test('解析来源期间仍可用 Escape 取消，迟到草稿不重新打开面板', async () => {
    await route('video-home')
    await page.getByRole('button', { name: '从链接添加', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '从链接添加作品' })
    await dialog.getByLabel('来源页面链接').fill('https://hanime1.me/watch?v=200')
    await page.evaluate(() => {
      const f = (window as any).__fixture, api = (window as any).baoyi.video
      f.originalPrepare = api.prepareDownload
      api.prepareDownload = async (request: unknown) => {
        const value = await f.originalPrepare(request)
        return new Promise(resolve => { f.finishPrepare = () => resolve(value) })
      }
    })
    try {
      await dialog.getByRole('button', { name: '解析链接', exact: true }).click()
      await page.waitForFunction(() => typeof (window as any).__fixture.finishPrepare === 'function')
      await page.keyboard.press('Escape')
      assert.equal(await dialog.count(), 0)
    } finally {
      await page.evaluate(() => { const f = (window as any).__fixture; (window as any).baoyi.video.prepareDownload = f.originalPrepare; f.finishPrepare?.() })
    }
    assert.equal(await dialog.count(), 0)
    assert.equal(await page.getByRole('button', { name: '从链接添加', exact: true }).evaluate((element: Element) => element === document.activeElement), true)
  })
  assert.deepEqual(errors, [], 'renderer must not throw')
} finally {
  await close()
}
console.log(`视频工作流浏览器：${passed} 通过 / ${failed} 失败；临时截图：${temporary}`)
if (failed) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runWorkflowRenderer()
