import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { frameFfmpeg, generateFrames } from '../electron/kinds/video/frame-generator.ts'
const exec = promisify(execFile)
const ffmpeg = await frameFfmpeg(process.argv[2] || process.env.BAOYI_TEST_FFMPEG || '')
assert.ok(ffmpeg, '需要本机 FFmpeg（通过参数或 BAOYI_TEST_FFMPEG 提供）')
const output = path.resolve(process.argv[4] || 'output/p1-p2-video-2026-11-06/cancel')
await fs.mkdir(output, { recursive: true })
const root = await fs.mkdtemp(path.join(output, 'run-')), file = path.join(root, 'synthetic.mp4'), directory = path.join(root, 'frames')
if (process.argv[3]) {
  await fs.copyFile(path.resolve(process.argv[3]), file)
} else {
  await exec(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=640x360:rate=1', '-t', '3600', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '3600', '-keyint_min', '3600', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-threads', '2', file], { windowsHide: true, timeout: 90000, maxBuffer: 65536 })
}
const controller = new AbortController(), progress: number[] = [], started = Date.now()
let cancelledAt = 0
await assert.rejects(generateFrames({
  file, directory, ffmpeg, duration: 3600, signal: controller.signal, progress: value => {
    progress.push(value)
    if (!controller.signal.aborted) { cancelledAt = Date.now(); controller.abort(new Error('隔离取消验收')) }
  }
}), /取消/)
assert.ok(cancelledAt, '实际抽帧至少完成一帧后再取消')
const settleMs = Date.now() - cancelledAt
assert.ok(settleMs < 10000, 'worker 应在取消宽限内结束')
await fs.rename(file, file + '.released'); await fs.rename(file + '.released', file)
const after = await fs.readdir(directory), count = progress.length
await new Promise(resolve => setTimeout(resolve, 1200))
assert.deepEqual(await fs.readdir(directory), after, '取消结束后无迟到产物')
assert.equal(progress.length, count, '取消结束后无迟到回调')
assert.ok(!after.includes('index.json'), '取消后不发布完成缓存')
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ status: 'passed', checks: ['真实双worker/FFmpeg取消并释放源文件', '取消后无迟到进度或完成缓存'], settleMs, totalMs: Date.now() - started, progress }, null, 2))
console.log('PASS real frame cancellation; ' + root)
