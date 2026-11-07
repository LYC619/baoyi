import fs from 'node:fs'
import path from 'node:path'
import type { VideoDownloadJob, VideoDownloadCache } from '../../../../src/types/video-workflow.ts'

const active = (job: VideoDownloadJob) => job.status === 'running' || job.status === 'queued'
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
function candidates(job: VideoDownloadJob): string[] {
  if (!job.directory) return []
  const result = new Set<string>()
  for (const item of job.items) {
    if (!item.path) continue
    if (!path.isAbsolute(item.path) || !same(path.dirname(item.path), job.directory)) throw new Error('下载缓存目录归属不一致，未清理')
    for (const kind of ['hls', 'dash', 'ranges']) result.add(path.join(job.directory, '.' + path.basename(item.path) + '.baoyi-' + kind))
  }
  return [...result]
}
function sizeOf(directory: string): number {
  const stat = fs.lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory() || !same(fs.realpathSync(directory), directory)) throw new Error('缓存目录包含链接，未清理')
  let size = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name), stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) throw new Error('缓存包含链接，未清理')
    if (stat.isDirectory() && entry.name === 'audio-fragments' && path.basename(directory) !== 'audio-fragments') size += sizeOf(target)
    else if (stat.isFile() && /^(?:manifest\.json(?:\.tmp)?|\d+(?:-\d+)?\.segment(?:\.tmp)?|merged-media\.bin|track-\d+\.mp4|audio-track\.mp4)$/.test(entry.name)) size += stat.size
    else throw new Error('缓存目录包含未知文件，未清理')
  }
  return size
}
function blocked(job: VideoDownloadJob, jobs: VideoDownloadJob[]): void {
  if (active(job) || jobs.some(other => active(other) && (other.directory && same(other.directory, job.directory) || other.items.some(item => item.path && job.items.some(own => own.path && same(item.path, own.path)))))) throw new Error('此目录的下载正在运行或排队，请先停止并等待任务结束')
}
export function inspectDownloadCaches(jobs: VideoDownloadJob[]): VideoDownloadCache[] {
  return jobs.map(job => {
    const result: VideoDownloadCache = { jobId: job.id, title: job.title, directory: job.directory, bytes: 0, directories: [], canClear: true, reason: '' }
    try {
      for (const directory of candidates(job)) {
        if (fs.existsSync(directory + '.lock')) throw new Error('缓存有下载锁，请等待任务结束；残留锁可先重试下载恢复')
        if (!fs.existsSync(directory)) continue
        result.directories.push(directory); result.bytes += sizeOf(directory)
      }
      blocked(job, jobs)
    } catch (error) { result.canClear = false; result.reason = error instanceof Error ? error.message : String(error) }
    result.canClear = result.canClear && result.directories.length > 0
    return result
  }).filter(item => item.directories.length || item.reason)
}
/** Only paths derived from stored jobs are accepted; the caller rechecks the job after confirmation. */
export function clearDownloadCaches(job: VideoDownloadJob, jobs: VideoDownloadJob[]): number {
  blocked(job, jobs)
  const directories = candidates(job).filter(directory => fs.existsSync(directory))
  const locks: Array<{ file: string; fd: number }> = []
  let bytes = 0
  try {
    // Hold every writer lock before inspecting or deleting any cache, so failure leaves all caches intact.
    for (const directory of directories) {
      if (!same(fs.realpathSync(path.dirname(directory)), path.dirname(directory))) throw new Error('缓存上级目录是链接，未清理')
      const file = directory + '.lock'
      let fd: number
      try { fd = fs.openSync(file, 'wx', 0o600) } catch { throw new Error('缓存有下载锁，未清理') }
      locks.push({ file, fd }); fs.writeSync(fd, JSON.stringify({ pid: process.pid }))
      bytes += sizeOf(directory)
    }
    for (const directory of directories) {
      if (!same(path.dirname(directory), job.directory) || !same(fs.realpathSync(directory), directory)) throw new Error('缓存目录归属已变化，未清理')
      fs.rmSync(directory, { recursive: true })
    }
    return bytes
  } finally { for (const { file, fd } of locks) { fs.closeSync(fd); fs.unlinkSync(file) } }
}
