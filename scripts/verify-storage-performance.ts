import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateArtworkIntoLibrary } from '../electron/services/artwork-migration.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-storage-perf-'))
const library = path.join(root, 'library'), cache = path.join(root, 'posters'), db = new DatabaseSync(':memory:')
const nativeRead = fs.readSync, samples: { strategy: string; ms: number; imageBytesRead: number }[] = []
let imageBytesRead = 0
try {
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(path.join(cache, 'unreferenced.jpg'), Buffer.alloc(32768, 7))
  for (let i = 0; i < 1000; i++) {
    const folder = path.join(library, 'work-' + Math.floor(i / 4), '.baoyi', 'artwork')
    fs.mkdirSync(folder, { recursive: true })
    const bytes = Buffer.alloc(65536, 5); bytes.writeUInt32LE(i)
    fs.writeFileSync(path.join(folder, i + '.jpg'), bytes)
  }
  fs.readSync = ((...args: unknown[]) => { const size = Reflect.apply(nativeRead, fs, args) as number; imageBytesRead += size; return size }) as typeof fs.readSync
  for (const strategy of ['deduplicate', 'count'] as const) for (let i = 0; i < 3; i++) {
    imageBytesRead = 0
    const start = performance.now()
    const result = migrateArtworkIntoLibrary(db, { cacheDirs: [cache], fallbackDir: cache, recoveryRoot: root, scanRoots: [library], orphanStrategy: strategy })
    samples.push({ strategy, ms: Math.round((performance.now() - start) * 100) / 100, imageBytesRead })
    assert.equal(result.orphans, 1); assert.equal(result.removed, 0)
  }
  assert.ok(samples.filter(item => item.strategy === 'deduplicate').every(item => item.imageBytesRead >= 65536000))
  assert.ok(samples.filter(item => item.strategy === 'count').every(item => item.imageBytesRead === 0))
  const median = (strategy: string) => samples.filter(item => item.strategy === strategy).map(item => item.ms).sort((a, b) => a - b)[1]
  const result = { date: '2026-10-29', status: 'passed', fixture: { artworkFiles: 1000, orphanFiles: 1, sameInput: true }, samples, baselineMedianMs: median('deduplicate'), optimizedMedianMs: median('count'), boundary: 'Actual startup artwork migration phase, not total application startup; no user library used.' }
  fs.mkdirSync('output/optimization-2026-10-29', { recursive: true })
  fs.writeFileSync('output/optimization-2026-10-29/startup-performance.json', JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { fs.readSync = nativeRead; db.close(); fs.rmSync(root, { recursive: true, force: true }) }
