import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv } from 'node:crypto'
import { downloadHls } from '../electron/kinds/video/download/hls.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-hls-field-'))
try {
  const key = Buffer.alloc(16, 7), iv = Buffer.alloc(16); iv.writeBigUInt64BE(9n, 8)
  const original = Buffer.from('Synthetic media content for sequence nine.')
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(original), cipher.final()])
  const destination = path.join(root, 'test.mp4')
  const request: typeof fetch = async input => {
    const url = String(input)
    if (url.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\npart.ts\n#EXT-X-ENDLIST')
    return new Response(url.endsWith('/key') ? key : encrypted)
  }
  // Deliberately stop at the remux boundary; inspect bytes produced by the real downloader.
  await assert.rejects(downloadHls({ url: 'https://media.test/index.m3u8', destination, headers: {}, signal: new AbortController().signal, fetch: request, ffmpeg: path.join(root, 'unavailable-ffmpeg'), retries: 0 }))
  assert.deepEqual(fs.readFileSync(path.join(root, '.test.mp4.baoyi-hls', 'merged-media.bin')), original, 'implicit AES IV must store the sequence in the low 64 bits')
  console.log('PASS HLS AES-128 implicit IV and media bytes')
  const temp = path.join(root, '.test.mp4.baoyi-hls')
  fs.writeFileSync(path.join(temp, '000000.segment'), Buffer.alloc(original.length, 0))
  await assert.rejects(downloadHls({ url: 'https://media.test/index.m3u8', destination, headers: {}, signal: new AbortController().signal, fetch: request, ffmpeg: path.join(root, 'unavailable-ffmpeg'), retries: 0 }))
  assert.deepEqual(fs.readFileSync(path.join(temp, 'merged-media.bin')), original, 'damaged segments must be re-downloaded')
  const changed: typeof fetch = async input => String(input).endsWith('.m3u8') ? new Response('#EXTM3U\n#EXTINF:1,\nnew.ts\n#EXT-X-ENDLIST') : new Response('new media')
  await assert.rejects(downloadHls({ url: 'https://media.test/index.m3u8', destination, headers: {}, signal: new AbortController().signal, fetch: changed, ffmpeg: path.join(root, 'unavailable-ffmpeg'), retries: 0 }))
  assert.equal(fs.readFileSync(path.join(temp, 'merged-media.bin'), 'utf8'), 'new media', 'changed playlists must not reuse old segments')
  let active = 0
  const failing: typeof fetch = async input => {
    const url = String(input)
    if (url.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts\n#EXT-X-ENDLIST')
    active++
    try { await new Promise(resolve => setTimeout(resolve, url.endsWith('a.ts') ? 1 : 800)); if (url.endsWith('a.ts')) throw new Error('broken segment'); return new Response('slow segment') }
    finally { active-- }
  }
  await assert.rejects(downloadHls({ url: 'https://media.test/index.m3u8', destination, headers: {}, signal: new AbortController().signal, fetch: failing, ffmpeg: '', retries: 0, workers: 2 }), /broken segment/)
  assert.equal(active, 0, 'download failure must wait until all workers have stopped')
  assert.equal(fs.existsSync(path.join(temp, '000001.segment')), false, 'cancelled worker must not write late files')
  console.log('PASS HLS resume integrity, playlist identity and worker settlement')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
