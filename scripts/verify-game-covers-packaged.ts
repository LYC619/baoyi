/** Exercise the shipped game UI/IPC with fake launchers, decodable PNGs and offline network responses. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { pngFixture } from './verify-game-covers-fixtures.ts'

const require = createRequire(import.meta.url)
const runtime = process.env.BAOYI_PLAYWRIGHT || 'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { _electron } = require(runtime), { expect } = require(runtime + '/test')
const executable = path.resolve(process.argv[2] || 'release/0.8.0-integration-20260912/win-unpacked/抱一.exe')
assert.ok(fs.existsSync(executable))
for (const marker of ['portable.txt', '绿色版.txt']) assert.ok(!fs.existsSync(path.join(path.dirname(executable), marker)))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-game-package-'))
const outputRoot = path.resolve('.planning/ux-execution-20260908/packaged-ui')
fs.mkdirSync(outputRoot, { recursive: true })
const output = fs.mkdtempSync(path.join(outputRoot, 'game-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'light' })) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
db.close()
function file(name: string, contents: string | Buffer) {
  const target = path.join(profile, 'fixtures', name)
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents)
  return target
}
const portalExe = file('Portal/Portal.exe', 'isolated Portal launcher')
const genshinExe = file('Genshin/launcher.exe', 'isolated Genshin launcher')
file('Genshin/config.ini', 'game_biz=hk4e_cn\ngame_start_name=YuanShen.exe\n')
const localPoster = file('Genshin/poster.png', pngFixture(512, 256))
const invalidImage = file('invalid.png', 'not an image')
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.VITE_DEV_SERVER_URL
const app = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], env: environment, timeout: 30000 })
const checks: string[] = [], errors: string[] = []
let page: any
async function check(name: string, action: () => Promise<void>) { await action(); checks.push(name); console.log('PASS', name) }
async function chosenPath(value: string) { await app.evaluate((_electron: unknown, value: string) => { (globalThis as any).__gameFixture.nextPath = value }, value) }
try {
  assert.equal(path.resolve(await app.evaluate(({ app }: any) => app.getPath('userData'))).toLowerCase(), profile.toLowerCase())
  page = await app.firstWindow(); page.setDefaultTimeout(12000)
  page.on('pageerror', (error: Error) => errors.push(error.message))
  page.on('console', (message: any) => { if (message.type() === 'error' && /Content Security Policy|could not be cloned/i.test(message.text())) errors.push(message.text()) })
  await page.waitForFunction(() => !!(window as any).baoyi)
  await app.evaluate(({ net, dialog }: any, input: any) => {
    const state = { nextPath: input.path, requests: [] as string[], originalFetch: net.fetch, originalOpen: dialog.showOpenDialog }
    ;(globalThis as any).__gameFixture = state
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [state.nextPath] })
    net.fetch = async (target: any) => {
      const url = typeof target === 'string' ? target : target.url
      if (url.startsWith('file:')) return state.originalFetch(target)
      state.requests.push(url)
      if (url.includes('/api/storesearch/')) return Response.json({ items: [{ id: 400, name: 'Portal', type: 'app' }, { id: 620, name: 'Portal 2', type: 'app' }] })
      const png = url.startsWith('https://act-webstatic.mihoyo.com/') ? input.wide : input.portrait
      return new Response(new Uint8Array(Buffer.from(png, 'base64')), { headers: { 'content-type': 'image/png' } })
    }
  }, { path: portalExe, portrait: pngFixture(256, 384).toString('base64'), wide: pngFixture(512, 256).toString('base64') })
  let portal: any, genshin: any
  await check('manual registration works without AI and preserves launcher identity', async () => {
    const added = await page.evaluate(() => (window as any).baoyi.game.addManual())
    assert.equal(added.ok, true); portal = added.item
    assert.equal(portal.path, portalExe)
    assert.equal((await page.evaluate(() => (window as any).baoyi.game.addManual())).item.id, portal.id)
    await chosenPath(genshinExe)
    const second = await page.evaluate(() => (window as any).baoyi.game.addManual())
    assert.equal(second.ok, true); genshin = second.item
    await page.evaluate((id: string) => (window as any).baoyi.game.update(id, { notes: '保留游戏笔记' }), genshin.id)
    assert.equal(fs.readFileSync(genshinExe, 'utf8'), 'isolated Genshin launcher')
  })
  await check('Portal candidates decode through baoyi protocol and selection persists', async () => {
    await page.evaluate((id: string) => { location.hash = '/game/' + id }, portal.id)
    await page.getByRole('button', { name: '搜封面', exact: true }).click()
    await page.waitForFunction(() => { const images = [...document.querySelectorAll<HTMLImageElement>('.coverPick__img')]; return images.length > 0 && images.every(image => image.naturalWidth > 0) })
    const previews = await page.locator('.coverPick').evaluateAll((cards: Element[]) => cards.map(card => ({ title: card.getAttribute('title'), url: card.querySelector('img')!.src, fit: getComputedStyle(card.querySelector('img')!).objectFit })))
    assert.ok(previews.every((preview: any) => preview.url.startsWith('baoyi://cover/') && preview.fit === 'contain' && !preview.title.includes('Portal 2')))
    await page.screenshot({ path: path.join(output, 'portal-candidates.png') })
    await page.locator('.coverPick').first().click()
    await page.waitForFunction(() => !!document.querySelector<HTMLImageElement>('.hero__img')?.naturalWidth)
    portal = await page.evaluate((id: string) => (window as any).baoyi.game.get(id), portal.id)
    assert.ok(portal.cover_path.toLowerCase().startsWith(profile.toLowerCase() + path.sep))
    assert.ok(fs.existsSync(portal.cover_path))
  })
  await check('invalid replacement keeps the old image; missing cache can be rebuilt', async () => {
    const originalPath = portal.cover_path, originalBytes = fs.readFileSync(originalPath)
    await chosenPath(invalidImage)
    const result = await page.evaluate((id: string) => (window as any).baoyi.game.pickCover(id), portal.id)
    assert.equal(result.ok, false)
    assert.deepEqual(fs.readFileSync(originalPath), originalBytes)
    fs.unlinkSync(originalPath)
    const restored = await page.evaluate((id: string) => (window as any).baoyi.game.rebuildCovers([id]), portal.id)
    assert.equal(restored.updated, 1); assert.equal(restored.failed, 0)
    const current = await page.evaluate((id: string) => (window as any).baoyi.game.get(id), portal.id)
    assert.ok(fs.existsSync(current.cover_path))
  })
  await check('Genshin local artwork has priority and requires no network', async () => {
    const before = await app.evaluate(() => (globalThis as any).__gameFixture.requests.length)
    const result = await page.evaluate((id: string) => (window as any).baoyi.game.searchCovers(id), genshin.id)
    assert.equal(result.candidates[0].source, 'local'); assert.equal(result.candidates[0].width, 512)
    assert.equal(await app.evaluate(() => (globalThis as any).__gameFixture.requests.length), before)
    assert.equal((await page.evaluate((input: any) => (window as any).baoyi.game.setCoverFromUrl(input.id, input.url), { id: genshin.id, url: result.candidates[0].url })).ok, true)
    fs.unlinkSync(localPoster)
    await page.evaluate((id: string) => (window as any).baoyi.game.update(id, { identity_confirmed: true, identity_query: '原神 官方横幅' }), genshin.id)
  })
  await check('Genshin official source uses cached landscape previews without library keys', async () => {
    const before = await app.evaluate(() => (globalThis as any).__gameFixture.requests.length)
    await page.evaluate((id: string) => { location.hash = '/game/' + id }, genshin.id)
    await expect(page.locator('#game-identity')).toHaveValue('原神')
    await expect(page.locator('#game-cover-query')).toHaveValue('原神 官方横幅')
    await page.getByRole('button', { name: '搜封面', exact: true }).click()
    await page.waitForFunction(() => { const images = [...document.querySelectorAll<HTMLImageElement>('.coverPick__img')]; return images.length > 0 && images.every(image => image.naturalWidth === 512 && image.naturalHeight === 256) })
    const requests = (await app.evaluate(() => (globalThis as any).__gameFixture.requests)).slice(before)
    assert.ok(requests.length > 0); assert.ok(requests.every((url: string) => url.startsWith('https://act-webstatic.mihoyo.com/')))
    assert.ok(await page.locator('.coverPick').first().innerText().then((text: string) => text.includes('官方')))
    assert.ok((await page.locator('.coverPick__img').evaluateAll((images: HTMLImageElement[]) => images.map(image => getComputedStyle(image).objectFit))).every((fit: string) => fit === 'contain'))
    await page.screenshot({ path: path.join(output, 'genshin-candidates.png') })
    await page.locator('.coverPick').first().click()
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('.hero__img')?.naturalWidth === 512)
    const current = await page.evaluate((id: string) => (window as any).baoyi.game.get(id), genshin.id)
    assert.equal(current.path, genshinExe); assert.equal(current.notes, '保留游戏笔记')
    assert.equal(fs.readFileSync(genshinExe, 'utf8'), 'isolated Genshin launcher')
  })
  await check('packaged game wall renders both saved covers after reload', async () => {
    await page.evaluate(() => { location.hash = '/game' }); await page.reload()
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.wall .card__img')].filter(image => image.naturalWidth > 0).length === 2)
    await page.screenshot({ path: path.join(output, 'game-wall.png') })
  })
  assert.deepEqual(errors, [])
  const report = { executable, profile, output, checks, errors, limitations: ['All network responses are offline fixtures; official artwork availability and likeness are not asserted', 'No installed games or actual save directories were accessed; no launcher was executed'] }
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.resolve('.planning/ux-execution-20260908/validation-logs/game-packaged.json'), JSON.stringify(report, null, 2))
  console.log(`Packaged game covers: ${checks.length} passed / 0 failed; evidence: ${output}`)
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, error: String(error), text: await page.locator('body').innerText().catch(() => '') }, null, 2)) }
  throw error
} finally {
  await app.evaluate(({ net, dialog }: any) => { const original = (globalThis as any).__gameFixture; if (original) { net.fetch = original.originalFetch; dialog.showOpenDialog = original.originalOpen } }).catch(() => {})
  await app.close()
}
