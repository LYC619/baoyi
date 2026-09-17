import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { emptyFacts, mergeFacts } from '../electron/kinds/video/facts.ts'
import { parseNfo } from '../electron/kinds/video/nfo.ts'
import { scanVideoRoot } from '../electron/kinds/video/scanner.ts'
import { registerLocalVideoFacts, registerVideoContent, registerVideoBundle } from '../electron/kinds/video/registration.ts'
import { ignoredVideoFile } from '../electron/kinds/video/scan-ignores.ts'
import { readVideoLocalMetadata } from '../electron/kinds/video/local-metadata.ts'
import { parseDetail } from '../electron/kinds/video/hentai/selectors.ts'
import { getVideo, listEpisodes, listVideos, updateVideo, updateEpisode } from '../electron/kinds/video/db.ts'
import { syncVideoWorkFiles } from '../electron/kinds/video/local-sync.ts'
import { HENTAI_CATEGORY } from '../electron/kinds/video/taxonomy.ts'
import { previewVideoRemoval, applyVideoRemoval, bulkUpdateVideos } from '../electron/kinds/video/management.ts'
import { previewVideoOrganize, applyVideoOrganize, rollbackVideoOrganize, retryVideoOrganize } from '../electron/kinds/video/organize.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-feedback-fixes-'))
const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
let failed = 0, passed = 0
function test(name: string, run: () => void) { try { run(); passed++ } catch (e) { failed++; console.error('FAIL', name, e) } }
function file(name: string, data = '') { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p }

test('NFO retains original title, all tags and hentai evidence', () => {
  file('nfo/Story Vol.1 [中文字幕].mp4')
  const candidate = scanVideoRoot(path.join(root, 'nfo'))[0]
  const facts = mergeFacts(candidate, parseNfo('<movie><title>故事 第一集</title><originaltitle>Original Story</originaltitle><genre>Anime</genre><mpaa>X</mpaa><tag>Tag A</tag><tag>Tag B</tag><plot>Local synopsis</plot></movie>'), new Map(), new Map())
  const result = registerLocalVideoFacts(db, facts)
  const item = getVideo(db, result.id)!
  assert.equal(item.name_en, 'Original Story'); assert.ok(item.tags.includes('Tag A')); assert.ok(item.tags.includes('Tag B'))
  assert.equal(item.category, HENTAI_CATEGORY)
})
test('a loose file in a shared subdirectory does not adopt its neighbours', () => {
  const a = file('shared/One.mp4'), b = file('shared/Two.mp4')
  const ids = [a, b].map(p => registerLocalVideoFacts(db, { ...emptyFacts(), path: p, dir: path.dirname(p), title_zh: path.basename(p), parts: [{ path: p, label: '', file_size: 0, duration_sec: 0 }] }).id)
  const sync = syncVideoWorkFiles(db, ids[0])
  assert.equal(sync.itemsAdded, 0); assert.equal(getVideo(db, ids[0])!.path, a)
  assert.equal(fs.existsSync(path.join(root, 'shared/baoyi.json')), false)
})
test('new episodes match renamed viewer JSON, titles, images and sources independently', () => {
  const dir = path.join(root, 'viewer'), first = file('viewer/Sample 1 [501001].mp4')
  const result = registerVideoContent(db, { title: 'Sample', directory: dir, items: [{ title: 'Sample 1', order: 1, files: [{ path: first }] }] })
  file('viewer/info.json', JSON.stringify({ title: 'Sample 1', introduction: 'First description', coverUrl: 'https://fixture.test/image/thumbnail/1.jpg', tags: ['First'], videoUrls: {} }))
  file('viewer/Sample 1 [501001].png', 'image-one')
  file('viewer/Sample 2 [501002].mp4')
  file('viewer/info1.json', JSON.stringify({ title: 'Sample 2', introduction: 'Second description', coverUrl: 'https://fixture.test/image/thumbnail/2.jpg', tags: ['Second'], videoUrls: {} }))
  file('viewer/Sample 2 [501002].png', 'image-two')
  const sync = syncVideoWorkFiles(db, result.resourceId, { persist: false })
  const second = sync.library.contents.find(ep => ep.title === 'Sample 2')!
  assert.ok(second); assert.equal(second.description, 'Second description'); assert.deepEqual(second.tags, ['Second'])
  assert.ok(second.poster_path?.endsWith('Sample 2 [501002].png'))
  assert.ok(second.sources.some(s => s.externalId === '501002'))
  assert.ok(second.assets.some(a => a.path.endsWith('info1.json')))
  assert.equal(listEpisodes(db, result.resourceId).length, 2)
})

