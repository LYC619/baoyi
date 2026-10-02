/** Real Electron webpage entry; only synthetic localhost pages and isolated user data. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output = path.resolve('output/web-browser-ui'); fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, hide_hentai: true, theme: 'dark', proxy_mode: 'direct' })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value))
db.close()
const hits: string[] = []
let otherBase = ''
const server = http.createServer((req, res) => {
  hits.push(req.url || '/')
  if (req.url === '/disconnect') { req.socket.destroy(); return }
  if (req.url === '/redirect') { res.writeHead(302, { Location: otherBase + '/guide' }); res.end(); return }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><html lang="zh"><head><title>本机参考资料</title></head><body style="font-family:sans-serif;padding:36px;background:#f5f7fa;color:#233"><h1>${req.url === '/two' ? '第二页' : '本机参考资料'}</h1><p>这是通用网页浏览测试，无须导入作品清单。</p><a href="/two">第二页</a> · <a href="/redirect">跨站资料</a> · <a href="${otherBase}/guide" target="_blank">新窗口链接</a></body></html>`)
})
const other = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><title>另一个来源</title><h1>跨站参考资料</h1></html>') })
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`; otherBase = `http://127.0.0.1:${(other.address() as any).port}`
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('node_modules/electron/dist/electron.exe')
const args = process.argv[2] ? [`--user-data-dir=${profile}`] : [path.resolve('.'), `--user-data-dir=${profile}`]
let application: any
const evidence: string[] = [], errors: string[] = []
async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error('Timeout: ' + label)
}
async function menu(label: string) {
  await application.evaluate(({ BrowserWindow }: any, label: string) => {
    const win = BrowserWindow.getAllWindows().find((win: any) => win.__webBrowserTestMenu)
    const item = win?.__webBrowserTestMenu.items.find((item: any) => item.label === label)
    if (!item?.enabled) throw new Error('Unavailable browser menu: ' + label)
    item.click(item, win, {})
  }, label)
}
async function enterDiscovery(page: any) {
  // Visible controls appear after router.isReady() and app.mount(); preload alone
  // is available before startup routing and is not a navigation readiness signal.
  await page.getByRole('button', { name: /^影视\s/ }).click()
  await page.getByRole('button', { name: '找视频', exact: true }).click()
  await page.getByLabel('网页地址', { exact: true }).waitFor()
}
try {
  application = await _electron.launch({ executablePath, args, env, timeout: 45000 })
  assert.equal(path.resolve(await application.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  const page = await application.firstWindow(); page.on('pageerror', (error: Error) => errors.push(error.message))
  await page.waitForFunction(() => !!(window as any).baoyi)
  assert.equal(await page.evaluate(() => typeof (window as any).baoyi.video.discovery.web?.open), 'function', 'Missing generic webpage browser API')
  await application.evaluate(({ BrowserWindow }: any) => {
    const original = BrowserWindow.prototype.setMenu
    BrowserWindow.prototype.setMenu = function (value: any) { this.__webBrowserTestMenu = value; return original.call(this, value) }
  })
  await enterDiscovery(page)
  const address = page.getByLabel('网页地址', { exact: true })
  await address.fill('javascript:alert(1)'); await page.getByRole('button', { name: '打开网页', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /HTTP|网页地址/ }).waitFor()
  assert.equal(application.windows().length, 1)
  await address.fill(base)
  await page.getByLabel('来源名称（可选）').fill('我的参考资料')
  await page.getByRole('button', { name: '保存为来源', exact: true }).click()
  await page.getByRole('button', { name: '打开 我的参考资料', exact: true }).waitFor()
  await page.screenshot({ path: path.join(output, 'web-entry-dark.png') })
  evidence.push('empty-library-url-entry-and-source-saving')
  const opened = application.waitForEvent('window')
  await page.getByRole('button', { name: '打开网页', exact: true }).click()
  const viewer = await opened; await viewer.getByRole('heading', { name: '本机参考资料' }).waitFor()
  assert.equal(await viewer.evaluate(() => typeof (window as any).baoyi), 'undefined')
  assert.equal(await viewer.evaluate(() => typeof (window as any).require), 'undefined')
  assert.equal((await page.evaluate(() => (window as any).baoyi.video.discovery.sources())).length, 0)
  assert.equal((await page.evaluate(() => (window as any).baoyi.video.counts())).all, 0)
  await viewer.screenshot({ path: path.join(output, 'web-browser.png') })
  evidence.push('real-webpage-without-catalogue-or-local-inventory')
  await viewer.getByRole('link', { name: '第二页', exact: true }).click(); await viewer.getByRole('heading', { name: '第二页' }).waitFor()
  await menu('后退'); await viewer.getByRole('heading', { name: '本机参考资料' }).waitFor()
  await menu('前进'); await viewer.getByRole('heading', { name: '第二页' }).waitFor()
  const before = hits.filter(url => url === '/two').length; await menu('刷新')
  await waitFor(async () => hits.filter(url => url === '/two').length > before, 'reload request')
  await menu('主页'); await viewer.getByRole('heading', { name: '本机参考资料' }).waitFor()
  await viewer.getByRole('link', { name: '跨站资料', exact: true }).click(); await viewer.getByRole('heading', { name: '跨站参考资料' }).waitFor()
  await menu('更换网址'); await waitFor(() => address.inputValue().then((value: string) => value === otherBase + '/guide'), 'returned current address')
  evidence.push('back-forward-refresh-cross-origin-navigation-and-address-editing')
  await address.fill(base + '/disconnect'); await page.getByRole('button', { name: '打开网页', exact: true }).click()
  await viewer.getByRole('heading', { name: '网页加载失败' }).waitFor()
  await address.fill(base); await page.getByRole('button', { name: '打开网页', exact: true }).click()
  await viewer.getByRole('heading', { name: '本机参考资料' }).waitFor()
  await viewer.getByRole('link', { name: '新窗口链接', exact: true }).click()
  await viewer.getByRole('heading', { name: '本机参考资料' }).waitFor()
  assert.equal(viewer.url(), base + '/')
  assert.equal(application.windows().length, 2)
  await viewer.close(); evidence.push('error-recovery-reused-window-and-popup-blocking')
  await page.getByRole('button', { name: '编辑 我的参考资料', exact: true }).click()
  await page.getByLabel('来源名称（可选）').fill('资料入口')
  await page.getByRole('button', { name: '保存修改', exact: true }).click()
  await page.getByRole('button', { name: '打开 资料入口', exact: true }).waitFor()
  await page.setViewportSize({ width: 820, height: 740 }); await page.screenshot({ path: path.join(output, 'web-entry-narrow.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.screenshot({ path: path.join(output, 'web-entry-light.png') })
  await application.close()
  application = await _electron.launch({ executablePath, args, env, timeout: 45000 })
  const reopened = await application.firstWindow(); await reopened.waitForFunction(() => !!(window as any).baoyi)
  await enterDiscovery(reopened)
  await reopened.getByRole('button', { name: '打开 资料入口', exact: true }).waitFor()
  await reopened.getByRole('button', { name: '移除 资料入口', exact: true }).click()
  await waitFor(() => reopened.evaluate(async () => (await (window as any).baoyi.video.discovery.web.list()).length === 0), 'removed shortcut')
  assert.equal((await reopened.evaluate(() => (window as any).baoyi.video.counts())).all, 0)
  evidence.push('edit-restart-retention-remove-and-narrow-layout')
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ evidence, errors, profile, hits }, null, 2))
  console.log(`Web browser desktop verification: ${evidence.length} checks passed`)
} catch (error) {
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ evidence, errors, profile, hits, error: String(error) }, null, 2))
  if (application) await (await application.firstWindow()).screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  if (application) await application.close()
  server.closeAllConnections(); other.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => other.close(() => resolve()))
}
