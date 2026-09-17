/** Real scan, facts, tools and database; isolate Electron, media decoding and the LLM. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import * as video from '../electron/kinds/video/db.ts'
import { buildVideoTools, type VideoToolContext } from '../electron/kinds/video/tools.ts'
import { VIDEO_CATEGORIES, HENTAI_CATEGORY } from '../electron/kinds/video/taxonomy.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { previewVideoOrganize, applyVideoOrganize } from '../electron/kinds/video/organize.ts'
import { applyVideoRemoval, previewVideoRemoval } from '../electron/kinds/video/management.ts'
import * as localSync from '../electron/kinds/video/local-sync.ts'

const other = '\u5176\u4ed6'
let passed = 0; let failed = 0
async function test(name: string, run: (h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness()
  try { await run(h); passed++ }
  catch (error) { failed++; console.error('FAIL', name, error instanceof Error ? error.message : error) }
  finally { h.db.close(); fs.rmSync(h.root, { recursive: true, force: true }) }
}
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-identify-regression-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
  const calls: Array<{ path: string; user: string; system: string; tools: string[] }> = []
  const shellCalls: Array<{ action: string; path: string }> = []
  let context: VideoToolContext
  let failSplit = false
  let failPersistence = false
  const load = createRendererLoader({
    'node:fs': { ...fs, default: fs }, 'node:path': { ...path, default: path },
    electron: { app: { getPath: () => root }, net: {}, shell: {
      openPath: async (path: string) => { shellCalls.push({ action: 'open', path }); return '' },
      showItemInFolder: (path: string) => { shellCalls.push({ action: 'reveal', path }) }
    } },
    '../../services/database.ts': {
      getDb: () => db,
      getSettings: () => ({ ai: { enabled: true, api_key: 'fixture' }, search: {}, tmdb: {} }),
      listCategories: () => VIDEO_CATEGORIES, tagPool: () => [], saveIdentifyLog: () => {}, postersDir: () => root
    },
    '../../services/searchService.ts': { searchAvailable: () => false },
    './tmdb.ts': { tmdbAvailable: () => false }, './hentai/hanime.ts': {},
    './mediainfo.ts': { readContainerInfo: async () => null },
    './db.ts': video,
    './local-sync.ts': { ...localSync, persistVideoWorkBundle: (...args: Parameters<typeof localSync.persistVideoWorkBundle>) => {
      if (failPersistence) throw new Error('fixture metadata file is locked')
      return localSync.persistVideoWorkBundle(...args)
    } },
    './tools.ts': {
      buildVideoTools: (...args: Parameters<typeof buildVideoTools>) => {
        context = args[0]
        return buildVideoTools(...args)
      }
    },
    '../../services/agent/loop.ts': {
      runAgent: async (args: { user: string; system: string; tools: ReturnType<typeof buildVideoTools> }) => {
        calls.push({ path: context.facts.path, user: args.user, system: args.system, tools: args.tools.map(t => t.name) })
        if (failSplit && context.splitFromId) return { stopReason: 'error', tokens: 0, turns: 1 }
        const register = args.tools.find(t => t.name === 'register_video')!
        await register.execute({
          name_zh: context.facts.title_zh || context.facts.title_en || 'Sample',
          summary: 'Fixture recording', category: other, collection_name: 'Model collection'
        })
        return { stopReason: 'done', tokens: 0, turns: 1 }
      }
    }
  }, { Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout })
  const service = load('electron/kinds/video/service.ts') as typeof import('../electron/kinds/video/service.ts')
  function file(name: string) {
    const target = path.join(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '')
    return target
  }
  return { root, db, calls, shellCalls, service, file, scan: () => service.scanVideos([root], () => {}), failSplits: () => { failSplit = true; db.exec("CREATE TRIGGER fixture_fail_split BEFORE INSERT ON resource WHEN NEW.path LIKE '%Beta%' BEGIN SELECT RAISE(ABORT, 'fixture split failure'); END") }, failPersistence: () => { failPersistence = true } }
}

await test('opening the containing folder uses the actual path type even for a logical collection', async h => {
  const file = h.file('Logical/First.mp4')
  const item = registerVideoContent(h.db, { title: 'Logical collection', items: [{ title: 'First', order: 1, files: [{ path: file }] }] })
  h.db.prepare("UPDATE video_meta SET video_type = 'series' WHERE resource_id = ?").run(item.resourceId)
  await h.service.revealVideo(item.resourceId)
  assert.deepEqual(h.shellCalls, [{ action: 'reveal', path: file }], 'a video file must never be opened by the folder button')
  h.shellCalls.length = 0
  h.db.prepare('UPDATE resource SET path = ? WHERE id = ?').run(path.dirname(file), item.resourceId)
  h.db.prepare("UPDATE video_meta SET video_type = 'movie' WHERE resource_id = ?").run(item.resourceId)
  await h.service.revealVideo(item.resourceId)
  assert.deepEqual(h.shellCalls, [{ action: 'open', path: path.dirname(file) }])
})

await test('raw filenames enable Hanime tools under a generic storage folder', async h => {
  const name = 'Feature.[\u4e2d\u6587\u5b57\u5e55].mp4'
  h.file('Downloads/' + name)
  assert.equal((await h.scan()).registered, 1)
  assert.equal(h.calls.length,0)
  await h.service.reidentifyVideo(video.listVideos(h.db,{type:'hentai'})[0].id)
  assert.ok(h.calls[0].tools.includes('hanime_search'))
  assert.ok(h.calls[0].tools.includes('hanime_detail'))
  assert.ok(h.calls[0].user.includes(name))
  assert.ok(h.calls[0].user.includes('Downloads'))
})
await test('unchanged files skip the Agent and explicit reidentify still runs', async h => {
  h.file('Repeat/Example.mp4'); await h.scan(); h.calls.length = 0
  const result = await h.scan()
  assert.equal(result.skipped, 1); assert.equal(h.calls.length, 0)
  const item = video.listVideos(h.db)[0]
  assert.equal(item.collection_name, '')
  await h.service.reidentifyVideo(item.id)
  assert.equal(h.calls.length, 1)
})
await test('forced hentai scraping does not stop at a local NFO', async h => {
  h.file('Nfo/Example.mp4')
  fs.writeFileSync(h.file('Nfo/Example.nfo'), '<movie><title>Example</title><plot>Local text</plot></movie>')
  await h.scan(); h.calls.length = 0
  const item = video.listVideos(h.db)[0]
  await h.service.reidentifyVideo(item.id, true)
  assert.equal(h.calls.length, 1); assert.ok(h.calls[0].tools.includes('hanime_detail'))
})
await test('historical organized originals skip the Agent before the first new fingerprint', async h => {
  const files = [h.file('Original/A.mp4'), h.file('Original/B.mp4')]
  const ids = files.map((p,i) => registerVideoContent(h.db, { title: 'Old '+i, items: [{ title: 'Old '+i, order: i+1, files: [{ path: p }] }] }).resourceId)
  const preview = previewVideoOrganize(h.db, { resourceIds: ids, survivorId: ids[0], collectionTitle: 'Old collection', targetDirectory: path.join(h.root,'Organized') })
  assert.equal((await applyVideoOrganize(h.db, { preview, mode: 'physical' })).status,'applied')
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM video_scan_state').get()?.n, 0)
  await h.scan()
  assert.equal(h.calls.length, 0, 'retained originals have an exact recorded owner')
  fs.writeFileSync(files[0], 'changed original')
  const changed = await h.scan()
  assert.ok(changed.entries?.some(entry=>entry.path===files[0] && entry.status!=='skipped'), 'changed original must not be silently ignored')
  assert.equal(h.calls.length, 0)
  h.file('Original/New.mp4'); h.calls.length = 0
  const added = await h.scan()
  assert.ok(added.entries?.some(entry=>entry.path.endsWith('New.mp4') && entry.status!=='skipped'), 'new video still goes through local identification')
  assert.equal(h.calls.length, 0)
})
await test('overlapping scan roots import one bundle once and removed works stay skipped', async h => {
  const file = h.file('Bundle/Movie.mp4')
  const id = registerVideoContent(h.db, { title: 'Bundle', directory: path.dirname(file), items: [{ title: 'Movie', order: 1, files: [{ path: file }] }] }).resourceId
  const { persistVideoWorkBundle } = await import('../electron/kinds/video/local-sync.ts')
  persistVideoWorkBundle(h.db, id)
  const scan = await h.service.scanVideos([h.root, path.dirname(file)], () => {})
  assert.equal(scan.candidates, 1); assert.equal(scan.registered, 1); assert.equal(scan.entries?.length, 1)
  await h.service.removeVideo(id)
  const removed = await h.scan()
  assert.equal(removed.failed, 0); assert.equal(removed.skipped, 1); assert.equal(video.listVideos(h.db).length, 0)
  const restored = await h.service.scanVideos([h.root], () => {}, true)
  assert.equal(restored.registered, 1); assert.equal(video.listVideos(h.db).length, 1)
})
await test('a detached episode stays independent when filenames are still one scanned series', async h => {
  h.file('Detached/Series.S01E01.mp4'); h.file('Detached/Series.S01E02.mp4')
  await h.scan()
  const work = video.listVideos(h.db)[0], episode = video.listEpisodes(h.db,work.id)[0]
  const detached = await applyVideoRemoval(h.db,previewVideoRemoval(h.db,{resourceIds:[work.id],episodeId:episode.id,action:'detach',deleteLocal:false}))
  await h.scan()
  assert.equal(video.getEpisode(h.db,episode.id)?.resource_id,detached.detachedId)
  assert.equal(video.listEpisodes(h.db,work.id).length,1)
  assert.equal(video.listEpisodes(h.db,detached.detachedId).length,1)
})
await test('successful bundle registration is not counted as failed when the manifest cannot be refreshed', async h => {
  const file = h.file('Locked/Movie.mp4')
  const id = registerVideoContent(h.db, { title: 'Locked bundle', directory: path.dirname(file), items: [{ title: 'Movie', order: 1, files: [{ path: file }] }] }).resourceId
  localSync.persistVideoWorkBundle(h.db, id)
  h.failPersistence()
  const result = await h.service.scanVideos([h.root], () => {}, true)
  assert.equal(result.registered, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.entries?.[0].status, 'updated')
  assert.match(result.entries?.[0].message || '', /清单待保存/)
  assert.equal(video.listVideos(h.db).length, 1)
})
await test('mixed series and recordings reach separate registration calls with sibling context', async h => {
  h.file('Shared/Alpha.S01E01.mkv'); h.file('Shared/Alpha.S01E02.mkv')
  h.file('Shared/Beta.S01E01.mkv'); h.file('Shared/Training.mp4')
  const result = await h.scan()
  assert.equal(result.candidates, 3); assert.equal(result.registered, 3)
  assert.equal(video.listVideos(h.db).length, 3)
  assert.equal(h.calls.length,0)
  for (const item of video.listVideos(h.db)) await h.service.reidentifyVideo(item.id)
  const alpha = h.calls.find(c => c.path.includes('Alpha'))!
  assert.ok(alpha.user.includes('Alpha.S01E02.mkv')); assert.ok(alpha.user.includes('Beta'))
  assert.ok(h.calls.every(c => !c.tools.includes('hanime_search')))
})
await test('folder splitting and single-item reidentification preserve ownership and explicit type', async h => {
  h.file('Shared/Alpha.mp4'); await h.scan()
  const first = video.listVideos(h.db)[0]
  video.updateVideo(h.db, first.id, { category: HENTAI_CATEGORY, collection_name: 'User collection', watch_status: 'watched' })
  h.file('Shared/Beta.mp4'); h.calls.length = 0
  await h.scan()
  const restored = video.getVideo(h.db, first.id)!
  assert.equal(restored.path, path.join(h.root, 'Shared/Alpha.mp4'))
  assert.equal(restored.watch_status, 'watched'); assert.equal(restored.collection_name, 'User collection')
  assert.equal(restored.category, HENTAI_CATEGORY)
  assert.equal(video.listVideos(h.db).length, 1)
  assert.equal(video.listVideos(h.db, { type: 'hentai' }).length, 1)
  assert.equal(h.calls.length,0,'a local rescan does not automatically invoke the Agent')
  await h.service.reidentifyVideo(video.listVideos(h.db)[0].id)
  assert.ok(!h.calls[0].tools.includes('hanime_search'))
  h.calls.length = 0
  assert.equal((await h.service.reidentifyVideo(first.id))?.id, first.id)
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, restored.path)
  assert.ok(h.calls[0].tools.includes('hanime_search'))
})
await test('an earlier representative episode retains series identity and episode position', async h => {
  h.file('Shared/Alpha.S01E02.mkv'); h.file('Shared/Beta.mp4'); await h.scan()
  const first = video.listVideos(h.db).find(item => item.video_type === 'series')!
  const second = video.listEpisodes(h.db, first.id)[0]
  video.updateEpisode(h.db, second.id, { position_sec: 45 })
  h.file('Shared/Alpha.S01E01.mkv'); await h.scan()
  assert.equal(video.listVideos(h.db).length, 2)
  assert.equal(video.getVideo(h.db, first.id)?.path, path.join(h.root, 'Shared/Alpha.S01E01.mkv'))
  assert.equal(video.listEpisodes(h.db, first.id).find(ep => ep.episode === 2)?.position_sec, 45)
  assert.equal((await h.service.reidentifyVideo(first.id))?.id, first.id)
})

async function legacyMergedSeries(h: ReturnType<typeof harness>) {
  h.file('Shared/Alpha.S01E01.mkv'); h.file('Shared/Beta.S01E02.mkv'); await h.scan()
  const alpha = video.listVideos(h.db).find(item => item.path.includes('Alpha'))!
  const beta = video.listVideos(h.db).find(item => item.path.includes('Beta'))!
  const betaEpisode = video.listEpisodes(h.db, beta.id)[0]
  video.updateEpisode(h.db, betaEpisode.id, { position_sec: 65 })
  h.db.prepare('UPDATE episode SET resource_id = ? WHERE resource_id = ?').run(alpha.id, beta.id)
  h.db.prepare('DELETE FROM resource WHERE id = ?').run(beta.id)
  h.db.prepare('UPDATE resource SET path = ?, name_zh = ? WHERE id = ?').run(path.join(h.root, 'Shared'), 'Old merged folder', alpha.id)
  h.file('Shared/Alpha.S01E02.mkv')
  return { originalId: alpha.id, betaEpisodeId: betaEpisode.id }
}
for (const mode of ['scan', 'reidentify'] as const) {
  await test(`${mode} splits a legacy mixed series before episode slots can overwrite another work`, async h => {
    const { originalId, betaEpisodeId } = await legacyMergedSeries(h)
    if (mode === 'scan') await h.scan()
    else assert.equal((await h.service.reidentifyVideo(originalId))?.id, originalId)
    assert.equal(video.listVideos(h.db).length, 2)
    const beta = video.listVideos(h.db).find(item => item.path.includes('Beta'))!
    assert.notEqual(beta.id, originalId)
    const betaEpisodes = video.listEpisodes(h.db, beta.id)
    assert.equal(betaEpisodes.length, 1)
    assert.equal(betaEpisodes[0].id, betaEpisodeId); assert.equal(betaEpisodes[0].position_sec, 65)
    const alphaEpisodes = video.listEpisodes(h.db, originalId)
    assert.equal(alphaEpisodes.length, 2)
    assert.equal(alphaEpisodes.find(ep => ep.episode === 2)?.position_sec, 0)
    await h.scan()
    assert.equal(video.listVideos(h.db).length, 2)
    assert.equal(video.getEpisode(h.db, betaEpisodeId)?.position_sec, 65)
  })
}
await test('a failed split keeps the old owner and episode progress intact', async h => {
  const { originalId, betaEpisodeId } = await legacyMergedSeries(h)
  h.failSplits(); h.calls.length = 0
  assert.ok((await h.scan()).failed > 0)
  assert.equal(h.calls.length, 0)
  assert.equal(video.listVideos(h.db).length, 1)
  assert.equal(video.getVideo(h.db, originalId)?.path, path.join(h.root, 'Shared'))
  assert.equal(video.getEpisode(h.db, betaEpisodeId)?.resource_id, originalId)
  assert.equal(video.getEpisode(h.db, betaEpisodeId)?.position_sec, 65)
})

console.log(`Video identify service regression: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
