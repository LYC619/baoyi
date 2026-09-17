import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { getVideo, listEpisodes, listVideos } from '../electron/kinds/video/db.ts'
import * as videoDb from '../electron/kinds/video/db.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { syncVideoWorkFiles } from '../electron/kinds/video/local-sync.ts'
import { previewVideoOrganize, applyVideoOrganize } from '../electron/kinds/video/organize.ts'
import { previewVideoRemoval, applyVideoRemoval } from '../electron/kinds/video/management.ts'
import { registerVideoAsset } from '../electron/kinds/video/library.ts'
import { readVideoLocalMetadata } from '../electron/kinds/video/local-metadata.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { VIDEO_CATEGORIES } from '../electron/kinds/video/taxonomy.ts'
import { videoDateLabel } from '../src/utils/video-content.ts'

function localService(f: ReturnType<typeof fixture>, enabled = true) {
  let agentCalls = 0
  const logs: Array<Record<string, any>> = []
  const load = createRendererLoader({
    'node:fs': { ...fs, default: fs }, 'node:path': { ...path, default:path },
    electron: { app: { getPath: () => f.root }, net: {}, shell: {} },
    '../../services/database.ts': { getDb: () => f.db, getSettings: () => ({ ai:{enabled,api_key:enabled?'fixture':''},search:{},tmdb:{} }),
      listCategories: () => VIDEO_CATEGORIES, tagPool: () => [], saveIdentifyLog: (log:Record<string,any>) => logs.push(log), postersDir: () => f.root },
    '../../services/searchService.ts': { searchAvailable: () => false }, './tmdb.ts': { tmdbAvailable: () => false },
    './hentai/hanime.ts': {}, './mediainfo.ts': { readContainerInfo: async () => null }, './db.ts': videoDb,
    './tools.ts': { buildVideoTools: () => [] },
    '../../services/agent/loop.ts': { runAgent: async () => { agentCalls++; return {stopReason:'error',tokens:12,turns:1} } }
  }, { Buffer,URL,AbortController,AbortSignal,setTimeout,clearTimeout })
  return { service:load('electron/kinds/video/service.ts') as typeof import('../electron/kinds/video/service.ts'), calls:()=>agentCalls,logs }
}

let passed = 0, failed = 0
const filter = process.argv.find(arg => arg.startsWith('--filter='))?.slice(9)
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-library-usability-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
  const file = (name: string, content = 'synthetic media') => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p }
  const source = (number: number) => ({ provider: 'hanime', externalId: String(810000 + number), pageUrl: 'https://hanime1.me/watch?v=' + (810000 + number), scope: 'episode' as const, evidence: 'nfo' as const })
  const work = (number = 1, folder = 'Library') => registerVideoContent(db, { title: `故事 ${number}`, items: [{ title: `故事 ${number}`,
    originalTitle: `Original Story #${number}`, number, order: number, sources: [source(number)],
    files: [{ path: file(`${folder}/Original Story #${number} [中文字幕]_720P.mp4`) }] }] }).resourceId
  const close = () => { db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('baoyi-library-usability-')); fs.rmSync(root, { recursive: true, force: true }) }
  return { root, db, file, source, work, close }
}
async function test(name: string, run: (f: ReturnType<typeof fixture>) => void | Promise<void>) {
  if (filter && !name.includes(filter)) return
  const f = fixture()
  try { await run(f); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []); passed++ }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e instanceof Error ? e.message : e)) }
  finally { f.close() }
}

await test('loose check discovers an episode absent from the existing catalogue', f => {
  const id = f.work(), first = listEpisodes(f.db, id)[0]
  f.db.prepare("UPDATE episode SET watch_status='watching',position_sec=81,notes='keep' WHERE id=?").run(first.id)
  const second = f.file('Library/Original Story #2 [中文字幕]_720P.mp4')
  f.file('Library/Other Story #2 [中文字幕]_720P.mp4')
  const result = syncVideoWorkFiles(f.db, id)
  assert.equal(result.filesAdded, 1); assert.equal(result.itemsAdded, 1)
  assert.equal(result.library.contents.find(e => e.episode === 2)?.path, second)
  assert.equal(result.library.contents.length, 2)
  assert.equal(listEpisodes(f.db, id)[0].position_sec, 81)
  assert.equal(listEpisodes(f.db, id)[0].notes, 'keep')
  assert.equal(syncVideoWorkFiles(f.db, id).filesAdded, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_directories WHERE resource_id=?').get(id)!.n, 0)
  assert.ok(!fs.existsSync(path.join(f.root, 'Library/baoyi.json')))
})

await test('local metadata with a new source may introduce a new sibling episode', f => {
  const id = f.work()
  const second = f.file('Library/Original Story #2 [中文字幕]_720P.mp4')
  f.file('Library/info.json', JSON.stringify({ title: 'Original Story #2', chineseTitle: '故事 2', introduction: 'Second episode description',
    videoCode: f.source(2).externalId, coverUrl: '', videoUrls: [] }))
  const result = syncVideoWorkFiles(f.db, id)
  assert.equal(result.filesAdded, 1)
  const ep = result.library.contents.find(e => e.path === second)!
  assert.equal(ep.description, 'Second episode description')
  assert.ok(ep.sources.some(s => s.externalId === f.source(2).externalId))
})

await test('managed posters do not become candidate media directories', f => {
  const id = f.work()
  registerVideoAsset(f.db, { resourceId: id, role: 'poster', path: f.file('data/posters/cover.png') })
  f.file('Library/Original Story #2 [中文字幕]_720P.mp4')
  assert.equal(syncVideoWorkFiles(f.db, id).filesAdded, 1)
})

await test('logical collection checks all known video folders', async f => {
  const a = f.work(1, 'One'), b = f.work(2, 'Two')
  const j = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, { resourceIds: [a,b], survivorId: a, collectionTitle: '故事' }), mode: 'logical' })
  assert.equal(j.status, 'applied')
  const third = f.file('Two/Original Story #3 [中文字幕]_720P.mp4')
  const result = syncVideoWorkFiles(f.db, a)
  assert.equal(result.filesAdded, 1)
  assert.equal(result.library.contents.find(e => e.episode === 3)?.path, third)
})

