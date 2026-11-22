/** Isolated synthetic SQL/read-model benchmark; never opens the user's database. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { listVideos, videoCounts } from '../electron/kinds/video/db.ts'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-library-benchmark-'))
const db = new DatabaseSync(path.join(root, 'synthetic.db'))
const results: unknown[] = []
try {
  initSchema(db, KINDS)
  const resource = db.prepare("INSERT INTO resource(id,kind,path,name_zh,category,tags,created_at,updated_at,file_name) VALUES(?,?,?,?,?,?,0,0,'benchmark')")
  const meta = db.prepare('INSERT INTO video_meta(resource_id,video_type) VALUES(?,?)')
  const episode = db.prepare('INSERT INTO episode(id,resource_id,season,episode,title,path) VALUES(?,?,?,?,?,?)')
  let count = 0
  for (const scale of [1000, 5000, 10000]) {
    db.exec('BEGIN')
    for (; count < scale; count++) {
      const id = 'video-' + count
      resource.run(id, 'video', path.join(root, id), '基准作品 ' + count, count % 5 ? '电影' : '课程', '["基准标签"]')
      meta.run(id, 'series')
      for (let n = 1; n <= 5; n++) episode.run(id + '-' + n, id, 1, n, '内容 ' + n, path.join(root, id, n + '.mp4'))
    }
    db.exec('COMMIT')
    for (const [name, run] of [
      ['all', () => listVideos(db)], ['category', () => listVideos(db, { category: '课程' })],
      ['search', () => listVideos(db, { keyword: '基准作品 999' })], ['counts', () => videoCounts(db)]
    ] as const) {
      const times: number[] = []; let rows = 0
      for (let n = 0; n < 5; n++) { const start = performance.now(), value = run(); times.push(performance.now() - start); if (Array.isArray(value)) rows = value.length }
      if (name === 'all') assert.equal(rows, scale)
      results.push({ scale, episodes: scale * 5, query: name, rows, medianMs: +times.sort((a, b) => a - b)[2].toFixed(1), maxMs: +Math.max(...times).toFixed(1) })
    }
  }
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version, output = `output/release-${version}/library-benchmark.json`
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify({ status: 'passed', version, scope: 'Synthetic SQLite read model, warm process, 5 samples each; excludes filesystem scan, IPC, covers and rendering.', results }, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally { db.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) }
