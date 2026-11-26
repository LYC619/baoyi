import assert from 'node:assert/strict'
import { createChecker } from './check-i18n.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { settingsModule, MODULE_TABS } from '../src/composables/useModules.ts'
import { applyLanguage, locale, resolveLocale, tr, systemMessage, number } from '../src/i18n/index.ts'
import { libraryBlocks, libraryDirectoryGroup } from '../src/utils/library-grouping.ts'
import { onlineProbeMessage } from '../src/utils/online-probe.ts'
import { collectionName } from '../src/utils/video-series.ts'
import { categoryMoveConfirmation } from '../src/utils/softwareCategory.ts'
import { validateLanguageSetting } from '../electron/ipc/validate.ts'
import { setLocaleReader } from '../src/i18n/core.ts'
import { setNativeLanguage } from '../electron/services/system/language.ts'
import { formatRelative } from '../src/utils/index.ts'
for (const { key } of MODULE_TABS) {
  assert.equal(settingsModule(key, 'appearance', 'software'), key)
  assert.equal(settingsModule(undefined, 'appearance', key), key)
  assert.equal(settingsModule(key, 'downloads', 'software'), key)
  assert.equal(settingsModule(key, 'organize', 'software'), key)
}
assert.equal(settingsModule('wrong', 'search', 'game'), 'game')
assert.equal(settingsModule(undefined, 'project', 'software'), 'project')
assert.equal(settingsModule('video', 'organize', 'video'), 'video')
assert.equal(settingsModule(undefined, 'organize', 'video'), 'software')
assert.equal(settingsModule(undefined, 'downloads', 'game'), 'video')
assert.equal(settingsModule(undefined, 'saves', 'software'), 'game')
assert.equal(settingsModule(undefined, 'document', 'software'), 'document')
console.log('PASS settings module restoration, shared pages and video-specific deep links')

assert.equal(resolveLocale('system', ['en-US']), 'en')
assert.equal(resolveLocale('system', ['zh-TW']), 'zh-CN')
assert.equal(resolveLocale('system', ['fr-FR']), 'en')
assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN')
for (const language of ['system','en','zh-CN']) assert.equal(validateLanguageSetting(language), language)
for (const language of ['fr', '', null, {}, ['en']]) assert.throws(() => validateLanguageSetting(language))
locale.value = 'en'
assert.equal(MODULE_TABS[0].label, 'Personal')
assert.equal(tr('保存失败：{p0}', { p0: 'C:\\资料\\原文.txt' }), 'Could not save: C:\\资料\\原文.txt')
assert.equal(tr('constructor'), 'constructor')
assert.equal(tr('用户自己的笔记'), '用户自己的笔记')
assert.equal(systemMessage('保存失败：磁盘离线'), 'Could not save: Drive offline')
assert.equal(number(12345.6), '12,345.6')
assert.equal(formatRelative(Date.now() - 31 * 86400000), '1 month ago')
assert.equal(systemMessage('游戏正在启动，请等待后关闭游戏再还原'), 'The game is starting. Wait, then close it before restoring.')
assert.equal(systemMessage('关联文件不存在：C:\\资料\\正文.txt'), 'Linked file not found: C:\\资料\\正文.txt')
assert.equal(systemMessage('图片尺寸太小（20 × 30），短边至少 40、长边至少 60 像素'), 'The image is too small (20 × 30). The short side must be at least 40 pixels and the long side at least 60 pixels.')
const unmatched = '图片尺寸太小（' + ' × '.repeat(500) + '未匹配'
assert.equal(systemMessage(unmatched), unmatched, 'unmatched repeated delimiters remain intact without regex backtracking')
setNativeLanguage('en', ['zh-CN'])
assert.equal(tr('选择存档备份存放目录'), 'Choose save backup folder')
setNativeLanguage('system', ['zh-TW'])
assert.equal(tr('选择存档备份存放目录'), '选择存档备份存放目录')
setLocaleReader(() => locale.value)
locale.value = 'zh-CN'
assert.equal(MODULE_TABS[0].label, '个人', 'constant navigation labels react without remounting or losing drafts')
console.log('PASS language selection, runtime validation, live navigation labels, formatting and untouched interpolated content')

applyLanguage('en')
assert.equal(libraryDirectoryGroup('', []).name, 'Unknown location')
assert.equal(libraryDirectoryGroup('D:/Games/Game', ['D:/Games']).name, 'Games · Direct children')
const groups = libraryBlocks([{ category: '' }, { category: '用户分类' }, { category: 'unclassified' }], 'category', item => item.category, () => '', [])
assert.equal(groups.find(group => group.key === 'unclassified')!.name, tr('未分类'))
assert.equal(groups.find(group => group.key === 'category:用户分类')!.name, '用户分类')
assert.equal(groups.length, 3, 'custom names cannot collide with the unclassified group')
assert.equal(collectionName(['Alpha', 'Zebra']), tr('{p0}（{p1} 集）', { p0: 'Selected titles', p1: 2 }))
assert.doesNotMatch(onlineProbeMessage({ outcome: 'response_received', status: 200, resolved: '', sampleTruncated: true } as any), /\p{Script=Han}/u)
const confirmation = categoryMoveConfirmation([{ id: 's', name: 'App', preview: { from: 'C:/User', to: 'D:/User', warning: '目录已存在' } as any }])
assert.ok(confirmation.endsWith('Continue?'))
assert.ok(confirmation.includes(systemMessage('目录已存在')))
applyLanguage('zh-CN')
console.log('PASS English library labels, collection names, network summaries and category confirmations')