await test('independent siblings and explicitly removed files remain excluded', async f => {
  const id = f.work(), other = f.work(2)
  assert.equal(syncVideoWorkFiles(f.db, id).filesAdded, 0)
  assert.equal(listEpisodes(f.db, other).length, 1)
  const third = f.file('Library/Original Story #3 [中文字幕]_720P.mp4')
  registerVideoContent(f.db, { resourceId: id, title: getVideo(f.db,id)!.name_zh, items: [{ title:'故事 3', originalTitle: 'Original Story #3', number:3, order:3, files:[{path:third}] }] })
  const episodeId = listEpisodes(f.db,id).find(e=>e.episode===3)!.id
  await applyVideoRemoval(f.db, previewVideoRemoval(f.db, { resourceIds:[id], episodeId, action:'remove', deleteLocal:false }))
  assert.equal(syncVideoWorkFiles(f.db,id).filesAdded,0)
  assert.equal(listEpisodes(f.db,id).length,1)
})

await test('HanimeViewer upload date and studio survive local import without Agent', async f => {
  f.file('Viewer/Original Story #1 [中文字幕]_720P.mp4')
  f.file('Viewer/info.json', JSON.stringify({title:'Original Story #1',chineseTitle:'故事 1',introduction:'Local introduction',
    uploadTime:'2026-06-04',artist:'Example Studio',coverUrl:'',videoUrls:[],tags:['Animation']}))
  const h=localService(f)
  const result=await h.service.scanVideos([path.join(f.root,'Viewer')],()=>{})
  assert.equal(h.calls(),0,'ordinary scans must not invoke a configured Agent')
  assert.equal(result.tokens,0); assert.equal(result.registered,1)
  const id=String(f.db.prepare("SELECT id FROM resource WHERE kind='video'").get()!.id)
  const episode=listEpisodes(f.db,id)[0]
  assert.equal(episode?.published_at,Date.UTC(2026,5,4))
  assert.equal(episode?.studio,'Example Studio')
  assert.equal(episode?.description,'Local introduction')
  assert.equal(h.logs.length,1,'offline imports retain a readable identification log')
  assert.match(h.logs[0].events[0].text,/2026-06-04/)
  assert.equal((await h.service.listVideoItems({type:'hentai'}))[0].pending_reasons?.includes('metadata'),false)
})

await test('filename-only registration is marked for optional Agent review', async f => {
  f.file('Unknown/Unknown film.mp4')
  const h=localService(f)
  const result=await h.service.scanVideos([path.join(f.root,'Unknown')],()=>{})
  assert.equal(h.calls(),0); assert.equal(result.registered,1)
  assert.equal(result.entries?.[0].status,'review')
  assert.ok((await h.service.listVideoItems())[0].pending_reasons?.includes('metadata'))
  const id=result.entries![0].resourceId!
  await h.service.reidentifyVideo(id)
  assert.equal(h.calls(),1,'explicit reidentification remains an Agent operation')
})

await test('local readiness is usable without a model or degradation confirmation', f => {
  assert.deepEqual(JSON.parse(JSON.stringify(localService(f,false).service.videoScanReadiness())),{ok:true,message:''})
})

await test('a local rescan preserves previously scraped metadata when sidecars are absent', async f => {
  const file=f.file('Existing/Film.mp4'), h=localService(f)
  const first=await h.service.scanVideos([path.dirname(file)],()=>{})
  const id=first.entries![0].resourceId!
  f.db.prepare("UPDATE resource SET name_zh='Confirmed title',description='Scraped introduction',summary='Scraped introduction',ai_status='done' WHERE id=?").run(id)
  fs.appendFileSync(file,'changed media')
  const second=await h.service.scanVideos([path.dirname(file)],()=>{})
  assert.equal(second.registered,1)
  assert.equal(getVideo(f.db,id)?.description,'Scraped introduction')
  assert.equal(getVideo(f.db,id)?.name_zh,'Confirmed title')
  assert.equal(getVideo(f.db,id)?.needs_review,false)
  assert.equal(h.calls(),0)
})

