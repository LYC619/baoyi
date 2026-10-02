import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, type SqlDb } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { seedImageLibrary } from './helpers/image-library-fixture.ts'

const output = path.resolve('output/image-optimization/library-performance'); fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-')), db = new DatabaseSync(path.join(profile, 'baoyi.db'))
db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
const count = Number(process.env.BAOYI_BENCHMARK_COUNT || 2000)
seedImageLibrary(db, profile, count)
let queries = 0
const counted: SqlDb = { exec: sql => db.exec(sql), prepare: sql => { queries++; return db.prepare(sql) } }
try {
  const library = new ImageLibrary(counted), start = performance.now(), items = library.list(), ms = performance.now() - start
  const queryCount = queries
  assert.equal(items.length, count)
  for (const id of ['fixture-0', 'fixture-19', 'fixture-' + (count - 1)]) assert.deepEqual(items.find(i => i.id === id), library.get(id), 'batch list must match detail including chapters/progress/cover/read')
  const report = { count, pages: count * 24, ms: Math.round(ms), queries: queryCount, payloadBytes: Buffer.byteLength(JSON.stringify(items)), profile }
  fs.writeFileSync(path.join(output, process.argv.includes('--baseline') ? 'baseline.json' : 'optimized.json'), JSON.stringify(report, null, 2)); console.log(report)
  if (!process.argv.includes('--baseline')) assert.ok(queryCount <= 5, 'library list must avoid per-work SQL queries')
} finally { db.close() }
