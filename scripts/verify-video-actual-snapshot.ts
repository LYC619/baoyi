/** Checks the user's example against a disposable database copy; media and sidecars stay read-only. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { syncVideoWorkFiles } from '../electron/kinds/video/local-sync.ts'
import { applyVideoCatalogue } from '../electron/kinds/video/catalogue.ts'
import { fillEpisodeDetails } from '../electron/kinds/video/episode-details.ts'
import { getVideo, listEpisodes } from '../electron/kinds/video/db.ts'
import { getVideoWorkLibrary } from '../electron/kinds/video/library.ts'
import type { VideoWorkSource } from '../electron/kinds/video/download/workflow.ts'

const evidence = path.resolve('output/video-local-structure-20260912')
const target = path.join(evidence, 'actual-snapshot.db')
fs.copyFileSync(path.join(evidence, 'baseline/library-before.db'), target)
const d = new DatabaseSync(target); d.exec('PRAGMA foreign_keys = ON')
const id = 'b1200803-90dc-4289-8161-fd853f71f0df'
const read = (code: string) => JSON.parse(fs.readFileSync(path.join(evidence, 'source', code + '.json'), 'utf8')) as VideoWorkSource
try {
  const before = listEpisodes(d, id)
  const sync = syncVideoWorkFiles(d, id, { roots: ['E:\\视频'], persist: false })
  const catalogue = applyVideoCatalogue(d, id, read('87022'))
  for (const entry of catalogue.catalogue.episodes) {
    const info = read(entry.videoCode)
    const row = d.prepare("SELECT episode_id FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND external_id = ? AND episode_id IS NOT NULL").get(id, entry.videoCode) as { episode_id: string }
    assert.ok(row)
    fillEpisodeDetails(d, row.episode_id, { originalTitle: info.currentEpisode?.originalTitle, description: info.currentEpisode?.description,
      sourceUrl: 'https://hanime1.me/watch?v=' + entry.videoCode })
  }
  const episodes = listEpisodes(d, id), library = getVideoWorkLibrary(d, id)
  assert.equal(getVideo(d, id)?.name_zh, '妻NTR・凌辱輪迴 0-4')
  assert.deepEqual(episodes.map(ep => ep.episode), [0, 1, 2, 3, 4])
  assert.equal(episodes[0].path, '')
  assert.equal(library.assets.filter(asset => asset.role === 'video' && asset.state === 'present').length, 4)
  for (const ep of before) {
    const current = episodes.find(value => value.id === ep.id)
    assert.ok(current, 'Original episode identity lost')
    assert.equal(current.watch_status, ep.watch_status)
    assert.ok(current.position_sec >= ep.position_sec)
    assert.ok(current.watched_at >= ep.watched_at)
  }
  assert.equal(getVideo(d, 'aa6df460-4f3f-4c90-9dc2-bd0d06a0a4c6')?.is_archived, true)
  assert.ok(episodes.every(ep => ep.description && ep.original_title))
  assert.equal(d.prepare('PRAGMA foreign_key_check').all().length, 0)
  const report = { resourceId: id, title: getVideo(d, id)?.name_zh, directory: library.directory?.path,
    synced: { filesAdded: sync.filesAdded, pathsRepaired: sync.pathsRepaired, duplicatesMerged: sync.duplicatesMerged },
    episodes: episodes.map(ep => ({ id: ep.id, number: ep.episode, title: ep.title, originalTitle: ep.original_title, present: !!ep.path && fs.existsSync(ep.path), watchStatus: ep.watch_status, watchedAt: ep.watched_at, position: ep.position_sec,
      descriptionCharacters: ep.description?.length || 0, files: library.contents.find(content => content.id === ep.id)?.assets.length || 0 })) }
  fs.writeFileSync(path.join(evidence, 'actual-snapshot-check.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { d.close() }