test('grouped NFO episodes retain independent descriptions, original names and searchable tags', () => {
  const a = file('grouped/Story.S01E01.mp4'), b = file('grouped/Story.S01E02.mp4')
  const candidate = scanVideoRoot(path.dirname(a))[0]
  const nfos = new Map([a,b].map((p,i) => [p, parseNfo(`<episodedetails><title>Chapter ${i+1}</title><originaltitle>Original ${i+1}</originaltitle><plot>Plot ${i+1}</plot><tag>Episode tag ${i+1}</tag></episodedetails>`)!]))
  const result = registerLocalVideoFacts(db, mergeFacts(candidate, null, nfos, new Map()))
  const rows = listEpisodes(db, result.id)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(e => e.description), ['Plot 1', 'Plot 2'])
  assert.deepEqual(rows.map(e => e.original_title), ['Original 1', 'Original 2'])
  assert.deepEqual(rows[1].tags, ['Episode tag 2'])
  assert.ok(listVideos(db, { tag: 'Episode tag 2' }).some(v => v.id === result.id))
})
test('viewer quality suffixes still match their own image and NFO', () => {
  const a=file('quality/One [701001]_720P.mp4');file('quality/Two [701002]_1080P.mp4')
  const own=file('quality/One [701001].png','image');file('quality/Two [701002].png','other image')
  file('quality/One [701001].nfo','<movie><title>One</title><plot>Own details</plot></movie>')
  const metadata=readVideoLocalMetadata(a)
  assert.equal(metadata.posterPath,own);assert.equal(metadata.description,'Own details')
  assert.ok(!metadata.attachments?.some(f=>f.path.includes('Two')))
})
test('Hanime artwork candidates exclude unrelated adverts inside detail and player containers', () => {
  const detail=parseDetail('<meta property="og:image" content="https://fixture.invalid/image/cover/title.jpg"><video poster="https://fixture.invalid/image/thumbnail/episode.jpg"></video><div class="video-details-wrapper"><img src="https://ads.invalid/banner.png"></div><div id="player-div-wrapper"><img src="https://ads.invalid/pixel.gif"></div>')
  assert.deepEqual(detail.artworkUrls,['https://fixture.invalid/image/cover/title.jpg','https://fixture.invalid/image/thumbnail/episode.jpg'])
  const noPlayerPoster = parseDetail('<meta property="og:image" content="https://fixture.invalid/image/cover/title.jpg"><div id="player-div-wrapper"><img src="https://ads.invalid/pixel.gif"></div>')
  assert.deepEqual(noPlayerPoster.artworkUrls, ['https://fixture.invalid/image/cover/title.jpg'])
})
test('bulk tag removal clears both ordinary and source work tags without changing episode tags', () => {
  const work = registerVideoContent(db, { title: 'Bulk tags', items: [{ title: 'Tagged episode', order: 1, tags: ['Keep episode tag'], files: [{ path: file('bulk/Tagged.mp4') }] }] })
  updateVideo(db, work.resourceId, { tags: ['Remove', 'Keep'], hanime_tags: ['Remove', 'Source only'] })
  bulkUpdateVideos(db, [work.resourceId], { addTags: ['Added'], removeTags: ['Remove'] })
  const item = getVideo(db, work.resourceId)!
  assert.deepEqual(item.tags, ['Keep', 'Added'])
  assert.deepEqual(item.hanime_tags, ['Source only'])
  assert.deepEqual(listEpisodes(db, work.resourceId)[0].tags, ['Keep episode tag'])
})

