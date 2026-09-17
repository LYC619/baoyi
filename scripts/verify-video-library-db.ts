import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, type SqlDb } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import * as video from '../electron/kinds/video/db.ts'
import { emptyFacts } from '../electron/kinds/video/facts.ts'
import { buildVideoTools } from '../electron/kinds/video/tools.ts'

let passed = 0; let failed = 0
async function test(name: string, run: (db: SqlDb) => void | Promise<void>) {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
    await run(db); passed++
  } catch (error) { failed++; console.error('FAIL', name, error instanceof Error ? error.message : error) }
  finally { db.close() }
}
function payload(name: string, extra: Record<string, unknown> = {}): video.VideoPayload {
  return {
    path: `D:\\fixture\\${name}.mp4`, video_type: 'movie', name_zh: name, name_en: '', summary: '',
    description: '', category: '其他', tags: ['共同'], official_url: '', source_dir: 'D:\\fixture', file_size: 100,
    year: 0, end_year: 0, rating: 0, duration_sec: 0, resolution: '', video_codec: '', source: '', release_group: '',
    audio_tracks: [], subtitle_tracks: [], parts: [], linked_files: [], tmdb_id: '', imdb_id: '', douban_id: '', douban_rating: 0,
    poster_path: '', fanart_path: '', episodes: [], ...extra
  }
}
await test('default views, searches, watch states and counts exclude hentai', db => {
  video.insertVideo(db, payload('普通'))
  video.insertVideo(db, payload('里番样本', { category: '里番', hanime_tags: ['站方'] }))
  for (const q of [{}, { keyword: '样本' }, { type: 'movie' }, { status: 'unwatched' }, { tag: '共同' }, { category: '里番' }]) {
    assert.ok(video.listVideos(db, q as any).every(x => x.category !== '里番'))
  }
  const counts = video.videoCounts(db) as any
  assert.equal(counts.all, 1); assert.equal(counts.type.movie, 1); assert.equal(counts.status.unwatched, 1)
  assert.equal(counts.hentai, 1)
  assert.ok(counts.categories.every((c: any) => c.name !== '里番'))
})
await test('explicit hentai type and its site tags work; hide setting still wins', db => {
  video.insertVideo(db, payload('普通'))
  video.insertVideo(db, payload('样本', { category: '里番', hanime_tags: ['站方'] }))
  assert.deepEqual(video.listVideos(db, { type: 'hentai' } as any).map(x => x.name_zh), ['样本'])
  assert.equal(video.listVideos(db, { type: 'hentai', tag: '站方' } as any).length, 1)
  assert.equal(video.listVideos(db, { type: 'hentai' } as any, true).length, 0)
  assert.equal((video.videoCounts(db, true) as any).hentai, 0)
})
await test('collection membership is persisted, queried, scoped and user-protected', db => {
  const item = video.insertVideo(db, payload('普通', { collection_name: '  系列合集  ' }))
  video.insertVideo(db, payload('其他作品', { collection_name: '另一个分组' }))
  video.insertVideo(db, payload('样本', { collection_name: '系列合集', category: '里番' }))
  assert.equal((video.getVideo(db, item.id) as any).collection_name, '')
  video.updateVideo(db,item.id,{collection_name:'系列合集'})
  assert.equal(video.listVideos(db, { collection: '系列合集' } as any).length, 1)
  assert.deepEqual((video.videoCounts(db) as any).collections.find((x: any) => x.name === '系列合集'), { name: '系列合集', count: 1 })
  assert.equal((video.videosUnder(db, 'D:\\fixture')[0] as any).collection_name, '系列合集')
  video.updateVideo(db, item.id, { collection_name: '用户分组' } as any)
  video.insertVideo(db, payload('普通', { collection_name: '模型分组' }))
  assert.equal((video.getVideo(db, item.id) as any).collection_name, '用户分组')
  video.updateVideo(db, item.id, { collection_name: '' } as any)
  assert.equal((video.getVideo(db, item.id) as any).collection_name, '')
})
await test('agent can register a recording with a collection without database IDs', async db => {
  const facts = { ...emptyFacts(), path: 'D:\\fixture\\培训录屏.mp4', dir: 'D:\\fixture', title_zh: '培训录屏' }
  const tools = buildVideoTools({ facts, db, tagPool: [], searchConfig: {} as any, tmdbConfig: {} as any }, ['其他'], false, false)
  const register = tools.find(x => x.name === 'register_video')!
  assert.ok(!(register.parameters as any).properties.collection_name)
  await register.execute({ name_zh: '培训录屏', category: '其他', collection_name: '培训', summary: '培训录像' })
  const [item] = video.listVideos(db)
  assert.equal(item.name_zh, '培训录屏'); assert.equal((item as any).collection_name, ''); assert.equal(item.tmdb_id, '')
})
await test('remote poster source survives local caching and future rescans', db => {
  const item = video.insertVideo(db, payload('普通', { poster_path: '/original.jpg' }))
  video.updateVideo(db, item.id, { poster_path: 'C:\\cache\\poster.jpg' })
  assert.equal((video.getVideo(db, item.id) as any).poster_source, '/original.jpg')
  video.insertVideo(db, payload('普通', { poster_path: '/fresh.jpg' }))
  assert.equal(video.getVideo(db, item.id)?.poster_path, 'C:\\cache\\poster.jpg')
  assert.equal((video.getVideo(db, item.id) as any).poster_source, '/fresh.jpg')
})
await test('adding another work to an owned folder keeps the original identity and watch state', db => {
  const original = payload('Alpha', { path: 'D:\\fixture', parts: [{ path: 'D:\\fixture\\Alpha.mp4', label: '', file_size: 100, duration_sec: 1 }] })
  const first = video.insertVideo(db, original)
  video.updateVideo(db, first.id, { watch_status: 'watched', collection_name: '用户分组' } as any)
  const rescanned = video.insertVideo(db, { ...original, path: 'D:\\fixture\\Alpha.mp4' })
  assert.equal(rescanned.id, first.id); assert.equal(rescanned.created, false)
  video.insertVideo(db, payload('Beta'))
  assert.equal(video.listVideos(db).length, 2)
  assert.equal(video.getVideo(db, first.id)?.watch_status, 'watched')
  assert.equal(video.getVideo(db, first.id)?.collection_name, '用户分组')
})
await test('adding an earlier episode preserves the series identity and episode progress', db => {
  const ep2 = { season: 1, episode: 2, title: '', path: 'D:\\fixture\\Alpha.S01E02.mp4', file_size: 100, duration_sec: 1, air_date: 0 }
  const original = payload('Alpha', { path: ep2.path, video_type: 'series', episodes: [ep2] })
  const first = video.insertVideo(db, original)
  video.updateEpisode(db, video.listEpisodes(db, first.id)[0].id, { position_sec: 5 })
  const ep1 = { ...ep2, episode: 1, path: 'D:\\fixture\\Alpha.S01E01.mp4' }
  const rescanned = video.insertVideo(db, { ...original, path: ep1.path, episodes: [ep1, ep2] })
  assert.equal(rescanned.id, first.id)
  assert.equal(video.listVideos(db).length, 1)
  assert.equal(video.listEpisodes(db, first.id).find(e => e.episode === 2)?.position_sec, 5)
})
await test('new metadata migration is idempotent and keeps library data', db => {
  const item = video.insertVideo(db, payload('已有条目'))
  db.exec('DROP VIEW video; ALTER TABLE video_meta DROP COLUMN collection_name; ALTER TABLE video_meta DROP COLUMN poster_source;')
  initSchema(db, KINDS); initSchema(db, KINDS)
  assert.equal(video.getVideo(db, item.id)?.name_zh, '已有条目')
  assert.equal((video.getVideo(db, item.id) as any).collection_name, '')
})
await test('a failed episode transfer rolls back the new resource and preserves the old episode', db => {
  const episode = { season: 1, episode: 2, title: '', path: 'D:\\fixture\\Beta.S01E02.mp4', file_size: 100, duration_sec: 1, air_date: 0 }
  const first = video.insertVideo(db, payload('Merged', { path: 'D:\\fixture', video_type: 'series', episodes: [episode] }))
  const stored = video.listEpisodes(db, first.id)[0]
  video.updateEpisode(db, stored.id, { position_sec: 65 })
  db.exec("CREATE TEMP TRIGGER reject_episode_transfer BEFORE UPDATE OF resource_id ON episode BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
  assert.throws(() => video.insertVideo(db, payload('Beta', { path: episode.path, video_type: 'series', episodes: [episode] }), first.id), /fixture failure/)
  assert.equal(video.listVideos(db).length, 1)
  assert.equal(video.getEpisode(db, stored.id)?.resource_id, first.id)
  assert.equal(video.getEpisode(db, stored.id)?.position_sec, 65)
})
console.log(`视频分组与筛选回归：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
