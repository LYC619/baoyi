import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { emptyFacts } from '../electron/kinds/video/facts.ts'
import { getVideo, listEpisodes, updateEpisode } from '../electron/kinds/video/db.ts'
import { listVideoAssets } from '../electron/kinds/video/library.ts'
const module: any = await import('../electron/kinds/video/registration.ts')
assert.equal(typeof module.registerLocalVideoFacts, 'function', 'deterministic local registration is required')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-local-import-'))
const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
try {
  const file = path.join(root, 'Course S01E01.mp4'); fs.writeFileSync(file, 'fixture-video')
  const facts = { ...emptyFacts(), path: root, dir: root, video_type: 'series', title_zh: '离线课程', plot: '本地 NFO 简介', year: 2020,
    episodes: [{ season: 1, episode: 1, title: '第一讲', path: file, file_size: 13, duration_sec: 0, air_date: 0, watch: { watch_status: 'watched', position_sec: 25, watched_at: 1 } }], nfo_files: [path.join(root, 'tvshow.nfo')] }
  const registered = module.registerLocalVideoFacts(db, facts)
  const ep = listEpisodes(db, registered.id)[0]
  assert.equal(getVideo(db, registered.id)?.summary, '本地 NFO 简介')
  assert.equal(ep.watch_status, 'watched'); assert.equal(listVideoAssets(db, registered.id, ep.id).length, 1)
  updateEpisode(db, ep.id, { watch_status: 'watching', position_sec: 55 })
  module.registerLocalVideoFacts(db, facts)
  assert.equal(listEpisodes(db, registered.id).length, 1); assert.equal(listEpisodes(db, registered.id)[0].position_sec, 55)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
  console.log('PASS deterministic local/NFO registration, assets, idempotency and history preservation')
} finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