try {
  const a = file('shared-removal/One.mp4'), b = file('shared-removal/Two.mp4'), cover = file('shared-removal/cover.png', 'shared artwork')
  const work = registerVideoContent(db, { title: 'Shared artwork', directory: path.dirname(a), posterPath: cover,
    items: [{ title: 'One', order: 1, files: [{ path: a }], attachments: [{ path: cover, role: 'poster' }] }, { title: 'Two', order: 2, files: [{ path: b }] }] })
  const other = registerVideoContent(db, { title: 'Legacy shared user', items: [{ title: 'Separate', order: 1, files: [{ path: file('legacy-ref/Separate.mp4') }] }] })
  updateVideo(db, other.resourceId, { linked_files: [{ path: a, label: 'Shared original', type: 'other' }] })
  const ep = listEpisodes(db, work.resourceId)[0]
  updateEpisode(db, ep.id, { poster_path: cover })
  const preview = previewVideoRemoval(db, { resourceIds: [work.resourceId], episodeId: ep.id, action: 'remove', deleteLocal: true })
  assert.ok(preview.files.find(f => f.path === cover)?.shared, 'parent cover is still in use')
  assert.ok(preview.files.find(f => f.path === a)?.shared, 'legacy references protect shared videos')
  const deleted: string[] = []
  await applyVideoRemoval(db, preview, async p => { deleted.push(p); fs.unlinkSync(p) })
  assert.ok(!deleted.includes(a) && !deleted.includes(cover)); assert.ok(fs.existsSync(a) && fs.existsSync(cover))
  passed++
} catch (error) { failed++; console.error('FAIL shared files protected during episode removal', error) }

try {
  const dir = path.join(root, 'remove'), a = file('remove/Alpha 1.mp4'), b = file('remove/Alpha 2.mp4')
  const work = registerVideoContent(db, { title: 'Alpha', directory: dir, items: [{ title: 'Alpha 1', order: 1, files: [{ path: a }] }, { title: 'Alpha 2', order: 2, tags: ['Episode two'], files: [{ path: b }] }] })
  const ep = listEpisodes(db, work.resourceId)[1]
  fs.unlinkSync(b)
  const preview = previewVideoRemoval(db, { resourceIds: [work.resourceId], episodeId: ep.id, action: 'remove', deleteLocal: false })
  await applyVideoRemoval(db, preview)
  assert.equal(listEpisodes(db, work.resourceId).length, 1)
  file('remove/Alpha 2.mp4')
  syncVideoWorkFiles(db, work.resourceId)
  assert.equal(listEpisodes(db, work.resourceId).length, 1, 'removed content does not reappear on checking files')
  bulkUpdateVideos(db, [work.resourceId], { collection: 'My group', addTags: ['Keep', 'Remove'] })
  bulkUpdateVideos(db, [work.resourceId], { removeTags: ['Remove'] })
  assert.deepEqual(getVideo(db, work.resourceId)?.tags, ['Keep'])
  assert.equal(getVideo(db, work.resourceId)?.collection_name, 'My group')
  const detached = await applyVideoRemoval(db, previewVideoRemoval(db, { resourceIds: [work.resourceId], episodeId: listEpisodes(db,work.resourceId)[0].id, action: 'detach', deleteLocal: false }))
  assert.ok(detached.detachedId); assert.notEqual(detached.detachedId,work.resourceId); assert.equal(listEpisodes(db, detached.detachedId).length, 1)
  assert.ok(fs.existsSync(a)); syncVideoWorkFiles(db, work.resourceId)
  assert.equal(listEpisodes(db, work.resourceId).length, 0)
  assert.equal(ignoredVideoFile(db, a), false, 'detached video remains eligible for its own scan')
  assert.equal(ignoredVideoFile(db, a, work.resourceId), true, 'former collection still excludes it')
  registerVideoBundle(db, dir, true)
  assert.equal(listEpisodes(db, work.resourceId).length, 1, 'explicit import can restore the removed second episode')
  assert.equal(listEpisodes(db, detached.detachedId).length, 1, 'explicit import does not steal the detached episode')
  assert.equal(ignoredVideoFile(db, b), false)
  passed++
} catch (error) { failed++; console.error('FAIL removal, detach and bulk management', error) }
try {
  const a = file('move-source/one/Move 1.mp4', 'first video'), b = file('move-source/two/Move 2.mp4', 'second video')
  file('move-source/one/info.json', JSON.stringify({ title: 'Move 1', introduction: 'First', coverUrl: '', videoUrls: {} }))
  file('move-source/two/info.json', JSON.stringify({ title: 'Move 2', introduction: 'Second', coverUrl: '', videoUrls: {} }))
  file('move-source/one/.nomedia'); file('move-source/two/.nomedia')
  const ids = [a,b].map((p,i) => registerVideoContent(db, { title: 'Move '+(i+1), items: [{ title: 'Move '+(i+1), order: i+1, tags: ['Tag '+i], files: [{ path:p }] }] }).resourceId)
  const preview = previewVideoOrganize(db, { resourceIds: ids, survivorId: ids[0], collectionTitle: 'Move', transfer: 'move', targetDirectory: path.join(root,'move-target') })
  assert.equal(preview.collisions.length,0)
  assert.equal(preview.files.filter(f=>f.source.endsWith('info.json')).length,2)
  assert.equal(preview.files.filter(f=>f.source.endsWith('.nomedia')).length,1)
  const done = await applyVideoOrganize(db,{ preview,mode:'physical' })
  assert.equal(done.status,'applied', JSON.stringify(done.conflicts)); assert.ok(!fs.existsSync(a)); assert.ok(!fs.existsSync(b))
  assert.ok(listEpisodes(db,ids[0]).every(e=>e.tags?.length))
  const restored = await rollbackVideoOrganize(db,done.id)
  assert.equal(restored.status,'rolled-back',JSON.stringify(restored.conflicts)); assert.ok(fs.existsSync(a)); assert.ok(fs.existsSync(b))
  passed++
} catch (error) { failed++; console.error('FAIL move, same-name metadata and recovery',error) }

