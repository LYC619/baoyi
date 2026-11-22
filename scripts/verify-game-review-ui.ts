import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { insertGame, updateGame } from '../electron/kinds/game/db.ts'
import { reserveWorkDirectory, writeBundleFiles } from '../electron/kinds/video/bundle.ts'
import { registerVideoBundleData } from '../electron/kinds/video/registration.ts'
import { loadPlaywright, electronTestEnv } from './helpers/playwright.ts'

const executable = process.argv[2] || 'development'
const output = path.resolve(process.argv[3] || 'output/game-review-2026-11-08/native')
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const fixtures = path.join(profile, 'fixtures'); fs.mkdirSync(fixtures)
const write = (name: string) => { const p = path.join(fixtures, name); fs.writeFileSync(p, 'isolated fixture'); return p }
const save = write('slot.dat'), alternate = write('alternate.cmd'), trainer = write('trainer.cmd')
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', video_updates_weekly: false })) {
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
}
const ids = ['测试甲', '测试乙', '路径缺失', '测试丙', '测试丁'].map((name, i) => {
  const item = insertGame(db, { exe_path: write(`game${i}.cmd`), name_zh: name, name_en: '', category: '冒险', tags: [], summary: '一句话测试', description: '说明', official_url: '', source_dir: fixtures, file_size: 1, save_paths: i ? [] : [{ path: save, verified_at: 0 }], linked_files: [{ path: alternate, type: 'other', role: 'launcher', label: '备用入口' }, { path: trainer, type: 'trainer', label: '测试工具' }] })
  updateGame(db, item.id, { play_status: i ? 'unplayed' : 'playing', last_played_at: i ? 0 : Date.now() - 1000 })
  return item.id
})
fs.unlinkSync(path.join(fixtures, 'game2.cmd'))
const videoIds = Array.from({ length: 5 }, (_, i) => {
  const title = '切换影视' + i, { directory, bundleId } = reserveWorkDirectory(fixtures, title, 'rapid-' + i)
  const file = path.join(directory, '1.mp4'); fs.writeFileSync(file, 'isolated media index fixture')
  const bundle = writeBundleFiles({ directory, bundleId, title, description: '仅用于详情读取', files: [{ path: file, title: '内容' + i, order: 1 }] }).bundle
  return registerVideoBundleData(db, directory, bundle).resourceId
})
db.close()
const { _electron } = loadPlaywright()
const app = await _electron.launch({ executablePath: path.resolve(executable === 'development' ? 'node_modules/electron/dist/electron.exe' : executable), args: [...(executable === 'development' ? [path.resolve('.')] : []), '--user-data-dir=' + profile, '--disable-gpu'], env: electronTestEnv() })
const page = await app.firstWindow({ timeout: 30000 }), checks: string[] = [], failures: { name: string; error: string }[] = [], errors: string[] = []
page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => void d.accept())
const route = async (target: string) => { await page.evaluate(target => { location.hash = target }, target) }
const detail = async (id: string, title: string) => { await route('/game/' + id); await page.getByLabel('游戏名', { exact: true }).waitFor(); await page.waitForFunction(title => (document.querySelector('.hero__name') as HTMLInputElement)?.value === title, title) }
const check = async (name: string, fn: () => Promise<void>) => { try { await fn(); checks.push(name); console.log('PASS ' + name) } catch (e) { failures.push({ name, error: e instanceof Error ? e.stack || e.message : String(e) }); console.error('FAIL ' + name + ': ' + e) } }
const backupText = () => page.locator('.hero-stats>div').filter({ hasText: '存档备份' }).locator('b')
const backedCount = () => page.locator('.sidebar .row').filter({ has: page.locator('.row__label', { hasText: /^已备份$/ }) }).locator('.row__count')
try {
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), profile)
  await app.evaluate(({ BrowserWindow, shell }: any) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(800, 640); win.setSize(1366, 900); (globalThis as any).__opened = []; shell.openPath = async (p: string) => { (globalThis as any).__opened.push(p); return '' } })
  await page.waitForFunction(() => !!window.baoyi?.game)
  await check('面包屑随滚动显示、窄窗隐藏，标题与说明对齐', async () => {
    await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(1366, 640))
    await detail(ids[0], '测试甲')
    assert.equal(await page.locator('.breadcrumb-sep').evaluate(e => getComputedStyle(e).opacity), '0')
    const positions = await page.locator('.hero__name,.hero__summary').evaluateAll(els => els.map(e => { const c = getComputedStyle(e); return e.getBoundingClientRect().left + parseFloat(c.paddingLeft) + parseFloat(c.borderLeftWidth) }))
    assert.ok(Math.abs(positions[0] - positions[1]) < 1, JSON.stringify(positions))
    await page.locator('.detail').evaluate(e => { e.scrollTop = 300; e.dispatchEvent(new Event('scroll')) })
    fs.writeFileSync(path.join(output, 'scroll-probe.json'), JSON.stringify(await page.locator('.detail').evaluate(e => ({width:innerWidth,height:innerHeight,scrollTop:e.scrollTop,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,separator:document.querySelector('.breadcrumb-sep')?.outerHTML})),null,2))
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.breadcrumb-sep')!).opacity === '1')
    await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(940, 640))
    await page.waitForFunction(() => Math.abs(innerWidth - 940) <= 2)
    assert.equal(await page.locator('.breadcrumb-sep').evaluate(e => getComputedStyle(e).display), 'none')
    assert.equal(await page.locator('.breadcrumb-title').evaluate(e => getComputedStyle(e).display), 'none')
    assert.equal(await page.evaluate(() => { const d = document.querySelector('.detail')!; return d.scrollWidth > d.clientWidth || document.documentElement.scrollWidth > innerWidth }), false)
    await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(1366, 900))
  })
  await check('中文组词回车不提交，确认后的回车保存完整标签', async () => {
    await detail(ids[0], '测试甲'); const input = page.getByLabel('添加游戏标签'); await input.fill('中文标签')
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 })
    assert.equal(await input.inputValue(), '中文标签'); assert.deepEqual((await page.evaluate(id => window.baoyi.game.get(id), ids[0]))!.tags, [])
    await input.press('Enter'); await page.getByLabel('删除标签 中文标签').waitFor()
    assert.deepEqual((await page.evaluate(id => window.baoyi.game.get(id), ids[0]))!.tags, ['中文标签'])
  })
  await check('未分类为零时隐藏，正在查看空分类时保留入口', async () => {
    await route('/game'); await page.locator('.gameCard').first().waitFor()
    assert.equal(await page.locator('.sidebar .row').filter({ hasText: '未分类' }).count(), 0)
    await page.evaluate(id => window.baoyi.game.update(id, { category: '' }), ids[1]); await page.reload()
    const row = page.locator('.sidebar .row').filter({ hasText: '未分类' }); await row.waitFor(); await row.click()
    await page.getByRole('button', { name: '查看游戏 测试乙', exact: true }).click(); await page.getByLabel('游戏分类').fill('冒险'); await page.getByLabel('游戏分类').press('Tab')
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar .row')].some(e => e.textContent?.includes('未分类') && e.querySelector('.row__count')?.textContent === '0'))
    assert.equal(await row.count(), 1); await page.locator('.sidebar .row').filter({ hasText: '全部游戏' }).click(); await page.locator('.gameCard').first().waitFor(); assert.equal(await row.count(), 0)
  })
  await check('继续游玩允许未知路径状态，已知失效时两个启动按钮都禁用', async () => {
    await app.evaluate(({ ipcMain }: any, id: string) => {
      const handlers = ipcMain._invokeHandlers, original = handlers.get('game:list'); (globalThis as any).__listOriginal = original; (globalThis as any).__pathState = undefined
      handlers.set('game:list', async (...args: any[]) => (await original(...args)).map((g: any) => g.id === id ? { ...g, path_state: (globalThis as any).__pathState } : g))
    }, ids[0])
    await page.reload(); await page.locator('.resume').waitFor(); assert.equal(await page.locator('.resume').getByRole('button', { name: '启动', exact: true }).isEnabled(), true)
    await app.evaluate(() => { (globalThis as any).__pathState = 'offline' }); await page.reload(); await page.locator('.resume').waitFor()
    assert.equal(await page.locator('.resume').getByRole('button', { name: '启动', exact: true }).isDisabled(), true)
    assert.equal(await page.locator('.resume').getByRole('button', { name: '连同修改器', exact: true }).isDisabled(), true)
  })
  await app.evaluate(({ ipcMain }: any) => ipcMain._invokeHandlers.set('game:list', (globalThis as any).__listOriginal))
  await check('详情缺失入口禁用，备用入口仍可启动', async () => {
    await detail(ids[2], '路径缺失'); await page.locator('.path-warning').waitFor()
    assert.equal(await page.locator('.split-launch>.btn').isDisabled(), true)
    await page.getByRole('button', { name: '选择启动方式', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '★ game2.cmd', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '备用入口', exact: true }).click()
    assert.ok((await app.evaluate(() => (globalThis as any).__opened)).includes(alternate))
    await page.getByRole('tab', { name: '文件与封面', exact: true }).click()
    assert.equal(await page.locator('.entry-row').filter({ hasText: 'game2.cmd' }).getByRole('button', { name: '启动', exact: true }).isDisabled(), true)
  })
  await check('备份与删除立即刷新详情份数和侧栏游戏数', async () => {
    await detail(ids[0], '测试甲'); await page.getByRole('tab', { name: '存档与备份', exact: true }).click()
    await page.getByRole('button', { name: '立即备份', exact: true }).click(); await page.locator('.app-dialog [data-dialog-confirm]').click(); await page.locator('.backup').waitFor()
    assert.equal(await backupText().innerText(), '1 份')
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar .row')].some(e => e.querySelector('.row__label')?.textContent === '已备份' && e.querySelector('.row__count')?.textContent === '1'))
    await page.locator('.backup').getByRole('button', { name: '删掉这份备份', exact: true }).click(); await page.locator('.app-dialog [data-dialog-confirm]').click()
    await page.waitForFunction(() => document.querySelectorAll('.backup').length === 0)
    assert.equal(await backupText().innerText(), '0 份')
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar .row')].some(e => e.querySelector('.row__label')?.textContent === '已备份' && e.querySelector('.row__count')?.textContent === '0'))
    // Retain one real backup to test late replies and the difference in count units.
    await page.getByRole('button', { name: '立即备份', exact: true }).click(); await page.locator('.app-dialog [data-dialog-confirm]').click(); await page.locator('.backup').waitFor()
  })
  await check('快速切换游戏不带入旧备份，侧栏与详情的计数单位明确', async () => {
    await route('/game'); await page.locator('.gameCard').first().waitFor()
    await app.evaluate(({ ipcMain }: any, id: string) => {
      const handlers = ipcMain._invokeHandlers, original = handlers.get('game:backups'); (globalThis as any).__backupOriginal = original
      handlers.set('game:backups', async (...args: any[]) => { const result = await original(...args); if (args[1] === id) await new Promise(resolve => { (globalThis as any).__releaseBackups = () => resolve(undefined) }); return result })
    }, ids[0])
    await detail(ids[0], '测试甲')
    for (let i = 0; i < 60 && !(await app.evaluate(() => !!(globalThis as any).__releaseBackups)); i++) await new Promise(r => setTimeout(r, 50))
    assert.equal(await app.evaluate(() => !!(globalThis as any).__releaseBackups), true)
    for (const index of [2, 3, 4, 1]) { await route('/game/' + ids[index]); await page.waitForTimeout(70) }
    await page.waitForFunction(() => (document.querySelector('.hero__name') as HTMLInputElement)?.value === '测试乙')
    await page.waitForFunction(() => document.querySelector('.hero-stats>div:last-child b')?.textContent === '0 份')
    await app.evaluate(() => (globalThis as any).__releaseBackups()); await page.waitForTimeout(200)
    assert.equal(await backupText().innerText(), '0 份'); assert.equal(await backedCount().innerText(), '1')
    assert.match(await page.locator('.sidebar .row').filter({ hasText: /^已备份/ }).getAttribute('title') || '', /游戏/)
  })
  await app.evaluate(({ ipcMain }: any) => { if ((globalThis as any).__backupOriginal) ipcMain._invokeHandlers.set('game:backups', (globalThis as any).__backupOriginal) })
  await route('/game/' + ids[0]); await page.getByLabel('游戏名', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.hero-stats>div:last-child b')?.textContent === '1 份')
  await check('游玩结束刷新资料时保留当前备份统计', async () => {
    await app.evaluate(({ BrowserWindow }: any, id: string) => BrowserWindow.getAllWindows()[0].webContents.send('game:session', { id, counted: false, message: '隔离会话结束' }), ids[0])
    await page.getByText('隔离会话结束', { exact: true }).waitFor()
    await page.waitForTimeout(150)
    assert.equal(await backupText().innerText(), '1 份')
  })
  // One compact screenshot is an optional visual aid; checks above use DOM and real IPC.
  await page.screenshot({ path: path.join(output, 'detail.png'), scale: 'css' })
  await check('连续切换五部影视，迟到的旧内容不覆盖最后一部', async () => {
    await app.evaluate(({ ipcMain }: any, id: string) => {
      const handlers = ipcMain._invokeHandlers, original = handlers.get('video:library'); (globalThis as any).__videoLibraryOriginal = original
      handlers.set('video:library', async (...args: any[]) => { const result = await original(...args); if (args[1] === id) await new Promise(resolve => { (globalThis as any).__releaseVideoLibrary = resolve }); return result })
    }, videoIds[0])
    try {
      await route('/video/' + videoIds[0])
      for (let i = 0; i < 100 && !(await app.evaluate(() => !!(globalThis as any).__releaseVideoLibrary)); i++) await page.waitForTimeout(50)
      assert.equal(await app.evaluate(() => !!(globalThis as any).__releaseVideoLibrary), true)
      for (const id of videoIds.slice(1)) { await route('/video/' + id); await page.waitForTimeout(70) }
      await page.getByRole('heading', { name: '切换影视4', exact: true }).waitFor()
      await app.evaluate(() => (globalThis as any).__releaseVideoLibrary())
      await page.waitForTimeout(200)
      assert.equal(await page.locator('.hero__title').innerText(), '切换影视4')
      assert.ok((await page.locator('.detail').innerText()).includes('内容4'))
      assert.ok(!(await page.locator('.detail').innerText()).includes('内容0'))
    } finally {
      await app.evaluate(({ ipcMain }: any) => { (globalThis as any).__releaseVideoLibrary?.(); ipcMain._invokeHandlers.set('video:library', (globalThis as any).__videoLibraryOriginal) })
    }
  })
  if (process.env.BAOYI_SIDEBAR_PHASE) await check('软件、游戏、影视侧栏逐项筛选并留存对照', async () => {
    const directory = path.resolve('output/refactor-20261109/02.5-sidebars'); fs.mkdirSync(directory, { recursive: true })
    for (const [module, target] of [['software', '/'], ['game', '/game'], ['video', '/video']]) {
      await route(target); await page.locator('.sidebar').waitFor()
      await page.waitForFunction(() => !document.querySelector('.page-enter-active,.page-leave-active'))
      await page.locator('.sidebar .row').first().click(); await page.waitForTimeout(150)
      const sidebar = page.locator('.sidebar')
      const rows = await sidebar.locator('.row').evaluateAll(elements => elements.map(e => {
        const style = getComputedStyle(e), label = e.querySelector('.row__label')!, count = e.querySelector('.row__count')!
        return { label: label.textContent, count: count.textContent, title: e.getAttribute('title'), active: e.classList.contains('row--active'), height: e.getBoundingClientRect().height, color: style.color, labelWhiteSpace: getComputedStyle(label).whiteSpace, countColor: getComputedStyle(count).color }
      }))
      const phase = process.env.BAOYI_SIDEBAR_PHASE!
      await sidebar.screenshot({ path: path.join(directory, module + '-' + phase + '.png') })
      const file = path.join(directory, module + '-' + phase + '.json'); fs.writeFileSync(file, JSON.stringify(rows, null, 2))
      if (phase === 'after') assert.deepEqual(rows, JSON.parse(fs.readFileSync(path.join(directory, module + '-before.json'), 'utf8')))
      for (const row of rows) {
        await sidebar.locator('.row').first().click(); await page.waitForTimeout(30)
        const button = sidebar.locator('.row').filter({ has: page.locator('.row__label', { hasText: new RegExp('^' + row.label + '$') }) })
        await button.click()
        await page.waitForFunction(label => [...document.querySelectorAll('.sidebar .row--active')].some(e => e.querySelector('.row__label')?.textContent === label), row.label)
      }
    }
  })
  assert.deepEqual(errors, [])
} finally {
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ passed: checks.length, checks, failures, errors, profile, executable, boundary: 'Native Electron, DOM layout and real SQLite/save operations in an isolated profile. Composition event is synthetic; OS opens are recorded, not executed. Path status and backup latency use wrappers around real IPC.' }, null, 2))
  await app.close()
}
assert.deepEqual(failures, [])
