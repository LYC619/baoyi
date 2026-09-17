/** Actual Electron decoder, SQLite, game SFCs and baoyi:// under the application's CSP.
 * Run with node; --official permits one bounded official image download.
 * All profiles, images, bundles and evidence live in a newly created temporary directory.
 */
const electron = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

if (!electron.app) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    env, stdio: 'inherit', windowsHide: true, timeout: 120000
  })
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow, ipcMain, protocol, nativeImage, net } = electron
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-game-electron-'))
const profile = path.join(root, 'profile')
const covers = path.join(root, 'covers')
fs.mkdirSync(profile)
fs.mkdirSync(covers)
app.setPath('userData', profile)
app.setPath('sessionData', profile)
app.setPath('logs', path.join(root, 'logs'))
protocol.registerSchemesAsPrivileged([{ scheme: 'baoyi', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

const ts = require('typescript')
const vm = require('node:vm')
const repository = path.resolve(__dirname, '..')
let db
let window
let checks = 0
const requestLog = []
const apiLog = []
let fixtureFetch

function loader(mocks = {}) {
  const modules = new Map()
  function load(file) {
    const absolute = path.resolve(repository, file)
    if (modules.has(absolute)) return modules.get(absolute).exports
    const module = { exports: {} }
    modules.set(absolute, module)
    const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText
    const localRequire = name => {
      if (name in mocks) return mocks[name]
      if (name.startsWith('.')) {
        let target = path.resolve(path.dirname(absolute), name)
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.ts')
        else if (!fs.existsSync(target)) target += '.ts'
        return load(target)
      }
      return require(name)
    }
    vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, console, Buffer, URL,
      process, AbortController, AbortSignal, setTimeout, clearTimeout }, { filename: absolute })
    return module.exports
  }
  return load
}

async function waitFor(script) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(script)) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('Renderer condition timed out: ' + script)
}

