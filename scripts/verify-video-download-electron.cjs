if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio:'inherit' })
  child.once('error',error=>{console.error(error);process.exitCode=1})
  child.once('exit',code=>{process.exitCode=code===0?0:1})
  return
}
const { app, net, session, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-network-regression-'))
app.setPath('userData', path.join(temporary, 'profile'))
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('host-resolver-rules','MAP vdownload.hembed.com 127.0.0.1')
const bundle = path.join(temporary, 'network.cjs')
buildSync({ entryPoints: [path.join(__dirname, '../electron/kinds/video/download/chromium-fetch.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const { createChromiumDownloadFetch } = require(bundle)
const mediaBundle=path.join(temporary,'media.cjs')
buildSync({entryPoints:[path.join(__dirname,'../electron/kinds/video/download/media.ts')],outfile:mediaBundle,bundle:true,platform:'node',format:'cjs',external:['electron']})
const {createVideoMediaTransfer}=require(mediaBundle)
const media=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(512*1024,37)])
let failed = 0
let passed = 0
const seen = []
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, referer: req.headers.referer, cookie: req.headers.cookie, range:req.headers.range })
  if(req.url==='/continuous'){
    const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'')
    let offset=m?Number(m[1]):0
    const end=m?.[2]?Number(m[2]):media.length-1
    res.writeHead(m?206:200,{'Content-Type':'video/mp4','Content-Length':end-offset+1,ETag:'"continuous"',...(m?{'Content-Range':`bytes ${offset}-${end}/${media.length}`}:{})})
    const timer=setInterval(()=>{const next=Math.min(offset+8192,end+1);res.write(media.subarray(offset,next));offset=next;if(offset>end){clearInterval(timer);res.end()}},2)
    res.once('close',()=>clearInterval(timer));return
  }
  if (req.url === '/etag' && req.headers['if-none-match'] === '"fixture"') {
    res.writeHead(304, { etag: '"fixture"' }); res.end()
  } else if (req.url === '/redirect') {
    res.writeHead(302, { location: '/video', 'set-cookie': 'fixture=redirect; Path=/' })
    res.end()
  } else {
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(Buffer.from('0000ftypisom0000fixture'))
  }
})
async function test(name, run) {
  console.log('RUN '+name)
  try { await run(); passed++; console.log('PASS '+name) }
  catch (error) { failed++; console.error('FAIL', name, error.message) }
}

app.whenReady().then(async () => {
  const runtimeWindow=new BrowserWindow({show:false})
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
  await test('image requests omit existing session cookies', async () => {
    assert.match(await (await fetch(base + '/video', { ...init({}), credentials: 'omit' })).text(), /ftyp/)
    assert.equal(seen.at(-1).cookie, undefined)
  })
  await test('conditional fragment validation returns a bodyless 304 with its strong ETag', async () => {
    const response = await fetch(base + '/etag', init({ 'If-None-Match': '"fixture"' }))
    assert.equal(response.status, 304); assert.equal(response.body, null); assert.equal(response.headers.get('etag'), '"fixture"')
  })
  await test('continuous CDN uses real Chromium response, cancellation and verified suffix resume',async()=>{
    const transfer=createVideoMediaTransfer({fetch,settings:()=>({video_download_connections:1}),ffmpeg:()=>null})
    const url='http://vdownload.hembed.com:'+server.address().port+'/continuous'
    const first=seen.length,destination=path.join(temporary,'continuous.mp4')
    await transfer({url,destination,referer:'https://hanime1.me/watch?v=1',signal:AbortSignal.timeout(10000)})
    assert.deepEqual(fs.readFileSync(destination),media)
    assert.deepEqual(seen.slice(first).map(r=>r.range),[undefined])
    const stop=new AbortController(),resume=path.join(temporary,'resume.mp4')
    await assert.rejects(transfer({url,destination:resume,referer:'https://hanime1.me/watch?v=1',signal:AbortSignal.any([stop.signal,AbortSignal.timeout(5000)]),onProgress:p=>{if(p.receivedBytes>0){stop.abort(new Error('pause fixture'));}}}),/pause fixture/)
    const before=seen.length
    await transfer({url,destination:resume,referer:'https://hanime1.me/watch?v=1',signal:AbortSignal.timeout(10000)})
    assert.deepEqual(fs.readFileSync(resume),media)
    assert.ok(seen.slice(before).some(r=>/^bytes=[1-9]\d*-$/.test(r.range||'')))
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
