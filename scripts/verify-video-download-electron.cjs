const { app, net, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-network-regression-'))
app.setPath('userData', path.join(temporary, 'profile'))
app.commandLine.appendSwitch('disable-gpu')
const bundle = path.join(temporary, 'network.cjs')
buildSync({ entryPoints: [path.join(__dirname, '../electron/kinds/video/download/chromium-fetch.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const { createChromiumDownloadFetch } = require(bundle)
let failed = 0
let passed = 0
const seen = []
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, referer: req.headers.referer, cookie: req.headers.cookie })
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/video', 'set-cookie': 'fixture=redirect; Path=/' })
    res.end()
  } else {
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(Buffer.from('0000ftypisom0000fixture'))
  }
})
async function test(name, run) {
  try { await run(); passed++ }
  catch (error) { failed++; console.error('FAIL', name, error.message) }
}

app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const ses = session.fromPartition('network-regression')
  await ses.setProxy({ mode: 'direct' })
  const fetch = createChromiumDownloadFetch(options => net.request(options), ses)
  const init = headers => ({ redirect: 'manual', headers, signal: AbortSignal.timeout(5000) })
  await test('direct stream', async () => {
    assert.match(await (await fetch(base + '/video', init({}))).text(), /ftyp/)
  })
  await test('cross-origin full Referer used by real downloads', async () => {
    assert.match(await (await fetch(base + '/video', init({ Referer: 'https://hanime1.me/watch?v=12617' }))).text(), /ftyp/)
    assert.equal(seen.at(-1).referer, 'https://hanime1.me/watch?v=12617')
  })
  await test('manual redirect response and session cookie', async () => {
    const response = await fetch(base + '/redirect', init({}))
    assert.equal(response.status, 302)
    const next = new URL(response.headers.get('location'), base).href
    assert.match(await (await fetch(next, init({}))).text(), /ftyp/)
    assert.match(seen.at(-1).cookie || '', /fixture=redirect/)
  })
  await test('session configured proxy carries download request', async () => {
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: base, proxyBypassRules: '<-loopback>' })
    assert.match(await ses.resolveProxy('http://download.fixture.invalid/video'), /PROXY/)
    assert.match(await (await fetch('http://download.fixture.invalid/video', init({}))).text(), /ftyp/)
    assert.equal(seen.at(-1).url, 'http://download.fixture.invalid/video')
  })
}).catch(error => { failed++; console.error(error.message) }).finally(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  console.log(`Electron 下载回归：${passed} 通过 / ${failed} 失败`)
  app.exit(failed ? 1 : 0)
})
