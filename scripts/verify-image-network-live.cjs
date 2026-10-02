/** Read-only live check against the latest failed Pica job. Usage: node <script> <userData>. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const output = path.resolve('output/pica-network-verification')
const userData = process.argv[2]
if (!userData || !path.isAbsolute(userData)) throw new Error('Pass the absolute userData directory')

if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true })
  require('esbuild').buildSync({ entryPoints: { source: 'electron/kinds/image/source.ts', network: 'electron/kinds/image/network.ts' }, bundle: true, platform: 'node', format: 'cjs', outdir: output, outExtension: { '.js': '.cjs' }, external: ['electron'] })
  const profile = fs.mkdtempSync(path.join(output, 'profile-'))
  // Windows safeStorage v10 uses the profile's DPAPI-wrapped key; never copy the token.
  const state = JSON.parse(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'))
  fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: state.os_crypt }))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, userData, '--user-data-dir=' + profile], { env, windowsHide: true, encoding: 'utf8', timeout: 180000 })
  fs.rmSync(path.join(profile, 'Local State'), { force: true })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
} else {
  const { app, safeStorage, session } = require('electron')
  app.disableHardwareAcceleration()
  app.whenReady().then(async () => {
    const Database = require('better-sqlite3')
    const db = new Database(path.join(userData, 'baoyi.db'), { readonly: true, fileMustExist: true })
    let job
    try {
      const row = db.prepare("SELECT payload FROM image_download_jobs WHERE status='failed' ORDER BY updated_at DESC LIMIT 1").get()
      assert.ok(row, 'No failed image download found')
      job = JSON.parse(row.payload)
    } finally { db.close() }
    const { createImageSourceFetch } = require(path.join(output, 'network.cjs'))
    const fetch = createImageSourceFetch()
    const report = { checkedAt: new Date().toISOString(), mediaHosts: [], redirects: [] }
    const baseline = await fetch(job.work.coverUrl, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(15000) })
    report.baseline = { status: baseline.status, host: new URL(job.work.coverUrl).hostname, redirectHost: baseline.headers.get('location') ? new URL(baseline.headers.get('location'), job.work.coverUrl).hostname : null }
    await baseline.body?.cancel()
    assert.ok(safeStorage.isEncryptionAvailable(), 'Credential decryption unavailable')
    const token = safeStorage.decryptString(fs.readFileSync(path.join(userData, 'pica-auth.bin')))
    const { PicacomicSource } = require(path.join(output, 'source.cjs'))
    const source = new PicacomicSource({ token: () => token, fetch: async (url, init) => {
      const response = await fetch(url, init)
      if (new URL(url).hostname !== 'picaapi.picacomic.com') {
        assert.equal(init.credentials, 'omit')
        assert.equal(init.headers, undefined)
        report.mediaHosts.push(new URL(url).hostname)
        if (response.headers.get('location')) report.redirects.push({ status: response.status, from: new URL(url).hostname, to: new URL(response.headers.get('location'), url).hostname })
      }
      return response
    } })
    const detail = await source.detail(job.work.id)
    const cover = await source.cover(detail.work.coverUrl)
    assert.match(cover, /^data:image\//)
    const chapter = detail.chapters.find(c => c.id === job.chapters[0].id)
    assert.ok(chapter, 'Selected chapter no longer exists')
    const pages = await source.pages(job.work.id, chapter)
    assert.ok(pages.length, 'No pages returned')
    const first = await source.image(pages[0].url)
    assert.ok(first.data.length > 0)
    report.cover = { mime: cover.slice(5, cover.indexOf(';')), bytes: Buffer.byteLength(cover.split(',')[1], 'base64') }
    report.chapter = { pages: pages.length, firstPageBytes: first.data.length, extension: first.extension }
    report.systemProxyUsed = (await session.defaultSession.resolveProxy(pages[0].url)) !== 'DIRECT'
    report.mediaHosts = [...new Set(report.mediaHosts)]
    fs.writeFileSync(path.join(output, 'live-report.json'), JSON.stringify(report, null, 2))
    console.log('PASS real Pica API, cover and first page; ' + JSON.stringify(report))
    app.exit(0)
  }).catch(error => {
    console.error(error.message)
    app.exit(1)
  })
}
