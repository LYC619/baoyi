/** Reads only source metadata and posters into this task's evidence directory. No media downloads. */
import { app, session, nativeImage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { loadVideoWork } from '../electron/kinds/video/download/sources.ts'
import { setHanimeFetch } from '../electron/kinds/video/hentai/hanime.ts'
import { normalizeProxyRules } from '../electron/services/proxy-rules.ts'
import { catalogueIdentity } from '../electron/kinds/video/episode-identity.ts'
import { buildHanimeHostResolverRules } from '../electron/services/hanime-network-rules.ts'

const output = path.resolve('output/video-local-structure-20260912/source')
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-source-probe-'))
app.setPath('userData', profile)
app.commandLine.appendSwitch('host-resolver-rules', buildHanimeHostResolverRules())
const snapshot = new Database(path.resolve('output/video-local-structure-20260912/baseline/library-before.db'), { readonly: true })
const proxyRow = snapshot.prepare("SELECT value FROM settings WHERE key = 'proxy'").get() as { value: string } | undefined
const proxy = proxyRow ? JSON.parse(proxyRow.value) : ''
snapshot.close()

app.whenReady().then(async () => {
  try {
    const network = session.fromPartition('persist:video-source-probe')
    const rules = normalizeProxyRules(proxy)
    await network.setProxy(rules ? { mode: 'fixed_servers', proxyRules: rules, proxyBypassRules: '<-loopback>' } : { mode: 'direct' })
    setHanimeFetch((input, init) => network.fetch(String(input), { ...init, credentials: 'include' }))
    const first = await loadVideoWork('87022', { timeoutMs: 20000 })
    const catalogue = catalogueIdentity(first.title, first.episodes)
    fs.writeFileSync(path.join(output, 'catalogue.json'), JSON.stringify(catalogue, null, 2))
    console.log(JSON.stringify({ title: catalogue.title, episodes: catalogue.episodes.map(ep => ({ code: ep.videoCode, title: ep.title, number: ep.order, numbered: ep.numbered })) }))
    for (const entry of catalogue.episodes) {
      const info = entry.videoCode === first.videoCode ? first : await loadVideoWork(entry.videoCode, { timeoutMs: 20000 })
      fs.writeFileSync(path.join(output, entry.videoCode + '.json'), JSON.stringify(info, null, 2))
      let posterSaved = false
      if (info.currentEpisode?.posterUrl) {
        const response = await network.fetch(info.currentEpisode.posterUrl, { signal: AbortSignal.timeout(20000) })
        if (response.ok && Number(response.headers.get('content-length') || 0) <= 15 * 1024 * 1024) {
          const bytes = Buffer.from(await response.arrayBuffer())
          if (bytes.length > 15 * 1024 * 1024) throw new Error('Poster exceeds limit')
          const picture = nativeImage.createFromBuffer(bytes)
          if (!picture.isEmpty()) { fs.writeFileSync(path.join(output, entry.videoCode + '.png'), picture.toPNG()); posterSaved = true }
        }
      }
      console.log('Saved source ' + entry.videoCode + ', episode ' + entry.order + ', poster ' + posterSaved)
    }
    app.exit(0)
  } catch (error) { console.error(String(error)); app.exit(1) }
})
