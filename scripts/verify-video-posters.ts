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
await test('an episode cover can become the work poster; wrong ownership and missing files are refused', async h => {
  const video = h.file('Series/E01.mp4', 'video'), cover = h.file('Series/.baoyi/artwork/e01.png', pngImage(300, 450))
  const id = h.item('Series', path.dirname(video)), other = h.item('Other', h.file('Other/movie.mp4', 'video'))
  h.db.prepare(`INSERT INTO episode (id,resource_id,season,episode,title,path,file_size,poster_path,poster_source) VALUES ('ep1',?,0,1,'E01',?,1,?,'https://source.example/e01.png')`).run(id, video, cover)
  h.db.prepare(`INSERT INTO episode (id,resource_id,season,episode,title,path,file_size,poster_path) VALUES ('ep2',?,0,2,'E02',?,1,'')`).run(id, video)
  assert.equal(h.service.useVideoEpisodeArtwork(other, 'ep1', 'poster').ok, false, '单集必须属于该作品')
  assert.equal(h.service.useVideoEpisodeArtwork(id, 'ep2', 'poster').ok, false, '这一集没有图')
  assert.equal(h.service.useVideoEpisodeArtwork(id, 'ep1', 'thumbnail').ok, false, '这一集没有预览图')
  const result = h.service.useVideoEpisodeArtwork(id, 'ep1', 'poster')
  assert.equal(result.ok, true, result.message)
  const item = dbVideo.getVideo(h.db, id)!
  assert.ok(fs.existsSync(item.poster_path)); assert.deepEqual(fs.readFileSync(item.poster_path), fs.readFileSync(cover))
  assert.ok(item.poster_path.includes(path.join('.baoyi', 'artwork')), '新图写进作品目录：' + item.poster_path)
  assert.equal(item.poster_source, 'https://source.example/e01.png', '来源跟着单集走')
  assert.ok(item.user_edited.includes('poster_path'), '用户亲手挑的图要标 user_edited')
  assert.equal((await h.service.fetchVideoPoster(id)).changed, false, '标了 user_edited 之后补封面不再换掉它')
})
await test('artwork-only enrichment replaces a landscape work poster with the episode portrait, but not a user-picked one', async h => {
  const video = h.file('Enrich/E01.mp4', 'video'), landscape = h.file('Enrich/.baoyi/artwork/wide.png', pngImage(640, 360))
  const id = h.item('Enrich', path.dirname(video), { hanime_id: '123', poster_path: landscape })
  h.db.prepare(`INSERT INTO episode (id,resource_id,season,episode,title,path,file_size) VALUES ('en1',?,0,1,'E01',?,1)`).run(id, video)
  h.db.prepare(`INSERT INTO video_sources (id,resource_id,episode_id,provider,external_id,scope,page_url,evidence,confirmed,created_at,updated_at) VALUES ('src-en1',?,'en1','hanime','123','episode','https://hanime1.me/watch?v=123','confirmed',1,0,0)`).run(id)
  h.setFetch(async url => new Response(pngImage(url.includes('thumbnail') ? 640 : 400, url.includes('thumbnail') ? 360 : 600), { headers: { 'content-type': 'image/png' } }))
  const scratch = new DatabaseSync(':memory:'); initSchema(scratch, KINDS)
  const result = await h.service.enrichVideoWithAgent(id, { artwork: true, metadata: false }, scratch as any, new AbortController().signal, () => {})
  assert.ok(result.ok, result.message)
  const work = dbVideo.getVideo(h.db, id)!
  assert.notEqual(work.poster_path, landscape, '作品原来挂的横图要被单集竖图换掉')
  assert.equal(fs.readFileSync(work.poster_path).readUInt32BE(20), 600, '换上去的是竖图')
  assert.ok(work.thumbnail_path && fs.readFileSync(work.thumbnail_path).readUInt32BE(20) === 360, '横图留作预览图')
  // 用户手选的封面不换
  const manual = h.file('Enrich/manual.png', pngImage(300, 200))
  assert.equal(h.service.setVideoPoster(id, manual, true).ok, true)
  h.db.prepare("UPDATE episode SET poster_path = '' WHERE id = 'en1'").run()
  const again = await h.service.enrichVideoWithAgent(id, { artwork: true, metadata: false }, scratch as any, new AbortController().signal, () => {})
  assert.ok(again.ok, again.message)
  assert.deepEqual(fs.readFileSync(dbVideo.getVideo(h.db, id)!.poster_path), fs.readFileSync(manual), '用户亲手挑的横图保留')
  scratch.close()
})
console.log(`视频封面回归：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