try {
  const source = file('deep-move/Media.mp4', 'video content')
  const metadata = file('deep-move/info.json', JSON.stringify({ title: 'Media', introduction: 'metadata', tags: [], videoUrls: {} }))
  const work = registerVideoContent(db, { title: 'Deep attachment path', items: [{ title: 'Media', order: 1, files: [{ path: source }], attachments: [{ path: metadata, role: 'attachment' }] }] })
  const target = path.join(root, 'target-' + 'd'.repeat(Math.max(8, 140 - root.length - 8)))
  const preview = previewVideoOrganize(db, { resourceIds: [work.resourceId], survivorId: work.resourceId, collectionTitle: 'Deep path', transfer: 'move', targetDirectory: target })
  assert.equal(preview.collisions.length, 0)
  const done = await applyVideoOrganize(db, { preview, mode: 'physical' })
  assert.equal(done.status, 'applied', JSON.stringify(done.files.filter(f => f.error)))
  assert.equal(fs.existsSync(source), false); assert.equal(fs.existsSync(metadata), false)
  assert.equal((await rollbackVideoOrganize(db, done.id)).status, 'rolled-back')
  assert.equal(fs.readFileSync(source, 'utf8'), 'video content')
  passed++
} catch (error) { failed++; console.error('FAIL internal staging accommodates valid deeper attachment paths', error) }

try {
  const source = file('interrupted-move/Retry.mp4', 'recoverable content')
  const work = registerVideoContent(db, { title: 'Interrupted move', items: [{ title: 'Retry', order: 1, files: [{ path: source }] }] })
  const preview = previewVideoOrganize(db, { resourceIds: [work.resourceId], survivorId: work.resourceId, collectionTitle: 'Retry', transfer: 'move', targetDirectory: path.join(root,'retried-target') })
  const unlink = fs.promises.unlink
  let interrupted = false
  fs.promises.unlink = async p => { await unlink(p); if (String(p) === source && !interrupted) { interrupted = true; throw new Error('simulated interruption after source unlink') } }
  let partial
  try { partial = await applyVideoOrganize(db, { preview, mode: 'physical' }) } finally { fs.promises.unlink = unlink }
  assert.equal(partial.status, 'partial'); assert.ok(!fs.existsSync(source))
  const retried = await retryVideoOrganize(db, partial.id)
  assert.equal(retried.status, 'applied', JSON.stringify(retried.conflicts))
  assert.ok(retried.files.find(f => f.source === source)?.sourceRemoved)
  const rollback = await rollbackVideoOrganize(db, partial.id)
  assert.equal(rollback.status, 'rolled-back'); assert.equal(fs.readFileSync(source,'utf8'), 'recoverable content')
  passed++
} catch (error) { failed++; console.error('FAIL interrupted move recovery', error) }
db.close(); fs.rmSync(root, { recursive: true, force: true })
console.log(`New video feedback fixes: ${passed} passed / ${failed} failed`); process.exitCode = failed ? 1 : 0