await test('an unchanged legacy import refreshes new metadata once without Agent or lost watch progress', async f => {
  const file=f.file('Legacy/Original Story #1 [中文字幕]_720P.mp4')
  const metadata=f.file('Legacy/info.json',JSON.stringify({title:'Original Story #1',chineseTitle:'旧版导入样例 1',
    introduction:'Existing local description',uploadTime:'2026-06-04',artist:'Fixture Studio',coverUrl:'',videoUrls:[]}))
  const h=localService(f), first=await h.service.scanVideos([path.dirname(file)],()=>{})
  const id=first.entries![0].resourceId!, stat=fs.statSync(file)
  // Historical v2 cache from the released reader that did not import uploadTime/artist.
  const legacy=createHash('sha256').update('video-feedback-v2')
    .update(JSON.stringify([path.resolve(file).toLowerCase(),stat.size,stat.mtimeMs]))
    .update(metadata).update(fs.readFileSync(metadata)).digest('hex')
  f.db.prepare('UPDATE video_scan_state SET fingerprint=? WHERE resource_id=?').run(legacy,id)
  f.db.prepare("UPDATE episode SET published_at=0,studio='',watch_status='watching',position_sec=37 WHERE resource_id=?").run(id)
  const refreshed=await h.service.scanVideos([path.dirname(file)],()=>{})
  assert.equal(refreshed.registered,1)
  assert.equal(refreshed.entries![0].resourceId,id)
  const episode=listEpisodes(f.db,id)[0]
  assert.equal(episode.published_at,Date.UTC(2026,5,4));assert.equal(episode.studio,'Fixture Studio')
  assert.equal(episode.position_sec,37);assert.equal(episode.watch_status,'watching');assert.equal(h.calls(),0)
  assert.equal((await h.service.scanVideos([path.dirname(file)],()=>{})).skipped,1)
})

await test('local date extraction ignores invalid upload dates', f => {
  const file=f.file('Dates/Story.mp4')
  for (const uploadTime of ['not-a-date','2026-02-31','2026-02-29T12:00:00+08:00','2026-13-01']) {
    f.file('Dates/info.json',JSON.stringify({title:'Story',uploadTime,artist:'Studio',coverUrl:'',videoUrls:[]}))
    assert.equal(readVideoLocalMetadata(file).publishedAt,0,uploadTime)
  }
  f.file('Dates/info.json',JSON.stringify({title:'Story',uploadTime:'2024-02-29T12:00:00+08:00',coverUrl:'',videoUrls:[]}))
  assert.equal(readVideoLocalMetadata(file).publishedAt,Date.UTC(2024,1,29,4))
})

await test('publication range uses episode dates and normalizes legacy Unix seconds', f => {
  const id=f.work()
  f.db.prepare('UPDATE episode SET published_at=? WHERE resource_id=?').run(Date.UTC(2024,2,1),id)
  registerVideoContent(f.db,{resourceId:id,title:'故事',items:[{title:'故事 2',number:2,order:2,airDate:Date.UTC(2026,5,4)/1000,files:[]},{title:'故事 3',number:3,order:3,files:[]}]})
  const item=getVideo(f.db,id)!
  assert.equal(item.published_start,Date.UTC(2024,2,1))
  assert.equal(item.published_end,Date.UTC(2026,5,4))
  assert.equal(videoDateLabel(Date.UTC(2026,5,4)/1000),'2026-06-04')
})

await test('publication filters match real episode dates with inclusive calendar boundaries', f => {
  const a=f.work(1),b=f.work(2),unknown=f.work(3)
  f.db.prepare('UPDATE episode SET published_at=? WHERE resource_id=?').run(Date.UTC(2026,5,4,23,59,59),a)
  f.db.prepare('UPDATE episode SET published_at=? WHERE resource_id=?').run(Date.UTC(2025,0,1),b)
  assert.deepEqual(listVideos(f.db,{publishedFrom:'2026-06-04',publishedTo:'2026-06-04'}).map(w=>w.id),[a])
  assert.deepEqual(listVideos(f.db,{sort:'published'}).map(w=>w.id),[a,b,unknown])
  assert.deepEqual(listVideos(f.db,{sort:'published-asc'}).map(w=>w.id),[b,a,unknown])
  assert.throws(()=>listVideos(f.db,{publishedFrom:'2026-02-31'}),/日期/)
})

await test('local availability filter can distinguish present missing and undownloaded content', async f => {
  const a=f.work(1),b=f.work(2)
  fs.unlinkSync(listEpisodes(f.db,b)[0].path)
  const c=registerVideoContent(f.db,{title:'Pending',directory:path.dirname(f.file('Pending/.keep')),items:[{title:'Pending 1',order:1,files:[]}]}).resourceId
  const h=localService(f)
  assert.deepEqual(Array.from(await h.service.listVideoItems({local:'available'}),w=>w.id),[a])
  assert.deepEqual(Array.from(await h.service.listVideoItems({local:'missing'}),w=>w.id),[b])
  assert.deepEqual(Array.from(await h.service.listVideoItems({local:'none'}),w=>w.id).sort(),[b,c].sort())
})

console.log(`Video library usability: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
