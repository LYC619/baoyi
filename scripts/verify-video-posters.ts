import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import * as dbVideo from '../electron/kinds/video/db.ts'
import * as posters from '../electron/kinds/video/posters.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { pngImage } from './helpers/test-images.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=', 'base64')
let passed = 0; let failed = 0
async function test(name: string, run: (h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness()
  try { await run(h); passed++ }
  catch (error) { failed++; console.error('FAIL', name, error instanceof Error ? error.message : error) }
  finally { h.db.close(); fs.rmSync(h.root, { recursive: true, force: true }) }
}
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-poster-regression-'))
  const cache = path.join(root, 'posters'); fs.mkdirSync(cache)
  const db = new DatabaseSync(':memory:'); initSchema(db, KINDS)
  const fetched: string[] = []
  const providers: string[] = []
  const dimensions = (bytes: Buffer) => ({ isEmpty: () => bytes.length < 24, getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }), toPNG: () => bytes })
  let work = { videoCode: '123', title: 'Alpha', tags: [], description: '', episodes: [], warnings: [], posterUrl: 'https://vdownload.hembed.com/image/cover/fresh.png', thumbnailUrl: 'https://vdownload.hembed.com/image/thumbnail/123.png', artworkUrls: [] as string[] }
  let fetchImpl = async (_url: string) => new Response(png, { headers: { 'content-type': 'image/png' } })
  const fetch = (url: string) => { fetched.push(url); return fetchImpl(url) }
  const settings = { tmdb: { enabled: true, api_key: 'fixture', api_domain: 'api.themoviedb.org', image_domain: 'image.tmdb.org' } }
  const load = createRendererLoader({
    'node:fs': { ...fs, default: fs }, 'node:path': { ...path, default: path },
    electron: { app: { getPath: () => root }, net: { fetch }, shell: {}, nativeImage: { createFromBuffer: dimensions, createFromPath: (p: string) => dimensions(fs.readFileSync(p)) } },
    '../../services/database.ts': { getDb: () => db, getSettings: () => settings, postersDir: () => cache },
    '../../services/agent/loop.ts': {}, '../../services/searchService.ts': {},
    './db.ts': dbVideo, './posters.ts': posters, './facts.ts': {}, './prompts.ts': {}, './tools.ts': {},
    './download/sources.ts': { loadVideoWork: async () => work },
    './tmdb.ts': {
      imageUrl: (_cfg: unknown, rel: string) => `https://image.tmdb.org/t/p/w500${rel}`,
      tmdbAvailable: () => true,
      tmdbDetail: async () => { providers.push('tmdb'); return { poster_path: '/recovered.png' } }
    },
    './hentai/hanime.ts': { fetchHanimeResource: fetch, newBudget: () => ({}),
      hanimeSearch: async () => { providers.push('hanime-search'); return [{ videoCode: '123', coverUrl: 'https://vdownload.hembed.com/image/cover/fresh.png' }] },
      hanimeDetail: async () => ({ videoCode: '123', coverUrl: 'https://vdownload.hembed.com/image/thumbnail/123.png' }) }
  }, { Buffer, URL, AbortController, AbortSignal, Response, setTimeout, clearTimeout })
  const service = load('electron/kinds/video/service.ts') as typeof import('../electron/kinds/video/service.ts')
  function file(name: string, content: string | Buffer = png) {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target
  }
  function item(name: string, resourcePath: string, patch: Record<string, unknown> = {}) {
    db.prepare(`INSERT INTO resource (id,kind,created_at,updated_at,path,file_name,name_zh,category,source_dir)
      VALUES (?, 'video',1,1,?,?,?,'其他',?)`).run(name, resourcePath, path.basename(resourcePath), name, path.dirname(resourcePath))
    db.prepare('INSERT INTO video_meta (resource_id) VALUES (?)').run(name)
    dbVideo.updateVideo(db, name, patch)
    return name
  }
  return { db, root, cache, file, item, fetched, providers, service, setWork: (patch: Partial<typeof work>) => { work = { ...work, ...patch } }, setFetch: (fn: typeof fetchImpl) => { fetchImpl = fn } }
}
await test('movie directory owns its adjacent poster', async h => {
  h.file('Library/Title/movie.mp4', 'video'); const poster = h.file('Library/Title/poster.png')
  const id = h.item('Title', path.dirname(poster))
  assert.equal((await h.service.fetchVideoPoster(id)).ok, true)
  assert.equal(h.fetched.length, 0)
  assert.ok(fs.existsSync(dbVideo.getVideo(h.db, id)!.poster_path))
})
await test('shared directory only accepts the matching movie poster', async h => {
  const movie = h.file('Shared/Alpha.mp4', 'video'); h.file('Shared/Beta.mp4', 'video')
  h.file('Shared/poster.png', Buffer.from('wrong')); h.file('Shared/Alphabet-poster.png', Buffer.from('wrong'))
  const own = h.file('Shared/Alpha-poster.png')
  const id = h.item('Alpha', movie)
  assert.equal((await h.service.fetchVideoPoster(id)).ok, true)
  assert.deepEqual(fs.readFileSync(dbVideo.getVideo(h.db, id)!.poster_path), fs.readFileSync(own))
})
await test('missing cached file is retrieved from saved source', async h => {
  const id = h.item('Alpha', h.file('Shared/Alpha.mp4', 'video'), { poster_path: path.join(h.cache, 'missing.png'), poster_source: '/original.png' })
  assert.equal((await h.service.fetchVideoPoster(id)).ok, true)
  assert.match(h.fetched[0], /original\.png$/)
})
await test('old cached file without saved source can re-resolve TMDB ID', async h => {
  const id = h.item('Alpha', h.file('Shared/Alpha.mp4', 'video'), { poster_path: path.join(h.cache, 'missing.png'), tmdb_id: '123' })
  assert.equal((await h.service.fetchVideoPoster(id)).ok, true)
  assert.deepEqual(h.providers, ['tmdb'])
})
await test('expired Hanime poster refreshes to a matching formal cover', async h => {
  const id = h.item('Alpha', h.file('Shared/Alpha.mp4', 'video'), { poster_path: 'https://vdownload.hembed.com/expired.png', hanime_id: '123' })
  h.setFetch(async url => url.includes('expired') ? new Response(null, { status: 403 }) : new Response(png, { headers: { 'content-type': 'image/png' } }))
  assert.equal((await h.service.fetchVideoPoster(id)).ok, true)
  assert.ok(h.fetched.some(url => url.includes('/image/cover/fresh.png')))
})
await test('valid user cover is preserved; selecting its cached path is safe', async h => {
  const cover = h.file('posters/Alpha.png'); const id = h.item('Alpha', h.file('Shared/Alpha.mp4', 'video'), { poster_path: cover, tmdb_id: '123' })
  assert.equal((await h.service.fetchVideoPoster(id)).changed, false)
  assert.equal(h.service.setVideoPoster(id, cover).ok, true)
  assert.ok(fs.existsSync(cover)); assert.equal(h.fetched.length, 0)
})
await test('late network completion cannot overwrite a new manual cover', async h => {
  const id = h.item('Alpha', h.file('Shared/Alpha.mp4', 'video'), { poster_path: '/original.png' })
  let resolve!: (response: Response) => void
  h.setFetch(() => new Promise(done => { resolve = done }))
  const job = h.service.fetchVideoPoster(id)
  assert.equal(h.service.setVideoPoster(id, h.file('manual.png', Buffer.from('manual-cover'))).ok, true)
  resolve(new Response(png, { headers: { 'content-type': 'image/png' } }))
  await job
  assert.equal(fs.readFileSync(dbVideo.getVideo(h.db, id)!.poster_path, 'utf8'), 'manual-cover')
})
await test('existing portrait still acquires a separate landscape thumbnail', async h => {
  const cover = h.file('posters/manual.png', pngImage(400,600))
  const id = h.item('Two roles', h.file('Roles/video.mp4','video'), { hanime_id: '123', poster_path: cover })
  h.setFetch(async url => new Response(pngImage(url.includes('thumbnail') ? 640 : 400, url.includes('thumbnail') ? 360 : 600), { headers: { 'content-type': 'image/png' } }))
  const result = await h.service.fetchVideoPoster(id)
  assert.equal(result.ok,true); assert.equal(result.changed,true)
  assert.equal(dbVideo.getVideo(h.db,id)?.poster_path,cover)
  assert.ok(dbVideo.getVideo(h.db,id)?.thumbnail_path)
  assert.notEqual(dbVideo.getVideo(h.db,id)?.thumbnail_path,cover)
})
await test('actual dimensions select the portrait even when source role hints are reversed', async h => {
  const id = h.item('Wrong hints', h.file('Hints/video.mp4','video'), { hanime_id: '123' })
  h.setFetch(async url => new Response(pngImage(url.includes('thumbnail') ? 400 : 640, url.includes('thumbnail') ? 600 : 360), { headers: { 'content-type': 'image/png' } }))
  assert.equal((await h.service.fetchVideoPoster(id)).ok,true)
  const item = dbVideo.getVideo(h.db,id)!
  assert.ok(item.poster_source?.includes('thumbnail')); assert.ok(item.thumbnail_source?.includes('cover'))
  assert.equal(fs.readFileSync(item.poster_path).readUInt32BE(20),600)
})
await test('two horizontal source images report that no portrait was available', async h => {
  const id = h.item('Landscape only', h.file('Fallback/video.mp4','video'), { hanime_id: '123' })
  h.setFetch(async () => new Response(pngImage(640,360), { headers: { 'content-type': 'image/png' } }))
  const result = await h.service.fetchVideoPoster(id)
  assert.equal(result.ok,true); assert.match(result.message,/未提供|暂无.*竖图/)
})
console.log(`视频封面回归：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
