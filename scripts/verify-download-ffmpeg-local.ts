/** Real FFmpeg + local HTTP only. Never touches the user's library or remote media. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { createVideoMediaTransfer } from '../electron/kinds/video/download/media.ts'
import { locateFfmpeg } from '../electron/kinds/video/download/ffmpeg.ts'

const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version
const output = path.resolve(`output/release-${version}/ffmpeg-local`)
await fs.mkdir(output, { recursive: true })
const root = await fs.mkdtemp(path.join(output, 'run-'))
const ffmpeg = locateFfmpeg(process.argv[2] || process.env.BAOYI_TEST_FFMPEG || '')
assert.ok(ffmpeg, 'A real local FFmpeg executable is required')
function run(args: string[], cwd = root) {
  const result = spawnSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.status, 0, result.error?.message || result.stderr)
}
const input = path.join(root, 'source.mp4')
run(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input])
const hls = path.join(root, 'hls'), dash = path.join(root, 'dash')
await fs.mkdir(hls); await fs.mkdir(dash)
run(['-i', input, '-map', '0:v:0', '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', path.join(hls, 'video.m3u8')])
run(['-i', input, '-map', '0:a:0', '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', path.join(hls, 'audio.m3u8')])
await fs.writeFile(path.join(hls, 'index.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="main",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=160x90,AUDIO="audio"\nvideo.m3u8\n')
run(['-i', input, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'dash', '-seg_duration', '1', '-use_template', '1', '-use_timeline', '1', 'index.mpd'], dash)
const counts = new Map<string, number>(), active = new Set<string>()
const server = createServer(async (req, res) => {
  const name = new URL(req.url || '/', 'http://localhost').pathname
  const file = path.resolve(root, '.' + name)
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return }
  try {
    const bytes = await fs.readFile(file)
    counts.set(name, (counts.get(name) || 0) + 1)
    res.writeHead(200, { 'Content-Length': bytes.length })
    if (/\.(m3u8|mpd)$/.test(name)) { res.end(bytes); return }
    active.add(name)
    for (let offset = 0; offset < bytes.length && !res.destroyed; offset += 1024) {
      res.write(bytes.subarray(offset, offset + 1024))
      await new Promise(resolve => setTimeout(resolve, 3))
    }
    res.end(); active.delete(name)
  } catch { res.writeHead(404); res.end() }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
const checks: string[] = [], results: any[] = []
try {
  const transfer = createVideoMediaTransfer({ fetch, ffmpeg: () => ffmpeg, settings: () => ({ video_download_connections: 1 }) })
  for (const kind of ['hls', 'dash'] as const) {
    const destination = path.join(root, kind + '-result.mp4')
    const options = { url: base + '/' + kind + '/index.' + (kind === 'hls' ? 'm3u8' : 'mpd'), format: kind, destination, referer: base }
    const controller = new AbortController()
    await assert.rejects(transfer({ ...options, signal: controller.signal, onProgress: progress => {
      if (/已下载 [1-9]\d*\//.test(progress.message || '')) controller.abort(new Error('local test interruption'))
    } }), /local test interruption/)
    const workspace = path.join(root, '.' + kind + '-result.mp4.baoyi-' + kind)
    const journal = JSON.parse(await fs.readFile(path.join(workspace, 'manifest.json'), 'utf8'))
    assert.ok(Object.keys(journal.files).length, 'Interruption must preserve at least one verified fragment')
    checks.push(kind + '-interruption-keeps-verified-fragments')
    const before = new Map(counts), progress: any[] = []
    let liveBytes = false
    const saved = await transfer({ ...options, signal: new AbortController().signal, onProgress: item => {
      progress.push(item)
      if (item.phase === 'downloading' && item.receivedBytes > 0 && active.size > 0) liveBytes = true
    } })
    assert.ok(liveBytes, 'Bytes must be visible during an active media response')
    assert.ok(progress.some(item => item.message?.includes('FFmpeg') && item.phase === 'finalizing'))
    if (kind === 'hls') assert.ok(progress.some(item => item.message?.startsWith('独立音轨：')))
    assert.ok([...before].some(([name, count]) => /\.(ts|m4s)$/.test(name) && counts.get(name) === count), 'A completed cached fragment must not be requested again')
    const size = (await fs.stat(destination)).size
    assert.equal(saved.receivedBytes, size); assert.equal(saved.totalBytes, size)
    await assert.rejects(fs.stat(workspace), /ENOENT/)
    await assert.rejects(fs.stat(workspace + '.lock'), /ENOENT/)
    // Decode both streams completely; a container header alone is insufficient.
    run(['-xerror', '-i', destination, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
    checks.push(kind + '-resume-without-refetching-complete-fragments', kind + '-live-bytes-and-ffmpeg-stage', kind + '-real-remux-and-full-audio-video-decode', kind + '-successful-cache-and-lock-cleanup')
    results.push({ kind, destination, bytes: size, progress })
  }
  assert.ok(!(await fs.readdir(root)).some(name => name.endsWith('.baoyi-part.mp4')))
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ status: 'passed', version, ffmpeg, root, scope: 'Local HTTP, synthesized four-second video and tone; no remote media or user library', checks, results }, null, 2) + '\n')
  console.log(`PASS real FFmpeg local acceptance: ${checks.length} checks; HLS separate audio and DASH decode successfully`)
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
