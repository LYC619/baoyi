/** Run after the unified build. Launches Electron with an isolated profile. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron } from 'playwright'
import { initSchema } from '../electron/services/storage/schema.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

const output = path.resolve('output/unified-settings')
await fs.mkdir(output, { recursive: true })
const profile = await fs.mkdtemp(path.join(output, 'profile-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); initSchema(db, KINDS); db.exec(VIDEO_JOBS_SQL)
for (const [key, value] of Object.entries({ onboarded: true, language: 'zh-CN', theme: 'light', hanime_builtin_hosts: false, ai: { enabled: false, api_url: '', api_key: '', model: '' } })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
const secrets = { ai:'synthetic-old-ai', profile:'synthetic-old-profile', search:'synthetic-old-search', tmdb:'synthetic-old-tmdb' }
for (const [key, value] of Object.entries({ai:{enabled:false,api_key:secrets.ai}, ai_profiles:[{id:'test',name:'测试',enabled:false,api_key:secrets.profile}],search:{enabled:false,api_key:secrets.search},tmdb:{enabled:false,api_key:secrets.tmdb}})) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value))
db.prepare("UPDATE settings SET value='31' WHERE key='_schema'").run()
const fixtureFile = path.join(profile, '标签验收.txt'); await fs.writeFile(fixtureFile, '第一章\n隔离标签测试')
const fixtureDoc = await new DocumentLibrary(db).register(fixtureFile, 'novel')
db.close()
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const executable = process.env.BAOYI_TEST_EXE || path.resolve('node_modules/electron/dist/electron.exe')
const app = await _electron.launch({ executablePath: executable, args: [...(process.env.BAOYI_TEST_EXE ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
const page = await app.firstWindow(), errors: string[] = [], checks: string[] = []
page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message))
const navigate = async (route: string) => { await page.evaluate(route => { location.hash = route }, route) }
try {
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), profile)
  await page.waitForFunction(() => !!window.baoyi?.workspace)
  const current = await page.evaluate(() => window.baoyi.settings.getAll())
  assert.deepEqual([current.ai.api_key,current.ai_profiles[0].api_key,current.search.api_key,current.tmdb.api_key],Object.values(secrets))
  await page.evaluate(ai=>window.baoyi.settings.patch({ai:{...ai,api_key:'synthetic-new-ai'}}),current.ai)
  const disk = new DatabaseSync(path.join(profile,'baoyi.db'),{readOnly:true})
  try {
    const rows = disk.prepare("SELECT value FROM settings WHERE key IN ('ai','ai_profiles','search','tmdb')").all()
    assert.equal(rows.length,4)
    for (const row of rows) assert.ok(String(row.value).includes('safeStorageV1') && !String(row.value).includes('synthetic-'))
  } finally { disk.close() }
  assert.equal((await page.evaluate(()=>window.baoyi.settings.getAll())).ai.api_key,'synthetic-new-ai')
  checks.push('existing and edited API keys round-trip with Windows encryption')
  for (const [module, route] of [['software', '/'], ['game', '/game'], ['video', '/video'], ['image', '/image'], ['document', '/document'], ['project', '/project'], ['personal', '/personal']]) {
    await navigate(route)
    await page.locator('.settings').waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('button', { name: '设置', exact: true }).count(), 1)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings').waitFor()
    await page.waitForFunction(module => location.hash.includes('module=' + module), module)
    assert.equal(await page.locator('.scope-nav button').count(), 8)
    const tabs = await page.locator('.settings .nav__item').allTextContents()
    for (const label of tabs) {
      await page.locator('.settings .nav').getByRole('button', { name: label.trim(), exact: true }).click()
      await page.waitForFunction(label => document.querySelector('.settings .nav__item.on')?.textContent?.trim() === label, label.trim())
      await page.waitForFunction(() => !document.querySelector('.page-enter-active,.page-leave-active'))
      if (['software', 'game', 'video'].includes(module)) {
        const heading = ({ '扫描与识别': '扫描目录', '目录整理': module === 'video' ? '影视整理目录' : '整理目标目录', '分类': '分类', '标签': module === 'video' ? '影视标签' : '标签', '存档与备份': '存档备份目录', '影视刮削': 'TMDB 刮削（影视）', '里番区基础设置': '隐藏里番', '网络与出站代理': '通用在线来源', '下载与缓存': '视频更新检查' } as Record<string, string>)[label.trim()]
        if (heading) await page.getByRole('heading', { name: heading, exact: true }).waitFor()
      }
      assert.ok((await page.locator('.settings .body').innerText()).trim(), module + ': ' + label)
    }
  }
  checks.push('one-titlebar-entry-and-current-module-default-for-seven-modules')
  await navigate('/settings?scope=global&module=software&tab=ai')
  await page.getByRole('heading', { name: 'AI 模型配置', exact: true }).waitFor()
  await page.locator('.profiles__name').fill('local-fixture-profile')
  await page.getByTitle('把当前填的存成一套', { exact: true }).click()
  const modelInput = page.locator('input[list="ai-models"]')
  await modelInput.fill('saved-fixture-model')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.waitForFunction(async () => (await window.baoyi.settings.getAll()).ai.model === 'saved-fixture-model')
  await modelInput.fill('unsaved-fixture-model')
  await page.locator('.dirty').filter({ hasText: '有未保存的改动' }).waitFor()
  for (const label of ['外观', '联网搜索', '数据管理', '关于', 'AI 配置']) {
    await page.locator('.settings .nav').getByRole('button', { name: label, exact: true }).click()
    assert.ok((await page.locator('.settings .body').innerText()).trim())
  }
  assert.equal(await modelInput.inputValue(), 'unsaved-fixture-model')
  await page.locator('.dirty').filter({ hasText: '有未保存的改动' }).waitFor()
  await page.locator('.scope-nav').getByRole('button', { name: '图片', exact: true }).click()
  await page.locator('.settings .head__module').filter({ hasText: '图片' }).waitFor()
  await navigate('/settings?scope=global&module=software&tab=ai')
  await modelInput.waitFor(); assert.equal(await modelInput.inputValue(), 'unsaved-fixture-model')
  await navigate('/'); await page.locator('.settings').waitFor({ state: 'hidden' })
  await navigate('/settings?scope=global&module=software&tab=ai')
  await modelInput.waitFor(); assert.equal(await modelInput.inputValue(), 'saved-fixture-model')
  checks.push('all-visible-tabs-save-reopen-and-unsaved-ai-draft')
  for (const module of ['software', 'game', 'video']) {
    await navigate('/settings?scope=module&module=' + module + '&tab=categories')
    await page.locator('.taxonomy-fields').waitFor()
    assert.equal(await page.locator('.taxonomy-fields').getByRole('heading', { name: '标签', exact: true }).count(), 0)
    await page.locator('.settings .nav').getByRole('button', { name: '标签', exact: true }).click()
    await page.getByRole('heading', { name: module === 'video' ? '影视标签' : '标签', exact: true }).waitFor()
  }
  const pool = page.locator('.panel').filter({ has: page.getByRole('heading', { name: '识别标签池（影视通用）', exact: true }) })
  await pool.getByPlaceholder('新标签名').fill('池预设')
  await pool.getByRole('button', { name: '添加', exact: true }).click()
  await page.waitForFunction(async () => (await window.baoyi.tags.list('video')).some(tag => tag.name === '池预设' && tag.source === 'user'))
  checks.push('video-preset-tag-pool-preserved')
  await navigate('/settings?scope=global&module=video&tab=appearance')
  await page.getByRole('heading', { name: '主题', exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: '隐藏里番', exact: true }).count(), 0)
  await page.locator('.scope-nav').getByRole('button', { name: '影视', exact: true }).click()
  await page.locator('.settings .nav').getByRole('button', { name: '里番区基础设置', exact: true }).click()
  await page.getByRole('heading', { name: '隐藏里番', exact: true }).waitFor()
  assert.equal(await page.locator('.nav__divider').count(), 1)
  checks.push('independent-category-and-tag-pages-and-hentai-section')
  for (const module of ['image', 'document']) {
    await navigate(`/settings?scope=module&module=${module}&tab=organize`)
    await page.getByRole('heading', { name: module === 'image' ? '目录整理' : '文库归档整理', exact: true }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: module === 'image' ? '目录整理' : '文库归档整理', exact: true }).waitFor()
    assert.ok((await page.evaluate(() => location.hash)).includes('module=' + module))
  }
  await navigate('/settings?module=image&scope=module&tab=reader')
  await page.getByLabel('阅读方向').selectOption('rtl')
  await page.getByRole('button', { name: '保存阅读偏好', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '阅读偏好已保存' }).waitFor()
  assert.equal(await page.evaluate(async () => (await window.baoyi.image.preferences()).direction), 'rtl')
  await navigate('/settings?module=document&scope=module&tab=reader')
  await page.getByLabel('阅读字号', { exact: true }).fill('21')
  await page.getByRole('button', { name: '保存模块偏好', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor()
  assert.equal(await page.evaluate(async () => (await window.baoyi.workspace.preferences.get('document')).fontSize), 21)
  checks.push('image-document-organize-route-reload-and-persisted-reader-preferences')
  await navigate('/settings?module=document&scope=module&tab=tags')
  await page.getByLabel('选择分类', { exact: false }).selectOption('novel')
  await page.locator('.tag-documents').getByText('标签验收', { exact: true }).click()
  await page.getByPlaceholder('输入新标签（按回车或点击添加）').fill('设置页标签')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await page.getByRole('button', { name: '应用到 1 份资料', exact: true }).click()
  await page.waitForFunction(async id => (await window.baoyi.workspace.documents.get(id))?.tags.includes('设置页标签'), fixtureDoc.id)
  await page.getByRole('button', { name: '重命名', exact: true }).first().waitFor()
  checks.push('embedded-document-tag-selection-and-persisted-batch-update')
  await navigate('/video'); await page.locator('.sidebar').waitFor()
  assert.equal(await page.locator('.sidebar').getByText('观看', { exact: true }).count(), 0)
  assert.equal(await page.locator('.sidebar').getByText('其他分类', { exact: true }).count(), 0)
  await navigate('/game'); await page.locator('.sidebar').waitFor()
  assert.equal(await page.locator('.sidebar').getByText('存档', { exact: true }).count(), 0)
  checks.push('removed-sidebar-sections')
  for (const width of [960, 1280]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 850), width)
    await navigate('/settings?module=video&scope=module&tab=online')
    await page.getByRole('heading', { name: '找视频 · 网站与代理', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(output, `settings-${width}.png`) })
  }
  await navigate('/document')
  await page.locator('.settings').waitFor({ state: 'hidden' })
  await page.keyboard.press('Control+,')
  await page.locator('.settings').waitFor()
  await page.locator('.settings .nav').getByRole('button', { name: '网络代理', exact: true }).click()
  await page.getByRole('heading', { name: '应用出站代理', exact: true }).waitFor()
  await page.locator('.scope-nav').getByRole('button', { name: '游戏', exact: true }).click()
  await page.locator('.settings .head__module').filter({ hasText: '游戏' }).waitFor()
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/document'))
  await page.keyboard.press('Control+Shift+k')
  await page.locator('dialog.global-search-dialog[open]').waitFor()
  await page.locator('#global-search-input').fill('标签验收')
  await page.locator('.gs-row').filter({ hasText: '标签验收' }).first().waitFor()
  await page.keyboard.press('Enter')
  await page.waitForFunction((id: string) => location.hash.includes('/document/' + id), fixtureDoc.id)
  await page.keyboard.press('Control+j')
  await page.locator('.archive-panel').waitFor()
  await page.getByRole('button', { name: /附带当前条目：标签验收/ }).waitFor()
  await page.waitForFunction(() => {
    const el = document.querySelector('.app__view')
    return !!el && parseFloat(getComputedStyle(el).marginRight) >= 380
  })
  await page.keyboard.press('Escape')
  checks.push('merged-settings-proxy-exact-return-global-search-and-side-split')
  await navigate('/settings?module=software&scope=global&tab=appearance')
  await page.getByLabel('Language / 界面语言', { exact: true }).selectOption('en')
  await page.waitForFunction(() => document.documentElement.lang === 'en')
  await page.getByRole('heading', { name: 'Theme', exact: true }).waitFor()
  assert.deepEqual((await page.locator('.titlebar .tabs .tab > span:first-child').allTextContents()).map(x => x.trim()), ['Personal', 'Projects', 'Software', 'Games', 'Video', 'Images', 'Documents'])
  const englishSettings = await page.evaluate(() => window.baoyi.settings.getAll())
  assert.equal(englishSettings.language, 'en')
  assert.equal(englishSettings.title_lang, current.title_lang, 'interface language must not change resource title preference')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: path.join(output, 'settings-english.png') })
  const englishDocument = await page.evaluate(id => window.baoyi.workspace.documents.get(id), fixtureDoc.id)
  assert.equal(englishDocument?.name, fixtureDoc.name)
  assert.ok(englishDocument?.tags.includes('设置页标签'), 'user labels remain unchanged')
  await app.evaluate(({ dialog }) => {
    const state = globalThis as any
    state.i18nOriginalOpenDialog = dialog.showOpenDialog
    dialog.showOpenDialog = (async (...args: any[]) => {
      state.i18nDialogTitle = args.at(-1).title
      return { canceled: true, filePaths: [] }
    }) as typeof dialog.showOpenDialog
  })
  try {
    await page.evaluate(() => window.baoyi.data.pickSaveBackupRoot())
    assert.equal(await app.evaluate(() => (globalThis as any).i18nDialogTitle), 'Choose save backup folder')
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (globalThis as any).i18nOriginalOpenDialog
      delete (globalThis as any).i18nOriginalOpenDialog
      delete (globalThis as any).i18nDialogTitle
    })
  }
  await page.reload()
  await page.getByRole('heading', { name: 'Theme', exact: true }).waitFor()
  assert.equal(await page.locator('html').getAttribute('lang'), 'en')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 850))
  for (const [module, route, marker] of [
    ['software', '/', 'input[aria-label="Search software"]'],
    ['game', '/game', 'input[aria-label="Search games"]'],
    ['video', '/video', 'input[aria-label="Search works, content titles or filenames"]'],
    ['image', '/image', '.image-home'],
    ['document', '/document', '.document-home'],
    ['project', '/project', '.pj-home'],
    ['personal', '/personal', '.personal-home'],
  ]) {
    await navigate(route)
    await page.locator(marker).waitFor({ state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('.page-enter-active,.page-leave-active'))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'English page fits: ' + module)
    const allLabel = { software: 'All', game: 'All games', video: 'All video' }[module]
    if (allLabel) assert.equal(await page.locator('.sidebar .row__label').first().textContent(), allLabel)
    if (module === 'document') {
      assert.equal(await page.locator('.document-sidebar').evaluate(element => element.scrollWidth > element.clientWidth), false, 'English document navigation fits its sidebar')
    }
    await page.screenshot({ path: path.join(output, 'english-' + module + '.png') })
  }
  checks.push('seven-english-module-pages-fit-960px-after-route-content-ready')
  await navigate('/settings?module=software&scope=global&tab=appearance')
  await page.getByRole('heading', { name: 'Theme', exact: true }).waitFor()
  await page.getByLabel('Language / 界面语言', { exact: true }).selectOption('zh-CN')
  await page.getByRole('heading', { name: '主题', exact: true }).waitFor()
  assert.equal(await page.locator('.titlebar .tabs .tab > span:first-child').first().textContent(), '个人')
  checks.push('live-language-switch-persistence-user-content-and-title-preference-preserved')
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ status: 'passed', executable, profile, checks, errors }, null, 2))
  console.log('PASS ' + checks.join(', '))
} catch (error) {
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ status: 'failed', profile, checks, errors, failure: String(error), route: await page.evaluate(() => location.hash) }, null, 2))
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  throw error
} finally { await app.close().catch(() => {}) }
