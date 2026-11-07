/** Opt-in live probe: three playlists + first segments, isolated profile, no library writes. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { parseVideoSources } from '../electron/kinds/video/download/sources.ts'
import { parsePlaylist } from '../electron/kinds/video/download/hls.ts'
import { DOWNLOAD_UA } from '../electron/kinds/video/download/transfer.ts'
import { retryableDownloadError } from '../electron/kinds/video/download/resource.ts'
import { loadPlaywright, electronTestEnv } from './helpers/playwright.ts'

const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const output = path.resolve(`output/release-${version}/cdn-live`)
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, proxy: '', hanime_builtin_hosts: true, hanime_hosts_active_ip: '104.25.254.167' })) {
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
}
db.close()
const application = await loadPlaywright()._electron.launch({
  executablePath: path.resolve(process.argv[2] || `release/${version}/win-unpacked/抱一.exe`),
  args: ['--user-data-dir=' + profile, '--disable-gpu'], env: electronTestEnv()
})
const checks: any[] = [], errors: string[] = []
try {
  const runtime = await application.evaluate(({ app, BrowserWindow }: any) => {
    for (const win of BrowserWindow.getAllWindows()) win.hide()
    return { version: app.getVersion(), profile: app.getPath('userData'), rules: app.commandLine.getSwitchValue('host-resolver-rules') }
  })
  assert.equal(runtime.version, version); assert.equal(runtime.profile, profile)
  assert.match(runtime.rules, /MAP abre-videos\.youjizz\.com abre-videos\.youjizz\.com\.lds\.rncdn7\.com/)
  const page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('button', { name: /^影视\s/ }).click()
  await page.evaluate(() => { location.hash = '/settings?tab=network&module=video' })
  await page.getByText('覆盖 Hanime 镜像及已知视频 CDN', { exact: false }).waitFor()
  await page.screenshot({ path: path.join(output, 'network-settings.png') })

  const request = (url: string, referer: string, text = true) => application.evaluate(async ({ session, net }: any, input: any) => {
    const ses = session.fromPartition('persist:hanime-network')
    return await new Promise<{ status: number; bytes: number; text: string }>((resolve, reject) => {
      const req = net.request({ url: input.url, session: ses, useSessionCookies: true, redirect: 'error', referrerPolicy: 'unsafe-url' })
      let timer: ReturnType<typeof setTimeout>
      const tick = () => { clearTimeout(timer); timer = setTimeout(() => { req.abort(); reject(new Error('CDN inactivity timeout')) }, 20000) }
      req.setHeader('User-Agent', input.ua); req.setHeader('Referer', input.referer)
      req.on('error', (e: Error) => { clearTimeout(timer); reject(e) })
      req.on('response', (res: any) => {
        const chunks: Buffer[] = []; let bytes = 0
        res.on('error', (e: Error) => { clearTimeout(timer); reject(e) })
        res.on('data', (chunk: Buffer) => {
          tick(); bytes += chunk.length
          if (bytes > (input.text ? 4 : 64) * 1024 * 1024) { clearTimeout(timer); req.abort(); reject(new Error('probe response too large')); return }
          if (input.text) chunks.push(chunk)
        })
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, bytes, text: input.text ? Buffer.concat(chunks).toString() : '' }) })
      })
      tick(); req.end()
    })
  }, { url, referer, text, ua: DOWNLOAD_UA })
  const get = async (url: string, referer: string, text = true) => {
    for (let attempt = 0; ; attempt++) {
      try { return { ...await request(url, referer, text), attempts: attempt + 1 } }
      catch (error) {
        if (attempt >= 2 || !retryableDownloadError(error)) throw error
        console.log(`RETRY transient CDN connection: ${error instanceof Error ? error.message.split('\n')[0] : 'network error'}`)
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
      }
    }
  }

  for (const id of ['37551', '37552', '14516']) {
    const watch = 'https://hanime1.me/watch?v=' + id
    const html = await get(watch, 'https://hanime1.me/'); assert.equal(html.status, 200)
    const source = parseVideoSources(html.text, watch).candidates.find(c => c.format === 'hls')
    assert.ok(source, 'expected the affected HLS source'); assert.equal(new URL(source.url).hostname, 'abre-videos.youjizz.com')
    const master = await get(source.url, watch); assert.equal(master.status, 200)
    const parsed = parsePlaylist(master.text, source.url); assert.equal(parsed.type, 'master')
    if (parsed.type !== 'master') throw new Error('expected master playlist')
    const mediaUrl = parsed.variants[0].url
    const media = await get(mediaUrl, watch); assert.equal(media.status, 200)
    const playlist = parsePlaylist(media.text, mediaUrl); assert.equal(playlist.type, 'media')
    if (playlist.type !== 'media') throw new Error('expected media playlist')
    const segment = await get(playlist.segments[0].url, watch, false)
    assert.equal(segment.status, 200); assert.ok(segment.bytes > 0)
    checks.push({ id, masterStatus: master.status, mediaStatus: media.status, segmentStatus: segment.status, segmentBytes: segment.bytes, segmentAttempts: segment.attempts, totalSegments: playlist.segments.length })
    console.log(`PASS packaged CDN ${id}: master 200, media 200, first complete segment ${segment.bytes} bytes`)
  }
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ status: 'passed', version, runtime, checks, errors, scope: 'Isolated direct session; three live watch/master/media requests and full first segments only. No full-episode download.' }, null, 2))
} finally { await application.close() }