for (const [source, ui] of [
  ["tr('完成{p0}', { p0: done ? '已停止' : '完成' })", false],
  ["$t('完成{p0}', { p0: `还有 ${count} 项` })", true],
  ["({ none: '不分组' })", true],
  ["Menu.buildFromTemplate([{ label: '下载当前视频' }])", false],
  ["dialog.showErrorBox('启动失败', '请重试')", false],
  ["invalidArg('url', '不是合法链接')", false],
  ["new Error(`错${detail}`)", false]
] as const) {
  const check = createChecker({ '完成{p0}': 'Done {p0}', '错{p0}': 'Error {p0}' })
  check.script(source, '/electron/fixture.ts', ui)
  assert.ok(check.failures.length > 0, 'The checker must reject: ' + source)
}
const clean = createChecker({ '完成{p0}': 'Done {p0}', '已停止': 'Stopped', '完成': 'Done', '下载当前视频': 'Download current video', '不是合法链接': 'Not a valid URL' })
clean.script("tr('完成{p0}', { p0: done ? tr('已停止') : tr('完成') }); Menu.buildFromTemplate([{label:tr('下载当前视频')}]); invalidArg('url','不是合法链接')", '/electron/fixture.ts')
clean.script("item.category === '里番'", '/src/fixture.vue', true)
assert.deepEqual(clean.failures, [])
console.log('PASS checker covers template expressions, parameters, native menus, errors, reasons and short templates')

for (const [mode, preferred, expected] of [['all', 'zh-CN', 'zh-CN'], ['all', 'en-US', 'en'], ['library', 'zh-CN', 'en']] as const) {
  let settings = { language: 'en' }, pickedTitle = '', resets = 0
  const handlers = new Map<string, (...args: any[]) => any>()
  const mocks: Record<string, unknown> = {}
  for (const dependency of [
    '../archive/library.ts', '../kinds/software/aiService', '../services/storage/identify-records.ts',
    '../kinds/software/db.ts', '../services/taxonomy/taxonomy-store.ts', '../services/storage/task-records.ts',
    '../services/storage/portable', '../kinds/video/tmdb', '../services/network/searchService',
    '../services/network/proxy', '../services/network/online-network.ts', '../services/network/proxy-rules.ts'
  ]) mocks[dependency] = {}
  Object.assign(mocks, {
    electron: { app: { getPath: () => '/isolated-fixture', getPreferredSystemLanguages: () => [preferred] }, dialog: { showOpenDialog: async (_win: unknown, options: any) => { pickedTitle = options.title; return { canceled: true } } } },
    '../kinds/project/activity.ts': { assertProjectRunsStopped() {} },
    './library-backup.ts': { assertLibraryIdle() {} },
    '../services/system/lifecycle.ts': { stopServices: async (...actions: (() => unknown)[]) => { for (const action of actions) await action() } },
    '../services/storage/reset-files.ts': { removeProfileEntry: async () => {} },
    '../services/storage/database': { getDb: () => ({}), resetData: (value: string) => { resets++; if (value === 'all') settings = { language: 'system' }; return 'reset complete' } },
    '../services/storage/settings-store.ts': { getSettings: () => settings },
    '../services/hanime/hanime-browser.ts': { createHanimeBrowser: () => ({}) },
    './archive.ts': { closeArchiveAssistant: async () => {} },
    './video-preview.ts': { closeVideoPreview() {} },
    './comic-ingest.ts': { reopenComicIngest() {}, stopComicIngest: async () => {} }
  })
  const load = createRendererLoader(mocks)
  const i18n = load('src/i18n/index.ts')
  i18n.applyLanguage('en')
  load('electron/ipc/system.ts').registerSystemIpc(() => ({}), {
    handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), on() {}
  }, { activity: { reset: (action: () => unknown) => action() }, send() {}, resetVideoHistory() {}, imageSource: { stop() {}, reset() {} }, resetComic: async () => {} })
  const result = await handlers.get('data:reset')!(null, mode)
  assert.equal(resets, 1)
  assert.equal(result.settings.language, mode === 'all' ? 'system' : 'en')
  assert.equal(load('src/i18n/core.ts').currentLocale.value, expected)
  await handlers.get('data:pick-save-backup-root')!()
  assert.equal(pickedTitle, expected === 'en' ? 'Choose save backup folder' : '选择存档备份存放目录')
}
console.log('PASS reset handler immediately applies reset settings to native dialog language')
