import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { insertGame } from '../electron/kinds/game/db.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { inspectProject } from '../electron/kinds/project/scanner.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output = path.resolve('output/unified-ux'); fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-unified-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); initSchema(db, KINDS); db.exec(VIDEO_JOBS_SQL)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', hanime_builtin_hosts: false, hide_hentai: false, organize_root: path.join(root, 'organized'), ai: { enabled: false } })) {
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
}
const files: string[] = []
for (let i = 1; i <= 36; i++) {
  const id = 'ux-software-' + i, name = `体验软件 ${String(i).padStart(2, '0')}`
  const dir = path.join(root, name); fs.mkdirSync(dir)
  const file = path.join(dir, 'app.exe'); fs.writeFileSync(file, 'synthetic fixture, never execute'); files.push(file)
  db.prepare('INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,source_dir,name_zh,category,tags,ai_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'software', i, i, file, 'app.exe', dir, name, '其他', '["原标签"]', 'done')
  db.prepare('INSERT INTO software_meta(resource_id,is_portable,move_risk) VALUES(?,1,?)').run(id, 'safe')
}
const games: string[] = [], projects: string[] = []
db.exec(`CREATE TRIGGER ux_partial_failure BEFORE UPDATE OF tags ON resource
  WHEN OLD.id = 'ux-software-4' AND NEW.tags LIKE '%失败用例%'
  BEGIN SELECT RAISE(ABORT, 'fixture-write-failure'); END`)
for (let i = 1; i <= 3; i++) {
  const dir = path.join(root, '游戏' + i); fs.mkdirSync(dir); const exe = path.join(dir, 'game.exe'); fs.writeFileSync(exe, 'fixture'); files.push(exe)
  games.push(insertGame(db, { exe_path: exe, source_dir: dir, file_size: 7, name_zh: '体验游戏 ' + i, name_en: '', summary: '', description: '', category: '其他', tags: ['原标签'], official_url: '', save_paths: [], linked_files: [] }).id)
  const project = path.join(root, '项目' + i); fs.mkdirSync(project); const readme = path.join(project, 'README.md'); fs.writeFileSync(readme, '# 体验项目 ' + i); files.push(readme)
  projects.push(new ProjectLibrary(db).register(await inspectProject(project)).id)
}
const photos = path.join(root, '相册'); fs.mkdirSync(photos)
fs.writeFileSync(path.join(photos, '1.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7wAAAABJRU5ErkJggg==', 'base64'))
new ImageLibrary(db).register((await scanImageImport(photos, 'photo', false))[0]); db.close()
const executable = path.resolve(process.argv.slice(2).find(arg => arg.endsWith('.exe')) || 'node_modules/electron/dist/electron.exe')
const packed = !executable.includes('node_modules'), baseline = process.argv.includes('--baseline')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const args = [...(packed ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu']
let app = await _electron.launch({ executablePath: executable, args, env, timeout: 30000 })
let page = await app.firstWindow(); page.setDefaultTimeout(7000)
const results: Array<{ name: string; ok: boolean; error?: string }> = [], errors: string[] = []
page.on('pageerror', (e: Error) => errors.push(e.message))
const go = async (route: string) => {
  await page.evaluate((r: string) => { location.hash = r }, route)
  await page.waitForURL((url: URL) => url.hash === '#' + route)
  const selector = route === '/' ? '.toolbar__search' : route === '/organize' ? '.organize' : route === '/game' ? '.search__input' : route === '/project' ? '.pj-home' : route === '/image' ? '.image-home' : route === '/video' ? '[aria-label="影视分类与待处理"]' : null
  if (selector) await page.locator(selector).first().waitFor()
  await page.waitForFunction(() => !document.querySelector('.page-leave-active,.page-enter-active'))
}
async function check(name: string, run: () => Promise<void>) {
  try { await run(); results.push({ name, ok: true }); console.log('PASS ' + name) }
  catch (cause) { results.push({ name, ok: false, error: String(cause) }); console.log('FAIL ' + name + ': ' + String(cause).slice(0, 250)); await page.screenshot({ path: path.join(output, name + '-failure.png') }).catch(() => {}) }
}
try {
  assert.equal(path.resolve(await app.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  await page.waitForFunction(() => !!window.baoyi?.software)
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await check('organize-scroll-last-row', async () => {
    await go('/organize'); await page.locator('.line').nth(35).waitFor()
    const geometry = await page.locator('.organize .body').evaluate((el: HTMLElement) => {
      el.scrollTop = el.scrollHeight
      const last = el.querySelector('.line:last-child')!.getBoundingClientRect(), box = el.getBoundingClientRect()
      return { scroll: el.scrollTop, lastBottom: last.bottom, bottom: box.bottom }
    })
    assert.ok(geometry.scroll > 0, JSON.stringify(geometry)); assert.ok(geometry.lastBottom <= geometry.bottom + 1, JSON.stringify(geometry))
    await page.screenshot({ path: path.join(output, 'organize-bottom.png') })
  })
  await check('organize-cancel-home', async () => {
    await go('/settings'); await page.locator('.settings').first().waitFor().catch(() => {})
    await go('/organize'); await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.waitForURL((url: URL) => url.hash === '#/')
  })
  await check('active-module-home', async () => {
    await go('/organize'); await page.locator('.titlebar .tab').filter({ hasText: '软件' }).click()
    await page.waitForURL((url: URL) => url.hash === '#/')
  })
  await check('hanime-scope', async () => {
    await go('/video'); await page.getByRole('navigation', { name: '影视分类与待处理' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '从 Hanime 添加', exact: true }).count(), 0)
    await page.locator('.sidebar .row').filter({ hasText: '里番' }).click()
    await page.getByRole('button', { name: '从 Hanime 添加', exact: true }).waitFor()
    await page.locator('.sidebar .row').filter({ hasText: '电影' }).click()
    assert.equal(await page.getByRole('button', { name: '从 Hanime 添加', exact: true }).count(), 0)
  })
  await check('software-bulk-entry', async () => {
    await go('/'); await page.getByRole('button', { name: '批量管理', exact: true }).click()
    await page.getByRole('region', { name: '批量管理' }).waitFor()
  })
  if (!baseline) {
    await check('software-clear-filter-search-sync', async () => {
      await page.getByLabel('搜索软件', { exact: true }).fill('不存在的软件')
      await page.getByRole('button', { name: '清空筛选', exact: true }).click()
      assert.equal(await page.getByLabel('搜索软件', { exact: true }).inputValue(), '')
    })
    await check('software-bulk-workflow', async () => {
      const panel = page.getByRole('region', { name: '批量管理' })
      await page.getByRole('checkbox', { name: '选择 体验软件 01', exact: true }).check()
      await page.getByRole('checkbox', { name: '选择 体验软件 02', exact: true }).check()
      await panel.getByLabel('批量操作', { exact: true }).selectOption('tags')
      await panel.getByLabel('批量标签', { exact: true }).fill('体验统一')
      await panel.getByRole('button', { name: '添加标签所选 2 项', exact: true }).click()
      await panel.getByText('添加标签结束：成功 2 项', { exact: true }).waitFor()
      const tagged = await page.evaluate(() => window.baoyi.software.get('ux-software-1'))
      assert.deepEqual(tagged.tags, ['原标签', '体验统一'])
      await page.getByRole('checkbox', { name: '选择 体验软件 01', exact: true }).check()
      await panel.getByLabel('批量操作', { exact: true }).selectOption('archive')
      await panel.getByRole('button', { name: '归档所选 1 项', exact: true }).click()
      await panel.getByText('归档结束：成功 1 项', { exact: true }).waitFor()
      assert.equal((await page.evaluate(() => window.baoyi.software.get('ux-software-1'))).is_archived, true)
      await page.locator('.sidebar button').filter({ hasText: '已归档' }).click()
      await page.getByRole('checkbox', { name: '选择 体验软件 01', exact: true }).waitFor()
      await panel.getByRole('button', { name: '全选当前结果', exact: true }).click()
      await panel.getByLabel('批量操作', { exact: true }).selectOption('restore')
      await panel.getByRole('button', { name: '恢复到库所选 1 项', exact: true }).click()
      await panel.getByText('恢复到库结束：成功 1 项', { exact: true }).waitFor()
      await page.getByRole('button', { name: '清空筛选', exact: true }).click()
      await page.getByRole('checkbox', { name: '选择 体验软件 01', exact: true }).waitFor()
      await panel.getByRole('button', { name: '全选当前结果', exact: true }).click()
      await page.getByLabel('搜索软件', { exact: true }).fill('体验软件 03')
      await page.waitForFunction(() => document.querySelectorAll('.card__select').length === 1)
      assert.match(await panel.innerText(), /已选 1 \/ 1 项/)
      await page.getByLabel('搜索软件', { exact: true }).press('Control+a')
      assert.equal(await page.getByLabel('搜索软件', { exact: true }).evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!), 7)
      await panel.getByLabel('批量操作', { exact: true }).selectOption('remove')
      await panel.getByRole('button', { name: '移出资料库所选 1 项', exact: true }).click()
      await panel.getByRole('button', { name: '取消', exact: true }).click()
      assert.ok(await page.evaluate(() => window.baoyi.software.get('ux-software-3')))
      await panel.getByRole('button', { name: '移出资料库所选 1 项', exact: true }).click()
      await panel.getByRole('button', { name: '确认移出 1 项', exact: true }).click()
      await panel.getByText('移出资料库结束：成功 1 项', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.baoyi.software.get('ux-software-3')), null)
      await page.getByRole('button', { name: '清空筛选', exact: true }).click()
      await page.screenshot({ path: path.join(output, 'software-bulk-dark.png') })
      await panel.getByRole('button', { name: '退出批量管理', exact: true }).click()
    })
    await check('game-bulk-workflow', async () => {
      await go('/game'); await page.getByRole('button', { name: '批量管理', exact: true }).click()
      const panel = page.getByRole('region', { name: '批量管理' })
      await panel.getByRole('button', { name: '全选当前结果', exact: true }).click()
      await panel.getByLabel('批量操作', { exact: true }).selectOption('tags'); await panel.getByLabel('批量标签', { exact: true }).fill('统一游戏')
      await panel.getByRole('button', { name: '添加标签所选 3 项', exact: true }).click()
      await panel.getByText('添加标签结束：成功 3 项', { exact: true }).waitFor()
      assert.ok((await page.evaluate((id: string) => window.baoyi.game.get(id), games[0])).tags.includes('统一游戏'))
      await page.getByRole('checkbox', { name: '选择 体验游戏 1', exact: true }).check()
      await panel.getByLabel('批量操作', { exact: true }).selectOption('category')
      await panel.getByLabel('批量分类', { exact: true }).selectOption({ index: 1 })
      const category = await panel.getByLabel('批量分类', { exact: true }).inputValue()
      await panel.getByRole('button', { name: '修改分类所选 1 项', exact: true }).click(); await panel.getByText('修改分类结束：成功 1 项', { exact: true }).waitFor()
      assert.equal((await page.evaluate((id: string) => window.baoyi.game.get(id), games[0])).category, category)
      await page.getByRole('checkbox', { name: '选择 体验游戏 1', exact: true }).check()
      await panel.getByLabel('批量操作', { exact: true }).selectOption('archive')
      await panel.getByRole('button', { name: '归档所选 1 项', exact: true }).click(); await panel.getByText('归档结束：成功 1 项', { exact: true }).waitFor()
      await page.locator('.sidebar button').filter({ hasText: '已归档' }).click(); await page.getByRole('checkbox', { name: '选择 体验游戏 1', exact: true }).waitFor()
      await panel.getByRole('button', { name: '全选当前结果', exact: true }).click(); await panel.getByLabel('批量操作', { exact: true }).selectOption('restore')
      await panel.getByRole('button', { name: '恢复到库所选 1 项', exact: true }).click(); await panel.getByText('恢复到库结束：成功 1 项', { exact: true }).waitFor()
      await page.getByRole('button', { name: '清空筛选', exact: true }).click(); await page.getByRole('checkbox', { name: '选择 体验游戏 3', exact: true }).check()
      await panel.getByLabel('批量操作', { exact: true }).selectOption('remove'); await panel.getByRole('button', { name: '移出资料库所选 1 项', exact: true }).click()
      await panel.getByRole('button', { name: '确认移出 1 项', exact: true }).click(); await panel.getByText('移出资料库结束：成功 1 项', { exact: true }).waitFor()
      assert.equal(await page.evaluate((id: string) => window.baoyi.game.get(id), games[2]), null)
      await page.screenshot({ path: path.join(output, 'game-bulk-dark.png') })
      await panel.getByRole('button', { name: '清空选择', exact: true }).focus().catch(() => {})
      await panel.getByRole('button', { name: '退出批量管理', exact: true }).focus(); await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'hidden' })
    })
    await check('bulk-partial-failure-retry', async () => {
      await go('/'); await page.getByRole('button', { name: '批量管理', exact: true }).click()
      const panel = page.getByRole('region', { name: '批量管理' })
      for (const n of ['04', '05']) await page.getByRole('checkbox', { name: '选择 体验软件 ' + n, exact: true }).check()
      await panel.getByLabel('批量操作', { exact: true }).selectOption('tags'); await panel.getByLabel('批量标签', { exact: true }).fill('失败用例')
      await panel.getByRole('button', { name: '添加标签所选 2 项', exact: true }).click()
      await panel.getByText(/成功 1 项，失败 1 项/).waitFor()
      assert.match(await panel.locator('.bulk-errors').innerText(), /体验软件 04.*fixture-write-failure/)
      assert.equal(await page.getByRole('checkbox', { name: '选择 体验软件 04', exact: true }).isChecked(), true)
      assert.equal(await page.getByRole('checkbox', { name: '选择 体验软件 05', exact: true }).isChecked(), false)
      await page.screenshot({ path: path.join(output, 'partial-failure.png') })
      await panel.getByLabel('批量标签', { exact: true }).fill('重试成功')
      await panel.getByRole('button', { name: '添加标签所选 1 项', exact: true }).click()
      await panel.getByText('添加标签结束：成功 1 项', { exact: true }).waitFor()
      assert.ok((await page.evaluate(() => window.baoyi.software.get('ux-software-4'))).tags.includes('重试成功'))
      await panel.getByRole('button', { name: '退出批量管理', exact: true }).click()
    })
    await check('project-bulk-workflow', async () => {
      await go('/project'); await page.getByRole('button', { name: '批量管理', exact: true }).click()
      const panel = page.getByRole('region', { name: '批量管理' })
      await panel.getByRole('button', { name: '全选当前结果', exact: true }).click()
      await panel.getByLabel('批量操作', { exact: true }).selectOption('group'); await panel.getByLabel('批量分组', { exact: true }).fill('统一体验项目')
      await panel.getByRole('button', { name: '修改分组所选 3 项', exact: true }).click()
      await panel.getByText('修改分组结束：成功 3 项', { exact: true }).waitFor()
      assert.equal((await page.evaluate((id: string) => window.baoyi.project.get(id), projects[0])).group, '统一体验项目')
      await panel.getByRole('button', { name: '全选当前结果', exact: true }).click()
      await panel.getByLabel('批量操作', { exact: true }).selectOption('state'); await panel.getByLabel('批量状态', { exact: true }).selectOption('paused')
      await panel.getByRole('button', { name: '修改状态所选 3 项', exact: true }).click()
      await panel.getByText('修改状态结束：成功 3 项', { exact: true }).waitFor()
      await panel.getByRole('button', { name: '全选当前结果', exact: true }).click(); await panel.getByLabel('批量操作', { exact: true }).selectOption('category')
      await panel.getByLabel('批量分类', { exact: true }).selectOption('调研写作'); await panel.getByRole('button', { name: '修改分类所选 3 项', exact: true }).click()
      await panel.getByText('修改分类结束：成功 3 项', { exact: true }).waitFor()
      await panel.getByRole('button', { name: '全选当前结果', exact: true }).click(); await panel.getByLabel('批量操作', { exact: true }).selectOption('pin')
      await panel.getByRole('button', { name: '置顶所选 3 项', exact: true }).click(); await panel.getByText('置顶结束：成功 3 项', { exact: true }).waitFor()
      assert.equal((await page.evaluate((id: string) => window.baoyi.project.get(id), projects[0])).pinned, true)
      await page.locator(`[data-project-id="${projects[2]}"] input[type=checkbox]`).check(); await panel.getByLabel('批量操作', { exact: true }).selectOption('remove')
      await panel.getByRole('button', { name: '移出资料库所选 1 项', exact: true }).click(); await panel.getByRole('button', { name: '确认移出 1 项', exact: true }).click()
      await panel.getByText('移出资料库结束：成功 1 项', { exact: true }).waitFor(); assert.equal(await page.evaluate((id: string) => window.baoyi.project.get(id), projects[2]), null)
      await page.screenshot({ path: path.join(output, 'project-bulk-dark.png') })
      await panel.getByRole('button', { name: '退出批量管理', exact: true }).click()
      await page.getByLabel('搜索项目', { exact: true }).fill('不存在的项目')
      await page.getByRole('button', { name: '清空筛选', exact: true }).click(); assert.equal(await page.locator('.pj-card').count(), 2)
    })
    await check('photo-bulk-and-empty-filter', async () => {
      await go('/image'); await page.getByRole('button', { name: '照片', exact: true }).click()
      await page.getByRole('button', { name: '批量整理', exact: true }).click()
      assert.equal(await page.getByLabel('批量已读状态', { exact: true }).count(), 0)
      assert.equal(await page.getByText('按分类建立文件夹', { exact: true }).count(), 0)
      await page.getByRole('button', { name: '全选筛选结果', exact: true }).click()
      await page.getByLabel('批量标签', { exact: true }).fill('统一相册')
      await page.getByRole('button', { name: '应用到所选', exact: true }).click()
      await page.getByText('已更新 1 项', { exact: true }).waitFor()
      await page.getByRole('button', { name: '批量整理', exact: true }).focus(); await page.keyboard.press('Escape')
      await page.getByLabel('批量标签', { exact: true }).waitFor({ state: 'hidden' })
      await page.getByLabel('搜索图片库', { exact: true }).fill('不存在的照片')
      await page.getByRole('button', { name: '清空筛选', exact: true }).click()
      assert.equal(await page.getByLabel('搜索图片库', { exact: true }).inputValue(), '')
      await page.screenshot({ path: path.join(output, 'photo-dark.png') })
    })
    await check('five-module-navigation-and-width', async () => {
      for (const [route, label] of [['/', '软件'], ['/game', '游戏'], ['/video', '影视'], ['/image', '图片'], ['/project', '项目']]) {
        await go(route)
        assert.equal(await page.locator('.app').evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth), false, label + ' horizontal overflow')
        await go('/settings'); await page.locator('.titlebar .tab').filter({ hasText: label }).click()
        await page.waitForURL((url: URL) => url.hash === '#' + route)
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
      await page.screenshot({ path: path.join(output, 'project-light.png') })
    })
    await check('restart-persistence', async () => {
      await app.close(); app = await _electron.launch({ executablePath: executable, args, env, timeout: 30000 }); page = await app.firstWindow()
      await page.waitForFunction(() => !!window.baoyi?.project)
      assert.equal((await page.evaluate((id: string) => window.baoyi.project.get(id), projects[0])).state, 'paused')
      assert.ok((await page.evaluate(() => window.baoyi.software.get('ux-software-1'))).tags.includes('体验统一'))
    })
    await check('organize-result-return', async () => {
      await go('/organize'); await page.locator('.line').first().waitFor()
      await page.locator('.segmented').getByRole('button', { name: '跳过', exact: true }).click()
      await page.locator('.line').first().locator('select').first().selectOption('junction')
      page.once('dialog', (dialog: any) => dialog.accept())
      await page.getByRole('button', { name: '执行整理', exact: true }).click()
      const result = page.getByRole('region', { name: '本次整理结果' })
      await result.waitFor(); assert.match(await result.innerText(), /创建链接 1 项.*失败 0 项/)
      await page.screenshot({ path: path.join(output, 'organize-result.png') })
      await page.getByRole('button', { name: '完成并返回软件库', exact: true }).click(); await page.waitForURL((url: URL) => url.hash === '#/')
    })
  }
} finally {
  for (const file of files) assert.ok(fs.existsSync(file), '原文件必须保留：' + file)
  await app.close()
  fs.writeFileSync(path.join(output, baseline ? 'baseline.json' : 'report.json'), JSON.stringify({ executable, profile, root, results, errors }, null, 2))
}
if (results.some(row => !row.ok) || errors.length) process.exitCode = 1

