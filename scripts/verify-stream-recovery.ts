import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRendererLoader } from './helpers/renderer-harness.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-recovery-'))
const load = createRendererLoader({
  'node:fs': { default: fs, ...fs }, 'node:path': { default: path, ...path },
  './ffmpeg.ts': { remuxToMp4: async (_exe: string, inputs: string | string[], out: string) => {
    fs.writeFileSync(out, Buffer.concat([Buffer.from('\0\0\0\x18ftypisom'), ...[inputs].flat().map(f => fs.readFileSync(f))]))
  } }
}, { process, Buffer, URL, Headers, Response, Request, AbortSignal, AbortController, ReadableStream, setTimeout, clearTimeout, Date, TextDecoder })
let checks = 0
try {
  const { createFragmentCache, fragmentShape } = load('electron/kinds/video/download/fragment-cache.ts')
  const original = [{ url: 'https://media.test/a?t=old', sequence: 1, range: { start: 0, end: 9 } }]
  assert.equal(fragmentShape(original), fragmentShape([{ ...original[0], url: 'https://media.test/a?t=new' }]))
  for (const changed of [{ ...original[0], sequence: 2 }, { ...original[0], range: { start: 10, end: 19 } }, { ...original[0], url: 'https://other.test/a?t=new' }]) assert.notEqual(fragmentShape(original), fragmentShape([changed]))
  const cryptoDir = path.join(root, 'encrypted'), target = path.join(cryptoDir, '000000.segment')
  createFragmentCache(cryptoDir, 'old', 'same-shape', false).save('0', target, Buffer.from('decrypted'), { url: original[0].url, headers: new Headers({ ETag: '"ciphertext"' }) }, original[0].url)
  const encrypted = createFragmentCache(cryptoDir, 'new', 'same-shape', false)
  assert.equal(encrypted.exact('0', target), null); assert.equal(encrypted.conditional('0', target, original[0].url), undefined)
  const { readDownloadResource } = load('electron/kinds/video/download/resource.ts')
  await assert.rejects(readDownloadResource({ url: original[0].url, headers: {}, signal: new AbortController().signal, retries: 0, fetch: async () => new Response(null, { status: 304 }) }), /304/)
  const redirect = await readDownloadResource({ url: original[0].url, headers: {}, signal: new AbortController().signal, retries: 0,
    conditional: { data: Buffer.from('OLD'), etag: '"same"', resolved: 'https://media.test/a' },
    fetch: async (url: string, init: any) => url.includes('/a?') ? new Response(null, { status: 302, headers: { location: '/different' } })
      : new Headers(init.headers).has('If-None-Match') ? new Response(null, { status: 304, headers: { ETag: '"same"' } }) : new Response('NEW') })
  assert.equal(redirect.data.toString(), 'NEW')
  checks += 3
  for (const kind of ['hls', 'dash']) for (const scenario of ['same', 'renew', 'changed', 'weak', 'missing', 'origin', 'corrupt', 'invalid304', 'interrupted-validation']) {
    const destination = path.join(root, kind + '-' + scenario + '.mp4')
    const download = load('electron/kinds/video/download/' + kind + '.ts')[kind === 'hls' ? 'downloadHls' : 'downloadDash']
    let attempt = 0, conditional = 0, bodies = 0
    const events: any[] = []
    const fetcher: any = async (raw: string, init: any) => {
      const url = new URL(raw), token = attempt && scenario !== 'same' && scenario !== 'corrupt' ? 'new' : 'old'
      const origin = attempt && scenario === 'origin' ? 'https://other.test' : 'https://media.test'
      if (url.pathname === '/manifest') return new Response(kind === 'hls'
        ? `#EXTM3U\n#EXTINF:1,\n${origin}/first?token=${token}\n#EXTINF:1,\n${origin}/second?token=${token}\n#EXT-X-ENDLIST`
        : `<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation id="v"><SegmentList><SegmentURL media="${origin}/first?token=${token}"/><SegmentURL media="${origin}/second?token=${token}"/></SegmentList></Representation></AdaptationSet></Period></MPD>`)
      if (url.pathname === '/second' && !attempt) return new Response('', { status: 403 })
      const etag = scenario === 'weak' ? 'W/"first"' : scenario === 'missing' ? '' : '"first"'
      if (url.pathname === '/first') {
        const sent = new Headers(init?.headers).get('If-None-Match')
        if (sent) {
          conditional++
          if (scenario === 'interrupted-validation' && attempt === 1) return new Response('', { status: 403 })
          if (scenario !== 'changed') return new Response(null, { status: 304, headers: { ETag: scenario === 'invalid304' ? 'W/"first"' : etag } })
        }
        bodies++
      }
      return new Response(url.pathname === '/first' ? attempt && scenario === 'changed' ? 'NEW-CONTENT' : 'ORIGINAL-CONTENT' : 'SECOND', { headers: etag ? { ETag: etag } : {} })
    }
    const run = () => download({ url: 'https://media.test/manifest', destination, headers: {}, signal: new AbortController().signal, fetch: fetcher, ffmpeg: 'fixture', workers: 1, retries: 0, onProgress: (p: any) => events.push(p) })
    await assert.rejects(run(), /403/)
    assert.equal(bodies, 1)
    if (scenario === 'corrupt') {
      const workspace = path.join(root, '.' + path.basename(destination) + '.baoyi-' + kind)
      fs.writeFileSync(path.join(workspace, kind === 'hls' ? '000000.segment' : '0-0.segment'), 'DAMAGED')
    }
    attempt = 1; events.length = 0
    if (scenario === 'interrupted-validation') { await assert.rejects(run(), /403/); attempt = 2; events.length = 0 }
    await run()
    assert.equal(events[0].checkingCache, true, 'initial progress must preserve previously displayed bytes while checking cache')
    assert.equal(bodies, ['same', 'renew', 'interrupted-validation'].includes(scenario) ? 1 : 2, kind + '/' + scenario)
    if (scenario === 'renew') assert.equal(conditional, 1)
    if (scenario === 'interrupted-validation') assert.equal(conditional, 2, 'failed validation must never promote the old fragment to the new identity')
    if (['origin', 'weak', 'missing', 'corrupt'].includes(scenario)) assert.equal(conditional, 0)
    assert.ok(fs.readFileSync(destination).includes(Buffer.from(scenario === 'changed' ? 'NEW-CONTENT' : 'ORIGINAL-CONTENT')))
    assert.equal(fs.existsSync(path.join(root, '.' + path.basename(destination) + '.baoyi-' + kind)), false)
    checks++
  }
  console.log(`PASS stream recovery: ${checks} scenarios (validation, corruption, changed content, interrupted renewal, progress, cleanup)`)
} finally {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  fs.rmSync(root, { recursive: true, force: true })
}