async function rendererHarness(firstId, genshinId) {
  const { parse, compileScript, compileStyle } = require('@vue/compiler-sfc')
  const styles = []
  const virtual = {
    '@/stores/settings': 'export const useSettingsStore = () => ({settings:{ai:{enabled:false,api_key:""},title_lang:"en",theme:"dark"}})',
    '@/composables/useModules': 'export const recallScroll=()=>0; export const rememberScroll=()=>{}',
    '@/composables/useMediaScan': 'import {ref} from "vue"; export const useMediaScan=()=>({running:ref(false),stopping:ref(false),progress:ref(null)})',
    '@/components/game/Sidebar.vue': 'export default {render:()=>null}',
    'vue-router': [
      'import {reactive} from "vue";',
      'export const route=reactive({name:"game-detail",id:' + JSON.stringify(firstId) + '});',
      'export const useRouter=()=>({push(next){route.name=next.name;route.id=next.params?.id || route.id}});'
    ].join('\n')
  }
  const entry = [
    'import {createApp,h} from "vue"; import {createPinia} from "pinia";',
    'import {route} from "vue-router";',
    'import Home from "./src/pages/game/Home.vue"; import Detail from "./src/pages/game/Detail.vue";',
    'window.fixtureRoute=route;',
    'createApp({setup:()=>()=>route.name==="game-home"?h(Home):h(Detail,{id:route.id})}).use(createPinia()).mount("#app");'
  ].join('\n')
  await require('esbuild').build({
    stdin: { contents: entry, resolveDir: repository, loader: 'ts' },
    bundle: true, outfile: path.join(root, 'renderer.js'), format: 'iife', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false' },
    plugins: [{
      name: 'isolated-game-sfcs',
      setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.path in virtual) return { path: args.path, namespace: 'fixture' }
          if (args.path.startsWith('@/')) {
            let target = path.join(repository, 'src', args.path.slice(2))
            if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.ts')
            else if (!path.extname(target)) target += '.ts'
            return { path: target }
          }
        })
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: virtual[args.path], loader: 'ts', resolveDir: repository }))
        build.onLoad({ filter: /\.vue$/ }, args => {
          const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path })
          const id = 'game-' + styles.length
          const script = compileScript(descriptor, { id, inlineTemplate: true })
          for (const style of descriptor.styles) {
            const result = compileStyle({ source: style.content, filename: args.path, id, scoped: style.scoped })
            if (result.errors.length) throw result.errors[0]
            styles.push(result.code)
          }
          const contents = script.content.replace('export default', 'const __component =') +
            '\n__component.__scopeId=' + JSON.stringify('data-v-' + id) + '; export default __component;'
          return { contents, loader: 'ts', resolveDir: path.dirname(args.path) }
        })
      }
    }]
  })
  const sass = require('sass')
  const globalCss = sass.compile(path.join(repository, 'src/styles/global.scss')).css
  fs.writeFileSync(path.join(root, 'renderer.css'), globalCss + '\n' + styles.join('\n') + '\nhtml,body,#app {height:100%;margin:0} body{background:var(--bg-base,#1e1e2e)}')
  const csp = fs.readFileSync(path.join(repository, 'index.html'), 'utf8').match(/content="(default-src[^"]+)"/)[1]
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html lang="zh-CN" data-theme="dark"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '"><link rel="stylesheet" href="./renderer.css"><div id="app"></div><script src="./renderer.js"></script></html>')
  fs.writeFileSync(path.join(root, 'preload.cjs'), [
    'const {contextBridge,ipcRenderer}=require("electron");',
    'const invoke=(method,...args)=>ipcRenderer.invoke("fixture:game",method,JSON.parse(JSON.stringify(args)));',
    'const game={};',
    'for(const name of ["get","list","counts","checkSavePaths","update","backups","running","searchCovers","setCoverFromUrl","rebuildCovers","addManual","clearCover"])game[name]=(...args)=>invoke(name,...args);',
    'game.onSession=()=>()=>{}; game.onCoverProgress=cb=>{const fn=(_e,p)=>cb(p);ipcRenderer.on("fixture:progress",fn);return()=>ipcRenderer.removeListener("fixture:progress",fn)};',
    'const tasks={list:()=>invoke("tasks-list"),save:t=>invoke("tasks-save",t),clear:()=>invoke("tasks-clear")};',
    'contextBridge.exposeInMainWorld("baoyi",{game,tasks});'
  ].join('\n'))
  window = new BrowserWindow({ show: false, width: 1040, height: 780, webPreferences: {
    preload: path.join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false
  } })
  const errors = []
  window.webContents.on('console-message', event => {
    if (event.level === 'error') { errors.push(event.message); console.error('Renderer: ' + event.message) }
  })
  await window.loadFile(path.join(root, 'index.html'))
  await waitFor('!!document.querySelector(".hero__img")?.naturalWidth')
  const image = await window.webContents.executeJavaScript('(()=>{const im=document.querySelector(".hero__img");return {fit:getComputedStyle(im).objectFit,width:im.naturalWidth,height:im.naturalHeight}})()')
  assert.equal(image.fit, 'contain')
  checks++
  await window.webContents.executeJavaScript('document.querySelector(".hero__coverBtn").click()')
  await waitFor('document.querySelectorAll(".coverPick__img").length>0 && [...document.querySelectorAll(".coverPick__img")].every(im=>im.naturalWidth>0)')
  const previews = await window.webContents.executeJavaScript('[...document.querySelectorAll(".coverPick__img")].map(im=>({url:im.src,fit:getComputedStyle(im).objectFit}))')
  assert.ok(previews.every(im => im.url.startsWith('baoyi://cover/') && im.fit === 'contain'))
  checks++
  fs.writeFileSync(path.join(root, 'detail-candidates.png'), (await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript('document.querySelector(".coverPick__img").src="baoyi://cover/missing.png"')
  await waitFor('!!document.querySelector(".coverPick--failed")?.disabled')
  checks++
  await window.webContents.executeJavaScript('window.fixtureRoute.name="game-home"')
  await waitFor('!!document.querySelector(".card__img")?.naturalWidth')
  assert.equal(await window.webContents.executeJavaScript('getComputedStyle(document.querySelector(".card__img")).objectFit'), 'contain')
  checks++
  fs.writeFileSync(path.join(root, 'library.png'), (await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.textContent.includes("加游戏")).click()')
  await waitFor('document.querySelector("#game-identity")?.value==="Offline Game"')
  checks++
  if (genshinId) {
    await window.webContents.executeJavaScript('window.fixtureRoute.id=' + JSON.stringify(genshinId) + ';window.fixtureRoute.name="game-detail"')
    await waitFor('document.querySelector("#game-identity")?.value==="原神" && document.querySelector(".hero__img")?.naturalWidth===512')
    assert.equal(await window.webContents.executeJavaScript('getComputedStyle(document.querySelector(".hero__img")).objectFit'), 'contain')
    checks++
    await window.webContents.executeJavaScript('document.querySelector(".hero__coverBtn").click()')
    await waitFor('document.querySelectorAll(".coverPick__img").length>0 && [...document.querySelectorAll(".coverPick__img")].every(im=>im.naturalWidth===512 && im.naturalHeight===256)')
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#game-cover-query").value'), '原神 官方横幅')
    assert.ok(await window.webContents.executeJavaScript('[...document.querySelectorAll(".coverPick__img")].every(im=>im.src.startsWith("baoyi://cover/") && getComputedStyle(im).objectFit==="contain")'))
    fs.writeFileSync(path.join(root, 'genshin-candidates.png'), (await window.webContents.capturePage()).toPNG())
    checks++
  }
  assert.equal(errors.filter(error => !error.includes('missing.png') && !error.includes('404')).length, 0, errors.join('\n'))
}

app.whenReady().then(async () => {
  assert.equal(app.getPath('userData'), profile)
  const basic = loader()
  db = require('better-sqlite3')(':memory:')
  db.pragma('foreign_keys = ON')
  basic('electron/services/schema.ts').initSchema(db, basic('electron/kinds/index.ts').KINDS)
  const games = basic('electron/kinds/game/db.ts')
  const { pngFixture } = basic('scripts/verify-game-covers-fixtures.ts')
  const png = pngFixture(256, 384)
  const imageResponse = () => new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })
  fixtureFetch = async url => url.includes('/api/storesearch/')
    ? Response.json({ items: [{ id: 400, name: 'Portal', type: 'app' }] }) : imageResponse()
  const load = loader({
    electron: { ...electron, net: { fetch: (url, options) => { requestLog.push(url); return fixtureFetch(url, options) } } },
    '../../services/database': { getDb: () => db, coversDir: () => covers, getSettings: () => ({ ai: { enabled: false }, search: {} }) },
    '../../services/searchService': { imageSearchAvailable: () => false, imageSearchWhyNot: () => '' },
    '../../services/agent/loop': {}, './backup': {}, './savedb': {}, './session': {}, './tools': {}, './prompts': {}, './db': games
  })
  const service = load('electron/kinds/game/service.ts')
  const file = (name, bytes) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); return target }
  const game = service.registerManualGame(file('Portal/Portal.exe', 'entry sentinel')).item
  assert.ok(game)
  const chosen = file('chosen.png', png)
  assert.equal(service.setGameCover(game.id, chosen).ok, true)
  checks++
  const before = games.getGame(db, game.id)
  for (const bytes of [Buffer.from('not an image'), png.subarray(0, 40), pngFixture(1, 1)]) {
    assert.equal(service.setGameCover(game.id, file('invalid.png', bytes)).ok, false)
    assert.ok(fs.readFileSync(before.cover_path).equals(png))
    assert.equal(games.getGame(db, game.id).cover_path, before.cover_path)
    checks++
  }
  const search = await service.searchGameCovers(game.id)
  assert.equal(search.ok, true)
  assert.ok(search.candidates.every(candidate => candidate.preview_url.startsWith('baoyi://') && candidate.width === 256 && candidate.height === 384))
  checks++
  assert.equal((await service.setGameCoverFromUrl(game.id, search.candidates[0].url)).ok, true)
  checks++
  // The default run exercises both Genshin sources with generated offline images.
  let genshinFixtureId
  if (!process.argv.includes('--official') && !process.argv.includes('--official-file')) {
    const widePng = pngFixture(512, 256, [176, 70, 41])
    file('Genshin-fixture/config.ini', 'game_biz=hk4e_cn\ngame_start_name=YuanShen.exe\n')
    const genshin = service.registerManualGame(file('Genshin-fixture/launcher.exe', 'genshin launcher sentinel')).item
    assert.equal(genshin.identity_name, '原神')
    const poster = file('Genshin-fixture/poster.png', widePng)
    const localRequestCount = requestLog.length
    const localGenshin = await service.searchGameCovers(genshin.id)
    assert.equal(localGenshin.candidates[0].source, 'local')
    assert.equal(localGenshin.candidates[0].width, 512)
    assert.equal(requestLog.length, localRequestCount)
    assert.equal((await service.setGameCoverFromUrl(genshin.id, localGenshin.candidates[0].url)).ok, true)
    checks++
    fs.rmSync(poster)
    service.updateGameItem(genshin.id, { identity_confirmed: true, identity_query: '原神 官方横幅' })
    const portalFetch = fixtureFetch
    fixtureFetch = async (url, options) => url.startsWith('https://act-webstatic.mihoyo.com/')
      ? new Response(new Uint8Array(widePng), { headers: { 'content-type': 'image/png' } }) : portalFetch(url, options)
    const officialRequestCount = requestLog.length
    const officialGenshin = await service.searchGameCovers(genshin.id)
    assert.equal(officialGenshin.ok, true)
    assert.ok(officialGenshin.candidates.every(candidate => candidate.source === 'official' && candidate.width === 512 && candidate.height === 256 && !candidate.portrait))
    assert.ok(requestLog.slice(officialRequestCount).every(url => url.startsWith('https://act-webstatic.mihoyo.com/')))
    assert.equal((await service.setGameCoverFromUrl(genshin.id, officialGenshin.candidates[0].url)).ok, true)
    assert.equal(fs.readFileSync(genshin.path, 'utf8'), 'genshin launcher sentinel')
    checks++
    genshinFixtureId = genshin.id
  }
  let firstId = game.id
  const officialFileArg = process.argv.indexOf('--official-file')
  const savedOfficialFile = officialFileArg >= 0 ? process.argv[officialFileArg + 1] : ''
  if (process.argv.includes('--official') || savedOfficialFile) {
    const genshin = service.registerManualGame(file('Genshin/YuanShen.exe', 'entry sentinel')).item
    const url = 'https://act-webstatic.mihoyo.com/puzzle/hyp/pz_Bur_m6Btc7/resource/puzzle/2024/04/11/014eb24be7604aad6c6b289ac01d57f5_3910634999481955313.png'
    const real = savedOfficialFile
      ? new Response(new Uint8Array(fs.readFileSync(savedOfficialFile)), { headers: { 'content-type': 'image/png' } })
      : await net.fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' })
    assert.equal(real.status, 200)
    assert.ok(Number(real.headers.get('content-length') || 0) <= 1024 * 1024, 'Official image exceeds the small-download limit')
    const reader = real.body.getReader()
    const parts = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        assert.ok(size <= 1024 * 1024, 'Official image exceeds the small-download limit')
        parts.push(Buffer.from(value))
      }
    } finally { await reader.cancel().catch(() => {}) }
    const bytes = Buffer.concat(parts)
    const dimensions = nativeImage.createFromBuffer(bytes).getSize()
    assert.ok(dimensions.width >= 128 && dimensions.height >= 64)
    const type = real.headers.get('content-type')
    const evidence = file('official-original.png', bytes)
    fixtureFetch = async target => target === url
      ? new Response(new Uint8Array(bytes), { headers: { 'content-type': type } }) : imageResponse()
    assert.equal((await service.setGameCoverFromUrl(genshin.id, url)).ok, true)
    firstId = genshin.id
    const metadata = { url, status: real.status, type, bytes: size, ...dimensions, evidence, reusedFrom: savedOfficialFile || undefined }
    fs.writeFileSync(path.join(root, 'official-image.json'), JSON.stringify(metadata, null, 2))
    console.log('Official image: ' + JSON.stringify(metadata))
    checks++
  }
  protocol.handle('baoyi', request => {
    const url = new URL(request.url)
    const target = path.join(covers, path.basename(decodeURIComponent(url.pathname)))
    if (url.hostname !== 'cover' || !fs.existsSync(target)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(target).href)
  })
  const tasks = new Map()
  ipcMain.handle('fixture:game', async (_event, method, args) => {
    apiLog.push(method)
    const [id, value] = args
    if (method === 'get') return service.getGameItem(id)
    if (method === 'list') return service.listGameItems(id)
    if (method === 'counts') return service.gameCountsOf()
    if (method === 'checkSavePaths' || method === 'backups') return []
    if (method === 'running') return false
    if (method === 'update') return service.updateGameItem(id, value)
    if (method === 'searchCovers') return service.searchGameCovers(id)
    if (method === 'setCoverFromUrl') return { ...await service.setGameCoverFromUrl(id, value), item: service.getGameItem(id) }
    if (method === 'clearCover') return service.clearGameCover(id)
    if (method === 'rebuildCovers') return service.rebuildMissingGameCovers(id, p => window.webContents.send('fixture:progress', p))
    if (method === 'addManual') return service.registerManualGame(file('Offline/Offline Game.exe', 'offline sentinel'))
    if (method === 'tasks-list') return [...tasks.values()]
    if (method === 'tasks-save') { tasks.set(id.id, id); return true }
    if (method === 'tasks-clear') { tasks.clear(); return }
    throw new Error('Unexpected fixture API method: ' + method)
  })
  await rendererHarness(firstId, genshinFixtureId)
  assert.equal(fs.readFileSync(game.path, 'utf8'), 'entry sentinel')
  assert.ok([...tasks.values()].some(task => task.title.includes('查找游戏封面') && task.status === 'success'))
  checks++
  console.log('Game Electron regression: ' + checks + ' checks passed; evidence: ' + root)
  window?.destroy()
  db.close()
  app.exit(0)
}).catch(async error => {
  console.error(error.stack || error)
  console.error('Game Electron regression failed after ' + checks + ' completed checks')
  console.error('API boundary: ' + apiLog.join(', '))
  console.error('Isolated evidence: ' + root)
  if (window && !window.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await window.webContents.capturePage()).toPNG())
  window?.destroy()
  db?.close()
  app.exit(1)
})
