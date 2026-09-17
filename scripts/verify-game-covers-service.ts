/** Real cover service, SQLite and files; only Electron/network boundaries use fixtures. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import * as games from '../electron/kinds/game/db.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { pngFixture } from './verify-game-covers-fixtures.ts'

const png = pngFixture(256, 384)
const otherPng = pngFixture(384, 256, [176, 70, 41])
const tinyPng = pngFixture(1, 1)
const undersizedPng = pngFixture(32, 128)
const fixtureImages = [png, otherPng, tinyPng, undersizedPng]
const imageResponse = () => new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })
let passed = 0
let failed = 0

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-game-covers-'))
  const covers = path.join(root, 'covers')
  fs.mkdirSync(covers)
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  initSchema(db, KINDS)
  const requests: string[] = []
  let fetchResponse: (url: string) => Promise<Response> = async url => {
    if (url.includes('/api/storesearch/')) return Response.json({ items: [{ id: 400, name: 'Portal', type: 'app' }] })
    if (url === 'https://launcher.mihoyo.com/') return new Response('<script src="/assets/config.js"></script>')
    if (url.endsWith('/assets/config.js')) return new Response('const game={game_biz:"hk4e_cn",poster:"https://act-webstatic.mihoyo.com/fixture/cover.png"}')
    return imageResponse()
  }
  let renameFailure: ((from: string, to: string) => boolean) | null = null
  const fixtureFs = {
    ...fs,
    renameSync(from: fs.PathLike, to: fs.PathLike) {
      if (renameFailure?.(String(from), String(to))) throw new Error('fixture rename failed')
      return fs.renameSync(from, to)
    }
  }
  const newService = () => {
  const load = createRendererLoader({
    typescript: { ...ts, default: ts },
    'node:fs': { ...fixtureFs, default: fixtureFs },
    'node:path': { ...path, default: path },
    electron: {
      app: { getPath: () => root, getAppPath: () => root, isPackaged: false },
      net: { fetch: async (url: string) => { requests.push(url); return fetchResponse(url) } },
      session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      nativeImage: { createFromPath: (file: string) => ({ getSize: () => {
        const bytes = fs.readFileSync(file)
        return fixtureImages.some(image => image.equals(bytes))
          ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : { width: 0, height: 0 }
      } }) },
      shell: {}
    },
    '../../services/database': {
      getDb: () => db, coversDir: () => covers,
      getSettings: () => ({ ai: { enabled: false, api_key: '' }, search: {} }),
      listCategories: () => [], tagPool: () => []
    },
    '../../services/searchService': { imageSearchAvailable: () => false, imageSearchWhyNot: () => '', searchAvailable: () => false },
    '../../services/agent/loop': {}, './backup': {}, './savedb': {}, './session': {}, './tools': {}, './prompts': {},
    './db': games
  }, { Buffer, URL, AbortController, AbortSignal, process, setTimeout, clearTimeout })
  return load('electron/kinds/game/service.ts') as typeof import('../electron/kinds/game/service.ts')
  }
  const service = newService()
  const file = (name: string, bytes: string | Buffer = '') => {
    const target = path.join(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
    return target
  }
  const game = (name = 'Portal', exe = `${name}/game.exe`) => {
    const target = file(exe)
    const { id } = games.insertGame(db, {
      exe_path: target, name_zh: '', name_en: name, summary: '', description: '', category: '其他', tags: [],
      official_url: '', source_dir: path.dirname(target), file_size: 0, save_paths: [], linked_files: []
    })
    return games.getGame(db, id)!
  }
  return {
    root, covers, db, service, newService, requests, game, file,
    fetch: (fn: typeof fetchResponse) => { fetchResponse = fn },
    failRename: (fn: NonNullable<typeof renameFailure>) => { renameFailure = fn },
    cleanup() {
      db.close()
      const actual = fs.realpathSync(root)
      assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase())
      assert.ok(path.basename(actual).startsWith('baoyi-game-covers-'))
      fs.rmSync(actual, { recursive: true, force: true })
    }
  }
}

async function test(name: string, run: (h: ReturnType<typeof harness>) => Promise<void>) {
  if (process.env.GAME_COVER_TEST_FILTER && !name.includes(process.env.GAME_COVER_TEST_FILTER)) return
  const h = harness()
  try { await run(h); passed++ }
  catch (error) { failed++; console.error('FAIL', name, error instanceof Error ? error.message : error) }
  finally { h.cleanup() }
}

await test('search preserves a healthy existing cover and returns decoded local previews', async h => {
  const game = h.game()
  assert.equal(h.service.setGameCover(game.id, h.file('manual.png', png)).ok, true)
  const before = games.getGame(h.db, game.id)!
  const result = await h.service.searchGameCovers(game.id)
  assert.equal(result.ok, true)
  assert.equal(games.getGame(h.db, game.id)!.cover_status, 'ready')
  assert.equal(games.getGame(h.db, game.id)!.cover_path, before.cover_path)
  assert.ok(result.candidates.every(c => c.preview_url?.startsWith('baoyi://cover/')))
  assert.equal(result.candidates[0].width, 256)
  assert.equal(result.candidates[0].height, 384)
  assert.equal(result.candidates[0].status, 'ready')
  assert.ok(result.candidates[0].route)
})

await test('a newer manual choice wins over an older in-flight remote download', async h => {
  const game = h.game()
  let release!: (value: Response) => void
  h.fetch(() => new Promise<Response>(resolve => { release = resolve }))
  const pending = h.service.setGameCoverFromUrl(game.id, 'https://cdn.cloudflare.steamstatic.com/steam/apps/400/header.jpg')
  await new Promise(resolve => setTimeout(resolve, 0))
  h.service.setGameCover(game.id, h.file('newer.png', png))
  const manual = games.getGame(h.db, game.id)!
  release(imageResponse())
  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.message, /更新|选择|取消/)
  assert.equal(games.getGame(h.db, game.id)!.cover_source, 'manual')
  assert.equal(games.getGame(h.db, game.id)!.cover_path, manual.cover_path)
})

await test('an empty selected scope never expands to the entire library', async h => {
  h.game()
  const result = await h.service.rebuildMissingGameCovers([])
  assert.equal(result.processed, 0)
  assert.equal(h.requests.length, 0)
})

await test('bulk fill skips healthy images even when old status metadata says missing', async h => {
  const game = h.game()
  h.service.setGameCover(game.id, h.file('manual.png', png))
  games.updateGame(h.db, game.id, { cover_status: 'missing' })
  const result = await h.service.rebuildMissingGameCovers([game.id, game.id])
  assert.equal(result.processed, 0)
  assert.equal(h.requests.length, 0)
  assert.equal(games.getGame(h.db, game.id)!.cover_source, 'manual')
})

await test('local poster wins before the network and remains usable after the original disappears', async h => {
  const game = h.game()
  const poster = h.file('Portal/poster.png', png)
  const result = await h.service.searchGameCovers(game.id)
  assert.equal(result.ok, true)
  assert.equal(result.candidates[0].source, 'local')
  assert.equal(h.requests.length, 0)
  fs.rmSync(poster)
  assert.equal((await h.service.setGameCoverFromUrl(game.id, result.candidates[0].url)).ok, true)
  assert.equal(games.getGame(h.db, game.id)!.cover_source, 'local')
})

await test('decode failure reports its stage while preserving an older ready image', async h => {
  const game = h.game()
  h.service.setGameCover(game.id, h.file('manual.png', png))
  const before = games.getGame(h.db, game.id)!
  h.fetch(async url => url.includes('/api/storesearch/')
    ? Response.json({ items: [{ id: 400, name: 'Portal', type: 'app' }] })
    : new Response('not an image', { headers: { 'content-type': 'image/png' } }))
  const search = await h.service.searchGameCovers(game.id)
  assert.equal(search.ok, false)
  assert.ok(search.diagnostics?.some(d => d.stage === 'decode' && d.status === 'failed'))
  const result = await h.service.setGameCoverFromUrl(game.id, 'https://cdn.cloudflare.steamstatic.com/steam/apps/400/header.jpg')
  assert.equal(result.ok, false)
  assert.equal(games.getGame(h.db, game.id)!.cover_status, 'ready')
  assert.equal(games.getGame(h.db, game.id)!.cover_path, before.cover_path)
  assert.ok(fs.readFileSync(before.cover_path).equals(png))
})

await test('failed local images cannot crowd usable matched Steam covers out of the candidate limit', async h => {
  const game = h.game('Portal', 'Portal/bin/game.exe')
  h.db.prepare('UPDATE resource SET source_dir = ? WHERE id = ?').run(path.join(h.root, 'Portal'), game.id)
  for (const dir of ['Portal', 'Portal/bin']) {
    for (const name of ['poster.png', 'poster.jpg', 'cover.png', 'cover.jpg', 'folder.png', 'folder.jpg']) h.file(`${dir}/${name}`, 'broken local image')
  }
  const result = await h.service.searchGameCovers(game.id)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.candidates[0].status, 'ready')
  assert.equal(result.candidates[0].source, 'steam')
  assert.ok(result.diagnostics?.some(d => d.source === 'local' && d.stage === 'decode' && d.status === 'failed'))
})

await test('local product config corrects launcher identity without touching play history or launch path', async h => {
  const game = h.game('Launcher', 'Client/launcher.exe')
  h.file('Client/config.ini', '[General]\ngame_name=hk4e_cn\ngame_start_name=YuanShen.exe\n')
  games.updateGame(h.db, game.id, { total_playtime_sec: 876, last_played_at: 1234, play_status: 'playing', save_paths: [{ path: h.file('saves/data.sav'), verified_at: 1 }] })
  const before = games.getGame(h.db, game.id)!
  const result = await h.service.searchGameCovers(game.id)
  const after = games.getGame(h.db, game.id)!
  assert.equal(after.name_zh, '原神')
  assert.equal(after.name_en, 'Genshin Impact')
  assert.equal(after.path, before.path)
  assert.equal(after.id, before.id)
  assert.equal(after.total_playtime_sec, before.total_playtime_sec)
  assert.equal(after.last_played_at, before.last_played_at)
  assert.deepEqual(after.save_paths, before.save_paths)
  assert.ok(result.candidates.some(c => c.source === 'official' && c.status === 'ready'))
  assert.ok(h.requests.every(url => !url.includes('steampowered.com') && !url.includes('steamstatic.com')))
})

await test('a generic launcher under a suggestive folder is never silently called Genshin', async h => {
  const game = h.game('Launcher', 'Genshin Impact/launcher.exe')
  const result = await h.service.searchGameCovers(game.id)
  assert.equal(games.getGame(h.db, game.id)!.name_en, 'Launcher')
  assert.equal(result.ok, false)
  assert.ok(h.requests.every(url => !url.includes('mihoyo.com')))
  assert.equal(h.requests.length, 0)
})

await test('cover query is independent and never falls back to a generic directory', async h => {
  const game = h.game('Portal', 'Games/game.exe')
  games.updateGame(h.db, game.id, { identity_query: 'Portal 2 custom query' })
  h.fetch(async () => Response.json({ items: [] }))
  const result = await h.service.searchGameCovers(game.id)
  assert.equal(result.query, 'Portal 2 custom query')
  const queries = h.requests.filter(url => url.includes('/api/storesearch/')).map(url => new URL(url).searchParams.get('term'))
  assert.deepEqual(queries, ['Portal 2 custom query'])
})

await test('missing cached local candidates fail without destroying the current cover', async h => {
  const game = h.game()
  h.file('Portal/cover.png', png)
  const search = await h.service.searchGameCovers(game.id)
  h.service.setGameCover(game.id, h.file('chosen.png', png))
  const before = games.getGame(h.db, game.id)!
  const preview = new URL(search.candidates[0].preview_url!)
  fs.rmSync(path.join(h.covers, decodeURIComponent(preview.pathname.slice(1))))
  const result = await h.service.setGameCoverFromUrl(game.id, search.candidates[0].url)
  assert.equal(result.ok, false)
  assert.match(result.message, /缓存.*(?:不存在|丢失)/)
  assert.equal(games.getGame(h.db, game.id)!.cover_status, 'ready')
  assert.ok(fs.readFileSync(before.cover_path).equals(png))
})

await test('a corrupt local preview reports decoding rather than a missing cache', async h => {
  const game = h.game()
  h.file('Portal/cover.png', png)
  const search = await h.service.searchGameCovers(game.id)
  h.service.setGameCover(game.id, h.file('chosen.png', otherPng))
  const before = games.getGame(h.db, game.id)!
  const preview = new URL(search.candidates[0].preview_url!)
  fs.writeFileSync(path.join(h.covers, decodeURIComponent(preview.pathname.slice(1))), 'corrupt cached image')
  const result = await h.service.setGameCoverFromUrl(game.id, search.candidates[0].url)
  assert.equal(result.ok, false)
  assert.match(result.message, /解码/)
  assert.equal(games.getGame(h.db, game.id)!.cover_path, before.cover_path)
  assert.ok(fs.readFileSync(before.cover_path).equals(otherPng))
})

await test('manual registration works with AI disabled and duplicate paths preserve existing history', async h => {
  const exe = h.file('Offline Game/Offline Game.exe')
  const result = h.service.registerManualGame(exe)
  assert.equal(result.ok, true)
  assert.equal(result.item!.path, exe)
  const first = result.item!
  games.updateGame(h.db, first.id, { name_zh: '自定义标题', total_playtime_sec: 91 })
  const duplicate = h.service.registerManualGame(exe)
  assert.equal(duplicate.item!.id, first.id)
  assert.equal(duplicate.item!.total_playtime_sec, 91)
  assert.equal(duplicate.item!.name_zh, '自定义标题')
  assert.equal(h.requests.length, 0)
})

await test('replacement rollback restores the previous bytes and cleans its staging file', async h => {
  const game = h.game()
  const source = h.file('manual.png', png)
  h.service.setGameCover(game.id, source)
  const before = games.getGame(h.db, game.id)!
  h.failRename(from => from.endsWith('.tmp'))
  assert.equal(h.service.setGameCover(game.id, source).ok, false)
  assert.ok(fs.readFileSync(before.cover_path).equals(png))
  assert.equal(fs.readdirSync(h.covers).filter(name => name.endsWith('.tmp')).length, 0)
})

await test('real but undersized images cannot replace an adequate cover', async h => {
  const game = h.game()
  h.service.setGameCover(game.id, h.file('chosen.png', png))
  const before = games.getGame(h.db, game.id)!
  for (const [name, bytes] of [['pixel.png', tinyPng], ['small.png', undersizedPng]] as const) {
    const result = h.service.setGameCover(game.id, h.file(name, bytes))
    assert.equal(result.ok, false, name)
    assert.match(result.message, /尺寸|像素|分辨率/)
    assert.equal(games.getGame(h.db, game.id)!.cover_path, before.cover_path)
    assert.ok(fs.readFileSync(before.cover_path).equals(png))
  }
})

await test('publishing a replacement never removes or rewrites the referenced old file before commit', async h => {
  const game = h.game()
  h.service.setGameCover(game.id, h.file('first.png', png))
  const before = games.getGame(h.db, game.id)!
  let sawPublication = false
  h.failRename((from) => {
    assert.ok(fs.readFileSync(before.cover_path).equals(png), 'old bytes must remain readable during publication')
    if (from === before.cover_path) return true
    sawPublication = true
    return false
  })
  const result = h.service.setGameCover(game.id, h.file('next.png', otherPng))
  assert.equal(result.ok, true, result.message)
  assert.equal(sawPublication, true)
  const after = games.getGame(h.db, game.id)!
  assert.notEqual(after.cover_path, before.cover_path)
  assert.ok(fs.readFileSync(after.cover_path).equals(otherPng))
})

await test('database commit failure leaves the previous reference and bytes intact', async h => {
  const game = h.game()
  h.service.setGameCover(game.id, h.file('first.png', png))
  const before = games.getGame(h.db, game.id)!
  const filesBefore = fs.readdirSync(h.covers)
  h.db.exec("CREATE TRIGGER fail_cover BEFORE UPDATE OF cover_path ON game_meta BEGIN SELECT RAISE(ABORT, 'fixture DB failure'); END")
  const result = h.service.setGameCover(game.id, h.file('next.png', otherPng))
  assert.equal(result.ok, false)
  assert.deepEqual(games.getGame(h.db, game.id), before)
  assert.ok(fs.readFileSync(before.cover_path).equals(png))
  assert.deepEqual(fs.readdirSync(h.covers), filesBefore)
})

await test('a failed clear retains the previous cover file', async h => {
  const game = h.game()
  h.service.setGameCover(game.id, h.file('chosen.png', png))
  const before = games.getGame(h.db, game.id)!
  h.db.exec("CREATE TRIGGER fail_clear BEFORE UPDATE OF cover_path ON game_meta BEGIN SELECT RAISE(ABORT, 'fixture DB failure'); END")
  assert.throws(() => h.service.clearGameCover(game.id), /fixture DB failure/)
  assert.ok(fs.existsSync(before.cover_path))
  assert.ok(fs.readFileSync(before.cover_path).equals(png))
})

await test('missing cover and preview recover from the persisted source after service restart', async h => {
  const game = h.game()
  const chosenUrl = 'https://images.igdb.com/igdb/image/upload/t_cover_big/chosen.png'
  assert.equal((await h.service.setGameCoverFromUrl(game.id, chosenUrl)).ok, true)
  const before = games.getGame(h.db, game.id)!
  fs.rmSync(before.cover_path)
  for (const name of fs.readdirSync(h.covers).filter(name => name.startsWith('preview-'))) fs.rmSync(path.join(h.covers, name))
  h.requests.length = 0
  h.fetch(async url => url === chosenUrl ? imageResponse() : new Response('offline', { status: 503 }))
  const result = await h.newService().rebuildMissingGameCovers([game.id])
  assert.equal(result.updated, 1)
  assert.deepEqual(h.requests, [chosenUrl])
  const after = games.getGame(h.db, game.id)!
  assert.equal(after.cover_source_url, chosenUrl)
  assert.ok(fs.readFileSync(after.cover_path).equals(png))
})

await test('a local candidate keeps its reusable source when installed', async h => {
  const game = h.game()
  const poster = h.file('Portal/poster.png', png)
  const search = await h.service.searchGameCovers(game.id)
  await h.service.setGameCoverFromUrl(game.id, search.candidates[0].url)
  const chosen = games.getGame(h.db, game.id)!
  assert.ok(chosen.cover_source_url)
  fs.rmSync(poster)
  fs.rmSync(chosen.cover_path)
  const result = await h.newService().rebuildMissingGameCovers([game.id])
  assert.equal(result.updated, 1)
  assert.equal(h.requests.length, 0)
})

await test('cache recovery restores the last chosen source before a different directory poster', async h => {
  const game = h.game()
  const chosenUrl = 'https://images.igdb.com/igdb/image/upload/t_cover_big/selected.png'
  assert.equal((await h.service.setGameCoverFromUrl(game.id, chosenUrl)).ok, true)
  const chosen = games.getGame(h.db, game.id)!
  fs.rmSync(chosen.cover_path)
  h.file('Portal/poster.png', otherPng)
  h.requests.length = 0
  const result = await h.newService().rebuildMissingGameCovers([game.id])
  assert.equal(result.updated, 1)
  const restored = games.getGame(h.db, game.id)!
  assert.equal(restored.cover_source_url, chosenUrl)
  assert.ok(fs.readFileSync(restored.cover_path).equals(png))
  assert.equal(h.requests.length, 0)
})

await test('a newer choice for a waiting batch item is respected even when it clears a cover', async h => {
  const first = h.game('Portal')
  const second = h.game('Hades')
  let release!: (result: Response) => void
  h.fetch(url => url.includes('/api/storesearch/')
    ? new Promise(resolve => { release = resolve }) : Promise.resolve(imageResponse()))
  const progress: Array<{ processed: number; total: number; current: string; message: string }> = []
  const batch = h.service.rebuildMissingGameCovers([first.id, second.id], p => progress.push(p))
  await new Promise(resolve => setTimeout(resolve, 0))
  h.service.clearGameCover(second.id)
  release(Response.json({ items: [{ id: 400, name: 'Portal', type: 'app' }] }))
  // A second lookup would deadlock this fixture; make any such regression fail normally.
  h.fetch(async url => url.includes('/api/storesearch/')
    ? Response.json({ items: [{ id: 1145360, name: 'Hades', type: 'app' }] }) : imageResponse())
  const result = await batch
  assert.equal(result.updated, 1)
  assert.equal(result.failed, 0)
  assert.equal(games.getGame(h.db, second.id)!.cover_path, '')
  assert.ok(progress.some(p => p.current === 'Hades' && /跳过|更新/.test(p.message)))
})

await test('mixed batch progress reports each outcome and truthful final totals', async h => {
  const first = h.game('Portal')
  const second = h.game('Launcher', 'Unknown/launcher.exe')
  h.file('Portal/poster.png', png)
  const progress: Array<{ processed: number; total: number; current: string; message: string }> = []
  const result = await h.service.rebuildMissingGameCovers([first.id, second.id], p => progress.push(p))
  assert.equal(result.updated, 1)
  assert.equal(result.failed, 1)
  assert.ok(progress.some(p => p.current === 'Portal' && p.processed === 1 && /补齐|设置|成功/.test(p.message)))
  assert.ok(progress.some(p => p.current === 'Launcher' && p.processed === 2 && /失败/.test(p.message)))
  assert.match(progress.at(-1)!.message, /失败.*1|1.*失败/)
})

await test('overlapping batch requests cannot race to install different covers', async h => {
  const game = h.game()
  let release!: (result: Response) => void
  h.fetch(() => new Promise(resolve => { release = resolve }))
  const first = h.service.rebuildMissingGameCovers([game.id])
  await new Promise(resolve => setTimeout(resolve, 0))
  h.fetch(async () => Response.json({ items: [] }))
  await assert.rejects(h.service.rebuildMissingGameCovers([game.id]), /正在|进行|运行/)
  release(Response.json({ items: [] }))
  await first
})

await test('registration rolls back completely when the second database write fails', async h => {
  const exe = h.file('Offline/entry.exe')
  h.db.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON game_meta BEGIN SELECT RAISE(ABORT, 'fixture registration failure'); END")
  const result = h.service.registerManualGame(exe)
  assert.equal(result.ok, false)
  assert.equal((h.db.prepare('SELECT COUNT(*) AS count FROM resource WHERE path = ?').get(exe) as { count: number }).count, 0)
  assert.equal(fs.readFileSync(exe).length, 0)
})

await test('an unrelated executable beside a known product does not inherit its identity', async h => {
  h.file('Shared/YuanShen.exe')
  const game = h.game('Launcher', 'Shared/OtherGame.exe')
  const read = h.service.getGameItem(game.id)!
  assert.equal(read.name_en, 'Launcher')
  assert.notEqual(read.identity_name, '原神')
})

await test('only reliable Steam identity matches are offered for automatic fill', async h => {
  const game = h.game('Portal')
  h.fetch(async () => Response.json({ items: [{ id: 620, name: 'Portal 2', type: 'app' }] }))
  const result = await h.service.searchGameCovers(game.id)
  assert.equal(result.ok, false)
  assert.equal(h.requests.filter(url => url.includes('steamstatic.com')).length, 0)
})

await test('verified launcher aliases become the product name without altering user data', async h => {
  const game = h.game('Genshin Impact Launcher', 'Client/launcher.exe')
  h.file('Client/config.ini', '[General]\ngame_biz=hk4e_cn\n')
  const savePath = h.file('save-data/record.dat', 'save sentinel')
  const guide = h.file('docs/guide.txt', 'guide sentinel')
  games.updateGame(h.db, game.id, {
    name_zh: '原神客户端', identity_name: '原神启动器', identity_query: 'custom cover query',
    total_playtime_sec: 876, last_played_at: 1234, play_status: 'playing', notes: 'manual notes',
    save_paths: [{ path: savePath, verified_at: 55 }], linked_files: [{ path: guide, label: 'Guide', type: 'guide' }]
  })
  const before = games.getGame(h.db, game.id)!
  const after = h.service.getGameItem(game.id)!
  assert.equal(after.name_zh, '原神')
  assert.equal(after.name_en, 'Genshin Impact')
  assert.equal(after.identity_name, '原神')
  for (const key of ['id', 'path', 'identity_query', 'total_playtime_sec', 'last_played_at', 'play_status', 'notes', 'save_paths', 'linked_files'] as const) {
    assert.deepEqual(after[key], before[key], key)
  }
  assert.equal(fs.readFileSync(savePath, 'utf8'), 'save sentinel')
  assert.equal(fs.readFileSync(guide, 'utf8'), 'guide sentinel')
})

await test('a selected known executable identifies its product regardless of Windows path casing', async h => {
  const target = h.file('Shared/yuanshen.exe', 'selected game entry')
  h.file('Shared/StarRail.exe', 'another game entry')
  const result = h.service.registerManualGame(target)
  assert.equal(result.ok, true)
  assert.equal(result.item!.name_zh, '原神')
  assert.equal(result.item!.name_en, 'Genshin Impact')
  assert.equal(result.item!.path, target)
  assert.equal(h.requests.length, 0)
})

await test('configurations for several products cannot identify a shared launcher as one game', async h => {
  const game = h.game('Launcher', 'Shared/launcher.exe')
  h.file('Shared/config.ini', 'game_biz=hk4e_cn\n')
  h.file('Shared/config.json', JSON.stringify({ game_biz: 'hkrpg_cn' }))
  h.file('Shared/YuanShen Game/YuanShen.exe')
  assert.equal(h.service.getGameItem(game.id)!.name_en, 'Launcher')
})

await test('explicit identity confirmation corrects known product aliases independently from the query', async h => {
  const game = h.game('Launcher', 'Client/launcher.exe')
  const item = h.service.updateGameItem(game.id, { identity_name: 'YuanShen', identity_confirmed: true, identity_query: '原神 官方横幅' })!
  assert.equal(item.identity_name, '原神')
  assert.equal(item.name_en, 'Genshin Impact')
  assert.equal(item.identity_query, '原神 官方横幅')
  assert.equal(item.path, game.path)
})

await test('a known Genshin executable keeps its official source with a custom display name and cover keyword', async h => {
  const game = h.game('My game title', 'Client/YuanShen.exe')
  games.updateGame(h.db, game.id, { identity_query: '原神 官方横幅', notes: 'manual notes' })
  const result = await h.service.searchGameCovers(game.id)
  assert.equal(result.ok, true)
  assert.equal(result.query, '原神 官方横幅')
  assert.ok(result.candidates.some(candidate => candidate.source === 'official' && candidate.status === 'ready'))
  assert.equal(h.requests.some(url => /steam(?:powered|static)\.com/.test(url)), false, 'Known Genshin must not depend on Steam')
  const after = games.getGame(h.db, game.id)!
  assert.equal(after.name_en, 'My game title')
  assert.equal(after.identity_name, 'My game title')
  assert.equal(after.notes, 'manual notes')
  assert.equal(after.path, game.path)
})

await test('confirmed Genshin identity keeps its official source independently of the cover keyword', async h => {
  const game = h.game('Launcher', 'Client/launcher.exe')
  h.service.updateGameItem(game.id, { identity_name: '原神', identity_confirmed: true, identity_query: '原神 官方横幅' })
  const result = await h.service.searchGameCovers(game.id)
  assert.equal(result.ok, true)
  assert.equal(result.query, '原神 官方横幅')
  assert.ok(result.candidates.some(candidate => candidate.source === 'official' && candidate.status === 'ready'))
  assert.equal(h.requests.some(url => /steam(?:powered|static)\.com/.test(url)), false)
})

await test('official source refresh uses the product config after versioned images expire', async h => {
  const game = h.game('Genshin Impact', 'Client/YuanShen.exe')
  h.fetch(async url => {
    if (url.includes('/2024/04/11/')) return new Response('gone', { status: 404 })
    if (url === 'https://launcher.mihoyo.com/') return new Response('<script src="/assets/config.js"></script>')
    if (url.endsWith('/assets/config.js')) return new Response('const game={game_biz:"hk4e_cn",poster:"https://act-webstatic.mihoyo.com/new-cover.png"}')
    if (url.endsWith('/new-cover.png')) return imageResponse()
    throw new Error('unexpected network destination')
  })
  const result = await h.service.searchGameCovers(game.id)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.candidates.some(c => c.url.endsWith('/new-cover.png') && c.status === 'ready'))
  assert.ok(result.diagnostics!.some(d => d.status === 'failed' && d.message.includes('404')))
  assert.equal(h.requests.filter(url => url.includes('steampowered')).length, 0)
})

for (const type of ['text/html; charset=utf-8', 'image/png']) await test(`HTML verification pages (${type}) are distinct from corrupt image decoding and keep the selected cover`, async h => {
  const game = h.game()
  h.service.setGameCover(game.id, h.file('chosen.png', png))
  const before = games.getGame(h.db, game.id)!
  h.fetch(async () => new Response('<!doctype html><html><body>Verification required</body></html>', { headers: { 'content-type': type } }))
  const result = await h.service.setGameCoverFromUrl(game.id, 'https://images.igdb.com/verification.png')
  assert.equal(result.ok, false)
  assert.match(result.message, /HTML|网页/, type)
  assert.equal(games.getGame(h.db, game.id)!.cover_path, before.cover_path)
  assert.match(games.getGame(h.db, game.id)!.cover_detail, /HTML|网页/)
  assert.ok(fs.readFileSync(before.cover_path).equals(png))
})

for (const failure of ['network', '404']) await test(`${failure} errors keep their visible cause and the old cover`, async h => {
  const game = h.game()
  h.service.setGameCover(game.id, h.file('chosen.png', png))
  const before = games.getGame(h.db, game.id)!
  h.fetch(async () => {
    if (failure === 'network') throw new Error('fixture network unreachable')
    return new Response('gone', { status: 404 })
  })
  const result = await h.service.setGameCoverFromUrl(game.id, 'https://images.igdb.com/unavailable.png')
  assert.equal(result.ok, false)
  assert.match(result.message, failure === '404' ? /HTTP 404/ : /网络请求失败.*network unreachable/)
  assert.equal(games.getGame(h.db, game.id)!.cover_detail, result.message)
  assert.equal(games.getGame(h.db, game.id)!.cover_path, before.cover_path)
  assert.ok(fs.readFileSync(before.cover_path).equals(png))
})

await test('network limits and access errors preserve the selected cover and explain the failed stage', async h => {
  const game = h.game()
  h.service.setGameCover(game.id, h.file('chosen.png', png))
  const before = games.getGame(h.db, game.id)!
  const url = 'https://images.igdb.com/new.png'
  for (const response of [
    () => new Response('blocked', { status: 403 }),
    () => new Response('slow down', { status: 429 }),
    () => new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'content-length': String(13 * 1024 * 1024) } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(7 * 1024 * 1024)); controller.enqueue(new Uint8Array(7 * 1024 * 1024)); controller.close() } }), { headers: { 'content-type': 'image/png' } }),
    () => new Response(null, { status: 302, headers: { location: 'https://untrusted.example/private.png' } })
  ]) {
    h.fetch(async () => response())
    const result = await h.service.setGameCoverFromUrl(game.id, url)
    assert.equal(result.ok, false)
    assert.match(result.message, /网络|缓存|解码/)
    assert.equal(games.getGame(h.db, game.id)!.cover_path, before.cover_path)
    assert.ok(fs.readFileSync(before.cover_path).equals(png))
  }
  assert.ok(h.requests.every(request => request === url))
  assert.equal(fs.readdirSync(h.covers).filter(name => name.endsWith('.tmp')).length, 0)
})

await test('manual scripts and shortcuts can register offline, invalid files cannot create entries', async h => {
  for (const ext of ['lnk', 'bat', 'cmd']) {
    const target = h.file(`Offline/entry.${ext}`, 'unchanged entry')
    const result = h.service.registerManualGame(target)
    assert.equal(result.ok, true)
    assert.equal(result.item!.path, target)
    assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged entry')
  }
  assert.equal(h.service.registerManualGame(h.file('Offline/readme.txt')).ok, false)
  assert.equal(h.service.registerManualGame(path.join(h.root, 'missing.exe')).ok, false)
  const original = h.service.registerManualGame(h.file('Offline/entry.exe')).item!
  const duplicate = h.service.registerManualGame(original.path.toUpperCase())
  assert.equal(duplicate.item!.id, original.id)
  assert.equal(duplicate.item!.path, original.path)
  assert.equal(h.requests.length, 0)
})

console.log(`Game cover service regression: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
