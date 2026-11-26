/** Actual Vue routes in an isolated Chromium profile. IPC is an in-memory fixture;
 * no Electron app, library, configuration, network media or packaging is used. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { loadPlaywright, findChromiumExecutable } from './playwright.ts'

const { chromium } = loadPlaywright()
const entry = String.raw`
import { createApp as createVueApp, h, Transition } from 'vue'
import { installI18n, applyLanguage } from '@/i18n'
const createApp = (...args) => { const app = createVueApp(...args); installI18n(app); return app }
applyLanguage('zh-CN')
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import Home from '@/pages/video/Home.vue'
import Detail from '@/pages/video/Detail.vue'
import TaskCenter from '@/components/tasks/TaskCenter.vue'
import { useSettingsStore } from '@/stores/settings'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useVideoStore } from '@/stores/video'
import { trackRoute } from '@/composables/useModules'
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
  archive: { insights: { list: async () => [], onChanged: () => () => {} } },
  workspace: { onChanged: () => () => {} },
  settings: { getAll: async () => clone(prefs()), patch: async patch => { Object.assign(preferences, patch); return clone({ ...prefs(), ...patch }) } },
  tasks: { list: async () => [], save: async () => true, clear: async () => true },
  app: { copyText: async value => calls.push(['copy', value]) },
  video: {
    preview: { onClosed: () => () => {}, onFrames: () => () => {} },
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
    dismissDownloadJob: async id => { calls.push(['dismiss', id]); const index = jobs.findIndex(j => j.id === id); if (index < 0 || ['running', 'queued'].includes(jobs[index].status)) return false; jobs.splice(index, 1); localStorage.setItem('fixture-jobs', JSON.stringify(jobs)); return true },
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
  { path: '/', redirect: '/video' }, { path: '/video', name: 'video-home', component: Home, meta: { module: 'video' } },
  { path: '/video/:id', name: 'video-detail', component: Detail, props: true, meta: { module: 'video', remountOnId: true } }, { path: '/settings', name: 'settings', component: Settings }
] })
router.afterEach(to => trackRoute(to))
const app = createApp({ setup: () => () => h('div', { style: 'height:100vh;display:flex;flex-direction:column' }, [
  h('header', { style: 'height:38px;min-height:38px;display:flex;justify-content:flex-end' }, [h(TaskCenter)]),
  h(RouterView, null, { default: ({ Component, route }) => h(Transition, { name: 'page', mode: 'out-in' }, () => Component ? h(Component, { key: route.meta.remountOnId ? String(route.params.id) : undefined, class: 'app__view' }) : null) })
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
  configFile: false, root: process.cwd(), optimizeDeps: { noDiscovery: true }, cacheDir: path.join(temporary, 'vite-cache'),
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
  // Fixtures never edit source while running. Avoid scanning large local reference/media directories.
  server: { host: '127.0.0.1', port: 0, watch: null }, logLevel: 'error'
})
await server.listen()
const address = server.httpServer!.address()
assert.ok(address && typeof address !== 'string')
const executablePath = findChromiumExecutable()
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(3000)
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))
// Fixture routes must never request external media or the user's network services.
await page.route('**/*', (route: any) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
return { page, errors, temporary, url: 'http://127.0.0.1:' + address.port + '/__w56__#/video', close: async () => { await browser.close(); await server.close() } }
}

