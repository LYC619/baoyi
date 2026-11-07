import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectDownloadCaches, clearDownloadCaches } from '../electron/kinds/video/download/cache-management.ts'
import type { VideoDownloadJob } from '../src/types/video-workflow.ts'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-cache-'))
try {
  const destination = path.join(root, 'movie.mp4'), cache = path.join(root, '.movie.mp4.baoyi-hls')
  const job = { id: 'fixture', directory: root, title: 'Fixture', status: 'failed', items: [{ path: destination }] } as VideoDownloadJob
  const seed = () => { fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, 'manifest.json'), '{}'); fs.writeFileSync(path.join(cache, '000000.segment'), 'fragment') }
  seed(); fs.writeFileSync(destination, 'complete movie')
  assert.equal(inspectDownloadCaches([job])[0].bytes, 10)
  assert.equal(clearDownloadCaches(job, [job]), 10)
  assert.equal(fs.readFileSync(destination, 'utf8'), 'complete movie')
  seed(); job.status = 'running'
  assert.throws(() => clearDownloadCaches(job, [job]), /运行|排队/)
  job.status = 'failed'; fs.writeFileSync(cache + '.lock', JSON.stringify({ pid: process.pid }))
  assert.equal(inspectDownloadCaches([job])[0].canClear, false)
  assert.throws(() => clearDownloadCaches(job, [job]), /锁/)
  fs.unlinkSync(cache + '.lock'); fs.writeFileSync(path.join(cache, 'user-note.txt'), 'keep')
  assert.throws(() => clearDownloadCaches(job, [job]), /未知|非缓存/)
  fs.unlinkSync(path.join(cache, 'user-note.txt'))
  assert.throws(() => clearDownloadCaches(job, [job, { ...job, id: 'active', status: 'queued' }]), /运行|排队/)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-outside-'))
  try {
    fs.mkdirSync(path.join(cache, 'audio-fragments'))
    fs.rmdirSync(path.join(cache, 'audio-fragments'))
    fs.symlinkSync(outside, path.join(cache, 'audio-fragments'), 'junction')
    assert.throws(() => clearDownloadCaches(job, [job]), /链接/)
    fs.unlinkSync(path.join(cache, 'audio-fragments'))
    const wrong = { ...job, items: [{ path: path.join(outside, 'movie.mp4') }] } as VideoDownloadJob
    assert.throws(() => clearDownloadCaches(wrong, [wrong]), /归属|目录/)
  } finally { assert.equal(path.dirname(outside), path.resolve(os.tmpdir())); fs.rmSync(outside, { recursive: true, force: true }) }
  assert.equal(clearDownloadCaches(job, [job]), 10)
  console.log('PASS cache inventory, stopped-only cleanup, complete-file preservation, lock, active sibling, unknown files, junction and ownership guards')
} finally { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) }
